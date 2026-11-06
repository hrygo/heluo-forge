import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyStagedLayout } from '../scripts/fetch-native-keyring.mjs';

const lock = JSON.parse(
  (await import('node:fs')).readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/native-keyring.json'),
    'utf8',
  ),
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Build a synthetic staging tree that satisfies every rule, then break one. */
function staging(t, { addons = {}, checksums, triples } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-verify-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'forge-native-verify-'))); rmSync(root, { recursive: true, force: true }); });
  const files = {};
  for (const target of lock.targets) {
    const bytes = addons[target.triple] ?? Buffer.from(`synthetic-${target.triple}`);
    const license = Buffer.from(`license for ${target.triple}`);
    mkdirSync(join(root, target.triple), { recursive: true });
    writeFileSync(join(root, target.triple, 'keyring.node'), bytes);
    writeFileSync(join(root, target.triple, 'LICENSE.third-party.md'), license);
    files[`${target.triple}/keyring.node`] = {
      sha256: sha256(bytes),
      bytes: bytes.length,
      source: target.source,
      version: target.version,
      license: target.license,
      integrity: target.integrity,
    };
  }
  for (const triple of triples ?? []) {
    mkdirSync(join(root, triple), { recursive: true });
    writeFileSync(join(root, triple, 'keyring.node'), 'stray');
  }
  return { root, targets: lock.targets, checksums: { files: { ...files, ...(checksums ?? {}) } } };
}

test('a complete staging tree has no problems', (t) => {
  assert.deepEqual(verifyStagedLayout(staging(t)), []);
});

for (const [label, mutate, expected] of [
  ['missing addon', (layout) => rmSync(join(layout.root, 'linux-x64-gnu', 'keyring.node')), /linux-x64-gnu\/keyring\.node: staged file is missing/u],
  ['missing license', (layout) => rmSync(join(layout.root, 'win32-x64-msvc', 'LICENSE.third-party.md')), /win32-x64-msvc\/LICENSE\.third-party\.md: license is missing/u],
  ['corrupted bytes', (layout) => writeFileSync(join(layout.root, 'linux-arm64-gnu', 'keyring.node'), 'tampered'), /linux-arm64-gnu\/keyring\.node: (size|sha256) mismatch/u],
  ['version drift', (layout) => { layout.checksums.files['linux-x64-gnu/keyring.node'].version = '2.0.0'; }, /recorded version 2\.0\.0/u],
  ['license drift', (layout) => { layout.checksums.files['linux-x64-gnu/keyring.node'].license = 'Apache-2.0'; }, /recorded license Apache-2\.0/u],
  ['unclaimed record', (layout) => { layout.checksums.files['win32-arm64-msvc/keyring.node'] = layout.checksums.files['win32-x64-msvc/keyring.node']; }, /win32-arm64-msvc\/keyring\.node: recorded but no delivery target claims it/u],
]) {
  test(`staging rejects ${label}`, (t) => {
    const layout = staging(t);
    mutate(layout);
    assert.match(verifyStagedLayout(layout).join('; '), expected);
  });
}

test('staging rejects an arch directory the manifest does not deliver', (t) => {
  const layout = staging(t, { triples: ['win32-arm64-msvc'] });
  assert.match(verifyStagedLayout(layout).join('; '), /win32-arm64-msvc\/: unknown target directory/u);
});