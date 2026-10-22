import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBackend } from '../src/backend.mjs';
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
