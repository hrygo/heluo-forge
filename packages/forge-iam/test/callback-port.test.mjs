import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { apply } from '../src/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import {
  createCallbackRequestHandler, isLoopbackAddress, rejectNonLoopbackPeer, startCallbackListener,
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
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

function send(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

async function waitForListener(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await send(port, { path: '/iam/callback', method: 'POST' });
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`callback listener on ${port} did not start`);
}

/** Minimal Cordis context, mirroring lifecycle.test.mjs. */
function fakeContext(credentials = new MemoryCredentials()) {
  const provided = new Map();
  const effects = [];
  const routes = [];
  return {
    provided,
    effects,
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

test('callbackPort: a fixed port outranks the host origin', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();

  const checked = validateConfig(configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    // Deliberately a different origin: the fixed port must win.
    getOrigin: () => 'http://127.0.0.1:9',
  });
  const started = await service.startSignIn();
  const authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/iam/callback`);
});

test('callbackPort: an omitted redirectUri is derived from the fixed port', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, { callbackPort: port }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
  });
  const started = await service.startSignIn();
  const authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/iam/callback`);
});

test('callback listener: a full login completes through the fixed port', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
  });
  const listener = startCallbackListener({
    port,
    origin: `http://127.0.0.1:${port}`,
    path: '/iam/callback',
    handler: createIamRoutes(service, {
      callbackPath: '/iam/callback',
      getOrigin: () => `http://127.0.0.1:${port}`,
    }),
  });
  t.after(() => listener.close());
  await listener.ready;

  const started = await service.startSignIn();
  const authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/iam/callback`);
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin, `http://127.0.0.1:${port}`);

  const callback = await send(port, { path: `${location.pathname}${location.search}` });
  assert.equal(callback.status, 200);
  assert.equal((await service.getSession()).signedIn, true);
});

test('callbackPort: a redirectUri that is not byte-equal is refused', () => {
  const port = 17890;
  for (const redirectUri of [
    `http://localhost:${port}/iam/callback`,
    `http://127.0.0.1:${port + 1}/iam/callback`,
    `http://127.0.0.1:${port}/iam/callback/`,
  ]) {
    const checked = validateConfig({ callbackPort: port, redirectUri });
    assert.ok('issues' in checked, `must reject ${redirectUri}`);
    assert.ok(checked.issues.some((item) => item.path.includes('redirectUri')));
  }
  assert.ok('issues' in validateConfig({ callbackPort: 70000 }));
  assert.ok('issues' in validateConfig({ callbackPort: 1.5 }));
});

test('callback listener: only the exact loopback path is served', async (t) => {
  const port = await freePort();
  const seen = [];
  const listener = startCallbackListener({
    port,
    origin: `http://127.0.0.1:${port}`,
    path: '/iam/callback',
    handler: (req, res) => {
      seen.push(req.url);
      res.statusCode = 204;
      res.end();
    },
  });
  t.after(() => listener.close());
  assert.equal(await listener.ready, undefined);

  const exact = await send(port, { path: '/iam/callback?code=x&state=y' });
  assert.equal(exact.status, 204);
  assert.equal(seen.length, 1);

  for (const path of ['/iam/callbackX', '/iam/callback/extra', '/other']) {
    const response = await send(port, { path });
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
  const listener = startCallbackListener({
    port,
    origin: `http://127.0.0.1:${port}`,
    path: '/iam/callback',
    handler: routes,
  });
  t.after(() => listener.close());
  await listener.ready;

  const post = await send(port, { method: 'POST', path: '/iam/callback' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');

  const get = await send(port, { path: '/iam/callback?code=stub' });
  assert.equal(get.status, 200);

  // A Host header that is not the registered loopback origin is refused before
  // the callback runs, so a DNS-rebound page cannot drive the exchange.
  const rebound = await send(port, { path: '/iam/callback', headers: { host: 'evil.example' } });
  assert.equal(rebound.status, 403);
});

test('callback listener: a taken port fails closed and never rebinds', async (t) => {
  const port = await freePort();
  const occupant = createNetServer(() => {});
  await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupant.close(resolve)));

  const listener = startCallbackListener({
    port,
    origin: `http://127.0.0.1:${port}`,
    path: '/iam/callback',
    handler: () => {},
  });
  t.after(() => listener.close());
  const failure = await listener.ready;
  assert.equal(failure?.code, 'IAM_CALLBACK_PORT_UNAVAILABLE');
  assert.equal(listener.server.listening, false);
  assert.equal(listener.origin, `http://127.0.0.1:${port}`);
});

test('callback listener: closing before the bind settles cannot hang a waiter', async () => {
  const port = await freePort();
  const listener = startCallbackListener({
    port,
    origin: `http://127.0.0.1:${port}`,
    path: '/iam/callback',
    handler: () => {},
  });
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

test('service: a sign-in still waiting on the callback bind is refused once disposed', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  let release;
  const binding = new Promise((resolve) => { release = resolve; });
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
    getCallbackReady: () => binding,
  });

  const started = service.startSignIn();
  await delay(30);
  await service.dispose();
  release();
  // The guard after the await is what makes teardown order safe: disposing
  // before closing the listener cannot yield a URL for a closed port.
  await assert.rejects(started, { code: 'IAM_DISPOSED' });
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
  assert.equal(remote.res.body, 'callback is loopback only');

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

test('plugin: a fixed port moves the callback off the host', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const ctx = fakeContext();
  apply(ctx, configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  const service = ctx.provided.get('iam');
  assert.ok(service);
  // Only the management API stays on the host web server.
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].path, '/api/forge-iam');

  await waitForListener(port);
  const served = await send(port, { path: '/iam/callback' });
  assert.equal(served.status, 400, 'an attempt-less callback is rejected by the service');
  await ctx.unload();
});

test('service: sign-in waits for the fixed port to finish binding', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  let release;
  const binding = new Promise((resolve) => { release = resolve; });
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
    getCallbackReady: () => binding,
  });

  let settled = false;
  const started = service.startSignIn().then((value) => { settled = true; return value; });
  await delay(50);
  assert.equal(settled, false, 'no authorization URL before the port is bound');

  release();
  const result = await started;
  assert.equal(new URL(result.authorizationUrl).searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/iam/callback`);
});

test('service: a failed bind refuses sign-in instead of falling back to the host port', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const checked = validateConfig(configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  assert.ok('value' in checked, JSON.stringify(checked.issues));
  const failure = Object.assign(new Error('callback port is unavailable'), { code: 'IAM_CALLBACK_PORT_UNAVAILABLE' });
  const service = createIamService(checked.value, {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9',
    getCallbackFailure: () => failure,
  });
  await assert.rejects(service.startSignIn(), { code: 'IAM_CALLBACK_PORT_UNAVAILABLE' });
});

test('plugin: unload releases the fixed port so a re-apply can bind it', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const port = await freePort();
  const first = fakeContext();
  apply(first, configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  await waitForListener(port);
  await first.unload();
  await assert.rejects(
    () => send(port, { path: '/iam/callback' }),
    (error) => error.code === 'ECONNREFUSED',
  );

  const second = fakeContext();
  apply(second, configFor(mock, {
    callbackPort: port,
    redirectUri: `http://127.0.0.1:${port}/iam/callback`,
  }));
  await waitForListener(port);
  const served = await send(port, { path: '/iam/callback' });
  assert.equal(served.status, 400);
  await second.unload();
});
