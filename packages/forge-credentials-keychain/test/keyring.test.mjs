import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, writeFileSync, chmodSync, unlinkSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { createCredentialStore } from '../src/credential-store.mjs';
import { createFileKeyProvider } from '../src/keyring.mjs';
import { outsideRepositoryTmp } from './support/tmp.mjs';

function fixture(t) {
  const dir = outsideRepositoryTmp('forge-keyring-test-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'keyring.json');
  return { path, provider: createFileKeyProvider({ path }) };
}

test('initialization persists independent 32-byte keys without replacing existing keys', (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  const first = provider.active();
  assert.equal(first.kid, 'k1');
  assert.equal(first.key.length, 32);
  assert.deepEqual(provider.byId('k1'), first.key);
  assert.equal(provider.byId('absent'), undefined);
  provider.add('k2');
  assert.notDeepEqual(provider.byId('k2'), first.key);
  assert.deepEqual(provider.active(), first);
  const before = readFileSync(path);
  assert.throws(() => provider.add('k1'));
  assert.throws(() => provider.initialize('k3'));
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(createFileKeyProvider({ path }).byId('k2'), provider.byId('k2'));
  provider.add('__proto__');
  assert.equal(provider.byId('__proto__').length, 32);
});

test('missing file is not created by reads or add', (t) => {
  const { path, provider } = fixture(t);
  assert.throws(() => provider.active());
  assert.throws(() => provider.byId('k1'));
  assert.throws(() => provider.add('k2'));
  assert.throws(() => readFileSync(path), { code: 'ENOENT' });
});

test('removed old key is unavailable but active key remains readable', (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  provider.add('k2');
  const stored = JSON.parse(readFileSync(path));
  stored.active = 'k2';
  delete stored.keys.k1;
  writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
  assert.equal(provider.byId('k1'), undefined);
  assert.equal(provider.active().kid, 'k2');
  unlinkSync(path);
  assert.throws(() => provider.active());
});

test('a read survives another process atomically rotating the keyring', async (t) => {
  const { path: fixturePath } = fixture(t);
  const directory = join(dirname(fixturePath), 'data');
  const path = join(`${directory}.keys`, 'keyring.json');
  const store = createCredentialStore({ directory });
  const ref = 'heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY';
  const original = fs.lstatSync;
  let rotated = false;
  try {
    await store.set(ref, 'synthetic');
    fs.lstatSync = (target, ...args) => {
      const stat = original(target, ...args);
      if (!rotated && target === path) {
        rotated = true;
        const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
        const source = `import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
          const store = createCredentialStore({ directory: process.argv[1] });
          try { await store.rotate('k2'); } finally { await store.close(); }`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, directory], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 0, child.stderr || child.error?.message);
      }
      return stat;
    };
    syncBuiltinESMExports();
    assert.equal(await store.get(ref), 'synthetic');
    assert.equal(rotated, true);
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
    await store.close();
  }
});

test('continuous keyring replacement is rejected after bounded retries', (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  const replacement = `${path}.replacement`;
  const original = fs.lstatSync;
  let attempts = 0;
  try {
    fs.lstatSync = (target, ...args) => {
      const stat = original(target, ...args);
      if (target === path) {
        attempts += 1;
        writeFileSync(replacement, readFileSync(path), { mode: 0o600, flag: 'wx' });
        fs.renameSync(replacement, path);
      }
      return stat;
    };
    syncBuiltinESMExports();
    assert.throws(() => provider.active(), { code: 'CRED_KEY_INVALID' });
    assert.ok(attempts >= 2 && attempts <= 3);
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
  }
});

test('an insecure replacement is rejected after an open race', { skip: process.platform === 'win32' }, (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
  chmodSync(replacement, 0o644);
  const original = fs.lstatSync;
  let replaced = false;
  try {
    fs.lstatSync = (target, ...args) => {
      const stat = original(target, ...args);
      if (target === path && !replaced) {
        replaced = true;
        fs.renameSync(replacement, path);
      }
      return stat;
    };
    syncBuiltinESMExports();
    assert.throws(() => provider.active(), { code: 'CRED_KEY_PERMISSIONS' });
    assert.equal(replaced, true);
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
  }
});

test('a symlink substituted during open is rejected', { skip: process.platform === 'win32' }, (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  const alternate = `${path}.alternate`;
  const replacement = `${path}.replacement`;
  writeFileSync(alternate, readFileSync(path), { mode: 0o600 });
  symlinkSync(alternate, replacement);
  const original = fs.lstatSync;
  let replaced = false;
  try {
    fs.lstatSync = (target, ...args) => {
      const stat = original(target, ...args);
      if (target === path && !replaced) {
        replaced = true;
        fs.renameSync(replacement, path);
      }
      return stat;
    };
    syncBuiltinESMExports();
    assert.throws(() => provider.active(), (error) => ['ELOOP', 'CRED_KEY_INVALID'].includes(error.code));
    assert.equal(replaced, true);
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
  }
});

test('a keyring owned by a different user is rejected', { skip: process.platform === 'win32' }, (t) => {
  const { provider } = fixture(t);
  provider.initialize('k1');
  const original = fs.fstatSync;
  try {
    fs.fstatSync = (fd, ...args) => {
      const stat = original(fd, ...args);
      stat.uid = process.getuid() + 1;
      return stat;
    };
    syncBuiltinESMExports();
    assert.throws(() => provider.active(), { code: 'CRED_KEY_PERMISSIONS' });
  } finally {
    fs.fstatSync = original;
    syncBuiltinESMExports();
  }
});

test('rejects invalid kids and malformed or noncanonical documents without leaking key material', (t) => {
  const { path, provider } = fixture(t);
  for (const kid of ['', 'a/b', 'a|b', '中']) {
    assert.throws(() => provider.initialize(kid));
  }
  const valid = Buffer.alloc(32, 17).toString('base64');
  const cases = ['{', 'null', '{}', JSON.stringify({ v: 2, active: 'k1', keys: { k1: valid } }),
    JSON.stringify({ v: 1, active: 'missing', keys: { k1: valid } }),
    JSON.stringify({ v: 1, active: 'k1', keys: { k1: valid.slice(0, -1) } }),
    JSON.stringify({ v: 1, active: 'k1', keys: { k1: Buffer.alloc(31).toString('base64') } }),
    JSON.stringify({ v: 1, active: 'k1', keys: { k1: valid, 'bad/kid': valid } }),
    JSON.stringify({ v: 1, active: 'k1', keys: { k1: valid }, extra: true })];
  for (const content of cases) {
    writeFileSync(path, content, { mode: 0o600 });
    assert.throws(() => provider.active(), (error) => !error.message.includes(valid));
  }
});

test('POSIX rejects permissive files and symlinks', { skip: process.platform === 'win32' }, (t) => {
  const { path, provider } = fixture(t);
  provider.initialize('k1');
  chmodSync(path, 0o644);
  assert.throws(() => provider.active());
  chmodSync(path, 0o600);
  const link = `${path}.link`;
  symlinkSync(path, link);
  assert.throws(() => createFileKeyProvider({ path: link }).active());
});
