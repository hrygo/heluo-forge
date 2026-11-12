import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const probe = fileURLToPath(new URL('../scripts/probe/installed-credential-smoke.mjs', import.meta.url));
const packageDir = fileURLToPath(new URL('../packages/forge-credentials-keychain', import.meta.url));
const entry = pathToFileURL(join(packageDir, 'src/index.mjs')).href;

function syntheticPackage(t, implementation) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-installed-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/index.mjs'), `
    import { createCredentialStore as realStore } from ${JSON.stringify(entry)};
    ${implementation}
  `);
  return directory;
}

function runProbe(directory) {
  return spawnSync(process.execPath, [probe, directory], { encoding: 'utf8' });
}

test('installed credential smoke checks rotation and paired backup recovery', () => {
  const result = spawnSync(process.execPath, [probe, packageDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic SQLite round trip passed \(rotation and backup verified\)/u);
});

test('installed credential smoke rejects a missing package', () => {
  const result = spawnSync(process.execPath, [probe, `${packageDir}/missing`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('installed credential smoke rejects a package without rotation', (t) => {
  const directory = syntheticPackage(t, `
    export function createCredentialStore(options) {
      const store = realStore(options);
      return {
        set: (...args) => store.set(...args),
        get: (...args) => store.get(...args),
        close: () => store.close(),
      };
    }
  `);
  const result = runProbe(directory);
  assert.notEqual(result.status, 0, 'a missing rotation operation must fail the probe');
  assert.match(result.stderr, /rotate/u);
});

test('installed credential smoke rejects a rotation that does not activate a new key', (t) => {
  const directory = syntheticPackage(t, `
    export function createCredentialStore(options) {
      const store = realStore(options);
      return {
        set: (...args) => store.set(...args),
        get: (...args) => store.get(...args),
        rotate: async () => {},
        close: () => store.close(),
      };
    }
  `);
  const result = runProbe(directory);
  assert.notEqual(result.status, 0, 'a no-op rotation must fail the probe');
  assert.match(result.stderr, /rotation did not activate/u);
});

test('installed credential smoke rejects a package that cannot restore persisted values', (t) => {
  const directory = syntheticPackage(t, `
    const values = new Map();
    export function createCredentialStore(options) {
      const store = realStore(options);
      if (!values.has(options.directory)) values.set(options.directory, new Map());
      const cache = values.get(options.directory);
      return {
        async set(key, value) { await store.set(key, value); cache.set(key, value); },
        async get(key) { return cache.get(key); },
        rotate: (...args) => store.rotate(...args),
        close: () => store.close(),
      };
    }
  `);
  const result = runProbe(directory);
  assert.notEqual(result.status, 0, 'a package that ignores the copied store must fail the probe');
  assert.match(result.stderr, /synthetic-old/u);
});

test('installed credential smoke rejects a package that ignores readOnly', (t) => {
  const directory = syntheticPackage(t, `
    export function createCredentialStore(options) {
      return realStore({ ...options, readOnly: false });
    }
  `);
  const result = runProbe(directory);
  assert.notEqual(result.status, 0, 'a writable restoration must fail the probe');
  assert.match(result.stderr, /Missing expected rejection/u);
});

for (const [missing, code] of [['keys', 'CRED_KEY_UNAVAILABLE'], ['database', 'CRED_STORE_UNAVAILABLE']]) {
  test(`installed credential smoke rejects a package that silently accepts a backup missing ${missing}`, (t) => {
    const directory = syntheticPackage(t, `
      export function createCredentialStore(options) {
        const store = realStore(options);
        return {
          set: (...args) => store.set(...args),
          async get(...args) {
            try { return await store.get(...args); }
            catch (error) {
              if (error.code === ${JSON.stringify(code)}) return undefined;
              throw error;
            }
          },
          rotate: (...args) => store.rotate(...args),
          close: () => store.close(),
        };
      }
    `);
    const result = runProbe(directory);
    assert.notEqual(result.status, 0, 'an incomplete backup must fail closed');
    assert.match(result.stderr, /Missing expected rejection/u);
  });
}
