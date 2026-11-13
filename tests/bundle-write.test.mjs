/**
 * Long-path (pax) coverage for the release tarball writer (issue #254 item 17).
 *
 * The writer falls back to a pax extended header when ustar's name/prefix split
 * cannot represent the path. That fallback must stay readable by the project's own
 * `readBundleEntries()`: the extended header has to carry typeflag `x` and the
 * real entry has to keep its own mode. These cases exist because the previous
 * fallback wrote the pax record as a regular 0644 file, so the reader surfaced
 * `PaxHeaders/entry` as a shipped entry and rejected it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';

// Cannot use the ustar split: the prefix before the last slash is 158 bytes (over
// 155) and the remaining name is 244 bytes (over 100), but the archive path stays
// within the writer's 255-byte limit and the trailing segment fits 100 bytes.
const LONG_DIRECTORY = 'd'.repeat(150);
const LONG_SEGMENT = `artifact-${'f'.repeat(80)}.mjs`;
const LONG_PATH = `${LONG_DIRECTORY}/${LONG_SEGMENT}`;
const BODY = 'export const longPath = true;\n';

const text = (buffer) => buffer.toString('latin1').replace(/[\0 ]/gu, '');

test('pax long-path fallback round-trips through the archive reader', () => {
  const tarball = writeBundleTarball([{ path: LONG_PATH, body: BODY, mode: 0o755 }]);
  const entries = readBundleEntries(tarball, { withContent: true });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [LONG_PATH],
    'the pax extended header must not surface as an entry',
  );
  assert.equal(entries[0].mode, '0755', 'the entry keeps the mode it was written with');
  assert.equal(entries[0].size, Buffer.byteLength(BODY));
  assert.equal(entries[0].content.toString('utf8'), BODY);
});

test('pax extended header is typed x and the following header keeps the file mode', () => {
  const tarball = writeBundleTarball([{ path: LONG_PATH, body: BODY, mode: 0o755 }]);
  const tar = gunzipSync(tarball);
  assert.equal(tar.subarray(156, 157).toString('latin1'), 'x', 'pax header typeflag must be x');
  assert.equal(tar.subarray(0, 100).toString('utf8').replace(/\0.*$/su, ''), 'PaxHeaders/entry');
  const payloadLength = Number.parseInt(text(tar.subarray(124, 136)), 8);
  const entryOffset = 512 + Math.ceil(payloadLength / 512) * 512;
  assert.equal(tar.subarray(entryOffset + 156, entryOffset + 157).toString('latin1'), '0', 'the real entry is a regular file');
  assert.equal(Number.parseInt(text(tar.subarray(entryOffset + 100, entryOffset + 108)), 8), 0o755);
  assert.equal(tar.subarray(entryOffset, entryOffset + 100).toString('utf8').replace(/\0.*$/su, ''), LONG_SEGMENT);
});

test('regular entries keep the mode they were written with', () => {
  const tarball = writeBundleTarball([{ path: 'bin/entry.mjs', body: '#!/bin/sh\n', mode: 0o755 }]);
  const entries = readBundleEntries(tarball);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mode, '0755');
});

test('a long path the fallback cannot express is rejected before writing', () => {
  // One 120-byte segment: no ustar split and the pax entry header name would be
  // truncated, so the writer must refuse instead of emitting an unreadable archive.
  assert.throws(() => writeBundleTarball([{ path: 's'.repeat(120), body: 'x', mode: 0o644 }]), /bundle writer: path segment too long/u);
});
