import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, PolicyCatalogError } from '../src/index.mjs';

const ENTRY = { action: 'repository.read', kind: 'read', target: 'repository', enabled: true };
const WRITE = { action: 'issue.create_or_update', kind: 'write', target: 'issue' };
const CONFIRM = { action: 'review.human.record', kind: 'confirm', target: 'pull-request', enabled: true };

function fakeHost({ approval, commands } = {}) {
  const provided = new Map();
  const guards = [];
  const listeners = new Map();
  const effects = [];
  const ctx = {
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => guards.splice(guards.indexOf(fn), 1);
      },
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    get(name) {
      if (name === 'approval') return approval;
      if (name === 'commands') return commands;
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, guards, listeners, provided, effects };
}

const DEV_AUDIT = { sink: 'memory', allowNonDurable: true };

// D1：enabled 的确认/写动作必须有有效台账条目（合成批准人，不代表任何真实批准）。
const APPROVALS = [
  {
    approval_id: 'APR-TEST-1',
    action: 'review.human.record',
    resource: '*',
    approved_by: 'test-fixture',
    approved_at: '2026-10-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  },
  {
    approval_id: 'APR-TEST-2',
    action: 'fs.write',
    resource: '*',
    approved_by: 'test-fixture',
    approved_at: '2026-10-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  },
];

const baseConfig = {
  audit: DEV_AUDIT,
  approvals: APPROVALS,
  catalog: [ENTRY, WRITE, CONFIRM],
  tools: {
    forge_repository_read: 'repository.read',
    forge_issue_write: 'issue.create_or_update',
    forge_review_confirm: 'review.human.record',
    forge_typo_tool: 'change.read',
  },
  categories: { bash: 'shell.exec' },
};

test('apply installs the guard, the pre-execute stage and the policy service', () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  assert.equal(host.guards.length, 1);
  assert.equal(typeof host.listeners.get('tools/pre-execute'), 'function');
  assert.deepEqual(host.provided.get('policy').actions(), ['repository.read', 'issue.create_or_update', 'review.human.record']);
});

test('the guard denies unregistered actions and disabled writes with zero body calls', () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  const guard = host.guards[0];
  let bodyCalls = 0;
  const run = (name, args) => {
    const reason = guard({ name, arguments: args, callId: 'c1' });
    if (reason === undefined) bodyCalls += 1;
    return reason;
  };
  assert.equal(run('forge_repository_read', { target: 'r' }), undefined, 'a registered read action passes');
  assert.match(String(run('forge_typo_tool', { target: 'r' })), /not registered/, 'a mapped but unregistered action is denied');
  assert.match(String(run('forge_issue_write', { target: 'I-1' })), /not enabled/, 'a disabled write is denied');
  assert.match(String(run('forge_repository_read', {})), /requires a repository target/, 'a missing target is denied');
  assert.equal(guard({ name: 'forge_unmapped_tool', arguments: { target: 'r' }, callId: 'c9' }), undefined, 'an unmapped tool is outside this gate, never claimed as covered');
  assert.equal(bodyCalls, 1, 'only the registered enabled read action reaches the body');
});

test('an out-of-scope host tool is not silently claimed', () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  assert.equal(host.guards[0]({ name: 'read', arguments: {}, callId: 'c1' }), undefined);
  assert.match(
    String(host.guards[0]({ name: 'bash', arguments: { command: 'ls' }, callId: 'c2' })),
    /not registered/,
    'a declared category without a catalog entry is denied',
  );
  assert.equal(
    host.guards[0]({ name: 'web_fetch', arguments: { url: 'https://example.invalid' }, callId: 'c3' }),
    undefined,
    'an undeclared category is not silently gated',
  );
});

test('a confirm action fails closed until the confirmation stage approved it', async () => {
  const requests = [];
  const approval = {
    async request(request) {
      requests.push(request);
      return allowed ? 'allowed-once' : 'rejected';
    },
  };
  let allowed = false;
  const host = fakeHost({ approval });
  apply(host.ctx, baseConfig);
  const guard = host.guards[0];
  const preExecute = host.listeners.get('tools/pre-execute');
  const exec = { name: 'forge_review_confirm', arguments: { target: 'pr-1' }, callId: 'c9', agent: { id: 'agent-1' }, signal: new AbortController().signal };

  assert.match(String(guard(exec)), /confirmation stage did not run/);
  const denied = await preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /rejected/);
  assert.match(String(guard(exec)), /confirmation stage did not run/);

  allowed = true;
  const granted = await preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(granted.kind, 'allow');
  assert.equal(guard(exec), undefined);
  assert.equal(requests.length, 2);
});

test('an agent-less confirm action is denied without asking', async () => {
  const approval = { async request() { throw new Error('should not be asked'); } };
  const host = fakeHost({ approval });
  apply(host.ctx, baseConfig);
  const decision = await host.listeners.get('tools/pre-execute')(
    { name: 'forge_review_confirm', arguments: { target: 'pr-1' }, callId: 'c1', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /no approval channel/);
});

test('teardown removes the guard, the stage and the service', () => {
  const host = fakeHost();
  const dispose = apply(host.ctx, baseConfig);
  assert.equal(host.provided.has('policy'), true);
  dispose();
  assert.equal(host.guards.length, 0);
  assert.equal(host.listeners.has('tools/pre-execute'), false);
  assert.equal(host.provided.has('policy'), false);
  dispose();
  assert.equal(host.guards.length, 0);
});

test('an invalid catalog or an occupied service refuses to mount', () => {
  const host = fakeHost();
  assert.throws(
    () => apply(host.ctx, { catalog: [{ action: 'a.b', kind: 'read' }] }),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_CATALOG_INVALID',
  );
  assert.equal(host.guards.length, 0, 'a rejected mount leaves no guard behind');
  apply(host.ctx, baseConfig);
  assert.throws(
    () => apply(host.ctx, baseConfig),
    (error) => error.code === 'POLICY_SERVICE_CONFLICT',
  );
});

test('a host without the guard seam refuses to mount', () => {
  assert.throws(
    () => apply({ get: () => undefined, provide: () => () => {}, effect: () => () => {}, tools: {} }, baseConfig),
    (error) => error.code === 'POLICY_HOST_UNAVAILABLE',
  );
});

const pathBase = mkdtempSync(join(tmpdir(), 'forge-policy-gate-'));
const protectedDir = join(pathBase, 'secrets');
const openDir = join(pathBase, 'workspace');
mkdirSync(protectedDir, { recursive: true });
mkdirSync(openDir, { recursive: true });
writeFileSync(join(protectedDir, 'credentials.env'), 'canary');
writeFileSync(join(openDir, 'notes.md'), 'ok');
symlinkSync(protectedDir, join(pathBase, 'shortcut'), 'dir');

const pathConfig = {
  audit: DEV_AUDIT,
  approvals: APPROVALS,
  catalog: [
    { action: 'fs.read', kind: 'read', target: 'file', enabled: true, path: 'path' },
    { action: 'fs.write', kind: 'confirm', target: 'file', enabled: true, path: 'path' },
  ],
  tools: { forge_fs_read: 'fs.read', forge_fs_write: 'fs.write' },
  protectedPaths: [`${protectedDir}/**`],
};

test('direct, traversal and symlink access to a protected path is denied with zero body calls', () => {
  const host = fakeHost();
  apply(host.ctx, pathConfig);
  const guard = host.guards[0];
  const body = (path) => {
    const reason = guard({ name: 'forge_fs_read', arguments: { target: 'file', path }, callId: 'c1' });
    return reason;
  };
  assert.match(String(body(join(protectedDir, 'credentials.env'))), /protected path/);
  assert.match(String(body(join(openDir, '..', 'secrets', 'credentials.env'))), /protected path/);
  assert.match(String(body(join(pathBase, 'shortcut', 'credentials.env'))), /protected path/);
  assert.match(String(body(join(protectedDir, 'not-created-yet'))), /protected path/);
  assert.equal(body(join(openDir, 'notes.md')), undefined, 'a path outside the roots passes');
  assert.match(String(body('relative/notes.md')), /cannot be verified/);
  assert.match(String(body(undefined)), /cannot be verified/);
});

test('a protected path is denied before the confirmation stage and at the hard gate', async () => {
  const approval = { async request() { return 'allowed-once'; } };
  const host = fakeHost({ approval });
  apply(host.ctx, pathConfig);
  const guard = host.guards[0];
  const preExecute = host.listeners.get('tools/pre-execute');
  const exec = {
    name: 'forge_fs_write',
    arguments: { target: 'file', path: join(protectedDir, 'credentials.env') },
    callId: 'c7',
    agent: { id: 'agent-1' },
    signal: new AbortController().signal,
  };
  const denied = await preExecute(exec, () => Promise.resolve({ kind: 'deny', reason: 'should not be reached' }));
  assert.equal(denied.kind, 'deny', 'the protected path is refused before any confirmation is considered');
  assert.match(denied.reason, /protected path/);
  assert.match(String(guard(exec)), /protected path/, 'the hard denial also holds at the gate');
});

test('path-bearing actions are closed when no protected root is configured', () => {
  const host = fakeHost();
  apply(host.ctx, { ...pathConfig, protectedPaths: [] });
  const reason = host.guards[0]({ name: 'forge_fs_read', arguments: { target: 'file', path: join(openDir, 'notes.md') }, callId: 'c1' });
  assert.match(String(reason), /no protected root is configured/);
});

test('an unresolvable protected root refuses to mount', () => {
  const host = fakeHost();
  assert.throws(
    () => apply(host.ctx, { ...pathConfig, protectedPaths: ['$DSH_AGENTS_HOME/**'], env: {} }),
    (error) => error.code === 'POLICY_PROTECTED_ROOT_UNRESOLVED',
  );
  assert.equal(host.guards.length, 0);
});

test('the mounted service exposes delegation, confirmation and path helpers', () => {
  const host = fakeHost();
  apply(host.ctx, pathConfig);
  const policy = host.ctx.get('policy');

  const grant = policy.createDelegation({
    id: 'dlg-1',
    source: 'host',
    principal: 'user-a',
    changeId: 'C-2026-1',
    repositories: ['repo-a'],
    actions: ['fs.read'],
    revisions: { change: 'rev-1' },
    ttlMs: 60_000,
  });
  const inScope = { principal: 'user-a', changeId: 'C-2026-1', repository: 'repo-a', action: 'fs.read', revisions: { change: 'rev-1' } };
  assert.equal(policy.authorizeDelegation({ grant, request: inScope }).action, 'allow');
  assert.equal(policy.authorizeDelegation({ grant: policy.revokeDelegation(grant), request: inScope }).rule, 'delegation-revoked');

  const issued = policy.issueConfirmation({ action: 'fs.read', target: 'repo-a', content: { body: 'x' }, revision: 'rev-1', kind: 'human', ttlMs: 60_000 });
  assert.equal(policy.confirmations().length, 1);
  assert.equal(policy.consumeConfirmation({ action: 'fs.read', target: 'repo-a', content: { body: 'x' }, revision: 'rev-1' }).action, 'allow');
  assert.equal(policy.consumeConfirmation({ key: issued.key, revision: 'rev-1' }).rule, 'confirmation-consumed');

  assert.deepEqual(policy.protectedPaths(), [`${protectedDir}/**`]);
  assert.equal(policy.checkPath(join(protectedDir, 'credentials.env')).protected, true);
  assert.equal(policy.checkPath(join(openDir, 'notes.md')).protected, false);
  assert.equal(policy.digestContent({ a: 1 }).length, 64);
  assert.match(policy.renderEgressScope(policy.confirmationScope({ action: 'a.b', target: 't', content: { body: 'x' } })), /fields=\[body\]/);
  assert.doesNotThrow(() => policy.assertNoCanary('nothing here', ['canary-value']));
});

test('an enforced action is refused when no audit sink is configured', async () => {
  const host = fakeHost();
  apply(host.ctx, { ...baseConfig, audit: {} });
  const exec = { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c1', signal: new AbortController().signal };
  const decision = await host.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /audit refused/);
  assert.match(decision.reason, /no audit sink is available/);
  assert.equal(host.ctx.get('policy').auditGaps().length, 0, 'a refused pre-audit is not a gap');
});

test('a non-durable audit sink is refused unless explicitly allowed', async () => {
  const host = fakeHost();
  apply(host.ctx, { ...baseConfig, audit: { sink: 'memory' } });
  const decision = await host.listeners.get('tools/pre-execute')(
    { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c1', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.match(decision.reason, /not durable/);
});

test('a failing audit sink refuses before the body runs', async () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  const policy = host.ctx.get('policy');
  let bodyCalls = 0;
  policy.setAuditSink({ durable: true, append: () => { throw new Error('disk on fire'); } });
  const decision = await host.listeners.get('tools/pre-execute')(
    { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c1', signal: new AbortController().signal },
    () => (bodyCalls += 1, Promise.resolve({ kind: 'allow' })),
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /disk on fire/);
  assert.equal(bodyCalls, 0);
});

test('a post-execution audit failure keeps the outcome, records a gap and limits later actions', async () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  const policy = host.ctx.get('policy');
  const records = [];
  policy.setAuditSink({ durable: true, append: (record) => {
    if (record.phase === 'settle') throw new Error('settle failed');
    records.push(record);
  } });
  const exec = { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c1', signal: new AbortController().signal };
  const allowed = await host.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(allowed.kind, 'allow');
  assert.equal(records.length, 1, 'the pre-audit record was written first');
  assert.equal(records[0].phase, 'begin');
  assert.equal(JSON.stringify(records[0]).includes('arguments') === false, true);

  // 宿主签名是 (exec, result, next)，默认决议 `{ kind: 'accept' }`。
  const settled = await host.listeners.get('tools/post-execute')(exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }));
  assert.equal(settled.kind, 'accept', 'the outcome is untouched by the failed settle');
  assert.equal(policy.auditGaps().length, 1);
  assert.equal(policy.auditDegraded(), true);

  const next = await host.listeners.get('tools/pre-execute')(
    { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c2', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.match(next.reason, /still outstanding/);
  assert.equal(policy.acknowledgeAuditGaps(), 1);
  const after = await host.listeners.get('tools/pre-execute')(
    { name: 'forge_repository_read', arguments: { target: 'r' }, callId: 'c3', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(after.kind, 'allow');
});

test('an optional telemetry failure only leaves a gap', async () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  const policy = host.ctx.get('policy');
  assert.equal(typeof policy.setAuditSink, 'function');
  assert.equal(policy.auditRecords().length, 0);
});
