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

/**
 * Minimal object files: only the header fields the verifier reads, so a target
 * mix-up is detectable without shipping a real 2 MB addon into the test tree.
 */
function fakeBinary(triple) {
  if (triple.startsWith('win32-')) {
    const bytes = Buffer.alloc(0x80);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.writeUInt32BE(0x50450000, 0x40);
    bytes.writeUInt16LE(triple.includes('arm64') ? 0xaa64 : 0x8664, 0x44);
    return bytes;
  }
  if (triple.startsWith('darwin-')) {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(triple.includes('arm64') ? 0x0100000c : 0x01000007, 4);
    return bytes;
  }
  const machine = triple === 'linux-arm64-gnu' ? 183 : 62;
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

/** Build a synthetic staging tree that satisfies every rule, then break one. */
function staging(t, { addons = {}, checksums, triples } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-verify-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'forge-native-verify-'))); rmSync(root, { recursive: true, force: true }); });
  const files = {};
  for (const target of lock.targets) {
    const bytes = addons[target.triple] ?? fakeBinary(target.triple);
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
  ['a PE object under the win32 triple with the ARM64 machine type', (layout) => {
    const bytes = fakeBinary('win32-x64-msvc');
    bytes.writeUInt16LE(0xaa64, 0x44);
    layout.checksums.files['win32-x64-msvc/keyring.node'] = { ...layout.checksums.files['win32-x64-msvc/keyring.node'], sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(join(layout.root, 'win32-x64-msvc', 'keyring.node'), bytes);
  }, /win32-x64-msvc\/keyring\.node: PE machine 0xaa64 does not match PE\/AMD64/u],
  ['an ELF object under the linux-x64 triple with the AArch64 machine type', (layout) => {
    const bytes = fakeBinary('linux-arm64-gnu');
    layout.checksums.files['linux-x64-gnu/keyring.node'] = { ...layout.checksums.files['linux-x64-gnu/keyring.node'], sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(join(layout.root, 'linux-x64-gnu', 'keyring.node'), bytes);
  }, /linux-x64-gnu\/keyring\.node: ELF machine 183 does not match ELF\/x86-64/u],
  ['a Mach-O object with the x86_64 cputype under the arm64 triple', (layout) => {
    const bytes = fakeBinary('darwin-arm64');
    bytes.writeUInt32LE(0x01000007, 4);
    layout.checksums.files['darwin-arm64/keyring.node'] = { ...layout.checksums.files['darwin-arm64/keyring.node'], sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(join(layout.root, 'darwin-arm64', 'keyring.node'), bytes);
  }, /darwin-arm64\/keyring\.node: Mach-O cputype 0x1000007 does not match Mach-O\/arm64/u],
  ['a text file where an object is expected', (layout) => {
    const bytes = Buffer.from('definitely not a binary');
    layout.checksums.files['linux-x64-gnu/keyring.node'] = { ...layout.checksums.files['linux-x64-gnu/keyring.node'], sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(join(layout.root, 'linux-x64-gnu', 'keyring.node'), bytes);
  }, /linux-x64-gnu\/keyring\.node: not an ELF object/u],
  ['version drift', (layout) => { layout.checksums.files['linux-x64-gnu/keyring.node'].version = '2.0.0'; }, /recorded version 2\.0\.0/u],
  ['license drift', (layout) => { layout.checksums.files['linux-x64-gnu/keyring.node'].license = 'Apache-2.0'; }, /recorded license Apache-2\.0/u],
  ['unclaimed record', (layout) => { layout.checksums.files['freebsd-x64/keyring.node'] = layout.checksums.files['win32-x64-msvc/keyring.node']; }, /freebsd-x64\/keyring\.node: recorded but no delivery target claims it/u],
]) {
  test(`staging rejects ${label}`, (t) => {
    const layout = staging(t);
    mutate(layout);
    assert.match(verifyStagedLayout(layout).join('; '), expected);
  });
}

test('staging rejects a missing staging directory', (t) => {
  const layout = staging(t);
  rmSync(layout.root, { recursive: true, force: true });
  assert.match(verifyStagedLayout(layout).join('; '), /staging directory is missing/u);
});

test('staging rejects an arch directory the manifest does not deliver', (t) => {
  const layout = staging(t, { triples: ['freebsd-x64'] });
  assert.match(verifyStagedLayout(layout).join('; '), /freebsd-x64\/: unknown target directory/u);
});