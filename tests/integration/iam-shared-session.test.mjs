import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Root integration tests use each package's declared public entry, without an
// installed dependency or a hard-coded import of implementation modules.
const iamManifestUrl = new URL('../../packages/forge-iam/package.json', import.meta.url);
const iamManifest = JSON.parse(await readFile(iamManifestUrl, 'utf8'));
const { createIamService } = await import(new URL(iamManifest.exports['.'], iamManifestUrl));
const keychainManifestUrl = new URL('../../packages/forge-credentials-keychain/package.json', import.meta.url);
const keychainManifest = JSON.parse(await readFile(keychainManifestUrl, 'utf8'));
const { createKeychainProvider, createMemoryBackend } = await import(new URL(keychainManifest.exports['.'], keychainManifestUrl));
const GRANT_KEY = 'heluo-iam/session';
const GATEWAY_REF = 'ENTERPRISE_STATIC_KEY';
// These verifiers declare trust only for the controlled in-memory fixtures;
// they do not establish cross-process or production storage atomicity.

const configured = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  revocationEndpoint: 'https://iam.corp.example/revoke',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForGate(entered, action, label) {
  let timer;
  try {
    await Promise.race([
      entered,
      action.then(() => { throw new Error(`${label} completed before entering the gate`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedGrant(credentials) {
  await credentials.modifyRecord(GRANT_KEY, async () => ({
    kind: 'grant',
    payload: {
      version: 1,
      issuer: configured.issuer,
      subject: 'E1001',
      clientId: configured.clientId,
      resource: configured.gatewayResource,
      scope: 'openid profile offline_access',
      obtainedAt: new Date().toISOString(),
      refreshToken: 'synthetic-old-refresh',
      accessToken: 'synthetic-old-access',
      accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  }));
}

function pauseNextRead(credentials) {
  const entered = deferred();
  const release = deferred();
  const read = credentials.readRecord.bind(credentials);
  let paused = false;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (!paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return record;
  };
  return { entered: entered.promise, release: release.resolve };
}

function tokenFetch({ tokenGate, revoked = new Set() } = {}) {
  return async (url, init) => {
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    if (String(url).endsWith('/token')) {
      tokenGate?.entered.resolve();
      if (tokenGate) await tokenGate.release.promise;
      return Response.json({
        access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh',
        token_type: 'Bearer', expires_in: 3600,
      });
    }
    if (String(url).endsWith('/revoke')) {
      revoked.add(new URLSearchParams(init.body).get('token'));
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected synthetic IAM endpoint');
  };
}

test('shared sign-out reports unknown while another instance has a pending refresh', async (t) => {
  const credentials = createKeychainProvider(createMemoryBackend());
  await seedGrant(credentials);
  await credentials.modifyRecord('heluo-iam/gateway-credential', async () => ({
    kind: 'grant',
    payload: { version: 1, ownerSubject: 'E1001', enteredAt: new Date().toISOString() },
  }));
  await credentials.set(GATEWAY_REF, `uag-${'a'.repeat(32)}`);
  const tokenGate = { entered: deferred(), release: deferred() };
  const revoked = new Set();
  const config = { ...configured, refreshSkewSeconds: 7200 };
  const fetch = tokenFetch({ tokenGate, revoked });
  const signingOut = createIamService(config, { credentials, fetch, verifyAtomicStore: actual => actual === credentials });
  const refreshing = createIamService(config, { credentials, fetch, verifyAtomicStore: actual => actual === credentials });
  t.after(() => tokenGate.release.resolve());
  t.after(() => signingOut.dispose());
  t.after(() => refreshing.dispose());
  await signingOut.hydrate();
  await refreshing.hydrate();

  const logoutEntered = deferred();
  let logoutStarted = false;
  const modify = credentials.modifyRecord.bind(credentials);
  const remove = credentials.deleteRecord.bind(credentials);
  credentials.modifyRecord = (...args) => {
    if (logoutStarted) logoutEntered.resolve();
    return modify(...args);
  };
  credentials.deleteRecord = (...args) => {
    if (logoutStarted) logoutEntered.resolve();
    return remove(...args);
  };
  const refresh = refreshing.resolveToken();
  await waitForGate(tokenGate.entered.promise, refresh, 'refresh token request');
  logoutStarted = true;
  const logout = signingOut.signOut();
  await waitForGate(logoutEntered.promise, logout, 'sign-out store mutation');
  const result = await logout;
  assert.equal(result.view.state, 'error');
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.equal(result.revocation, 'unknown');
  assert.equal(revoked.size, 0);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  // The other instance may still complete: this is not global sign-out.
  tokenGate.release.resolve();
  assert.equal(await refresh, 'synthetic-new-access');
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'complete');
  // The model credential belongs to the user, not the IAM session.
  assert.equal((await credentials.resolve(GATEWAY_REF))?.value, `uag-${'a'.repeat(32)}`);
});

test('a hydration racing a shared clear converges on the next sync', async (t) => {
  const credentials = createKeychainProvider(createMemoryBackend());
  await seedGrant(credentials);
  const service = createIamService(configured, { credentials, verifyAtomicStore: actual => actual === credentials });
  const gate = pauseNextRead(credentials);
  t.after(() => gate.release());
  t.after(() => service.dispose());

  const hydrating = service.hydrate();
  await waitForGate(gate.entered, hydrating, 'hydration read');
  const signingOut = createIamService(configured, { credentials, fetch: tokenFetch(), verifyAtomicStore: actual => actual === credentials });
  t.after(() => signingOut.dispose());
  assert.equal((await signingOut.signOut()).view.state, 'signed-out');
  gate.release();
  await hydrating;

  // The stale read may finish first; the next poll must observe the clear.
  const settled = await service.syncFromStore();
  assert.equal(settled.state, 'signed-out');
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
});

test('a refresh rejects an unbound concurrent rotation without clearing or replaying it', async (t) => {
  const backend = createMemoryBackend();
  const credentials = createKeychainProvider(backend);
  // A second provider over the same storage models the other process: its lock
  // is independent, so it can rotate while this instance is mid-request.
  const otherProcess = createKeychainProvider(backend);
  await seedGrant(credentials);
  let tokenRequests = 0;
  const service = createIamService({ ...configured, refreshSkewSeconds: 7200 }, {
    credentials,
    verifyAtomicStore: actual => actual === credentials,
    fetch: async (url) => {
      if (String(url).endsWith('/token')) {
        tokenRequests++;
        // This foreign write has no matching completion receipt; it is not
        // evidence that the current refresh safely completed.
        await otherProcess.modifyRecord(GRANT_KEY, async (current) => ({
          kind: 'grant',
          payload: { ...current.payload, refreshToken: 'synthetic-latest-refresh', accessToken: 'synthetic-latest-access' },
        }));
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return tokenFetch()(url);
    },
  });
  t.after(() => service.dispose());
  await service.hydrate();

  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.notEqual(service.getView().state, 'ready');
  const record = await credentials.readRecord(GRANT_KEY);
  assert.equal(record.payload.refreshToken, 'synthetic-latest-refresh');
  assert.equal(record.payload.refreshOperation.state, 'pending');
  const restarted = createIamService({ ...configured, refreshSkewSeconds: 7200 }, {
    credentials, verifyAtomicStore: actual => actual === credentials,
  });
  t.after(() => restarted.dispose());
  assert.notEqual((await restarted.hydrate()).state, 'ready');
  assert.equal(tokenRequests, 1);
});

test('dispose during hydration keeps the stored grant', async (t) => {
  const credentials = createKeychainProvider(createMemoryBackend());
  await seedGrant(credentials);
  const service = createIamService(configured, { credentials, verifyAtomicStore: actual => actual === credentials });
  const gate = pauseNextRead(credentials);
  t.after(() => gate.release());
  t.after(() => service.dispose());

  const hydrating = service.hydrate();
  await waitForGate(gate.entered, hydrating, 'hydration read');
  await service.dispose();
  gate.release();
  await hydrating;

  assert.equal(service.getView().state, 'signed-out');
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshToken, 'synthetic-old-refresh');
});

test('dispose during refresh preserves pending and does not commit a late rotation', async (t) => {
  const credentials = createKeychainProvider(createMemoryBackend());
  await seedGrant(credentials);
  const tokenGate = { entered: deferred(), release: deferred() };
  const service = createIamService({ ...configured, refreshSkewSeconds: 7200 }, {
    credentials, fetch: tokenFetch({ tokenGate }), verifyAtomicStore: actual => actual === credentials,
  });
  t.after(() => tokenGate.release.resolve());
  t.after(() => service.dispose());
  await service.hydrate();

  const refreshing = service.resolveToken();
  await waitForGate(tokenGate.entered.promise, refreshing, 'refresh token request');
  await service.dispose();
  tokenGate.release.resolve();
  await assert.rejects(refreshing, { code: 'IAM_DISPOSED' });
  assert.equal(service.getView().state, 'signed-out');
  const record = await credentials.readRecord(GRANT_KEY);
  assert.equal(record.payload.refreshToken, 'synthetic-old-refresh');
  assert.equal(record.payload.refreshOperation.state, 'pending');
  let requests = 0;
  const restarted = createIamService({ ...configured, refreshSkewSeconds: 7200 }, {
    credentials, verifyAtomicStore: actual => actual === credentials,
    fetch: async () => { requests++; throw new Error('unexpected request'); },
  });
  t.after(() => restarted.dispose());
  assert.notEqual((await restarted.hydrate()).state, 'ready');
  assert.equal(requests, 0);
});
