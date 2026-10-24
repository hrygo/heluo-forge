#!/usr/bin/env node
// #37 AC4：真实 tarball 闭包核验。对每个有清单的 packages/*、services/* 目录跑
// `npm pack --dry-run --json`（不写 tarball、不联网、不安装），把实际文件列表与模式位
// 交给 auditTarball 对照声明。用 npm 而不是 pnpm：CI 只装 Node、不装 pnpm，
// 而 pack 的文件选择与模式位正是 npm 的实现语义。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { auditTarball, parsePackOutput } from './lib/bundle-rules.mjs';

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

const errors = [];
let packedFiles = 0;
for (const target of targets) {
  if (target.manifest === null) {
    errors.push(`bundle: ${target.label}/package.json is not valid JSON`);
    continue;
  }
  let packed;
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: target.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    packed = parsePackOutput(output);
    if (packed === null) {
      errors.push(`bundle: ${target.label} npm pack --dry-run produced no parsable file list`);
      continue;
    }
  } catch (error) {
    errors.push(`bundle: ${target.label} npm pack --dry-run failed: ${String(error.message).split('\n')[0]}`);
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
