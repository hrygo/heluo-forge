import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

// C: the view must answer "can this session still renew itself" before the user
// loses a request to IAM_REAUTH_REQUIRED. A session whose sliding refresh window
// has lapsed is terminal; it is not the same state as a renewable lapse.

async function serviceWith(t, grant) {
  const oidc = await startMockOidc({ accessTtl: 60 });
  const credentials = new MemoryCredentials();
  const clock = { wall: Date.now() };
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  if (grant) {
    await createGrantStore(credentials).write({
      version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
      issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
      refreshToken: 'synthetic-refresh', scope: 'openid',
      obtainedAt: new Date(clock.wall).toISOString(),
      ...grant(clock.wall),
    });
  }
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, { credentials, now: () => clock.wall });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  return { service, oidc, clock };
}

test('a renewable session reports the renewal window it still has', async (t) => {
  const { service } = await serviceWith(t, (clock) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(clock + 60_000).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  }));
  const view = await service.hydrate();
  assert.equal(view.state, 'ready');
  assert.equal(view.renewal, 'available');
  assert.equal(view.refreshExpiresAt, new Date(JSON.parse(JSON.stringify(view)).refreshExpiresAt).toISOString());
});

test('a lapsed refresh window is reported as unrenewable before the access token dies', async (t) => {
  const { service, oidc, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now + 60_000).toISOString(),
    refreshExpiresAt: new Date(now - 1).toISOString(),
  }));
  // The access token still works, so the session is not expired yet — but it
  // cannot survive the next minute, and the view has to say so.
  const ready = await service.hydrate();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.renewal, 'unavailable');
  assert.equal(oidc.counts.refresh, 0, 'nothing can be renewed, so nothing is attempted');

  clock.wall += 20_000;
  assert.equal(await service.getAccessToken(), 'synthetic-access', 'the early renewal window cannot cut short a valid AT');
  assert.equal(service.getView().state, 'ready');
  assert.equal(oidc.counts.refresh, 0);
  clock.wall += 40_000;
  const expired = service.notifyView();
  assert.equal(expired.state, 'expired');
  assert.equal(expired.error, null, 'a lapsed renewal is a state, not a request failure');
  assert.equal(expired.renewal, 'unavailable');
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
});

test('a session without a stored grant reports no renewal at all', async (t) => {
  const { service } = await serviceWith(t, null);
  const view = await service.hydrate();
  assert.equal(view.state, 'signed-out');
  assert.equal(view.renewal, 'none');
  assert.equal(view.refreshExpiresAt, null);
});

test('a renewed session keeps reporting an available renewal window', async (t) => {
  const { service, oidc } = await serviceWith(t, (clock) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(clock - 1).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  }));
  await service.hydrate();
  const token = await service.getAccessToken();
  assert.notEqual(token, 'synthetic-access');
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().renewal, 'available');
});
