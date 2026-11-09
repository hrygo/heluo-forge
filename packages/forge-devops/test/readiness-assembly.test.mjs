/**
 * r16 / PR #215 review：就绪视图的**真实装配路径**（`apply()` → `withReadiness`）。
 *
 * 纯函数替身证明的是 `buildReadiness()` 自己的契约；这里要证明的是装配层真的把
 * `cli-access` 快照接了进去。两个已知坑各守一条：
 *   1. 快照的 `dopBin` 只有 `path`（没有 `value`），来源推导若不认 `path`，
 *      装配完整的机器也会被记成"来源不可判定"；
 *   2. 快照来源词表是 `mock | enterprise`，readiness 契约却是四枚举；两套词表必须
 *      在装配路径上真的对上（`enterprise → local-diagnostic` / `mock → fixture`），
 *      否则 target 层恒 fail、verdict 恒不等于 pass。
 *
 * 只走真实模块：发现层用一次性 PATH，策略用离线桩，不产生子进程、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, READ_ACTIONS, SERVICE_KEY } from '../src/index.mjs';
import { ENV_KEYS } from '../src/runtime-config.mjs';
import { EVIDENCE_STATES, READINESS_SOURCE_TYPES } from '../src/readiness.mjs';

const EXE = process.platform === 'win32' ? 'dop.exe' : 'dop';

/** 只登记、放行的策略桩：装配层需要 `catalog`（Map）+ `executeAction`。 */
function admitAllPolicy() {
  return {
    catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
    executeAction: async (ctx, action, exec, operation) => operation(),
  };
}

/** 最小宿主：策略必有，webServer / configEditor / 注入端口按需。 */
function host({ configEditor = null, webServer = null, providers = {} } = {}) {
  const provided = new Map();
  const ctx = {
    get: (key) => {
      if (Object.hasOwn(providers, key)) return providers[key];
      if (key === 'policy') return admitAllPolicy();
      if (key === 'webServer') return webServer;
      if (key === 'configEditor') return configEditor;
      return undefined;
    },
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    inject: () => () => {},
    tools: { register: () => () => {} },
  };
  return { ctx, provided };
}

function tempDir(files = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-devops-readiness-'));
  for (const name of files) {
    const file = path.join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(file, 0o755);
  }
  return dir;
}

function withEnv(overrides, run) {
  const names = [...Object.values(ENV_KEYS), 'PATH', 'Path'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of Object.values(ENV_KEYS)) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function mount(options) {
  const { ctx, provided } = host(options);
  apply(ctx, {});
  return { service: provided.get(SERVICE_KEY) };
}

const evidenceOf = (view, id) => view.evidence.find((item) => item.id === id);

test('全装配：发现到 dop 时来源走 local-diagnostic，四层证据全 pass、verdict=pass', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: dir, Path: dir }, async () => {
      const { service } = mount();
      const snapshot = service.cliSnapshot();

      assert.equal(snapshot.entries.dopBin.origin, 'discovered', '发现层拿到 dop');
      assert.equal(snapshot.entries.dopBin.path, target, '快照的路径字段是 path');
      assert.equal(snapshot.entries.dopBin.value, undefined, '快照没有 value（这正是原 bug 读错的字段）');

      const readiness = snapshot.readiness;
      assert.ok(READINESS_SOURCE_TYPES.includes(readiness.sourceType), '结论必须是契约四枚举之一');
      assert.equal(readiness.sourceType, 'local-diagnostic', 'enterprise（dop 已就绪）→ 本机配置诊断');
      assert.equal(evidenceOf(readiness, 'file').state, EVIDENCE_STATES.PASS);
      assert.equal(evidenceOf(readiness, 'executable').state, EVIDENCE_STATES.PASS);
      assert.equal(evidenceOf(readiness, 'target').state, EVIDENCE_STATES.PASS, '来源可判定，target 不该失败');
      assert.equal(evidenceOf(readiness, 'readonly').state, EVIDENCE_STATES.PASS);
      assert.equal(readiness.verdict, 'pass');
      assert.equal(readiness.blockedBy, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全装配：没有 dop 时来源走 fixture，target 不猜成失败/通过，verdict=incomplete', async () => {
  const empty = tempDir();
  try {
    await withEnv({ PATH: empty, Path: empty }, async () => {
      const { service } = mount();
      const readiness = service.cliSnapshot().readiness;

      assert.equal(readiness.sourceType, 'fixture', 'mock（没有 dop）→ 离线夹具');
      assert.equal(evidenceOf(readiness, 'target').state, EVIDENCE_STATES.NOT_RUN, '没有依据就不判定');
      assert.equal(readiness.verdict, 'incomplete', '不是 fail：只是还没配置');
      assert.equal(readiness.blockedBy, 'file');
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
