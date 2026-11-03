#!/usr/bin/env node
// 离线 workspace 链接：给仓库根的 node_modules 建 `@heluo/<包名>` 符号链接。
//
// 为什么需要：CI 的 `node --run check` 刻意不安装依赖（见 .github/workflows/check.yml
// 的 "avoid dependency installation" 注释）。而包内测试按裸包名 import 同仓的兄弟包
// （例如 `@heluo/forge-policy`），没有 node_modules 就 ERR_MODULE_NOT_FOUND。
// 这里只做 `pnpm install` 本来就会建的那一层目录链接：不联网、不下载、不执行脚本。
//
// 归属：docs/engineering/development-conventions.md §「本地检查」。

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPE = '@heluo';
export const LINK_ROOT = 'node_modules';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..');

/** 读 pnpm-workspace.yaml 里的 packages 目录模式（只认 `- <pattern>` 行，够用即止）。 */
export function readWorkspacePatterns(root = REPO_ROOT) {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const patterns = [];
  let inPackages = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const match = /^\s*-\s*(\S+)\s*$/.exec(line);
    if (match) patterns.push(match[1]);
  }
  return patterns;
}

/** 把 `packages/*` 这类模式展开成实际目录（只展开一层通配）。 */
export function expandPatterns(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      if (existsSync(join(root, pattern))) dirs.push(pattern);
      continue;
    }
    const [prefix] = pattern.split('*');
    const base = join(root, prefix);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(join(prefix, entry.name).replace(/\/+/g, '/'));
    }
  }
  return dirs;
}

/** 收集工作区里能按包名解析的包：返回 [{ name, dir }]，跳过无清单或无名的目录。 */
export function discoverPackages(root = REPO_ROOT) {
  const packages = [];
  for (const dir of expandPatterns(root, readWorkspacePatterns(root))) {
    const manifestPath = join(root, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
    } catch {
      continue;
    }
    if (typeof name !== 'string' || !name.startsWith(`${SCOPE}/`)) continue;
    packages.push({ name, dir });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/**
 * 建链接。已存在且指向同一目录 → 计为 kept（幂等）；被别的东西占着 → 计为 skipped，
 * 不覆盖（`pnpm install` 用 .pnpm 布局时也是链接，这里照样保留）。
 */
export function linkWorkspace({ root = REPO_ROOT, write = console.log } = {}) {
  const targetDir = join(root, LINK_ROOT, SCOPE);
  mkdirSync(targetDir, { recursive: true });
  const linked = [];
  const kept = [];
  const skipped = [];
  for (const pkg of discoverPackages(root)) {
    const name = pkg.name.slice(SCOPE.length + 1);
    const linkPath = join(targetDir, name);
    const expected = relative(targetDir, join(root, pkg.dir));
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      if (isSymlink(linkPath) && readlinkSync(linkPath) === expected) kept.push(pkg.name);
      else skipped.push(pkg.name);
      continue;
    }
    symlinkSync(expected, linkPath, 'dir');
    linked.push(pkg.name);
  }
  write(
    `workspace links: ${linked.length} created, ${kept.length} already present, ${skipped.length} left alone`,
  );
  for (const name of skipped) write(`  left alone: ${name}（已存在且不是指向同仓的链接）`);
  return { linked, kept, skipped };
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node scripts/link-workspace.mjs\n\n在仓库根 node_modules/@heluo 下建包名链接（离线、幂等），供不装依赖的 CI 解析裸包名。');
  } else {
    linkWorkspace();
  }
}
