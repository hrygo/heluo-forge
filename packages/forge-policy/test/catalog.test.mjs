import assert from 'node:assert/strict';
import test from 'node:test';

import { compileCatalog, decideAction, PolicyCatalogError } from '../src/catalog.mjs';

const ENTRY = { action: 'repository.read', kind: 'read', target: 'repository', enabled: true };

test('compiling a valid catalog keeps the registered fields', () => {
  const catalog = compileCatalog([ENTRY, { action: 'issue.create_or_update', kind: 'write', target: 'issue' }]);
  assert.equal(catalog.get('repository.read').kind, 'read');
  assert.equal(catalog.get('repository.read').retry, 'read_recheck');
  assert.equal(catalog.get('issue.create_or_update').enabled, false);
  assert.equal(catalog.get('issue.create_or_update').retry, 'none');
  assert.ok(Object.isFrozen(catalog.get('repository.read')));
});

test('an invalid catalog throws instead of silently shrinking', () => {
  const cases = [
    [[{ action: 'a.b', kind: 'unknown', target: 't' }], 'POLICY_CATALOG_INVALID'],
    [[{ action: 'a.b', kind: 'read' }], 'POLICY_CATALOG_INVALID'],
    [[{ kind: 'read', target: 't' }], 'POLICY_CATALOG_INVALID'],
    [[ENTRY, { ...ENTRY }], 'POLICY_CATALOG_DUPLICATE'],
    [[{ action: 'a.b', kind: 'read', target: 't', retry: 'auto' }], 'POLICY_CATALOG_INVALID'],
  ];
  for (const [entries, code] of cases) {
    assert.throws(() => compileCatalog(entries), (error) => error instanceof PolicyCatalogError && error.code === code);
  }
  assert.throws(() => compileCatalog('nope'), (error) => error.code === 'POLICY_CATALOG_INVALID');
});

test('an uncompiled catalog denies every action', () => {
  const decision = decideAction({ catalog: undefined, action: 'repository.read', target: 'r' });
  assert.deepEqual(decision, { action: 'deny', reason: 'policy catalog is not compiled', rule: 'policy-unavailable' });
});

test('unregistered, disabled and target-less actions are denied', () => {
  const catalog = compileCatalog([ENTRY, { action: 'issue.create_or_update', kind: 'write', target: 'issue' }]);
  assert.equal(decideAction({ catalog, action: 'change.read', target: 'C-1' }).rule, 'unregistered-action');
  assert.equal(decideAction({ catalog, action: 'issue.create_or_update', target: 'I-1' }).rule, 'action-disabled');
  assert.equal(decideAction({ catalog, action: 'repository.read' }).rule, 'target-required');
  assert.equal(decideAction({ catalog, action: 'repository.read', target: '   ' }).rule, 'target-required');
});

test('a registered read action is allowed and a confirm action asks', () => {
  const catalog = compileCatalog([ENTRY, { action: 'review.human.record', kind: 'confirm', target: 'pull-request', enabled: true }]);
  assert.equal(decideAction({ catalog, action: 'repository.read', target: 'r' }).action, 'allow');
  const confirm = decideAction({ catalog, action: 'review.human.record', target: 'pr-1' });
  assert.equal(confirm.action, 'confirm');
  assert.equal(confirm.rule, 'confirm-required');
});

test('egress policy cannot be widened by the caller', () => {
  const catalog = compileCatalog([
    { action: 'http.egress', kind: 'read', target: 'endpoint', enabled: true, egress: 'deny' },
    { action: 'issue.read', kind: 'read', target: 'issue', enabled: true, egress: 'confirm' },
  ]);
  assert.equal(decideAction({ catalog, action: 'http.egress', target: 'e', egress: 'allow' }).rule, 'egress-denied');
  assert.equal(decideAction({ catalog, action: 'issue.read', target: 'i', egress: 'allow' }).rule, 'egress-confirm');
  assert.equal(decideAction({ catalog, action: 'issue.read', target: 'i' }).action, 'allow');
});

test('a self-reported read-only claim cannot turn a write into a read', () => {
  const catalog = compileCatalog([{ action: 'issue.create_or_update', kind: 'write', target: 'issue', enabled: true }]);
  const plain = decideAction({ catalog, action: 'issue.create_or_update', target: 'I-1' });
  const claimed = decideAction({
    catalog,
    action: 'issue.create_or_update',
    target: 'I-1',
    claims: { readOnly: true, mutating: false, action: 'repository.read' },
  });
  assert.deepEqual(claimed, plain);
  assert.equal(plain.action, 'allow');
  assert.equal(plain.rule, 'registered-action');
});
