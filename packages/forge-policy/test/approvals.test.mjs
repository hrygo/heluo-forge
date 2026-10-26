import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, APPROVAL_REASONS, compileApprovals, decideApproval, PolicyApprovalError } from '../src/index.mjs';

/** 台账条目：合成值，不含任何真实批准人或凭据。 */
const ROW = {
  approval_id: 'APR-0001',
  action: 'issue.close',
  resource: 'group/repo',
  approved_by: 'security-review-board',
  approved_at: '2026-10-01T00:00:00Z',
  revision_range: ['R-1', 'R-2'],
  expires_at: '2099-01-01T00:00:00Z',
};

const EXPIRED = { ...ROW, approval_id: 'APR-0002', action: 'pr.create_or_update', expires_at: '2026-10-02T00:00:00Z' };

const WRITE = { action: 'issue.close', kind: 'write', target: 'issue', enabled: true };
const READ = { action: 'issue.read', kind: 'read', target: 'issue', enabled: true };

function fakeHost() {
  const provided = new Map();
  const guards = [];
  const listeners = new Map();
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    get: (name) => provided.get(name),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, guards, provided, listeners };
}

const mount = (config) => {
  const host = fakeHost();
  apply(host.ctx, { audit: { sink: 'memory', allowNonDurable: true }, ...config });
  return host;
};

test('把一个写动作置为 enabled 但没有台账条目：挂载直接拒绝', () => {
  assert.throws(
    () => mount({ catalog: [WRITE], approvals: [], tools: { forge_issue_close: 'issue.close' } }),
    (error) =>
      error instanceof PolicyApprovalError &&
      error.code === 'POLICY_APPROVAL_REQUIRED' &&
      error.details.offenders.some((row) => row.action === 'issue.close' && row.reason === APPROVAL_REASONS.NO_APPROVAL),
  );
});

test('台账条目存在且当前有效：写动作可以开放，审计后门禁放行', async () => {
  const host = mount({
    catalog: [WRITE],
    approvals: [ROW],
    tools: { forge_issue_close: 'issue.close' },
  });
  const exec = { name: 'forge_issue_close', arguments: { target: 'group/repo', revision: 'R-1' }, callId: 'c1' };
  assert.equal((await host.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(host.guards[0](exec), undefined);
});

test('台账条目已过期：不足以开放写动作（拒绝原因 expired）', () => {
  assert.throws(
    () => mount({ catalog: [{ ...WRITE, action: 'pr.create_or_update', target: 'pull-request' }], approvals: [EXPIRED], tools: { forge_pr: 'pr.create_or_update' } }),
    (error) => error.code === 'POLICY_APPROVAL_REQUIRED' && error.details.offenders[0].reason === APPROVAL_REASONS.EXPIRED,
  );
});

test('台账条目属于别的动作：不算批准', () => {
  assert.throws(
    () =>
      mount({
        catalog: [{ ...WRITE, action: 'commit.record', target: 'repository' }],
        approvals: [ROW],
        tools: { forge_commit: 'commit.record' },
      }),
    (error) => error.code === 'POLICY_APPROVAL_REQUIRED' && error.details.offenders[0].reason === APPROVAL_REASONS.NO_APPROVAL,
  );
});

test('只读动作不需要台账，但仍需要必要审计', async () => {
  const host = mount({ catalog: [READ], approvals: [], tools: { forge_issue_read: 'issue.read' } });
  const exec = { name: 'forge_issue_read', arguments: { target: 'I-1' }, callId: 'c1' };
  assert.equal((await host.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(host.guards[0](exec), undefined);
});

test('台账条目校验：字段缺失、时间倒挂、重复 id、未知字段都报错', () => {
  const bad = [
    { ...ROW, approved_by: '' },
    { ...ROW, approved_at: 'not-a-date' },
    { ...ROW, expires_at: '2020-01-01T00:00:00Z' },
    { ...ROW, revision_range: ['R-1', ''] },
    { ...ROW, note: 'extra' },
    [ROW, ROW],
  ];
  for (const entry of bad) {
    assert.throws(() => compileApprovals([entry]), (error) => error instanceof PolicyApprovalError);
  }
  assert.throws(() => compileApprovals('nope'), (error) => error.code === 'POLICY_APPROVAL_INVALID');
});

test('decideApproval 的资源与版本范围判定各自归因', () => {
  const approvals = compileApprovals([ROW]);
  const now = Date.parse('2026-10-24T00:00:00Z');
  assert.deepEqual(decideApproval({ approvals, action: 'issue.close', resource: 'group/repo', revision: 'R-1', now }), {
    allowed: true,
    reason: null,
    approvalId: 'APR-0001',
  });
  assert.equal(
    decideApproval({ approvals, action: 'issue.close', resource: 'other/repo', revision: 'R-1', now }).reason,
    APPROVAL_REASONS.RESOURCE_MISMATCH,
  );
  assert.equal(
    decideApproval({ approvals, action: 'issue.close', resource: 'group/repo', revision: 'R-9', now }).reason,
    APPROVAL_REASONS.REVISION_OUT_OF_RANGE,
  );
  assert.equal(
    decideApproval({ approvals, action: 'issue.close', now: Date.parse('2020-01-01T00:00:00Z') }).reason,
    APPROVAL_REASONS.NOT_YET_VALID,
  );
  assert.equal(decideApproval({ approvals, action: 'review.ai.publish', now }).reason, APPROVAL_REASONS.NO_APPROVAL);
});

test('策略服务暴露台账与逐动作判定，且台账里不含任何凭据字段', () => {
  const { provided } = mount({ catalog: [WRITE, READ], approvals: [ROW], tools: { forge_issue_close: 'issue.close' } });
  const service = provided.get('policy');
  assert.equal(service.approvals().length, 1);
  assert.equal(service.approvalFor('issue.close', { resource: 'group/repo', revision: 'R-2' }).allowed, true);
  const keys = Object.keys(service.approvals()[0]).sort();
  assert.deepEqual(keys, ['action', 'approvalId', 'approvedAt', 'approvedBy', 'expiresAt', 'resource', 'revisionRange']);
});
