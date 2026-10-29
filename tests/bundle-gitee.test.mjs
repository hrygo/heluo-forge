import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBundle } from '../scripts/build-enterprise-bundle.mjs';
import { auditTarball, npmExecutable, parsePackOutput } from '../scripts/lib/bundle-rules.mjs';

// 归属：docs/teamflow/20261029-r4-forge-gitee PRD AC-2 / AC-3 / AC-5（安装单元闭包、分发白名单、
// 产物与工作区一致）与 AC-24 / AC-25（证据与登记是交付物的一部分）。
// 规则本身由 scripts/lib/bundle-rules.mjs 提供，这里补的是"这个包作为单安装单元"的真实产物证据：
// 真实 buildBundle、真实 npm pack、真实 tgz 字节，而不是清单里写了什么。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages/forge-gitee');

const withTemp = (prefix, body) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const nts = (buffer) => buffer.toString('utf8').replace(/\0.*$/su, '').trim();

/** 读 tgz 里的条目（只认 ustar，够读 `npm pack` 的产物；不引入外部依赖）。 */
function readTarball(path) {
  const tar = gunzipSync(readFileSync(path));
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = nts(header.subarray(0, 100));
    const prefix = nts(header.subarray(345, 500));
    const size = parseInt(nts(header.subarray(124, 136)) || '0', 8);
    const typeflag = header[156];
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (typeflag === 0 || typeflag === 48) {
      const full = (prefix === '' ? name : `${prefix}/${name}`).replace(/^\.\//u, '');
      entries.set(full, body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('安装单元把 workspace 依赖闭包成真版本，产物里只有一个已声明的成员（AC-3）', () => {
  const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(source.dependencies['@heluo/forge-policy'], 'workspace:*', '工作区只留源码清单');

  withTemp('gitee-bundle-', (dir) => {
    const built = buildBundle({ root, entry: '@heluo/forge-gitee', destination: dir });
    const artifact = readTarball(built.tarball);
    const manifest = JSON.parse(artifact.get('package/package.json').toString('utf8'));

    assert.equal(manifest.name, '@heluo/forge-gitee');
    assert.match(manifest.dependencies['@heluo/forge-policy'], /^\d+\.\d+\.\d+$/u, '安装单元必须是真版本');
    assert.deepEqual(manifest.bundledDependencies, ['@heluo/forge-policy'], '闭包成员必须声明为 bundled');
    assert.equal(manifest.peerDependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.ok(artifact.has('package/node_modules/@heluo/forge-policy/package.json'), '被闭包成员必须真的进包');
    assert.equal(JSON.stringify(manifest).includes('workspace:'), false, '产物里不许残留 workspace 协议');
    const packed = [...artifact.keys()].map((path) => ({ path: path.replace(/^package\//u, '') }));
    assert.deepEqual(auditTarball({ label: 'forge-gitee', manifest, packed }), []);
  });
});

test('分发内容就是产物内容：源码、补丁层与 README，无测试与编译产物（AC-2）', () => {
  const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(source.private, true);
  assert.equal(source.type, 'module');
  assert.match(source.engines.dsh, /^>=\d+\.\d+\.\d+-rc\.\d+$/u);
  assert.equal(source.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(packageDir, 'cordis.patch.yml')));
  assert.deepEqual(source.files, ['src', 'cordis.patch.yml', 'README.md']);

  // 入口文件必须落在 files 白名单里，否则装上就是"清单指向不存在的文件"。
  const declared = [source.main, ...Object.values(source.exports ?? {})];
  for (const target of declared) {
    const relative = target.replace(/^\.\//u, '');
    assert.ok(existsSync(join(packageDir, relative)), `入口 ${target} 不存在`);
    assert.ok(
      source.files.some((entry) => relative === entry || relative.startsWith(`${entry.replace(/\/$/u, '')}/`)),
      `入口 ${target} 不在 files 白名单内`,
    );
  }

  const dryRun = spawnSync(npmExecutable(), ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(dryRun.status, 0, `npm pack --dry-run 失败：${dryRun.stderr}`);
  const paths = parsePackOutput(dryRun.stdout).map((entry) => entry.path);
  for (const required of ['package.json', 'README.md', 'cordis.patch.yml', 'src/index.mjs', 'src/gitee-cli.mjs']) {
    assert.ok(paths.includes(required), `分发内容缺 ${required}`);
  }
  for (const path of paths) {
    assert.equal(/^(?:test|tests|coverage)\//u.test(path), false, `分发内容不该含 ${path}`);
    assert.equal(path.startsWith('node_modules/'), false, `分发内容不该含 ${path}`);
    assert.equal(path.endsWith('.tgz'), false, `分发内容不该含 ${path}`);
    assert.equal(path.startsWith('lib/') || path.startsWith('dist/'), false, `分发内容不该含编译产物 ${path}`);
  }

  // 声明与实际必须同一份：dry-run 的文件集 = 产物文件集（减掉闭包成员的 node_modules 部分）。
  withTemp('gitee-pack-', (dir) => {
    const built = buildBundle({ root, entry: '@heluo/forge-gitee', destination: dir });
    const shipped = [...readTarball(built.tarball).keys()]
      .map((path) => path.replace(/^package\//u, ''))
      .filter((path) => !path.startsWith('node_modules/'));
    assert.deepEqual(shipped.sort(), [...paths].sort(), '分发清单与产物内容不一致');
  });
});

test('产物入口与工作区逐字节一致，缺失或被改动都能被测出来（AC-5）', () => {
  withTemp('gitee-artifact-', (dir) => {
    const built = buildBundle({ root, entry: '@heluo/forge-gitee', destination: dir });
    const artifact = readTarball(built.tarball);
    const entryPath = 'package/src/index.mjs';

    assert.ok(artifact.has(entryPath), '产物里必须有入口文件');
    assert.equal(
      sha256(artifact.get(entryPath)),
      sha256(readFileSync(join(packageDir, 'src/index.mjs'))),
      '产物入口必须与工作区逐字节一致（无构建期改写）',
    );
    assert.equal(artifact.has('package/lib/index.mjs'), false, '不得有编译产物');
    assert.equal(artifact.has('package/dist/index.mjs'), false, '不得有编译产物');

    // 反向：拷一份产物改一个字节，摘要必须变——否则上面的断言与"读出来的字节"无关。
    const copy = join(dir, 'tampered.tgz');
    const flipped = Buffer.from(readFileSync(built.tarball));
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    writeFileSync(copy, flipped);
    assert.throws(() => readTarball(copy), '被破坏的产物不该还能读出条目');
  });
});

test('设计索引与包 README 登记的是实现的现状，不是规划（AC-24 / AC-25）', () => {
  const index = readFileSync(join(root, 'docs/design/README.md'), 'utf8');
  const row = index.split('\n').find((line) => line.startsWith('| `@heluo/forge-gitee`'));
  assert.ok(row, '设计索引必须登记 forge-gitee');
  assert.match(row, /plugins\/forge-gitee\.md/u, '索引行必须指向模块设计');

  const design = readFileSync(join(root, 'docs/design/plugins/forge-gitee.md'), 'utf8');
  assert.match(design, /\|\s*模块状态\s*\|\s*可用/u, '模块设计必须声明实现状态');
  assert.match(design, /NOT RUN/u, '模块设计必须记账未验项');

  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
  assert.match(readme, /^状态：可用/mu, '包 README 的状态必须与实现一致');
  for (const heading of ['## 安装', '## 配置', '## 回滚', '## 证据表', '## 未验（NOT RUN）']) {
    assert.ok(readme.includes(heading), `包 README 缺 ${heading}`);
  }
  // 证据表五列是 AC-24 的字段口径：命令、时间、宿主版本、目标对象、来源类型。
  const header = readme.split('\n').find((line) => line.startsWith('| # | 命令 |'));
  assert.ok(header, '证据表必须有表头');
  for (const column of ['命令', '时间', '宿主版本', '目标对象', '来源类型']) {
    assert.ok(header.includes(column), `证据表缺列 ${column}`);
  }
});
