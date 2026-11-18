import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrantStore } from '../src/store.mjs';
import { renewalLeadMillis, renewalDeadline } from '../src/record.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

function grantAt(now, { accessSeconds, refreshSeconds }) {
  return {
    accessExpiresAt: new Date(now + accessSeconds * 1000).toISOString(),
    refreshExpiresAt: new Date(now + refreshSeconds * 1000).toISOString(),
  };
}

test('a two-hour access token renews ten minutes before expiry', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grant = grantAt(now, { accessSeconds: 7200, refreshSeconds: 7300 });
  const deadline = renewalDeadline(grant, now);
  const lead = renewalLeadMillis(grant, deadline, now, 60);
  const renewalAt = deadline - lead;
  assert.equal(lead, 600_000);
  assert.equal(renewalAt - now, 6_600_000);
  assert.equal(Date.parse(grant.refreshExpiresAt) - renewalAt, 700_000);
});

test('an unknown refresh deadline uses a ten-minute lead from access expiry', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grant = { accessExpiresAt: new Date(now + 7200 * 1000).toISOString() };
  const deadline = renewalDeadline(grant, now);
  assert.equal(renewalLeadMillis(grant, deadline, now, 60), 600_000);
});

test('a known refresh expiry before access expiry moves the ten-minute window earlier', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grant = grantAt(now, { accessSeconds: 7200, refreshSeconds: 3600 });
  const deadline = renewalDeadline(grant, now);
  assert.equal(deadline - now, 3_600_000);
  assert.equal(renewalLeadMillis(grant, deadline, now, 60), 600_000);
});

test('a short-lived access token keeps the configured lead', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grant = grantAt(now, { accessSeconds: 90, refreshSeconds: 300 });
  const deadline = renewalDeadline(grant, now);
  assert.equal(renewalLeadMillis(grant, deadline, now, 20), 20_000);
});

test('a refresh deadline earlier than access keeps the one-second zero-skew allowance', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grant = grantAt(now, { accessSeconds: 30, refreshSeconds: 2.4 });
  const deadline = renewalDeadline(grant, now);
  assert.equal(renewalLeadMillis(grant, deadline, now, 0), 1000);
});

test('a five-minute grant limits the background lead to half its lifetime', { timeout: 15_000 }, async (t) => {
  // Keep the mock IdP's ID token (real +300 s) valid across the clock jump.
  const accessSeconds = 300;
  const halfLifeSeconds = accessSeconds / 2;
  const oidc = await startMockOidc({ accessTtl: accessSeconds });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(),
    accessExpiresAt: new Date(clock + accessSeconds * 1000).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, { credentials, now: () => clock });
  t.after(async () => { await service.dispose(); t.mock.timers.reset(); await oidc.close(); });

  assert.equal((await service.hydrate()).state, 'ready');

  // One second short of the capped renewal point.
  clock += halfLifeSeconds * 1000 - 1000;
  t.mock.timers.tick(halfLifeSeconds * 1000 - 1000);
  await delay(50);
  assert.equal(oidc.counts.refresh, 0, 'the renewal must not be due before the halfway point');

  clock += 2_000;
  t.mock.timers.tick(2_000);
  const deadline = Date.now() + 5_000;
  while (oidc.counts.refresh === 0 && Date.now() < deadline) await delay(20);
  assert.equal(oidc.counts.refresh, 1, 'the host renews itself at half of the access lifetime');
  while (service.getView().state !== 'ready' && Date.now() < deadline) await delay(20);
  assert.equal(service.getView().state, 'ready');
  assert.ok(Date.parse(service.getView().accessExpiresAt) > clock);
});
