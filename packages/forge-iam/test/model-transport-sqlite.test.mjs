import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';

const request = { provider: 'enterprise', model: 'synthetic-model', messages: [{ role: 'user', content: 'synthetic prompt' }] };
const issuer = 'https://iam.corp.example';
const clientId = 'synthetic-dsh';
const firstDelta = { type: 'text-delta', text: 'first' };
const iso = (time) => new Date(time).toISOString();

async function fixture(t) {
  const start = Date.now();
  const originalDeadline = start + 90_000;
  const grant = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer, clientId, subject: 'synthetic-user', scope: 'openid',
    accessToken: 'synthetic-first-access', refreshToken: 'synthetic-first-refresh',
    obtainedAt: iso(start), accessExpiresAt: iso(originalDeadline),
    refreshExpiresAt: iso(start + 600_000),
  };
  const directory = await mkdtemp(join(tmpdir(), 'forge-stream-sqlite-'));
  const owners = [];
  const requests = [];
  const closed = Promise.withResolvers();
  let runtime;
  let response;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, accessToken: req.headers['x-iam-token'] });
    req.resume();
    req.once('end', () => {
      response = res;
      res.once('close', closed.resolve);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first\n');
    });
  });
  t.after(async () => {
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
      return Response.json({
        access_token: 'synthetic-second-access', refresh_token: 'synthetic-second-refresh',
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
  const second = openHost(60, oidc(iamCalls.second));
  const firstStore = createGrantStore(first.credentials);
  const secondStore = createGrantStore(second.credentials);
  await firstStore.write(grant);
  await first.service.hydrate();
  await first.service.saveGatewayCredential({ key: `uag-${'a'.repeat(32)}` });
  await first.service.saveModelSelection({ models: { [request.model]: {} }, defaultModelId: request.model });
  await second.service.hydrate();

  // Keep the hosts' pre-existing background renewal timers on the real clock.
  // The stream watchdog runs on virtual time, so it cannot succeed because a
  // scheduled refresh in the serving Host happened to observe the other Host.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let attempts = 0;
  const protocol = {
    async *streamSimple(model, _context, options) {
      attempts++;
      const res = await (options.fetch ?? fetch)(`${model.baseUrl}/chat/completions`, {
        method: 'POST', signal: options.signal, headers: options.headers, body: '{}',
      });
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
  const stream = guard(request, (options) => adapter.stream(options))[Symbol.asyncIterator]();
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
      if (holdRead) await holdRead();
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
    stream, closed: closed.promise, advance, approach,
    push(text) { response.write(`${text}\n`); },
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
    await f.approach(f.originalDeadline);
    await f.advance(f.originalDeadline + 1);
    assertSingleDispatch(f);
    f.push('after original expiry');
    assert.deepEqual((await continued).value, { type: 'text-delta', text: 'after original expiry' });
    assert.ok(f.reads >= 1 && f.reads <= 2, 'the first cutoff uses bounded shared-store reads');

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
