import assert from 'node:assert/strict';
import test from 'node:test';

import { createConfirmationLedger, PolicyConfirmationError } from '../src/confirmations.mjs';

const request = { action: 'change.clarification.write', target: 'C-2026-1', content: { body: 'hello' }, revision: 'rev-1' };

function ledgerAt(start = 1_000) {
  let now = start;
  const ledger = createConfirmationLedger({ now: () => now });
  return { ledger, advance: (ms) => { now += ms; } };
}

test('a host-attested confirmation is consumable exactly once', () => {
  const { ledger } = ledgerAt();
  ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  const first = ledger.consume(request);
  assert.equal(first.action, 'allow');
  assert.equal(first.rule, 'confirmation-consumed');
  const second = ledger.consume(request);
  assert.equal(second.action, 'deny');
  assert.equal(second.rule, 'confirmation-consumed');
});

test('a model-produced confirmation cannot even be registered', () => {
  const { ledger } = ledgerAt();
  assert.throws(
    () => ledger.issue({ ...request, kind: 'model', ttlMs: 60_000 }),
    (error) => error instanceof PolicyConfirmationError && error.code === 'POLICY_CONFIRMATION_UNTRUSTED_KIND',
  );
  assert.throws(() => ledger.issue({ ...request, kind: 'human', ttlMs: 0 }), (error) => error.code === 'POLICY_CONFIRMATION_INVALID');
  assert.deepEqual(ledger.pending(), []);
});

test('expiry, revision drift, scope change and revocation all deny', () => {
  const expired = ledgerAt();
  expired.ledger.issue({ ...request, kind: 'human', ttlMs: 1_000 });
  expired.advance(1_000);
  assert.equal(expired.ledger.consume(request).rule, 'confirmation-expired');

  const drifted = ledgerAt();
  drifted.ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  assert.equal(drifted.ledger.consume({ ...request, revision: 'rev-2' }).rule, 'confirmation-revision-drift');
  assert.equal(drifted.ledger.consume({ ...request, content: { body: 'hello!' } }).rule, 'confirmation-unknown');
  assert.equal(drifted.ledger.consume({ ...request, target: 'C-2026-2' }).rule, 'confirmation-unknown');

  const revoked = ledgerAt();
  const record = revoked.ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  assert.equal(revoked.ledger.revoke({ key: record.key, reason: 'user cancelled' }), true);
  assert.equal(revoked.ledger.consume(request).rule, 'confirmation-revoked');
  assert.equal(revoked.ledger.revoke({ key: 'missing' }), false);
});

test('a restarted or forked session cannot reuse an old confirmation', () => {
  const first = ledgerAt();
  const record = first.ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  const afterRestart = ledgerAt(2_000).ledger;
  const decision = afterRestart.consume({ ...request, key: record.key });
  assert.equal(decision.action, 'deny');
  assert.equal(decision.rule, 'confirmation-unknown', 'in-memory state is intentionally not restorable');
});

test('an explicit old key cannot substitute for current action, target or content', () => {
  for (const changed of [
    { action: 'issue.close' },
    { target: 'C-2026-2' },
    { content: { body: 'changed' } },
  ]) {
    const { ledger } = ledgerAt();
    const record = ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
    assert.equal(ledger.consume({ ...request, ...changed, key: record.key }).action, 'deny');
    assert.equal(ledger.pending()[0].state, 'pending', 'a rejected attempt must not burn the valid ticket');
    assert.equal(ledger.consume({ ...request, key: record.key }).action, 'allow');
    assert.equal(ledger.consume({ ...request, key: record.key }).rule, 'confirmation-consumed');
  }
});

test('missing scope or a bound revision denies without consuming the ticket', () => {
  for (const missing of ['action', 'target', 'content', 'revision']) {
    const { ledger } = ledgerAt();
    const record = ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
    const candidate = { ...request, key: record.key };
    delete candidate[missing];
    assert.equal(ledger.consume(candidate).action, 'deny', missing);
    assert.equal(ledger.pending()[0].state, 'pending');
    assert.equal(ledger.consume(request).action, 'allow');
  }
});

test('revision drift with an explicit key does not consume a valid confirmation', () => {
  const { ledger } = ledgerAt();
  const record = ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  assert.equal(ledger.consume({ ...request, key: record.key, revision: 'rev-2' }).rule, 'confirmation-revision-drift');
  assert.equal(ledger.consume(request).action, 'allow');
});

test('a delimiter collision in a key cannot change the bound action and target', () => {
  const { ledger } = ledgerAt();
  const original = { ...request, action: 'a\u0000b', target: 'c' };
  const record = ledger.issue({ ...original, kind: 'human', ttlMs: 60_000 });
  const changed = { ...original, action: 'a', target: 'b\u0000c', key: record.key };
  assert.equal(ledger.consume(changed).action, 'deny');
  assert.equal(ledger.consume(original).action, 'allow');
});

test('invalid scope, exceptional content and clock failures fail closed without burning tickets', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const throws = new Proxy({}, { get() { throw new Error('untrusted getter'); } });
  const exceptionalContent = new Proxy({}, { ownKeys() { throw new Error('cannot enumerate'); } });
  for (const candidate of [undefined, null, {}, throws, { ...request, content: cyclic }, { ...request, content: 1n }, { ...request, content: exceptionalContent }]) {
    const { ledger } = ledgerAt();
    ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
    assert.equal(ledger.consume(candidate).action, 'deny');
    assert.equal(ledger.consume(request).action, 'allow');
  }
  for (const broken of [() => NaN, () => Infinity, () => { throw new Error('clock unavailable'); }]) {
    let clock = () => 1_000;
    const ledger = createConfirmationLedger({ now: () => clock() });
    ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
    clock = broken;
    assert.equal(ledger.consume(request).action, 'deny');
    clock = () => 2_000;
    assert.equal(ledger.consume(request).action, 'allow');
  }
});

test('explicit keys do not revive expired or cancelled tickets', () => {
  const expired = ledgerAt();
  const record = expired.ledger.issue({ ...request, kind: 'human', ttlMs: 1 });
  expired.advance(1);
  assert.equal(expired.ledger.consume({ ...request, key: record.key }).rule, 'confirmation-expired');
  const { ledger } = ledgerAt();
  const cancelled = ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  ledger.revoke({ key: cancelled.key });
  assert.equal(ledger.consume({ ...request, key: cancelled.key }).rule, 'confirmation-revoked');
});

test('optional content and unbound revision remain supported', () => {
  const { ledger } = ledgerAt();
  const unversioned = { action: request.action, target: request.target };
  const record = ledger.issue({ ...unversioned, kind: 'human', ttlMs: 60_000 });
  assert.equal(ledger.consume({ ...unversioned, key: record.key }).action, 'allow');
});

test('invalid revision bindings and non-finite issue times cannot create tickets', () => {
  for (const revision of [null, '', 1, {}]) {
    const { ledger } = ledgerAt();
    assert.throws(() => ledger.issue({ ...request, revision, kind: 'human', ttlMs: 60_000 }), (error) => error.code === 'POLICY_CONFIRMATION_INVALID');
    assert.deepEqual(ledger.pending(), []);
  }
  for (const now of [NaN, Infinity, Number.MAX_VALUE]) {
    const ledger = createConfirmationLedger({ now: () => now });
    assert.throws(() => ledger.issue({ ...request, kind: 'human', ttlMs: Number.MAX_VALUE }), (error) => error.code === 'POLICY_CONFIRMATION_INVALID');
    assert.deepEqual(ledger.pending(), []);
  }
});

test('the consumed record keeps its scope for audit without values', () => {
  const { ledger } = ledgerAt();
  ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  const decision = ledger.consume(request);
  assert.deepEqual(decision.scope.fields, ['body']);
  assert.equal(JSON.stringify(decision).includes('hello'), false);
  const [record] = ledger.pending();
  assert.equal(record.state, 'consumed');
});
