#!/usr/bin/env node
// #37 AC4：真实 tarball 闭包核验。对每个有清单的 packages/*、services/* 目录跑
// `npm pack --dry-run --json`；有运行时依赖的包（enterprise 组合包、devops 单安装单元）
// 先按该包为根构建真正的自包含 tarball 再审计、清理 —— dry-run 清单里依赖仍是
// `workspace:*`，直接审计只会得到 unclosed runtime dependency。
// 不联网、不安装，把实际文件列表与模式位交给 auditTarball。用 npm 而不是 pnpm：
// 而 pack 的文件选择与模式位正是 npm 的实现语义。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBundle } from './build-enterprise-bundle.mjs';

import { auditTarball, npmExecutable, parsePackOutput } from './lib/bundle-rules.mjs';

const root = resolve(process.argv[2] ?? process.cwd());

const targets = [];
for (const group of ['packages', 'services']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      targets.push({
        label: `${group}/${entry.name}`,
        dir: join(dir, entry.name),
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      });
    } catch (error) {
      targets.push({ label: `${group}/${entry.name}`, dir: join(dir, entry.name), manifest: null, error });
    }
  }
}

const npm = npmExecutable();
const errors = [];
let packedFiles = 0;
for (const target of targets) {
  if (target.manifest === null) {
    errors.push(`bundle: ${target.label}/package.json is not valid JSON`);
    continue;
  }
  let packed;
  try {
    if (Object.keys(target.manifest.dependencies ?? {}).length > 0) {
      const result = buildBundle({ root, entry: target.manifest.name });
      packedFiles += result.packed.length;
      errors.push(...auditTarball({ label: target.label, manifest: result.manifest, packed: result.packed }));
      const artifactDir = dirname(result.tarball);
      if (dirname(artifactDir) === tmpdir() && basename(artifactDir).startsWith('forge-bundle-artifact-')) rmSync(artifactDir, { recursive: true, force: true });
      continue;
    }
    const output = execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: target.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    packed = parsePackOutput(output);
    if (packed === null) {
      // Report which npm produced the unparsable output instead of guessing: the
      // shape differs between npm major versions and between "npm not found on
      // PATH" and "npm printed a notice first".
      const version = execFileSync(npm, ['--version'], {
        cwd: target.dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const head = output.replaceAll(/\s+/gu, ' ').trim().slice(0, 160);
      errors.push(`bundle: ${target.label} npm pack --dry-run produced no parsable file list (${npm} v${version}; stdout starts: ${head || '<empty>'})`);
      continue;
    }
  } catch (error) {
    errors.push(`bundle: ${target.label} package/build audit failed (${npm}): ${String(error.message).split('\n')[0]}`);
    continue;
  }
  packedFiles += packed.length;
  errors.push(...auditTarball({ label: target.label, manifest: target.manifest, packed }));
}

console.log(`bundles: ${targets.length} packed, ${packedFiles} files`);
for (const error of errors) console.error(`- ${error}`);
if (errors.length > 0) {
  console.error(`bundles: ${errors.length} error(s)`);
  process.exit(1);
}
console.log('bundles: ok');
