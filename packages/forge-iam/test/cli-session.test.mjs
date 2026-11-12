// CLI session projection and offline token policy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { accessTokenOf, classifySessionRecord, isBridgeReadableSession, isSameBridgeSession, sessionFromRecord } from '../src/cli-session.mjs';
import { refreshBaseId } from '../src/service-helpers.mjs';

function grant(overrides = {}) {
  return {
    kind: 'grant',
    payload: {
      version: 1, clientId: 'fixture', obtainedAt: '2026-01-01T00:00:00.000Z',
      issuer: 'https://iam.corp.example',
      subject: 'E1001',
      scope: 'openid profile',
      accessToken: 'placeholder-access-token',
      refreshToken: 'placeholder-refresh-token',
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    },
  };
}

test('the store record projects onto the session shape without tokens', () => {
  const session = sessionFromRecord(grant());
  assert.equal(session.status, 'ready');
  assert.equal(session.signedIn, true);
  assert.deepEqual(session.principal, { issuer: 'https://iam.corp.example', subject: 'E1001' });
  assert.equal(session.scope, 'openid profile');
  assert.doesNotMatch(JSON.stringify(session), /placeholder-access-token|placeholder-refresh-token/u);

  const signedOut = sessionFromRecord(undefined);
  assert.equal(signedOut.status, 'signed-out');
  assert.equal(signedOut.principal, undefined);
});

test('an expired or unknown-expiry token is refused rather than returned', () => {
  const now = Date.now();
  assert.deepEqual(accessTokenOf(grant({ accessExpiresAt: new Date(now - 1000).toISOString() }), now), {
    ok: false,
    code: 'IAM_REAUTH_REQUIRED',
  });
  assert.deepEqual(accessTokenOf(grant({ accessExpiresAt: undefined }), now), { ok: false, code: 'IAM_INVALID_GRANT' });
  assert.deepEqual(accessTokenOf(undefined, now), { ok: false, code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(accessTokenOf(grant(), now).token, 'placeholder-access-token');
});

test('an unresolved refresh never exposes the previous token or a ready session', () => {
  const pending = grant({ refreshOperation: { version: 1, state: 'pending', id: Buffer.alloc(32, 1).toString('base64url'), base: Buffer.alloc(32, 2).toString('base64url') } });
  assert.deepEqual(accessTokenOf(pending), { ok: false, code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(sessionFromRecord(pending).status, 'error');
  assert.equal(sessionFromRecord(pending).signedIn, false);
  assert.equal(sessionFromRecord(pending).principal, undefined);
});

test('invalid grant fields and malformed refresh markers never expose identity or token', () => {
  const valid = grant({ version: 1, clientId: 'fixture', obtainedAt: '2026-01-01T00:00:00.000Z' });
  for (const payload of [
    { ...valid.payload, version: undefined },
    { ...valid.payload, clientId: undefined },
    { ...valid.payload, refreshOperation: { state: 'broken' } },
    { ...valid.payload, refreshOperation: { state: 'complete' } },
  ]) {
    const invalid = { kind: 'grant', payload };
    assert.equal(sessionFromRecord(invalid).status, 'error');
    assert.equal(sessionFromRecord(invalid).signedIn, false);
    assert.equal(accessTokenOf(invalid).ok, false);
  }
});

test('absent and tombstoned records remain signed out while validated sign-out pending stays fenced', () => {
  for (const record of [undefined, null, { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } }]) {
    assert.equal(sessionFromRecord(record).status, 'signed-out');
    assert.deepEqual(accessTokenOf(record), { ok: false, code: 'IAM_NOT_SIGNED_IN' });
  }
  const pending = grant({ signOutOperation: { version: 1, state: 'pending', id: Buffer.alloc(32, 8).toString('base64url') } });
  assert.equal(sessionFromRecord(pending).status, 'error');
  assert.deepEqual(accessTokenOf(pending), { ok: false, code: 'IAM_INVALID_GRANT' });
});


test('bridge readability admits legacy V1 refresh pending but fences sign-out and invalid records', () => {
  const id = Buffer.alloc(32, 1).toString('base64url');
  const original = grant();
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(original.payload, id) };
  assert.equal(isBridgeReadableSession(grant({ refreshOperation: operation })), true);
  assert.equal(isBridgeReadableSession(grant({ signOutOperation: { version: 1, state: 'pending', id } })), false);
  assert.equal(isBridgeReadableSession(grant({ refreshOperation: { ...operation, base: 'bad' } })), false);
  const v2 = grant({ version: 2, authContext: { mode: 'confidential', method: 'client_secret_basic',
    secretRef: 'fixture-secret-ref', secretRevision: 'fixture-revision' }, refreshOperation: operation });
  assert.deepEqual(classifySessionRecord(v2), { state: 'pending', operation: 'refresh' });
  assert.equal(isBridgeReadableSession(v2), false);
});

test('bridge associates a legacy pending refresh only with the same completed rotation', () => {
  const original = grant();
  const id = Buffer.alloc(32, 2).toString('base64url');
  const other = Buffer.alloc(32, 3).toString('base64url');
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(original.payload, id) };
  const pending = grant({ ...original.payload, refreshOperation: operation });
  const complete = grant({ ...original.payload, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', refreshOperation: { ...operation, state: 'complete' } });
  assert.equal(isSameBridgeSession(pending, complete), true);
  for (const changed of [
    grant({ ...complete.payload, refreshOperation: { ...complete.payload.refreshOperation, id: other } }),
    grant({ ...complete.payload, refreshOperation: { ...complete.payload.refreshOperation, base: other } }),
    grant({ ...complete.payload, subject: 'other-subject' }),
    grant({ ...complete.payload, refreshToken: pending.payload.refreshToken }),
  ]) assert.equal(isSameBridgeSession(pending, changed), false);
});

test('bridge associates a legacy active grant with a rotation based on its full original record', () => {
  const previous = { version: 1, state: 'complete', id: Buffer.alloc(32, 4).toString('base64url'), base: Buffer.alloc(32, 5).toString('base64url') };
  const before = grant({ refreshOperation: previous });
  const id = Buffer.alloc(32, 6).toString('base64url');
  const marker = { version: 1, state: 'complete', id, base: refreshBaseId(before.payload, id) };
  const after = grant({ ...before.payload, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', refreshOperation: marker });
  assert.equal(isSameBridgeSession(before, before), true);
  assert.equal(isSameBridgeSession(before, after), true);
  const wrongBase = grant({ ...after.payload, refreshOperation: { ...marker, base: Buffer.alloc(32, 7).toString('base64url') } });
  assert.equal(isSameBridgeSession(before, wrongBase), false);
});

test('bridge rejects a bound pending refresh completed without rotating its refresh token', () => {
  const original = grant({ sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') });
  const id = Buffer.alloc(32, 9).toString('base64url');
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(original.payload, id) };
  const pending = grant({ ...original.payload, refreshOperation: operation });
  const completed = grant({ ...original.payload, accessToken: 'rotated-access', refreshToken: 'rotated-refresh',
    refreshOperation: { ...operation, state: 'complete' } });
  const unchangedRefresh = grant({ ...completed.payload, refreshToken: original.payload.refreshToken });
  assert.equal(isSameBridgeSession(pending, completed), true);
  assert.equal(isSameBridgeSession(pending, unchangedRefresh), false);
});
