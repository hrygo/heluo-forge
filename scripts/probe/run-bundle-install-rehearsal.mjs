/**
 * #37 E01 安装/升级/卸载/回退演练（AC4 安装语义 + AC6 保护用户工作区）。
 *
 * 全程只在临时目录里做：`npm pack` 打出真实 tarball → 装进临时项目 → 用**装好的**
 * 补丁层做组合 A/B 对照 → 升级 → 回退 → 卸载，每一步都核对用户自建文件未被改动，
 * 并复核仓库工作区没有被写入。不联网、不安装 pnpm、不触碰任何真实 profile。
 *
 * 环境：DSH_BIN（默认 dsh）、DSH_HOST_PROBE_PROFILE（默认 sdk）
 * 退出码：0 全部符合预期；1 有失败项；2 环境不具备（缺 dsh/npm）
 * 证据：临时目录里的 install-rehearsal.json（只含布尔、版本号与退出码）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_HOST_PROBE_PROFILE ?? 'sdk';
const officialRows = ['deepseek-account', 'ui-settings-account', 'llm-deepseek-account', 'llm-deepseek'];

const dir = mkdtempSync(join(tmpdir(), 'forge-install-rehearsal-'));
const project = join(dir, 'project');
const evidence = { probe: 'forge-bundle-install-rehearsal', env: { profile, platform: `${process.platform}-${process.arch}`, node: process.version }, steps: [], ok: true };

const record = (id, ok, detail = {}) => {
  evidence.steps.push({ id, ok, detail });
  if (!ok) evidence.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

const npm = (args, options = {}) =>
  execFileSync('npm', ['--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

const pack = (packageDir, destination) => {
  mkdirSync(destination, { recursive: true });
  npm(['pack', '--pack-destination', destination], { cwd: packageDir });
  const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  return join(destination, tarballs[tarballs.length - 1]);
};

const installedManifest = (packageDir) => JSON.parse(readFileSync(join(project, 'node_modules', packageDir, 'package.json'), 'utf8'));

const disabledRows = (dump) => {
  const rows = new Map();
  let current = null;
  for (const line of dump.split('\n')) {
    const id = line.match(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u);
    if (id !== null) {
      current = id[1];
      if (!rows.has(current)) rows.set(current, false);
      continue;
    }
    if (current !== null && /^\s*disabled:\s*true\s*$/u.test(line)) rows.set(current, true);
  }
  return rows;
};

const dumpConfig = (patchPath) => {
  const args = ['--profile', profile, ...(patchPath === undefined ? [] : ['--patch', patchPath]), '--dump-config'];
  const result = spawnSync(dsh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const userWorkspaceIntact = () =>
  readFileSync(join(project, 'user-file.txt'), 'utf8').trim() === 'user-workspace-marker' &&
  readFileSync(join(project, 'user-notes', 'notes.md'), 'utf8').trim() === '# 用户笔记' &&
  existsSync(join(project, 'user-notes'));

// 仓库工作区快照：演练前后必须完全一致（不要求干净，因为操作者可能本来就有未提交改动）。
const gitStatusAtStart = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });

const versionCheck = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
if (versionCheck.status !== 0) {
  console.error(`rehearsal: 无法执行 ${dsh}（${versionCheck.error?.message ?? versionCheck.stderr}）；本演练需要目标环境已安装 DSH`);
  process.exit(2);
}
evidence.env.dshVersion = versionCheck.stdout.trim();
record('dsh-available', true, { version: evidence.env.dshVersion });

mkdirSync(join(project, 'user-notes'), { recursive: true });
writeFileSync(join(project, 'package.json'), '{"name":"rehearsal-project","private":true}\n');
writeFileSync(join(project, 'user-file.txt'), 'user-workspace-marker\n');
writeFileSync(join(project, 'user-notes', 'notes.md'), '# 用户笔记\n');

try {
  const enterprise = join(repo, 'packages', 'forge-enterprise');
  const manifest = JSON.parse(readFileSync(join(enterprise, 'package.json'), 'utf8'));
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare'].filter((name) => typeof manifest.scripts?.[name] === 'string');
  record('package-declares-no-lifecycle-scripts', lifecycle.length === 0, { lifecycle });

  const tgzV1 = pack(enterprise, join(dir, 'pack-v1'));
  record('pack-v1', existsSync(tgzV1), { version: manifest.version });

  npm(['install', tgzV1], { cwd: project });
  const installedV1 = installedManifest('@heluo/forge-enterprise');
  const patchInstalled = join(project, 'node_modules', '@heluo', 'forge-enterprise', 'cordis.patch.yml');
  record(
    'install-v1-with-patch-and-workspace-intact',
    installedV1.version === manifest.version && existsSync(patchInstalled) && userWorkspaceIntact(),
    { version: installedV1.version, patchShipped: existsSync(patchInstalled), workspaceIntact: userWorkspaceIntact() },
  );

  const base = dumpConfig();
  const patched = dumpConfig(patchInstalled);
  const baseRows = disabledRows(base.stdout);
  const patchedRows = disabledRows(patched.stdout);
  const perRow = officialRows.map((id) => ({
    id,
    presentInProfile: baseRows.has(id),
    disabledWithoutPatch: baseRows.get(id) === true,
    disabledWithPatch: patchedRows.get(id) === true,
  }));
  const present = perRow.filter((row) => row.presentInProfile);
  record(
    'installed-patch-disables-official-rows',
    base.status === 0 && patched.status === 0 && present.length > 0 && present.every((row) => row.disabledWithPatch && !row.disabledWithoutPatch),
    { perRow, patchedStatus: patched.status, note: '缺席的行按 --patch 语义跳过（跳过 ≠ 已禁用）' },
  );

  const sdd = join(repo, 'packages', 'forge-sdd');
  const tgzSdd = pack(sdd, join(dir, 'pack-sdd'));
  npm(['install', tgzSdd], { cwd: project });
  const binPath = join(project, 'node_modules', '.bin', 'forge-sdd');
  const cliTarget = join(project, 'node_modules', '@heluo', 'forge-sdd', 'src', 'cli.mjs');
  const binRun = spawnSync(binPath, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  record(
    'installed-bin-is-executable',
    existsSync(binPath) && existsSync(cliTarget) && (statSync(cliTarget).mode & 0o100) !== 0 && binRun.status === 2,
    { status: binRun.status, usagePrinted: /用法/u.test(`${binRun.stdout ?? ''}${binRun.stderr ?? ''}`), mode: (statSync(cliTarget).mode & 0o777).toString(8) },
  );

  const upgradeSource = join(dir, 'upgrade-src');
  cpSync(enterprise, upgradeSource, { recursive: true });
  const upgradeManifest = JSON.parse(readFileSync(join(upgradeSource, 'package.json'), 'utf8'));
  upgradeManifest.version = '0.1.1';
  writeFileSync(join(upgradeSource, 'package.json'), `${JSON.stringify(upgradeManifest, null, 2)}\n`);
  const tgzV2 = pack(upgradeSource, join(dir, 'pack-v2'));
  npm(['install', tgzV2], { cwd: project });
  const installedV2 = installedManifest('@heluo/forge-enterprise');
  const patchedV2 = dumpConfig(join(project, 'node_modules', '@heluo', 'forge-enterprise', 'cordis.patch.yml'));
  record(
    'upgrade-to-0.1.1-keeps-composition-and-workspace',
    installedV2.version === '0.1.1' && userWorkspaceIntact() && officialRows.filter((id) => baseRows.has(id)).every((id) => disabledRows(patchedV2.stdout).get(id) === true),
    { version: installedV2.version, workspaceIntact: userWorkspaceIntact() },
  );

  npm(['install', tgzV1], { cwd: project });
  const rolledBack = installedManifest('@heluo/forge-enterprise');
  const patchedRollback = dumpConfig(join(project, 'node_modules', '@heluo', 'forge-enterprise', 'cordis.patch.yml'));
  record(
    'rollback-to-0.1.0-keeps-composition-and-workspace',
    rolledBack.version === manifest.version && userWorkspaceIntact() && officialRows.filter((id) => baseRows.has(id)).every((id) => disabledRows(patchedRollback.stdout).get(id) === true),
    { version: rolledBack.version, workspaceIntact: userWorkspaceIntact() },
  );

  npm(['uninstall', '@heluo/forge-enterprise', '@heluo/forge-sdd'], { cwd: project });
  record(
    'uninstall-removes-packages-and-keeps-workspace',
    !existsSync(join(project, 'node_modules', '@heluo', 'forge-enterprise')) &&
      !existsSync(join(project, 'node_modules', '@heluo', 'forge-sdd')) &&
      !existsSync(binPath) &&
      userWorkspaceIntact(),
    { workspaceIntact: userWorkspaceIntact(), leftoverBin: existsSync(binPath) },
  );

  const gitStatusAtEnd = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  record('repository-working-tree-untouched', gitStatusAtEnd === gitStatusAtStart, {
    entriesAtStart: gitStatusAtStart.trim().split('\n').filter(Boolean).length,
    entriesAtEnd: gitStatusAtEnd.trim().split('\n').filter(Boolean).length,
  });
} finally {
  writeFileSync(join(dir, 'install-rehearsal.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`rehearsal: ${evidence.steps.filter((step) => step.ok).length}/${evidence.steps.length} steps ok`);
  console.log(`rehearsal: 证据留在 ${dir}`);
  if (!evidence.ok) process.exitCode = 1;
}
