import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditRecordAgainstLock, parseNativeChecksums } from '../scripts/lib/native-resources.mjs';

/**
 * The committed record must agree with the pinned lock file without any addon
 * bytes on disk.
 *
 * A clean checkout has no `vendor/<triple>/` (binaries never enter Git), so the
 * byte-level gate cannot run there: `fetch-native-keyring.mjs --check` needs the
 * staged files, and the artifact gate needs a built tarball. That left the two
 * committed documents unjudged in CI — a hand-edited record or a lock bump that
 * forgot the record stayed green until the release machine looked. This file
 * closes that window with documents only.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const record = readJson('packages/forge-credentials-keychain/vendor/CHECKSUMS.json');
const lock = readJson('scripts/native-keyring.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

test('the committed record parses under the artifact rules', () => {
  // No bytes are involved: this only proves the record documents are well formed,
  // which the artifact gate would otherwise discover after a release build.
  const parsed = parseNativeChecksums(JSON.stringify(record), { label: 'CHECKSUMS.json' });
  assert.equal(parsed.triples.length, 4, 'the release covers four delivery triples');
});

test('the committed record agrees with the pinned lock file', () => {
  assert.deepEqual(auditRecordAgainstLock({ record, lock }), []);
});

test('a triple the lock pins but the record omits is reported', () => {
  const broken = clone(record);
  delete broken.files['win32-arm64-msvc/keyring.node'];
  assert.match(
    auditRecordAgainstLock({ record: broken, lock }).join('\n'),
    /win32-arm64-msvc\/keyring\.node is pinned by the lock file but missing from the record/u,
  );
});

test('a triple the record invents is reported', () => {
  const broken = clone(record);
  broken.files['linux-x64-musl/keyring.node'] = { ...broken.files['linux-x64-gnu/keyring.node'], relative: 'linux-x64-musl/keyring.node' };
  assert.match(auditRecordAgainstLock({ record: broken, lock }).join('\n'), /linux-x64-musl\/keyring\.node is not pinned by the lock file/u);
});

test('a drifted source, integrity, version or license is reported per field', () => {
  for (const [field, value] of [
    ['source', '@napi-rs/keyring-linux-x64-gnu@9.9.9'],
    ['integrity', 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='],
    ['version', '2.1.3'],
    ['license', 'Apache-2.0'],
  ]) {
    const broken = clone(record);
    broken.files['linux-x64-gnu/keyring.node'][field] = value;
    const problems = auditRecordAgainstLock({ record: broken, lock }).join('\n');
    assert.match(problems, new RegExp(`linux-x64-gnu/keyring\\.node records ${field} ${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} but the lock file pins`, 'u'));
  }
});

test('a package or version bump on one side only is reported', () => {
  const recordOnly = clone(record);
  recordOnly.version = '2.1.3';
  assert.match(auditRecordAgainstLock({ record: recordOnly, lock }).join('\n'), /version 2\.1\.3 does not match the lock file 2\.1\.2/u);
  const lockOnly = clone(lock);
  lockOnly.package = '@napi-rs/keyring-next';
  assert.match(auditRecordAgainstLock({ record, lock: lockOnly }).join('\n'), /package @napi-rs\/keyring does not match the lock file @napi-rs\/keyring-next/u);
});

test('a lock file without targets is reported instead of passing silently', () => {
  assert.match(auditRecordAgainstLock({ record, lock: {} }).join('\n'), /the lock file has no targets array/u);
  assert.match(auditRecordAgainstLock({ record: null, lock }).join('\n'), /the record is not an object/u);
});
