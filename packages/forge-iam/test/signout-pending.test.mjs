import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from './support/trusted-service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = {
  issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize',
  tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks',
  revocationEndpoint: 'https://iam.example/revoke', clientId: 'test',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
  refreshSkewSeconds: 7200,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const failure of ['throws', 'skips-mutator']) {
  test(`sign-out will not delete after the locked read ${failure}`, async (t) => {
    const credentials = new MemoryCredentials();
    await createGrantStore(credentials).write({
      version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
      refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
      obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    let deletions = 0;
    let revocations = 0;
    credentials.modifyRecord = async () => {
      if (failure === 'throws') throw new Error('synthetic provider failure');
      return undefined;
    };
    credentials.deleteRecord = async () => { deletions++; };
    const service = createIamService(config, { credentials, fetch: async () => {
      revocations++;
      return new Response(null, { status: 204 });
    } });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal(result.revocation, 'unknown');
    assert.equal(deletions, 0);
    assert.equal(revocations, 0);
  });
}

test('sign-out observing an in-flight refresh preserves pending and reports unknown', async (t) => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const entered = deferred();
  const release = deferred();
  let revocations = 0;
  const fetch = async (url) => {
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    if (String(url).endsWith('/token')) {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).endsWith('/revoke')) { revocations++; return new Response(null, { status: 204 }); }
    throw new Error('unexpected mock request');
  };
  const refreshing = createIamService(config, { credentials, fetch });
  const signingOut = createIamService(config, { credentials, fetch });
  t.after(() => { release.resolve(); refreshing.dispose(); signingOut.dispose(); });
  const refresh = refreshing.resolveToken();
  await Promise.race([
    entered.promise,
    refresh.then(() => { throw new Error('refresh completed before reaching the mock endpoint'); }),
  ]);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  const result = await signingOut.signOut();
  assert.equal(result.view.state, 'error');
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.equal(result.revocation, 'unknown');
  assert.equal(revocations, 0);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  release.resolve();
  assert.equal(await refresh, 'synthetic-new-access');
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'complete');
});

async function startLocalRefresh(t, tokenResponse) {
  const credentials = new MemoryCredentials();
  const grant = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await createGrantStore(credentials).write(grant);
  const entered = deferred();
  const release = deferred();
  const requests = [];
  const renewalEvents = [];
  const fetch = async (url, init) => {
    const target = new URL(url);
    if (target.pathname === '/jwks') return Response.json({ keys: [] });
    if (target.pathname === '/token') {
      requests.push({ method: init.method, path: target.pathname });
      entered.resolve();
      await release.promise;
      return tokenResponse();
    }
    if (target.pathname === '/revoke') {
      requests.push({ method: init.method, path: target.pathname, accessToken: target.searchParams.get('access_token') });
      return Response.json({ result: true });
    }
    throw new Error('unexpected mock request');
  };
  const service = createIamService(config, { credentials, fetch,
    logRenewal: (event, fields) => renewalEvents.push({ event, ...fields }),
  });
  t.after(() => { release.resolve(); return service.dispose(); });
  const refresh = service.getAccessToken();
  await Promise.race([
    entered.promise,
    refresh.then(() => { throw new Error('refresh completed before reaching the mock endpoint'); }),
  ]);
  const pending = await credentials.readRecord(GRANT_KEY);
  assert.equal(pending.payload.refreshOperation.state, 'pending');
  return { credentials, grant, pending, release, requests, service, refresh, renewalEvents };
}

test('same-Host sign-out revokes the confirmed refresh without publishing its token', { timeout: 5000 }, async (t) => {
  const { credentials, grant, release, requests, service, refresh, renewalEvents } = await startLocalRefresh(t, () =>
    Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 1800 }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const views = service.watch(controller.signal);
  await views.next();
  const signingOut = service.signOut();
  const blockedGetter = assert.rejects(refresh, { code: 'IAM_DISPOSED' });
  release.resolve();
  const [result] = await Promise.all([signingOut, blockedGetter]);

  assert.deepEqual(requests, [
    { method: 'POST', path: '/token' },
    { method: 'GET', path: '/revoke', accessToken: 'synthetic-new-access' },
  ]);
  assert.equal(result.revocation, 'ok');
  assert.equal(result.view.state, 'signed-out');
  assert.equal(service.getView().state, 'signed-out');
  const observed = [];
  for await (const view of views) {
    observed.push(view);
    if (view.state === 'signed-out') break;
  }
  assert.equal(observed.at(-1)?.state, 'signed-out');
  assert.ok(observed.every((view) => view.accessExpiresAt == null || view.accessExpiresAt === grant.accessExpiresAt));
  await assert.rejects(service.getAccessToken(), { code: 'IAM_NOT_SIGNED_IN' });
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), {
    kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' },
  });
  assert.equal(requests.length, 2);
  const handoffs = renewalEvents.filter(({ event }) => event === 'refresh-handed-off');
  assert.equal(handoffs.length, 1);
  assert.equal(renewalEvents.some(({ event, renewalId }) => event === 'refresh-failed' && renewalId === handoffs[0].renewalId), false);
  assert.doesNotMatch(JSON.stringify(renewalEvents), /synthetic-new-(?:access|refresh)/);
});

test('same-Host sign-out cannot consume the result or revoke a replacement login during refresh', { timeout: 5000 }, async (t) => {
  const { credentials, grant, release, requests, service, refresh } = await startLocalRefresh(t, () =>
    Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 1800 }));
  const signingOut = service.signOut();
  const blockedGetter = assert.rejects(refresh);
  const replacement = { ...grant, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') };
  const store = createGrantStore(credentials);
  await store.write(replacement);
  release.resolve();
  const [result] = await Promise.all([signingOut, blockedGetter]);
  assert.equal(result.revocation, 'unknown');
  assert.deepEqual(requests, [{ method: 'POST', path: '/token' }]);
  assert.deepEqual((await store.read()).grant, replacement);
});

test('same-Host sign-out stops waiting for an in-flight refresh and ignores a later response', { timeout: 5000 }, async (t) => {
  const { credentials, pending, release, requests, service, refresh } = await startLocalRefresh(t, () =>
    Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 1800 }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signingOut = service.signOut();
  const blockedGetter = assert.rejects(refresh);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  const result = await signingOut;
  assert.equal(result.revocation, 'unknown');
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');

  release.resolve();
  await blockedGetter;
  assert.deepEqual(requests, [{ method: 'POST', path: '/token' }]);
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), pending);
});

for (const [failure, tokenResponse] of [
  ['lost response', () => { throw new Error('synthetic transport failure'); }],
  ['invalid response', () => Response.json({ refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 1800 })],
]) {
  test(`same-Host sign-out preserves pending after a refresh with ${failure}`, { timeout: 5000 }, async (t) => {
    const { credentials, pending, release, requests, service, refresh } = await startLocalRefresh(t, tokenResponse);
    const signingOut = service.signOut();
    const blockedGetter = assert.rejects(refresh);
    release.resolve();
    const [result] = await Promise.all([signingOut, blockedGetter]);

    assert.equal(result.revocation, 'unknown');
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal((await service.signOut()).revocation, 'unknown');
    assert.deepEqual(requests, [{ method: 'POST', path: '/token' }]);
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), pending);
  });
}
