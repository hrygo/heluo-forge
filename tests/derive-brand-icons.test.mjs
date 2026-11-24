import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ICNS_ENTRIES,
  ICO_SIZES,
  IconError,
  buildIcns,
  buildIco,
  deriveAll,
  pngSize,
  readManifest,
  sha256Hex,
  verifyAsset,
} from '../scripts/derive-brand-icons.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/derive-brand-icons.mjs', import.meta.url));
const REPO_ROOT = dirname(dirname(SCRIPT));

// ---- minimal deterministic PNG builder (grayscale, solid) -------------------

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([head, name, data, tail]);
}

function makePng(size, shade = 0x42) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const row = Buffer.alloc(1 + size, shade);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- pure function tests ----------------------------------------------------

test('pngSize 解析尺寸并拒绝非 PNG', () => {
  assert.deepEqual(pngSize(makePng(48)), { width: 48, height: 48 });
  const real = readFileSync(join(REPO_ROOT, 'docs/assets/branding/cyber-long/sizes/app-icon-128.png'));
  assert.deepEqual(pngSize(real), { width: 128, height: 128 });
  assert.throws(() => pngSize(Buffer.alloc(32)), (error) => error.code === 'INVALID_PNG');
});

test('buildIco 产出结构合法的 PNG-in-ICO 容器', () => {
  const entries = ICO_SIZES.map((size) => ({ size, png: makePng(size) }));
  const ico = buildIco(entries);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), entries.length);
  let offset = 6 + entries.length * 16;
  [...entries].sort((a, b) => a.size - b.size).forEach((entry, index) => {
    const base = 6 + index * 16;
    const widthByte = ico.readUInt8(base);
    assert.equal(widthByte, entry.size === 256 ? 0 : entry.size);
    assert.equal(ico.readUInt16LE(base + 4), 1);
    assert.equal(ico.readUInt16LE(base + 6), 32);
    assert.equal(ico.readUInt32LE(base + 8), entry.png.length);
    assert.equal(ico.readUInt32LE(base + 12), offset);
    assert.equal(ico.subarray(offset, offset + 4).toString('hex'), '89504e47');
    offset += entry.png.length;
  });
  assert.equal(offset, ico.length);
});

test('buildIco 反向：条目尺寸与 PNG 实际尺寸不符时报 SIZE_MISMATCH', () => {
  assert.throws(() => buildIco([{ size: 32, png: makePng(64) }]), (error) => error.code === 'SIZE_MISMATCH');
});

test('buildIcns 产出 magic + 长度链完整的 PNG ICNS', () => {
  const entries = ICNS_ENTRIES.map(({ type, size }) => ({ type, png: makePng(size) }));
  const icns = buildIcns(entries);
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  let offset = 8;
  for (const entry of entries) {
    assert.equal(icns.subarray(offset, offset + 4).toString('ascii'), entry.type);
    const length = icns.readUInt32BE(offset + 4);
    assert.equal(icns.subarray(offset + 8, offset + 12).toString('hex'), '89504e47');
    offset += length;
  }
  assert.equal(offset, icns.length);
});

test('buildIcns 反向：未知类型与尺寸不符均报错', () => {
  assert.throws(() => buildIcns([{ type: 'ic99', png: makePng(64) }]), (error) => error.code === 'INVALID_PNG');
  assert.throws(() => buildIcns([{ type: 'ic07', png: makePng(64) }]), (error) => error.code === 'SIZE_MISMATCH');
});

// ---- fixture e2e ------------------------------------------------------------

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'heluo-icons-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Brand-dir fixture with every committed size present (no rasterizer needed). */
function writeBrandFixture(root, { sizes = [16, 32, 48, 64, 128, 256, 512, 1024], dropSizes = [], tamper } = {}) {
  const brandDir = join(root, 'brand');
  mkdirSync(join(brandDir, 'primary'), { recursive: true });
  mkdirSync(join(brandDir, 'sizes'), { recursive: true });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(brandDir, 'primary/app-icon.svg'), svg);
  const assets = [{ path: 'primary/app-icon.svg', bytes: svg.length, sha256: sha256Hex(svg) }];
  for (const size of sizes) {
    const png = makePng(size, 0x7f);
    const relPath = `sizes/app-icon-${size}.png`;
    writeFileSync(join(brandDir, relPath), png);
    const record = { path: relPath, bytes: png.length, sha256: sha256Hex(png) };
    if (tamper?.relPath === relPath) record.sha256 = '0'.repeat(64);
    assets.push(record);
  }
  const manifest = { brand: 'fixture', version: 'T1', assets: sizes.length ? assets : assets };
  writeFileSync(join(brandDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const size of dropSizes) rmSync(join(brandDir, `sizes/app-icon-${size}.png`), { force: true });
  return brandDir;
}

test('deriveAll 全量夹具：产出 ico/icns/png 与派生清单', (t) => {
  const root = tempRoot(t);
  const brandDir = writeBrandFixture(root);
  const outputDir = join(root, 'out');
  const derivation = deriveAll({ brandDir, outputDir, rasterizer: 'none' });
  assert.equal(derivation.schema, 'heluo-brand-icons/1');
  assert.equal(derivation.rasterizer, 'none-needed');
  assert.ok(existsSync(join(outputDir, 'app-icon.ico')));
  assert.ok(existsSync(join(outputDir, 'app-icon.icns')));
  assert.equal(derivation.outputs.filter((entry) => entry.origin === 'committed').length, 8);
  const icoEntry = derivation.outputs.find((entry) => entry.path === 'app-icon.ico');
  assert.equal(icoEntry.sha256, sha256Hex(readFileSync(join(outputDir, 'app-icon.ico'))));
});

test('deriveAll 反向：缺小尺寸且 --rasterizer none 报 MISSING_RASTERIZER', (t) => {
  const root = tempRoot(t);
  const brandDir = writeBrandFixture(root, { dropSizes: [16, 32, 48, 64] });
  assert.throws(
    () => deriveAll({ brandDir, outputDir: join(root, 'out'), rasterizer: 'none' }),
    (error) => error instanceof IconError && error.code === 'MISSING_RASTERIZER',
  );
});

test('deriveAll 反向：manifest 摘要不符报 SOURCE_MISMATCH', (t) => {
  const root = tempRoot(t);
  const brandDir = writeBrandFixture(root, { tamper: { relPath: 'sizes/app-icon-128.png' } });
  assert.throws(
    () => deriveAll({ brandDir, outputDir: join(root, 'out'), rasterizer: 'none' }),
    (error) => error.code === 'SOURCE_MISMATCH',
  );
});

test('verifyAsset：未登记资产拒绝，已登记资产通过', (t) => {
  const root = tempRoot(t);
  const brandDir = writeBrandFixture(root, { sizes: [128] });
  const { byPath } = readManifest(brandDir);
  const verified = verifyAsset(brandDir, byPath, 'sizes/app-icon-128.png');
  assert.equal(verified.entry.bytes, verified.bytes.length);
  assert.throws(() => verifyAsset(brandDir, byPath, 'sizes/app-icon-16.png'), (error) => error.code === 'UNREGISTERED_ASSET');
});

test('CLI 端到端：夹具目录成功退出 0；缺尺寸 + none 退出 4', (t) => {
  const root = tempRoot(t);
  const brandDir = writeBrandFixture(root);
  const output = join(root, 'cli-out');
  const ok = spawnSync(
    process.execPath,
    [SCRIPT, '--brand-dir', brandDir, '--output', output, '--rasterizer', 'none', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(output, 'derivation-manifest.json')));
  // With --json, stdout is the record and nothing else: a reader must not have to trim a trailing line.
  assert.deepEqual(JSON.parse(ok.stdout), JSON.parse(readFileSync(join(output, 'derivation-manifest.json'), 'utf8')));
  assert.match(ok.stderr, /品牌图标派生完成/);

  const plain = spawnSync(
    process.execPath,
    [SCRIPT, '--brand-dir', brandDir, '--output', join(root, 'cli-plain'), '--rasterizer', 'none'],
    { encoding: 'utf8' },
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /品牌图标派生完成/);

  const brokenDir = writeBrandFixture(join(root, 'b'), { dropSizes: [16, 32, 48, 64] });
  const failed = spawnSync(
    process.execPath,
    [SCRIPT, '--brand-dir', brokenDir, '--output', join(root, 'cli-broken'), '--rasterizer', 'none'],
    { encoding: 'utf8' },
  );
  assert.equal(failed.status, 4);
  assert.match(failed.stderr, /MISSING_RASTERIZER/);
});

// ---- real brand suite closure -------------------------------------------------

const BRAND_DIR = join(REPO_ROOT, 'docs/assets/branding/cyber-long');

test('真实品牌套件：8 档 app-icon 切图全部入库，重建免栅格化器', (t) => {
  const root = tempRoot(t);
  const output = join(root, 'out');
  const derivation = deriveAll({ brandDir: BRAND_DIR, outputDir: output, rasterizer: 'none' });
  assert.equal(derivation.rasterizer, 'none-needed');
  assert.deepEqual(
    derivation.outputs.filter((entry) => entry.origin === 'committed').map((entry) => entry.path).sort(),
    [16, 32, 48, 64, 128, 256, 512, 1024].map((size) => `sizes/app-icon-${size}.png`).sort(),
  );
});

test('真实品牌套件：入库的派生产物（小图/ico/icns）均登记 manifest 且摘要一致', () => {
  const { byPath } = readManifest(BRAND_DIR);
  for (const relPath of [
    'sizes/app-icon-16.png',
    'sizes/app-icon-32.png',
    'sizes/app-icon-48.png',
    'sizes/app-icon-64.png',
    'icons/app-icon.ico',
    'icons/app-icon.icns',
  ]) {
    verifyAsset(BRAND_DIR, byPath, relPath);
  }
});

test('真实品牌套件：纯 Node 重建的 ico/icns 与入库副本逐字节一致', (t) => {
  const root = tempRoot(t);
  const output = join(root, 'out');
  deriveAll({ brandDir: BRAND_DIR, outputDir: output, rasterizer: 'none' });
  assert.equal(Buffer.compare(readFileSync(join(output, 'app-icon.ico')), readFileSync(join(BRAND_DIR, 'icons/app-icon.ico'))), 0);
  assert.equal(Buffer.compare(readFileSync(join(output, 'app-icon.icns')), readFileSync(join(BRAND_DIR, 'icons/app-icon.icns'))), 0);
});

test('真实品牌套件反向：任一档源切图变动即使重建偏离入库 ico（判据会失败）', () => {
  const committed = ICO_SIZES.map((size) => ({ size, png: readFileSync(join(BRAND_DIR, `sizes/app-icon-${size}.png`)) }));
  const mutated = committed.map((entry) => (entry.size === 32 ? { size: 32, png: makePng(32) } : entry));
  assert.notEqual(Buffer.compare(buildIco(mutated), readFileSync(join(BRAND_DIR, 'icons/app-icon.ico'))), 0);
});
