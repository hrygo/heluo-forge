import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { buildEnterpriseBundle } from '../scripts/build-enterprise-bundle.mjs';
import { readBundleEntries, summarizeBundle } from '../scripts/lib/bundle-archive.mjs';
import { createBundleManifest, diffBundleManifest, parseBundleManifest, serializeBundleManifest, serializeSha256Sums } from '../scripts/lib/bundle-manifest.mjs';
import { verifyBundle } from '../scripts/verify-enterprise-bundle.mjs';
import { createReleaseTree, ENTRY } from './fixtures/release-tree.mjs';

const builder = fileURLToPath(new URL('../scripts/build-enterprise-bundle.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-enterprise-bundle.mjs', import.meta.url));
const TARBALL_NAME = 'heluo-forge-enterprise-0.1.0.tgz';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value)}\n`;
/**
 * The CLI tests used to build the real workspace. A clean checkout must now
 * refuse that (issue #216), so they build a staged fixture instead and keep
 * asserting the sidecar/refusal contract through the same entry point. The real
 * six-package closure is still packed and audited by `check-bundle-tarballs`.
 */
const releaseTree = (t) => createReleaseTree(t, { triples: ['linux-x64-gnu'] });

// Minimal ustar writer: the real artifact cannot be byte-patched without
// rebuilding the whole archive, so negative cases use synthetic single-point
// mutations instead (TECHNICAL §7).
const BLOCK = 512;
const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

function tarHeader({ name, mode, size, type }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode & 0o7777, 8), 100, 8, 'latin1');
  header.write(octal(0, 8), 108, 8, 'latin1');
  header.write(octal(0, 8), 116, 8, 'latin1');
  header.write(octal(size, 12), 124, 12, 'latin1');
  header.write(octal(0, 12), 136, 12, 'latin1');
  header.write('        ', 148, 8, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function tarStream(files) {
  const chunks = [];
  for (const file of files) {
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
    chunks.push(tarHeader({ name: file.name, mode: file.mode ?? 0o644, size: body.length, type: file.type ?? '0' }));
    chunks.push(body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}

function baseFiles({ binMode = 0o755, dependencies = {}, extra = [] } = {}) {
  return [
    { name: 'package/package.json', body: json({ name: ENTRY, version: '0.1.0', bin: { 'forge-verify': './bin/cli.mjs' } }) },
    { name: 'package/README.md', body: '# Enterprise bundle fixture\n' },
    { name: 'package/src/index.mjs', body: 'export const fixture = true;\n' },
    { name: 'package/bin/cli.mjs', body: '#!/usr/bin/env node\nconsole.log("fixture");\n', mode: binMode },
    { name: 'package/node_modules/@heluo/forge-member/package.json', body: json({ name: '@heluo/forge-member', version: '0.1.0', dependencies }) },
    { name: 'package/node_modules/@heluo/forge-member/src/index.mjs', body: 'export const member = true;\n' },
    { name: 'package/node_modules/@heluo/forge-core/package.json', body: json({ name: '@heluo/forge-core', version: '0.1.0' }) },
    ...extra,
  ];
}

function manifestFor(tarballPath, entries, { members = {} } = {}) {
  const bytes = readFileSync(tarballPath);
  return createBundleManifest({
    entry: { name: ENTRY, version: '0.1.0' },
    members: { [ENTRY]: '0.1.0', '@heluo/forge-member': '0.1.0', '@heluo/forge-core': '0.1.0', ...members },
    tarball: { name: basename(tarballPath), sha256: digest(bytes), bytes: bytes.length },
    entries,
    toolchain: { node: process.version, npm: '11.6.2' },
  });
}

/** Synthetic artifact: tarball plus (optionally) the manifest describing it. */
function artifact(t, { manifest = true, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tarballPath = join(dir, TARBALL_NAME);
  writeFileSync(tarballPath, tarStream(baseFiles(options)));
  const entries = readBundleEntries(tarballPath);
  const manifestPath = join(dir, 'bundle-manifest.json');
  if (manifest) writeFileSync(manifestPath, serializeBundleManifest(manifestFor(tarballPath, entries)));
  return { dir, tarballPath, manifestPath, entries, files: baseFiles(options) };
}

function runCli(script, args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('staged release tree: build sidecar, verify, and refuse to overwrite', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = releaseTree(t);
  const build = (destination) => runCli(builder, ['--root', tree.root, destination]);
  const built = build(dir);
  assert.equal(built.status, 0, built.stderr);
  const result = JSON.parse(built.stdout);
  assert.ok(Number.isInteger(result.files) && result.files > 0);
  assert.equal(existsSync(result.manifest), true);
  assert.equal(existsSync(result.sums), true);
  const sums = readFileSync(result.sums, 'utf8');
  assert.match(sums, /^[0-9a-f]{64} {2}heluo-forge-enterprise-0\.1\.0\.tgz\n[0-9a-f]{64} {2}bundle-manifest\.json\n$/u);
  const [tarballLine, manifestLine] = sums.trimEnd().split('\n');
  assert.equal(tarballLine.slice(0, 64), digest(readFileSync(result.tarball)));
  assert.equal(manifestLine.slice(0, 64), digest(readFileSync(result.manifest)));

  const verdict = verifyBundle(result.tarball);
  assert.equal(verdict.ok, true, verdict.errors.join('\n'));
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.summary.fileCount, result.files);
  assert.equal(verdict.manifest.files.length, result.files);
  assert.equal(verdict.summary.memberCount, 2);
  assert.equal(verdict.summary.entryName, ENTRY);
  assert.equal(verdict.summary.sha256, digest(readFileSync(result.tarball)));
  assert.equal(verdict.manifest.formatVersion, 1);

  const cli = runCli(verifier, [result.tarball]);
  assert.equal(cli.status, 0, cli.stdout);
  const lines = cli.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `bundle: heluo-forge-enterprise-0.1.0.tgz | ${result.files} files | ${verdict.summary.totalBytes} bytes | sha256 ${verdict.summary.sha256}`);
  assert.equal(lines[1], 'bundle: manifest ok (formatVersion 1, 2 packages)');
  assert.equal(lines[2], 'bundle: ok');

  // Second build into the same directory: refused, and the first sidecar is untouched.
  const manifestBefore = readFileSync(result.manifest, 'utf8');
  const again = build(dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /refusing to replace existing artifact/u);
  assert.equal(readFileSync(result.manifest, 'utf8'), manifestBefore);
  assert.ok(!readdirSync(dir).some((name) => name.endsWith('.tmp')), readdirSync(dir).join(','));
  assert.deepEqual(readdirSync(dir).sort(), ['SHA256SUMS', 'bundle-manifest.json', TARBALL_NAME]);
});

test('a sidecar failure rolls the tarball back and leaves no partial artifact', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = releaseTree(t);
  // A leftover SHA256SUMS makes the second sidecar write fail after the first
  // one already landed; the build must not leave either of them behind.
  writeFileSync(join(dir, 'SHA256SUMS'), 'preserved\n');
  const built = runCli(builder, ['--root', tree.root, dir]);
  assert.equal(built.status, 1);
  assert.match(built.stderr, /refusing to replace existing artifact SHA256SUMS/u);
  assert.deepEqual(readdirSync(dir), ['SHA256SUMS']);
  assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), 'preserved\n');
});

test('two builds of the same tree share a tarball hash and manifest', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-verify-repro-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : json(value));
  };
  const member = { name: '@heluo/forge-member', version: '0.1.0', type: 'module', main: './src/index.mjs', files: ['src', 'README.md'] };
  const enterprise = { ...member, name: ENTRY, dependencies: { [member.name]: 'workspace:*' }, bundledDependencies: [member.name] };
  for (const pkg of [member, enterprise]) {
    const path = `packages/${pkg.name.slice('@heluo/'.length)}`;
    put(`${path}/package.json`, pkg);
    put(`${path}/README.md`, '# Reproducible fixture\n');
    put(`${path}/src/index.mjs`, 'export const fixture = true;\n');
  }
  const first = buildEnterpriseBundle({ root, destination: join(root, 'first') });
  const second = buildEnterpriseBundle({ root, destination: join(root, 'second') });
  assert.equal(digest(readFileSync(first.tarball)), digest(readFileSync(second.tarball)));
  const firstEntries = readBundleEntries(first.tarball);
  const secondEntries = readBundleEntries(second.tarball);
  assert.deepEqual(firstEntries, secondEntries);
  assert.deepEqual(summarizeBundle(firstEntries), summarizeBundle(secondEntries));
  assert.equal(verifyBundle(first.tarball).ok, true);
});

test('content tamper, undeclared file, deleted file and mode drift are all rejected', (t) => {
  const fixture = artifact(t);
  const rewrite = (files) => writeFileSync(fixture.tarballPath, tarStream(files));
  const replace = (name, body, mode) => fixture.files.map((file) => (file.name === name ? { ...file, body, mode: mode ?? file.mode } : file));

  // ① one changed byte inside a shipped file.
  rewrite(replace('package/src/index.mjs', 'export const fixture = trVe;\n'));
  let verdict = verifyBundle(fixture.tarballPath);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors[0], /^package\/src\/index\.mjs: sha256 mismatch/u);

  // ② a file the manifest never declared.
  rewrite([...fixture.files, { name: 'package/extra.mjs', body: 'export const extra = true;\n' }]);
  verdict = verifyBundle(fixture.tarballPath);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0], 'package/extra.mjs: not declared in manifest');

  // ④ a declared file removed from the tarball.
  rewrite(fixture.files.filter((file) => file.name !== 'package/README.md'));
  verdict = verifyBundle(fixture.tarballPath);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0], 'package/README.md: missing from tarball');
});

test('structure rules catch workspace references, shipped tests and a non-executable bin', (t) => {
  const workspace = artifact(t, { manifest: false, dependencies: { '@heluo/forge-core': 'workspace:*' } });
  let verdict = verifyBundle(workspace.tarballPath);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0], 'package/node_modules/@heluo/forge-member/package.json: unclosed dependencies @heluo/forge-core (workspace:*)');

  const tests = artifact(t, { manifest: false, extra: [{ name: 'package/tests/unit.test.mjs', body: 'export const test = 1;\n' }] });
  verdict = verifyBundle(tests.tarballPath);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('package/tests/unit.test.mjs: must not ship tests'), verdict.errors.join('\n'));

  const bin = artifact(t, { manifest: false, binMode: 0o644 });
  verdict = verifyBundle(bin.tarballPath);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('package/bin/cli.mjs: bin forge-verify is not executable (mode 0644)'), verdict.errors.join('\n'));

  // Without a manifest the structural rules still decide the verdict.
  assert.equal(verifyBundle(artifact(t, { manifest: false }).tarballPath).ok, true);
  assert.equal(verifyBundle(artifact(t, { manifest: false }).tarballPath).manifest, null);
});

test('archive reader rejects unsafe paths, duplicates, links and broken streams', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.tgz');
  const one = (name, extra = {}) => [{ name, body: 'x\n', ...extra }];

  for (const name of ['package/../evil.txt', 'package//double.txt', '/absolute.txt', 'other/root.txt', 'package/trailing/']) {
    writeFileSync(path, tarStream(one(name)));
    assert.throws(() => readBundleEntries(path), /bundle archive: unsafe path/u, name);
  }
  writeFileSync(path, tarStream([...one('package/a.mjs'), ...one('package/a.mjs')]));
  assert.throws(() => readBundleEntries(path), /bundle archive: duplicate path "a\.mjs"/u);
  writeFileSync(path, tarStream(one('package/link.mjs', { type: '2' })));
  assert.throws(() => readBundleEntries(path), /bundle archive: unsupported type "2"/u);
  assert.throws(() => readBundleEntries(Buffer.from('not a tarball')), /bundle archive: not a gzip stream/u);
  writeFileSync(path, gzipSync(tarHeader({ name: 'package/truncated.mjs', mode: 0o644, size: 4096, type: '0' })));
  assert.throws(() => readBundleEntries(path), /bundle archive: truncated tar/u);
});

test('manifest boundaries: unknown version, unsorted, duplicated and escaping paths', (t) => {
  const fixture = artifact(t);
  const manifest = manifestFor(fixture.tarballPath, fixture.entries);
  const text = serializeBundleManifest(manifest);
  assert.equal(serializeBundleManifest(parseBundleManifest(text)), text);

  assert.throws(() => parseBundleManifest(text.replace('"formatVersion": 1', '"formatVersion": 2')), /unsupported formatVersion 2/u);
  const unsorted = JSON.parse(text);
  unsorted.files = [...unsorted.files].reverse();
  assert.throws(() => parseBundleManifest(JSON.stringify(unsorted)), /files must be sorted by path/u);
  const duplicated = JSON.parse(text);
  duplicated.files = [duplicated.files[0], duplicated.files[0]];
  assert.throws(() => parseBundleManifest(JSON.stringify(duplicated)), /duplicate file/u);
  const escaping = JSON.parse(text);
  escaping.files[0] = { ...escaping.files[0], path: '../evil.mjs' };
  assert.throws(() => parseBundleManifest(JSON.stringify(escaping)), /unsafe file path/u);
  assert.throws(() => parseBundleManifest('not json'), /not valid JSON/u);

  // A version the verifier cannot understand is refused, never guessed.
  writeFileSync(fixture.manifestPath, text.replace('"formatVersion": 1', '"formatVersion": 2'));
  const verdict = verifyBundle(fixture.tarballPath);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0], 'bundle-manifest.json: unsupported formatVersion 2 (expected 1)');

  // Toolchain records the build host and must not fail a cross-machine check.
  assert.deepEqual(diffBundleManifest(manifest, { ...manifest, toolchain: { node: 'v0.0.0', npm: '0.0.0' } }), []);
  const drifted = { ...manifest, files: manifest.files.map((file, index) => (index === 0 ? { ...file, sha256: 'f'.repeat(64) } : file)) };
  assert.ok(diffBundleManifest(manifest, drifted).some((line) => line.includes('sha256 mismatch')));
  assert.match(serializeSha256Sums([{ sha256: 'a'.repeat(64), name: 'x.tgz' }]), /^a{64} {2}x\.tgz\n$/u);
});

test('verifier CLI uses exit codes 0/1/2 as documented', (t) => {
  const fixture = artifact(t);
  assert.equal(runCli(verifier, [fixture.tarballPath]).status, 0);
  assert.equal(runCli(verifier, []).status, 2);
  assert.equal(runCli(verifier, [join(fixture.dir, 'missing.tgz')]).status, 2);
  assert.equal(runCli(verifier, [fixture.tarballPath, '--manifest', join(fixture.dir, 'missing.json')]).status, 2);
  assert.equal(runCli(verifier, [fixture.tarballPath, '--bogus']).status, 2);

  // exit 1 keeps one line per difference and names the first one.
  writeFileSync(fixture.tarballPath, tarStream(fixture.files.map((file) => (file.name === 'package/README.md' ? { ...file, body: '# tampered\n' } : file))));
  const failed = runCli(verifier, [fixture.tarballPath]);
  assert.equal(failed.status, 1);
  const lines = failed.stdout.trimEnd().split('\n');
  assert.match(lines.at(-1), /^bundle: failed with \d+ error\(s\); first: package\/README\.md: (sha256|size) mismatch/u);
  assert.ok(!/\n\s+at /u.test(failed.stdout), 'no stack traces on the CLI surface');
});

test('the verifier CLI emits one machine-readable verdict with --json', (t) => {
  const fixture = artifact(t);
  const okRun = runCli(verifier, [fixture.tarballPath, '--json']);
  assert.equal(okRun.status, 0);
  const verdict = JSON.parse(okRun.stdout);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tarball, 'heluo-forge-enterprise-0.1.0.tgz');
  assert.ok(verdict.files > 0 && verdict.bytes > 0);
  assert.match(verdict.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(verdict.entry.name, ENTRY);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.members['@heluo/forge-member'], '0.1.0');
  assert.equal(verdict.members['@heluo/forge-enterprise'], '0.1.0');

  // A failing artifact still gives a parseable verdict and exit 1, because the
  // release script must be able to branch on the verdict, not on message text.
  writeFileSync(fixture.tarballPath, tarStream(fixture.files.map((file) => (file.name === 'package/README.md' ? { ...file, body: '# tampered\n' } : file))));
  const failedRun = runCli(verifier, [fixture.tarballPath, '--json']);
  assert.equal(failedRun.status, 1);
  const failedVerdict = JSON.parse(failedRun.stdout);
  assert.equal(failedVerdict.ok, false);
  assert.ok(failedVerdict.errors.length > 0);
  assert.match(failedVerdict.errors[0], /package\/README\.md: (sha256|size) mismatch/u);

  // Usage errors stay exit 2 and stay on the text surface.
  assert.equal(runCli(verifier, ['--json']).status, 2);
  assert.equal(runCli(verifier, [fixture.tarballPath, '--json', fixture.tarballPath]).status, 2);
});
