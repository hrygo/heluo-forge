import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractTarball } from '../src/tarball.mjs';

function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 'utf8');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  block.write('0000000\0', 136, 'utf8');
  block.write(type, 156, 'utf8');
  block.write('ustar\0', 257, 'utf8');
  block.write('00', 263, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  return block;
}

function tar(entries) {
  const parts = [];
  for (const [path, content] of entries) {
    const body = Buffer.from(content);
    parts.push(header(path, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('reads files out of a gzipped tarball', () => {
  const archive = tar([
    ['package.json', '{"name":"@heluo/a"}'],
    ['src/index.mjs', 'export const x = 1;\n'],
  ]);
  const result = extractTarball(archive);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.path), ['package.json', 'src/index.mjs']);
  assert.equal(result.files[1].bytes.toString('utf8'), 'export const x = 1;\n');
});

test('rejects traversal entries and garbage input', () => {
  assert.equal(extractTarball(tar([['../evil', 'x']])).reason, 'unsafe-path');
  assert.equal(extractTarball(Buffer.from('not a tarball')).reason, 'empty-archive');
  assert.equal(extractTarball(tar([])).reason, 'empty-archive');
});

test('refuses archives above the size limit', () => {
  assert.equal(extractTarball(tar([['package.json', '{}']]), { maxBytes: 1 }).reason, 'archive-too-large');
});

test('a truncated header stops with a reason instead of a RangeError', () => {
  const archive = tar([['package.json', '{}']]);
  const cut = archive.subarray(0, 20);
  const result = extractTarball(cut);
  assert.equal(result.ok, false);
});

test('detects a body shorter than its header claims', () => {
  const plain = gunzipSync(tar([['package.json', 'x'.repeat(700)]]));
  const result = extractTarball(plain.subarray(0, 512 + 100));
  assert.equal(result.reason, 'truncated-archive');
});

test('refuses bytes that claim gzip but cannot be inflated', () => {
  assert.equal(extractTarball(Buffer.from([0x1f, 0x8b, 0x00, 0x00])).reason, 'bad-archive');
});

test('skips directory entries and pax headers', () => {
  const plain = gunzipSync(tar([
    ['pax_global_header', 'x'],
    ['src/', ''],
    ['package.json', '{}'],
  ]));
  const result = extractTarball(plain);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.path), ['package.json']);
});

test('refuses a gzip bomb without inflating it', () => {
  const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024));
  const result = extractTarball(bomb, { maxBytes: 1024 * 1024 });
  assert.equal(result.reason, 'archive-too-large');
});
