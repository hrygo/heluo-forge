import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildBundle, buildEnterpriseBundle } from '../scripts/build-enterprise-bundle.mjs';
import { auditReleaseClosure, auditTarball, npmExecutable } from '../scripts/lib/bundle-rules.mjs';

// These fixtures test packaging failures only; the real product tarball and
// real installed Loader are exercised by bundle-install-rehearsal.test.mjs.
function put(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-build-test-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'forge-build-test-'))); rmSync(root, { recursive: true, force: true }); });
  const member = { name: '@heluo/forge-member', version: '0.1.0', type: 'module', main: './src/index.mjs', files: ['src', 'README.md'] };
  const enterprise = { ...member, name: '@heluo/forge-enterprise', dependencies: { [member.name]: 'workspace:*' }, bundledDependencies: [member.name], ...overrides };
  for (const pkg of [member, enterprise]) {
    const path = `packages/${pkg.name.slice('@heluo/'.length)}`;
    put(root, `${path}/package.json`, pkg);
    put(root, `${path}/README.md`, '# Local packaging fixture\n');
    put(root, `${path}/src/index.mjs`, 'export const fixture = true;\n');
  }
  return root;
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('build closes workspace dependencies, is reproducible, and installs offline without cache', (t) => {
  const root = fixture(t);
  const source = join(root, 'packages/forge-enterprise/package.json');
  const before = readFileSync(source, 'utf8');
  const first = buildEnterpriseBundle({ root, destination: join(root, 'one') });
  const second = buildEnterpriseBundle({ root, destination: join(root, 'two') });
  assert.equal(digest(first.tarball), digest(second.tarball));
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.equal(first.manifest.dependencies['@heluo/forge-member'], '0.1.0');
  assert.deepEqual(first.members, { '@heluo/forge-member': '0.1.0' });
  assert.ok(first.packed.some((file) => file.path === 'node_modules/@heluo/forge-member/src/index.mjs'));
  assert.deepEqual(auditTarball({ label: 'fixture', manifest: first.manifest, packed: first.packed }), []);
  const project = join(root, 'clean-project');
  put(project, 'package.json', { name: 'clean-fixture', private: true });
  execFileSync(npmExecutable(), ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=http://127.0.0.1:9', `--cache=${join(root, 'empty-cache')}`, first.tarball], { cwd: project, stdio: 'pipe' });
  assert.deepEqual(auditReleaseClosure(join(project, 'node_modules/@heluo/forge-enterprise')), []);
  assert.throws(() => buildEnterpriseBundle({ root, destination: join(root, 'one') }), /refusing to replace existing artifact/u);
  assert.deepEqual(readdirSync(join(root, 'one')), ['heluo-forge-enterprise-0.1.0.tgz']);
  const upgrade = buildEnterpriseBundle({ root, destination: join(root, 'upgrade'), version: '0.1.1' });
  assert.equal(upgrade.manifest.version, '0.1.1');
});

for (const [label, overrides, expected] of [
  ['external runtime dependency', { dependencies: { external: '^1.0.0' } }, /unclosed runtime dependency/u],
  ['missing member', { dependencies: { '@heluo/forge-missing': 'workspace:*' } }, /missing workspace member/u],
  ['peer dependency', { peerDependencies: { external: '1.0.0' } }, /unclosed peerDependencies/u],
  ['optional dependency', { optionalDependencies: { external: '1.0.0' } }, /unclosed optionalDependencies/u],
  ['install hook', { scripts: { prepare: 'compile-me' } }, /install-time script prepare/u],
  ['glob resources', { files: ['src/*'] }, /unsafe release resource/u],
  ['escape resources', { files: ['../secret'] }, /unsafe release resource/u],
  ['empty resources', { files: [] }, /must declare release files/u],
]) test(`build refuses ${label} without publishing a partial tarball`, (t) => {
  const root = fixture(t, overrides);
  const destination = join(root, 'release');
  assert.throws(() => buildEnterpriseBundle({ root, destination }), expected);
  assert.equal(existsSync(destination), false);
});

test('buildBundle 以指定安装单元为根闭包构建，默认入口仍是企业组合包', (t) => {
  const root = fixture(t);
  const member = buildBundle({ root, entry: '@heluo/forge-member', destination: join(root, 'member') });
  assert.equal(member.manifest.name, '@heluo/forge-member');
  assert.equal(member.manifest.dependencies, undefined, '无依赖的安装单元不得带 workspace 引用');
  assert.deepEqual(member.members, {});
  assert.deepEqual(auditTarball({ label: 'member', manifest: member.manifest, packed: member.packed }), []);
  const umbrella = buildEnterpriseBundle({ root, destination: join(root, 'umbrella') });
  assert.equal(umbrella.manifest.name, '@heluo/forge-enterprise');
  assert.equal(umbrella.manifest.dependencies['@heluo/forge-member'], '0.1.0');
});

test('build refuses source symlinks and accidentally declared test/cache resources', (t) => {
  const root = fixture(t);
  const source = join(root, 'packages/forge-member/src');
  symlinkSync(join(source, 'index.mjs'), join(source, 'linked.mjs'));
  assert.throws(() => buildEnterpriseBundle({ root, destination: join(root, 'release') }), /symlink is not a release resource/u);
  rmSync(join(source, 'linked.mjs'));
  put(source, 'nested/test/fixture.mjs', 'test fixture\n');
  assert.throws(() => buildEnterpriseBundle({ root, destination: join(root, 'release') }), /non-release resource: test/u);
});

test('release audits reject missing/wrong member, workspace references, undeclared inserts, and source links', (t) => {
  const root = fixture(t);
  const released = join(root, 'release');
  const member = { name: '@heluo/forge-member', version: '0.2.0', main: './src/missing.mjs', files: ['src'] };
  put(released, 'package.json', { name: '@heluo/forge-enterprise', dependencies: { '@heluo/forge-member': '0.1.0', external: 'workspace:*' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { install: 'no' }, peerDependencies: { external: '1' } });
  put(released, 'cordis.patch.yml', '- insert:\n    - id: undeclared\n      name: "@heluo/forge-other"\n');
  let errors = auditReleaseClosure(released);
  assert.ok(errors.some((message) => message.includes('missing member @heluo/forge-member')), errors.join('\n'));
  put(released, 'node_modules/@heluo/forge-member/package.json', member);
  symlinkSync(join(released, 'package.json'), join(released, 'source-link'));
  errors = auditReleaseClosure(released);
  for (const expected of ['install-time script', 'unclosed peerDependencies', 'identity/version mismatch', 'not declared bundled', 'unclosed runtime dependency', 'undeclared member', 'symlink', 'does not exist']) assert.ok(errors.some((message) => message.includes(expected)), `${expected}: ${errors.join('\n')}`);
  put(released, 'node_modules/@heluo/forge-member/package.json', 'not-json');
  assert.ok(auditReleaseClosure(released).some((message) => message.includes('invalid manifest')));
});

test('tarball checker consumes a built umbrella rather than its unresolved source manifest', (t) => {
  const root = fixture(t);
  const checker = fileURLToPath(new URL('../scripts/check-bundle-tarballs.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [checker, root], { encoding: 'utf8' });
  assert.match(output, /bundles: 2 packed/u);
  assert.match(output, /bundles: ok/u);
  put(root, 'packages/forge-member/package.json', 'not-json');
  assert.throws(() => execFileSync(process.execPath, [checker, root], { encoding: 'utf8', stdio: 'pipe' }), (error) => {
    assert.match(error.stderr, /not valid JSON/u);
    assert.match(error.stderr, /package\/build audit failed/u);
    return error.status === 1;
  });
});

test('build CLI emits the final artifact and refuses replacing it', (t) => {
  const root = fixture(t);
  const builder = fileURLToPath(new URL('../scripts/build-enterprise-bundle.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [builder, join(root, 'cli-release')], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.ok(existsSync(result.tarball));
  assert.ok(Object.hasOwn(result.members, '@heluo/forge-sdd'));
  assert.throws(() => execFileSync(process.execPath, [builder, join(root, 'cli-release')], { stdio: 'pipe' }), (error) => error.status === 1 && /refusing to replace/u.test(error.stderr));
});

test('packed closure rejects omitted payloads and unclosed dependencies including peers/kernel', () => {
  const errors = auditTarball({ label: 'broken', manifest: { dependencies: { '@heluo/forge-member': 'workspace:*', '@deepseek-ai/dsh': '1.0.0' }, bundledDependencies: ['@heluo/forge-member', '@deepseek-ai/dsh'], peerDependencies: { unknown: '*' } }, packed: [{ path: 'node_modules/@deepseek-ai/dsh/lib/index.js' }, { path: 'node_modules/@heluo/forge-member/test/index.test.mjs' }] });
  for (const expected of ['unclosed runtime dependency', 'missing bundled member', 'external/kernel package', 'unclosed peerDependencies', 'must not ship']) assert.ok(errors.some((message) => message.includes(expected)), errors.join('\n'));
});
