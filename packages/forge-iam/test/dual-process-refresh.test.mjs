// Cross-process refresh behaviour for #13 AC3 / plan P0-4. Two operating-system
// processes share one credential store (a locked JSON file standing in for the
// keychain), and the assertions are about what the IdP sees and what the store
// ends up holding — not about in-process promise sharing.
//
// Honest limits: the store is a test double, the IdP is a local mock, and the
// 5s bound is the service's own REFRESH_TIMEOUT_MS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIamService } from '../src/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { FileCredentials } from './support/file-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const WORKER = fileURLToPath(new URL('./support/refresh-worker.mjs', import.meta.url));
const RECORD_KEY = 'heluo-iam/session';

function configFor(mock, overrides = {}) {
  return validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  }).value;
}

async function signIn(dir, config) {
  const credentials = new FileCredentials(dir);
  const service = createIamService(config, { credentials });
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const view = await service.handleCallback(response.headers.get('location'));
  assert.equal(view.state, 'ready');
  return credentials;
}

/** Force the stored access token to look expired without touching the refresh token. */
async function expireAccessToken(credentials) {
  await credentials.modifyRecord(RECORD_KEY, (current) => ({
    ...current,
    payload: { ...current.payload, accessExpiresAt: new Date(Date.now() - 60_000).toISOString() },
  }));
}

async function storedGrant(credentials) {
  return (await credentials.readRecord(RECORD_KEY))?.payload;
}

function runWorker(dir, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER, '--dir', dir, '--config', JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ exitCode: code, ...JSON.parse(stdout) });
      } catch {
        reject(new Error(`worker produced no JSON (exit ${code}): ${stdout} ${stderr}`.slice(0, 800)));
      }
    });
  });
}

test('two processes refresh once and share the rotated grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-dual-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  assert.equal(mock.counts.refresh, 0);

  const results = await Promise.all([runWorker(dir, config), runWorker(dir, config)]);

  for (const result of results) {
    assert.equal(result.ok, true, `worker failed: ${JSON.stringify(result)}`);
    assert.equal(result.state, 'ready');
    assert.equal(result.hasToken, true);
  }
  assert.equal(mock.counts.refresh, 1, 'the IdP must see exactly one refresh for two processes');
  const after = await storedGrant(credentials);
  assert.notEqual(after.refreshToken, before.refreshToken, 'the store must hold the rotated token');
  assert.equal(mock.refreshTokens.has(after.refreshToken), true, 'the stored token must be the live one');
  assert.equal(mock.refreshTokens.has(before.refreshToken), false, 'the old token must be consumed');
});

test('a refresh that exceeds five seconds fails instead of hanging', async (t) => {
  const mock = await startMockOidc({ refreshDelayMs: 8000 });
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-slow-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);
  mock.control.refreshDelayMs = 8000;

  const result = await runWorker(dir, config);

  assert.equal(result.ok, false, 'the refresh must not succeed past the bound');
  assert.ok(result.elapsedMs >= 4500, `gave up too early: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 7000, `did not respect the 5s bound: ${result.elapsedMs}ms`);
  const after = await storedGrant(credentials);
  assert.equal(after.refreshToken, before.refreshToken, 'a timed-out refresh must not change the stored grant');
});

test('a lost refresh response forces a new sign-in', async (t) => {
  const mock = await startMockOidc({ dropRefreshResponse: true });
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-lost-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  await expireAccessToken(credentials);
  const before = await storedGrant(credentials);

  // The IdP rotates the refresh token and then drops the connection, so this
  // process still holds a token the IdP has already invalidated.
  const lost = await runWorker(dir, config);
  assert.equal(lost.ok, false, 'the dropped response must not be reported as success');
  assert.equal(lost.state !== 'ready', true);
  const stillOld = await storedGrant(credentials);
  assert.equal(stillOld.refreshToken, before.refreshToken, 'the store cannot hold a token it never received');
  assert.equal(mock.refreshTokens.has(before.refreshToken), false, 'the IdP already consumed it');

  mock.control.dropRefreshResponse = false;
  const retry = await runWorker(dir, config);
  assert.equal(retry.ok, false, 'a consumed refresh token cannot be replayed');
  assert.equal(retry.code, 'IAM_REAUTH_REQUIRED');
  assert.notEqual(retry.state, 'ready');
  const cleared = await credentials.readRecord(RECORD_KEY);
  assert.equal(cleared, undefined, 'the unusable session must be cleared so the UI asks for sign-in');

  // A fresh browser sign-in recovers on the same store.
  const recovered = await signIn(dir, config);
  assert.equal(mock.counts.refresh, 1, 'only the first, response-lost attempt reached the refresh branch');
  assert.equal((await storedGrant(recovered)).subject, before.subject);
});

test('the shared store file never holds the authorization code or verifier', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const dir = await mkdtemp(join(tmpdir(), 'iam-atrest-'));
  const config = configFor(mock);
  const credentials = await signIn(dir, config);
  const raw = await readFile(join(dir, 'records.json'), 'utf8');
  const payload = JSON.parse(raw)[RECORD_KEY].payload;
  assert.equal(payload.version, 1);
  for (const forbidden of ['code', 'verifier', 'codeVerifier', 'attempt', 'nonce']) {
    assert.equal(forbidden in payload, false, `the grant record must not carry ${forbidden}`);
  }
  assert.equal(raw.includes('code_verifier'), false);
});
