import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/index.mjs';
import { createIamRoutes } from '../src/routes.mjs';

const configured = {
  discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
};

function response() {
  const headers = {};
  let body = '';
  return {
    statusCode: 0,
    headers,
    headersSent: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value) {
      body = value;
      this.headersSent = true;
    },
    json() {
      return JSON.parse(body);
    },
  };
}

async function call(handler, method, url) {
  const res = response();
  await handler({ method, url }, res);
  return res;
}

test('GET view returns the non-secret service snapshot', async () => {
  const service = createIamService(configured);
  const res = await call(createIamRoutes(service), 'GET', '/api/forge-iam/view');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'signed-out');
  assert.equal('accessToken' in res.json(), false);
  assert.equal('refreshToken' in res.json(), false);
});

test('sign-in returns 501 before the IAM contract is frozen', async () => {
  const service = createIamService(configured);
  const res = await call(createIamRoutes(service), 'POST', '/api/forge-iam/sign-in');
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error.code, 'IAM_NOT_IMPLEMENTED');
});

test('unconfigured sign-in returns 409 and the missing fields', async () => {
  const service = createIamService({});
  const res = await call(createIamRoutes(service), 'POST', '/api/forge-iam/sign-in');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'IAM_UNCONFIGURED');
  assert.ok(res.json().error.missing.includes('clientId'));
});

test('sign-out returns a signed-out snapshot', async () => {
  const service = createIamService(configured);
  const res = await call(createIamRoutes(service), 'POST', '/api/forge-iam/sign-out');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'signed-out');
});

test('methods and unknown paths are rejected without leaking internals', async () => {
  const handler = createIamRoutes(createIamService(configured));
  const wrongMethod = await call(handler, 'GET', '/api/forge-iam/sign-in');
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.json().error.code, 'IAM_METHOD_NOT_ALLOWED');
  const missing = await call(handler, 'GET', '/api/forge-iam/nope');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'IAM_NOT_FOUND');
});