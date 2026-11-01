import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIamRoutes } from '../src/routes.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { createIamService as createUntrustedService } from '../src/service.mjs';
import { validateConfig } from '../src/config.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const view = {
  state: 'signed-out', configured: true, signedIn: false, canSignIn: true,
  missing: [], error: null, exclusive: 'ok', principal: null, accessExpiresAt: null,
};

function response() {
  const headers = {};
  let body = '';
  return {
    statusCode: 0,
    headers,
    headersSent: false,
    setHeader(name, value) { headers[name] = value; },
    end(value) { body = value; this.headersSent = true; },
    json() { return JSON.parse(body); },
    text() { return body; },
  };
}

function request(method, url, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

async function call(handler, method, url, headers = {}, body) {
  const res = response();
  await handler(request(method, url, headers, body), res);
  return res;
}

// DSH Connection admits the request unless a test overrides it.
const ADMITTED = { requestRejection: () => undefined };

function routes(service, options = {}) {
  return createIamRoutes(service, { getConnection: () => ADMITTED, ...options });
}

function service(overrides = {}) {
  return {
    getView: () => view,
    startSignIn: async () => ({ view: { ...view, state: 'authenticating' }, authorizationUrl: 'https://iam.example/authorize' }),
    signOut: async () => ({ view, logoutUrl: null }),
    cancelSignIn: async () => ({ ...view, state: 'signed-out' }),
    handleCallback: async () => view,
    loadGatewayCredential: async () => ({ state: 'unconfigured' }),
    saveGatewayCredential: async () => ({ ...view, state: 'ready', gatewayCredential: { state: 'configured' } }),
    clearGatewayCredential: async () => ({ ...view, state: 'ready', gatewayCredential: { state: 'unconfigured' } }),
    ...overrides,
  };
}

test('the callback route follows the configured path', async () => {
  let called = 0;
  const handler = routes(service({ handleCallback: async () => { called += 1; return view; } }), {
    callbackPath: '/custom/callback',
  });
  const hit = await call(handler, 'GET', '/custom/callback?code=x&state=y');
  assert.equal(hit.statusCode, 200);
  assert.equal(called, 1);
  const miss = await call(handler, 'GET', '/iam/callback?code=x&state=y');
  assert.equal(miss.statusCode, 404);
});

test('the callback rejects a Host that differs from the live origin', async () => {
  const handler = routes(service(), { getOrigin: () => 'http://127.0.0.1:4567' });
  const callback = await call(handler, 'GET', '/iam/callback?code=x&state=y', { host: 'evil.example:4567' });
  assert.equal(callback.statusCode, 403);
  const good = await call(handler, 'GET', '/iam/callback?code=x&state=y', { host: '127.0.0.1:4567' });
  assert.equal(good.statusCode, 200);
});

test('callback route passes the live origin and exact path to the real service', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const origin = 'http://127.0.0.1:4567';
  const config = validateConfig({
    ...mock.endpoints, clientId: mock.clientId,
    redirectUri: `${origin}/iam/callback`, allowInsecureHttp: true,
  }).value;
  const iam = createIamService(config, { credentials, getOrigin: () => origin });
  const handler = routes(iam, { getOrigin: () => origin });
  const started = await iam.startSignIn();
  const authorization = await fetch(started.authorizationUrl, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const target = `${callback.pathname}${callback.search}`;
  assert.equal((await call(handler, 'GET', target, { host: '127.0.0.1:4568' })).statusCode, 403);
  assert.equal((await call(handler, 'GET', `http://localhost:4567${target}`, { host: '127.0.0.1:4567' })).statusCode, 403);
  assert.equal((await call(handler, 'GET', `/wrong${target}`, { host: '127.0.0.1:4567' })).statusCode, 404);
  assert.equal(mock.counts.token, 0);
  assert.equal((await call(handler, 'GET', target, { host: '127.0.0.1:4567' })).statusCode, 200);
  assert.equal(iam.getView().state, 'ready');
  assert.equal(mock.counts.token, 1);
});

test('unverified atomic store produces a safe 503 for sign-in', async () => {
  const credentials = new MemoryCredentials();
  const config = { issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize', tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks', clientId: 'client', redirectUri: 'http://127.0.0.1:4567/iam/callback' };
  const handler = routes(createUntrustedService(config, { credentials }));
  const result = await call(handler, 'POST', '/api/forge-iam/sign-in', { 'x-forge-iam-request': '1', 'content-type': 'application/json' });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().error.code, 'IAM_ATOMIC_STORE_UNVERIFIED');
  assert.doesNotMatch(result.text(), /refresh-token|access-token/);
});

test('the API defers Host and Origin policy to DSH Connection', async () => {
  let seen = 0;
  const handler = routes(service(), {
    getConnection: () => ({
      requestRejection({ headers }) {
        seen += 1;
        return headers.host === 'evil.example:4567' ? 403 : undefined;
      },
    }),
  });
  const api = await call(handler, 'POST', '/api/forge-iam/sign-in', {
    'x-forge-iam-request': '1', 'content-type': 'application/json', host: 'evil.example:4567',
    origin: 'http://evil.example:4567', 'sec-fetch-site': 'same-origin',
  });
  assert.equal(api.statusCode, 403);
  assert.equal(seen, 1);
});

test('POST keeps the CSRF intent header and fetch metadata checks', async () => {
  const handler = routes(service(), { getOrigin: () => 'http://127.0.0.1:4567' });
  const res = await call(handler, 'POST', '/api/forge-iam/sign-in', {
    'x-forge-iam-request': '1', 'content-type': 'application/json',
    host: '127.0.0.1:4567', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site',
  });
  assert.equal(res.statusCode, 403);
});

test('a rejected API request never reads the shared session', async () => {
  let reads = 0;
  const handler = routes(service({
    syncFromStore: async () => { reads += 1; },
    getView: () => { reads += 1; return { ...view, principal: 'E1001' }; },
  }), { getConnection: () => ({ requestRejection: () => 403 }) });
  const res = await call(handler, 'GET', '/api/forge-iam/view', { host: 'evil.example:4567' });
  assert.equal(res.statusCode, 403);
  assert.doesNotMatch(res.text(), /E1001/);
  assert.equal(reads, 0);
  const admitted = routes(service({
    syncFromStore: async () => { reads += 1; },
    getView: () => { reads += 1; return { ...view, principal: 'E1001' }; },
  }));
  const trusted = await call(admitted, 'GET', '/api/forge-iam/view', { host: '127.0.0.1:4567' });
  assert.equal(trusted.statusCode, 200);
  assert.equal(reads, 2);
});

test('origin lookup failure does not disable the callback Host check', async () => {
  for (const getOrigin of [() => undefined, () => 'not a URL', () => { throw new Error('not listening'); }]) {
    let called = false;
    const handler = routes(service({
      handleCallback: async () => { called = true; return view; },
    }), { getOrigin });
    const headers = { host: 'evil.example:4567', origin: 'http://evil.example:4567' };
    assert.equal((await call(handler, 'GET', '/iam/callback?code=x&state=y', headers)).statusCode, 403);
    assert.equal(called, false);
  }
});

test('GET view syncs the shared record before returning a snapshot', async () => {
  let synced = 0;
  const res = await call(routes(service({ syncFromStore: async () => { synced += 1; } })), 'GET', '/api/forge-iam/view');
  assert.equal(res.statusCode, 200);
  assert.equal(synced, 1);
});

test('GET view returns the non-secret service snapshot', async () => {
  const res = await call(routes(service()), 'GET', '/api/forge-iam/view');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'signed-out');
  assert.equal('accessToken' in res.json(), false);
  assert.equal('refreshToken' in res.json(), false);
});

test('sign-in requires the custom request header', async () => {
  const handler = routes(service());
  const missing = await call(handler, 'POST', '/api/forge-iam/sign-in');
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error.code, 'IAM_REQUEST_HEADER_REQUIRED');
  const ok = await call(handler, 'POST', '/api/forge-iam/sign-in', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().view.state, 'authenticating');
  assert.equal(ok.json().authorizationUrl, 'https://iam.example/authorize');
});

test('sign-in error status is mapped without leaking tokens', async () => {
  const handler = routes(service({
    startSignIn: async () => { throw Object.assign(new Error('nope'), { code: 'IAM_UNREACHABLE', details: {} }); },
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-in', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'IAM_UNREACHABLE');
});

test('sign-out returns the view and optional logout URL', async () => {
  const handler = routes(service({
    signOut: async () => ({ view, logoutUrl: 'https://iam.example/logout' }),
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-out', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().view.state, 'signed-out');
  assert.equal(res.json().logoutUrl, 'https://iam.example/logout');
});

test('sign-out unknown suppresses logout URL and reports unavailable', async () => {
  const handler = routes(service({
    signOut: async () => ({ view: { ...view, state: 'error', error: 'IAM_CREDENTIALS_CLEAR_FAILED' }, revocation: 'unknown', logoutUrl: 'https://iam.example/logout' }),
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-out', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.equal(res.json().revocation, 'unknown');
  assert.equal(res.json().logoutUrl, null);
  assert.equal('accessToken' in res.json(), false);
  assert.equal('refreshToken' in res.json(), false);
});

test('sign-out preserves an unconfirmed remote revocation warning', async () => {
  const handler = routes(service({
    signOut: async () => ({ view: { ...view, error: 'IAM_REVOCATION_FAILED' }, revocation: 'failed', logoutUrl: null }),
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-out', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().view.error, 'IAM_REVOCATION_FAILED');
  assert.equal(res.json().revocation, 'failed');
});

test('cancel is a POST with the request header and returns the view', async () => {
  const handler = routes(service());
  const missing = await call(handler, 'POST', '/api/forge-iam/cancel');
  assert.equal(missing.statusCode, 403);
  const ok = await call(handler, 'POST', '/api/forge-iam/cancel', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().view.state, 'signed-out');
});

test('callback success and failure are HTML and do not expose details', async () => {
  const handler = routes(service());
  const success = await call(handler, 'GET', '/iam/callback?code=c&state=s');
  assert.equal(success.statusCode, 200);
  assert.match(success.text(), /登录完成/);
  assert.doesNotMatch(success.text(), /access|refresh/i);

  const failure = routes(service({
    handleCallback: async () => { throw Object.assign(new Error('bad'), { code: 'IAM_STATE_MISMATCH' }); },
  }));
  const failed = await call(failure, 'GET', '/iam/callback?code=c&state=s');
  assert.equal(failed.statusCode, 400);
  assert.match(failed.text(), /登录失败/);
  assert.doesNotMatch(failed.text(), /state mismatch|IAM_STATE_MISMATCH/i);
});

test('methods and unknown paths are rejected without leaking internals', async () => {
  const handler = routes(service());
  const wrongMethod = await call(handler, 'GET', '/api/forge-iam/sign-in');
  assert.equal(wrongMethod.statusCode, 405);
  const missing = await call(handler, 'GET', '/api/forge-iam/nope');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'IAM_NOT_FOUND');
});
test('POST rejects cross-site fetch metadata even with a matching Host', async () => {
  const handler = routes(service(), { getOrigin: () => 'http://127.0.0.1:4567' });
  const res = await call(handler, 'POST', '/api/forge-iam/sign-in', {
    'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567',
    'sec-fetch-site': 'cross-site',
  });
  assert.equal(res.statusCode, 403);
});

test('POST requests reject cross-site origin and non-JSON content', async () => {
  const handler = routes(service());
  const crossSite = await call(handler, 'POST', '/api/forge-iam/sign-in', {
    'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567',
    origin: 'https://evil.example', 'sec-fetch-site': 'cross-site',
  });
  assert.equal(crossSite.statusCode, 403);
  const form = await call(handler, 'POST', '/api/forge-iam/sign-in', {
    'x-forge-iam-request': '1', 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1:4567',
  });
  assert.equal(form.statusCode, 403);
});

test('the management API requires DSH Connection authentication', async () => {
  let reads = 0;
  let mutations = 0;
  const handler = routes(service({
    getView: () => { reads += 1; return view; },
    signOut: async () => { mutations += 1; return { view }; },
  }), { getConnection: () => ({ requestRejection: () => 401 }) });
  const read = await call(handler, 'GET', '/api/forge-iam/view', { host: '127.0.0.1:4567' });
  assert.equal(read.statusCode, 401);
  assert.equal(read.json().error.code, 'IAM_UNAUTHENTICATED');
  const write = await call(handler, 'POST', '/api/forge-iam/sign-out', {
    'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567',
  });
  assert.equal(write.statusCode, 401);
  assert.equal(reads, 0);
  assert.equal(mutations, 0);
});

test('the management API fails closed when Connection is unavailable', async () => {
  let reads = 0;
  const handler = routes(service({ getView: () => { reads += 1; return view; } }), {
    getConnection: () => undefined,
  });
  const res = await call(handler, 'GET', '/api/forge-iam/view', { host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'IAM_CONNECTION_UNAVAILABLE');
  assert.equal(reads, 0);
});

test('a throwing Connection check fails closed', async () => {
  const handler = routes(service(), {
    getConnection: () => ({ requestRejection() { throw new Error('boom'); } }),
  });
  const res = await call(handler, 'GET', '/api/forge-iam/view', { host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 503);
});

test('the OIDC callback does not require a DSH browser session', async () => {
  const handler = routes(service(), { getConnection: () => ({ requestRejection: () => 401 }) });
  const res = await call(handler, 'GET', '/iam/callback?code=c&state=s', { host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 200);
  assert.match(res.text(), /登录完成/);
});

const MUTATION = { 'x-forge-iam-request': '1', 'content-type': 'application/json' };

test('the credential API saves a key without echoing it', async () => {
  let saved;
  const handler = routes(service({
    saveGatewayCredential: async (input) => {
      saved = input;
      return { ...view, state: 'ready', gatewayCredential: { state: 'configured' } };
    },
  }));
  const key = `uag-${'a'.repeat(32)}`;
  const res = await call(handler, 'PUT', '/api/forge-iam/credential', MUTATION, { key, deviceLabel: ' 工作站-01 ' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved, { key, deviceLabel: ' 工作站-01 ' });
  assert.equal(res.text().includes(key), false);
  assert.equal(res.json().view.gatewayCredential.state, 'configured');
});

test('the credential API rejects a malformed key', async () => {
  const handler = routes(service({
    saveGatewayCredential: async () => {
      const error = new Error('invalid');
      error.code = 'IAM_GATEWAY_KEY_INVALID';
      throw error;
    },
  }));
  const res = await call(handler, 'PUT', '/api/forge-iam/credential', MUTATION, { key: 'oops' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'IAM_GATEWAY_KEY_INVALID');
});

test('credential writes require the CSRF header and a JSON body', async () => {
  const handler = routes(service());
  assert.equal((await call(handler, 'PUT', '/api/forge-iam/credential', {}, { key: 'x' })).statusCode, 403);
  assert.equal((await call(handler, 'DELETE', '/api/forge-iam/credential', {})).statusCode, 403);
  const noKey = await call(handler, 'PUT', '/api/forge-iam/credential', MUTATION, { deviceLabel: 'x' });
  assert.equal(noKey.statusCode, 400);
  assert.equal(noKey.json().error.code, 'IAM_REQUEST_INVALID');
  const notJson = await call(handler, 'PUT', '/api/forge-iam/credential', MUTATION, '{not json');
  assert.equal(notJson.statusCode, 400);
  assert.equal(notJson.json().error.code, 'IAM_REQUEST_INVALID');
});

test('an oversized credential body is rejected before parsing', async () => {
  const handler = routes(service());
  const oversized = JSON.stringify({ key: 'x'.repeat(9 * 1024) });
  const res = await call(handler, 'PUT', '/api/forge-iam/credential', MUTATION, oversized);
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error.code, 'IAM_REQUEST_TOO_LARGE');
});

test('the credential API reads and clears the stored credential', async () => {
  let cleared = 0;
  const handler = routes(service({
    loadGatewayCredential: async () => ({ state: 'configured' }),
    getView: () => ({ ...view, state: 'ready', gatewayCredential: { state: 'configured', deviceLabel: '工作站-01' } }),
    clearGatewayCredential: async () => {
      cleared += 1;
      return { ...view, state: 'ready', gatewayCredential: { state: 'unconfigured' } };
    },
  }));
  const read = await call(handler, 'GET', '/api/forge-iam/credential');
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().credential.deviceLabel, '工作站-01');
  const deleted = await call(handler, 'DELETE', '/api/forge-iam/credential', MUTATION);
  assert.equal(deleted.statusCode, 200);
  assert.equal(cleared, 1);
  assert.equal(deleted.json().view.gatewayCredential.state, 'unconfigured');
});

test('the credential API rejects unsupported methods', async () => {
  const res = await call(routes(service()), 'POST', '/api/forge-iam/credential', MUTATION, {});
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, PUT, DELETE');
});
