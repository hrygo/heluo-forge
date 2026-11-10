// #120 AC: when one process signs out, a peer that still holds the same
// authorization must refuse new work. The store is a shared file; the two
// services are separate processes, so no in-process epoch can explain it.
//
// Honest limits: the IdP is a local mock, and this proves local invalidation
// propagation, not that the enterprise IAM revoked the grant server-side.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { FileCredentials } from './support/file-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const WORKER = fileURLToPath(new URL('./support/session-worker.mjs', import.meta.url));

function configFor(mock) {
  return validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
  }).value;
}

function worker(dir, config, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, '--dir', dir, '--config', JSON.stringify(config), '--mode', mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ exitCode: code, ...JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`worker produced no JSON (exit ${code}): ${stderr.slice(0, 200)}`));
      }
    });
  });
}

async function signIn(t) {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-signout-'));
  const config = configFor(mock);
  const credentials = new FileCredentials(directory);
  const service = createIamService(config, { credentials });
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  await service.handleCallback(response.headers.get('location'));
  return { service, directory, config };
}

test('a peer process refuses new work after another process signs out', async (t) => {
  const { service, directory, config } = await signIn(t);

  assert.equal(typeof await service.resolveToken(), 'string');
  const peerBefore = await worker(directory, config, 'token');
  assert.equal(peerBefore.ok, true);

  const signingOut = await worker(directory, config, 'sign-out');
  assert.equal(signingOut.ok, true);
  assert.ok(['ok', 'failed', 'unknown', 'skipped'].includes(signingOut.revocation));
  assert.equal(signingOut.signedIn, false);
  assert.doesNotMatch(JSON.stringify(signingOut), /eyJ/u);

  await assert.rejects(service.resolveToken(), (error) => {
    assert.ok(['IAM_NOT_SIGNED_IN', 'IAM_REAUTH_REQUIRED'].includes(error.code), `unexpected ${error.code}`);
    return true;
  });

  // A fresh process that never held the session must also be refused, so the
  // result cannot be explained by the first service's own cache.
  const peerAfter = await worker(directory, config, 'token');
  assert.equal(peerAfter.ok, false);
  assert.equal(peerAfter.code, 'IAM_NOT_SIGNED_IN');

  await service.syncFromStore();
  const view = service.getView();
  assert.equal(view.signedIn, false);
  assert.equal(view.principal, null);
});
