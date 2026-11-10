import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { apply } from '../src/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import {
  createCallbackManager, createCallbackRequestHandler, isLoopbackAddress, loopbackOrigin,
  rejectNonLoopbackPeer, startCallbackListener,
} from '../src/callback-listener.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function configFor(mock, overrides = {}) {
  return {
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

function send(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // A fresh socket per call: a pooled keep-alive socket would report the
    // server's close as a hang-up instead of the refused connect we assert.
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const refused = (error) => ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code);

/** A service whose callback listener is owned by a manager, as apply() wires it. */
function loopbackService(config, { managerOptions = {} } = {}) {
  let manager;
  const service = createIamService(config, {
    credentials: new MemoryCredentials(),
    // Deliberately a different origin: the loopback listener must win.
    getOrigin: () => 'http://127.0.0.1:9',
    openCallback: () => manager.ensure(),
    closeCallback: () => manager.release(),
    getCallbackOrigin: () => manager.origin,
  });
  manager = createCallbackManager({
    port: config.callbackPort,
    address: config.callbackAddress,
    path: config.redirectPath,
    handler: createIamRoutes(service, {
      callbackPath: config.redirectPath,
      getOrigin: () => manager.origin,
    }),
    ...managerOptions,
  });
  return { service, manager };
}

test('callbackPort: 0 binds an OS-assigned loopback port for the attempt', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  assert.equal(manager.origin, undefined, 'nothing listens before a sign-in');
  const started = await service.startSignIn();
  const redirect = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/iam\/callback$/);
  assert.equal(redirect, `${manager.origin}/iam/callback`);
  assert.notEqual(new URL(manager.origin).port, '9');
});

test('callbackAddress: auto keeps IPv4 first and the prefix IAM registers', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  const started = await service.startSignIn();
  const redirect = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
  assert.ok(redirect.startsWith('http://127.0.0.1:'), redirect);
  assert.equal(new URL(redirect).hostname, '127.0.0.1', 'localhost or [::1] would miss the registered prefix');
});

/** A listener stub: each address either binds or fails with a given code. */
function stubListener(outcomes) {
  const tried = [];
  const start = ({ address, port }) => {
    tried.push(address);
    const outcome = outcomes[address];
    if (!outcome) {
      return {
        address,
        port,
        origin: `http://${address}:${port}`,
        ready: Promise.resolve(undefined),
        release: async () => {},
        close: async () => {},
      };
    }
    const error = Object.assign(new Error(outcome), { code: outcome });
    error.code = outcome === 'EADDRINUSE' ? 'IAM_CALLBACK_PORT_UNAVAILABLE' : 'IAM_CALLBACK_BIND_FAILED';
    error.details = { reason: outcome, address, port };
    return {
      address,
      port,
      origin: undefined,
      ready: Promise.resolve(error),
      release: async () => {},
      close: async () => {},
    };
  };
  return { start, tried };
}

test('callbackAddress: the derived URI always carries an accepted prefix', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  const started = await service.startSignIn();
  const redirect = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
  // IAM accepts only http://127.0.0.1: and http://127.0.0.1/ (https too). A
  // host suffix such as 127.0.0.1.evil.com or a neighbour such as 127.0.0.10
  // fails that rule, so the derived URI must stop at the literal host.
  assert.match(redirect, /^http:\/\/127\.0\.0\.1[:/]/);
  assert.doesNotMatch(redirect, /^http:\/\/127\.0\.0\.1[^:/]/, 'no host suffix may follow the literal');
  assert.equal(new URL(redirect).hostname, '127.0.0.1');

  // The IPv6 fallback does not sit under that prefix: it only works once IAM
  // registers http://[::1].
  assert.doesNotMatch('http://[::1]:17890/iam/callback', /^http:\/\/127\.0\.0\.1[:/]/);
});

test('callbackAddress: auto falls back to IPv6 only when the family is missing', async () => {
  const missing = stubListener({ '127.0.0.1': 'EADDRNOTAVAIL' });
  const manager = createCallbackManager({
    port: 0, path: '/iam/callback', handler: () => {}, startListener: missing.start,
  });
  const origin = await manager.ensure();
  assert.deepEqual(missing.tried, ['127.0.0.1', '::1']);
  assert.match(origin, /^http:\/\/[\[\]::1]+:/);
  await manager.close();

  // A taken port is a real refusal: switching address family would send the
  // browser somewhere that was never registered.
  const taken = stubListener({ '127.0.0.1': 'EADDRINUSE' });
  const pinned = createCallbackManager({
    port: 17890, path: '/iam/callback', handler: () => {}, startListener: taken.start,
  });
  await assert.rejects(pinned.ensure(), { code: 'IAM_CALLBACK_PORT_UNAVAILABLE' });
  assert.deepEqual(taken.tried, ['127.0.0.1']);

  // The same rule holds for a pinned port that is simply not available.
  const unavailable = stubListener({ '127.0.0.1': 'EADDRNOTAVAIL', '::1': 'EADDRNOTAVAIL' });
  const both = createCallbackManager({
    port: 17891, path: '/iam/callback', handler: () => {}, startListener: unavailable.start,
  });
  await assert.rejects(both.ensure(), { code: 'IAM_CALLBACK_BIND_FAILED' });
  assert.deepEqual(unavailable.tried, ['127.0.0.1', '::1']);
});

test('callbackAddress: an explicit address never tries the other family', async () => {
  const stub = stubListener({ '127.0.0.1': 'EADDRINUSE' });
  const manager = createCallbackManager({
    port: 17892, address: '127.0.0.1', path: '/iam/callback', handler: () => {}, startListener: stub.start,
  });
  await assert.rejects(manager.ensure(), { code: 'IAM_CALLBACK_PORT_UNAVAILABLE' });
  assert.deepEqual(stub.tried, ['127.0.0.1']);
});

test('callbackAddress: the default binds the prefix IAM registers', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  const started = await service.startSignIn();
  const redirect = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
  assert.ok(redirect.startsWith('http://127.0.0.1:'), redirect);
  assert.equal(new URL(redirect).hostname, '127.0.0.1', 'localhost or [::1] would miss the registered prefix');
});

test('callbackPort: a pinned port is used verbatim', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, { callbackPort: port }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  const started = await service.startSignIn();
  assert.equal(
    new URL(started.authorizationUrl).searchParams.get('redirect_uri'),
    `http://127.0.0.1:${port}/iam/callback`,
  );
});

test('callbackPort: an explicit redirectUri is refused for an OS-assigned port', () => {
  const checked = validateConfig({ callbackPort: 0, redirectUri: 'http://127.0.0.1:17890/iam/callback' });
  assert.ok('issues' in checked);
  assert.ok(checked.issues.some((item) => item.path.includes('redirectUri')));
});

test('callbackPort: a pinned redirectUri that is not byte-equal is refused', () => {
  const port = 17890;
  for (const redirectUri of [
    `http://localhost:${port}/iam/callback`,
    `http://127.0.0.1:${port + 1}/iam/callback`,
    `http://127.0.0.1:${port}/iam/callback/`,
  ]) {
    const checked = validateConfig({ callbackPort: port, redirectUri });
    assert.ok('issues' in checked, `must reject ${redirectUri}`);
  }
  assert.ok('issues' in validateConfig({ callbackPort: 1 }));
  assert.ok('issues' in validateConfig({ callbackPort: 70000 }));
  assert.ok('issues' in validateConfig({ callbackPort: 1.5 }));
  assert.ok('issues' in validateConfig({ callbackAddress: '0.0.0.0', callbackPort: 0 }));
});

test('callbackPort: closed before the sign-in, open during it, closed after', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, { callbackPort: port }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);

  await service.startSignIn();
  const probe = await send(port, { path: '/iam/callback' });
  assert.equal(probe.status, 400, 'an attempt-less callback is rejected by the service');

  await service.cancelSignIn();
  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);
});

test('callbackPort: a completed login releases the port and the response survives', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  const started = await service.startSignIn();
  const origin = manager.origin;
  const authorized = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const target = new URL(authorized.headers.get('location'));
  assert.equal(target.origin, origin);

  // The abort-on-release bug showed up here as ECONNRESET: the callback page
  // must arrive even though the attempt ends while the response is written.
  const callback = await send(Number(new URL(origin).port), {
    path: `${target.pathname}${target.search}`,
    headers: { host: new URL(origin).host },
  });
  assert.equal(callback.status, 200);
  assert.equal((await service.getSession()).signedIn, true);
  assert.equal(manager.origin, undefined, 'the listener is gone after the attempt');

  await assert.rejects(() => send(Number(new URL(origin).port), { path: '/iam/callback' }), refused);
});

test('callbackPort: the next sign-in rebinds after a release', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0 }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  await service.startSignIn();
  const first = manager.origin;
  await service.cancelSignIn();
  assert.equal(manager.origin, undefined);

  const second = await service.startSignIn();
  assert.ok(manager.origin, 'the second attempt binds again');
  assert.equal(
    new URL(second.authorizationUrl).searchParams.get('redirect_uri'),
    `${manager.origin}/iam/callback`,
    'the new attempt uses the new bind',
  );
  assert.ok(first, 'the first attempt did bind');
});

test('callbackPort: an unavailable bound origin releases the listener and permits a retry', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, { callbackPort: port, callbackAddress: '127.0.0.1' }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));

  let manager;
  let unavailable = true;
  let boundOrigin;
  let release;
  let closeCalls = 0;
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
    openCallback: async () => { boundOrigin = await manager.ensure(); },
    getCallbackOrigin: () => unavailable ? undefined : manager.origin,
    closeCallback: () => { closeCalls += 1; release = manager.release(); return release; },
  });
  manager = createCallbackManager({
    port,
    address: '127.0.0.1',
    path: checked.value.redirectPath,
    handler: (_req, res) => { res.statusCode = 204; res.end(); },
  });
  t.after(async () => { await service.dispose(); await manager.close(); });

  await assert.rejects(() => service.startSignIn(), { code: 'IAM_CALLBACK_UNAVAILABLE' });
  assert.equal(boundOrigin, `http://127.0.0.1:${port}`, 'the listener bound before the origin lookup failed');
  assert.equal(closeCalls, 1, 'the failed sign-in requested listener cleanup');
  await release;
  assert.equal(manager.origin, undefined);
  assert.equal(service.getView().state, 'signed-out');
  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);

  unavailable = false;
  const retry = await service.startSignIn();
  assert.equal(manager.origin, boundOrigin);
  assert.equal(new URL(retry.authorizationUrl).searchParams.get('redirect_uri'), `${boundOrigin}/iam/callback`);
  assert.equal(retry.view.state, 'authenticating');
  assert.equal((await send(port, { path: '/iam/callback' })).status, 204);
});

test('callbackPort: reentrant cancellation cannot return the cached authorization URL', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const checked = validateConfig(configFor(mock, { callbackPort: 0, callbackAddress: '127.0.0.1' }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));

  let manager;
  let service;
  let release;
  let cancelDuringOrigin = false;
  service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    openCallback: () => manager.ensure(),
    closeCallback: () => { release = manager.release(); return release; },
    getCallbackOrigin: () => {
      const origin = manager.origin;
      if (cancelDuringOrigin) {
        cancelDuringOrigin = false;
        void service.cancelSignIn();
      }
      return origin;
    },
  });
  manager = createCallbackManager({
    port: 0,
    address: '127.0.0.1',
    path: checked.value.redirectPath,
    handler: (_req, res) => { res.statusCode = 204; res.end(); },
  });
  t.after(async () => { await service.dispose(); await manager.close(); });

  const first = await service.startSignIn();
  const authorization = new URL(first.authorizationUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'synthetic');
  const port = Number(callback.port);
  assert.equal((await service.startSignIn()).authorizationUrl, first.authorizationUrl);

  cancelDuringOrigin = true;
  await assert.rejects(() => service.startSignIn(), { code: 'IAM_ATTEMPT_CANCELLED' });
  assert.ok(release, 'cancellation requested listener cleanup');
  await release;
  assert.equal(manager.origin, undefined);
  assert.equal(service.getView().state, 'signed-out');
  await assert.rejects(() => service.handleCallback(callback.href), { code: 'IAM_STATE_MISMATCH' });
  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);
});

test('callbackPort: a taken pinned port refuses the sign-in and never falls back', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const occupant = createNetServer(() => {});
  await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupant.close(resolve)));

  const checked = validateConfig(configFor(mock, { callbackPort: port }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  t.after(() => manager.close());

  await assert.rejects(service.startSignIn(), { code: 'IAM_CALLBACK_PORT_UNAVAILABLE' });
  assert.equal(manager.origin, undefined);
  assert.equal((await service.getView()).signedIn, false);
});

test('callback listener: only the exact loopback path is served', async (t) => {
  const port = await freePort();
  const seen = [];
  const listener = startCallbackListener({
    port,
    address: '127.0.0.1',
    path: '/iam/callback',
    handler: (req, res) => {
      seen.push(req.url);
      res.statusCode = 204;
      res.end();
    },
  });
  t.after(() => listener.close());
  assert.equal(await listener.ready, undefined);
  const host = new URL(listener.origin).host;

  const exact = await send(port, { path: '/iam/callback?code=x&state=y', headers: { host } });
  assert.equal(exact.status, 204);
  assert.equal(seen.length, 1);

  for (const path of ['/iam/callbackX', '/iam/callback/extra', '/other']) {
    const response = await send(port, { path, headers: { host } });
    assert.equal(response.status, 404, `${path} must not reach the callback handler`);
  }
  const rebound = await send(port, { path: '/iam/callback', headers: { host: 'evil.example' } });
  assert.equal(rebound.status, 403, 'a foreign Host header is refused before routing');
  assert.equal(seen.length, 1);
});

test('callback listener: non-GET reaches the callback route and is refused', async (t) => {
  const port = await freePort();
  const routes = createIamRoutes(
    { handleCallback: async () => {} },
    { callbackPath: '/iam/callback', getOrigin: () => `http://127.0.0.1:${port}` },
  );
  const listener = startCallbackListener({ port, address: '127.0.0.1', path: '/iam/callback', handler: routes });
  t.after(() => listener.close());
  await listener.ready;
  const host = new URL(listener.origin).host;

  const post = await send(port, { method: 'POST', path: '/iam/callback', headers: { host } });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
});

test('callback listener: closing before the bind settles cannot hang a waiter', async () => {
  const port = await freePort();
  const listener = startCallbackListener({ port, address: '127.0.0.1', path: '/iam/callback', handler: () => {} });
  await listener.close();
  let guard;
  const outcome = await Promise.race([
    listener.ready,
    new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('ready never settled after close')), 1000);
    }),
  ]).finally(() => clearTimeout(guard));
  assert.equal(outcome?.code, 'IAM_CALLBACK_BIND_FAILED');
});

test('callback listener: loopback peer detection', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['203.0.113.8', '::ffff:203.0.113.8', '198.51.100.2', '', undefined]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('callback listener: a non-loopback peer is refused before routing', () => {
  const peer = (address) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value; },
      end(body = '') { this.body = body; },
    };
    const rejected = rejectNonLoopbackPeer({ socket: { remoteAddress: address } }, res);
    return { rejected, res };
  };
  const remote = peer('203.0.113.5');
  assert.equal(remote.rejected, true);
  assert.equal(remote.res.statusCode, 403);

  const local = peer('127.0.0.1');
  assert.equal(local.rejected, false);
  assert.equal(local.res.statusCode, 0);
});

test('callback listener: the request gate checks peer, host and path in order', () => {
  const host = '127.0.0.1:17890';
  const fakeRes = () => ({
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body = '') { this.body = body; this.headersSent = true; },
  });
  const req = (overrides = {}) => ({
    url: '/iam/callback',
    headers: { host },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  });
  let routed = 0;
  const gate = createCallbackRequestHandler({
    origin: 'http://127.0.0.1:17890',
    path: '/iam/callback',
    handler: () => { routed += 1; },
  });

  const remote = fakeRes();
  gate(req({ socket: { remoteAddress: '203.0.113.5' } }), remote);
  assert.equal(remote.statusCode, 403);

  const rebound = fakeRes();
  gate(req({ headers: { host: 'evil.example' } }), rebound);
  assert.equal(rebound.statusCode, 403);

  const wrongPath = fakeRes();
  gate(req({ url: '/iam/callbackX' }), wrongPath);
  assert.equal(wrongPath.statusCode, 404);

  assert.equal(routed, 0, 'nothing reaches the IAM handler before every check passes');
  const accepted = fakeRes();
  gate(req({ url: '/iam/callback?code=x' }), accepted);
  assert.equal(routed, 1);
});

test('callback listener: IPv6 loopback uses a bracketed origin', async (t) => {
  let available = true;
  const probe = createNetServer();
  await new Promise((resolve) => {
    probe.once('error', () => { available = false; resolve(); });
    probe.listen(0, '::1', resolve);
  });
  if (available) await new Promise((resolve) => probe.close(resolve));
  if (!available) {
    t.skip('IPv6 loopback is not available on this host');
    return;
  }

  const listener = startCallbackListener({ port: 0, address: '::1', path: '/iam/callback', handler: (req, res) => res.end('ok') });
  t.after(() => listener.close());
  assert.equal(await listener.ready, undefined);
  assert.match(listener.origin, /^http:\/\/\[::1\]:\d+$/);
  assert.equal(loopbackOrigin('::1', 8080), 'http://[::1]:8080');
  assert.equal(loopbackOrigin('127.0.0.1', 8080), 'http://127.0.0.1:8080');

  // A real request on ::1 must pass the loopback peer check and the Host check.
  const host = new URL(listener.origin).host;
  const port = Number(new URL(listener.origin).port);
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '::1', port, path: '/iam/callback', headers: { host }, agent: false },
      (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(response.status, 200);
});

test('callback listener: a client that never completes cannot hold the port', async (t) => {
  const manager = createCallbackManager({
    port: 0,
    path: '/iam/callback',
    // The bug this covers: a half-finished request used to keep server.close()
    // pending, and every later bind queued behind it.
    handler: () => {},
  });
  t.after(() => manager.close());
  await manager.ensure();
  const origin = manager.origin;
  const port = Number(new URL(origin).port);

  // A complete request reaches the handler, which never answers: the connection
  // is active, so plain server.close() would wait for it.
  const pending = new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/iam/callback', headers: { host: new URL(origin).host }, agent: false });
    req.on('error', () => resolve('closed'));
    req.on('response', (res) => { res.resume(); resolve('responded'); });
    req.end();
  });
  await delay(30);

  const started = Date.now();
  await manager.release();
  const elapsed = Date.now() - started;
  assert.equal(await pending, 'closed', 'the grace timer drops the stuck request');
  assert.ok(elapsed < 3000, `release took ${elapsed}ms with a stuck request`);
  assert.ok(elapsed >= 500, `release returned in ${elapsed}ms, before the grace window`);

  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);
});

test('callback manager: ensure is idempotent and release drains', async (t) => {
  let served = 0;
  const manager = createCallbackManager({
    port: 0,
    path: '/iam/callback',
    handler: async (req, res) => { await delay(40); served += 1; res.end('done'); },
  });
  t.after(() => manager.close());

  const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(first, second, 'concurrent ensures share one bind');
  assert.ok(manager.origin);

  const port = Number(new URL(manager.origin).port);
  const host = new URL(manager.origin).host;
  const inFlight = send(port, { path: '/iam/callback', headers: { host } });
  await delay(10);
  await manager.release();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.equal(response.body, 'done');
  assert.equal(served, 1);
});

test('plugin: unload releases the callback port', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, { callbackPort: port }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const { service, manager } = loopbackService(checked.value);
  await service.startSignIn();
  await manager.close();
  await assert.rejects(() => send(port, { path: '/iam/callback' }), refused);
});
/** Minimal Cordis context, mirroring lifecycle.test.mjs. */
function fakeContext(credentials = new MemoryCredentials()) {
  const provided = new Map();
  const effects = [];
  const routes = [];
  return {
    provided,
    routes,
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'connection') return { userId: 'local-operator' };
      return undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    inject(deps, callback) {
      if (!deps.includes('webServer')) return undefined;
      const host = {
        webServer: {
          getOrigin: () => 'http://127.0.0.1:9',
          register(route) {
            routes.push(route);
            return () => routes.splice(routes.indexOf(route), 1);
          },
        },
      };
      const dispose = callback(host);
      effects.push(dispose);
      return dispose;
    },
    async unload() {
      for (const dispose of effects.splice(0).reverse()) {
        if (typeof dispose === 'function') await dispose();
        else await dispose?.dispose?.();
      }
    },
  };
}

test('plugin: a loopback callback leaves the host web server with only the API', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const ctx = fakeContext();
  apply(ctx, configFor(mock, { callbackPort: 0 }));
  assert.ok(ctx.provided.get('iam'));
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].path, '/api/forge-iam');
  await ctx.unload();
  assert.equal(ctx.routes.length, 0);
});
