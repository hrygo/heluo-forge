// Read paths × platform matrix. The backend contract is the same everywhere:
// a native addon on Windows/Linux (injected here so every platform-arch runs on
// any host) and the encrypted document on macOS. Each platform-arch must serve
// every read path that scripts and the host use, not just the one that happens
// to be easy to test on this machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKeychainProvider,
  createMacosBackend,
  createNativeKeyringBackend,
} from '@heluo/forge-credentials-keychain';
import { createIamRoutes } from '../src/routes.mjs';
import { validateConfig } from '../src/config.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { SESSION_RECORD_KEY, accessTokenOf, sessionFromRecord } from '../src/cli-session.mjs';

const PLATFORMS = [
  ['win32', 'x64'],
  ['win32', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
];

function fakeNativeModule() {
  const entries = new Map();
  class Entry {
    constructor(_service, account, _options) {
      this.account = account;
    }
    getPassword() {
      return entries.has(this.account) ? entries.get(this.account) : null;
    }
    setPassword(value) {
      entries.set(this.account, value);
    }
    deletePassword() {
      return entries.delete(this.account);
    }
  }
  return { Entry };
}

const grant = {
  kind: 'grant',
  payload: {
    issuer: 'https://iam.corp.example',
    subject: 'E1001',
    scope: 'openid profile',
    accessToken: 'placeholder-access-token',
    refreshToken: 'placeholder-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  },
};

const nativeStores = new Map();

function backendFor(platform, arch, directory) {
  if (platform === 'darwin') return createMacosBackend({ directory });
  const id = `${platform}-${arch}`;
  if (!nativeStores.has(id)) nativeStores.set(id, fakeNativeModule());
  return createNativeKeyringBackend({
    service: 'heluo-forge',
    platform,
    arch,
    vetted: true,
    load: () => nativeStores.get(id),
  });
}

async function signedInRecord(t) {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const config = validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
  }).value;
  const credentials = new MemoryCredentials();
  const service = createIamService(config, { credentials });
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

test('every read path works on every delivered platform-arch', async (t) => {
  const { config, record: seeded } = await signedInRecord(t);
  for (const [platform, arch] of PLATFORMS) {
    const directory = platform === 'darwin' ? await mkdtemp(join(tmpdir(), `forge-read-${platform}-${arch}-`)) : undefined;
    t.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
    const backend = backendFor(platform, arch, directory);
    assert.equal(backend.available, true, `${platform}-${arch} backend`);
    const provider = createKeychainProvider(backend, { service: 'heluo-forge', accountPrefix: 'iam' });
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
    const fresh = createKeychainProvider(backendFor(platform, arch, directory), { service: 'heluo-forge', accountPrefix: 'iam' });
    const again = await fresh.readRecord(SESSION_RECORD_KEY);
    assert.equal(again.payload.subject, 'E1001', `${platform}-${arch} reopen`);

    // 5. host service reads: getSession() and getAccessToken()
    const platformProvider = createKeychainProvider(backendFor(platform, arch, directory), { service: 'heluo-forge', accountPrefix: 'iam' });
    await platformProvider.modifyRecord(SESSION_RECORD_KEY, async () => seeded);
    const service = createIamService(config, { credentials: platformProvider });
    await service.syncFromStore();
    const sessionRead = service.getSession();
    assert.equal(sessionRead.signedIn, true, `${platform}-${arch} getSession`);
    assert.equal(sessionRead.principal.subject, 'E1001', `${platform}-${arch} getSession principal`);
    assert.doesNotMatch(JSON.stringify(sessionRead), /placeholder-access-token|placeholder-refresh-token/u, `${platform}-${arch} session has no token`);
    assert.equal(typeof (await service.getAccessToken()), 'string', `${platform}-${arch} getAccessToken`);

    // 6. HTTP reads: GET /api/forge-iam/session and POST /api/forge-iam/token
    const handler = createIamRoutes(service, {
      getConnection: () => ({ requestRejection: () => undefined }),
      getOrigin: () => 'http://127.0.0.1:4567',
    });
    const httpSession = await callRoute(handler, 'GET', '/api/forge-iam/session');
    assert.equal(httpSession.statusCode, 200, `${platform}-${arch} GET session`);
    assert.equal(httpSession.json().principal.subject, 'E1001', `${platform}-${arch} GET session body`);
    assert.doesNotMatch(httpSession.text(), /placeholder-access-token|placeholder-refresh-token/u, `${platform}-${arch} HTTP session has no token`);
    const httpToken = await callRoute(handler, 'POST', '/api/forge-iam/token', { 'x-forge-iam-request': '1', 'content-type': 'application/json' });
    assert.equal(httpToken.statusCode, 200, `${platform}-${arch} POST token`);
    assert.equal(typeof httpToken.json().token, 'string', `${platform}-${arch} POST token body`);
  }
});
