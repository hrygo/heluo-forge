// Step 2/3 of DESIGN-002 §5.5 for the CLI path: read identity and an unexpired
// token from the store, never refresh, and fail loudly when the token is stale.
// The store is a real file-backend document written through the keychain
// package, so the CLI and the IAM service agree on the record format.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFileBackend, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { accessTokenOf, SESSION_RECORD_KEY, sessionFromRecord } from '../src/cli-session.mjs';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));

function grant(overrides = {}) {
  return {
    kind: 'grant',
    payload: {
      issuer: 'https://iam.corp.example',
      subject: 'E1001',
      scope: 'openid profile',
      accessToken: 'placeholder-access-token',
      refreshToken: 'placeholder-refresh-token',
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    },
  };
}

async function storeWith(t, record) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-cli-'));
  const path = join(directory, 'credentials.json');
  const provider = createKeychainProvider(createFileBackend({ path }));
  if (record) await provider.modifyRecord(SESSION_RECORD_KEY, async () => record);
  return path;
}

function cli(path, ...args) {
  return run(process.execPath, [BIN, 'auth', ...args], {
    env: { ...process.env, HELUO_FORGE_CREDENTIALS_FILE: path },
  });
}

test('the store record projects onto the session shape without tokens', () => {
  const session = sessionFromRecord(grant());
  assert.equal(session.status, 'ready');
  assert.equal(session.signedIn, true);
  assert.deepEqual(session.principal, { issuer: 'https://iam.corp.example', subject: 'E1001' });
  assert.equal(session.scope, 'openid profile');
  assert.doesNotMatch(JSON.stringify(session), /placeholder-access-token|placeholder-refresh-token/u);

  const signedOut = sessionFromRecord(undefined);
  assert.equal(signedOut.status, 'signed-out');
  assert.equal(signedOut.principal, undefined);
});

test('an expired or unknown-expiry token is refused rather than returned', () => {
  const now = Date.now();
  assert.deepEqual(accessTokenOf(grant({ accessExpiresAt: new Date(now - 1000).toISOString() }), now), {
    ok: false,
    code: 'IAM_REAUTH_REQUIRED',
  });
  assert.deepEqual(accessTokenOf(grant({ accessExpiresAt: undefined }), now), { ok: false, code: 'IAM_EXPIRY_UNKNOWN' });
  assert.deepEqual(accessTokenOf(undefined, now), { ok: false, code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(accessTokenOf(grant(), now).token, 'placeholder-access-token');
});

test('heluo-forge auth whoami prints identity, and token prints the unexpired token', async (t) => {
  const path = await storeWith(t, grant());

  const whoami = await cli(path, 'whoami', '--json');
  const session = JSON.parse(whoami.stdout);
  assert.equal(session.principal.subject, 'E1001');
  assert.equal(session.signedIn, true);
  assert.doesNotMatch(whoami.stdout, /placeholder-access-token/u);

  const token = await cli(path, 'token');
  assert.equal(token.stdout.trim(), 'placeholder-access-token');
});

test('heluo-forge auth token fails with a distinct exit code when the token expired', async (t) => {
  const path = await storeWith(t, grant({ accessExpiresAt: new Date(Date.now() - 60_000).toISOString() }));
  await assert.rejects(cli(path, 'token'), (error) => {
    assert.equal(error.code, 3);
    assert.match(String(error.stderr), /IAM_REAUTH_REQUIRED/u);
    assert.equal(String(error.stdout), '');
    return true;
  });
});

test('heluo-forge auth whoami reports a signed-out store without inventing identity', async (t) => {
  const path = await storeWith(t, undefined);
  const result = await cli(path, 'whoami', '--json');
  const session = JSON.parse(result.stdout);
  assert.equal(session.status, 'signed-out');
  assert.equal(session.principal, undefined);
});
