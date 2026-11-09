/**
 * Two-package release tree with a staged native resource.
 *
 * `@heluo/forge-enterprise` depends on `@heluo/forge-credentials-keychain`, whose
 * `vendor/CHECKSUMS.json` is the single source of truth for the four addons.
 * The build, the artifact verifier and the tests all judge the same record, so
 * the fixture that writes it lives in one place instead of three near-copies.
 *
 * Addon bytes only need to be distinguishable, not loadable: every rule compares
 * recorded size and sha256 and never loads the addon (that is the runtime's job).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Member package that ships the native addons. */
export const MEMBER = '@heluo/forge-credentials-keychain';

/** Umbrella package whose tarball is the release artifact. */
export const ENTRY = '@heluo/forge-enterprise';

/** Every triple the enterprise release must carry. */
export const TRIPLES = ['linux-arm64-gnu', 'linux-x64-gnu', 'win32-arm64-msvc', 'win32-x64-msvc'];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const addonBytes = (triple) => Buffer.from(`synthetic addon for ${triple}\n`);

/** Write a file, creating parents; Buffers are written verbatim, objects as JSON. */
export function put(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   memberFiles?: string[],
 *   entryFiles?: string[],
 *   triples?: string[],
 *   staged?: string[],
 *   tamper?: string,
 *   record?: object | string,
 * }} [options] `triples` is what the record declares, `staged` what is on disk
 *   (default: the same); `tamper` corrupts one staged addon; `record` replaces
 *   the generated record, either as an object or as raw text.
 */
export function createReleaseTree(t, options = {}) {
  const {
    memberFiles = ['src', 'vendor', 'README.md'],
    entryFiles = ['src', 'README.md'],
    triples = TRIPLES,
    staged = triples,
    tamper,
    record,
  } = options;
  const root = mkdtempSync(join(tmpdir(), 'forge-release-tree-'));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'forge-release-tree-')));
    rmSync(root, { recursive: true, force: true });
  });
  const member = { name: MEMBER, version: '0.1.0', type: 'module', main: './src/index.mjs', files: memberFiles };
  const enterprise = {
    ...member,
    name: ENTRY,
    files: entryFiles,
    dependencies: { [MEMBER]: 'workspace:*' },
    bundledDependencies: [MEMBER],
  };
  for (const pkg of [member, enterprise]) {
    const path = `packages/${pkg.name.slice('@heluo/'.length)}`;
    put(root, `${path}/package.json`, pkg);
    put(root, `${path}/README.md`, '# Release tree fixture\n');
    put(root, `${path}/src/index.mjs`, 'export const fixture = true;\n');
  }
  const vendor = `packages/forge-credentials-keychain/vendor`;
  const files = {};
  for (const triple of triples) {
    const bytes = addonBytes(triple);
    files[`${triple}/keyring.node`] = {
      relative: `${triple}/keyring.node`,
      sha256: sha256(bytes),
      bytes: bytes.length,
      source: `@napi-rs/keyring-${triple}`,
      version: '2.1.2',
      license: 'MIT',
      integrity: `sha512-${triple}`,
    };
  }
  put(root, `${vendor}/CHECKSUMS.json`, record ?? { package: '@napi-rs/keyring', version: '2.1.2', files });
  put(root, `${vendor}/README.md`, '# Staged addons\n');
  for (const triple of staged) {
    const bytes = addonBytes(triple);
    put(root, `${vendor}/${triple}/keyring.node`, tamper === undefined || tamper !== triple ? bytes : Buffer.concat([bytes, Buffer.from('x')]));
    put(root, `${vendor}/${triple}/LICENSE.third-party.md`, 'MIT\n');
  }
  return { root, member, entry: enterprise, vendor, vendorDir: join(root, vendor) };
}
