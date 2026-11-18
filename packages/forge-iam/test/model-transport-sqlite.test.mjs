import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';

const request = { provider: 'enterprise', model: 'synthetic-model', messages: [{ role: 'user', content: 'synthetic prompt' }] };
const issuer = 'https://iam.corp.example';
const clientId = 'synthetic-dsh';
const firstDelta = { type: 'text-delta', text: 'first' };
const successorAccessToken = 'synthetic-second-access';
const iso = (time) => new Date(time).toISOString();

async function fixture(t, { renewalHost } = {}) {
  const start = Date.now();
  const originalDeadline = start + (renewalHost ? 7_200_000 : 90_000);
  const grant = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer, clientId, subject: 'synthetic-user', scope: 'openid',
    accessToken: 'synthetic-first-access', refreshToken: 'synthetic-first-refresh',
    obtainedAt: iso(start), accessExpiresAt: iso(originalDeadline),
    refreshExpiresAt: iso(start + (renewalHost ? 7_300_000 : 600_000)),
  };
  const directory = await mkdtemp(join(tmpdir(), 'forge-stream-sqlite-'));
  const owners = [];
  const requests = [];
  const responses = [];
  const closed = Promise.withResolvers();
  const refreshRequested = Promise.withResolvers();
  const releaseRefresh = Promise.withResolvers();
  const revocationRequested = Promise.withResolvers();
  const releaseRevocation = Promise.withResolvers();
  let holdRevocation = false;
  let runtime;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, accessToken: req.headers['x-iam-token'] });
    req.resume();
    req.once('end', () => {
      if (holdRevocation) {
        holdRevocation = false;
        revocationRequested.resolve();
        void releaseRevocation.promise.then(() => {
          if (res.destroyed) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'credential_revoked', message: 'synthetic credential revoked' } }));
        });
        return;
      }
      if (!responses.length) res.once('close', closed.resolve);
      responses.push(res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first\n');
    });
  });
  t.after(async () => {
    releaseRefresh.resolve();
    releaseRevocation.resolve();
    await runtime?.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const { service, credentials } of owners) {
      await service.dispose();
      await credentials.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const config = {
    issuer, clientId, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`, revocationEndpoint: `${issuer}/revoke`,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    defaultProvider: request.provider, managedModels: { baseURL },
  };
  function openHost(refreshSkewSeconds, fetch, onWrite) {
    const backend = createCredentialStore({ directory: join(directory, 'credentials') });
    const credentials = createKeychainProvider(backend, { notifyRecord: onWrite, notifyReference: onWrite });
    const joint = createJointStore(backend, namespacePrefixes());
    const service = createIamService({ ...config, refreshSkewSeconds }, {
      credentials, fetch, monotonic: () => Date.now(),
      verifyAtomicStore: (candidate) => candidate === credentials,
      getGatewayAtomicStore: (candidate) => candidate === credentials ? joint : undefined,
      verifyGatewayAtomicStore: (candidate, adapter) => candidate === credentials && adapter === joint,
    });
    const owner = { credentials, service };
    owners.push(owner);
    return owner;
  }
  const iamCalls = { first: [], second: [] };
  let dropRefresh = false;
  const oidc = (calls) => async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/jwks') return Response.json({ keys: [] });
    if (path === '/token') {
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), grant.refreshToken);
      if (dropRefresh) throw new TypeError('synthetic lost refresh response');
      if (renewalHost) {
        refreshRequested.resolve();
        await releaseRefresh.promise;
      }
      return Response.json({
        access_token: successorAccessToken, refresh_token: 'synthetic-second-refresh',
        // The successor AT remains usable when its RT has lapsed. This keeps
        // background renewal from moving the second cutoff under test.
        token_type: 'Bearer', expires_in: 120, refresh_expires_in: 30,
      });
    }
    assert.equal(path, '/revoke');
    return Response.json({ result: true });
  };
  const writes = [];
  const first = openHost(0, oidc(iamCalls.first), (key) => writes.push(key));
  const second = renewalHost === 'first' ? null : openHost(60, oidc(iamCalls.second));
  const firstStore = createGrantStore(first.credentials);
  const secondStore = second ? createGrantStore(second.credentials) : firstStore;
  if (renewalHost) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  await firstStore.write(grant);
  if (renewalHost === 'second') {
    await second.service.hydrate();
    // The observer's own scheduled renewal is later than the renewing Host's.
    t.mock.timers.tick(60_000);
  }
  await first.service.hydrate();
  await first.service.saveGatewayCredential({ key: `uag-${'a'.repeat(32)}` });
  await first.service.saveModelSelection({ models: { [request.model]: {} }, defaultModelId: request.model });
  if (!renewalHost) {
    await second.service.hydrate();
    // Keep the existing background timers on the real clock so idle cutoff
    // tests exercise the stream watchdog without a coincidental refresh.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  }
  let attempts = 0;
  const dispatchAttempt = new AsyncLocalStorage();
  const protocol = {
    async *streamSimple(model, _context, options) {
      attempts++;
      const res = await dispatchAttempt.run(attempts, () => (options.fetch ?? fetch)(`${model.baseUrl}/chat/completions`, {
        method: 'POST', signal: options.signal, headers: options.headers, body: '{}',
      }));
      if (!res.ok) {
        await res.text();
        // The real DSH adapter flattens this response to a generic AUTH error.
        yield { type: 'finish', reason: { kind: 'error', failure: { status: res.status, code: 'AUTH' } } };
        return;
      }
      let tail = '';
      for await (const fragment of res.body.pipeThrough(new TextDecoderStream())) {
        const lines = (tail + fragment).split('\n');
        tail = lines.pop();
        for (const text of lines) yield { type: 'text-delta', text };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  class PiAiAdapter {
    constructor(options) { this.options = options; }
    async *stream(options) {
      const profile = this.options.profiles().get(request.provider);
      await this.options.resolveApiKey(request.provider, profile);
      yield* profile.piProvider.streamSimple(profile.piProvider.getModels()[0], {}, { signal: options.signal });
    }
  }
  let adapter;
  let guard;
  runtime = createManagedModelRuntime({
    host: {
      llm: { registerAdapter(_routes, value) { adapter = value; } },
      on(_name, callback) { guard = callback; },
      emit() {},
      loader: { async import(name) { return name === '@deepseek-ai/dsh-llm-pi-ai' ? { PiAiAdapter } : { openAICompletionsApi: () => protocol }; } },
    },
    iam: first.service, config, requestHeaders: async () => ({}),
    fetch: async () => Response.json({ data: [{ id: request.model }] }),
  });
  await runtime.ready;
  if (renewalHost) t.mock.timers.tick(start + 3_599_000 - Date.now());
  const openStream = () => guard(request, (options) => adapter.stream(options))[Symbol.asyncIterator]();
  const stream = openStream();
  assert.deepEqual((await stream.next()).value, firstDelta);
  writes.length = 0;

  const pendingReads = new Set();
  let readCount = 0;
  let holdRead;
  const readRecord = first.credentials.readRecord.bind(first.credentials);
  t.mock.method(first.credentials, 'readRecord', async (key) => {
    if (key !== GRANT_KEY) return readRecord(key);
    readCount++;
    const read = readRecord(key);
    pendingReads.add(read);
    try {
      const record = await read;
      if (holdRead) await holdRead(record, dispatchAttempt.getStore());
      return record;
    } finally {
      pendingReads.delete(read);
    }
  });
  async function advance(time) {
    t.mock.timers.tick(time - Date.now());
    await nextTurn();
    await Promise.all(pendingReads);
    await nextTurn();
  }
  async function approach(deadline) {
    // Release completed SQLite reads before moving the watchdog to the next time.
    await advance(deadline - 1_000);
    for (let remaining = 900; remaining >= 100; remaining -= 100) await advance(deadline - remaining);
    await advance(deadline - 1);
  }
  return {
    first, second, secondStore, grant, start, originalDeadline, iamCalls, writes, requests,
    stream, openStream, closed: closed.promise, advance, approach,
    refreshRequested: refreshRequested.promise, releaseRefresh: releaseRefresh.resolve,
    holdGatewayRevocation() { holdRevocation = true; return revocationRequested.promise; },
    releaseGatewayRevocation: releaseRevocation.resolve,
    push(text, index = 0) { responses[index].write(`${text}\n`); },
    end(index = 0) { responses[index].end(); },
    get attempts() { return attempts; },
    get reads() { return readCount; },
    dropRefreshResponse() { dropRefresh = true; },
    pauseRead(callback) { holdRead = callback; },
  };
}

function assertSingleDispatch(f) {
  assert.deepEqual(f.requests, [{
    method: 'POST', url: '/v1/chat/completions', accessToken: f.grant.accessToken,
  }]);
  assert.equal(f.attempts, 1);
  assert.deepEqual(f.iamCalls.first, []);
  assert.deepEqual(f.writes, []);
}

async function assertIdleCutoff(f, deadline, waiting) {
  await f.advance(deadline);
  assert.equal((await waiting).value.reason.failure.code, 'IAM_LOGIN_REQUIRED');
  assert.equal((await f.stream.next()).done, true);
  await f.closed;
  assert.equal(Date.now(), deadline);
}

for (const activity of ['an idle gap', 'continuing output']) {
  test(`a SQLite model POST with ${activity} survives the original expiry after another Host rotates`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    let continued = f.stream.next();
    await f.advance(f.start + 45_000);
    assert.equal(await f.second.service.getAccessToken(), 'synthetic-second-access');
    await f.second.service.dispose();
    const successor = (await f.secondStore.read()).grant;
    assert.equal(successor.refreshOperation.state, 'complete');
    assert.equal(successor.sessionInstanceId, f.grant.sessionInstanceId);
    assert.equal(f.first.service.getView().accessExpiresAt, f.grant.accessExpiresAt);
    assert.equal(f.reads, 0, 'the idle stream does not poll between cutoffs');
    const successorDeadline = Date.parse(successor.accessExpiresAt);
    assert.equal(successorDeadline, f.start + 165_000);
    assert.equal(Date.parse(successor.refreshExpiresAt), f.start + 75_000);

    if (activity === 'continuing output') {
      await f.advance(f.originalDeadline - 1001);
      f.push('before original expiry');
      assert.deepEqual((await continued).value, { type: 'text-delta', text: 'before original expiry' });
      continued = f.stream.next();
    }
    const readsBeforeCutoff = f.reads;
    await f.approach(f.originalDeadline);
    await f.advance(f.originalDeadline + 1);
    assertSingleDispatch(f);
    const cutoffReads = f.reads - readsBeforeCutoff;
    assert.ok(cutoffReads >= 1 && cutoffReads <= 2, 'the first cutoff uses bounded shared-store reads');
    f.push('after original expiry');
    assert.deepEqual((await continued).value, { type: 'text-delta', text: 'after original expiry' });

    const finalDelta = f.stream.next();
    await f.approach(successorDeadline);
    f.push('before successor expiry');
    assert.deepEqual((await finalDelta).value, { type: 'text-delta', text: 'before successor expiry' });
    await assertIdleCutoff(f, successorDeadline, f.stream.next());
    assertSingleDispatch(f);
    assert.deepEqual(f.iamCalls.second, ['/jwks', '/token']);
    assert.deepEqual((await f.secondStore.read()).grant, successor);
  });
}

const invalidContinuations = [
  {
    name: 'the grant has no successor',
    iamCalls: [],
    async arrange(f) {
      assert.deepEqual((await f.secondStore.read()).grant, f.grant);
    },
  },
  {
    name: 'a refresh is still pending',
    iamCalls: ['/jwks', '/token'],
    async arrange(f) {
      f.dropRefreshResponse();
      await assert.rejects(f.second.service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
      assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'pending');
    },
  },
  {
    name: 'the rotation receipt refers to another baseline',
    iamCalls: ['/jwks', '/token'],
    async arrange(f) {
      assert.equal(await f.second.service.getAccessToken(), 'synthetic-second-access');
      const latest = (await f.secondStore.read()).grant;
      const wrongBase = Buffer.alloc(32, 19).toString('base64url');
      assert.notEqual(latest.refreshOperation.base, wrongBase);
      await f.secondStore.write({ ...latest, refreshOperation: { ...latest.refreshOperation, base: wrongBase } });
    },
  },
  {
    name: 'the same principal starts a different login',
    iamCalls: [],
    async arrange(f) {
      await f.secondStore.write({
        ...f.grant, sessionInstanceId: Buffer.alloc(32, 23).toString('base64url'),
        accessToken: 'synthetic-replacement-access', refreshToken: 'synthetic-replacement-refresh',
        obtainedAt: iso(Date.now()), accessExpiresAt: iso(f.start + 165_000),
      });
    },
  },
  {
    name: 'the other Host signs out',
    iamCalls: ['/revoke'],
    async arrange(f) {
      const result = await f.second.service.signOut();
      assert.equal(result.view.state, 'signed-out');
      assert.equal(result.revocation, 'ok');
      assert.equal((await f.secondStore.read()).grant, null);
    },
  },
];

for (const scenario of invalidContinuations) {
  test(`an idle SQLite model POST stops by the original cutoff when ${scenario.name}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const waiting = f.stream.next();
    await f.advance(f.start + 45_000);
    await scenario.arrange(f);
    await f.second.service.dispose();
    const shared = await f.second.credentials.readRecord(GRANT_KEY);
    await f.approach(f.originalDeadline);
    await assertIdleCutoff(f, f.originalDeadline, waiting);
    assertSingleDispatch(f);
    assert.deepEqual(f.iamCalls.second, scenario.iamCalls);
    assert.deepEqual(await f.second.credentials.readRecord(GRANT_KEY), shared);
  });
}

test('a SQLite continuity read still pending at cutoff cannot keep the POST open or revive it', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const waiting = f.stream.next();
  await f.advance(f.start + 45_000);
  assert.equal(await f.second.service.getAccessToken(), 'synthetic-second-access');
  await f.second.service.dispose();
  const successor = (await f.secondStore.read()).grant;
  const release = Promise.withResolvers();
  f.pauseRead(() => release.promise);
  try {
    await f.approach(f.originalDeadline);
    assert.equal(f.reads, 1, 'only one SQLite read is outstanding');
    await assertIdleCutoff(f, f.originalDeadline, waiting);
  } finally {
    release.resolve();
    await nextTurn();
  }
  assertSingleDispatch(f);
  assert.equal((await f.stream.next()).done, true);
  assert.notEqual(f.first.service.getView().accessExpiresAt, successor.accessExpiresAt);
  assert.deepEqual(f.iamCalls.second, ['/jwks', '/token']);
  assert.deepEqual((await f.secondStore.read()).grant, successor);
});

async function startHalfLifeRefresh(f, { syncObserver = true } = {}) {
  assert.deepEqual(f.iamCalls, { first: [], second: [] });
  await f.advance(f.start + 3_600_000);
  await f.refreshRequested;
  const pending = (await f.secondStore.read()).grant;
  assert.equal(pending.refreshOperation.state, 'pending');
  assert.equal(pending.sessionInstanceId, f.grant.sessionInstanceId);
  assert.ok(Date.parse(pending.accessExpiresAt) > Date.now());
  if (f.second && syncObserver) await f.first.service.syncFromStore();
  return pending;
}

function observeNext(stream) {
  const next = { settled: false };
  next.promise = stream.next().then(
    (result) => { next.settled = true; return { result }; },
    (error) => { next.settled = true; return { error }; },
  );
  return next;
}

async function settleDuring(f, time, ...observations) {
  const cutoff = Date.now() + time;
  while (Date.now() < cutoff && observations.some((next) => !next.settled)) {
    await delay(10);
    await f.advance(Math.min(cutoff, Date.now() + 100));
  }
  assert.ok(observations.every((next) => next.settled), `model action did not settle within ${time} ms`);
}

async function expectFailure(next, code) {
  const { result, error } = await next.promise;
  assert.ifError(error);
  assert.equal(result.value.type, 'finish');
  assert.equal(result.value.reason.kind, 'error');
  assert.equal(result.value.reason.failure.code, code);
}

for (const [renewalHost, scenario] of [['first', 'single Host'], ['second', 'dual Host']]) {
  test(`a ${scenario} SQLite model POST survives pending half-life renewal on the same HTTP stream`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { renewalHost });
    const pending = await startHalfLifeRefresh(f);
    const nextDelta = observeNext(f.stream);
    f.push('queued during renewal');
    const newStream = f.openStream();
    const waiting = observeNext(newStream);
    // Allow the loopback chunk and shared-store reads to reach the guard.
    await delay(30);
    assert.equal(nextDelta.settled, false, 'accepted stream pauses output while the refresh is pending');
    assert.equal(waiting.settled, false, 'new call waits for a verified successor');
    assert.equal(f.requests.length, 1, 'no new model POST reaches the gateway during pending');
    assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'pending');

    f.releaseRefresh();
    await settleDuring(f, 5_000, nextDelta, waiting);
    assert.deepEqual(await nextDelta.promise, {
      result: { done: false, value: { type: 'text-delta', text: 'queued during renewal' } },
    });
    assert.deepEqual(await waiting.promise, { result: { done: false, value: firstDelta } });
    const successor = (await f.secondStore.read()).grant;
    assert.equal(successor.refreshOperation.state, 'complete');
    assert.equal(successor.refreshOperation.id, pending.refreshOperation.id);
    assert.equal(successor.sessionInstanceId, f.grant.sessionInstanceId);
    assert.equal(successor.accessToken, successorAccessToken);
    f.end();
    f.end(1);
    for (const stream of [f.stream, newStream]) {
      assert.equal((await stream.next()).value.reason.kind, 'stop');
      assert.equal((await stream.next()).done, true);
    }
    assert.deepEqual(f.requests, [f.grant.accessToken, successorAccessToken].map((accessToken) => ({
      method: 'POST', url: '/v1/chat/completions', accessToken,
    })));
    assert.deepEqual(f.iamCalls[renewalHost], ['/jwks', '/token']);
    assert.deepEqual(f.iamCalls[renewalHost === 'first' ? 'second' : 'first'], []);
  });
}

test('dual Host model output detects a pending rotation without a separate view refresh or model call', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'second' });
  const pending = await startHalfLifeRefresh(f, { syncObserver: false });
  assert.equal(f.reads, 0, 'the idle stream has not checked the shared grant');
  const observedPending = Promise.withResolvers();
  f.pauseRead((record) => {
    if (record?.payload?.refreshOperation?.state === 'pending') observedPending.resolve(record.payload);
  });
  const nextDelta = observeNext(f.stream);
  f.push('detected during output');
  assert.deepEqual(await Promise.race([observedPending.promise, nextDelta.promise]), pending);
  await nextTurn();
  assert.equal(nextDelta.settled, false, 'output waits after reading the pending grant');
  assertSingleDispatch(f);

  f.releaseRefresh();
  await settleDuring(f, 5_000, nextDelta);
  assert.deepEqual(await nextDelta.promise, {
    result: { done: false, value: { type: 'text-delta', text: 'detected during output' } },
  });
  f.end();
  assert.equal((await f.stream.next()).value.reason.kind, 'stop');
  assert.equal((await f.stream.next()).done, true);
  assertSingleDispatch(f);
  assert.deepEqual(f.iamCalls.second, ['/jwks', '/token']);
});

test('pending half-life renewal bounds a new model call to five seconds without dispatching', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'second' });
  await startHalfLifeRefresh(f);
  const newStream = f.openStream();
  const waiting = observeNext(newStream);
  await delay(30);
  assert.equal(waiting.settled, false);
  await settleDuring(f, 5_000, waiting);
  await expectFailure(waiting, 'ENTERPRISE_IAM_RENEWAL_UNCONFIRMED');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'pending');
  f.releaseRefresh();
  // Join the renewing Host's flight while it consumes the overdue answer.
  // The model call stays finished regardless of that flight's outcome.
  await Promise.allSettled([f.second.service.getAccessToken()]);
  await f.advance(Date.now() + 100);
  assert.equal((await newStream.next()).done, true);
  assert.deepEqual(f.iamCalls, { first: [], second: ['/jwks', '/token'] });
  assert.equal(f.requests.length, 1, 'a late IAM response cannot send a model call that timed out');
});

test('a final dispatch read past the pending renewal budget cannot send a model POST', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'second' });
  const pending = await startHalfLifeRefresh(f);
  const held = { settled: false };
  const releaseRead = Promise.withResolvers();
  const drained = Promise.withResolvers();
  f.pauseRead(async (record, attempt) => {
    const grant = record?.payload;
    if (attempt !== 2 || grant?.refreshOperation?.state !== 'complete'
      || f.first.service.getView().accessExpiresAt !== grant.accessExpiresAt) return;
    held.grant = grant;
    held.settled = true;
    await releaseRead.promise;
    drained.resolve();
  });
  const newStream = f.openStream();
  const waiting = observeNext(newStream);
  const deadline = Date.now() + 5_000;
  try {
    await delay(30);
    await f.advance(Date.now() + 2_000);
    assert.equal(waiting.settled, false);
    f.releaseRefresh();
    await settleDuring(f, 2_000, held);
    assert.equal(held.grant.refreshOperation.id, pending.refreshOperation.id);
    assert.equal(held.grant.accessToken, successorAccessToken);
    assert.equal(waiting.settled, false, 'the verified successor still needs a final durable read');
    assert.equal(f.requests.length, 1);

    await settleDuring(f, deadline - Date.now(), waiting);
    await expectFailure(waiting, 'ENTERPRISE_IAM_RENEWAL_UNCONFIRMED');
    assert.equal((await newStream.next()).done, true);
    assert.equal(f.requests.length, 1);
  } finally {
    releaseRead.resolve();
  }
  await drained.promise;
  await nextTurn();
  assert.equal(f.requests.length, 1, 'the completed read cannot send after timeout');
  assert.deepEqual(f.iamCalls, { first: [], second: ['/jwks', '/token'] });
});

test('local sign-out fences a pending renewal before the held IAM response arrives', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'first' });
  await startHalfLifeRefresh(f);
  const original = observeNext(f.stream);
  f.push('queued before sign-out');
  const newStream = f.openStream();
  const waiting = observeNext(newStream);
  await delay(30);
  assert.equal(original.settled, false);
  assert.equal(waiting.settled, false);

  const logout = f.first.service.signOut();
  await settleDuring(f, 1_000, original, waiting);
  await expectFailure(original, 'IAM_LOGIN_REQUIRED');
  await expectFailure(waiting, 'IAM_LOGIN_REQUIRED');
  await f.closed;
  assert.equal((await f.stream.next()).done, true);
  assert.equal((await newStream.next()).done, true);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'pending');
  f.releaseRefresh();
  const result = await logout;
  assert.equal(result.view.state, 'signed-out');
  assert.equal((await f.secondStore.read()).grant, null);
  assert.equal(f.requests.length, 1);
});

test('observed gateway revocation fences accepted and waiting model calls during pending renewal', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'first' });
  const revocationRequested = f.holdGatewayRevocation();
  const reportingStream = f.openStream();
  const reporting = observeNext(reportingStream);
  await Promise.race([revocationRequested, reporting.promise.then(() => { throw new Error('reporting request ended before the gateway could respond'); })]);
  await startHalfLifeRefresh(f);
  const original = observeNext(f.stream);
  f.push('queued before revocation');
  const newStream = f.openStream();
  const waiting = observeNext(newStream);
  await delay(30);
  assert.equal(original.settled, false);
  assert.equal(waiting.settled, false);

  f.releaseGatewayRevocation();
  await settleDuring(f, 1_000, reporting, original, waiting);
  for (const next of [reporting, original, waiting]) {
    await expectFailure(next, 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
  }
  await f.closed;
  for (const stream of [reportingStream, f.stream, newStream]) assert.equal((await stream.next()).done, true);
  assert.deepEqual(f.requests.map(({ accessToken }) => accessToken), [f.grant.accessToken, f.grant.accessToken]);
  assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'pending');
});

test('a model call waiting on renewal rechecks the shared gateway credential before dispatch', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { renewalHost: 'second' });
  await startHalfLifeRefresh(f);
  const newStream = f.openStream();
  const waiting = observeNext(newStream);
  await delay(30);
  assert.equal(waiting.settled, false);
  await f.second.service.clearGatewayCredential();
  assert.equal(f.first.service.getView().gatewayCredential.state, 'configured', 'the serving Host still has its earlier view');
  f.releaseRefresh();
  await settleDuring(f, 5_000, waiting);
  await expectFailure(waiting, 'IAM_GATEWAY_CREDENTIAL_REQUIRED');
  assert.equal((await newStream.next()).done, true);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.secondStore.read()).grant.refreshOperation.state, 'complete');
});
