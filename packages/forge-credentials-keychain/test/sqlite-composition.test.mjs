import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { apply, openCredentialReader, validateConfig } from '../src/index.mjs';
import { createMemoryBackend } from '../src/backend.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

function ownDirectory(t, directory) {
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(directory, { recursive: true, force: true });
  });
  return (cleanup) => cleanups.push(cleanup);
}

function context() {
  const provided = new Map();
  return {
    provided,
    get(name) { return provided.get(name); },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
    effect(callback) { return callback(); },
  };
}

test('plugin and read-only reader use the same namespace and durable store', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-credentials-composition-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const ctx = context();
  const dispose = apply(ctx, { storeDirectory: directory });
  own(dispose);
  const credentials = ctx.provided.get('credentials');
  await credentials.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: { subject: 'E1001' } }));
  await credentials.set('ENTERPRISE_STATIC_KEY', 'synthetic-key');
  const reader = await openCredentialReader({ directory });
  own(() => reader.close());
  assert.deepEqual(await reader.readRecord('heluo-iam/session'), { kind: 'grant', payload: { subject: 'E1001' } });
  assert.deepEqual(await reader.resolve('ENTERPRISE_STATIC_KEY'), { value: 'synthetic-key', source: 'file' });
  assert.deepEqual(await credentials.describe('ENTERPRISE_STATIC_KEY'), { configured: true, source: 'file', writable: true });
  assert.equal(reader.set, undefined);
  assert.equal(ctx.provided.get('iam-atomic-store').verify(credentials), true);
  assert.equal(ctx.provided.get('iam-atomic-store').verify({}), false);
  await reader.close();
});

test('a backend cannot grant itself trust by claiming atomic capabilities', async (t) => {
  const ctx = context();
  const backend = Object.assign(createMemoryBackend(), {
    durable: true,
    transaction: async () => {},
    snapshot: async () => ({}),
    compareAndSwap: async () => ({ ok: true }),
  });
  const dispose = apply(ctx, { backend, allowEphemeral: true });
  t.after(dispose);
  assert.equal(ctx.provided.has('iam-atomic-store'), false);
  await dispose();
});

test('legacy backend configuration is rejected instead of silently changing its meaning', () => {
  for (const config of [
    { filePath: '/tmp/legacy-test.json', allowInsecureFile: true },
    { platformAdapter: 'native-keyring', allowUnvettedPlatformAdapter: true },
  ]) assert.ok('issues' in validateConfig(config));
});

test('CLI reopens the same sqlite session in a fresh process without changing it', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-cli-sqlite-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const ctx = context();
  const dispose = apply(ctx, { storeDirectory: directory });
  own(dispose);
  const credentials = ctx.provided.get('credentials');
  await credentials.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: {
    version: 1, sessionInstanceId: Buffer.alloc(32, 1).toString('base64url'),
    clientId: 'fixture', scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z',
    subject: 'E1001', issuer: 'https://iam.corp.example', refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access-token', accessExpiresAt: '2099-01-01T00:00:00.000Z',
  } }));
  await dispose();
  const executable = fileURLToPath(new URL('../../forge-iam/bin/heluo-forge.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [executable, 'auth', 'token'], {
    encoding: 'utf8', env: { HELUO_FORGE_STORE_DIRECTORY: directory },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'synthetic-access-token\n');
});
