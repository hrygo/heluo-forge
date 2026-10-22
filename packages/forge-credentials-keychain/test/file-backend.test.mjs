import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBackend } from '../src/backend.mjs';
import { createKeychainProvider } from '../src/provider.mjs';
import { apply, KeychainProviderError } from '../src/index.mjs';

async function tempFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-keychain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'credentials.json');
}

test('the file backend round-trips and writes mode 0600', async (t) => {
  const path = await tempFile(t);
  const backend = createFileBackend({ path });
  await backend.set('heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN', 'placeholder');
  assert.equal(await backend.get('heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN'), 'placeholder');
  assert.deepEqual(await backend.list('heluo-forge/iam/'), ['heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await backend.delete('heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN');
  assert.equal(await backend.get('heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN'), undefined);
});

test('a corrupt file fails closed instead of reading as empty', async (t) => {
  const path = await tempFile(t);
  await writeFile(path, '{');
  const backend = createFileBackend({ path });
  await assert.rejects(
    () => backend.get('anything'),
    (error) => error.code === 'KEYCHAIN_FILE_CORRUPT',
  );
});

test('the plugin refuses a file backend unless explicitly allowed', async (t) => {
  const path = await tempFile(t);
  const ctx = {
    get() { return undefined; },
    provide() { return () => {}; },
    effect(callback) { return callback(); },
  };
  assert.throws(
    () => apply(ctx, { filePath: path }),
    (error) => error instanceof KeychainProviderError && error.code === 'KEYCHAIN_INSECURE_FILE_REFUSED',
  );
});

test('the plugin registers the file backend with explicit opt-in', async (t) => {
  const path = await tempFile(t);
  let provided;
  const ctx = {
    get() { return undefined; },
    provide(name, value) { if (name === 'credentials') provided = value; return () => {}; },
    effect(callback) { return callback(); },
  };
  const dispose = apply(ctx, { filePath: path, allowInsecureFile: true });
  assert.ok(provided);
  await provided.set('ENTERPRISE_ACCESS_TOKEN', 'placeholder');
  assert.equal((await provided.resolve('ENTERPRISE_ACCESS_TOKEN')).value, 'placeholder');
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.entries['heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN']);
  dispose();
});
test('two provider instances serialize a cross-process-style read-modify-write', async (t) => {
  const path = await tempFile(t);
  const first = createKeychainProvider(createFileBackend({ path }));
  const second = createKeychainProvider(createFileBackend({ path }));
  await first.modifyRecord('heluo-iam/session', async () => ({
    kind: 'grant', payload: { version: 1, count: 0 },
  }));
  const bump = (current) => ({
    kind: 'grant', payload: { version: 1, count: (current?.payload?.count ?? 0) + 1 },
  });
  await Promise.all([
    first.modifyRecord('heluo-iam/session', bump),
    second.modifyRecord('heluo-iam/session', bump),
  ]);
  const record = await first.readRecord('heluo-iam/session');
  assert.equal(record.payload.count, 2);
});
test('the file backend rejects a relative path', () => {
  assert.throws(
    () => createFileBackend({ path: 'relative-credentials.json' }),
    (error) => error.code === 'KEYCHAIN_PATH_REQUIRED',
  );
});
test('concurrent writes to different keys do not clobber the JSON document', async (t) => {
  const path = await tempFile(t);
  const first = createKeychainProvider(createFileBackend({ path }));
  const second = createKeychainProvider(createFileBackend({ path }));
  await Promise.all([
    first.modifyRecord('heluo-iam/one', async () => ({ kind: 'grant', payload: { version: 1, n: 1 } })),
    second.modifyRecord('heluo-iam/two', async () => ({ kind: 'grant', payload: { version: 1, n: 2 } })),
  ]);
  assert.equal((await first.readRecord('heluo-iam/one')).payload.n, 1);
  assert.equal((await first.readRecord('heluo-iam/two')).payload.n, 2);
});
