import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { accessTokenOf } from '../src/cli-session.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';

const grant = {
  version: 1, issuer: 'https://iam.corp.example', subject: 'synthetic-old-user', clientId: 'test',
  refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
  obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z',
};
const options = { verifyAtomicStore: () => true };

function open(directory) {
  const backend = createCredentialStore({ directory });
  const credentials = createKeychainProvider(backend);
  return { backend, credentials, store: createGrantStore(credentials, options) };
}

test('SQLite restart fences sign-out interrupted during revoke and preserves a new login', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-crash-'));
  const cleanups = [];
  const own = (cleanup) => cleanups.push(cleanup);
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(directory, { recursive: true, force: true });
  });
  const first = open(directory);
  own(() => first.backend.close());
  await first.store.write(grant);
  await first.backend.close();

  const script = `
    import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
    import { createGrantStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const backend = createCredentialStore({ directory: process.argv[1] });
    const store = createGrantStore(createKeychainProvider(backend), { verifyAtomicStore: () => true });
    await store.signOutSnapshot(${JSON.stringify(grant)}, async () => {
      process.send('revoke-entered');
      await new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolve) => {
    let error;
    child.once('error', (cause) => { error = cause; });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
  own(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await closed;
    if (result.error) throw result.error;
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = once(child, 'exit');
  const message = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const result = await Promise.race([
    message.then(([value]) => ({ value })),
    ended.then(([code, signal]) => ({ code, signal })),
  ]);
  assert.equal(result.value, 'revoke-entered', `child ended before callback: ${stderr}`);
  assert.equal(child.kill('SIGKILL'), true);
  const [, signal] = await ended;
  assert.equal(signal, 'SIGKILL');

  const reopened = open(directory);
  own(() => reopened.backend.close());
  const pending = await reopened.credentials.readRecord(GRANT_KEY);
  assert.equal(pending.payload.signOutOperation.state, 'pending');
  assert.deepEqual(await reopened.store.read(), { ok: false, reason: 'sign-out-pending' });
  assert.deepEqual(accessTokenOf(pending), { ok: false, code: 'IAM_INVALID_GRANT' });
  let callbacks = 0;
  assert.deepEqual(await reopened.store.signOutSnapshot(grant, async () => { callbacks++; }), { ok: true, decision: 'pending' });
  assert.equal(callbacks, 0);

  const replacement = { ...grant, subject: 'synthetic-new-user', accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh' };
  await reopened.store.write(replacement);
  assert.deepEqual((await reopened.store.read()).grant, replacement);
  assert.deepEqual(await reopened.store.signOutSnapshot(grant, async () => { callbacks++; }), { ok: true, decision: 'replaced' });
  assert.equal(callbacks, 0);
  assert.deepEqual((await reopened.store.read()).grant, replacement);
});
