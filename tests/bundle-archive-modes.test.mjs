// 归属：issue #123 报告 5.1（Windows 上 bin 可执行位丢失）。
// 规则侧的证据：`withExecutableModes` 真的把 tar 头改对，声明项缺席时真的报错，
// `auditTarball` 的索引判据真的会失败。夹具用最小 ustar 手工构造，避免依赖外部 tar。
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { readBundleEntries, withExecutableModes, executableTargets } from '../scripts/lib/bundle-archive.mjs';
import { auditTarball } from '../scripts/lib/bundle-rules.mjs';

const BLOCK = 512;

function ustarHeader(name, mode, size, typeflag = '0') {
  const header = Buffer.alloc(BLOCK, 0);
  const put = (text, offset, length) => header.write(text, offset, length, 'latin1');
  put(name, 0, 100);
  put(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put(`${'0'.repeat(11)}\0`, 136, 12);
  put('        ', 148, 8);
  put(typeflag, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

function tarball(files) {
  const blocks = [];
  for (const { name, mode, body } of files) {
    blocks.push(ustarHeader(name, mode, body.length), body, Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK - body.length));
  }
  blocks.push(Buffer.alloc(BLOCK));
  return gzipSync(Buffer.concat(blocks));
}

const binBody = Buffer.from('#!/usr/bin/env node\nconsole.log("heluo");\n', 'utf8');
const sample = () => tarball([
  { name: 'package/package.json', mode: 0o644, body: Buffer.from('{"name":"fixture"}\n', 'utf8') },
  { name: 'package/bin/heluo-forge.mjs', mode: 0o644, body: binBody },
]);

test('withExecutableModes 把 bin 补成 0755，内容与其余条目不动', () => {
  const source = sample();
  const patched = withExecutableModes(source, new Set(['bin/heluo-forge.mjs']));
  assert.notEqual(patched, source);
  const before = readBundleEntries(source, { withContent: true });
  const after = readBundleEntries(patched, { withContent: true });
  assert.deepEqual(after.map((entry) => entry.path), before.map((entry) => entry.path));
  const bin = after.find((entry) => entry.path === 'bin/heluo-forge.mjs');
  assert.equal(bin.mode, '0755');
  assert.equal(bin.sha256, before.find((entry) => entry.path === 'bin/heluo-forge.mjs').sha256);
  assert.equal(after.find((entry) => entry.path === 'package.json').mode, '0644');
});

test('withExecutableModes 声明了却找不到条目时直接报错，不静默放过', () => {
  assert.throws(() => withExecutableModes(sample(), new Set(['bin/nonexistent.mjs'])), /no entry for declared executable bin\/nonexistent\.mjs/u);
});

test('withExecutableModes 模式已正确时原样返回字节', () => {
  const source = tarball([{ name: 'package/bin/heluo-forge.mjs', mode: 0o755, body: binBody }]);
  assert.equal(withExecutableModes(source, new Set(['bin/heluo-forge.mjs'])).equals(source), true);
});

test('executableTargets 只收带前缀的字面 bin 路径', () => {
  const manifest = { bin: { 'heluo-forge': './bin/heluo-forge.mjs', glob: './bin/*.mjs' } };
  assert.deepEqual([...executableTargets(manifest, 'node_modules/@heluo/forge-iam/')], ['node_modules/@heluo/forge-iam/bin/heluo-forge.mjs']);
});

test('auditTarball 的索引判据会失败，也会在有 +x 记录时放行', () => {
  const manifest = { name: '@heluo/forge-iam', version: '0.1.0', bin: { 'heluo-forge': './bin/heluo-forge.mjs' }, main: './src/index.mjs', files: ['src', 'bin'] };
  const packed = [
    { path: 'package.json', mode: 0o644 },
    { path: 'README.md', mode: 0o644 },
    { path: 'src/index.mjs', mode: 0o644 },
    { path: 'bin/heluo-forge.mjs', mode: 0o644 },
  ];
  const missing = auditTarball({ label: 'packages/forge-iam', manifest, packed, executablePaths: new Set() });
  assert.ok(missing.some((error) => error.includes('bin.heluo-forge ./bin/heluo-forge.mjs is not executable (git index records it without +x)')), missing.join('\n'));
  const recorded = auditTarball({ label: 'packages/forge-iam', manifest, packed, executablePaths: new Set(['bin/heluo-forge.mjs']) });
  assert.equal(recorded.some((error) => error.includes('is not executable')), false, recorded.join('\n'));
});
