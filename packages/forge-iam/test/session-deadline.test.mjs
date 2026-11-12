import test from 'node:test';
import assert from 'node:assert/strict';
import { accessTokenOf, sessionFromRecord } from '../src/cli-session.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const now = Date.parse('2026-11-12T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'fixture',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const grant = (expiresAt) => ({ kind: 'grant', payload: {
  version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
  refreshToken: 'synthetic-refresh', scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z',
  accessToken: 'synthetic-access', accessExpiresAt: new Date(expiresAt).toISOString(),
  refreshExpiresAt: new Date(now - 1000).toISOString(),
} });

test('CLI and Host project the same expired session using the same clock', async (t) => {
  const record = grant(now - 1000);
  const credentials = new MemoryCredentials();
  await credentials.modifyRecord('heluo-iam/session', () => record);
  const service = createIamService(config, { credentials, now: () => now });
  t.after(() => service.dispose());
  await service.syncFromStore();
  const cli = sessionFromRecord(record, now);
  assert.equal(cli.status, 'expired');
  assert.deepEqual(cli, service.getSession());
  assert.equal(sessionFromRecord(grant(now + 1), now).status, 'ready');
  assert.equal(sessionFromRecord(grant(now), now).status, 'expired');
});

test('offline token snapshots close 30 seconds before access expiry', () => {
  assert.equal(accessTokenOf(grant(now + 30_001), now).ok, true);
  for (const remaining of [30_000, 20_000, 1, 0]) {
    assert.deepEqual(accessTokenOf(grant(now + remaining), now), { ok: false, code: 'IAM_REAUTH_REQUIRED' });
  }
});
