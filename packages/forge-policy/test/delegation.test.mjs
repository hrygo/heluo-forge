import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeDelegation, createDelegation, PolicyDelegationError, revokeDelegation } from '../src/delegation.mjs';
import { compileCatalog } from '../src/catalog.mjs';

const catalog = compileCatalog([
  { action: 'change.read', kind: 'read', target: 'change', enabled: true },
  { action: 'repository.read', kind: 'read', target: 'repository', enabled: true },
  { action: 'issue.create_or_update', kind: 'write', target: 'issue', enabled: true },
  { action: 'issue.close', kind: 'write', target: 'issue' },
]);

const facts = {
  id: 'dlg-1',
  source: 'host',
  principal: 'user-a',
  changeId: 'C-2026-1',
  repositories: ['repo-a'],
  actions: ['change.read', 'issue.create_or_update'],
  revisions: { change: 'rev-1' },
  ttlMs: 3_600_000,
  now: 1_000,
};

const request = { principal: 'user-a', changeId: 'C-2026-1', repository: 'repo-a', action: 'change.read', revisions: { change: 'rev-1' } };

test('a host delegation allows in-scope actions and denies everything else', () => {
  const grant = createDelegation(facts);
  assert.equal(authorizeDelegation({ grant, request, catalog, now: 2_000 }).action, 'allow');
  const cases = [
    [{ ...request, action: 'repository.read' }, 'delegation-action-out-of-scope'],
    [{ ...request, action: 'issue.close' }, 'delegation-action-disabled'],
    [{ ...request, action: 'story.read' }, 'delegation-action-unregistered'],
    [{ ...request, principal: 'user-b' }, 'delegation-principal-mismatch'],
    [{ ...request, changeId: 'C-2026-2' }, 'delegation-change-mismatch'],
    [{ ...request, repository: 'repo-b' }, 'delegation-repository-out-of-scope'],
    [{ ...request, revisions: { change: 'rev-2' } }, 'delegation-revision-drift'],
    [request, 'delegation-expired', 4_000_000],
  ];
  for (const [candidate, rule, now] of cases) {
    const decision = authorizeDelegation({ grant, request: candidate, catalog, now: now ?? 2_000 });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.rule, rule);
  }
});

test('a model-supplied or missing delegation cannot authorize anything', () => {
  assert.throws(
    () => createDelegation({ ...facts, source: 'model' }),
    (error) => error instanceof PolicyDelegationError && error.code === 'POLICY_DELEGATION_UNTRUSTED_SOURCE',
  );
  assert.equal(authorizeDelegation({ request, catalog }).rule, 'delegation-missing');
  assert.equal(
    authorizeDelegation({ grant: { ...createDelegation(facts), source: 'model' }, request, catalog }).rule,
    'delegation-untrusted-source',
  );
});

test('a revoked delegation stops authorizing immediately', () => {
  const grant = createDelegation(facts);
  const revoked = revokeDelegation(grant, { reason: 'user cancelled', now: 2_000 });
  assert.equal(authorizeDelegation({ grant, request, catalog, now: 2_500 }).action, 'allow', 'the original object is unchanged');
  const decision = authorizeDelegation({ grant: revoked, request, catalog, now: 2_500 });
  assert.equal(decision.rule, 'delegation-revoked');
  assert.throws(() => revokeDelegation(undefined), (error) => error.code === 'POLICY_DELEGATION_MISSING');
});

test('an incomplete delegation is refused at creation', () => {
  const invalid = [
    [{ ...facts, id: '' }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, repositories: [] }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, actions: [] }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, ttlMs: 0 }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, principal: '' }, 'POLICY_DELEGATION_INVALID'],
  ];
  for (const [input, code] of invalid) {
    assert.throws(() => createDelegation(input), (error) => error.code === code);
  }
});
