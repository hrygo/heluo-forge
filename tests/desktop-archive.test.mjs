/**
 * The packed runtime, checked against what was staged (CORP-DSH-PLAN-026 §4.3-7).
 *
 * The embedded runtime is packed into `app.asar` by electron-builder, and what
 * it hands to the operating system is unpacked beside the archive. Nothing else
 * reads those bytes before the user does, so the build does: the archive must
 * hold exactly the files the rule lets through, byte for byte as staged, and no
 * native program or library may be left inside it. Every negative case here is
 * an archive electron-builder could produce from a wrong configuration.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ArchiveError, openArchive, verifyRuntimeArchive } from '../scripts/lib/desktop-archive.mjs';
import { writeAsar } from './support/asar-fixture.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Paths from the resources root, the way the rules see them. */
const N = 'dsh/node_modules/';
/** Magic numbers: a 64-bit Mach-O and an ELF, the formats that ship extensionless programs. */
const MACHO = Buffer.from('cffaedfe000000020000000000000000', 'hex');
const ELF = Buffer.from('7f454c46020101000000000000000000', 'hex');

/**
 * A staged tree in the image of the real one, and the archive electron-builder
 * makes of it when the configuration is right. Listed by hand: the verifier is
 * checked against what the rules mean, not against the rules themselves.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-archive-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, 'app', '.staged', 'resources');
  const write = (rel, content) => {
    mkdirSync(dirname(join(resources, rel)), { recursive: true });
    writeFileSync(join(resources, rel), content);
  };
  write(`${N}@deepseek-ai/dsh/lib/bin.js`, 'entry');
  // Types of the artifact travel verbatim; types anywhere else are left out.
  write(`${N}@deepseek-ai/dsh/lib/types/bin.d.ts`, 'types of the artifact');
  write(`${N}@deepseek-ai/dsh-llm/lib/index.js`, 'module');
  write(`${N}@deepseek-ai/dsh-llm/lib/types/index.d.ts`, 'types left out by the rule');
  write(`${N}@deepseek-ai/dsh-llm/lib/index.js.map`, 'map left out by the rule');
  write(`${N}node-pty/prebuilds/darwin-arm64/pty.node`, MACHO);
  write(`${N}@vscode/ripgrep-darwin-arm64/bin/rg`, MACHO);
  write(`${N}@deepseek-ai/libreoffice-kit-darwin-arm64/bin/dsoffice`, MACHO);
  write(`${N}@deepseek-ai/libreoffice-kit-darwin-arm64/program/registry/main.xcd`, 'registry');
  // A dependency's manifest as the registry laid it down; electron-builder strips the metadata from it on the way in.
  write(
    `${N}some-package/package.json`,
    JSON.stringify({ name: 'some-package', version: '1.0.0', scripts: { build: 'tsc' }, keywords: ['search'], bugs: { url: 'https://example.invalid' }, _id: 'some-package@1.0.0', dependencies: { dep: '^1.0.0' } }, null, 2),
  );
  // The manifest of a tree that is unpacked whole is cleaned the same way before it is written beside the archive.
  write(
    `${N}@deepseek-ai/libreoffice-kit-darwin-arm64/package.json`,
    JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-darwin-arm64', version: '0.2.3', keywords: ['libreoffice'], bugs: { url: 'https://example.invalid' } }, null, 2),
  );
  mkdirSync(dirname(join(resources, `${N}.bin/dsh`)), { recursive: true });
  symlinkSync('../@deepseek-ai/dsh/lib/bin.js', join(resources, `${N}.bin/dsh`));
  // Beside the archive, as it was staged: not the verifier's subject.
  write('brand/tray.png', 'png');
  // On disk the link names its target from its own directory; in the archive, from the archive's root.
  const faithful = [
    { path: 'src/main.mjs', content: 'the shell itself: not the runtime' },
    { path: `${N}@deepseek-ai/dsh/lib/bin.js`, content: 'entry' },
    { path: `${N}@deepseek-ai/dsh/lib/types/bin.d.ts`, content: 'types of the artifact' },
    { path: `${N}@deepseek-ai/dsh-llm/lib/index.js`, content: 'module' },
    { path: `${N}node-pty/prebuilds/darwin-arm64/pty.node`, content: MACHO, unpacked: true },
    { path: `${N}@vscode/ripgrep-darwin-arm64/bin/rg`, content: MACHO, unpacked: true },
    { path: `${N}@deepseek-ai/libreoffice-kit-darwin-arm64/bin/dsoffice`, content: MACHO, unpacked: true },
    { path: `${N}@deepseek-ai/libreoffice-kit-darwin-arm64/program/registry/main.xcd`, content: 'registry', unpacked: true },
    { path: `${N}.bin/dsh`, link: `${N}@deepseek-ai/dsh/lib/bin.js` },
    { path: `${N}some-package/package.json`, content: JSON.stringify({ name: 'some-package', version: '1.0.0', dependencies: { dep: '^1.0.0' } }, null, 2) },
    { path: `${N}@deepseek-ai/libreoffice-kit-darwin-arm64/package.json`, content: JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-darwin-arm64', version: '0.2.3' }, null, 2), unpacked: true },
  ];
  return { archivePath: join(root, 'out', 'resources', 'app.asar'), faithful, resources, root, write };
}

const PACKED_BYTES = 'entry'.length + 'types of the artifact'.length + 'module'.length + '{\n  "name": "some-package",\n  "version": "1.0.0",\n  "dependencies": {\n    "dep": "^1.0.0"\n  }\n}'.length;

test('an archive made as configured holds exactly the staged runtime: packed, unpacked and linked as the rules say', (t) => {
  const f = fixture(t);
  writeAsar(f.archivePath, f.faithful);
  const summary = verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: f.resources });
  assert.deepEqual(summary, { files: 10, packed: 4, unpacked: 5, links: 1, trimmedManifests: 2, bytes: PACKED_BYTES, archiveBytes: statSync(f.archivePath).size });
});

test('反向：归档内容与暂存不一致时构建失败，并点出是哪一条', (t) => {
  const f = fixture(t);
  const verify = () => verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: f.resources });
  const change = (path, patch) => f.faithful.map((entry) => (entry.path === path ? { ...entry, ...patch } : entry));
  const without = (path) => f.faithful.filter((entry) => entry.path !== path);
  const plus = (entry) => [...f.faithful, entry];
  const fails = (entries, code, pattern) => {
    writeAsar(f.archivePath, entries);
    assert.throws(() => verify(), (error) => error instanceof ArchiveError && error.code === code && pattern.test(error.message), `${code} ${pattern}: ${entries.length} entries`);
  };

  // Bytes: the archive is not what was staged.
  fails(change(`${N}@deepseek-ai/dsh/lib/bin.js`, { content: 'tampered' }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  // A manifest may lack what electron-builder removes, and nothing the runtime reads.
  fails(change(`${N}some-package/package.json`, { content: JSON.stringify({ name: 'some-package', version: '1.0.0' }) }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  fails(change(`${N}some-package/package.json`, { content: JSON.stringify({ name: 'some-package', version: '1.0.1', dependencies: { dep: '^1.0.0' } }) }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  fails(change(`${N}some-package/package.json`, { content: 'not json' }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  // The copy beside the archive is held to the same: it may lack what is removed, and nothing else.
  fails(change(`${N}@deepseek-ai/libreoffice-kit-darwin-arm64/package.json`, { physical: JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-darwin-arm64' }) }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  // Staged after packing: the same file, another content on disk.
  writeAsar(f.archivePath, f.faithful);
  f.write(`${N}@deepseek-ai/dsh-llm/lib/index.js`, 'edited after packing');
  assert.throws(() => verify(), (error) => error.code === 'ARCHIVE_MISMATCH' && /bytes differ/u.test(error.message));
  f.write(`${N}@deepseek-ai/dsh-llm/lib/index.js`, 'module');

  // Membership: a file missing, one that was never staged, one the rule leaves out.
  fails(without(`${N}@deepseek-ai/dsh-llm/lib/index.js`), 'ARCHIVE_MISMATCH', /missing/u);
  fails(plus({ path: `${N}@deepseek-ai/dsh-llm/lib/extra.js`, content: 'never staged' }), 'ARCHIVE_MISMATCH', /not staged/u);
  fails(plus({ path: `${N}@deepseek-ai/dsh-llm/lib/types/index.d.ts`, content: 'types left out by the rule' }), 'ARCHIVE_MISMATCH', /leaves out/u);

  // The unpack rule, both ways: what must be a real file is not, and what is to stay packed was made one.
  fails(change(`${N}node-pty/prebuilds/darwin-arm64/pty.node`, { unpacked: false }), 'NATIVE_PACKED', /pty\.node/u);
  fails(change(`${N}@deepseek-ai/libreoffice-kit-darwin-arm64/program/registry/main.xcd`, { unpacked: false }), 'ARCHIVE_MISMATCH', /must be unpacked/u);
  fails(change(`${N}@deepseek-ai/dsh/lib/bin.js`, { unpacked: true }), 'ARCHIVE_MISMATCH', /not to be unpacked/u);
  // An unpacked entry whose copy on disk is missing, or is not the staged file.
  fails(change(`${N}node-pty/prebuilds/darwin-arm64/pty.node`, { physical: null }), 'ARCHIVE_MISMATCH', /nothing on disk/u);
  fails(change(`${N}@vscode/ripgrep-darwin-arm64/bin/rg`, { physical: ELF }), 'ARCHIVE_MISMATCH', /bytes differ/u);
  // A file on disk that is not an entry of the archive would be found by nothing that reads the archive.
  writeAsar(f.archivePath, f.faithful);
  mkdirSync(dirname(join(`${f.archivePath}.unpacked`, N, 'node-pty', 'stale.node')), { recursive: true });
  writeFileSync(join(`${f.archivePath}.unpacked`, N, 'node-pty', 'stale.node'), MACHO);
  assert.throws(() => verify(), (error) => error.code === 'ARCHIVE_MISMATCH' && /on disk but not an entry/u.test(error.message));

  // Links: the archive's link points where the staged one does, and never out of the archive.
  fails(change(`${N}.bin/dsh`, { link: `${N}@deepseek-ai/dsh-llm/lib/index.js` }), 'ARCHIVE_MISMATCH', /link/u);
  symlinkSync('../../../../../../outside', join(f.resources, `${N}.bin/escape`));
  writeAsar(f.archivePath, [...f.faithful, { path: `${N}.bin/escape`, link: '../../../../../../outside' }]);
  assert.throws(() => verify(), (error) => error.code === 'ARCHIVE_MISMATCH' && /link/u.test(error.message));
});

test('反向：规则不认识的原生程序被留在归档里时构建失败，并点出路径；绕过规则解包同样失败', (t) => {
  const f = fixture(t);
  f.write(`${N}some-new-package/native/helper`, ELF);
  const helper = { path: `${N}some-new-package/native/helper`, content: ELF };
  // The content says it is a program the operating system would have to open: packed is refused by name.
  writeAsar(f.archivePath, [...f.faithful, helper]);
  assert.throws(() => verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: f.resources }), (error) => error.code === 'NATIVE_PACKED' && /some-new-package\/native\/helper/u.test(error.message));
  // Unpacked without the rule saying so is not a way around: the rule is the one place that says what is unpacked.
  writeAsar(f.archivePath, [...f.faithful, { ...helper, unpacked: true }]);
  assert.throws(() => verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: f.resources }), (error) => error.code === 'ARCHIVE_MISMATCH' && /not to be unpacked/u.test(error.message));
});

test('反向：读不出归档或找不到暂存树时不放行', (t) => {
  const f = fixture(t);
  const verify = () => verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: f.resources });
  mkdirSync(dirname(f.archivePath), { recursive: true });
  // Empty, and not an archive at all.
  writeFileSync(f.archivePath, Buffer.alloc(0));
  assert.throws(verify, (error) => error.code === 'ARCHIVE_INVALID');
  writeFileSync(f.archivePath, 'PK\u0003\u0004 not an asar');
  assert.throws(verify, (error) => error.code === 'ARCHIVE_INVALID');
  // A header that describes more than the file holds behind it.
  writeAsar(f.archivePath, f.faithful);
  writeFileSync(f.archivePath, readFileSync(f.archivePath).subarray(0, 24));
  assert.throws(() => openArchive(f.archivePath), (error) => error.code === 'ARCHIVE_INVALID');
  // No staged tree to compare against is not a pass.
  writeAsar(f.archivePath, f.faithful);
  assert.throws(() => verifyRuntimeArchive({ archivePath: f.archivePath, resourcesDir: join(f.root, 'nowhere') }), (error) => error.code === 'ARCHIVE_UNVERIFIED');
});

test('the reader reads what @electron/asar writes: the archive electron-builder packs with', async (t) => {
  const pkg = join(REPO_ROOT, 'node_modules', '.pnpm', 'app-builder-lib@26.0.12_dmg-builder@26.0.12_electron-builder-squirrel-windows@26.0.12_supports-color@7.2.0', 'node_modules', 'app-builder-lib', 'package.json');
  if (!existsSync(pkg)) {
    t.skip('app-builder-lib is not installed here');
    return;
  }
  const asar = createRequire(pkg)('@electron/asar');
  const root = mkdtempSync(join(tmpdir(), 'forge-asar-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'src');
  for (const [rel, content] of [[`${N}a/lib/index.js`, 'module'], [`${N}a/native/addon.node`, MACHO], ['deeply/nested/dir/file.txt', 'text']]) {
    mkdirSync(dirname(join(source, rel)), { recursive: true });
    writeFileSync(join(source, rel), content);
  }
  const archivePath = join(root, 'app.asar');
  await asar.createPackageWithOptions(source, archivePath, { unpack: '**/native/*.node' });
  const archive = openArchive(archivePath);
  t.after(() => archive.close());
  assert.deepEqual([...archive.files.keys()].sort(), [`${N}a/lib/index.js`, `${N}a/native/addon.node`, 'deeply/nested/dir/file.txt'].sort());
  // The flag Electron redirects an archive path by.
  assert.equal(archive.files.get(`${N}a/native/addon.node`).unpacked, true);
  assert.equal(archive.files.get(`${N}a/lib/index.js`).unpacked, undefined);
  // A packed entry: its bytes are the file's. An unpacked one: its size, and the bytes are on disk.
  assert.equal(archive.read(archive.files.get(`${N}a/lib/index.js`)).toString(), 'module');
  assert.equal(archive.read(archive.files.get('deeply/nested/dir/file.txt')).toString(), 'text');
  assert.equal(archive.files.get(`${N}a/native/addon.node`).size, MACHO.length);
  assert.equal(existsSync(join(`${archivePath}.unpacked`, N, 'a', 'native', 'addon.node')), true);
});
