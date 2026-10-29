import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply as applyPolicy } from '@heluo/forge-policy';

import { apply as applyDevops, READ_ACTIONS, READER_KEY, SERVICE_KEY } from '../src/index.mjs';

/**
 * QA N-1（2026-10-28 第 2 轮，P1）：补丁层只插策略行的 `id`/`name`，没给 `catalog`。
 *
 * `@heluo/forge-policy` 的 `catalog` 缺省是 `[]`（编译出空目录），而 devops 把"四个只读动作
 * 已登记且 `enabled`"当作挂载前置（硬依赖、fail closed）。空目录 → `apply()` 抛
 * `POLICY_ACTION_UNREGISTERED`，宿主 `dump-config` 超时，AC-8 不成立。
 *
 * 本文件是这条缺陷的**永久门禁**：直接解析分发出去的 `cordis.patch.yml`，把其中的策略配置
 * 交给真实的 `@heluo/forge-policy` 装配，再在同一个假宿主上挂 devops。它同时覆盖两类
 * 容易只修一半的形态——只补目录不补审计（挂载通过但每个动作都被 `POLICY_AUDIT_*` 拒绝），
 * 以及只在 devops 补丁层修、其他挂 devops 的补丁层继续缺目录（第 3、4 条用例做全仓扫描）。
 */

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(here, '..', '..');

const ROW = /^ {4}- id: (\S+)\s*$/u;
const NAME = /^ {6}name: '([^']+)'\s*$/u;
const CONFIG = /^ {6}config:\s*$/u;
const CATALOG = /^ {8}catalog:\s*$/u;
const AUDIT = /^ {8}audit:\s*$/u;
const CATALOG_ENTRY = /^ {10}- (\{.*\})\s*$/u;
const CONFIG_ENTRY = /^ {10}([A-Za-z][\w]*): (.+?)\s*$/u;

/** 标量：布尔 / 单引号字符串 / 原样字符串（补丁层只用到这三种）。 */
function scalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^'.*'$/u.test(value)) return value.slice(1, -1);
  return value;
}

/** 解析补丁层用到的 YAML 子集：`{ action: 'x', kind: 'read', target: 'y', enabled: true }`。 */
function flowMap(text) {
  const body = text.replace(/^\{/u, '').replace(/\}$/u, '');
  const parsed = {};
  for (const chunk of body.split(',')) {
    const match = /^\s*([A-Za-z][\w]*):\s*(.+?)\s*$/u.exec(chunk);
    if (match !== null) parsed[match[1]] = scalar(match[2]);
  }
  return parsed;
}

/**
 * 逐行解析 insert 行（补丁层只用这一种写法）：返回 `{ id, name, catalog, audit }`，
 * 其中 `catalog` 是动作条目数组、`audit` 是原样键值（未出现的键即未配置）。
 */
export function parsePatch(text) {
  const rows = [];
  let current = null;
  let section = null;
  for (const line of text.split('\n')) {
    const row = ROW.exec(line);
    if (row !== null) {
      current = { id: row[1], name: null, catalog: [], audit: {} };
      rows.push(current);
      section = null;
      continue;
    }
    if (current === null) continue;
    const name = NAME.exec(line);
    if (name !== null) {
      current.name = name[1];
      continue;
    }
    if (CONFIG.test(line)) {
      section = 'config';
      continue;
    }
    if (CATALOG.test(line)) {
      section = 'catalog';
      continue;
    }
    if (AUDIT.test(line)) {
      section = 'audit';
      continue;
    }
    const entry = CATALOG_ENTRY.exec(line);
    if (entry !== null && section === 'catalog') {
      current.catalog.push(flowMap(entry[1]));
      continue;
    }
    const pair = CONFIG_ENTRY.exec(line);
    if (pair !== null && section === 'audit') {
      current.audit[pair[1]] = scalar(pair[2]);
      continue;
    }
  }
  return rows;
}

/** 挂 devops 的补丁层必须自带的策略配置：覆盖四个只读动作，且审计舱可用。 */
function assertPolicyConfigComplete(patch, label) {
  const policy = patch.find((row) => row.name === '@heluo/forge-policy');
  assert.ok(policy, `${label}：必须插入 @heluo/forge-policy（devops 的策略门禁是硬依赖）`);
  assert.ok(
    policy.catalog.length > 0,
    `${label}：策略行必须带 config.catalog；空目录会让 devops 以 POLICY_ACTION_UNREGISTERED 拒绝挂载`,
  );
  const registered = new Map(policy.catalog.map((entry) => [entry.action, entry]));
  for (const action of READ_ACTIONS) {
    const entry = registered.get(action);
    assert.ok(entry, `${label}：策略目录缺只读动作 ${action}`);
    assert.equal(entry.enabled, true, `${label}：${action} 必须 enabled:true，否则 devops 拒绝挂载`);
    assert.equal(entry.kind, 'read', `${label}：${action} 必须是 read 动作用来收紧写面`);
    assert.ok(
      typeof entry.target === 'string' && entry.target.trim().length > 0,
      `${label}：${action} 必须声明 target（策略按它给出"目标缺失"的可见原因）`,
    );
  }
  // 没有可用审计舱时策略对每个动作都拒绝（POLICY_AUDIT_UNAVAILABLE / NOT_DURABLE），
  // 挂载能过但读不到任何事实——只补目录不补审计是"修了一半"。
  assert.ok(
    policy.audit !== undefined && Object.keys(policy.audit).length > 0,
    `${label}：策略行必须配置 config.audit；默认空对象会让每个动作在审计前置处被拒绝`,
  );
  if (policy.audit.sink === 'memory') {
    assert.equal(
      policy.audit.allowNonDurable,
      true,
      `${label}：内存审计舱不是持久 sink，必须显式 allowNonDurable:true（否则每次动作都被拒）`,
    );
  }
  return policy;
}

/** 假宿主：策略与 devops 都要 get/provide/effect，devops 还要 tools.register。 */
function createHost() {
  const services = new Map();
  const tools = new Map();
  const effects = [];
  return {
    services,
    tools,
    effects,
    ctx: {
      get: (key) => services.get(key),
      provide: (key, value) => {
        services.set(key, value);
        return () => services.delete(key);
      },
      effect: (factory) => {
        effects.push(factory);
        return () => {};
      },
      tools: {
        guard: () => () => {},
        register: (definition) => {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
    },
  };
}

const goodReader = () => ({
  read: async ({ action, target }) => ({
    status: 'succeeded',
    action,
    target_ref: target,
    source_revision: 'dop:0123456789ab',
    facts: { title: '夹具变更' },
  }),
});

test('补丁层给 devops 挂载所需的最小策略目录，并显式配置审计', async () => {
  const text = await readFile(join(here, 'cordis.patch.yml'), 'utf8');
  const patch = parsePatch(text);
  assert.deepEqual(
    patch.map((row) => row.id),
    ['heluo-policy', 'forge-devops'],
    '补丁层只插这两行且策略先行',
  );
  assertPolicyConfigComplete(patch, 'packages/forge-devops/cordis.patch.yml');
});

test('按补丁层配置真实装配策略 + devops：挂载不抛、9 工具、读经门禁放行', async () => {
  const text = await readFile(join(here, 'cordis.patch.yml'), 'utf8');
  const patch = parsePatch(text);
  const policyRow = assertPolicyConfigComplete(patch, 'packages/forge-devops/cordis.patch.yml');

  const host = createHost();
  // 1) 用补丁层里的 config 挂真实的策略服务（不造假目录）。
  applyPolicy(host.ctx, { catalog: policyRow.catalog, audit: policyRow.audit });
  const policy = host.services.get('policy');
  assert.ok(policy, '策略必须提供 policy 服务');
  for (const action of READ_ACTIONS) {
    assert.equal(policy.catalog.get(action)?.enabled, true, `${action} 必须已登记并启用`);
  }

  // 2) 同一宿主上挂 devops：修复前这里会抛 POLICY_ACTION_UNREGISTERED。
  const reader = goodReader();
  host.services.set(READER_KEY, reader);
  applyDevops(host.ctx, {});
  const service = host.services.get(SERVICE_KEY);
  assert.ok(service, 'devops 必须提供自己的服务');

  assert.equal(service.status(), 'ready', '注入了只读适配器后状态必须是 ready');
  assert.equal(service.toolNames().length, 9, '工具面 9 个（4 只读 + 5 流程）');

  // 3) 读动作走真实门禁 + 审计：审计舱不可用会在这里变成 POLICY_DENIED。
  const result = await service.read({ action: 'change.read', target: 'CHG-2026-0042' });
  assert.equal(result.status, 'succeeded', '策略放行后读结果必须原样归一化返回');
  assert.ok(policy.auditRecords().length > 0, '前置审计必须真的写入记录，而不是跳过审计');
});

test('全仓扫描：任何插入 forge-devops 的补丁层都必须自带可用策略目录', async () => {
  const packagesDir = join(repoRoot, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const mounting = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text;
    try {
      text = await readFile(join(packagesDir, entry.name, 'cordis.patch.yml'), 'utf8');
    } catch {
      continue; // 该包没有补丁层
    }
    const patch = parsePatch(text);
    if (patch.some((row) => row.name === '@heluo/forge-devops')) mounting.push({ dir: entry.name, patch });
  }
  assert.ok(mounting.length > 0, '至少本包补丁层必须挂 forge-devops');
  for (const { dir, patch } of mounting) {
    assertPolicyConfigComplete(patch, `packages/${dir}/cordis.patch.yml`);
  }
});
