import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, unlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileKeyProvider } from '../src/keyring.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-keyring-test-'));
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
