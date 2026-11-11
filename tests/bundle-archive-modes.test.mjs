// 归属：issue #123 报告 5.1（Windows 上 bin 可执行位丢失）。
// 规则侧的证据：`withExecutableModes` 真的把 tar 头改对，声明项缺席时真的报错，
// `auditTarball` 的索引判据真的会失败。夹具用最小 ustar 手工构造，避免依赖外部 tar。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { readBundleEntries, withExecutableModes, executableTargets } from '../scripts/lib/bundle-archive.mjs';
import { auditTarball, gitIndexedModes } from '../scripts/lib/bundle-rules.mjs';

const BLOCK = 512;

function ustarHeader(name, mode, size, typeflag = '0') {
  const header = Buffer.alloc(BLOCK, 0);
  const put = (text, offset, length) => header.write(text, offset, length, 'latin1');
  // tar 头存的是原始字节，npm 按 UTF-8 写路径；夹具同样用 UTF-8，才能覆盖中文入口。
  Buffer.from(name, 'utf8').subarray(0, 100).copy(header, 0);
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

test('withExecutableModes 只认包根坐标，`package/` 前缀不会撞到同名普通文件', () => {
  // 清单里 bin 声明成 `./package/bin/cli.mjs`（包根下真有这么个目录），而包里还有
  // 一个普通的 `bin/cli.mjs`。按"剥前缀再比"的旧逻辑，两者原始路径相同，普通文件
  // 会被一起改成 0755；现在声明项换算成 `package/package/bin/cli.mjs`，对不上就报错。
  const source = tarball([
    { name: 'package/package.json', mode: 0o644, body: Buffer.from('{"name":"fixture"}\n', 'utf8') },
    { name: 'package/bin/cli.mjs', mode: 0o644, body: binBody },
  ]);
  assert.throws(() => withExecutableModes(source, new Set(['./package/bin/cli.mjs'])), /no entry for declared executable package\/bin\/cli\.mjs/u);
  const untouched = readBundleEntries(withExecutableModes(source, new Set()), { withContent: true });
  assert.equal(untouched.find((entry) => entry.path === 'bin/cli.mjs').mode, '0644');
});

test('withExecutableModes 支持非 ASCII 与含空格的入口路径', () => {
  const source = tarball([
    { name: 'package/package.json', mode: 0o644, body: Buffer.from('{"name":"fixture"}\n', 'utf8') },
    { name: 'package/bin/入口 工具.mjs', mode: 0o644, body: binBody },
  ]);
  const patched = withExecutableModes(source, new Set(['bin/入口 工具.mjs']));
  const entries = readBundleEntries(patched, { withContent: true });
  assert.equal(entries.find((entry) => entry.path === 'bin/入口 工具.mjs').mode, '0755');
});

test('executableTargets 只收带前缀的字面 bin 路径', () => {
  const manifest = { bin: { 'heluo-forge': './bin/heluo-forge.mjs', glob: './bin/*.mjs' } };
  assert.deepEqual([...executableTargets(manifest, 'node_modules/@heluo/forge-iam/')], ['node_modules/@heluo/forge-iam/bin/heluo-forge.mjs']);
});

const auditManifest = { name: '@heluo/forge-iam', version: '0.1.0', bin: { 'heluo-forge': './bin/heluo-forge.mjs' }, main: './src/index.mjs', files: ['src', 'bin'] };
const auditPacked = [
  { path: 'package.json', mode: 0o644 },
  { path: 'README.md', mode: 0o644 },
  { path: 'src/index.mjs', mode: 0o644 },
  { path: 'bin/heluo-forge.mjs', mode: 0o644 },
];

test('auditTarball 的索引判据会失败，也会在有 +x 记录时放行', () => {
  const missing = auditTarball({ label: 'packages/forge-iam', manifest: auditManifest, packed: auditPacked, indexModes: new Map([['bin/heluo-forge.mjs', '100644']]) });
  assert.ok(missing.some((error) => error.includes('bin.heluo-forge ./bin/heluo-forge.mjs is not executable (git index records it without +x)')), missing.join('\n'));
  const recorded = auditTarball({ label: 'packages/forge-iam', manifest: auditManifest, packed: auditPacked, indexModes: new Map([['bin/heluo-forge.mjs', '100755']]) });
  assert.equal(recorded.some((error) => error.includes('is not executable')), false, recorded.join('\n'));
});

test('auditTarball 把未跟踪的入口当成无法判定，不报错', () => {
  // 索引里没有 bin/heluo-forge.mjs：新建入口还没 `git add`，不能据此判缺陷。
  const errors = auditTarball({ label: 'packages/forge-iam', manifest: auditManifest, packed: auditPacked, indexModes: new Map([['src/index.mjs', '100644']]) });
  assert.equal(errors.some((error) => error.includes('is not executable')), false, errors.join('\n'));
});

test('auditTarball 没有索引依据时不在 Windows 上中止构建', { skip: process.platform !== 'win32' }, () => {
  // 无 `.git` 或 Git 不在 PATH：indexModes 为 null，pack 输出恒为 0644，必须跳过。
  const errors = auditTarball({ label: 'packages/forge-iam', manifest: auditManifest, packed: auditPacked, indexModes: null });
  assert.equal(errors.some((error) => error.includes('is not executable')), false, errors.join('\n'));
});

test('auditTarball 索引里的中文入口路径按原样匹配', () => {
  const manifest = { name: '@heluo/forge-iam', version: '0.1.0', bin: { 'heluo-forge': './bin/入口.mjs' }, main: './src/index.mjs', files: ['src', 'bin'] };
  const packed = [...auditPacked.filter((entry) => !entry.path.startsWith('bin/')), { path: 'bin/入口.mjs', mode: 0o644 }];
  const errors = auditTarball({ label: 'packages/forge-iam', manifest, packed, indexModes: new Map([['bin/入口.mjs', '100755']]) });
  assert.equal(errors.some((error) => error.includes('is not executable')), false, errors.join('\n'));
});

test('gitIndexedModes 原样保留中文与含空格的路径，并区分未跟踪', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-modes-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git('init', '-q');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', '入口.mjs'), 'x');
    writeFileSync(join(dir, 'bin', 'two  spaces.mjs'), 'x');
    git('add', 'bin');
    git('update-index', '--chmod=+x', '--', 'bin/入口.mjs');
    const modes = gitIndexedModes(dir);
    assert.equal(modes.get('bin/入口.mjs'), '100755');
    assert.equal(modes.get('bin/two  spaces.mjs'), '100644');
    writeFileSync(join(dir, 'bin', 'untracked.mjs'), 'x');
    assert.equal(modes.has('bin/untracked.mjs'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
