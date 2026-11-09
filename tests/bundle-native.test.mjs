import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../scripts/build-enterprise-bundle.mjs';
import { auditStagedNativeResources, parseNativeChecksums } from '../scripts/lib/native-resources.mjs';
import { verifyBundle } from '../scripts/verify-enterprise-bundle.mjs';
import { createReleaseTree, ENTRY, MEMBER, put, TRIPLES } from './fixtures/release-tree.mjs';

/**
 * Issue #216 regression cover.
 *
 * The defect was not a wrong hash or a wrong path: a clean checkout produced an
 * enterprise tarball whose `vendor/` held only the record and the README, every
 * gate stayed green, and the profile failed closed at mount on the target
 * machine. These fixtures reproduce that shape without staging real addons: the
 * record declares four triples, and the build either refuses to pack or the
 * verifier refuses the artifact.
 *
 * Two of these cases exist because the first version of the fix missed them: a
 * record that the release file set does not carry is invisible to the artifact
 * gate, and a defective record inside an archive used to escape as an exception
 * instead of a verdict.
 */

const verifier = fileURLToPath(new URL('../scripts/verify-enterprise-bundle.mjs', import.meta.url));

const release = (t, options = {}) => createReleaseTree(t, options);

test('a fully staged release packs four addons and verifies', (t) => {
  const { root, vendorDir, member } = release(t);
  assert.deepEqual(auditStagedNativeResources({ dir: dirname(vendorDir), label: MEMBER, releaseFiles: member.files }), []);
  const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'release') });
  for (const triple of TRIPLES) {
    assert.ok(
      result.packed.some((file) => file.path === `node_modules/${MEMBER}/vendor/${triple}/keyring.node`),
      `${triple} addon must be packed`,
    );
  }
  const verdict = verifyBundle(result.tarball);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
});

test('every mapped platform resolves to an addon the artifact actually ships', async (t) => {
  // The record names four triples and the loader maps four platform pairs; these
  // are separate assertions today. This joins them: what the loader looks up is
  // what the artifact must contain, so a mapping change cannot silently ship an
  // addon nobody loads (or look for one nobody ships).
  const { nativeTargetFor } = await import('../packages/forge-credentials-keychain/src/native-keyring.mjs');
  const { root } = release(t);
  const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'release') });
  for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const triple = nativeTargetFor(platform, arch);
    assert.ok(triple, `${platform}-${arch} must map to a delivery triple`);
    assert.ok(
      result.packed.some((file) => file.path === `node_modules/${MEMBER}/vendor/${triple}/keyring.node`),
      `${platform}-${arch} resolves to ${triple}, so the artifact must ship that addon`,
    );
  }
  assert.equal(nativeTargetFor('darwin', 'arm64'), undefined, 'macOS keeps the encrypted document backend, not an addon');
});

test('a clean checkout cannot produce the #216 artifact', (t) => {
  // Only the record and the README are staged, exactly what git tracks.
  const { root } = release(t, { staged: [] });
  const destination = join(root, 'release');
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination }),
    (error) =>
      /4 recorded file\(s\) missing: .*linux-arm64-gnu\/keyring\.node/u.test(error.message)
      && /4 addon license\(s\) missing/u.test(error.message)
      && /fetch-native-keyring/u.test(error.message),
  );
  assert.equal(existsSync(destination), false, 'a refused build must not leave an artifact directory');
});

test('one missing addon fails the release build and names the triple', (t) => {
  const { root } = release(t, { staged: TRIPLES.filter((triple) => triple !== 'win32-x64-msvc') });
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    (error) => /1 recorded file\(s\) missing: win32-x64-msvc\/keyring\.node/u.test(error.message)
      && /1 addon license\(s\) missing: win32-x64-msvc/u.test(error.message),
  );
});

test('a record the release files do not carry is refused', (t) => {
  // #216's blind spot one level up: the record and its bytes exist on disk, but
  // `files` omits `vendor/`, so nothing about them ever reaches the artifact and
  // the artifact gate has nothing to judge.
  const { root } = release(t, { memberFiles: ['src', 'README.md'] });
  const destination = join(root, 'release');
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination }),
    /vendor\/ is not part of the release files, so neither the record nor its addons ship; add "vendor" to files/u,
  );
  assert.equal(existsSync(destination), false);
});

test('declaring only the record does not satisfy the release build', (t) => {
  const { root } = release(t, { memberFiles: ['src', 'vendor/CHECKSUMS.json', 'README.md'] });
  const destination = join(root, 'release');
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination }),
    /vendor\/ is not part of the release files/u,
  );
  assert.equal(existsSync(destination), false);
});

for (const [ignored, expected] of [
  ['*.node', /packed 4 recorded file\(s\) missing/u],
  ['CHECKSUMS.json', /packed vendor\/CHECKSUMS\.json is missing/u],
]) {
  test(`the build refuses an archive when npm excludes ${ignored}`, (t) => {
    const { root, vendor } = release(t);
    put(root, `${vendor}/.npmignore`, `${ignored}\n`);
    const destination = join(root, 'release');
    assert.throws(() => buildBundle({ root, entry: ENTRY, destination }), expected);
    assert.equal(existsSync(destination), false);
  });
}

test('the keychain package cannot build when its entire vendor directory is missing', (t) => {
  const { root, vendorDir } = release(t, { memberFiles: ['src', 'README.md'] });
  rmSync(vendorDir, { recursive: true });
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /vendor\/CHECKSUMS\.json.*missing/u,
  );
});

test('tampered addon bytes fail the release build', (t) => {
  const { root } = release(t, { tamper: 'linux-x64-gnu' });
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /linux-x64-gnu\/keyring\.node: \d+ bytes, recorded \d+/u,
  );
});

test('record drift does not hide an unshipped addon', (t) => {
  // Drift in what the record claims about upstream must not hide a missing file.
  const { root, vendorDir } = release(t, { staged: [] });
  const checksums = join(vendorDir, 'CHECKSUMS.json');
  const record = JSON.parse(readFileSync(checksums, 'utf8'));
  record.files['linux-x64-gnu/keyring.node'].sha256 = 'f'.repeat(64);
  writeFileSync(checksums, `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /4 recorded file\(s\) missing/u,
  );
});

test('the verifier rejects a structurally built artifact that lacks the addons', (t) => {
  // This is the artifact #216 shipped: valid structure, valid manifest, no addons.
  const { root } = release(t, { staged: [] });
  const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'release'), requireNativeResources: false });
  const verdict = verifyBundle(result.tarball);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length, 1, verdict.errors.join('\n'));
  assert.match(verdict.errors[0], /vendor\/CHECKSUMS\.json: 4 recorded file\(s\) missing: .*keyring\.node/u);
  assert.match(verdict.errors[0], /4 addon license\(s\) missing/u);
});

test('the verifier rejects a keychain package without its native resource record', (t) => {
  const { root } = release(t, { memberFiles: ['src', 'README.md'] });
  const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'release'), requireNativeResources: false });
  const verdict = verifyBundle(result.tarball);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /forge-credentials-keychain\/vendor\/CHECKSUMS\.json.*missing/u);
});

test('the verifier rejects an artifact whose addon bytes were replaced', (t) => {
  // The archive is gzip, so a packed file cannot be byte-patched in place: build
  // the same tree twice, once intact and once with one addon corrupted, and let
  // structural mode produce both artifacts for the verifier to judge.
  const good = release(t);
  const goodBuild = buildBundle({ root: good.root, entry: ENTRY, destination: join(good.root, 'release') });
  assert.deepEqual(verifyBundle(goodBuild.tarball).errors, []);
  const bad = release(t, { tamper: 'linux-x64-gnu' });
  const badBuild = buildBundle({ root: bad.root, entry: ENTRY, destination: join(bad.root, 'release'), requireNativeResources: false });
  const verdict = verifyBundle(badBuild.tarball);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length, 1, verdict.errors.join('\n'));
  assert.match(verdict.errors[0], /linux-x64-gnu\/keyring\.node: \d+ bytes, recorded \d+/u);
});

test('a defective record inside the artifact is a verdict, not an exception', (t) => {
  // Regression: the artifact audit used to throw, so a corrupt record inside an
  // archive produced an unhandled exception and exit 2 ("usage error") instead of
  // the exit 1 verdict the runbook's failure branch expects.
  const { root } = release(t, { record: '{ this is not json' });
  const built = buildBundle({ root, entry: ENTRY, destination: join(root, 'release'), requireNativeResources: false });
  const verdict = verifyBundle(built.tarball);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length, 1, verdict.errors.join('\n'));
  assert.match(verdict.errors[0], /vendor\/CHECKSUMS\.json: not valid JSON/u);
  assert.throws(
    () => execFileSync(process.execPath, [verifier, built.tarball], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1 && /not valid JSON/u.test(String(error.stdout)),
  );
});

test('a vendor directory without the record is refused instead of packed blind', (t) => {
  const { root, vendorDir } = release(t);
  rmSync(join(vendorDir, 'CHECKSUMS.json'));
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /vendor\/ ships without CHECKSUMS\.json; it cannot be audited/u,
  );
});

test('a record that declares nothing is refused', (t) => {
  const { root } = release(t, { record: { files: {} } });
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /declares no native resource/u,
  );
});

test('an addon without its third-party license is refused', (t) => {
  const { root, vendorDir } = release(t);
  rmSync(join(vendorDir, 'win32-arm64-msvc/LICENSE.third-party.md'));
  assert.throws(
    () => buildBundle({ root, entry: ENTRY, destination: join(root, 'release') }),
    /1 addon license\(s\) missing: win32-arm64-msvc/u,
  );
});

for (const [label, license] of [['empty', ''], ['tampered', 'BAD\n']]) {
  test(`a third-party license that is ${label} fails both build and artifact verification`, (t) => {
    const { root, vendorDir } = release(t);
    writeFileSync(join(vendorDir, 'win32-arm64-msvc/LICENSE.third-party.md'), license);
    assert.throws(
      () => buildBundle({ root, entry: ENTRY, destination: join(root, 'refused') }),
      /win32-arm64-msvc\/LICENSE\.third-party\.md:.*(?:bytes|sha256)/u,
    );
    const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'structural'), requireNativeResources: false });
    const verdict = verifyBundle(result.tarball);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /win32-arm64-msvc\/LICENSE\.third-party\.md:.*(?:bytes|sha256)/u);
  });
}

for (const relative of ['linux-x64-musl/keyring.node', 'linux-x64-gnu/other.node']) {
  test(`an unrecorded native addon ${relative} is refused`, (t) => {
    const { root, vendor } = release(t);
    put(root, `${vendor}/${relative}`, 'unrecorded binary');
    assert.throws(
      () => buildBundle({ root, entry: ENTRY, destination: join(root, 'refused') }),
      /unrecorded native file/u,
    );
    const result = buildBundle({ root, entry: ENTRY, destination: join(root, 'structural'), requireNativeResources: false });
    const verdict = verifyBundle(result.tarball);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /unrecorded native file/u);
  });
}

for (const [label, text, expected] of [
  ['invalid JSON', '{', /not valid JSON/u],
  ['missing files object', '{"package":"@napi-rs/keyring"}', /files must be an object/u],
  ['escaping path', '{"files":{"../escape/keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":1}}}', /unsafe recorded path/u],
  ['parent-directory path', '{"files":{"../keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":1}}}', /unsafe recorded path/u],
  ['bare file name', '{"files":{"keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":1}}}', /unsafe recorded path/u],
  ['bad digest', '{"files":{"linux-x64-gnu/keyring.node":{"sha256":"ABC","bytes":1}}}', /needs a lowercase sha256/u],
  ['zero bytes', '{"files":{"linux-x64-gnu/keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":0}}}', /needs a positive byte count/u],
  ['missing license digest', '{"files":{"linux-x64-gnu/keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":1}}}', /needs a lowercase license sha256/u],
  ['zero license bytes', '{"files":{"linux-x64-gnu/keyring.node":{"sha256":"' + 'a'.repeat(64) + '","bytes":1,"licenseSha256":"' + 'b'.repeat(64) + '","licenseBytes":0}}}', /needs a positive license byte count/u],
]) {
  test(`the record parser rejects ${label}`, () => {
    assert.throws(() => parseNativeChecksums(text, { label: 'fixture' }), expected);
  });
}
