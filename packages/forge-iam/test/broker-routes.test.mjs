import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { ERROR_STATUS } from '../src/error-contract.mjs';
import { createIamRoutes } from '../src/routes.mjs';

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

function makeReq(method, pathname, { headers = {}, body = null } = {}) {
  const payload = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.method = method;
  stream.url = pathname;
  stream.headers = headers;
  return stream;
}

test('ERROR_STATUS 映射手动模型与扩展凭证全部错误码', () => {
  assert.equal(ERROR_STATUS.IAM_MANUAL_MODEL_INVALID, 400);
  assert.equal(ERROR_STATUS.IAM_MANUAL_MODEL_LIMIT, 409);
  assert.equal(ERROR_STATUS.IAM_MANUAL_MODEL_NOT_FOUND, 404);
  assert.equal(ERROR_STATUS.IAM_MANUAL_MODEL_CONFLICT, 409);
  assert.equal(ERROR_STATUS.IAM_EXT_CREDENTIAL_NOT_FOUND, 404);
  assert.equal(ERROR_STATUS.IAM_EXT_CREDENTIAL_INVALID, 400);
  assert.equal(ERROR_STATUS.OWNER_MISMATCH, 409);
  assert.equal(ERROR_STATUS.KEYCHAIN_UNAVAILABLE, 503);
  assert.equal(ERROR_STATUS.PENDING_WRITE, 409);
});

test('POST /api/forge-iam/models/manual 鉴权头、成功透传与错误码映射', async () => {
  const handler = createIamRoutes(
    {
      getView: () => ({ state: 'ready' }),
      async updateManualModel({ action, id }) {
        if (id === 'bad') {
          const err = new Error('invalid');
          err.code = 'IAM_MANUAL_MODEL_INVALID';
          throw err;
        }
        return { ok: true, action, id };
      },
    },
    {
      getOrigin: () => 'http://localhost',
      getConnection: () => ({ requestRejection: () => undefined }),
    },
  );

  const res403 = makeRes();
  await handler(makeReq('POST', '/api/forge-iam/models/manual', { body: { action: 'add', id: 'm1' } }), res403);
  assert.equal(res403.statusCode, 403);

  const res400 = makeRes();
  await handler(
    makeReq('POST', '/api/forge-iam/models/manual', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
      body: { action: 'add', id: 'bad' },
    }),
    res400,
  );
  assert.equal(res400.statusCode, 400);

  const res200 = makeRes();
  await handler(
    makeReq('POST', '/api/forge-iam/models/manual', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
      body: { action: 'add', id: 'm1' },
    }),
    res200,
  );
  assert.equal(res200.statusCode, 200);
  const parsed = JSON.parse(res200.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.view.state, 'ready');
});

test('/api/forge-iam/ext-credentials GET/PUT/DELETE 不回显明文且强制预检头', async () => {
  const state = { hosted: false };
  const handler = createIamRoutes(
    {
      async listExtCredentials() {
        return [{ extensionId: 'sample-ext', state: state.hosted ? 'HOSTED_ACTIVE' : 'UNSET_NO_HOSTED', hosted: state.hosted }];
      },
      async saveExtCredential({ extensionId, token }) {
        if (extensionId !== 'sample-ext') {
          const err = new Error('not found');
          err.code = 'IAM_EXT_CREDENTIAL_NOT_FOUND';
          throw err;
        }
        assert.equal(token, 'super-secret-value');
        state.hosted = true;
        return { extensionId, state: 'HOSTED_ACTIVE', hosted: true };
      },
      async clearExtCredential({ extensionId }) {
        state.hosted = false;
        return { extensionId, state: 'UNSET_NO_HOSTED', hosted: false };
      },
    },
    {
      getOrigin: () => 'http://localhost',
      getConnection: () => ({ requestRejection: () => undefined }),
    },
  );

  const resGet = makeRes();
  await handler(makeReq('GET', '/api/forge-iam/ext-credentials'), resGet);
  assert.equal(resGet.statusCode, 200);
  assert.equal(JSON.parse(resGet.body).credentials[0].hosted, false);

  const resPut403 = makeRes();
  await handler(makeReq('PUT', '/api/forge-iam/ext-credentials/sample-ext', { body: { token: 'super-secret-value' } }), resPut403);
  assert.equal(resPut403.statusCode, 403);

  const resPut200 = makeRes();
  await handler(
    makeReq('PUT', '/api/forge-iam/ext-credentials/sample-ext', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
      body: { token: 'super-secret-value' },
    }),
    resPut200,
  );
  assert.equal(resPut200.statusCode, 200);
  assert.ok(!resPut200.body.includes('super-secret-value'), '响应绝不回显令牌明文');
  assert.equal(JSON.parse(resPut200.body).credential.hosted, true);

  const resDel = makeRes();
  await handler(
    makeReq('DELETE', '/api/forge-iam/ext-credentials/sample-ext', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
    }),
    resDel,
  );
  assert.equal(resDel.statusCode, 200);
  assert.equal(JSON.parse(resDel.body).credential.hosted, false);
});

test('扩展凭据路由保留错误契约：空令牌 400、存储不可用 503 且码不被压成 IAM_INTERNAL', async () => {
  const handler = createIamRoutes(
    {
      async listExtCredentials() { return []; },
      async saveExtCredential() {
        const err = new Error('invalid token');
        err.code = 'IAM_EXT_TOKEN_INVALID';
        throw err;
      },
      async clearExtCredential() {
        const err = new Error('keychain unavailable');
        err.code = 'KEYCHAIN_UNAVAILABLE';
        throw err;
      },
    },
    {
      getOrigin: () => 'http://localhost',
      getConnection: () => ({ requestRejection: () => undefined }),
    },
  );

  const resInvalid = makeRes();
  await handler(
    makeReq('PUT', '/api/forge-iam/ext-credentials/sample-ext', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
      body: { token: '' },
    }),
    resInvalid,
  );
  assert.equal(resInvalid.statusCode, 400);
  assert.equal(JSON.parse(resInvalid.body).error.code, 'IAM_EXT_TOKEN_INVALID');

  const resStorage = makeRes();
  await handler(
    makeReq('DELETE', '/api/forge-iam/ext-credentials/sample-ext', {
      headers: { 'x-forge-iam-request': '1', 'content-type': 'application/json' },
    }),
    resStorage,
  );
  assert.equal(resStorage.statusCode, 503);
  assert.equal(JSON.parse(resStorage.body).error.code, 'KEYCHAIN_UNAVAILABLE', '已登记的码不能被压成 IAM_INTERNAL');
});
