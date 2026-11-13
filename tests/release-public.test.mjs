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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function licensedTree(t, { license = 'Apache-2.0', splitLayers = false, dropRow } = {}) {
  const tree = createReleaseTree(t);
  put(tree.root, 'package.json', { name: 'heluo-forge-fixture', version: VERSION, private: true, license });
  for (const path of [`packages/forge-enterprise/package.json`, `packages/forge-credentials-keychain/package.json`]) {
    const manifest = JSON.parse(readFileSync(join(tree.root, path), 'utf8'));
    manifest.license = license;
    put(tree.root, path, manifest);
  }
  // The umbrella package declares the composition patch it installs; the public
  // artifact must ship it and the patch must stay configuration-neutral.
  const rows = (ids) => ids.flatMap(([id, name]) => [
    `    - id: ${id}`,
    `      name: '${name}'`,
    ...(id === 'heluo-iam' ? [] : ['      config: {}']),
  ]);
  const wants = (id) => dropRow !== id;
  const baseRows = [['heluo-iam', '@heluo/forge-iam']].filter(([id]) => wants(id));
  const overlayRows = [['heluo-gitee', '@heluo/forge-gitee'], ['forge-devops', '@heluo/forge-devops']].filter(([id]) => wants(id));
  if (splitLayers) {
    // 两层形态：默认层只放 IAM，研发叠加层放 Gitee 与 DevOps（与真实组合方式一致）。
    put(tree.root, 'packages/forge-enterprise/cordis.patch.yml', ['- insert:', ...rows(baseRows), ''].join('\n'));
    put(tree.root, 'packages/forge-enterprise/cordis.patch.engineering.yml', ['- insert:', ...rows(overlayRows), ''].join('\n'));
  } else {
    put(tree.root, 'packages/forge-enterprise/cordis.patch.yml', ['- insert:', ...rows([...baseRows, ...overlayRows]), ''].join('\n'));
  }
  for (const name of ['forge-iam', 'forge-gitee', 'forge-devops']) {
    put(tree.root, `packages/${name}/package.json`, { name: `@heluo/${name}`, version: '0.1.0', type: 'module', main: './src/index.mjs', files: ['src', 'README.md'], license });
    put(tree.root, `packages/${name}/README.md`, `# ${name} fixture\n`);
    put(tree.root, `packages/${name}/src/index.mjs`, 'export const fixture = true;\n');
  }
  for (const name of ['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs']) {
    put(tree.root, `packages/forge-iam/src/${name}`, readFileSync(new URL(`../packages/forge-iam/src/${name}`, import.meta.url)));
  }
  const enterprisePath = join(tree.root, 'packages/forge-enterprise/package.json');
  const enterprise = JSON.parse(readFileSync(enterprisePath, 'utf8'));
  enterprise.files = [...enterprise.files, 'cordis.patch.yml', ...(splitLayers ? ['cordis.patch.engineering.yml'] : [])];
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

/**
 * Tool trees for the toolchain-report cases (issue #254 items 13 and 23).
 *
 * `TOOL_TREE_FILES` is what the build must require before it archives anything:
 * the release scripts, the IAM validator import closure (#253), the skill entry and
 * a `scripts/lib` module. The native keyring helper and its data file are gone from
 * #253's toolchain and must stay out of the required list. The synthetic token is
 * assembled at runtime so this test file itself never carries a literal credential
 * pattern into the source archive it is scanned from.
 */
const TOOL_TOKEN = ['ghp', 'syntheticreleasefixturetoken1234'].join('_');
const IAM_VALIDATOR_FILES = ['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs']
  .map((name) => `packages/forge-iam/src/${name}`);
const TOOL_TREE_FILES = [
  '.agents/skills/heluo-forge-release-bundle/SKILL.md',
  ...IAM_VALIDATOR_FILES,
  'scripts/build-enterprise-bundle.mjs',
  'scripts/build-public-release.mjs',
  'scripts/init-enterprise-plugin.mjs',
  'scripts/lib/private-bundle.mjs',
  'scripts/make-private-bundle.mjs',
  'scripts/release-delivery.mjs',
  'scripts/verify-enterprise-bundle.mjs',
];

function toolTree(t, { omit } = {}) {
  const root = temp(t, 'forge-tool-tree-');
  for (const path of TOOL_TREE_FILES) {
    if (path === omit) continue;
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    // The IAM validator closure is byte-compared against the bundle, so a tool tree
    // fixture must carry the real modules; every other file only needs to exist.
    if (path.startsWith('packages/forge-iam/src/')) writeFileSync(full, readFileSync(join(TOOL_ROOT, path)));
    else writeFileSync(full, path.endsWith('.json') ? '{}\n' : '// fixture toolchain\n');
  }
  return root;
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
  for (const name of ['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs']) {
    const entry = tools.find((item) => item.path === `toolchain/packages/forge-iam/src/${name}`);
    assert.ok(entry, `the standalone maker must include IAM validation dependency ${name}`);
    assert.deepEqual(entry.content, readFileSync(join(TOOL_ROOT, 'packages/forge-iam/src', name)));
  }
  const extracted = temp(t, 'forge-standalone-toolchain-');
  for (const entry of tools) {
    const path = join(extracted, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.content);
  }
  const maker = join(extracted, 'toolchain/scripts/lib/private-bundle.mjs');
  execFileSync(process.execPath, ['--input-type=module', '-e', 'import { pathToFileURL } from "node:url"; const maker = await import(pathToFileURL(process.argv[1])); maker.inspectPublicTarball(process.argv[2]);', maker, release.tarball], { encoding: 'utf8' });
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

test('an ignored in-repository .env is absent from public release archives', (t) => {
  const tree = licensedTree(t);
  writeFileSync(join(tree.root, '.gitignore'), readFileSync(join(TOOL_ROOT, '.gitignore')));
  git(tree.root, ['init', '-q']);
  commitAll(tree.root, 'fixture release tree with ignore rules');
  git(tree.root, ['tag', `v${VERSION}`]);
  const marker = 'synthetic-private-configuration-marker';
  writeFileSync(join(tree.root, '.env'), `HELUO_IAM_CLIENT_ID=${marker}\n`, { mode: 0o600 });
  git(tree.root, ['check-ignore', '-q', '--', '.env']);
  const release = buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' });
  for (const [path, prefix] of [
    [release.source, `heluo-forge-${VERSION}/`],
    [release.tarball, 'package/'],
    [release.tools, 'heluo-forge-release-tools-1.0.0/'],
  ]) {
    const files = readBundleEntries(readFileSync(path), { withContent: true, prefix });
    assert.equal(files.some((file) => file.path.split('/').includes('.env')), false);
    assert.equal(files.some((file) => file.content.includes(marker)), false);
  }
});

test('refuses a dirty checkout', (t) => {
  const tree = taggedTree(t);
  writeFileSync(join(tree.root, 'uncommitted.txt'), 'dirty\n');
  expectCode(() => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }), 'WORKTREE_DIRTY');
});

test('refuses to publish a toolchain with a different IAM runtime validator', (t) => {
  const tree = taggedTree(t);
  writeFileSync(join(tree.root, 'packages/forge-iam/src/config.mjs'), 'export const different = true;\n');
  commitAll(tree.root, 'change the fixture validator');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  const destination = output(t);
  expectCode(() => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }), 'IAM_VALIDATOR_MISMATCH');
  assert.equal(existsSync(destination), false);
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

test('a split-layer public release ships both layers and is still judged as one set', (t) => {
  const tree = taggedTree(t, { splitLayers: true });
  const release = buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' });
  assert.equal(release.neutral, true);
  const entries = readBundleEntries(readFileSync(release.tarball), { withContent: true });
  const layers = entries.map((entry) => entry.path).filter((path) => /^cordis\.patch(?:\.[A-Za-z0-9-]+)?\.yml$/u.test(path)).sort();
  assert.deepEqual(layers, ['cordis.patch.engineering.yml', 'cordis.patch.yml'], '两层都必须进产物');
  const base = String(entries.find((entry) => entry.path === 'cordis.patch.yml').content);
  const overlay = String(entries.find((entry) => entry.path === 'cordis.patch.engineering.yml').content);
  assert.match(base, /heluo-iam/u);
  assert.match(overlay, /heluo-gitee/u);
  assert.match(overlay, /forge-devops/u);
});

test('refuses a split bundle whose required row lives in no layer at all', (t) => {
  const tree = taggedTree(t, { splitLayers: true, dropRow: 'forge-devops' });
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'ARTIFACT_NOT_NEUTRAL',
  );
});

test('refuses a split bundle whose non-default layer carries enterprise configuration', (t) => {
  const tree = taggedTree(t, { splitLayers: true });
  // 默认层干净、叠加层带企业配置：只判第一层就会放过。
  put(tree.root, 'packages/forge-enterprise/cordis.patch.engineering.yml', [
    '- insert:',
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    '      config:',
    '        host: gitee.corp.example',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n'));
  commitAll(tree.root, 'dirty overlay layer');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'ARTIFACT_NOT_NEUTRAL',
  );
});

test('refuses a bundle that does not ship its declared patch layer', (t) => {
  const tree = taggedTree(t);
  const manifestPath = join(tree.root, 'packages/forge-enterprise/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // 声明指向不存在的层：装上也加载不到企业能力。
  manifest.dsh = { bundle: { patch: './cordis.patch.missing.yml' } };
  put(tree.root, 'packages/forge-enterprise/package.json', manifest);
  commitAll(tree.root, 'declare a layer that is not shipped');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: output(t), tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'ARTIFACT_INVALID',
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

test('refuses a tool tree with no release scripts', (t) => {
  const tree = taggedTree(t);
  const destination = output(t);
  expectCode(
    () => buildPublicRelease({ root: tree.root, toolRoot: temp(t, 'forge-tool-empty-'), output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }),
    'TOOLS_INCOMPLETE',
  );
  assert.equal(existsSync(destination), false, 'a refused build must not leave release assets behind');
});

test('refuses a tool tree missing one required script or the skill entry', (t) => {
  const tree = taggedTree(t);
  for (const missing of ['scripts/release-delivery.mjs', '.agents/skills/heluo-forge-release-bundle/SKILL.md', 'packages/forge-iam/src/config.mjs']) {
    const destination = output(t);
    assert.throws(
      () => buildPublicRelease({ root: tree.root, toolRoot: toolTree(t, { omit: missing }), output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }),
      (error) => {
        assert.equal(error.code, 'TOOLS_INCOMPLETE', `${missing}: ${error.message}`);
        assert.ok(error.message.includes(missing), `the failure must name ${missing}: ${error.message}`);
        return true;
      },
    );
    assert.equal(existsSync(destination), false);
  }
});

test('refuses a release tool script that carries a credential pattern', (t) => {
  const tree = taggedTree(t);
  const toolRoot = toolTree(t);
  writeFileSync(join(toolRoot, 'scripts/lib/private-bundle.mjs'), `export const leaked = '${TOOL_TOKEN}';\n`);
  const destination = output(t);
  assert.throws(
    () => buildPublicRelease({ root: tree.root, toolRoot, output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }),
    (error) => {
      assert.equal(error.code, 'TOOLS_SENSITIVE', error.message);
      assert.ok(error.message.includes('scripts/lib/private-bundle.mjs'), error.message);
      assert.ok(error.message.includes('GitHub token'), error.message);
      assert.equal(error.message.includes(TOOL_TOKEN), false, 'the finding must not print the secret value');
      return true;
    },
  );
  assert.equal(existsSync(destination), false);
});

test('refuses a tracked source file that carries a credential pattern', (t) => {
  const tree = taggedTree(t);
  const token = ['ghp', 'syntheticsourcefixturetoken12345'].join('_');
  put(tree.root, 'docs/notes.md', `# 运维说明\n\n${token}\n`);
  commitAll(tree.root, 'add a synthetic credential pattern to the source tree');
  git(tree.root, ['tag', '-f', `v${VERSION}`]);
  const destination = output(t);
  assert.throws(
    () => buildPublicRelease({ root: tree.root, toolRoot: TOOL_ROOT, output: destination, tag: `v${VERSION}`, license: 'Apache-2.0' }),
    (error) => {
      assert.equal(error.code, 'SOURCE_UNSAFE', error.message);
      assert.ok(error.message.includes('docs/notes.md'), error.message);
      assert.ok(error.message.includes('GitHub token'), error.message);
      assert.equal(error.message.includes(token), false, 'the finding must not print the secret value');
      return true;
    },
  );
  assert.equal(existsSync(destination), false);
});
