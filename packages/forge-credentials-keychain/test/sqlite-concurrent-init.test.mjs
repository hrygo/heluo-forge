import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendUrl = new URL('../src/sqlite-backend.mjs', import.meta.url).href;
const keyringUrl = new URL('../src/keyring.mjs', import.meta.url).href;
const source = `import { createSqliteBackend } from ${JSON.stringify(backendUrl)};
import { createFileKeyProvider } from ${JSON.stringify(keyringUrl)};
import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[1], role = process.argv[2];
const keyProvider = createFileKeyProvider({ path: join(dir, 'keyring.json') });
const keys = role === 'first' ? { ...keyProvider, initialize(kid) {
  writeSync(1, 'initializing\\n');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(dir, 'release'))) Atomics.wait(wait, 0, 0, 5);
  keyProvider.initialize(kid);
}} : keyProvider;
const db = createSqliteBackend({ directory: dir, keyProvider: keys, readOnly: false, lockTimeoutMs: 700 });
try {
  if (role === 'second') writeSync(1, 'started\\n');
  await db.withLock(token => db.transaction(() => { db.assertToken(token); db.set({ id: role, kind:'ref', owner:'', envelope: Buffer.from('synthetic'), kid:'k1' }); }, true));
  await db.close();
  writeSync(1, 'success\\n');
} catch (error) { writeSync(1, 'error:' + (error.code || error.errcode || 'unknown') + '\\n'); process.exitCode = 1; }`;

function child(directory, role) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source, directory, role], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let stderr = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(process, 'close').then(([code, signal]) => ({ code, signal, output, stderr }));
  return { process, exit, async waitFor(text) {
    const limit = Date.now() + 3000;
    while (!output.includes(text)) {
      if (process.exitCode !== null || Date.now() > limit) throw Error(`child did not reach ${text}: ${output} ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-init-race-'));
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.process.exitCode === null && c.process.signalCode === null) c.process.kill('SIGKILL');
    await Promise.all(children.map((c) => c.exit));
    await rm(directory, { recursive: true, force: true });
  });
  const start = (role) => { const c = child(directory, role); children.push(c); return c; };
  return { directory, start };
}

test('two processes safely write during the first initialization', async (t) => {
  const { directory, start } = await setup(t);
  const first = start('first');
  await first.waitFor('initializing');
  const second = start('second');
  await second.waitFor('started');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(join(directory, 'release'), 'go');
  const [a, b] = await Promise.all([first.exit, second.exit]);
  assert.equal(a.code, 0, a.output + a.stderr);
  assert.equal(b.code, 0, b.output + b.stderr);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT id FROM secret ORDER BY id').all().map((row) => row.id), ['first', 'second']);
  db.close();
});

test('interrupted initialization never regenerates a key or overwrites the database', async (t) => {
  const { directory, start } = await setup(t);
  const first = start('first');
  await first.waitFor('initializing');
  first.process.kill('SIGKILL');
  await first.exit;
  const before = await readFile(join(directory, 'credentials.sqlite'));
  const second = start('second');
  const result = await second.exit;
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(join(directory, 'keyring.json')), false);
  assert.deepEqual(await readFile(join(directory, 'credentials.sqlite')), before);
});

test('read-only writes refuse without creating a directory or marker', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const missing = join(directory, 'not-created');
  const store = createCredentialStore({ directory: missing, readOnly: true, lockTimeoutMs: 50 });
  await assert.rejects(store.set('heluo-forge/iam/ref/TEST', 'synthetic'), { code: 'CRED_STORE_READ_ONLY' });
  assert.equal(existsSync(missing), false);
  await store.close();
});

test('a verified complete store can be written with an untouched leftover marker', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory, lockTimeoutMs: 50 });
  await first.set(key, 'before');
  await first.close();
  const marker = join(directory, 'credentials.sqlite.init');
  await writeFile(marker, 'unknown-owner');
  const next = createCredentialStore({ directory, lockTimeoutMs: 50 });
  await next.set(key, 'after');
  assert.equal(await next.get(key), 'after');
  assert.equal(await readFile(marker, 'utf8'), 'unknown-owner');
  await next.close();
});

test('leftover marker with a missing keyring cannot bypass initialization safety', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { unlink } = await import('node:fs/promises');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory, lockTimeoutMs: 30 });
  await first.set(key, 'before');
  await first.close();
  const database = join(directory, 'credentials.sqlite');
  const before = await readFile(database);
  const marker = join(directory, 'credentials.sqlite.init');
  await writeFile(marker, 'unknown-owner');
  await unlink(join(directory, 'keyring.json'));
  const next = createCredentialStore({ directory, lockTimeoutMs: 30 });
  await assert.rejects(next.set(key, 'after'), { code: 'CRED_LOCK_TIMEOUT' });
  assert.equal(existsSync(join(directory, 'keyring.json')), false);
  assert.deepEqual(await readFile(database), before);
  assert.equal(await readFile(marker, 'utf8'), 'unknown-owner');
  await next.close();
});

test('a transient SQLite exclusive lock during opening is retried', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory });
  await first.set(key, 'before');
  await first.close();
  const blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  blocker.exec('BEGIN EXCLUSIVE');
  t.after(() => { try { blocker.close(); } catch {} });
  const verify = new DatabaseSync(join(directory, 'credentials.sqlite'));
  verify.exec('PRAGMA busy_timeout=0');
  assert.throws(() => verify.prepare('PRAGMA user_version').get(), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  verify.close();
  const second = createCredentialStore({ directory, lockTimeoutMs: 700 });
  t.after(() => second.close());
  const write = second.set(key, 'after').then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  blocker.exec('COMMIT');
  const result = await write;
  assert.equal(result.ok, true, result.error?.stack);
  assert.equal(await second.get(key), 'after');
});

test('an invalid database fails immediately instead of being treated as contention', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  await initial.set(key, 'before');
  await initial.close();
  await writeFile(join(directory, 'credentials.sqlite'), 'invalid sqlite database');
  const store = createCredentialStore({ directory, lockTimeoutMs: 700 });
  t.after(() => store.close());
  await assert.rejects(store.set(key, 'after'), (error) => error.code === 'ERR_SQLITE_ERROR' && error.errcode !== 5 && error.errcode !== 6);
});


test('a leftover marker does not mask a corrupted database as contention', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  await initial.set(key, 'before');
  await initial.close();
  await writeFile(join(directory, 'credentials.sqlite'), 'invalid sqlite database');
  await writeFile(join(directory, 'credentials.sqlite.init'), 'unknown-owner');
  const store = createCredentialStore({ directory, lockTimeoutMs: 80 });
  t.after(() => store.close());
  await assert.rejects(store.set(key, 'after'), (error) => error.code === 'ERR_SQLITE_ERROR' && error.errcode !== 5 && error.errcode !== 6);
});

test('persistent SQLite contention times out without changing committed credentials', async (t) => {
  const { directory } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  await initial.set(key, 'before');
  await initial.close();
  const blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  blocker.exec('BEGIN EXCLUSIVE');
  t.after(() => { try { blocker.close(); } catch {} });
  const store = createCredentialStore({ directory, lockTimeoutMs: 40 });
  t.after(() => store.close());
  await assert.rejects(store.set(key, 'after'), { code: 'CRED_LOCK_TIMEOUT' });
  assert.equal(existsSync(join(directory, 'credentials.sqlite.init')), false);
  blocker.exec('COMMIT');
  assert.equal(await store.get(key), 'before');
});
