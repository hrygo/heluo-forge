/**
 * r16 / AC-4 / AC-5：就绪证据（`src/readiness.mjs`）的服务端契约。
 *
 * 这里只断言**证据与结论**，不碰页面：四层各自三态、verdict 只由证据决定、
 * 三层视图只出键名、探针缺席时如实降级。任何一条用例都不允许启动子进程或读环境变量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import {
  EVIDENCE_BASIS,
  EVIDENCE_LAYERS,
  EVIDENCE_REASONS,
  EVIDENCE_STATES,
  READINESS_CONTRACT,
  READINESS_OBJECT,
  READINESS_SOURCE_TYPES,
  buildReadiness,
  projectLayers,
  verdictOf,
} from '../src/readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, '..', 'src', 'readiness.mjs'), 'utf8');
const WIN = 'win32';
const POSIX = 'linux';
const EXE = 'C:\\tools\\dop.exe';
const ENDPOINT = 'https://dop.corp.example/api';

const statFile = () => ({ isFile: () => true, isDirectory: () => false, mode: 0o755 });
const statDir = () => ({ isFile: () => false, isDirectory: () => true, mode: 0o755 });
const statPlain = () => ({ isFile: () => false, isDirectory: () => false, mode: 0o644 });

function snapshotOf({ bin = EXE, endpoint = ENDPOINT } = {}) {
  return {
    revision: 'rev-1',
    entries: {
      dopBin: bin === null ? { origin: 'missing' } : { origin: 'discovered', path: bin },
      dopEndpoint: endpoint === null ? { origin: 'missing' } : { origin: 'config', value: endpoint },
      sourceType: { origin: 'default', value: 'enterprise' },
      timeoutMs: { origin: 'default', value: 20000 },
    },
  };
}

const allowed = () => ({ status: 'allowed', code: null });

function build(options = {}) {
  return buildReadiness({
    snapshot: snapshotOf(),
    row: { inherited: { dopBin: EXE }, override: {} },
    sourceType: 'local-diagnostic',
    plugin: { name: '@heluo/forge-devops', version: '0.1.0' },
    platform: WIN,
    statSync: statFile,
    admit: allowed,
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    ...options,
  });
}

const layerOf = (view, id) => view.evidence.find((item) => item.id === id);

test('r16：readiness 常量是页面可比对的稳定契约', () => {
  assert.equal(READINESS_CONTRACT, 1);
  assert.equal(READINESS_OBJECT, 'devops');
  assert.deepEqual([...READINESS_SOURCE_TYPES], ['local-diagnostic', 'fixture', 'enterprise-evidence', 'unknown']);
  assert.deepEqual([...EVIDENCE_LAYERS], ['file', 'executable', 'target', 'readonly']);
  assert.deepEqual({ ...EVIDENCE_STATES }, { PASS: 'pass', FAIL: 'fail', NOT_RUN: 'not-run' });
  assert.deepEqual({ ...EVIDENCE_BASIS }, {
    FILESYSTEM_STAT: 'filesystem-stat',
    CONFIG_SHAPE: 'config-shape',
    POLICY_ADMISSION: 'policy-admission',
  });
});

test('r16：证据恒为四层，顺序与 id 固定，每条只带 id/state/reason/basis', () => {
  const view = build();
  assert.deepEqual(view.evidence.map((item) => item.id), ['file', 'executable', 'target', 'readonly']);
  for (const item of view.evidence) {
    assert.deepEqual(Object.keys(item).sort(), ['basis', 'id', 'reason', 'state']);
    assert.ok(EVIDENCE_LAYERS.includes(item.id));
    assert.ok(Object.values(EVIDENCE_STATES).includes(item.state));
  }
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.evidence));
});

test('r16：file 层三态 —— 普通文件 pass / stat 失败 file-not-found / 目录 is-directory', () => {
  assert.equal(layerOf(build(), 'file').state, 'pass');
  assert.equal(layerOf(build(), 'file').basis, 'filesystem-stat');

  const missing = build({ statSync: () => { throw new Error('ENOENT'); } });
  assert.equal(layerOf(missing, 'file').state, 'fail');
  assert.equal(layerOf(missing, 'file').reason, EVIDENCE_REASONS.FILE_NOT_FOUND);

  const directory = build({ statSync: statDir });
  assert.equal(layerOf(directory, 'file').state, 'fail');
  assert.equal(layerOf(directory, 'file').reason, EVIDENCE_REASONS.IS_DIRECTORY);

  const weird = build({ statSync: statPlain });
  assert.equal(layerOf(weird, 'file').state, 'fail');
});

test('r16：file 层不猜 —— 无 dopBin / 裸命令名 / 没有 statSync 都记 not-run 并带原因', () => {
  const none = build({ snapshot: snapshotOf({ bin: null, endpoint: null }) });
  assert.equal(layerOf(none, 'file').state, 'not-run');
  assert.equal(layerOf(none, 'file').reason, EVIDENCE_REASONS.NO_DOP_BIN);

  const bare = build({ snapshot: snapshotOf({ bin: 'dop' }) });
  assert.equal(layerOf(bare, 'file').state, 'not-run');
  assert.equal(layerOf(bare, 'file').reason, EVIDENCE_REASONS.PATH_RESOLUTION_REQUIRED);

  const noProbe = build({ statSync: null });
  assert.equal(layerOf(noProbe, 'file').state, 'not-run');
  assert.equal(layerOf(noProbe, 'file').reason, EVIDENCE_REASONS.NO_EVIDENCE);
  assert.equal(layerOf(noProbe, 'file').basis, null);
});

test('r16：executable 层三态 —— 直接可执行 pass / 包装脚本未置位 fail / 文件层不成立时 not-run', () => {
  assert.equal(layerOf(build(), 'executable').state, 'pass');

  const wrapper = build({
    snapshot: snapshotOf({ bin: 'C:\\tools\\dop.cmd' }),
    platform: POSIX,
    statSync: () => ({ isFile: () => true, isDirectory: () => false, mode: 0o644 }),
  });
  assert.equal(layerOf(wrapper, 'executable').state, 'fail');
  assert.equal(layerOf(wrapper, 'executable').reason, EVIDENCE_REASONS.NOT_EXECUTABLE);

  const inherited = build({ statSync: () => { throw new Error('ENOENT'); } });
  assert.equal(layerOf(inherited, 'executable').state, 'not-run');
  assert.equal(layerOf(inherited, 'executable').reason, EVIDENCE_REASONS.NO_EVIDENCE);
});

test('r16：target 层三态 —— 来源与形状合法 pass / 来源未知或 endpoint 非法 fail / 两者都空 not-run', () => {
  assert.equal(layerOf(build(), 'target').state, 'pass');
  assert.equal(layerOf(build(), 'target').basis, 'config-shape');

  const unknown = build({ sourceType: 'unknown' });
  assert.equal(layerOf(unknown, 'target').state, 'fail');
  assert.equal(layerOf(unknown, 'target').reason, EVIDENCE_REASONS.SOURCE_TYPE_UNKNOWN);

  const badEndpoint = build({ snapshot: snapshotOf({ endpoint: 'ftp://dop.corp.example' }) });
  assert.equal(layerOf(badEndpoint, 'target').state, 'fail');

  const empty = build({ snapshot: snapshotOf({ bin: null, endpoint: null }) });
  assert.equal(layerOf(empty, 'target').state, 'not-run');
  assert.equal(layerOf(empty, 'target').reason, EVIDENCE_REASONS.NO_EVIDENCE);
});

test('r16：readonly 层 —— 只表示策略准入，pass 不发起任何下游调用', () => {
  const calls = [];
  const view = build({ admit: (request) => { calls.push(request); return allowed(); } });
  assert.deepEqual(calls, [{ action: 'change.read', target: 'dop:change.read' }]);
  assert.equal(layerOf(view, 'readonly').state, 'pass');
  assert.equal(layerOf(view, 'readonly').basis, 'policy-admission');

  const denied = build({ admit: () => ({ status: 'denied', code: 'POLICY_DENIED' }) });
  assert.equal(layerOf(denied, 'readonly').state, 'fail');
  assert.equal(layerOf(denied, 'readonly').reason, EVIDENCE_REASONS.POLICY_DENIED);

  const confirm = build({ admit: () => ({ status: 'confirm', code: 'CONFIRMATION_REQUIRED' }) });
  assert.equal(layerOf(confirm, 'readonly').state, 'not-run');
  assert.equal(layerOf(confirm, 'readonly').reason, EVIDENCE_REASONS.CONFIRMATION_REQUIRED);

  const unavailable = build({ admit: () => ({ status: 'denied', code: 'POLICY_UNAVAILABLE' }) });
  assert.equal(layerOf(unavailable, 'readonly').state, 'not-run');
  assert.equal(layerOf(unavailable, 'readonly').reason, EVIDENCE_REASONS.POLICY_UNAVAILABLE);

  const noPolicy = build({ admit: null });
  assert.equal(layerOf(noPolicy, 'readonly').state, 'not-run');
  assert.equal(layerOf(noPolicy, 'readonly').reason, EVIDENCE_REASONS.NO_EVIDENCE);

  const broken = build({ admit: () => { throw new Error('boom'); } });
  assert.equal(layerOf(broken, 'readonly').state, 'not-run');
  assert.equal(layerOf(broken, 'readonly').reason, EVIDENCE_REASONS.POLICY_UNAVAILABLE);
});

test('r16：verdict 只由证据决定 —— 任一 fail 即 fail，否则任一 not-run 为 incomplete，全 pass 才 pass', () => {
  assert.equal(build().verdict, 'pass');
  assert.equal(build().blockedBy, null);
  assert.equal(build().reason, null);

  const incomplete = build({ admit: null });
  assert.equal(incomplete.verdict, 'incomplete');
  assert.equal(incomplete.blockedBy, 'readonly');
  assert.equal(incomplete.reason, EVIDENCE_REASONS.NO_EVIDENCE);

  const failed = build({ statSync: statDir });
  assert.equal(failed.verdict, 'fail');
  assert.equal(failed.blockedBy, 'file');
  assert.equal(failed.reason, EVIDENCE_REASONS.IS_DIRECTORY);

  // 证据与结论不可能各说一套：verdict 必须能由同一份 evidence 复算出来。
  for (const view of [build(), incomplete, failed]) {
    assert.deepEqual(verdictOf(view.evidence), {
      verdict: view.verdict,
      blockedBy: view.blockedBy,
      reason: view.reason,
    });
  }
});

test('r16：三层视图只出键名（字典序），值一个都不进快照', () => {
  const layers = projectLayers({
    inherited: { timeoutMs: 20000, dopBin: EXE, dopEndpoint: ENDPOINT },
    override: { dopBin: EXE },
  });
  assert.deepEqual([...layers.inherited], ['dopBin', 'dopEndpoint', 'timeoutMs']);
  assert.deepEqual([...layers.override], ['dopBin']);
  assert.deepEqual([...layers.missing], []);
  assert.ok(!JSON.stringify(layers).includes('dop.exe'));
  assert.ok(!JSON.stringify(layers).includes('corp.example'));

  assert.deepEqual([...projectLayers(null).missing], ['LAYERS_UNAVAILABLE']);
  assert.deepEqual([...projectLayers({ inherited: {}, override: {} }).missing], ['INHERITED_EMPTY', 'OVERRIDE_EMPTY']);
  assert.deepEqual([...projectLayers({ inherited: { dopBin: EXE } }).missing], ['OVERRIDE_EMPTY', 'NO_REVISION']);
});

test('r16：来源类型只认四枚举，越界一律 unknown（并让 target 层失败）', () => {
  assert.equal(build({ sourceType: 'fixture' }).sourceType, 'fixture');
  assert.equal(build({ sourceType: 'enterprise-evidence' }).sourceType, 'enterprise-evidence');
  assert.equal(build({ sourceType: 'made-up' }).sourceType, 'unknown');
  assert.equal(build({ sourceType: undefined }).sourceType, 'unknown');
});

/**
 * 词表对齐（PR #215 review / r16 §3）：装配层把 `cli-config.deriveSourceType()` 的结果
 * 直接交给 readiness，取值域是 `mock | enterprise`；readiness 契约却是四枚举。
 * 映射只在这一处完成——`enterprise` 是"本机配置诊断"，**不是**企业证据。
 */
test('r16：来源词表单点对齐 —— enterprise→local-diagnostic，mock→fixture', () => {
  assert.equal(build({ sourceType: 'enterprise' }).sourceType, 'local-diagnostic');
  assert.equal(build({ sourceType: 'mock' }).sourceType, 'fixture');
  // 已经是四枚举的值原样保留（映射幂等）。
  for (const value of READINESS_SOURCE_TYPES) {
    assert.equal(build({ sourceType: value }).sourceType, value, `${value} 不该被再翻译一次`);
  }
  assert.equal(build({ sourceType: 'made-up' }).sourceType, 'unknown');
  assert.equal(build({ sourceType: '' }).sourceType, 'unknown');
  // 映射之后 target 层才可能判定：unknown 会让它恒 fail（原 bug 的下游症状）。
  assert.equal(layerOf(build({ sourceType: 'enterprise' }), 'target').state, EVIDENCE_STATES.PASS);
});

test('r16：at 只取一次时钟并落 ISO；revision/plugin 来自快照投影', () => {
  let ticks = 0;
  const view = build({ now: () => { ticks += 1; return new Date('2026-11-06T12:00:00.000Z'); } });
  assert.equal(ticks, 1);
  assert.equal(view.at, '2026-11-06T12:00:00.000Z');
  assert.equal(view.revision, 'rev-1');
  assert.deepEqual({ ...view.plugin }, { name: '@heluo/forge-devops', version: '0.1.0' });
  assert.equal(view.object, 'devops');
  assert.equal(view.contract, 1);
});

test('r16：零副作用 —— 只经注入的 statSync 读形态，不 import fs/child_process/env', () => {
  assert.ok(!/from 'node:fs'|from 'node:child_process'|require\(/u.test(SOURCE), '模块不得自带 IO 入口');
  assert.ok(!/process\.env/u.test(SOURCE), '模块不读环境变量');
  assert.ok(!/spawn|execFile|exec\(/u.test(SOURCE), '模块不得起子进程');

  const seen = [];
  const view = build({
    statSync: (file) => { seen.push(file); return statFile(); },
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((file) => file === EXE), '只探测 dopBin 这一个路径');
  assert.equal(view.verdict, 'pass');
});
