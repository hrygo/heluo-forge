// Four public read surfaces over the same SQLite session on the current host.
// Other operating systems and the Electron host require separate verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { SESSION_RECORD_KEY } from '../src/cli-session.mjs';
import { validateConfig } from '../src/config.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const bin = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));
const capability = 'fixture-bridge-capability';
const sessionHeaders = { 'x-fixture-auth': 'allowed' };
const tokenHeaders = { ...sessionHeaders, 'x-forge-iam-request': '1', 'content-type': 'application/json' };
const bridgeHeaders = { authorization: `Bearer ${capability}` };

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
  return { config, mock, record: await credentials.readRecord(SESSION_RECORD_KEY) };
}

async function fixture(t, transform = (record) => record) {
  const { config, mock, record } = await signedInRecord(t);
  const root = await mkdtemp(join(tmpdir(), 'forge-read-matrix-'));
  const directory = join(root, 'store');
  const provider = createKeychainProvider(createCredentialStore({ directory }));
  const cleanups = [() => provider.close()];
  t.after(async () => {
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'matrix fixture cleanup failed');
  });
  const stored = transform(record);
  if (stored !== undefined) await provider.modifyRecord(SESSION_RECORD_KEY, () => stored);
  await provider.set(BRIDGE_REF, capability);
  const service = createIamService(config, { credentials: provider });
  cleanups.push(() => service.dispose());
  await service.syncFromStore();
  const handler = createIamRoutes(service, {
    getConnection: () => ({
      requestRejection: ({ headers }) => headers['x-fixture-auth'] === 'allowed' ? undefined : 401,
    }),
    getBridgeSecret: () => capability,
  });
  const failures = [];
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => { failures.push(error); res.destroy(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  cleanups.push(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (failures.length) throw new AggregateError(failures, 'matrix HTTP handler failed');
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  function cli(args, useBridge = false) {
    const env = { ...process.env, HELUO_FORGE_STORE_DIRECTORY: directory, NODE_NO_WARNINGS: '1' };
    delete env.HELUO_FORGE_IAM_URL;
    delete env.HELUO_FORGE_KEYCHAIN_SERVICE;
    delete env.HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX;
    if (useBridge) env.HELUO_FORGE_IAM_URL = baseUrl;
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [bin, 'auth', ...args], { env, timeout: 5000 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    });
  }

  async function request(path, { method = 'GET', headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, { method, headers });
    const body = await response.text();
    return { status: response.status, json: JSON.parse(body), body };
  }
  return { cli, directory, mock, provider, record: stored, request, service };
}

function assertCliError(result, code, exit) {
  assert.equal(result.code, exit);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, code);
}

async function assertHttpError(response, code, status, secret) {
  assert.equal(response.status, status);
  assert.equal(response.json.error.code, code);
  if (secret) assert.doesNotMatch(response.body, new RegExp(secret, 'u'));
}

test('real CLI, Host and both HTTP endpoints expose the same identity and token with their existing envelopes', async (t) => {
  const f = await fixture(t);
  const whoami = await f.cli(['whoami', '--json']);
  assert.equal(whoami.code, 0, whoami.stderr);
  const hostSession = JSON.parse(JSON.stringify(f.service.getSession()));
  const httpSession = await f.request('/api/forge-iam/session', { headers: sessionHeaders });
  assert.equal(httpSession.status, 200);
  assert.deepEqual(JSON.parse(whoami.stdout), hostSession);
  assert.deepEqual(httpSession.json, hostSession);
  assert.equal(hostSession.signedIn, true);
  assert.equal(hostSession.principal.subject, 'E1001');
  for (const output of [whoami.stdout, JSON.stringify(hostSession), httpSession.body]) {
    assert.ok(!output.includes(f.record.payload.accessToken));
    assert.ok(!output.includes(f.record.payload.refreshToken));
  }

  const cliToken = await f.cli(['token']);
  const hostToken = await f.service.getAccessToken();
  const sameOrigin = await f.request('/api/forge-iam/token', { method: 'POST', headers: tokenHeaders });
  const bridge = await f.request('/api/forge-iam/bridge/token', { method: 'POST', headers: bridgeHeaders });
  const bridgeCli = await f.cli(['token'], true);
  assert.equal(cliToken.code, 0, cliToken.stderr);
  assert.equal(bridgeCli.code, 0, bridgeCli.stderr);
  assert.equal(typeof hostToken, 'string');
  assert.equal(hostToken, f.record.payload.accessToken);
  assert.equal(cliToken.stdout, `${hostToken}\n`);
  assert.equal(bridgeCli.stdout, `${hostToken}\n`);
  for (const response of [sameOrigin, bridge]) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { token: hostToken, expiresAt: hostSession.accessExpiresAt });
  }
  assert.equal(f.mock.counts.refresh, 0);
});

for (const [name, transform, code, exit] of [
  ['signed out', () => undefined, 'IAM_NOT_SIGNED_IN', 2],
  ['signed-out tombstone', () => ({ kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } }), 'IAM_NOT_SIGNED_IN', 2],
  ['invalid grant', (record) => ({ ...record, payload: { ...record.payload, clientId: undefined } }), 'IAM_INVALID_GRANT', 3],
  ['pending sign-out', (record) => ({ ...record, payload: { ...record.payload, signOutOperation: {
    version: 1, state: 'pending', id: Buffer.alloc(32, 42).toString('base64url'),
  } } }), 'IAM_INVALID_GRANT', 3],
  ['expired access and refresh', (record) => ({ ...record, payload: { ...record.payload,
    accessExpiresAt: '2020-01-01T00:00:00.000Z', refreshExpiresAt: '2020-01-01T00:00:00.000Z',
  } }), 'IAM_REAUTH_REQUIRED', 3],
]) test(`${name} rejects token on all four surfaces with the same code`, async (t) => {
  const f = await fixture(t, transform);
  assertCliError(await f.cli(['token', '--json']), code, exit);
  assertCliError(await f.cli(['token', '--json'], true), code, exit);
  await assert.rejects(f.service.getAccessToken(), { code });
  await assertHttpError(await f.request('/api/forge-iam/token', { method: 'POST', headers: tokenHeaders }), code, 401);
  await assertHttpError(await f.request('/api/forge-iam/bridge/token', { method: 'POST', headers: bridgeHeaders }), code, 401);
  assert.equal(f.mock.counts.refresh, 0);
});

for (const [field, value] of [
  ['issuer', 'https://other.corp.example'],
  ['clientId', 'other-client'],
  ['resource', 'https://other-resource.corp.example'],
]) test(`Host and bridge reject mismatched ${field}; offline CLI has no Host configuration`, async (t) => {
  const f = await fixture(t, (record) => ({
    ...record, payload: { ...record.payload, [field]: value },
  }));
  const code = 'IAM_GRANT_CONTEXT_MISMATCH';
  await assert.rejects(f.service.getAccessToken(), { code });
  for (const [path, headers] of [
    ['/api/forge-iam/token', tokenHeaders],
    ['/api/forge-iam/bridge/token', bridgeHeaders],
  ]) {
    await assertHttpError(await f.request(path, { method: 'POST', headers }), code, 401);
  }
  assertCliError(await f.cli(['token', '--json'], true), code, 4);
  const offline = await f.cli(['token', '--json']);
  assert.equal(offline.code, 0, offline.stderr);
  assert.equal(offline.stdout, `${f.record.payload.accessToken}\n`);
});

test('each HTTP token endpoint enforces its own admission rule before returning a token', async (t) => {
  const f = await fixture(t);
  await assertHttpError(await f.request('/api/forge-iam/session'), 'IAM_UNAUTHENTICATED', 401, f.record.payload.accessToken);
  await assertHttpError(await f.request('/api/forge-iam/token', { method: 'POST', headers: {
    'x-forge-iam-request': '1', 'content-type': 'application/json',
  } }), 'IAM_UNAUTHENTICATED', 401, f.record.payload.accessToken);
  await assertHttpError(await f.request('/api/forge-iam/token', { method: 'POST', headers: sessionHeaders }),
    'IAM_REQUEST_HEADER_REQUIRED', 403, f.record.payload.accessToken);
  await assertHttpError(await f.request('/api/forge-iam/bridge/token', { method: 'POST', headers: {
    authorization: 'Bearer wrong-capability',
  } }), 'IAM_BRIDGE_UNAUTHORIZED', 401, f.record.payload.accessToken);
  const allowed = await f.request('/api/forge-iam/bridge/token', { method: 'POST', headers: bridgeHeaders });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.token, f.record.payload.accessToken);
});

for (const [name, code] of [
  ['missing keyring', 'CRED_KEY_UNAVAILABLE'],
  ['wrong key', 'CRED_DECRYPT_FAILED'],
]) test(`${name} rejects CLI, Host and both HTTP reads without disclosing tokens`, async (t) => {
  const f = await fixture(t);
  const keyPath = join(`${f.directory}.keys`, 'keyring.json');
  if (code === 'CRED_KEY_UNAVAILABLE') {
    await rename(keyPath, join(`${f.directory}.keys`, 'saved-keyring.json'));
  } else {
    const keyring = JSON.parse(await readFile(keyPath, 'utf8'));
    const key = Buffer.from(keyring.keys[keyring.active], 'base64');
    key[0] ^= 1;
    keyring.keys[keyring.active] = key.toString('base64');
    await writeFile(keyPath, JSON.stringify(keyring), { mode: 0o600 });
  }
  for (const bridge of [false, true]) {
    const result = await f.cli(['token', '--json'], bridge);
    assertCliError(result, code, 4);
    assert.ok(!result.stderr.includes(f.record.payload.accessToken));
    assert.ok(!result.stderr.includes(f.record.payload.refreshToken));
  }
  await assert.rejects(f.service.getAccessToken(), (error) => error.code === code
    && !error.message.includes(f.record.payload.accessToken) && !error.message.includes(f.record.payload.refreshToken));
  for (const [path, headers] of [
    ['/api/forge-iam/token', tokenHeaders],
    ['/api/forge-iam/bridge/token', bridgeHeaders],
  ]) {
    const response = await f.request(path, { method: 'POST', headers });
    await assertHttpError(response, code, 503, f.record.payload.accessToken);
    assert.ok(!response.body.includes(f.record.payload.refreshToken));
  }
});

for (const code of ['CRED_KEY_UNAVAILABLE', 'CRED_DECRYPT_FAILED']) {
  test(`Host and HTTP redact the underlying ${code} failure detail`, async (t) => {
    const f = await fixture(t);
    f.provider.readRecord = async () => {
      throw Object.assign(new Error('synthetic-secret-detail'), { code });
    };
    await assert.rejects(f.service.getAccessToken(), (error) => error.code === code
      && !error.message.includes('synthetic-secret-detail'));
    const session = await f.request('/api/forge-iam/session', { headers: sessionHeaders });
    assert.deepEqual(session.json, JSON.parse(JSON.stringify(f.service.getSession())));
    assert.equal(session.json.status, 'error');
    for (const [path, headers] of [
      ['/api/forge-iam/token', tokenHeaders],
      ['/api/forge-iam/bridge/token', bridgeHeaders],
    ]) {
      const response = await f.request(path, { method: 'POST', headers });
      await assertHttpError(response, code, 503, 'synthetic-secret-detail');
    }
  });
}

test('offline CLI never refreshes an expired token; only Host refreshes for the bridge', async (t) => {
  const f = await fixture(t);
  // Simulate expiration after Host hydration so its background reconciliation
  // cannot race the offline CLI before the assertion.
  await f.provider.modifyRecord(SESSION_RECORD_KEY, (record) => ({
    ...record, payload: { ...record.payload, accessExpiresAt: '2020-01-01T00:00:00.000Z' },
  }));
  const before = await f.provider.readRecord(SESSION_RECORD_KEY);
  assertCliError(await f.cli(['token', '--json']), 'IAM_REAUTH_REQUIRED', 3);
  assert.deepEqual(await f.provider.readRecord(SESSION_RECORD_KEY), before);
  assert.equal(f.mock.counts.refresh, 0);

  const fromBridge = await f.cli(['token'], true);
  assert.equal(fromBridge.code, 0, fromBridge.stderr);
  const refreshed = await f.provider.readRecord(SESSION_RECORD_KEY);
  assert.equal(f.mock.counts.refresh, 1);
  assert.notEqual(refreshed.payload.accessToken, before.payload.accessToken);
  assert.equal(fromBridge.stdout, `${refreshed.payload.accessToken}\n`);
  assert.equal((await f.cli(['token'])).stdout, fromBridge.stdout);
  assert.equal(await f.service.getAccessToken(), refreshed.payload.accessToken);
  for (const [path, headers] of [
    ['/api/forge-iam/token', tokenHeaders],
    ['/api/forge-iam/bridge/token', bridgeHeaders],
  ]) {
    const response = await f.request(path, { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.equal(response.json.token, refreshed.payload.accessToken);
  }
  assert.equal(f.mock.counts.refresh, 1);
});
