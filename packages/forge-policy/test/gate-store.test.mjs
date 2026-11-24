import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuditBarrier, createMemorySink } from '../src/audit.mjs';
import { createGate } from '../src/gate.mjs';
import { buildPipeline } from '../src/pipeline.mjs';
import { storeRootsFrom } from '../src/store-protection.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'forge-gate-store-'));
  const storeDir = join(base, 'store');
  const keyDir = `${storeDir}.keys`;
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(storeDir, 'credentials.sqlite'), '');
  writeFileSync(join(keyDir, 'keyring.json'), '{}');
  writeFileSync(join(base, 'notes.txt'), 'hello');
  return { base, storeDir, keyDir, roots: storeRootsFrom({ directory: storeDir, keyDirectory: keyDir }) };
}

function gateWith(storeGuard) {
  const sink = createMemorySink({ buffer: 32 });
  const audit = createAuditBarrier({ sink });
  const gate = createGate({
    catalog: new Map(),
    rules: {},
    pipeline: buildPipeline({}),
    audit,
    storeGuard,
  });
  return { gate, sink };
}

const armed = (roots) => ({ available: true, roots });

const execOf = (name, args) => ({
  name,
  arguments: args,
  callId: `call-${Math.random().toString(16).slice(2)}`,
  agent: { kind: 'agent' },
  signal: new AbortController().signal,
});

test('存档判定先于目录解析：读库与读密钥都拒绝，且工具体未执行', async () => {
  const { base, storeDir, keyDir, roots } = fixture();
  try {
    const { gate } = gateWith(armed(roots));
    let executed = false;
    const decision = await gate.preExecute({}, execOf('read', { file_path: join(storeDir, 'credentials.sqlite') }), async () => {
      executed = true;
      return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.code, 'POLICY_STORE_ACCESS_DENIED');
    assert.match(decision.reason, /凭据存档/u);
    assert.equal(executed, false);
    assert.equal(gate.pendingAdmissions(), 0);

    const keyring = await gate.preExecute({}, execOf('read', { file_path: join(keyDir, 'keyring.json') }), async () => {
      executed = true;
      return { kind: 'allow' };
    });
    assert.equal(keyring.kind, 'deny');
    assert.equal(executed, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('取票调用拒绝发生在 CLI 之前：命令不执行', async () => {
  const { base, roots } = fixture();
  try {
    const { gate } = gateWith(armed(roots));
    let executed = false;
    const decision = await gate.preExecute({}, execOf('bash', { command: 'heluo-forge auth token' }), async () => {
      executed = true;
      return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.code, 'POLICY_IAM_TOKEN_DENIED');
    assert.match(decision.reason, /auth token/u);
    assert.equal(executed, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('位置服务缺席时不判定、存档读取直接放行（阶段仍在流水线首位）', async () => {
  const { base, storeDir, roots } = fixture();
  try {
    const { gate } = gateWith({ available: false, roots: [] });
    assert.equal(gate.stages[0].stage, 'store-access');
    let executed = false;
    const decision = await gate.preExecute({}, execOf('read', { file_path: join(storeDir, 'credentials.sqlite') }), async () => {
      executed = true;
      return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'allow');
    assert.equal(executed, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('公开 API 与无关读写照常放行；whoami 不被误伤', async () => {
  const { base, storeDir, roots } = fixture();
  try {
    const { gate } = gateWith(armed(roots));
    for (const [name, args] of [
      ['bash', { command: 'heluo-forge auth whoami --json' }],
      ['bash', { command: 'heluo-forge auth login --json' }],
      ['read', { file_path: join(base, 'notes.txt') }],
      ['bash', { command: 'git status' }],
      ['bash', { command: `sqlite3 ${join(base, 'notes.txt')} "select 1"` }],
    ]) {
      let executed = false;
      const decision = await gate.preExecute({}, execOf(name, args), async () => {
        executed = true;
        return { kind: 'allow' };
      });
      assert.equal(decision.kind, 'allow', `${name} ${JSON.stringify(args)}`);
      assert.equal(executed, true);
    }
    // 目录内的路径仍被拒，确保上面的放行不是判定失效。
    const blocked = await gate.preExecute({}, execOf('read', { file_path: storeDir }), async () => ({ kind: 'allow' }));
    assert.equal(blocked.kind, 'deny');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝证据不写绝对路径、不写命令原文', async () => {
  const { base, storeDir, roots } = fixture();
  try {
    const { gate, sink } = gateWith(armed(roots));
    await gate.preExecute({}, execOf('bash', { command: `sqlite3 ${join(storeDir, 'credentials.sqlite')} "select * from records"` }), async () => ({ kind: 'allow' }));
    await gate.preExecute({}, execOf('bash', { command: 'heluo-forge auth token' }), async () => ({ kind: 'allow' }));
    const text = JSON.stringify(sink.records());
    assert.equal(text.includes(storeDir), false, '审计不得包含绝对路径');
    assert.equal(text.includes('select * from records'), false, '审计不得包含命令原文');
    assert.equal(text.includes('canary'), false);
    assert.equal(text.includes('auth token'), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
