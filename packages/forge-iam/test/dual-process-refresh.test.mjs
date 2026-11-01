// Cross-process refresh behaviour for #13 AC3 / plan P0-4. Two operating-system
// processes share one credential store (a locked JSON file standing in for the
// keychain), and the assertions are about what the IdP sees and what the store
// ends up holding — not about in-process promise sharing.
//
// Honest limits: the store is a test double, the IdP is a local mock, and the
// 5s bound is the service's own REFRESH_TIMEOUT_MS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { FileCredentials } from './support/file-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const WORKER = fileURLToPath(new URL('./support/refresh-worker.mjs', import.meta.url));
const RECORD_KEY = 'heluo-iam/session';

function configFor(mock, overrides = {}) {
  return validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  }).value;
}

async function signIn(dir, config) {
  const credentials = new FileCredentials(dir);
  const service = createIamService(config, { credentials });
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const view = await service.handleCallback(response.headers.get('location'));
  assert.equal(view.state, 'ready');
  return credentials;
}

/** Force the stored access token to look expired without touching the refresh token. */
async function expireAccessToken(credentials) {
  await credentials.modifyRecord(RECORD_KEY, (current) => ({
    ...current,
    payload: { ...current.payload, accessExpiresAt: new Date(Date.now() - 60_000).toISOString() },
  }));
}

async function storedGrant(credentials) {
  return (await credentials.readRecord(RECORD_KEY))?.payload;
}

function runWorker(dir, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER, '--dir', dir, '--config', JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ exitCode: code, ...JSON.parse(stdout) });
      } catch {
        reject(new Error(`worker produced no JSON (exit ${code}): ${stdout} ${stderr}`.slice(0, 800)));
      }
    });
  });
}

test('two processes refresh once and share the rotated grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-dual-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  assert.equal(mock.counts.refresh, 0);

  const results = await Promise.all([runWorker(dir, config), runWorker(dir, config)]);

  for (const result of results) {
    assert.equal(result.ok, true, `worker failed: ${JSON.stringify(result)}`);
    assert.equal(result.hasToken, true, 'a cold worker must still receive a usable token');
  }
  assert.equal(mock.counts.refresh, 1, 'the IdP must see exactly one refresh for two processes');
  const after = await storedGrant(credentials);
  assert.notEqual(after.refreshToken, before.refreshToken, 'the store must hold the rotated token');
  assert.equal(mock.refreshTokens.has(after.refreshToken), true, 'the stored token must be the live one');
  assert.equal(mock.refreshTokens.has(before.refreshToken), false, 'the old token must be consumed');
});

test('a refresh that exceeds five seconds fails instead of hanging', async (t) => {
  const mock = await startMockOidc({ refreshDelayMs: 8000 });
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-slow-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  mock.control.refreshDelayMs = 8000;

  const result = await runWorker(dir, config);

  assert.equal(result.ok, false, 'the refresh must not succeed past the bound');
  assert.ok(result.elapsedMs >= 4500, `gave up too early: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 7000, `did not respect the 5s bound: ${result.elapsedMs}ms`);
  const after = await storedGrant(credentials);
  assert.equal(after.refreshToken, before.refreshToken, 'a timed-out refresh must not change the stored grant');
  assert.equal(after.refreshOperation?.state, 'pending');
  const count = mock.counts.token;
  const retry = await runWorker(dir, config);
  assert.equal(retry.ok, false);
  assert.equal(mock.counts.token, count, 'a timeout never permits resending the refresh token');
});

test('a lost refresh response forces a new sign-in', async (t) => {
  const mock = await startMockOidc({ dropRefreshResponse: true });
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-lost-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);

  // The IdP rotates the refresh token and then drops the connection, so this
  // process still holds a token the IdP has already invalidated.
  const lost = await runWorker(dir, config);
  assert.equal(lost.ok, false, 'the dropped response must not be reported as success');
  assert.equal(lost.hasToken, undefined);
  const stillOld = await storedGrant(credentials);
  assert.equal(stillOld.refreshToken, before.refreshToken, 'the store cannot hold a token it never received');
  assert.equal(mock.refreshTokens.has(before.refreshToken), false, 'the IdP already consumed it');

  mock.control.dropRefreshResponse = false;
  const tokenRequestsAfterLostResponse = mock.counts.token;
  const retry = await runWorker(dir, config);
  assert.equal(mock.counts.token, tokenRequestsAfterLostResponse, 'a refresh with unknown outcome must not be sent again');
  assert.equal(retry.ok, false, 'a consumed refresh token cannot be replayed');
  assert.equal(retry.code, 'IAM_REAUTH_REQUIRED');
  const pending = await credentials.readRecord(RECORD_KEY);
  assert.equal(pending?.payload?.refreshOperation?.state, 'pending', 'uncertainty must remain durable');

  // A fresh browser sign-in recovers on the same store.
  const recovered = await signIn(dir, config);
  assert.equal(mock.counts.refresh, 1, 'only the first, response-lost attempt reached the refresh branch');
  assert.equal((await storedGrant(recovered)).subject, before.subject);
});

test('a failed pending commit never sends the refresh request', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-pending-fail-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const count = mock.counts.token;
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = async (key, mutate) => modify(key, async (current) => {
    const next = await mutate(current);
    if (next?.payload?.refreshOperation) throw new Error('pending commit failed');
    return next;
  });
  const service = createIamService(config, { credentials });
  await assert.rejects(service.resolveToken());
  assert.equal(mock.counts.token, count);
  assert.notEqual(service.getView().state, 'ready');
});

test('pending committed before an error never authorizes a POST or restart replay', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-pending-ack-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  const count = mock.counts.token;
  const modify = credentials.modifyRecord.bind(credentials);
  let injected = false;
  credentials.modifyRecord = async (key, mutate) => {
    let wrotePending = false;
    const result = await modify(key, async (current) => {
      const next = await mutate(current);
      wrotePending = next?.payload?.refreshOperation?.state === 'pending';
      return next;
    });
    if (wrotePending) {
      injected = true;
      throw new Error('synthetic lost pending commit acknowledgement');
    }
    return result;
  };

  const service = createIamService(config, { credentials });
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(injected, true, 'the provider must commit before throwing');
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(mock.counts.token, count, 'no token POST may follow an unacknowledged pending commit');
  const pending = await storedGrant(credentials);
  assert.equal(pending?.refreshOperation?.state, 'pending');
  assert.equal(pending?.refreshToken === before.refreshToken, true);

  const restarted = await runWorker(dir, config);
  assert.equal(restarted.exitCode, 0);
  assert.equal(restarted.ok, false);
  assert.equal(restarted.code, 'IAM_REAUTH_REQUIRED');
  assert.notEqual(restarted.state, 'ready');
  assert.notEqual(restarted.hasToken, true);
  assert.equal(mock.counts.token, count, 'restart must not replay the pending operation');
  assert.deepEqual((await storedGrant(credentials))?.refreshOperation, pending.refreshOperation);
});

test('complete committed before an error fails the owner but is visible to a pending observer', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-complete-ack-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  const count = mock.counts.token;
  const modify = credentials.modifyRecord.bind(credentials);
  let injected = false;
  credentials.modifyRecord = async (key, mutate) => {
    let wroteComplete = false;
    const result = await modify(key, async (current) => {
      const next = await mutate(current);
      wroteComplete = next?.payload?.refreshOperation?.state === 'complete';
      return next;
    });
    if (wroteComplete) {
      injected = true;
      throw new Error('synthetic lost complete commit acknowledgement');
    }
    return result;
  };
  const observer = createIamService(config, { credentials: new FileCredentials(dir) });
  let observedPending = false;
  const service = createIamService(config, { credentials, fetch: async (url, init) => {
    if (String(url) === config.tokenEndpoint && new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') {
      observedPending = (await storedGrant(credentials))?.refreshOperation?.state === 'pending';
      assert.notEqual((await observer.hydrate()).state, 'ready');
    }
    return fetch(url, init);
  } });

  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(observedPending, true);
  assert.equal(injected, true, 'the provider must commit before throwing');
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(mock.counts.token - count, 1);
  const complete = await storedGrant(credentials);
  assert.equal(complete?.refreshOperation?.state, 'complete');
  assert.equal(complete?.refreshToken !== before.refreshToken, true);
  assert.equal(mock.refreshTokens.has(before.refreshToken), false);
  assert.equal(mock.refreshTokens.has(complete.refreshToken), true);

  // The store committed although its acknowledgement was lost. IAM cannot
  // eliminate this ambiguity: the owner fails closed while another conforming
  // instance may observe the durable completion and use the rotated grant.
  assert.equal((await observer.syncFromStore()).state, 'ready');
  assert.equal(observer.getView().signedIn, true);
  const observerToken = await observer.resolveToken();
  assert.equal(observerToken === complete.accessToken, true);
  assert.equal(mock.counts.token - count, 1, 'observing completion must not replay the refresh');
});

test('complete rejected before commit leaves pending and never replays on restart', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-complete-fail-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  const count = mock.counts.token;
  const modify = credentials.modifyRecord.bind(credentials);
  let injected = false;
  credentials.modifyRecord = async (key, mutate) => modify(key, async (current) => {
    const next = await mutate(current);
    if (next?.payload?.refreshOperation?.state === 'complete') {
      injected = true;
      throw new Error('synthetic complete commit failure');
    }
    return next;
  });

  const service = createIamService(config, { credentials });
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(injected, true, 'the fault must occur before the complete write');
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(mock.counts.token - count, 1);
  assert.equal(mock.refreshTokens.has(before.refreshToken), false);
  const pending = await storedGrant(credentials);
  assert.equal(pending?.refreshOperation?.state, 'pending');
  assert.equal(pending?.refreshToken === before.refreshToken, true);

  const restarted = await runWorker(dir, config);
  assert.equal(restarted.exitCode, 0);
  assert.equal(restarted.ok, false);
  assert.equal(restarted.code, 'IAM_REAUTH_REQUIRED');
  assert.notEqual(restarted.state, 'ready');
  assert.notEqual(restarted.hasToken, true);
  assert.equal(mock.counts.token - count, 1, 'restart must not resend the consumed refresh token');
  assert.deepEqual((await storedGrant(credentials))?.refreshOperation, pending.refreshOperation);
});

test('a crashed pending owner is never taken over by a new process', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-pending-crash-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  await credentials.modifyRecord(RECORD_KEY, (current) => ({
    ...current, payload: { ...current.payload, refreshOperation: { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) } },
  }));
  const count = mock.counts.token;
  const result = await runWorker(dir, config);
  assert.equal(result.ok, false);
  assert.notEqual(result.state, 'ready');
  assert.equal(mock.counts.token, count);
  assert.equal((await storedGrant(credentials)).refreshOperation.state, 'pending');
});

test('unknown or corrupt pending markers fail closed without token requests', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-pending-corrupt-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const original = await credentials.readRecord(RECORD_KEY);
  for (const marker of [null, {}, { version: 2, state: 'pending', id: 'A'.repeat(43) },
    { version: 1, state: 'done', id: 'A'.repeat(43) }, { version: 1, state: 'pending', id: 'bad' }]) {
    await credentials.modifyRecord(RECORD_KEY, () => ({ ...original, payload: { ...original.payload, refreshOperation: marker } }));
    const count = mock.counts.token;
    const result = await runWorker(dir, config);
    assert.equal(result.ok, false);
    assert.notEqual(result.state, 'ready');
    assert.equal(mock.counts.token, count);
  }
});

test('pending is durable before the refresh POST and hydrate cannot show ready', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-pending-order-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  let observed = false;
  let observer;
  let pendingMarker;
  const service = createIamService(config, { credentials, fetch: async (url, init) => {
    if (String(url).endsWith('/token')) {
      const grant = await storedGrant(credentials);
      assert.equal(grant.refreshOperation?.state, 'pending');
      pendingMarker = grant.refreshOperation;
      observer = createIamService(config, { credentials });
      const view = await observer.hydrate();
      assert.notEqual(view.state, 'ready');
      assert.equal(view.signedIn, false);
      assert.notEqual((await observer.syncFromStore()).state, 'ready');
      observed = true;
    }
    return fetch(url, init);
  } });
  await service.resolveToken();
  assert.equal(observed, true);
  assert.deepEqual((await storedGrant(credentials)).refreshOperation, { ...pendingMarker, state: 'complete' });
  assert.equal((await observer.syncFromStore()).state, 'ready');
  assert.equal(observer.getView().signedIn, true);
});

test('poll recovery refuses a replaced operation or a new login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-poll-replaced-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  const original = await credentials.readRecord(RECORD_KEY);
  const marker = { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) };
  const pending = { ...original, payload: { ...original.payload, refreshOperation: marker } };
  const complete = { ...pending, payload: { ...pending.payload, refreshOperation: { ...marker, state: 'complete' } } };
  await credentials.modifyRecord(RECORD_KEY, () => pending);
  const observer = createIamService(config, { credentials });
  assert.equal((await observer.hydrate()).state, 'error');
  await credentials.modifyRecord(RECORD_KEY, () => ({ ...complete, payload: { ...complete.payload,
    refreshOperation: { ...complete.payload.refreshOperation, id: 'B'.repeat(42) + 'A' } } }));
  assert.notEqual((await observer.syncFromStore()).state, 'ready');
  await credentials.modifyRecord(RECORD_KEY, () => complete);
  assert.notEqual((await observer.syncFromStore()).state, 'ready', 'a replaced marker invalidates the observation');

  await credentials.modifyRecord(RECORD_KEY, () => pending);
  const second = createIamService(config, { credentials });
  assert.equal((await second.hydrate()).state, 'error');
  await signIn(dir, config);
  assert.notEqual((await second.syncFromStore()).state, 'ready', 'a different login is not the observed completion');
});

test('poll recovery never clears unrelated errors or a superseded lifecycle', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-poll-error-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  const original = await credentials.readRecord(RECORD_KEY);
  const marker = { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) };
  const pending = { ...original, payload: { ...original.payload, refreshOperation: marker } };
  const complete = { ...pending, payload: { ...pending.payload, refreshOperation: { ...marker, state: 'complete' } } };
  const unrelated = createIamService(config, { credentials });
  await credentials.modifyRecord(RECORD_KEY, () => ({ ...original, payload: { ...original.payload, version: 999 } }));
  assert.equal((await unrelated.hydrate()).error, 'IAM_GRANT_INVALID');
  await credentials.modifyRecord(RECORD_KEY, () => pending);
  assert.equal((await unrelated.syncFromStore()).error, 'IAM_GRANT_INVALID');
  await credentials.modifyRecord(RECORD_KEY, () => complete);
  assert.equal((await unrelated.syncFromStore()).error, 'IAM_GRANT_INVALID');

  await credentials.modifyRecord(RECORD_KEY, () => pending);
  const observer = createIamService(config, { credentials });
  assert.equal((await observer.hydrate()).state, 'error');
  await observer.startSignIn();
  await credentials.modifyRecord(RECORD_KEY, () => complete);
  assert.equal((await observer.syncFromStore()).state, 'authenticating');
  await observer.cancelSignIn();
  // After cancellation a normal fresh sync is outside pending-error recovery.
  await observer.dispose();
  assert.notEqual((await observer.syncFromStore()).state, 'ready');
});

test('poll recovery rejects changed identity, unchanged rotation, expiry and timeout', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-poll-checks-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  const original = await credentials.readRecord(RECORD_KEY);
  const marker = { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) };
  const pending = { ...original, payload: { ...original.payload, refreshOperation: marker } };
  const complete = { ...pending, payload: { ...pending.payload, refreshToken: 'rotated-test-token',
    refreshOperation: { ...marker, state: 'complete' } } };
  const past = new Date(Date.now() - 60_000).toISOString();
  for (const [name, override] of [
    ['subject', { subject: 'different-subject' }],
    ['unchanged token', { refreshToken: pending.payload.refreshToken }],
    ['access expiry', { accessExpiresAt: past }],
    ['refresh expiry', { refreshExpiresAt: past }],
  ]) {
    await credentials.modifyRecord(RECORD_KEY, () => pending);
    const observer = createIamService(config, { credentials });
    assert.equal((await observer.hydrate()).state, 'error');
    await credentials.modifyRecord(RECORD_KEY, () => ({ ...complete, payload: { ...complete.payload, ...override } }));
    assert.notEqual((await observer.syncFromStore()).state, 'ready', name);
    await credentials.modifyRecord(RECORD_KEY, () => complete);
    assert.notEqual((await observer.syncFromStore()).state, 'ready', `${name} must invalidate observation`);
  }
  let clock = Date.now();
  await credentials.modifyRecord(RECORD_KEY, () => pending);
  const timed = createIamService(config, { credentials, now: () => clock });
  assert.equal((await timed.hydrate()).state, 'error');
  clock += 5000;
  await credentials.modifyRecord(RECORD_KEY, () => complete);
  assert.notEqual((await timed.syncFromStore()).state, 'ready', 'expired observation cannot recover');
});

test('a waiter cannot adopt a different authorization in place of the pending operation', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-wait-relogin-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  await credentials.modifyRecord(RECORD_KEY, (current) => ({
    ...current, payload: { ...current.payload, refreshOperation: { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) } },
  }));
  let entered;
  const observed = new Promise((resolve) => { entered = resolve; });
  const read = credentials.readRecord.bind(credentials);
  let first = true;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key === RECORD_KEY && first) { first = false; entered(); }
    return record;
  };
  const waiter = createIamService(config, { credentials });
  const pending = waiter.resolveToken();
  const rejected = assert.rejects(pending, { code: 'IAM_REAUTH_REQUIRED' });
  await observed;
  const replacement = await signIn(dir, config);
  const fresh = await storedGrant(replacement);
  await rejected;
  assert.equal((await storedGrant(credentials)).refreshToken, fresh.refreshToken);
  assert.notEqual(waiter.getView().state, 'ready');
});

test('waiters reject stalled reads and ignore late resolve or reject', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-wait-stalled-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const original = await credentials.readRecord(RECORD_KEY);
  const marker = { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) };
  const pending = { ...original, payload: { ...original.payload, refreshOperation: marker } };
  const complete = { ...pending, payload: { ...pending.payload, accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: 'rotated-test-token', refreshOperation: { ...marker, state: 'complete' } } };
  await credentials.modifyRecord(RECORD_KEY, () => pending);
  const waiters = ['resolve', 'reject'].map((mode) => {
    const provider = new FileCredentials(dir);
    const read = provider.readRecord.bind(provider);
    let count = 0;
    let entered;
    let settle;
    const observed = new Promise((resolve) => { entered = resolve; });
    const deferred = new Promise((resolve, reject) => { settle = mode === 'resolve' ? () => resolve(complete) : () => reject(new Error('late read')); });
    provider.readRecord = (key) => {
      if (key === RECORD_KEY && ++count === 2) { entered(); return deferred; }
      return read(key);
    };
    const service = createIamService(config, { credentials: provider });
    const result = service.resolveToken().then(() => 'accepted', (error) => error.code);
    return { observed, settle, service, result };
  });
  t.after(() => waiters.forEach((waiter) => waiter.settle()));
  await Promise.all(waiters.map((waiter) => waiter.observed));
  const results = await Promise.all(waiters.map((waiter) => Promise.race([
    waiter.result, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5600)),
  ])));
  const before = waiters.map((waiter) => waiter.service.getView());
  waiters.forEach((waiter) => waiter.settle());
  await Promise.all(waiters.map((waiter) => waiter.result));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, ['IAM_REAUTH_REQUIRED', 'IAM_REAUTH_REQUIRED']);
  for (let i = 0; i < waiters.length; i += 1) {
    assert.notEqual(before[i].state, 'ready');
    assert.deepEqual(waiters[i].service.getView(), before[i], 'late settlement cannot alter view');
  }
});

test('waitFor binds completion to the observed pending identity and rotation', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-wait-identity-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const original = await credentials.readRecord(RECORD_KEY);
  const marker = { version: 1, state: 'pending', id: 'A'.repeat(43), base: 'A'.repeat(43) };
  const pending = { ...original, payload: { ...original.payload, refreshOperation: marker } };
  const valid = { ...pending.payload, accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: 'rotated-test-token', refreshOperation: { ...marker, state: 'complete' } };
  await credentials.modifyRecord(RECORD_KEY, () => pending);
  for (const [name, override] of [
    ['valid', {}],
    ['unchanged refresh token', { refreshToken: pending.payload.refreshToken }],
    ['subject', { subject: 'other-subject' }],
    ['issuer', { issuer: 'https://other.corp.example' }],
    ['client', { clientId: 'other-client' }],
    ['resource', { resource: 'https://other.corp.example' }],
    ['obtainedAt', { obtainedAt: new Date(Date.parse(pending.payload.obtainedAt) + 1000).toISOString() }],
    ['expired access', { accessExpiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['version', { refreshOperation: { ...marker, version: 2, state: 'complete' } }],
    ['id', { refreshOperation: { ...marker, id: 'B'.repeat(42) + 'A', state: 'complete' } }],
    ['base', { refreshOperation: { ...marker, base: 'B'.repeat(42) + 'A', state: 'complete' } }],
  ]) {
    const provider = new FileCredentials(dir);
    const read = provider.readRecord.bind(provider);
    let count = 0;
    provider.readRecord = (key) => key === RECORD_KEY && ++count === 2
      ? Promise.resolve({ ...pending, payload: { ...valid, ...override } }) : read(key);
    const service = createIamService(config, { credentials: provider });
    const outcome = await service.resolveToken().then(() => 'accepted', (error) => error.code);
    if (name === 'valid') assert.equal(outcome, 'accepted');
    else {
      assert.notEqual(outcome, 'accepted', name);
      assert.notEqual(service.getView().state, 'ready', name);
    }
  }
});

test('a late refresh response cannot overwrite a newer login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-late-refresh-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  let entered;
  let release;
  const responseReceived = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const old = createIamService(config, { credentials, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/token')) { entered(); await gate; }
    return response;
  } });
  const refresh = old.resolveToken();
  const rejected = assert.rejects(refresh, { code: 'IAM_REAUTH_REQUIRED' });
  await responseReceived;
  const replacement = await signIn(dir, config);
  const fresh = await storedGrant(replacement);
  release();
  await rejected;
  assert.deepEqual(await storedGrant(credentials), fresh);
  assert.notEqual(old.getView().state, 'ready');
});

test('the shared store file never holds the authorization code or verifier', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-atrest-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  const raw = await readFile(join(dir, 'records.json'), 'utf8');
  const payload = JSON.parse(raw)[RECORD_KEY].payload;
  assert.equal(payload.version, 1);
  for (const forbidden of ['code', 'verifier', 'codeVerifier', 'attempt', 'nonce']) {
    assert.equal(forbidden in payload, false, `the grant record must not carry ${forbidden}`);
  }
  assert.equal(raw.includes('code_verifier'), false);
});

// These malformed successful responses are synthetic local faults, not claims
// about any vendor's refresh-token behavior.
for (const fault of ['missing', 'unchanged']) {
  test(`a ${fault} refresh token in a successful response stays pending and is never replayed`, async (t) => {
    const mock = await startMockOidc();
    t.after(() => mock.close());
    const dir = await mkdtemp(join(tmpdir(), 'iam-invalid-rotation-'));
    const config = configFor(mock);
    const credentials = await signIn(dir, config);
    await expireAccessToken(credentials);
    const before = await storedGrant(credentials);
    const beforeCount = mock.counts.token;
    let injected = false;
    const service = createIamService(config, { credentials, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url) !== config.tokenEndpoint || new URLSearchParams(init?.body).get('grant_type') !== 'refresh_token') return response;
      const payload = await response.json();
      injected = response.status === 200 && typeof payload.refresh_token === 'string'
        && payload.refresh_token !== before.refreshToken;
      if (fault === 'missing') delete payload.refresh_token;
      else payload.refresh_token = before.refreshToken;
      return new Response(JSON.stringify(payload), { status: response.status, headers: response.headers });
    } });

    const first = await service.resolveToken().then(
      (token) => ({ ok: true, returnedOldAccessToken: token === before.accessToken }),
      (error) => ({ ok: false, code: error?.code, returnedOldAccessToken: false }),
    );
    const afterFirst = await storedGrant(credentials);
    const countAfterFirst = mock.counts.token;
    const retry = await runWorker(dir, config);
    const afterRetry = await storedGrant(credentials);

    assert.deepEqual({
      injected,
      firstRequestCount: countAfterFirst - beforeCount,
      idpConsumedOldRefreshToken: !mock.refreshTokens.has(before.refreshToken),
      firstOk: first.ok,
      firstCode: first.code,
      returnedOldAccessToken: first.returnedOldAccessToken,
      firstReady: service.getView().state === 'ready',
      pendingAfterFirst: afterFirst?.refreshOperation?.state === 'pending',
      retryOk: retry.ok,
      retryCode: retry.code,
      retryReturnedToken: retry.hasToken === true,
      retryReady: retry.state === 'ready',
      additionalTokenRequests: mock.counts.token - countAfterFirst,
      pendingAfterRetry: afterRetry?.refreshOperation?.state === 'pending',
    }, {
      injected: true,
      firstRequestCount: 1,
      idpConsumedOldRefreshToken: true,
      firstOk: false,
      firstCode: 'IAM_REAUTH_REQUIRED',
      returnedOldAccessToken: false,
      firstReady: false,
      pendingAfterFirst: true,
      retryOk: false,
      retryCode: 'IAM_REAUTH_REQUIRED',
      retryReturnedToken: false,
      retryReady: false,
      additionalTokenRequests: 0,
      pendingAfterRetry: true,
    });
  });
}
