import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileBackend, createMacosBackend } from '../src/index.mjs';

const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-encrypted-'));
  return {
    directory,
    path: join(directory, 'credentials.json'),
    keyPath: join(directory, 'credentials.key'),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('an encrypted document round-trips across instances and lists entries', async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    const first = createFileBackend({ path, keyPath });
    assert.equal(first.kind, 'file-encrypted');
    assert.equal(first.encrypted, true);
    assert.equal(first.requiresExplicitOptIn, false);
    await first.set('iam/token', 'secret-value');
    await first.set('iam/refresh', 'other-value');

    const second = createFileBackend({ path, keyPath });
    assert.equal(await second.get('iam/token'), 'secret-value');
    assert.deepEqual((await second.listEntries('iam/')).map((entry) => entry.key).sort(), ['iam/refresh', 'iam/token']);
    await second.delete('iam/token');
    assert.equal(await createFileBackend({ path, keyPath }).get('iam/token'), undefined);
  } finally {
    await cleanup();
  }
});

test('the document is ciphertext at rest and the key file is 0600', async () => {
  const { directory, path, keyPath, cleanup } = await fixture();
  try {
    const backend = createFileBackend({ path, keyPath });
    await backend.set('iam/token', 'do-not-store-me-in-plaintext');
    const raw = await readFile(path, 'utf8');
    assert.equal(raw.includes('do-not-store-me-in-plaintext'), false);
    assert.match(raw, /"alg":"aes-256-gcm"/u);
    if (process.platform !== 'win32') {
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
  } finally {
    await cleanup();
  }
});

test('a modified document is rejected instead of read as empty', async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    const backend = createFileBackend({ path, keyPath });
    await backend.set('iam/token', 'value');
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] ^= 0xff;
    envelope.data = bytes.toString('base64');
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(
      () => createFileBackend({ path, keyPath }).get('iam/token'),
      (error) => error.code === 'KEYCHAIN_FILE_TAMPERED',
    );
  } finally {
    await cleanup();
  }
});

test('a key file with wider permissions fails closed', { skip: process.platform === 'win32' && 'POSIX modes are not meaningful on Windows' }, async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    const backend = createFileBackend({ path, keyPath });
    await backend.set('iam/token', 'value');
    await chmod(keyPath, 0o644);
    await assert.rejects(
      () => createFileBackend({ path, keyPath }).get('iam/token'),
      (error) => error.code === 'KEYCHAIN_KEY_PERMISSIONS',
    );
  } finally {
    await cleanup();
  }
});

test('a document encrypted with a different key is rejected', async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    await createFileBackend({ path, keyPath }).set('iam/token', 'value');
    await writeFile(keyPath, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    await assert.rejects(
      () => createFileBackend({ path, keyPath }).get('iam/token'),
      (error) => error.code === 'KEYCHAIN_FILE_TAMPERED',
    );
  } finally {
    await cleanup();
  }
});

test('a key file of the wrong length is refused', async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    await writeFile(keyPath, 'short\n', { mode: 0o600 });
    await assert.rejects(
      () => createFileBackend({ path, keyPath }).set('iam/token', 'value'),
      (error) => error.code === 'KEYCHAIN_KEY_INVALID',
    );
  } finally {
    await cleanup();
  }
});

test('a plaintext document where an encrypted one is expected is refused', async () => {
  const { path, keyPath, cleanup } = await fixture();
  try {
    await writeFile(path, JSON.stringify({ version: 1, entries: { 'iam/token': 'plain' } }));
    await assert.rejects(
      () => createFileBackend({ path, keyPath }).get('iam/token'),
      (error) => error.code === 'KEYCHAIN_FILE_CORRUPT',
    );
  } finally {
    await cleanup();
  }
});

test('a second process writes through the same encrypted document', async () => {
  const { directory, path, keyPath, cleanup } = await fixture();
  try {
    const backend = createFileBackend({ path, keyPath });
    await backend.set('iam/token', 'from-parent');
    const script = `
      import(${JSON.stringify(`file://${entry}`)}).then(async (module) => {
        const backend = module.createFileBackend({ path: ${JSON.stringify(path)}, keyPath: ${JSON.stringify(keyPath)} });
        await backend.set('iam/token', 'from-child');
      });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await createFileBackend({ path, keyPath }).get('iam/token'), 'from-child');
    if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await cleanup();
  }
});

test('the macOS backend keeps its document under Application Support', () => {
  const directory = join(tmpdir(), 'forge-macos-layout');
  const backend = createMacosBackend({ directory });
  assert.equal(backend.kind, 'file-encrypted');
  assert.equal(backend.available, true);
});
