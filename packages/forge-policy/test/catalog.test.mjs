import assert from 'node:assert/strict';
import test from 'node:test';

import { compileCatalog, composeDecision, decideAction, PolicyCatalogError } from '../src/catalog.mjs';

const ISSUE = { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' };
const PUSH = { action: 'gitee.git.push', target: 'repository', category: 'remote-write' };
const HUMAN = { action: 'gitee.review.record', target: 'pull-request', category: 'human-record' };

test('compiling valid writes attaches classification and default decision', () => {
  const catalog = compileCatalog([ISSUE, PUSH, HUMAN]);
  const issue = catalog.get('gitee.issue.write');
  assert.equal(issue.category, 'dev-write');
  assert.equal(issue.decision, 'allow');
  assert.ok(Object.isFrozen(issue));
  assert.deepEqual(Object.keys(issue).sort(), ['action', 'category', 'decision', 'target']);

  const push = catalog.get('gitee.git.push');
  assert.equal(push.category, 'remote-write');
  assert.equal(push.decision, 'confirm');

  assert.equal(catalog.get('gitee.review.record').decision, 'deny');
});

test('the target and category are fixed by the action classification, not by the entry', () => {
  const cases = [
    { action: 'gitee.issue.write', target: 'repository', category: 'dev-write' },
    { action: 'gitee.issue.write', target: 'issue', category: 'remote-write' },
    { action: 'gitee.issue.write', category: 'dev-write' },
    { action: 'gitee.issue.write', target: 'issue' },
  ];
  for (const entry of cases) {
    assert.throws(
      () => compileCatalog([entry]),
      (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_CATALOG_INVALID',
      JSON.stringify(entry),
    );
  }
});

test('an invalid catalog throws once with every issue located by key path', () => {
  const cases = [
    [[{ action: 'not.registered', target: 'repository', category: 'dev-write' }], /not a classified action/],
    [[{ ...ISSUE, enabled: true }], /catalog\[0\]\.enabled: unknown field/],
    [[{ ...ISSUE, revision: 'r' }], /catalog\[0\]\.revision: unknown field/],
    [[{ ...ISSUE, egress: 'allow' }], /catalog\[0\]\.egress: unknown field/],
    [[{ action: 'gitee.repository.read', target: 'repository', category: 'read' }], /read action "gitee.repository.read" is out of scope/],
    [[ISSUE, { ...ISSUE }], /duplicate action/],
    [['nope'], /must be an object/],
  ];
  for (const [entries, pattern] of cases) {
    assert.throws(
      () => compileCatalog(entries),
      (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_CATALOG_INVALID' && pattern.test(error.message),
      JSON.stringify(entries),
    );
  }
  assert.throws(() => compileCatalog('nope'), (error) => error.code === 'POLICY_CATALOG_INVALID');
});

test('an uncompiled catalog denies every action', () => {
  const decision = decideAction({ catalog: undefined, action: 'gitee.issue.write', target: 'r' });
  assert.equal(decision.action, 'deny');
  assert.equal(decision.rule, 'policy-unavailable');
});

test('the default rules let unregistered actions, human records and pushes pass', () => {
  const catalog = compileCatalog([ISSUE, PUSH, HUMAN]);
  const rules = {};
  assert.equal(decideAction({ catalog, rules, action: 'change.read', target: 'C-1' }).action, 'allow');
  assert.equal(decideAction({ catalog, rules, action: 'change.read', target: 'C-1' }).rule, 'out-of-scope');
  assert.equal(decideAction({ catalog, rules, action: 'gitee.issue.write', target: 'acme/demo!1' }).rule, 'registered-write');
  assert.equal(decideAction({ catalog, rules, action: 'gitee.git.push', target: 'acme/demo' }).action, 'allow');
  assert.equal(decideAction({ catalog, rules, action: 'gitee.review.record', target: 'acme/demo!2' }).action, 'allow');
});

test('an enabled rule tightens exactly its own actions', () => {
  const catalog = compileCatalog([ISSUE, PUSH, HUMAN]);
  const rules = { denyUnknownAction: true, denyHumanRecord: true, confirmPush: true, confirmDopWrite: true };
  assert.equal(decideAction({ catalog, rules, action: 'change.read', target: 'C-1' }).rule, 'unregistered-action');
  assert.equal(decideAction({ catalog, rules, action: 'gitee.review.record', target: 'acme/demo!2' }).rule, 'human-record-action');
  const push = decideAction({ catalog, rules, action: 'gitee.git.push', target: 'acme/demo' });
  assert.equal(push.action, 'confirm');
  assert.equal(push.rule, 'confirm-required');
  assert.equal(decideAction({ catalog, rules, action: 'gitee.issue.write', target: 'acme/demo!1' }).action, 'allow');
});

test('a controlled action needs a business target whatever the rules say', () => {
  const catalog = compileCatalog([ISSUE]);
  assert.equal(decideAction({ catalog, action: 'gitee.issue.write' }).rule, 'target-required');
  assert.equal(decideAction({ catalog, action: 'gitee.issue.write', target: '   ' }).rule, 'target-required');
});

test('self-reported read-only claims cannot change a write decision', () => {
  const catalog = compileCatalog([ISSUE]);
  const plain = decideAction({ catalog, action: 'gitee.issue.write', target: 'acme/demo!1' });
  const claimed = decideAction({
    catalog,
    action: 'gitee.issue.write',
    target: 'acme/demo!1',
    claims: { readOnly: true, mutating: false, action: 'gitee.repository.read' },
  });
  assert.deepEqual(claimed, plain);
  assert.equal(plain.action, 'allow');
});

test('decision composition takes the strictest of its inputs', () => {
  assert.equal(composeDecision('allow', 'confirm'), 'confirm');
  assert.equal(composeDecision('allow', 'deny', 'confirm'), 'deny');
  assert.equal(composeDecision('allow', 'allow'), 'allow');
});
