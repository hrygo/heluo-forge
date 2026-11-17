import assert from 'node:assert/strict';
import test from 'node:test';

import { compileCatalog, composeDecision, decideAction, PolicyCatalogError } from '../src/catalog.mjs';

const READ = { action: 'gitee.repository.read', target: 'repository', enabled: true };
const WRITE = { action: 'gitee.issue.write', target: 'issue', enabled: true };
const PUSH = { action: 'gitee.git.push', target: 'repository', enabled: true };
const HUMAN = { action: 'gitee.review.record', target: 'pull-request', enabled: true };

test('compiling a valid catalog attaches classification and default decision', () => {
  const catalog = compileCatalog([READ, { ...WRITE, enabled: false }, HUMAN]);
  const read = catalog.get('gitee.repository.read');
  assert.equal(read.category, 'read');
  assert.equal(read.decision, 'allow');
  assert.equal(read.contentGate, false);
  assert.equal(read.confirmation, 'none');
  assert.ok(Object.isFrozen(read));

  const write = catalog.get('gitee.issue.write');
  assert.equal(write.enabled, false);
  assert.equal(write.category, 'dev-write');
  assert.equal(write.contentGate, true);
  assert.equal(write.confirmation, 'scope');

  assert.equal(catalog.get('gitee.review.record').decision, 'deny');
  assert.equal(compileCatalog([PUSH]).get('gitee.git.push').confirmation, 'each');
});

test('the target shape is fixed by the action classification, not by the entry', () => {
  assert.throws(
    () => compileCatalog([{ action: 'gitee.repository.read', target: 'issue', enabled: true }]),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_CATALOG_TARGET_MISMATCH',
  );
  assert.throws(
    () => compileCatalog([{ action: 'gitee.issue.write', enabled: true }]),
    (error) => error.code === 'POLICY_CATALOG_TARGET_MISMATCH',
    'a missing target is a mismatch, not a default',
  );
});

test('an invalid catalog throws instead of silently shrinking', () => {
  const cases = [
    [[{ action: 'not.registered', target: 'repository', enabled: true }], 'POLICY_CATALOG_UNKNOWN_ACTION'],
    [[{ action: 'gitee.repository.read', target: 'repository', enabled: true, kind: 'read' }], 'POLICY_CATALOG_UNKNOWN_FIELD'],
    [[{ action: 'gitee.repository.read', target: 'repository', enabled: true, egress: 'allow' }], 'POLICY_CATALOG_UNKNOWN_FIELD'],
    [[{ action: 'gitee.repository.read', target: 'repository', enabled: 'true' }], 'POLICY_CATALOG_INVALID'],
    [[{ action: 'gitee.repository.read', target: 'repository', enabled: true, revision: 'r' }], 'POLICY_CATALOG_INVALID'],
    [[{ action: 'gitee.repository.read', target: 'repository' }], 'POLICY_CATALOG_INVALID'],
    [[READ, { ...READ }], 'POLICY_CATALOG_DUPLICATE'],
    [['nope'], 'POLICY_CATALOG_INVALID'],
  ];
  for (const [entries, code] of cases) {
    assert.throws(() => compileCatalog(entries), (error) => error instanceof PolicyCatalogError && error.code === code, code);
  }
  assert.throws(() => compileCatalog('nope'), (error) => error.code === 'POLICY_CATALOG_INVALID');
});

test('an uncompiled catalog denies every action', () => {
  const decision = decideAction({ catalog: undefined, action: 'gitee.repository.read', target: 'r' });
  assert.deepEqual(decision, { action: 'deny', reason: 'policy catalog is not compiled', rule: 'policy-unavailable' });
});

test('unregistered, disabled, human and target-less actions are denied', () => {
  const catalog = compileCatalog([READ, { ...WRITE, enabled: false }, HUMAN]);
  assert.equal(decideAction({ catalog, action: 'change.read', target: 'C-1' }).rule, 'unregistered-action');
  assert.equal(decideAction({ catalog, action: 'gitee.issue.write', target: 'acme/demo!1' }).rule, 'action-disabled');
  assert.equal(decideAction({ catalog, action: 'gitee.repository.read' }).rule, 'target-required');
  assert.equal(decideAction({ catalog, action: 'gitee.repository.read', target: '   ' }).rule, 'target-required');
  assert.equal(decideAction({ catalog, action: 'gitee.review.record', target: 'acme/demo!2' }).rule, 'human-record-action');
});

test('a registered read is allowed, a registered push asks for confirmation', () => {
  const catalog = compileCatalog([READ, PUSH]);
  assert.equal(decideAction({ catalog, action: 'gitee.repository.read', target: 'acme/demo' }).action, 'allow');
  const confirm = decideAction({ catalog, action: 'gitee.git.push', target: 'acme/demo' });
  assert.equal(confirm.action, 'confirm');
  assert.equal(confirm.rule, 'confirm-required');
});

test('a self-reported read-only claim cannot turn a write into something else', () => {
  const catalog = compileCatalog([WRITE]);
  const plain = decideAction({ catalog, action: 'gitee.issue.write', target: 'acme/demo!1' });
  const claimed = decideAction({
    catalog,
    action: 'gitee.issue.write',
    target: 'acme/demo!1',
    claims: { readOnly: true, mutating: false, action: 'gitee.repository.read' },
  });
  assert.deepEqual(claimed, plain);
  assert.equal(plain.action, 'allow');
  assert.equal(plain.rule, 'registered-action');
});

test('decision composition takes the strictest of its inputs', () => {
  assert.equal(composeDecision('allow', 'confirm'), 'confirm');
  assert.equal(composeDecision('allow', 'deny', 'confirm'), 'deny');
  assert.equal(composeDecision('allow', 'allow'), 'allow');
});
