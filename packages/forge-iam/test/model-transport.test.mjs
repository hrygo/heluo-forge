import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createModelFailureLogger } from '../src/model-failure-log.mjs';
import { modelFetchOptions, modelPreconnectFault, trackModelAttempt } from '../src/model-transport.mjs';
import { createGrantStore } from '../src/store.mjs';
import { seedGateway } from './support/atomic-gateway.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

const route = { provider: 'enterprise', model: 'synthetic-model' };
const request = { ...route, messages: [{ role: 'user', content: 'sensitive-test-prompt' }] };

const socketError = (code, syscall) => Object.assign(new Error('synthetic socket failure'), { code, syscall });
const fetchError = cause => new TypeError('fetch failed', { cause });

function failFirstFetch(t, cause) {
  const directFetch = globalThis.fetch;
  let first = true;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (first) {
      first = false;
      throw fetchError(cause);
    }
    return directFetch(input, init);
  });
}

async function fixture(t, mode, { createIam, beforeFetch, afterFirstDelta } = {}) {
  let posts = 0;
  const received = [];
  const server = createServer((req, res) => {
    posts++;
    received.push({ method: req.method, url: req.url, iamToken: req.headers['x-iam-token'] });
    req.resume();
    req.on('end', () => {
      if (mode === 'reset') return res.destroy();
      if (mode === 'http-error' || mode === 'rate-limited') {
        res.writeHead(mode === 'http-error' ? 503 : 429, { 'Retry-After': '2', 'X-Test-Private': 'sensitive-test-header' });
        return res.end('sensitive-test-response');
      }
      if (mode === 'unauthorized' || mode === 'invalid-iam-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(mode === 'invalid-iam-token' ? JSON.stringify({ error: { code: 'invalid_iam_token' } }) : undefined);
      }
      if (mode === 'redirect' && req.url !== '/other') {
        res.writeHead(307, { Location: '/other' });
        return res.end();
      }
      res.end('ok');
    });
  });
  const open = async (port = 0) => { server.listen(port, '127.0.0.1'); await once(server, 'listening'); };
  const close = async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); };
  await open();
  const port = server.address().port;
  if (['recovered', 'cancelled', 'cancelled-during-backoff', 'refused', 'signed-out'].includes(mode)) await close();
  t.after(close);
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const home = mkdtempSync(join(tmpdir(), 'forge-transport-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = join(home, 'logs', 'forge-iam-model-failures.jsonl');
  const diagnoseFailure = createModelFailureLogger({ home });
  const cancel = new AbortController();
  let adapter, guard, attempts = 0, reads = 0;
  let accessToken = 'sensitive-test-token', login = 1, sdkToken, responseStatus;
  const view = { state: 'ready', principal: 'person-a', accessExpiresAt: Date.now() + 60_000,
    gatewayCredential: { state: 'configured', matchesAccount: true } };
  const config = { defaultProvider: route.provider, managedModels: { baseURL } };

  // Match the target SDK boundary. Its provider calls fetch and emits usage
  // before a terminal error whose code no longer contains the socket cause.
  const protocol = {
    async *streamSimple(model, _context, options) {
      attempts++;
      const failure = code => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'sensitive-test-sdk-error' } } });
      if (mode === 'unverified') { yield failure('TRANSPORT'); return; }
      try {
        const init = { method: 'POST', signal: options.signal, body: '{}', headers: new Headers(options.headers) };
        sdkToken = init.headers.get('X-IAM-Token');
        if (mode === 'rotate-before-fetch') accessToken = 'sensitive-test-rotated-token';
        if (mode === 'replace-before-fetch') login++;
        if (beforeFetch) await beforeFetch();
        const response = await (options.fetch ?? fetch)(`${model.baseUrl}/chat/completions`, init);
        responseStatus = response.status;
        if (!response.ok) {
          yield { type: 'usage' };
          yield failure(mode === 'invalid-iam-token' ? 'AUTH' : 'SERVER');
          return;
        }
        yield { type: 'text-delta', text: await response.text() };
        if (afterFirstDelta) {
          afterFirstDelta();
          yield { type: 'text-delta', text: 'continued' };
        }
        if (mode === 'after-output') { yield failure('TRANSPORT'); return; }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (cause) {
        if (mode === 'throw-fetch-error') throw cause;
        if (mode === 'recovered' && attempts === 1) await open(port);
        if (mode === 'cancelled') cancel.abort();
        if (mode === 'signed-out') { view.state = 'signed-out'; view.principal = null; }
        yield { type: 'usage' };
        yield failure(cause.name === 'AbortError' ? 'ABORTED' : 'TRANSPORT');
      }
    },
  };
  class PiAiAdapter {
    constructor(options) { this.options = options; }
    async prepareCall(provider, model) { return { model: { provider, id: model }, stream: options => this.stream(options) }; }
    async *stream(options) {
      const profile = this.options.profiles().get(route.provider);
      await this.options.resolveApiKey(route.provider, profile);
      yield* profile.piProvider.streamSimple(profile.piProvider.getModels()[0], {}, { signal: options.signal });
    }
  }
  const runtime = createManagedModelRuntime({
    host: {
      llm: { registerAdapter(_routes, value) { adapter = value; } }, on(_name, callback) { guard = callback; }, emit() {},
      loader: { async import(name) { return name === '@deepseek-ai/dsh-llm-pi-ai' ? { PiAiAdapter } : { openAICompletionsApi: () => protocol }; } },
    },
    iam: createIam ? await createIam(config) : {
      getView: () => view, async *watch() {},
      async readModelSelection() { return { saved: true, subject: view.principal, models: { [route.model]: {} } }; },
      async resolveGatewayConnection() { reads++; return { baseURL, key: 'sensitive-test-key', subject: view.principal }; },
      async getAccessToken() { return accessToken; },
      captureModelSession() {
        if (mode === 'missing-session') return null;
        const captured = login;
        const assertCurrent = () => {
          if (login !== captured) throw Object.assign(new Error('Session changed'), { code: 'IAM_NOT_SIGNED_IN' });
        };
        if (mode === 'missing-dispatch-access') return { assertCurrent };
        return { assertCurrent, withDispatchAccessToken(dispatch) { assertCurrent(); return dispatch(accessToken); } };
      },
    },
    config,
    fetch: async () => Response.json({ data: [{ id: route.model }] }), requestHeaders: async () => ({}),
    diagnoseFailure(event) {
      if (mode === 'cancelled-during-backoff' && event.transport?.retrying) cancel.abort();
      diagnoseFailure(event);
    },
  });
  t.after(() => runtime.dispose());
  await runtime.ready;
  const readsBeforeCall = reads;
  const call = { ...request, signal: cancel.signal, sessionId: 'sensitive-test-session' };
  const stream = mode === 'missing-session'
    ? adapter.stream
    : (await adapter.prepareCall(route.provider, route.model, call.signal)).stream;
  const chunks = await Array.fromAsync(guard(call, stream));
  return { chunks, attempts, posts, received, sdkToken, responseStatus, credentialReads: reads - readsBeforeCall, log, runtime };
}

test('uses the rotated IAM token when it changes after the SDK creates the request headers', async t => {
  const result = await fixture(t, 'rotate-before-fetch');
  assert.equal(result.sdkToken, null);
  assert.deepEqual(result.received, [
    { method: 'POST', url: '/v1/chat/completions', iamToken: 'sensitive-test-rotated-token' },
  ]);
  assert.equal(result.chunks.at(-1).reason.kind, 'stop');
});

test('an accepted stream uses the dispatch grant deadline after another Host rotates the token', async t => {
  for (const [name, elapsedAfterDispatch, shouldContinue] of [
    ['continues past the original expiry', 95_000, true],
    ['stops at the rotated grant expiry', 300_000, false],
  ]) {
    await t.test(name, async t => {
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      const oidc = await startMockOidc({ accessTtl: 300 });
      t.after(() => oidc.close());
      const credentials = new MemoryCredentials();
      const store = createGrantStore(credentials);
      const subject = 'E1001';
      const originalToken = 'synthetic-access';
      const originalDeadline = new Date(now + 90_000).toISOString();
      oidc.refreshTokens.set('synthetic-refresh', { subject });
      await store.write({
        version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
        issuer: oidc.issuer, clientId: oidc.clientId, subject, scope: 'openid',
        accessToken: originalToken, refreshToken: 'synthetic-refresh',
        obtainedAt: new Date(now).toISOString(), accessExpiresAt: originalDeadline,
        refreshExpiresAt: new Date(now + 600_000).toISOString(),
      });
      let first, second, rotated, observedDeadline;
      const result = await fixture(t, 'rotated-session', {
        async createIam(config) {
          const serviceConfig = {
            ...config, ...oidc.endpoints, clientId: oidc.clientId,
            redirectUri: 'http://127.0.0.1:4567/iam/callback',
          };
          // Seed the Key against the address and issuer this run actually uses:
          // a mismatched binding would refuse the call before the stream starts.
          seedGateway(credentials, {
            value: `uag-${'a'.repeat(32)}`, ownerSubject: subject, enteredAt: new Date(now).toISOString(),
            issuer: oidc.issuer, baseURL: config.managedModels.baseURL,
          });
          first = createIamService({ ...serviceConfig, refreshSkewSeconds: 1 }, { credentials });
          second = createIamService({ ...serviceConfig, refreshSkewSeconds: 60 }, { credentials });
          t.after(async () => { await first.dispose(); await second.dispose(); });
          await first.hydrate();
          await second.hydrate();
          await first.saveModelSelection({ models: { [route.model]: {} }, defaultModelId: route.model });
          return first;
        },
        async beforeFetch() {
          t.mock.timers.tick(45_000);
          await second.getAccessToken();
          rotated = (await store.read()).grant;
          observedDeadline = first.getView().accessExpiresAt;
        },
        afterFirstDelta() {
          t.mock.timers.tick(elapsedAfterDispatch);
        },
      });

      assert.equal(observedDeadline, originalDeadline);
      assert.equal(rotated.accessExpiresAt, new Date(now + 345_000).toISOString());
      assert.equal(oidc.counts.token, 1);
      assert.equal(oidc.counts.refresh, 1);
      assert.equal(result.sdkToken, null);
      assert.notEqual(rotated.accessToken, originalToken);
      assert.deepEqual(result.received, [
        { method: 'POST', url: '/v1/chat/completions', iamToken: rotated.accessToken },
      ]);
      assert.equal(result.responseStatus, 200);
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.chunks[0], { type: 'text-delta', text: 'ok' });
      if (shouldContinue) {
        assert.deepEqual(result.chunks.slice(1), [
          { type: 'text-delta', text: 'continued' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
        assert.equal(first.getView().accessExpiresAt, rotated.accessExpiresAt);
      } else {
        assert.equal(result.chunks.length, 2);
        assert.equal(result.chunks.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
      }
    });
  }
});

test('sends no POST when the same principal replaces the login after the SDK creates the request headers', async t => {
  const result = await fixture(t, 'replace-before-fetch');
  assert.equal(result.sdkToken, null);
  assert.equal(result.posts, 0);
  assert.equal(result.chunks.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
});

test('native calls with session capture require a session and its dispatch context', async t => {
  for (const mode of ['missing-session', 'missing-dispatch-access']) {
    await t.test(mode, async t => {
      const result = await fixture(t, mode);
      assert.equal(result.posts, 0);
      assert.equal(result.chunks.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
    });
  }
});

test('a gateway rejection of the IAM token requires login and sends exactly one model request', async t => {
  const result = await fixture(t, 'invalid-iam-token');
  assert.equal(result.responseStatus, 401);
  assert.equal(result.attempts, 1);
  assert.equal(result.posts, 1);
  assert.equal(result.chunks.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED');
  assert.deepEqual(JSON.parse(readFileSync(result.log, 'utf8')).transport,
    { phase: 'response', status: 401, output: false, retrying: false });
});

test('retries once only after a verified refusal to connect, with fresh credential checks', async t => {
  const result = await fixture(t, 'recovered');
  assert.equal(result.attempts, 2);
  assert.equal(result.posts, 1);
  assert.equal(result.credentialReads, 2);
  assert.deepEqual(result.chunks.map(chunk => chunk.type), ['text-delta', 'finish']);
  assert.equal(result.chunks.at(-1).reason.kind, 'stop');
  const diagnostics = readFileSync(result.log, 'utf8');
  assert.doesNotMatch(diagnostics, /sensitive-test|127\.0\.0\.1/);
  const rows = diagnostics.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detailCode, 'TRANSPORT');
  assert.deepEqual(rows[0].transport, { phase: 'before-send', fault: 'ECONNREFUSED', output: false, retrying: true });
});

test('retries DNS and connect failures only when the original POST could not have been sent', async t => {
  for (const [name, mode, cause, fault] of [
    ['temporary DNS failure', 'sdk-error', socketError('EAI_AGAIN', 'getaddrinfo'), 'EAI_AGAIN'],
    ['TCP connect timeout', 'sdk-error', socketError('ETIMEDOUT', 'connect'), 'ETIMEDOUT'],
    ['Undici connect timeout', 'sdk-error', socketError('UND_ERR_CONNECT_TIMEOUT'), 'UND_ERR_CONNECT_TIMEOUT'],
    ['all addresses failed to connect', 'throw-fetch-error', new AggregateError([
      socketError('ETIMEDOUT', 'connect'),
      socketError('ECONNREFUSED', 'connect'),
    ]), 'ETIMEDOUT'],
  ]) {
    await t.test(name, async t => {
      failFirstFetch(t, cause);
      const result = await fixture(t, mode);
      assert.equal(result.attempts, 2);
      assert.equal(result.posts, 1);
      assert.equal(result.credentialReads, 2);
      assert.deepEqual(result.chunks, [
        { type: 'text-delta', text: 'ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]);
      assert.deepEqual(JSON.parse(readFileSync(result.log, 'utf8')).transport,
        { phase: 'before-send', fault, output: false, retrying: true });
    });
  }
});

test('requires specific DNS and connect evidence for each failure', async t => {
  for (const [name, cause, fault] of [
    ['permanent DNS failure', socketError('ENOTFOUND', 'getaddrinfo'), 'ENOTFOUND'],
    ['DNS phase missing', socketError('EAI_AGAIN'), 'EAI_AGAIN'],
    ['read timeout', socketError('ETIMEDOUT', 'read'), 'ETIMEDOUT'],
    ['an address has unknown delivery', new AggregateError([
      socketError('ECONNREFUSED', 'connect'),
      socketError('UND_ERR_SOCKET'),
    ]), undefined],
    ['no address failures in the aggregate', new AggregateError([]), undefined],
  ]) {
    await t.test(name, async t => {
      failFirstFetch(t, cause);
      const result = await fixture(t, 'sdk-error');
      assert.equal(result.attempts, 1);
      assert.equal(result.posts, 0);
      assert.equal(result.chunks.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
      const { transport } = JSON.parse(readFileSync(result.log, 'utf8'));
      assert.equal(transport.phase, 'unknown');
      assert.equal(transport.fault, fault);
      assert.equal(transport.retrying, false);
    });
  }
});

test('cannot prove a pre-send failure on a caller-supplied transport or a different endpoint', async t => {
  const baseURL = 'https://gateway.example/v1';
  const endpoint = `${baseURL}/chat/completions`;
  const cause = fetchError(socketError('ECONNREFUSED', 'connect'));
  const rejectFetch = async () => { throw cause; };
  t.mock.method(globalThis, 'fetch', rejectFetch);
  for (const [input, init, options, expected] of [
    [endpoint, { method: 'POST' }, { fetch: rejectFetch }, TypeError],
    [endpoint, { method: 'POST', dispatcher: {} }, {}, TypeError],
    [new Request(endpoint, { method: 'POST' }), {}, {}, TypeError],
    [`${baseURL}/other`, { method: 'POST' }, {}, { code: 'IAM_MODEL_CONTEXT_CHANGED' }],
  ]) {
    const attempt = { calls: 0, check() {} };
    async function* dispatch() {
      await modelFetchOptions(options, baseURL, () => 'synthetic-iam-token').fetch(input, init);
    }
    await assert.rejects(trackModelAttempt(dispatch, attempt).next(), expected);
    assert.equal(attempt.calls, expected === TypeError ? 1 : 0);
    assert.equal(modelPreconnectFault(attempt), undefined);
  }
});

test('does not replay ambiguous delivery, HTTP failure, output or cancellation', async t => {
  for (const [mode, phase, extras] of [
    ['reset', 'unknown', { fault: 'UND_ERR_SOCKET' }],
    ['http-error', 'response', { status: 503, retryAfterMs: 2000 }],
    ['rate-limited', 'response', { status: 429, retryAfterMs: 2000 }],
    ['unauthorized', 'response', { status: 401 }],
    ['redirect', 'response', { status: 307 }],
    ['after-output', 'response', { status: 200, output: true }],
  ]) {
    await t.test(mode, async t => {
      const result = await fixture(t, mode);
      assert.equal(result.attempts, 1);
      assert.equal(result.posts, 1);
      assert.equal(result.runtime.getView().state, 'ready');
      assert.equal(result.chunks.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
      const text = readFileSync(result.log, 'utf8');
      assert.doesNotMatch(text, /sensitive-test|127\.0\.0\.1/);
      assert.deepEqual(JSON.parse(text).transport, { phase, output: false, retrying: false, ...extras });
    });
  }
  const cancelled = await fixture(t, 'cancelled');
  assert.equal(cancelled.attempts, 1);
  assert.equal(cancelled.posts, 0);
  assert.equal(cancelled.chunks.at(-1).reason.kind, 'aborted');
  const duringBackoff = await fixture(t, 'cancelled-during-backoff');
  assert.equal(duringBackoff.attempts, 1);
  assert.equal(duringBackoff.posts, 0);
  assert.equal(duringBackoff.chunks.at(-1).reason.kind, 'aborted');
  const signedOut = await fixture(t, 'signed-out');
  assert.equal(signedOut.attempts, 1);
  assert.equal(signedOut.posts, 0);
  assert.equal(signedOut.chunks.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
  const unverified = await fixture(t, 'unverified');
  assert.equal(unverified.attempts, 1);
  assert.equal(unverified.posts, 0);
  assert.equal(JSON.parse(readFileSync(unverified.log, 'utf8')).transport, undefined);
});

test('exhausts the transport retry budget after two refusals to connect', async t => {
  const result = await fixture(t, 'refused');
  assert.equal(result.attempts, 2);
  assert.equal(result.posts, 0);
  assert.equal(result.chunks.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
  const rows = readFileSync(result.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.transport.retrying), [true, false]);
});
