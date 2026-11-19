import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createIamRoutes } from '../src/routes.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GATEWAY_RECORD_KEY, GATEWAY_REF, GRANT_KEY } from '../src/store.mjs';
import { createIamService } from './support/trusted-service.mjs';

const start = Date.parse('2030-01-01T00:00:00.000Z');
const accessLifetimeMs = 300_000;
const issuer = 'https://iam.corp.example';
const config = {
  issuer, clientId: 'synthetic-client', authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, refreshSkewSeconds: 1,
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const original = {
  version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
  issuer, clientId: config.clientId, subject: 'synthetic-subject', scope: 'openid',
  obtainedAt: new Date(start).toISOString(), accessExpiresAt: new Date(start + accessLifetimeMs).toISOString(),
  refreshExpiresAt: new Date(start + 360_000).toISOString(),
  accessToken: 'synthetic-original-access', refreshToken: 'synthetic-original-refresh',
};
const rotated = {
  access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh',
  token_type: 'Bearer', expires_in: 120, refresh_expires_in: 180,
};
const shortRefresh = { ...original, refreshExpiresAt: new Date(start + 6000).toISOString() };

async function startHost(t, initial = original, { refreshSkewSeconds = config.refreshSkewSeconds, getManagedModelRuntime } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-iam-read-lock-'));
  const directory = join(root, 'store');
  // A zero wait budget still exercises the actual SQLite busy error.
  const backend = createCredentialStore({ directory, lockTimeoutMs: 0 });
  const credentials = createKeychainProvider(backend);
  let activeCredentials = credentials;
  const joint = createJointStore(backend, namespacePrefixes());
  const store = createGrantStore(credentials);
  const posts = [];
  const events = [];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const service = createIamService({ ...config, refreshSkewSeconds }, {
    credentials,
    getCredentials: () => activeCredentials,
    getManagedModelRuntime,
    monotonic: () => Date.now(),
    getGatewayAtomicStore: (candidate) => candidate === credentials ? joint : undefined,
    verifyGatewayAtomicStore: (candidate, adapter) => candidate === credentials && adapter === joint,
    logRenewal: (event, fields) => events.push({ event, ...fields }),
    async fetch(url, init) {
      if (url === config.jwksUri) return Response.json({ keys: [] });
      assert.equal(url, config.tokenEndpoint);
      assert.equal(init.method, 'POST');
      posts.push(new URLSearchParams(init.body).get('refresh_token'));
      return Response.json(rotated);
    },
  });
  let blocker;
  let peer;
  let replacement;
  t.after(async () => {
    blocker?.close();
    await service.dispose();
    await peer?.close();
    await replacement?.close();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.write(initial);
  assert.equal((await service.hydrate()).state, 'ready');
  blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const handler = createIamRoutes(service, { getConnection: () => ({ requestRejection: () => undefined }) });
  function openPeerStore() {
    peer = createCredentialStore({ directory, lockTimeoutMs: 0 });
    return createGrantStore(createKeychainProvider(peer));
  }
  function replaceCredentials() {
    replacement = createCredentialStore({ directory: join(root, 'replacement'), lockTimeoutMs: 0 });
    activeCredentials = createKeychainProvider(replacement);
    return createGrantStore(activeCredentials);
  }
  return { blocker, store, service, credentials, posts, events, handler, openPeerStore, replaceCredentials };
}

function scheduledRenewal(events) {
  const scheduled = events.findLast((row) => row.event === 'renewal-scheduled');
  assert.ok(scheduled, 'expected a scheduled renewal');
  return scheduled;
}

function fireRenewal(t, events) {
  const scheduled = scheduledRenewal(events);
  t.mock.timers.tick(scheduled.dueAtMs - Date.now());
}

async function waitForView(service, predicate) {
  const deadline = performance.now() + 2000;
  do {
    const view = service.getView();
    if (predicate(view)) return view;
    await setImmediate();
  } while (performance.now() < deadline);
  assert.fail(`expected background state change, got ${service.getView().state}`);
}

async function callRoute(handler, method, path) {
  const response = {
    setHeader() {},
    end(payload) { this.body = JSON.parse(payload); },
  };
  await handler({ method, url: `/api/forge-iam/${path}`, headers: {
    'content-type': 'application/json', 'x-forge-iam-request': '1',
  } }, response);
  return response;
}

function assertUnavailable(service, view) {
  assert.equal(view.state, 'unreachable');
  assert.equal(view.error, 'IAM_CREDENTIALS_UNAVAILABLE');
  assert.equal(view.principal, null);
  assert.equal(view.signedIn, false);
  assert.equal(service.getSession().signedIn, false);
  assert.equal(service.getPrincipal(), undefined);
}

test('scheduled renewal retries a real SQLite read timeout before sending any refresh', async (t) => {
  const { blocker, store, service, posts, events } = await startHost(t);
  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  const blocked = await waitForView(service, (view) => view.state !== 'ready');
  await assert.rejects(store.read(), { code: 'CRED_LOCK_TIMEOUT' });
  assert.deepEqual(posts, []);
  assertUnavailable(service, blocked);

  t.mock.timers.tick(1000);
  await waitForView(service, () => events.filter((row) => row.event === 'store-sync' && row.reason === 'read-lock-timeout').length === 2);
  assertUnavailable(service, service.getView());

  blocker.exec('COMMIT');
  assert.deepEqual((await store.read()).grant, original);
  t.mock.timers.tick(999);
  await setImmediate();
  assertUnavailable(service, service.getView());
  assert.deepEqual(posts, []);
  t.mock.timers.tick(1);
  await waitForView(service, (view) => view.state === 'ready');
  // The successful read re-arms the due renewal in a separate timer turn.
  t.mock.timers.tick(1);
  await waitForView(service, (view) => view.state === 'ready' && view.accessExpiresAt !== original.accessExpiresAt);
  assert.deepEqual(posts, [original.refreshToken]);
  const renewed = (await store.read()).grant;
  assert.equal(renewed.sessionInstanceId, original.sessionInstanceId);
  assert.equal(renewed.refreshToken, rotated.refresh_token);
  assert.equal(renewed.refreshOperation.state, 'complete');
});

test('panel reads honor a shared backoff and the Host recovers without another request', async (t) => {
  const initial = { ...original, accessExpiresAt: new Date(start + 60_000).toISOString() };
  const { blocker, store, service, credentials, posts, events, handler } = await startHost(t, initial);
  const { dueAtMs } = scheduledRenewal(events);
  const readRecord = credentials.readRecord.bind(credentials);
  let sessionReads = 0;
  let otherReads = 0;
  t.mock.method(credentials, 'readRecord', (key) => {
    if (key === GRANT_KEY) sessionReads += 1;
    else otherReads += 1;
    return readRecord(key);
  });

  blocker.exec('BEGIN EXCLUSIVE');
  const panel = await callRoute(handler, 'GET', 'view');
  assert.equal(panel.statusCode, 200);
  assert.equal(sessionReads, 1);
  assert.equal(otherReads, 0);
  assertUnavailable(service, panel.body);
  const token = await callRoute(handler, 'POST', 'token');
  assert.equal(token.statusCode, 503);
  assert.equal(token.body.error.code, 'IAM_CREDENTIALS_UNAVAILABLE');
  assert.equal(Object.hasOwn(token.body, 'token'), false);
  assert.deepEqual(posts, []);

  blocker.exec('COMMIT');
  const readsBeforePolls = sessionReads;
  const panels = await Promise.all([callRoute(handler, 'GET', 'view'), callRoute(handler, 'GET', 'view')]);
  for (const response of panels) assertUnavailable(service, response.body);
  assert.equal(sessionReads, readsBeforePolls);
  assert.equal(otherReads, 0);

  t.mock.timers.tick(1000);
  const restored = await waitForView(service, (view) => view.state === 'ready');
  assert.equal(sessionReads, readsBeforePolls + 1);
  assert.equal(restored.principal, initial.subject);
  assert.equal(restored.accessExpiresAt, initial.accessExpiresAt);
  assert.deepEqual(posts, []);
  assert.deepEqual((await store.read()).grant, initial);

  t.mock.timers.tick(dueAtMs - Date.now() - 1);
  await setImmediate();
  assert.deepEqual(posts, []);
  t.mock.timers.tick(1);
  await waitForView(service, (view) => view.state === 'ready' && view.accessExpiresAt !== initial.accessExpiresAt);
  assert.deepEqual(posts, [initial.refreshToken]);
});

test('a recovered grant renews before its refresh deadline while the gateway summary is stalled', async (t) => {
  const { blocker, store, service, credentials, posts, events, handler } = await startHost(t, shortRefresh, {
    refreshSkewSeconds: 3,
    getManagedModelRuntime: () => ({ getView: () => ({ managed: true, state: 'ready', models: [] }) }),
  });
  await service.saveGatewayCredential({ key: 'synthetic-gateway-key', baseURL: 'https://gateway.corp.example/v1' });
  assert.equal((await service.resolveGatewayConnection()).subject, shortRefresh.subject);
  assert.equal(service.getView().modelAccess.state, 'ready');

  const releaseGateway = Promise.withResolvers();
  t.after(releaseGateway.resolve);
  const readRecord = credentials.readRecord.bind(credentials);
  let holdingGateway = false;
  t.mock.method(credentials, 'readRecord', async (key) => {
    const record = await readRecord(key);
    if (key === GATEWAY_RECORD_KEY && !holdingGateway) {
      holdingGateway = true;
      await releaseGateway.promise;
    }
    return record;
  });

  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  assertUnavailable(service, await waitForView(service, (view) => view.state !== 'ready'));
  blocker.exec('COMMIT');
  t.mock.timers.tick(1000);
  await waitForView(service, () => holdingGateway);
  t.mock.timers.tick(1);
  const view = await waitForView(service, (current) => current.state === 'ready' && current.accessExpiresAt !== shortRefresh.accessExpiresAt);
  assert.ok(Date.now() < Date.parse(shortRefresh.refreshExpiresAt));
  assert.deepEqual(posts, [shortRefresh.refreshToken]);
  assert.equal(service.getSession().signedIn, true);
  assert.equal(service.getSession().status, view.state);
  assert.equal(service.getSession().accessExpiresAt, view.accessExpiresAt);
  assert.equal((await store.read()).grant.refreshOperation.state, 'complete');

  let panel;
  let panelFailure;
  void callRoute(handler, 'GET', 'view').then((response) => { panel = response; }, (error) => { panelFailure = error; });
  await waitForView(service, () => panel !== undefined || panelFailure !== undefined);
  if (panelFailure) throw panelFailure;
  assert.equal(panel.statusCode, 200);
  assert.equal(panel.body.signedIn, service.getSession().signedIn);
  assert.equal(panel.body.state, service.getSession().status);
  assert.equal(panel.body.accessExpiresAt, service.getSession().accessExpiresAt);
  assert.equal(panel.body.modelAccess.state, 'unconfigured');

  // A cached gateway summary cannot authorize a mismatched stored value.
  await credentials.set(GATEWAY_REF, 'synthetic-different-key');
  await assert.rejects(service.resolveGatewayConnection(), { code: 'IAM_GATEWAY_CREDENTIAL_REQUIRED' });
  releaseGateway.resolve();
  await waitForView(service, (current) => current.gatewayCredential?.state === 'invalid');
  assert.deepEqual(posts, [shortRefresh.refreshToken]);
});

test('panel lock recovery keeps the renewal that became due during the read backoff', async (t) => {
  const { blocker, service, posts, events, handler } = await startHost(t, shortRefresh, { refreshSkewSeconds: 3 });
  const { dueAtMs } = scheduledRenewal(events);
  t.mock.timers.tick(dueAtMs - Date.now() - 1);
  blocker.exec('BEGIN EXCLUSIVE');
  assertUnavailable(service, (await callRoute(handler, 'GET', 'view')).body);
  t.mock.timers.tick(1);
  assert.deepEqual(posts, []);
  blocker.exec('COMMIT');
  t.mock.timers.tick(999);
  await waitForView(service, (view) => view.state === 'ready');
  t.mock.timers.tick(1);
  await waitForView(service, (view) => view.accessExpiresAt !== shortRefresh.accessExpiresAt && view.state === 'ready');
  t.mock.timers.tick(Date.parse(shortRefresh.refreshExpiresAt) - Date.now());
  await setImmediate();
  assert.deepEqual(posts, [shortRefresh.refreshToken]);
});

test('a delayed timer read timeout re-arms renewal after panel recovery adopted the same grant', async (t) => {
  const { blocker, store, service, credentials, posts, events, handler } = await startHost(t, shortRefresh, { refreshSkewSeconds: 3 });
  const { renewalId } = scheduledRenewal(events);
  const releaseTimeout = Promise.withResolvers();
  t.after(releaseTimeout.resolve);
  const readRecord = credentials.readRecord.bind(credentials);
  let holdTimerRead = true;
  let actualTimeout;
  t.mock.method(credentials, 'readRecord', async (key) => {
    if (key !== GRANT_KEY || !holdTimerRead) return readRecord(key);
    holdTimerRead = false;
    try {
      return await readRecord(key);
    } catch (error) {
      actualTimeout = error;
      await releaseTimeout.promise;
      throw error;
    }
  });

  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  await waitForView(service, () => actualTimeout !== undefined);
  assert.equal(actualTimeout.code, 'CRED_LOCK_TIMEOUT');
  assertUnavailable(service, (await callRoute(handler, 'GET', 'view')).body);
  blocker.exec('COMMIT');
  t.mock.timers.tick(1000);
  const restored = await waitForView(service, (view) => view.state === 'ready');
  assert.equal(restored.accessExpiresAt, shortRefresh.accessExpiresAt);
  assert.deepEqual((await store.read()).grant, shortRefresh);
  assert.deepEqual(posts, []);

  releaseTimeout.resolve();
  await waitForView(service, () => events.some((row) => row.event === 'renewal-failed' && row.renewalId === renewalId));
  assert.ok(events.some((row) => row.event === 'refresh-retry' && row.renewalId === renewalId
    && row.reason === 'read-lock-timeout'), 'late timeout must retain the due renewal for the equal grant');
  t.mock.timers.tick(1000);
  await waitForView(service, (view) => view.state === 'ready');
  t.mock.timers.tick(1);
  await waitForView(service, (view) => view.state === 'ready' && view.accessExpiresAt !== shortRefresh.accessExpiresAt);
  t.mock.timers.tick(Date.parse(shortRefresh.refreshExpiresAt) - Date.now());
  await setImmediate();
  assert.deepEqual(posts, [shortRefresh.refreshToken]);
});

async function observePeerPendingAfterReadTimeout(t) {
  const host = await startHost(t);
  const { blocker, service, events, openPeerStore } = host;
  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  assertUnavailable(service, await waitForView(service, (view) => view.state !== 'ready'));
  blocker.exec('COMMIT');

  const id = Buffer.alloc(32, 9).toString('base64url');
  const pending = { ...original, refreshOperation: { version: 1, state: 'pending', id, base: refreshBaseId(original, id) } };
  const peerStore = openPeerStore();
  await peerStore.write(pending);
  t.mock.timers.tick(1000);
  const view = await waitForView(service, (current) => current.state === 'error');
  assert.equal(view.error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual(host.posts, []);
  const complete = {
    ...pending,
    accessToken: rotated.access_token,
    refreshToken: rotated.refresh_token,
    accessExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    refreshOperation: { ...pending.refreshOperation, state: 'complete' },
  };
  return { ...host, peerStore, pending, complete };
}

test('a scheduled read retry observes a peer pending marker without replaying its refresh token', async (t) => {
  const { service, store, posts, pending } = await observePeerPendingAfterReadTimeout(t);
  t.mock.timers.tick(1000);
  assert.equal((await service.syncFromStore()).error, 'IAM_REAUTH_REQUIRED');
  assert.deepEqual((await store.read()).grant, pending);
  assert.deepEqual(posts, []);
});

test('a matching peer receipt after lock recovery is adopted in the background', async (t) => {
  const { service, handler, peerStore, pending, complete, posts } = await observePeerPendingAfterReadTimeout(t);
  await peerStore.mutate((current) => {
    assert.deepEqual(current, pending);
    return complete;
  });
  t.mock.timers.tick(1000);
  const view = await waitForView(service, (current) => current.state === 'ready');
  assert.equal(view.accessExpiresAt, complete.accessExpiresAt);
  assert.equal(service.getSession().signedIn, true);
  const panel = await callRoute(handler, 'GET', 'view');
  assert.equal(panel.body.state, 'ready');
  assert.equal(panel.body.accessExpiresAt, complete.accessExpiresAt);
  assert.deepEqual(posts, []);
});

test('an unmatched peer receipt after lock recovery cannot authorize the session', async (t) => {
  const { service, peerStore, complete, posts, events } = await observePeerPendingAfterReadTimeout(t);
  await peerStore.write({
    ...complete, refreshOperation: { ...complete.refreshOperation, base: Buffer.alloc(32, 5).toString('base64url') },
  });
  t.mock.timers.tick(1000);
  await waitForView(service, () => events.some((row) => row.event === 'store-sync' && row.reason === 'pending-result-unmatched'));
  assert.equal(service.getView().error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual(posts, []);
});

test('a peer receipt after the lock recovery observation window stays rejected', async (t) => {
  const { service, handler, peerStore, complete, posts } = await observePeerPendingAfterReadTimeout(t);
  t.mock.timers.tick(5000);
  await peerStore.write(complete);
  t.mock.timers.tick(1000);
  const panel = await callRoute(handler, 'GET', 'view');
  assert.equal(panel.body.error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual(posts, []);
});

async function hitPendingReadLock(t, host, afterMs) {
  const { blocker, service, store, pending, posts, events } = host;
  const lockTimeoutCount = () => events.filter((row) => row.event === 'store-sync' && row.reason === 'read-lock-timeout').length;
  const before = lockTimeoutCount();
  blocker.exec('BEGIN EXCLUSIVE');
  t.mock.timers.tick(afterMs);
  await waitForView(service, () => lockTimeoutCount() > before);
  assert.equal(service.getView().error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual(posts, []);
  blocker.exec('COMMIT');
  assert.deepEqual((await store.read()).grant, pending);
}

test('a retry after a second SQLite read timeout still adopts a receipt in the original window', async (t) => {
  const host = await observePeerPendingAfterReadTimeout(t);
  await hitPendingReadLock(t, host, 100);
  await host.peerStore.write(host.complete);
  t.mock.timers.tick(1000);
  const view = await waitForView(host.service, (current) => current.state === 'ready');
  assert.equal(view.accessExpiresAt, host.complete.accessExpiresAt);
  assert.deepEqual(host.posts, []);
});

test('a second SQLite read timeout does not extend the peer receipt window', async (t) => {
  const host = await observePeerPendingAfterReadTimeout(t);
  const deadline = Date.now() + 5000;
  await hitPendingReadLock(t, host, 4800);
  t.mock.timers.tick(deadline - Date.now());
  await host.peerStore.write(host.complete);
  t.mock.timers.tick(1000);
  const panel = await callRoute(host.handler, 'GET', 'view');
  assert.equal(panel.body.error, 'IAM_REAUTH_REQUIRED');
  assert.equal(host.service.getSession().signedIn, false);
  assert.deepEqual(host.posts, []);
});

async function holdMatchingPeerReceipt(t, { service, credentials, peerStore, complete }) {
  await peerStore.write(complete);
  const releaseReceipt = Promise.withResolvers();
  t.after(releaseReceipt.resolve);
  const readRecord = credentials.readRecord.bind(credentials);
  let holdingReceipt = false;
  t.mock.method(credentials, 'readRecord', async (key) => {
    const record = await readRecord(key);
    if (key === GRANT_KEY && record?.payload?.refreshOperation?.state === 'complete' && !holdingReceipt) {
      holdingReceipt = true;
      await releaseReceipt.promise;
    }
    return record;
  });
  t.mock.timers.tick(1000);
  await waitForView(service, () => holdingReceipt);
  return releaseReceipt.resolve;
}

test('sign-out fences a matching peer receipt already read by lock recovery', async (t) => {
  const host = await observePeerPendingAfterReadTimeout(t);
  const { service, store, posts } = host;
  const releaseReceipt = await holdMatchingPeerReceipt(t, host);
  assert.equal((await service.signOut()).view.state, 'signed-out');
  releaseReceipt();
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getSession().signedIn, false);
  assert.equal((await store.read()).grant, null);
  assert.deepEqual(posts, []);
});

test('dispose fences a matching peer receipt already read by lock recovery', async (t) => {
  const host = await observePeerPendingAfterReadTimeout(t);
  const { service, store, complete, posts } = host;
  const releaseReceipt = await holdMatchingPeerReceipt(t, host);
  await service.dispose();
  releaseReceipt();
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual((await store.read()).grant, complete);
  assert.deepEqual(posts, []);
});

test('a matching peer receipt from the previous SQLite provider cannot authorize the replacement', async (t) => {
  const host = await observePeerPendingAfterReadTimeout(t);
  const { service, store, complete, posts } = host;
  const releaseReceipt = await holdMatchingPeerReceipt(t, host);
  const replacement = host.replaceCredentials();
  await service.loadGatewayCredential({ force: true });
  releaseReceipt();
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(service.getView().error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual((await store.read()).grant, complete);
  assert.equal((await replacement.read()).grant, null);
  assert.deepEqual(posts, []);
});

test('sign-out during SQLite read backoff fences the deferred renewal', async (t) => {
  const { blocker, store, service, posts, events } = await startHost(t);
  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  assertUnavailable(service, await waitForView(service, (view) => view.state !== 'ready'));
  blocker.exec('COMMIT');

  assert.equal((await service.signOut()).view.state, 'signed-out');
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal((await store.read()).grant, null);
  assert.deepEqual(posts, []);
});
