import assert from 'node:assert/strict';
import test from 'node:test';

import { createGate } from '../src/gate.mjs';
import { createDecisionCache } from '../src/reuse.mjs';

const PUSH = 'gitee.git.push';
const CATALOG = new Map([[PUSH, Object.freeze({ action: PUSH, target: 'repository', category: 'remote-write' })]]);

const healthy = (overrides = {}) => ({
  record: async () => {},
  begin: async () => ({ id: 'receipt-1' }),
  settle: async () => {},
  sinks: () => ({ kind: 'memory' }),
  ...overrides,
});

const childExec = () => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', branch: 'feat/x' },
  callId: 'call-1',
  agent: { kind: 'child', session: { header: { origin: 'subagent', id: 'session-child' } } },
  signal: new AbortController().signal,
});

const pushExec = (callId = 'call-1') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', branch: 'feat/x' },
  callId,
  agent: { kind: 'agent' },
  signal: new AbortController().signal,
});

test('来源拒绝在审计降级时仍然拒绝，并标明证据未记录', async () => {
  const gate = createGate({
    catalog: CATALOG,
    tools: { forge_gitee_write: PUSH },
    rules: { denyDelegatedWrites: true },
    audit: healthy({ record: async () => { throw new Error('synthetic audit gap'); } }),
    getActor: () => 'svc-policy-test',
  });
  const decision = await gate.preExecute({}, childExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /主会话/u);
  assert.equal(decision.evidence, 'unrecorded', '证据写不进去时要让调用链看见');
});

test('来源拒绝在审计正常时不带降级标记', async () => {
  const records = [];
  const gate = createGate({
    catalog: CATALOG,
    tools: { forge_gitee_write: PUSH },
    rules: { denyDelegatedWrites: true },
    audit: healthy({ record: async (fields) => { records.push(fields); } }),
    getActor: () => 'svc-policy-test',
  });
  const decision = await gate.preExecute({}, childExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.evidence, undefined);
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'deny-delegated-writes');
});

test('放行记录写不进去时不留下可复用的确认，重试仍要重新问人', async () => {
  const asked = [];
  const gate = createGate({
    catalog: CATALOG,
    tools: { forge_gitee_write: PUSH },
    rules: { confirmPush: true },
    audit: healthy({
      begin: async () => {
        const error = new Error('audit gap outstanding');
        error.code = 'POLICY_AUDIT_GAP_OUTSTANDING';
        throw error;
      },
    }),
    getActor: () => 'svc-policy-test',
    confirmations: { ask: async (request) => { asked.push(request); return { decision: 'allow' }; } },
    decisionCache: createDecisionCache({ limit: 8 }),
  });
  const first = await gate.preExecute({}, pushExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(first.kind, 'deny');
  assert.equal(asked.length, 1);
  const second = await gate.preExecute({}, pushExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(second.kind, 'deny');
  assert.equal(asked.length, 2, '第一次的允许没有落成记录，就不能被重试复用');
});
