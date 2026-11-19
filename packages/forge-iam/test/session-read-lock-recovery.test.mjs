import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { createIamRoutes } from '../src/routes.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
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

async function startHost(t, initial = original) {
  const root = await mkdtemp(join(tmpdir(), 'forge-iam-read-lock-'));
  const directory = join(root, 'store');
  // A zero wait budget still exercises the actual SQLite busy error.
  const backend = createCredentialStore({ directory, lockTimeoutMs: 0 });
  const credentials = createKeychainProvider(backend);
  const store = createGrantStore(credentials);
  const posts = [];
  const events = [];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const service = createIamService(config, {
    credentials,
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
  t.after(async () => {
    blocker?.close();
    await service.dispose();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.write(initial);
  assert.equal((await service.hydrate()).state, 'ready');
  blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  return { directory, blocker, store, service, credentials, posts, events };
}

function fireRenewal(t, events) {
  const scheduled = events.findLast((row) => row.event === 'renewal-scheduled');
  assert.ok(scheduled, 'expected a scheduled renewal');
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
  const { blocker, store, service, credentials, posts, events } = await startHost(t, initial);
  const handler = createIamRoutes(service, { getConnection: () => ({ requestRejection: () => undefined }) });
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

  fireRenewal(t, events);
  await waitForView(service, (view) => view.state === 'ready' && view.accessExpiresAt !== initial.accessExpiresAt);
  assert.deepEqual(posts, [initial.refreshToken]);
});

test('a scheduled read retry adopts a peer pending marker without replaying its refresh token', async (t) => {
  const { directory, blocker, store, service, posts, events } = await startHost(t);
  blocker.exec('BEGIN EXCLUSIVE');
  fireRenewal(t, events);
  assertUnavailable(service, await waitForView(service, (view) => view.state !== 'ready'));
  blocker.exec('COMMIT');

  const id = Buffer.alloc(32, 9).toString('base64url');
  const pending = { ...original, refreshOperation: { version: 1, state: 'pending', id, base: refreshBaseId(original, id) } };
  const peer = createCredentialStore({ directory, lockTimeoutMs: 0 });
  try {
    await createGrantStore(createKeychainProvider(peer)).write(pending);
  } finally {
    await peer.close();
  }
  t.mock.timers.tick(1000);
  const view = await waitForView(service, (current) => current.state === 'error');
  assert.equal(view.error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);
  t.mock.timers.tick(1000);
  assert.equal((await service.syncFromStore()).error, 'IAM_REAUTH_REQUIRED');
  assert.deepEqual((await store.read()).grant, pending);
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
