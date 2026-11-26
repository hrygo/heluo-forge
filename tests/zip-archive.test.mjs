/**
 * Zip reader tests (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * The primary runtime unpacks Python wheels and the Windows Node.js archive
 * through `scripts/lib/zip-archive.mjs`, so what this reader accepts is what
 * can land inside the packaged app. The archives come from the hand-written
 * writer in `fixtures/zip-writer.mjs`, never from the reader itself, and each
 * refusal is shown to be the reader's own verdict and not an accident.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { crc32, readZipEntries, ZipError, ZIP_LIMITS } from '../scripts/lib/zip-archive.mjs';
import { writeZip } from './fixtures/zip-writer.mjs';

const refused = (code) => (error) => error instanceof ZipError && error.code === code;

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-zip-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const MEMBERS = [
  { path: 'pkg', directory: true },
  { path: 'pkg/__init__.py', content: 'VALUE = 1\n', mode: 0o100664 },
  { path: 'pkg/_speedups.so', content: 'x'.repeat(100000), mode: 0o100755 },
  { path: 'pkg/py.typed', content: '' },
  { path: 'pkg-1.0.dist-info', directory: true },
  { path: 'pkg-1.0.dist-info/RECORD', content: 'pkg/__init__.py,,\n' },
];
// The reader lists a directory in byte order, where `-` sorts before `/`.
const PATHS = MEMBERS.map((member) => member.path).sort();

test('CRC-32 计算与标准校验值一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('存储与压缩的成员原样读回：内容、大小、校验值、目录与权限位', () => {
  for (const method of ['store', 'deflate']) {
    const entries = readZipEntries(writeZip(MEMBERS, { method }), { withContent: true });
    assert.deepEqual(entries.map((entry) => entry.path), PATHS, method);
    const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath['pkg/_speedups.so'].content.toString(), 'x'.repeat(100000), `${method}: content comes back byte for byte`);
    assert.equal(byPath['pkg/_speedups.so'].mode, '0755', `${method}: the recorded mode is kept`);
    assert.equal(byPath['pkg/_speedups.so'].crc32, crc32(Buffer.from('x'.repeat(100000))));
    assert.equal(byPath['pkg/__init__.py'].mode, '0664');
    assert.equal(byPath['pkg/py.typed'].size, 0, `${method}: an empty member deflates to nothing`);
    assert.equal(byPath['pkg'].directory, true);
    assert.equal(byPath['pkg'].content, undefined, 'a directory carries no content');
  }
});

test('不带内容读取时只给出目录信息，并接受文件路径作为来源', (t) => {
  const root = temp(t);
  writeFileSync(join(root, 'wheel.whl'), writeZip(MEMBERS));
  const entries = readZipEntries(join(root, 'wheel.whl'));
  assert.deepEqual(entries.map((entry) => entry.path), PATHS);
  assert.equal(entries.every((entry) => entry.content === undefined), true);
  assert.equal(entries.find((entry) => entry.path === 'pkg/__init__.py').size, 'VALUE = 1\n'.length);
});

test('反向：内容与目录记录的 CRC-32 不符即拒（变异证明）', () => {
  const corrupted = writeZip(MEMBERS, { crc: (content) => (crc32(content) ^ 1) >>> 0 });
  assert.throws(() => readZipEntries(corrupted, { withContent: true }), refused('ZIP_CORRUPT'));
  // The directory alone is intact, so the damage shows only once the member is read.
  assert.equal(readZipEntries(corrupted).length, MEMBERS.length);
});

test('反向：成员路径离开解压目录即拒', () => {
  for (const path of ['../evil.py', '/etc/passwd', 'pkg\\..\\evil.py', 'pkg/../evil.py', 'pkg//evil.py', './']) {
    const archive = writeZip([{ path, content: 'x' }]);
    assert.throws(() => readZipEntries(archive), refused('ZIP_CORRUPT'), path);
  }
  // A leading `./` only prefixes a name and is accepted.
  assert.deepEqual(readZipEntries(writeZip([{ path: './pkg/__init__.py', content: 'x' }])).map((entry) => entry.path), ['./pkg/__init__.py']);
});

test('反向：重复成员、截断与非 zip 内容即拒', () => {
  assert.throws(() => readZipEntries(writeZip([{ path: 'a' }, { path: 'a' }])), /duplicate member/u);
  const whole = writeZip(MEMBERS);
  for (const length of [0, 10, whole.length - 1, whole.length - 22]) {
    assert.throws(() => readZipEntries(whole.subarray(0, length)), refused('ZIP_CORRUPT'), `first ${length} bytes`);
  }
  assert.throws(() => readZipEntries(Buffer.from('not a zip archive at all')), refused('ZIP_CORRUPT'));
  // A string is a path by contract; anything that is neither a path nor bytes is refused as such.
  assert.throws(() => readZipEntries(42), /source must be an archive path or a buffer/u);
});

test('反向：声明的大小与实际解压结果不符即拒（变异证明）', () => {
  // Stored, so the central directory sits exactly where the local header, the name and the body end.
  const archive = writeZip([{ path: 'pkg/__init__.py', content: 'VALUE = 1\n' }], { method: 'store' });
  const central = Buffer.concat([Buffer.alloc(30), Buffer.from('pkg/__init__.py'), Buffer.from('VALUE = 1\n')]).length;
  const inflated = Buffer.from(archive);
  inflated.writeUInt32LE('VALUE = 1\n'.length + 1, central + 24);
  assert.throws(() => readZipEntries(inflated, { withContent: true }), /inflates to 10 bytes, not the recorded 11/u);
});

test('反向：不支持的成员归为不支持，而不是损坏', () => {
  const unsupported = refused('ZIP_UNSUPPORTED');
  assert.throws(() => readZipEntries(writeZip([{ path: 'pkg/__init__.py', content: 'x' }], { compression: 99 })), unsupported);
  assert.throws(() => readZipEntries(writeZip([{ path: 'pkg/__init__.py', content: 'x' }], { flags: 0x01 })), unsupported);
  assert.throws(() => readZipEntries(writeZip([{ path: 'pkg/link', content: '', mode: 0o120777 }])), unsupported);
  assert.throws(() => readZipEntries(writeZip([{ path: 'pkg/fifo', content: '', mode: 0o010644 }])), unsupported);
  // The ZIP64 markers in the end record.
  const archive = writeZip([{ path: 'pkg/__init__.py', content: 'x' }]);
  const zip64 = Buffer.from(archive);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => readZipEntries(zip64), unsupported);
});

test('预算：归档、单个成员与总量各有上限，超出即拒', () => {
  const archive = writeZip([{ path: 'pkg/a', content: 'a'.repeat(1000) }, { path: 'pkg/b', content: 'b'.repeat(1000) }]);
  assert.throws(() => readZipEntries(archive, { limits: { ...ZIP_LIMITS, archiveBytes: archive.length - 1 } }), refused('ZIP_TOO_LARGE'));
  assert.throws(() => readZipEntries(archive, { limits: { ...ZIP_LIMITS, fileBytes: 999 } }), refused('ZIP_TOO_LARGE'));
  assert.throws(() => readZipEntries(archive, { limits: { ...ZIP_LIMITS, totalBytes: 1999 } }), refused('ZIP_TOO_LARGE'));
  assert.equal(readZipEntries(archive, { limits: { ...ZIP_LIMITS, totalBytes: 2000 } }).length, 2, 'a payload exactly at the budget is read');
  assert.throws(() => readZipEntries(archive, { limits: { archiveBytes: 1 } }), refused('ZIP_CORRUPT'));
});
