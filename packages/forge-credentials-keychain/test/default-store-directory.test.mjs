import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAesGcmCipher } from '../src/cipher.mjs';
import { createCredentialStore } from '../src/credential-store.mjs';
import { selectDefaultStoreDirectory } from '../src/default-store-directory.mjs';
import { createFileKeyProvider } from '../src/keyring.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

async function fixture(t) {
  const root = await outsideRepositoryTmpAsync('forge-default-dir-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const dataHome = path.join(root, 'data');
  return {
    root, home, dataHome,
    old: path.join(home, '.local', 'share', 'HeluoForge'),
    next: path.join(dataHome, 'HeluoForge'),
    options: { platform: 'linux', home, xdgDataHome: dataHome },
  };
}

// Build a synthetic version-1 store in the original same-directory layout,
// independently of whichever layout the current writer creates.
async function createLegacyStore(directory, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keys = createFileKeyProvider({ path: path.join(directory, 'keyring.json') });
  keys.initialize('k1');
  const database = path.join(directory, 'credentials.sqlite');
  const file = await open(database, 'wx', 0o600);
  await file.close();
  const db = new DatabaseSync(database);
  try {
    db.exec("CREATE TABLE secret (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', envelope BLOB NOT NULL, kid TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1; INSERT INTO meta(key,value) VALUES('active','k1');");
    const envelope = createAesGcmCipher(keys).seal({ kind: 'ref', id: key, owner: '', kid: 'k1', plaintext: Buffer.from('synthetic-value') });
    db.prepare('INSERT INTO secret (id,kind,owner,envelope,kid,revision,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(key, 'ref', '', envelope, 'k1', 1, '2026-01-01T00:00:00.000Z');
  } finally { db.close(); }
}

test('Linux selects XDG for a new store and ignores unset, empty and relative values', async (t) => {
  const f = await fixture(t);
  assert.equal(selectDefaultStoreDirectory(f.options), f.next);
  for (const xdgDataHome of [undefined, '', 'relative/data']) {
    assert.equal(selectDefaultStoreDirectory({ ...f.options, xdgDataHome }), f.old);
  }
  assert.equal(existsSync(f.old), false);
  assert.equal(existsSync(f.next), false);
});

test('an old same-directory store remains writable and readable across processes without migration', async (t) => {
  const f = await fixture(t);
  const key = 'heluo-forge/iam/ref/TEST';
  await createLegacyStore(f.old, key);
  const keyringBefore = await readFile(path.join(f.old, 'keyring.json'));
  const databaseBefore = await readFile(path.join(f.old, 'credentials.sqlite'));
  const selected = selectDefaultStoreDirectory(f.options);
  assert.equal(selected, f.old);
  const reader = createCredentialStore({ directory: selected, readOnly: true });
  try { assert.equal(await reader.get(key), 'synthetic-value'); }
  finally { await reader.close(); }
  assert.deepEqual(await readFile(path.join(f.old, 'keyring.json')), keyringBefore);
  assert.deepEqual(await readFile(path.join(f.old, 'credentials.sqlite')), databaseBefore);
  assert.equal(existsSync(f.next), false);
  assert.equal(existsSync(`${f.old}.keys`), false);

  const writer = createCredentialStore({ directory: selected });
  try { await writer.set(key, 'legacy-updated'); }
  finally { await writer.close(); }
  const entry = new URL('../src/credential-store.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    import { createCredentialStore } from ${JSON.stringify(entry)};
    const store = createCredentialStore({ directory: ${JSON.stringify(selected)}, readOnly: true });
    try { assert.equal(await store.get(${JSON.stringify(key)}), 'legacy-updated'); }
    finally { await store.close(); }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { HOME: f.home, USERPROFILE: f.home,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
    timeout: 10000,
  });
  assert.deepEqual(await readFile(path.join(f.old, 'keyring.json')), keyringBefore);
  assert.equal(existsSync(`${f.old}.keys`), false);
  assert.equal(existsSync(f.next), false);
});

test('an empty or incomplete old directory is preserved without creating another store', async (t) => {
  const f = await fixture(t);
  for (const [name, file] of [
    ['empty', undefined], ['database', 'credentials.sqlite'], ['keyring', 'keyring.json'],
    ['initialization marker', 'credentials.sqlite.init'], ['legacy document', 'credentials.json'],
    ['legacy key', 'credentials.key'],
  ]) await t.test(name, async (t) => {
    const home = path.join(f.root, name, 'home');
    const old = path.join(home, '.local', 'share', 'HeluoForge');
    const dataHome = path.join(f.root, name, 'data');
    const next = path.join(dataHome, 'HeluoForge');
    await mkdir(old, { recursive: true });
    if (file) await writeFile(path.join(old, file), 'synthetic-incomplete');
    assert.equal(selectDefaultStoreDirectory({ platform: 'linux', home, xdgDataHome: dataHome }), old);
    if (file) assert.equal(await readFile(path.join(old, file), 'utf8'), 'synthetic-incomplete');
    assert.equal(existsSync(next), false);
  });
});

test('an existing XDG store is selected when the old directory is absent', async (t) => {
  const f = await fixture(t);
  await mkdir(f.next, { recursive: true });
  await writeFile(path.join(f.next, 'credentials.sqlite.init'), 'synthetic-incomplete');
  assert.equal(selectDefaultStoreDirectory(f.options), f.next);
  assert.equal(await readFile(path.join(f.next, 'credentials.sqlite.init'), 'utf8'), 'synthetic-incomplete');
  assert.equal(existsSync(f.old), false);
});

test('distinct existing old and XDG directories fail closed, including empty directories', async (t) => {
  const f = await fixture(t);
  await mkdir(f.old, { recursive: true });
  await mkdir(f.next, { recursive: true });
  await writeFile(path.join(f.old, 'credentials.key'), 'synthetic-legacy');
  assert.throws(() => selectDefaultStoreDirectory(f.options), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(await readFile(path.join(f.old, 'credentials.key'), 'utf8'), 'synthetic-legacy');
  assert.deepEqual(await readdir(f.next), []);
});

test('the same normalized path is not a conflict', async (t) => {
  const f = await fixture(t);
  await mkdir(f.old, { recursive: true });
  const xdgDataHome = `${path.join(f.home, '.local', 'share')}${path.sep}unused${path.sep}..`;
  assert.equal(selectDefaultStoreDirectory({ ...f.options, xdgDataHome }), f.old);
});

test('two names for the same existing directory are not a conflict', async (t) => {
  const f = await fixture(t);
  const sameDirectory = { dev: 1, ino: 42, isDirectory: () => true };
  assert.equal(selectDefaultStoreDirectory({ ...f.options, inspect: () => sameDirectory }), f.old);
});

test('directory inspection errors are not treated as absence', async (t) => {
  const f = await fixture(t);
  for (const failingPath of [f.old, f.next]) {
    const denied = Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
    const inspect = (target) => {
      if (target === failingPath) throw denied;
      throw Object.assign(new Error('synthetic absent'), { code: 'ENOENT' });
    };
    assert.throws(() => selectDefaultStoreDirectory({ ...f.options, inspect }), (error) => error === denied);
  }
});

test('Host and reader refuse conflicting defaults but accept explicit directory overrides', async (t) => {
  const f = await fixture(t);
  const explicit = path.join(f.root, 'explicit');
  await mkdir(f.old, { recursive: true });
  await mkdir(f.next, { recursive: true });
  const entry = new URL('../src/index.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { apply, defaultStoreDirectory, openCredentialReader } = await import(${JSON.stringify(entry)});
    assert.throws(() => defaultStoreDirectory(), { code: 'CRED_STORE_PATH_CONFLICT' });
    await assert.rejects(openCredentialReader(), { code: 'CRED_STORE_PATH_CONFLICT' });
    const services = new Map();
    const ctx = { get: (name) => services.get(name),
      provide(name, value) { services.set(name, value); return () => services.delete(name); },
      effect(fn) { return fn(); } };
    assert.throws(() => apply(ctx, {}), { code: 'CRED_STORE_PATH_CONFLICT' });
    const dispose = apply(ctx, { storeDirectory: ${JSON.stringify(explicit)} });
    const reader = await openCredentialReader({ directory: ${JSON.stringify(explicit)} });
    await reader.close();
    await dispose();`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { HOME: f.home, USERPROFILE: f.home, XDG_DATA_HOME: f.dataHome }, timeout: 5000,
  });
  assert.equal(existsSync(explicit), false);
});

test('Host and reader use the platform default with a sibling key directory', async (t) => {
  const f = await fixture(t);
  const selected = process.platform === 'darwin'
    ? path.join(f.home, 'Library', 'Application Support', 'HeluoForge')
    : process.platform === 'win32' || process.platform === 'linux'
      ? path.join(f.dataHome, 'HeluoForge')
      : f.old;
  const entry = new URL('../src/index.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    const { apply, defaultStoreDirectory, openCredentialReader } = await import(${JSON.stringify(entry)});
    assert.equal(defaultStoreDirectory(), ${JSON.stringify(selected)});
    const services = new Map();
    const ctx = { get: (name) => services.get(name),
      provide(name, value) { services.set(name, value); return () => services.delete(name); },
      effect(fn) { return fn(); } };
    const dispose = apply(ctx, {});
    let reader;
    try {
      await services.get('credentials').set('TEST', 'synthetic-value');
      reader = await openCredentialReader();
      assert.equal((await reader.resolve('TEST')).value, 'synthetic-value');
    } finally { await reader?.close(); await dispose(); }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { HOME: f.home, USERPROFILE: f.home, LOCALAPPDATA: f.dataHome, XDG_DATA_HOME: f.dataHome,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
    timeout: 10000,
  });
  assert.ok((await stat(path.join(selected, 'credentials.sqlite'))).isFile());
  assert.ok((await stat(path.join(`${selected}.keys`, 'keyring.json'))).isFile());
  await assert.rejects(stat(path.join(selected, 'keyring.json')), { code: 'ENOENT' });
});

test('macOS default uses the non-sandboxed application support directory', () => {
  assert.equal(selectDefaultStoreDirectory({ platform: 'darwin', home: '/synthetic-home', paths: path.posix }),
    '/synthetic-home/Library/Application Support/HeluoForge');
});

test('Windows ignores empty and relative LOCALAPPDATA and keeps absolute paths', () => {
  const home = 'C:\\Profiles\\Example';
  const options = { platform: 'win32', home, paths: path.win32 };
  const fallback = 'C:\\Profiles\\Example\\AppData\\Local\\HeluoForge';
  for (const localAppData of [undefined, '', 'relative', 'C:relative', '\\root-relative']) {
    assert.equal(selectDefaultStoreDirectory({ ...options, localAppData }), fallback);
  }
  assert.equal(selectDefaultStoreDirectory({ ...options, localAppData: 'D:\\AppData' }), 'D:\\AppData\\HeluoForge');
  assert.equal(selectDefaultStoreDirectory({ ...options, localAppData: '\\\\server\\share\\AppData' }), '\\\\server\\share\\AppData\\HeluoForge');
});
