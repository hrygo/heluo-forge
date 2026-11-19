/**
 * 离线 workspace 链接的自证：`scripts/link-workspace.mjs`（AC：CI 零安装也能解析 @heluo/*）。
 *
 * 覆盖：模式解析、链接建立、幂等、占位不覆盖、非本 scope 忽略、无工作区文件时零副作用。
 * 全部在 mkdtemp 出来的临时仓库里跑，不碰真实仓库的 node_modules。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPackages, linkWorkspace, readWorkspacePatterns } from '../scripts/link-workspace.mjs';

function tempRepo() {
  return mkdtempSync(join(tmpdir(), 'heluo-link-'));
}

function addPackage(root, dir, name, extra = {}) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, ...extra }, null, 2));
}

function writeWorkspace(root, lines) {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), ['packages:', ...lines.map((l) => `  - ${l}`)].join('\n'));
}

test('readWorkspacePatterns：只取 packages 段的短横线项，遇到下一个顶层键就停', () => {
  const root = tempRepo();
  try {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      ['packages:', '  - packages/*', '  - services/*', 'onlyBuiltDependencies:', '  - esbuild', ''].join('\n'),
    );
    assert.deepEqual(readWorkspacePatterns(root), ['packages/*', 'services/*']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readWorkspacePatterns：没有 pnpm-workspace.yaml 时返回空数组，不抛错', () => {
  const root = tempRepo();
  try {
    assert.deepEqual(readWorkspacePatterns(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkWorkspace：给 @heluo/* 建目录链接，非本 scope 的包不建', () => {
  const root = tempRepo();
  const said = [];
  try {
    writeWorkspace(root, ['packages/*']);
    addPackage(root, 'packages/alpha', '@heluo/alpha');
    addPackage(root, 'packages/beta', '@heluo/beta');
    addPackage(root, 'packages/plain', 'plain-pkg');

    const result = linkWorkspace({ root, write: (line) => said.push(line) });

    assert.deepEqual(result.linked, ['@heluo/alpha', '@heluo/beta']);
    assert.equal(existsSync(join(root, 'node_modules/@heluo/plain-pkg')), false, '非 @heluo/ 不建链接');
    for (const name of ['alpha', 'beta']) {
      const link = join(root, 'node_modules/@heluo', name);
      assert.ok(lstatSync(link).isSymbolicLink(), `${name} 应是符号链接`);
      assert.equal(readlinkSync(link), `../../packages/${name}`, '相对路径要能从 node_modules/@heluo 走回包目录');
    }
    assert.match(said[0], /2 created/, '要报告新建数量');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkWorkspace：第二次运行幂等，已有同指向链接计入 kept 而不是重建', () => {
  const root = tempRepo();
  try {
    writeWorkspace(root, ['packages/*']);
    addPackage(root, 'packages/alpha', '@heluo/alpha');
    linkWorkspace({ root, write: () => {} });
    const again = linkWorkspace({ root, write: () => {} });
    assert.deepEqual(again.linked, []);
    assert.deepEqual(again.kept, ['@heluo/alpha']);
    assert.deepEqual(again.skipped, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkWorkspace：被真实目录占位时不覆盖，计入 skipped', () => {
  const root = tempRepo();
  const said = [];
  try {
    writeWorkspace(root, ['packages/*']);
    addPackage(root, 'packages/alpha', '@heluo/alpha');
    const occupied = join(root, 'node_modules/@heluo/alpha');
    mkdirSync(occupied, { recursive: true });

    const result = linkWorkspace({ root, write: (line) => said.push(line) });

    assert.deepEqual(result.skipped, ['@heluo/alpha']);
    assert.equal(lstatSync(occupied).isSymbolicLink(), false, '占位目录保持原样');
    assert.ok(said.some((line) => line.includes('left alone: @heluo/alpha')), '要点名跳过原因');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverPackages：跳过缺清单、坏清单与无 name 的目录', () => {
  const root = tempRepo();
  try {
    writeWorkspace(root, ['packages/*']);
    addPackage(root, 'packages/alpha', '@heluo/alpha');
    mkdirSync(join(root, 'packages/no-manifest'), { recursive: true });
    mkdirSync(join(root, 'packages/broken'), { recursive: true });
    writeFileSync(join(root, 'packages/broken/package.json'), '{ not json');
    addPackage(root, 'packages/nameless', undefined);

    assert.deepEqual(
      discoverPackages(root).map((pkg) => pkg.name),
      ['@heluo/alpha'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
