import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoCanary,
  confirmationScope,
  decideEgress,
  digestContent,
  PolicyEgressError,
  renderEgressScope,
} from '../src/egress.mjs';

const SECRET = 'canary-token-9f3a';
const request = { action: 'change.clarification.write', target: 'C-2026-1', content: { body: 'hello', token: SECRET } };

test('a confirmation scope binds action, target and content digest', () => {
  const scope = confirmationScope(request);
  assert.equal(scope.action, request.action);
  assert.equal(scope.target, request.target);
  assert.deepEqual(scope.fields, ['body', 'token']);
  assert.equal(scope.contentDigest, digestContent(request.content));
  assert.equal(scope.key, `${scope.action}\u0000${scope.target}\u0000${scope.contentDigest}`);
  assert.equal(JSON.stringify(scope).includes(SECRET), false, 'the scope carries no values');
  assert.equal(digestContent({ a: 1, b: [2, 3] }), digestContent({ b: [2, 3], a: 1 }), 'digest is key-order independent');
  assert.notEqual(digestContent({ body: 'hello' }), digestContent({ body: 'hello!' }));
});

test('the rendered scope shows names and digest only', () => {
  const rendered = renderEgressScope(confirmationScope(request));
  assert.match(rendered, /action=change\.clarification\.write/);
  assert.match(rendered, /target=C-2026-1/);
  assert.match(rendered, /fields=\[body, token\]/);
  assert.equal(rendered.includes(SECRET), false);
  assert.doesNotThrow(() => assertNoCanary(rendered, [SECRET]));
});

test('a canary value in rendered text is refused', () => {
  assert.throws(
    () => assertNoCanary(`failed to send ${SECRET}`, [SECRET]),
    (error) => error instanceof PolicyEgressError && error.code === 'POLICY_EGRESS_CANARY_LEAK',
  );
  assert.doesNotThrow(() => assertNoCanary('short tokens are ignored', ['abc']));
});

test('egress needs an explicit host and an allowlisted one', () => {
  const scope = confirmationScope(request);
  assert.equal(decideEgress({ host: '', scope }).rule, 'egress-host-required');
  assert.equal(decideEgress({ host: 'evil.example', scope, allowlist: ['corp.example'] }).rule, 'egress-host-not-allowed');
  assert.equal(
    decideEgress({ host: 'evil.example', scope, allowlist: ['corp.example'], confirmation: { outcome: 'allowed-once', key: scope.key } }).rule,
    'egress-host-not-allowed',
    'an allowlist miss is decided before any confirmation is trusted',
  );
});

test('a missing, unconfirmed, stale or expired confirmation denies', () => {
  const scope = confirmationScope(request);
  const host = 'corp.example';
  assert.equal(decideEgress({ host, scope }).rule, 'egress-confirmation-required');
  for (const outcome of ['rejected', 'cancelled', 'timeout', 'unavailable', 'never']) {
    const decision = decideEgress({ host, scope, confirmation: { outcome, key: scope.key } });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.rule, `egress-confirmation-${outcome}`);
  }
  const stale = decideEgress({ host, scope, confirmation: { outcome: 'allowed-once', key: confirmationScope({ ...request, target: 'C-2026-2' }).key } });
  assert.equal(stale.rule, 'egress-confirmation-stale', 'a changed target cannot reuse the confirmation');
  const changedContent = decideEgress({
    host,
    scope,
    confirmation: { outcome: 'allowed-once', key: confirmationScope({ ...request, content: { body: 'hello!', token: SECRET } }).key },
  });
  assert.equal(changedContent.rule, 'egress-confirmation-stale', 'changed content cannot reuse the confirmation');
  const expired = decideEgress({ host, scope, confirmation: { outcome: 'allowed-once', key: scope.key, expiresAt: 1000 }, now: 2000 });
  assert.equal(expired.rule, 'egress-confirmation-expired');
});

test('a bound, unexpired confirmation allows exactly that egress', () => {
  const scope = confirmationScope(request);
  const decision = decideEgress({
    host: 'corp.example',
    scope,
    allowlist: ['corp.example'],
    confirmation: { outcome: 'allowed-once', key: scope.key, expiresAt: 5000 },
    now: 1000,
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.rule, 'egress-confirmed');
  assert.equal(JSON.stringify(decision).includes(SECRET), false, 'the decision carries no values');
});

test('an incomplete scope is refused', () => {
  assert.throws(() => confirmationScope({ action: '', target: 't' }), (error) => error.code === 'POLICY_EGRESS_SCOPE_INVALID');
  assert.throws(() => confirmationScope({ action: 'a.b', target: '' }), (error) => error.code === 'POLICY_EGRESS_SCOPE_INVALID');
});
