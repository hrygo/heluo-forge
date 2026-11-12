import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIamRoutes } from '../src/routes.mjs';
import { IamError } from '../src/errors.mjs';
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

function request(method, url, headers, body, remoteAddress = '127.0.0.1') {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

async function call(handler, method, url, headers = {}, body, remoteAddress) {
  const res = response();
  await handler(request(method, url, headers, body, remoteAddress), res);
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

test('the callback route drains the listener only after the page is written', async () => {
  let releases = 0;
  let releasesAtEnd = -1;
  const handler = routes(service({ releaseCallback: async () => { releases += 1; } }));
  const res = response();
  const end = res.end.bind(res);
  res.end = (value) => { releasesAtEnd = releases; end(value); };
  await handler(request('GET', '/iam/callback?code=x&state=y'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(releasesAtEnd, 0);
  assert.equal(releases, 1);
});

test('the callback route drains the listener after a failed callback too', async () => {
  let releases = 0;
  const handler = routes(service({
    releaseCallback: async () => { releases += 1; },
    handleCallback: async () => { throw new IamError('IAM_STATE_MISMATCH', 'state does not match'); },
  }));
  const failed = await call(handler, 'GET', '/iam/callback?code=x&state=y');
  assert.equal(failed.statusCode, 400);
  assert.equal(releases, 1);
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
    redirectUri: `${origin}/iam/callback`,
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
  assert.match(success.text(), /name="viewport"/);
  assert.match(success.text(), /返回 DeepSeek Harness/);
  assert.match(success.text(), /@media \(prefers-color-scheme: dark\)/);
  assert.match(success.text(), /--dsw-alias-bg-layer-1/);
  assert.equal(success.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  assert.equal(success.headers['referrer-policy'], 'no-referrer');
  assert.doesNotMatch(success.text(), /<script\b|<link\b|<img\b/i);
  assert.doesNotMatch(success.text(), /code=c|state=s/);

  const failure = routes(service({
    handleCallback: async () => { throw Object.assign(new Error('bad'), { code: 'IAM_STATE_MISMATCH' }); },
  }));
  const failed = await call(failure, 'GET', '/iam/callback?code=c&state=s');
  assert.equal(failed.statusCode, 400);
  assert.match(failed.text(), /登录失败/);
  assert.match(failed.text(), /返回 DeepSeek Harness/);
  assert.doesNotMatch(failed.text(), /登录成功|登录已完成/);
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

test('a throwing Connection method getter is unavailable before any IAM operation', async () => {
  let operations = 0;
  const connection = Object.defineProperty({}, 'requestRejection', {
    get() { throw new Error('synthetic method lookup failure'); },
  });
  const handler = routes(service({ getView: () => { operations++; return view; } }), { getConnection: () => connection });
  const res = await call(handler, 'GET', '/api/forge-iam/view');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'IAM_CONNECTION_UNAVAILABLE');
  assert.equal(operations, 0);
});

for (const [label, result] of [
  ['false', () => false], ['null', () => null], ['zero', () => 0],
  ['empty string', () => ''], ['string status', () => '401'], ['unexpected status', () => 200],
  ['object', () => ({ admitted: true })], ['NaN', () => NaN],
  ['async admission', () => Promise.resolve(undefined)],
  ['async rejection', () => Promise.reject(new Error('synthetic auth failure'))],
]) {
  test(`Connection ${label} result rejects management requests before any IAM operation`, async () => {
    let operations = 0;
    const count = () => { operations++; return view; };
    const handler = routes(service({
      getView: count, syncFromStore: async () => count(), loadGatewayCredential: async () => count(),
      startSignIn: async () => count(), signOut: async () => count(), cancelSignIn: async () => count(),
      saveGatewayCredential: async () => count(), clearGatewayCredential: async () => count(),
    }), { getConnection: () => ({ requestRejection: result }) });
    for (const [method, path] of [
      ['GET', '/view'], ['POST', '/sign-in'], ['POST', '/sign-out'], ['POST', '/cancel'],
      ['GET', '/credential'], ['PUT', '/credential'], ['DELETE', '/credential'],
    ]) {
      const response = await call(handler, method, `/api/forge-iam${path}`, {
        'x-forge-iam-request': '1', 'content-type': 'application/json',
      }, { key: 'synthetic' });
      assert.equal(response.statusCode, 503, `${method} ${path}`);
      assert.equal(response.json().error.code, 'IAM_CONNECTION_UNAVAILABLE');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(operations, 0);
    await new Promise(setImmediate);
  });
}

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

test('the session route returns identity and never a token', async () => {
  const session = {
    status: 'ready',
    signedIn: true,
    principal: { issuer: 'https://iam.corp.example', subject: 'E1001' },
    accessExpiresAt: '2026-11-04T02:00:00.000Z',
    scope: 'openid profile',
  };
  const handler = routes(service({ getSession: () => session }));
  const res = await call(handler, 'GET', '/api/forge-iam/session');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), session);
  assert.doesNotMatch(res.text(), /accessToken|refreshToken|eyJ/u);

  const wrongMethod = await call(handler, 'POST', '/api/forge-iam/session');
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('the session route is refused when the connection seam is unavailable', async () => {
  const handler = createIamRoutes(service({ getSession: () => ({ status: 'ready' }) }), { getConnection: () => undefined });
  const res = await call(handler, 'GET', '/api/forge-iam/session');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'IAM_CONNECTION_UNAVAILABLE');
});

test('the token route requires the request header and returns expiry only', async () => {
  const handler = routes(service({
    getAccessToken: async () => 'placeholder-access-token',
    getSession: () => ({ status: 'ready', signedIn: true, accessExpiresAt: '2026-11-04T02:00:00.000Z' }),
  }));
  const missingHeader = await call(handler, 'POST', '/api/forge-iam/token', { 'content-type': 'application/json' }, {});
  assert.equal(missingHeader.statusCode, 403);

  const ok = await call(handler, 'POST', '/api/forge-iam/token',
    { 'content-type': 'application/json', 'x-forge-iam-request': '1' }, {});
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { token: 'placeholder-access-token', expiresAt: '2026-11-04T02:00:00.000Z' });
  assert.equal(ok.headers['cache-control'], 'no-store');

  const wrongMethod = await call(handler, 'GET', '/api/forge-iam/token', { 'x-forge-iam-request': '1' });
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
});

test('the token route reports a signed-out session as 401 without a token', async () => {
  const handler = routes(service({
    getAccessToken: async () => { const error = new Error('not signed in'); error.code = 'IAM_NOT_SIGNED_IN'; throw error; },
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/token',
    { 'content-type': 'application/json', 'x-forge-iam-request': '1' }, {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'IAM_NOT_SIGNED_IN');
  assert.doesNotMatch(res.text(), /placeholder-access-token/u);
});

test('the bridge admits only a loopback caller holding the capability', async () => {
  const handler = routes(
    service({
      getAccessToken: async () => 'placeholder-bridge-token',
      getSession: () => ({ status: 'ready', accessExpiresAt: '2026-11-04T02:00:00.000Z' }),
    }),
    { getBridgeSecret: async () => 'placeholder-capability' },
  );

  const ok = await call(handler, 'POST', '/api/forge-iam/bridge/token',
    { authorization: 'Bearer placeholder-capability' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { token: 'placeholder-bridge-token', expiresAt: '2026-11-04T02:00:00.000Z' });
  assert.equal(ok.headers['cache-control'], 'no-store');

  const wrong = await call(handler, 'POST', '/api/forge-iam/bridge/token',
    { authorization: 'Bearer wrong-capability' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'IAM_BRIDGE_UNAUTHORIZED');

  const remote = await call(handler, 'POST', '/api/forge-iam/bridge/token',
    { authorization: 'Bearer placeholder-capability' }, undefined, '203.0.113.7');
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.json().error.code, 'IAM_BRIDGE_FORBIDDEN');

  const missing = await call(handler, 'POST', '/api/forge-iam/bridge/token', {});
  assert.equal(missing.statusCode, 401);
  assert.doesNotMatch(missing.text(), /placeholder-bridge-token/u);
});

test('the bridge fails closed when no capability is available', async () => {
  const handler = routes(service({ getAccessToken: async () => 'placeholder-bridge-token' }),
    { getBridgeSecret: async () => undefined });
  const res = await call(handler, 'POST', '/api/forge-iam/bridge/token', { authorization: 'Bearer anything' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'IAM_CREDENTIALS_UNAVAILABLE');
});

test('the events route streams the same non-sensitive projection as the view', async () => {
  const handler = routes(service({
    watch: async function* watch() {
      yield { state: 'signed-out', signedIn: false };
      yield { state: 'ready', signedIn: true, principal: { issuer: 'https://iam.corp.example', subject: 'E1001' } };
    },
  }));
  const req = request('GET', '/api/forge-iam/events', {});
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.body += chunk; },
    end() { this.headersSent = true; },
  };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const frames = res.body.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /u, '')));
  assert.deepEqual(frames.map((frame) => frame.state), ['signed-out', 'ready']);
  assert.doesNotMatch(res.body, /token|eyJ/iu);

  const wrongMethod = await call(handler, 'POST', '/api/forge-iam/events');
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('a model-access failure keeps its own code and status', async () => {
  for (const [thrown, status, code] of [
    [new IamError('ENTERPRISE_GATEWAY_UNAVAILABLE', '暂时无法连接企业模型，请稍后重试。'), 502, 'ENTERPRISE_GATEWAY_UNAVAILABLE'],
    [new IamError('ENTERPRISE_MODEL_CATALOG_INVALID', '网关返回的模型列表无法识别。'), 502, 'ENTERPRISE_MODEL_CATALOG_INVALID'],
    [new IamError('ENTERPRISE_MODEL_SYNC_CANCELLED', '模型目录同步被中断，请重试。'), 409, 'ENTERPRISE_MODEL_SYNC_CANCELLED'],
    [new IamError('IAM_LOGIN_REQUIRED', '企业账号已退出或登录已过期，请重新登录后再使用模型。'), 401, 'IAM_LOGIN_REQUIRED'],
    // An unexpected failure still never describes itself as a model-access code.
    [new Error('synthetic'), 500, 'IAM_INTERNAL'],
  ]) {
    const handler = routes(service({ refreshGatewayModels: async () => { throw thrown; } }));
    const hit = await call(handler, 'GET', '/api/forge-iam/models');
    assert.equal(hit.statusCode, status);
    assert.equal(hit.json().error.code, code);
  }
});
