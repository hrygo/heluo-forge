import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

test('closing onboarding after PKCE sign-in does not stop idle renewal', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 3 });
  const credentials = new MemoryCredentials();
  const service = createIamService({
    ...oidc.endpoints,
    clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 2,
  }, { credentials });
  t.after(async () => { await service.dispose(); await oidc.close(); });

  const started = await service.startSignIn();
  const authorization = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(authorization.status, 302);
  const signedIn = await service.handleCallback(authorization.headers.get('location'));
  assert.equal(signedIn.state, 'ready');
  const expiry = Date.parse(signedIn.accessExpiresAt);
  assert.ok(Number.isFinite(expiry));

  // Onboarding's completion button posts /cancel even after login succeeds.
  const afterClose = await service.cancelSignIn();
  assert.equal(afterClose.state, 'ready');
  // No view, token, or storage call during the idle period.
  await delay(Math.max(0, expiry - 400 - Date.now()));
  assert.equal(oidc.counts.refresh, 1, 'the idle host must renew before the original access token expires');
});

test('cancellation still interrupts sign-in while discovery is pending', async (t) => {
  const oidc = await startMockOidc();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const service = createIamService({
    discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
    clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, {
    credentials: new MemoryCredentials(),
    fetch: async (...args) => {
      entered.resolve();
      await release.promise;
      return fetch(...args);
    },
  });
  t.after(async () => { release.resolve(); await service.dispose(); await oidc.close(); });

  const starting = service.startSignIn();
  const rejected = assert.rejects(starting, { code: 'IAM_ATTEMPT_CANCELLED' });
  await entered.promise;
  assert.equal((await service.cancelSignIn()).state, 'signed-out');
  release.resolve();
  await rejected;
});

test('closing onboarding cannot resend a refresh with an unknown result', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 3, refreshDelayMs: 500, dropRefreshResponse: true });
  const credentials = new MemoryCredentials();
  const service = createIamService({
    ...oidc.endpoints,
    clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 2,
  }, { credentials });
  t.after(async () => { await service.dispose(); await oidc.close(); });

  const started = await service.startSignIn();
  const authorization = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal((await service.handleCallback(authorization.headers.get('location'))).state, 'ready');
  const deadline = Date.now() + 3000;
  while (oidc.counts.refresh === 0 && Date.now() < deadline) await delay(10);
  assert.equal(oidc.counts.refresh, 1, 'the first refresh POST must have reached the issuer');
  assert.equal(oidc.counts.token, 2, 'one authorization exchange and one refresh POST must have been sent');
  await service.cancelSignIn();
  await delay(2000);
  // `refresh` counts only accepted tokens; `token` counts rejected POSTs too.
  assert.equal(oidc.counts.token, 2, 'an unconfirmed refresh cannot be sent again');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.equal(record?.payload?.refreshOperation?.state, 'pending');
});
