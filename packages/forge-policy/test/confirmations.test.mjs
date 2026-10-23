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

test('the consumed record keeps its scope for audit without values', () => {
  const { ledger } = ledgerAt();
  ledger.issue({ ...request, kind: 'human', ttlMs: 60_000 });
  const decision = ledger.consume(request);
  assert.deepEqual(decision.scope.fields, ['body']);
  assert.equal(JSON.stringify(decision).includes('hello'), false);
  const [record] = ledger.pending();
  assert.equal(record.state, 'consumed');
});
