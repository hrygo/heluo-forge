import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_MESSAGES,
  safeMessage,
  canonicalRecord,
  refreshBaseId,
  sameGrantIgnoringRefreshMarker,
  grantIdentity,
  nowIso,
  addSeconds,
  tokenErrorMessage,
} from '../src/service-helpers.mjs';
import { IamError } from '../src/errors.mjs';
import { OidcError } from '../src/oidc.mjs';
import { StoreError } from '../src/store.mjs';

test('safeMessage maps known codes to safe messages and defaults unknown', () => {
  assert.equal(safeMessage('IAM_UNCONFIGURED'), 'IAM configuration is incomplete');
  assert.equal(safeMessage('IAM_INVALID_GRANT'), 'IAM authorization is no longer valid');
  assert.equal(safeMessage('UNKNOWN_CODE_XYZ'), 'IAM operation failed');
  assert.ok(Object.isFrozen(SAFE_MESSAGES));
});

test('canonicalRecord sorts object keys recursively and preserves arrays/primitives', () => {
  const unordered = { z: 1, a: { d: 4, b: 2 }, c: [3, { y: 9, x: 8 }] };
  const canonical = canonicalRecord(unordered);
  assert.deepEqual(Object.keys(canonical), ['a', 'c', 'z']);
  assert.deepEqual(Object.keys(canonical.a), ['b', 'd']);
  assert.deepEqual(Object.keys(canonical.c[1]), ['x', 'y']);

  // Primitives and arrays
  assert.equal(canonicalRecord('test'), 'test');
  assert.equal(canonicalRecord(123), 123);
  assert.equal(canonicalRecord(null), null);
  assert.deepEqual(canonicalRecord([3, 1, 2]), [3, 1, 2]); // array order preserved
});

test('refreshBaseId computes consistent HMAC digest for equivalent objects', () => {
  const grantA = { subject: 'user1', issuer: 'https://idp.example', version: 1 };
  const grantB = { version: 1, issuer: 'https://idp.example', subject: 'user1' };
  const id = 'secret-key-1';

  const hashA = refreshBaseId(grantA, id);
  const hashB = refreshBaseId(grantB, id);
  assert.equal(hashA, hashB);
  assert.ok(typeof hashA === 'string' && hashA.length > 0);
});

test('sameGrantIgnoringRefreshMarker compares objects ignoring refreshOperation', () => {
  const grant1 = { id: 1, subject: 'alice', refreshOperation: { state: 'pending', id: 'op1' } };
  const grant2 = { id: 1, subject: 'alice', refreshOperation: { state: 'done', id: 'op2' } };
  const grant3 = { id: 2, subject: 'alice', refreshOperation: { state: 'pending', id: 'op1' } };

  assert.equal(sameGrantIgnoringRefreshMarker(grant1, grant2), true);
  assert.equal(sameGrantIgnoringRefreshMarker(grant1, grant3), false);
});

test('grantIdentity extracts standard session identity fields', () => {
  const grant = {
    version: 1,
    issuer: 'https://idp.example',
    clientId: 'client-1',
    resource: 'https://api.example',
    subject: 'alice',
    obtainedAt: '2026-11-04T00:00:00Z',
    sessionInstanceId: 'sess-123',
    extraField: 'should-not-be-in-identity',
    refreshToken: 'secret',
  };

  const identity = grantIdentity(grant);
  assert.deepEqual(identity, {
    version: 1,
    issuer: 'https://idp.example',
    clientId: 'client-1',
    resource: 'https://api.example',
    subject: 'alice',
    obtainedAt: '2026-11-04T00:00:00Z',
    sessionInstanceId: 'sess-123',
  });
});

test('nowIso and addSeconds format ISO 8601 timestamps', () => {
  const t = 1700000000000;
  assert.equal(nowIso(t), new Date(t).toISOString());
  assert.equal(addSeconds(t, 60), new Date(t + 60000).toISOString());
});

test('tokenErrorMessage redacts and normalizes error types', () => {
  const oidcInvalidGrant = new OidcError('IAM_HTTP_ERROR', 'oauth failure', { oauthError: 'invalid_grant' });
  assert.equal(tokenErrorMessage(oidcInvalidGrant), 'IAM_INVALID_GRANT');

  const oidcOther = new OidcError('IAM_TOKEN_ERROR', 'network failed');
  assert.equal(tokenErrorMessage(oidcOther), 'IAM_TOKEN_ERROR');

  const iamErr = new IamError('IAM_UNREACHABLE', 'unreachable');
  assert.equal(tokenErrorMessage(iamErr), 'IAM_UNREACHABLE');

  const storeErr = new StoreError('IAM_CREDENTIALS_UNAVAILABLE', 'store error');
  assert.equal(tokenErrorMessage(storeErr), 'IAM_CREDENTIALS_UNAVAILABLE');

  const genericErr = new Error('random node error');
  assert.equal(tokenErrorMessage(genericErr), 'IAM_INTERNAL');
});
