/**
 * Public release builder tests (issue #222 item ③).
 *
 * The fixture is a tagged two-package checkout with the four native addons, so
 * the test exercises the real `build-enterprise-bundle` path rather than a mock.
 * What it cannot prove: the published artifact was produced by GitHub Actions
 * from the public repository. That stays a CI-only claim.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { sha256 } from '../scripts/lib/release-support.mjs';
import { buildPublicRelease } from '../scripts/build-public-release.mjs';
import { createReleaseTree, ENTRY, MEMBER, put } from './fixtures/release-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_ROOT = REPO;
const VERSION = '0.1.0';

function temp(t, prefix = 'forge-public-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test', 'commit', '-q', '-m', message]);
}

function licensedTree(t, { license = 'Apache-2.0' } = {}) {
  const tree = createReleaseTree(t);
  put(tree.root, 'package.json', { name: 'heluo-forge-fixture', version: VERSION, private: true, license });
  for (const path of [`packages/forge-enterprise/package.json`, `packages/forge-credentials-keychain/package.json`]) {
    const manifest = JSON.parse(readFileSync(join(tree.root, path), 'utf8'));
    manifest.license = license;
    put(tree.root, path, manifest);
  }
  // The umbrella package declares the composition patch it installs; the public
  // artifact must ship it and the patch must stay configuration-neutral.
  put(tree.root, 'packages/forge-enterprise/cordis.patch.yml', [
    '- insert:',
    '    - id: heluo-iam',
    "      name: '@heluo/forge-iam'",
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    '      config: {}',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n'));
  for (const name of ['forge-iam', 'forge-gitee', 'forge-devops']) {
    put(tree.root, `packages/${name}/package.json`, { name: `@heluo/${name}`, version: '0.1.0', type: 'module', main: './src/index.mjs', files: ['src', 'README.md'], license });
    put(tree.root, `packages/${name}/README.md`, `# ${name} fixture\n`);
    put(tree.root, `packages/${name}/src/index.mjs`, 'export const fixture = true;\n');
  }
  const enterprisePath = join(tree.root, 'packages/forge-enterprise/package.json');
  const enterprise = JSON.parse(readFileSync(enterprisePath, 'utf8'));
  enterprise.files = [...enterprise.files, 'cordis.patch.yml'];
  enterprise.dsh = { bundle: { patch: './cordis.patch.yml' } };
  enterprise.dependencies = {
    ...enterprise.dependencies,
    '@heluo/forge-iam': 'workspace:*',
    '@heluo/forge-gitee': 'workspace:*',
    '@heluo/forge-devops': 'workspace:*',
  };
  enterprise.bundledDependencies = [...(enterprise.bundledDependencies ?? []), '@heluo/forge-iam', '@heluo/forge-gitee', '@heluo/forge-devops'];
  put(tree.root, 'packages/forge-enterprise/package.json', enterprise);
  return tree;
}

function taggedTree(t, options = {}) {
  const tree = licensedTree(t, options);
  git(tree.root, ['init', '-q']);
  commitAll(tree.root, 'fixture release tree');
  git(tree.root, ['tag', `v${VERSION}`]);
  return tree;
}

function output(t) {
  return join(temp(t, 'forge-public-out-'), 'release');
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('builds a configuration-neutral public release from a tagged checkout', (t) => {
  const tree = taggedTree(t);
  const release = buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' });
  assert.equal(release.neutral, true);
  assert.equal(release.version, VERSION);
  assert.equal(release.license, 'Apache-2.0');
  for (const name of ['release-manifest.json', 'SHA256SUMS', 'LICENSES.json', 'README.md', 'heluo-forge-release-tools-1.0.0.tgz', `heluo-forge-${VERSION}-source.tar.gz`]) {
    assert.equal(existsSync(join(release.output, name)), true, `${name} is missing`);
  }
  const manifest = JSON.parse(readFileSync(release.manifest, 'utf8'));
  assert.equal(manifest.schema, 'heluo-public-release/1');
  assert.equal(manifest.configNeutral, true);
  assert.equal(manifest.entry.name, ENTRY);
  assert.equal(manifest.entry.version, VERSION);
  assert.equal(manifest.license.declared, 'Apache-2.0');
  assert.equal(manifest.artifact.sha256, sha256(readFileSync(release.tarball)));
  assert.equal(manifest.source.sha256, sha256(readFileSync(release.source)));
  assert.equal(manifest.source.commit, git(tree.root, ['rev-parse', 'HEAD']));
  assert.equal(manifest.tools.files > 0, true);
  for (const line of readFileSync(release.sums, 'utf8').split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    assert.ok(match !== null, `malformed checksum line: ${line}`);
    assert.equal(sha256(readFileSync(join(release.output, match[2]))), match[1], `${match[2]} digest mismatch`);
  }
  const tools = readBundleEntries(readFileSync(release.tools), { withContent: true, prefix: 'heluo-forge-release-tools-1.0.0/' });
  assert.equal(
    tools.some((entry) => entry.path === 'toolchain/.agents/skills/heluo-forge-release-bundle/SKILL.md'),
    true,
    tools.map((entry) => entry.path).join(', '),
  );
  assert.equal(
    tools.some((entry) => entry.path === 'toolchain/scripts/release-delivery.mjs'),
    true,
    'the packager delivery builder must ship with the toolchain',
  );
  assert.equal(
    tools.some((entry) => entry.path === 'toolchain/scripts/init-enterprise-plugin.mjs'),
    true,
    'the employee-side initializer must ship with the toolchain',
  );
  assert.equal(
    tools.some((entry) => /full-installer\.mjs$/u.test(entry.path)),
    false,
    'the retired full-installer assembler must not ship',
  );
  assert.equal(tools.every((entry) => entry.path.startsWith('toolchain/')), true);
});

test('refuses a dirty checkout', (t) => {
  const tree = taggedTree(t);
  writeFileSync(join(tree.root, 'uncommitted.txt'), 'dirty\n');
  expectCode(() => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }), 'WORKTREE_DIRTY');
});

test('refuses a missing or mismatched tag', (t) => {
  const tree = taggedTree(t);
  expectCode(() => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: 'v9.9.9', license: 'Apache-2.0' }), 'TAG_MISSING');
  writeFileSync(join(tree.root, 'next.txt'), 'next\n');
  commitAll(tree.root, 'move past the tag');
  expectCode(() => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }), 'TAG_MISMATCH');
});

test('requires an explicit license', (t) => {
  const tree = licensedTree(t, { license: 'UNLICENSED' });
  git(tree.root, ['init', '-q']);
  commitAll(tree.root, 'fixture without a public license');
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}` }),
    'LICENSE_MISSING',
  );
});

test('refuses an artifact that carries enterprise configuration', (t) => {
  const tree = taggedTree(t);
  put(tree.root, 'packages/forge-enterprise/cordis.patch.yml', ['- insert:', '    - id: heluo-iam', "      name: '@heluo/forge-iam'", '      config:', '        issuer: https://iam.corp.example', ''].join('\n'));
  const manifestPath = join(tree.root, 'packages/forge-enterprise/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files = [...manifest.files, 'cordis.patch.yml'];
  put(tree.root, 'packages/forge-enterprise/package.json', manifest);
  commitAll(tree.root, 'add a non-neutral patch');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'ARTIFACT_NOT_NEUTRAL',
  );
});

test('refuses credential-like files in the published source archive', (t) => {
  const tree = taggedTree(t);
  writeFileSync(join(tree.root, '.env'), 'HELUO_IAM_CLIENT_SECRET=redacted\n');
  commitAll(tree.root, 'add a credential file');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'SOURCE_UNSAFE',
  );
});

test('refuses an existing non-empty output', (t) => {
  const tree = taggedTree(t);
  const destination = output(t);
  execFileSync('mkdir', ['-p', destination]);
  writeFileSync(join(destination, 'keep.txt'), 'keep\n');
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'OUTPUT_EXISTS',
  );
  assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'keep\n');
});

test('license inventory records declared licenses and the root entry', (t) => {
  const tree = taggedTree(t);
  const release = buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0', includeSource: false });
  const inventory = JSON.parse(readFileSync(join(release.output, 'LICENSES.json'), 'utf8'));
  assert.equal(inventory.schema, 'heluo-license-inventory/1');
  assert.equal(inventory.declared, 'Apache-2.0');
  assert.equal(inventory.packages.some((item) => item.entry === true && item.name === ENTRY), true);
  assert.equal(inventory.packages.some((item) => item.name === MEMBER), true);
  assert.equal(release.source, null);
});
