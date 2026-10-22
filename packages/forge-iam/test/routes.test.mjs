import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamRoutes } from '../src/routes.mjs';

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

async function call(handler, method, url, headers = {}) {
  const res = response();
  await handler({ method, url, headers }, res);
  return res;
}

function service(overrides = {}) {
  return {
    getView: () => view,
    startSignIn: async () => ({ view: { ...view, state: 'authenticating' }, authorizationUrl: 'https://iam.example/authorize' }),
    signOut: async () => ({ view, logoutUrl: null }),
    cancelSignIn: async () => ({ ...view, state: 'signed-out' }),
    handleCallback: async () => view,
    ...overrides,
  };
}

test('the callback route follows the configured path', async () => {
  let called = 0;
  const handler = createIamRoutes(service({ handleCallback: async () => { called += 1; return view; } }), {
    callbackPath: '/custom/callback',
  });
  const hit = await call(handler, 'GET', '/custom/callback?code=x&state=y');
  assert.equal(hit.statusCode, 200);
  assert.equal(called, 1);
  const miss = await call(handler, 'GET', '/iam/callback?code=x&state=y');
  assert.equal(miss.statusCode, 404);
});

test('GET view returns the non-secret service snapshot', async () => {
  const res = await call(createIamRoutes(service()), 'GET', '/api/forge-iam/view');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'signed-out');
  assert.equal('accessToken' in res.json(), false);
  assert.equal('refreshToken' in res.json(), false);
});

test('sign-in requires the custom request header', async () => {
  const handler = createIamRoutes(service());
  const missing = await call(handler, 'POST', '/api/forge-iam/sign-in');
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error.code, 'IAM_REQUEST_HEADER_REQUIRED');
  const ok = await call(handler, 'POST', '/api/forge-iam/sign-in', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().view.state, 'authenticating');
  assert.equal(ok.json().authorizationUrl, 'https://iam.example/authorize');
});

test('sign-in error status is mapped without leaking tokens', async () => {
  const handler = createIamRoutes(service({
    startSignIn: async () => { throw Object.assign(new Error('nope'), { code: 'IAM_UNREACHABLE', details: {} }); },
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-in', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'IAM_UNREACHABLE');
});

test('sign-out returns the view and optional logout URL', async () => {
  const handler = createIamRoutes(service({
    signOut: async () => ({ view, logoutUrl: 'https://iam.example/logout' }),
  }));
  const res = await call(handler, 'POST', '/api/forge-iam/sign-out', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().view.state, 'signed-out');
  assert.equal(res.json().logoutUrl, 'https://iam.example/logout');
});

test('cancel is a POST with the request header and returns the view', async () => {
  const handler = createIamRoutes(service());
  const missing = await call(handler, 'POST', '/api/forge-iam/cancel');
  assert.equal(missing.statusCode, 403);
  const ok = await call(handler, 'POST', '/api/forge-iam/cancel', { 'x-forge-iam-request': '1', 'content-type': 'application/json', host: '127.0.0.1:4567' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().view.state, 'signed-out');
});

test('callback success and failure are HTML and do not expose details', async () => {
  const handler = createIamRoutes(service());
  const success = await call(handler, 'GET', '/iam/callback?code=c&state=s');
  assert.equal(success.statusCode, 200);
  assert.match(success.text(), /登录完成/);
  assert.doesNotMatch(success.text(), /access|refresh/i);

  const failure = createIamRoutes(service({
    handleCallback: async () => { throw Object.assign(new Error('bad'), { code: 'IAM_STATE_MISMATCH' }); },
  }));
  const failed = await call(failure, 'GET', '/iam/callback?code=c&state=s');
  assert.equal(failed.statusCode, 400);
  assert.match(failed.text(), /登录失败/);
  assert.doesNotMatch(failed.text(), /state mismatch|IAM_STATE_MISMATCH/i);
});

test('methods and unknown paths are rejected without leaking internals', async () => {
  const handler = createIamRoutes(service());
  const wrongMethod = await call(handler, 'GET', '/api/forge-iam/sign-in');
  assert.equal(wrongMethod.statusCode, 405);
  const missing = await call(handler, 'GET', '/api/forge-iam/nope');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'IAM_NOT_FOUND');
});
test('POST requests reject cross-site origin and non-JSON content', async () => {
  const handler = createIamRoutes(service());
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
