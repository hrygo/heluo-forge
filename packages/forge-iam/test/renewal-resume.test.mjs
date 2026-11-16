import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

// B: a suspended host wakes up with a deadline that already passed. The monotonic
// clock does not advance while suspended, so the difference between the two clocks
// identifies a resume without any OS-level event, and the first scheduling pass
// after it must renew at once instead of waiting for the retry backoff.

async function seed({ accessSeconds = 60, refreshSeconds = 3600 } = {}) {
  const oidc = await startMockOidc({ accessTtl: 60 });
  const credentials = new MemoryCredentials();
  const clock = { wall: Date.now(), monotonic: 0 };
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock.wall).toISOString(),
    accessExpiresAt: new Date(clock.wall + accessSeconds * 1000).toISOString(),
    refreshExpiresAt: new Date(clock.wall + refreshSeconds * 1000).toISOString(),
  });
  return { oidc, credentials, clock };
}

test('resuming after a sleep renews at once instead of waiting for the retry backoff', { timeout: 20_000 }, async (t) => {
  const { oidc, credentials, clock } = await seed();
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, {
    credentials,
    now: () => clock.wall,
    monotonic: () => clock.monotonic,
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });

  assert.equal((await service.hydrate()).state, 'ready');
  assert.equal(oidc.counts.refresh, 0);

  // A suspend long enough to outlive the access token (and to trip the resume
  // threshold) while the mock IdP's five-minute ID token stays valid.
  clock.wall += 120_000;
  assert.equal(service.notifyView().state, 'expired');

  const deadline = Date.now() + 1_500;
  while (oidc.counts.refresh === 0 && Date.now() < deadline) await delay(10);
  assert.equal(oidc.counts.refresh, 1, 'a resumed host renews without waiting for the 30 s backoff');
  while (service.getView().state !== 'ready' && Date.now() < deadline) await delay(10);
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().renewal, 'available');
});

test('a wall clock that merely drifts does not force a renewal', { timeout: 20_000 }, async (t) => {
  const { oidc, credentials, clock } = await seed();
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, {
    credentials,
    now: () => clock.wall,
    monotonic: () => clock.monotonic,
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });

  assert.equal((await service.hydrate()).state, 'ready');
  // The process stayed awake: both clocks moved the same amount.
  clock.wall += 20_000;
  clock.monotonic += 20_000;
  assert.equal(service.getView().state, 'ready');
  await delay(150);
  assert.equal(oidc.counts.refresh, 0, 'a running host must keep its scheduled renewal');
});