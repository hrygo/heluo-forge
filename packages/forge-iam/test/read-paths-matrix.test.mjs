// Read all exposed surfaces through the current host SQLite implementation.
// Other operating systems require their own CI or physical-device run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKeychainProvider,
  createCredentialStore,
} from '@heluo/forge-credentials-keychain';
import { createIamRoutes } from '../src/routes.mjs';
import { validateConfig } from '../src/config.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { SESSION_RECORD_KEY, accessTokenOf, sessionFromRecord } from '../src/cli-session.mjs';

const grant = {
  kind: 'grant',
  payload: {
    version: 1, clientId: 'fixture', obtainedAt: '2026-01-01T00:00:00.000Z',
    issuer: 'https://iam.corp.example',
    subject: 'E1001',
    scope: 'openid profile',
    accessToken: 'placeholder-access-token',
    refreshToken: 'placeholder-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  },
};

async function signedInRecord(t) {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const config = validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
  }).value;
  const credentials = new MemoryCredentials();
  const service = createIamService(config, { credentials });
  t.after(() => service.dispose());
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  await service.handleCallback(response.headers.get('location'));
  return { config, record: await credentials.readRecord(SESSION_RECORD_KEY) };
}

function request(method, url, headers = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  setImmediate(() => { req.emit('end'); });
  return req;
}

function callRoute(handler, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    let body = '';
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader(name, value) { responseHeaders[name] = value; },
      end(value) { body = value ?? ''; this.headersSent = true; resolve({ statusCode: this.statusCode, json: () => JSON.parse(body), text: () => body }); },
    };
    handler(request(method, url, headers), res).catch(reject);
  });
}

test('all read surfaces use the same sqlite session on the current host', async (t) => {
  const { config, record: seeded } = await signedInRecord(t);
  {
    const platform = process.platform;
    const arch = process.arch;
    const root = await mkdtemp(join(tmpdir(), 'forge-read-sqlite-'));
    const directory = join(root, 'store');
    const cleanup = [];
    t.after(async () => {
      const errors = [];
      for (const close of cleanup.reverse()) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'failed to close SQLite test resources');
      await rm(root, { recursive: true, force: true });
    });
    const backend = createCredentialStore({ directory });
    assert.equal(backend.available, true, `${platform}-${arch} backend`);
    const provider = createKeychainProvider(backend, { service: 'heluo-forge', accountPrefix: 'iam' });
    cleanup.push(() => provider.close());
    await provider.modifyRecord(SESSION_RECORD_KEY, async () => grant);

    // 1. raw provider read (the host-side path)
    const record = await provider.readRecord(SESSION_RECORD_KEY);
    assert.equal(record.payload.subject, 'E1001', `${platform}-${arch} readRecord`);

    // 2. identity projection (whoami shape)
    const session = sessionFromRecord(record);
    assert.equal(session.principal.subject, 'E1001', `${platform}-${arch} identity`);
    assert.equal(session.signedIn, true, `${platform}-${arch} signedIn`);

    // 3. access token projection (token command)
    const token = accessTokenOf(record);
    assert.equal(token.ok, true, `${platform}-${arch} token`);
    assert.equal(token.token, 'placeholder-access-token', `${platform}-${arch} token value`);

    // 4. second reader instance, as a separate process would open it
    const fresh = createKeychainProvider(createCredentialStore({ directory }), { service: 'heluo-forge', accountPrefix: 'iam' });
    cleanup.push(() => fresh.close());
    const again = await fresh.readRecord(SESSION_RECORD_KEY);
    assert.equal(again.payload.subject, 'E1001', `${platform}-${arch} reopen`);

    // 5. host service reads: getSession() and getAccessToken()
    const platformProvider = createKeychainProvider(createCredentialStore({ directory }), { service: 'heluo-forge', accountPrefix: 'iam' });
    cleanup.push(() => platformProvider.close());
    await platformProvider.modifyRecord(SESSION_RECORD_KEY, async () => seeded);
    const service = createIamService(config, { credentials: platformProvider });
    cleanup.push(() => service.dispose());
    await service.syncFromStore();
    const sessionRead = service.getSession();
    assert.deepEqual(sessionFromRecord(await platformProvider.readRecord(SESSION_RECORD_KEY)), sessionRead, `${platform}-${arch} CLI and host session`);
    assert.equal(sessionRead.signedIn, true, `${platform}-${arch} getSession`);
    assert.equal(sessionRead.principal.subject, 'E1001', `${platform}-${arch} getSession principal`);
    assert.doesNotMatch(JSON.stringify(sessionRead), /placeholder-access-token|placeholder-refresh-token/u, `${platform}-${arch} session has no token`);
    assert.equal(typeof (await service.getAccessToken()), 'string', `${platform}-${arch} getAccessToken`);

    // 6. HTTP reads: GET /api/forge-iam/session and POST /api/forge-iam/token
    const handler = createIamRoutes(service, {
      getConnection: () => ({ requestRejection: () => undefined }),
      getOrigin: () => 'http://127.0.0.1:4567',
      getBridgeSecret: () => 'placeholder-bridge-capability',
    });
    const httpSession = await callRoute(handler, 'GET', '/api/forge-iam/session');
    assert.equal(httpSession.statusCode, 200, `${platform}-${arch} GET session`);
    assert.deepEqual(httpSession.json(), JSON.parse(JSON.stringify(sessionRead)), `${platform}-${arch} GET session body`);
    assert.doesNotMatch(httpSession.text(), /placeholder-access-token|placeholder-refresh-token/u, `${platform}-${arch} HTTP session has no token`);
    const httpToken = await callRoute(handler, 'POST', '/api/forge-iam/token', { 'x-forge-iam-request': '1', 'content-type': 'application/json' });
    assert.equal(httpToken.statusCode, 200, `${platform}-${arch} POST token`);
    assert.equal(typeof httpToken.json().token, 'string', `${platform}-${arch} POST token body`);
    const bridge = await callRoute(handler, 'POST', '/api/forge-iam/bridge/token', { authorization: 'Bearer placeholder-bridge-capability' });
    assert.equal(bridge.statusCode, 200, `${platform}-${arch} bridge token`);
    assert.deepEqual(bridge.json(), httpToken.json(), `${platform}-${arch} bridge and same-origin token body`);
  }
});

test('credential key and authentication failures have the same safe token error across Host and HTTP surfaces', async (t) => {
  const { config } = await signedInRecord(t);
  for (const code of ['CRED_KEY_UNAVAILABLE', 'CRED_DECRYPT_FAILED']) await t.test(code, async (t) => {
    const credentials = new MemoryCredentials();
    credentials.readRecord = async () => { throw Object.assign(new Error('synthetic-secret-detail'), { code }); };
    const service = createIamService(config, { credentials });
    t.after(() => service.dispose());
    await assert.rejects(service.getAccessToken(), (error) => error.code === code && !error.message.includes('synthetic-secret-detail'));
    const handler = createIamRoutes(service, {
      getConnection: () => ({ requestRejection: () => undefined }),
      getBridgeSecret: () => 'placeholder-bridge-capability',
    });
    const session = await callRoute(handler, 'GET', '/api/forge-iam/session');
    assert.deepEqual(session.json(), JSON.parse(JSON.stringify(service.getSession())));
    assert.equal(session.json().status, 'error');
    for (const [url, headers] of [
      ['/api/forge-iam/token', { 'x-forge-iam-request': '1', 'content-type': 'application/json' }],
      ['/api/forge-iam/bridge/token', { authorization: 'Bearer placeholder-bridge-capability' }],
    ]) {
      const response = await callRoute(handler, 'POST', url, headers);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, code);
      assert.doesNotMatch(response.text(), /synthetic-secret-detail/);
    }
  });
});

test('an invalid stored grant has the same token error on CLI, Host and both HTTP paths', async (t) => {
  const { config, record } = await signedInRecord(t);
  const invalid = { ...record, payload: { ...record.payload, clientId: undefined } };
  const credentials = new MemoryCredentials();
  await credentials.modifyRecord(SESSION_RECORD_KEY, () => invalid);
  const service = createIamService(config, { credentials });
  t.after(() => service.dispose());
  assert.deepEqual(accessTokenOf(invalid), { ok: false, code: 'IAM_INVALID_GRANT' });
  await assert.rejects(service.getAccessToken(), { code: 'IAM_INVALID_GRANT' });
  const handler = createIamRoutes(service, {
    getConnection: () => ({ requestRejection: () => undefined }),
    getBridgeSecret: () => 'placeholder-bridge-capability',
  });
  for (const [url, headers] of [
    ['/api/forge-iam/token', { 'x-forge-iam-request': '1', 'content-type': 'application/json' }],
    ['/api/forge-iam/bridge/token', { authorization: 'Bearer placeholder-bridge-capability' }],
  ]) {
    const response = await callRoute(handler, 'POST', url, headers);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'IAM_INVALID_GRANT');
  }
});
