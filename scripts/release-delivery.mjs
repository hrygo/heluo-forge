/**
 * Release delivery builder (issue #222 items ③④⑤⑥).
 *
 * One command turns a verified public artifact plus an out-of-repo enterprise
 * configuration into a delivery package an employee can use with minimal steps:
 *
 *   - `enterprise-plugin/` — the private plugin tarball, sidecar, manifest, sums
 *   - `installer/`         — the init CLI and per-OS launchers
 *   - `INSTALL.md`            — the employee-facing three-step guide
 *   - `SHA256SUMS`         — every file in the package
 *
 * The maker's confirmation stays intact: the first run prints a redacted plan
 * and its digest; only a matching `--confirm` prefix writes anything.
 *
 * 用法：
 *   node scripts/release-delivery.mjs --public <tgz> --public-sha256 <hex>
 *     --config <enterprise.env> --version <x.y.z> --output <dir>
 *     [--confirm <digest 前 8+ 位>] [--dry-run] [--tool-root <repo>] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from './verify-enterprise-bundle.mjs';
import {
  buildConfig,
  inspectPublicTarball,
  isLoginConfigured,
  makePrivateBundle,
  parseEnvConfig,
  planDigest,
  PrivateBundleError,
  SUPPORTED_PLATFORMS,
  verifyDiscovery,
} from './lib/private-bundle.mjs';
import { sha256 } from './lib/release-support.mjs';

const INSTALLER_SCRIPT = 'init-enterprise-plugin.mjs';

function fail(code, message, details) {
  throw new PrivateBundleError(code, message, details);
}

function parseArguments(argv) {
  const options = {
    publicPath: undefined,
    publicSha256: undefined,
    configPath: undefined,
    version: undefined,
    output: undefined,
    confirm: undefined,
    toolRoot: undefined,
    dryRun: false,
    skipDiscoveryCheck: false,
    json: false,
  };
  const valued = new Map([
    ['--public', 'publicPath'],
    ['--public-sha256', 'publicSha256'],
    ['--config', 'configPath'],
    ['--version', 'version'],
    ['--output', 'output'],
    ['--confirm', 'confirm'],
    ['--tool-root', 'toolRoot'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options[valued.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--skip-discovery-check') {
      options.skipDiscoveryCheck = true;
      continue;
    }
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  for (const [flag, key] of [
    ['--public', 'publicPath'],
    ['--public-sha256', 'publicSha256'],
    ['--config', 'configPath'],
    ['--version', 'version'],
    ['--output', 'output'],
  ]) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') fail('BAD_ARGUMENT', `${flag} is required`);
  }
  return options;
}

export function readDeliveryConfig(configPath) {
  const stats = statSync(configPath);
  if ((stats.mode & 0o077) !== 0) {
    fail('CONFIG_PERMISSIONS', `configuration file permissions are too broad (mode ${(stats.mode & 0o777).toString(8)}); run chmod 600`);
  }
  const text = readFileSync(configPath, 'utf8');
  const entries = parseEnvConfig(text);
  return { config: buildConfig(entries) };
}

function assertOutsideRepo(path, repoRoot, label) {
  const target = resolve(path);
  const repo = resolve(repoRoot);
  if (target === repo || target.startsWith(`${repo}${sep}`)) {
    fail('OUTPUT_INSIDE_REPO', `${label} must be outside the source checkout`);
  }
}

function sumsOf(root, files) {
  const lines = [];
  for (const file of [...files].sort()) {
    lines.push(`${sha256(readFileSync(join(root, file)))}  ${file}`);
  }
  return `${lines.join('\n')}\n`;
}

function installerSource(toolRoot) {
  const path = join(toolRoot, 'scripts', INSTALLER_SCRIPT);
  if (!existsSync(path)) fail('TOOLS_INCOMPLETE', `release toolchain is missing scripts/${INSTALLER_SCRIPT}`);
  return path;
}

const LAUNCHERS = {
  'install-macos.command': `#!/bin/sh
# 双击运行：自动准备官方 DSH（必要时 npm 安装）并装入企业插件。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js：请先安装 Node.js LTS（自带 npm），再运行本脚本。" >&2
  exit 3
fi
HASH=$(/usr/bin/shasum -a 256 "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
exec /usr/bin/env node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile auto --install-host --sha256 "$HASH" "$@"
`,
  'install-linux.sh': `#!/bin/sh
# 终端运行：自动准备官方 DSH（必要时 npm 安装）并装入企业插件。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js：请先安装 Node.js LTS（自带 npm），再运行本脚本。" >&2
  exit 3
fi
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
else
  HASH=$(shasum -a 256 "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
fi
exec node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile auto --install-host --sha256 "$HASH" "$@"
`,
  'install-windows.cmd': `@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "ROOT=%%~fI"
set "LOG=%TEMP%\\heluo-enterprise-install.log"
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"
echo [heluo] Enterprise plugin installer
echo [heluo] DSH_HOME=%DSH_HOME%
if not exist "%SystemRoot%\\System32\\vcruntime140.dll" (
  echo [heluo] WARNING: Microsoft Visual C++ 2015-2022 Redistributable is missing.
  echo [heluo] The enterprise credential store cannot start until it is installed.
)
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\\nodejs\\node.exe" set "PATH=%ProgramFiles%\\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [heluo] ERROR: Node.js was not found on PATH.
  echo [heluo] Install Node.js LTS first, then run this file again.
  pause
  exit /b 3
)
where dsh >nul 2>nul
if errorlevel 1 where dsh.cmd >nul 2>nul
if errorlevel 1 (
  echo [heluo] dsh was not found on PATH; it will be installed with npm now.
)
echo [heluo] Preparing the official DSH and installing the plugin ...
node "%HERE%init-enterprise-plugin.mjs" --release "%ROOT%\\enterprise-plugin" --profile auto --install-host > "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
type "%LOG%"
echo.
if "%CODE%"=="0" (
  echo [heluo] OK: plugin installed and verified locally.
  echo [heluo] Start DSH, then open Settings -^> Plugins to confirm it is loaded.
) else (
  echo [heluo] FAILED with exit code %CODE%.
  echo [heluo] Log: %LOG%
  echo [heluo] Send this window or the log to your administrator.
)
pause
`,
};

const EMPLOYEE_GUIDE = `# 企业 DSH 插件安装说明

整个目录是一个交付包，不需要再向管理员索取配置。

## 安装前

只需要安装 **Node.js LTS**（自带 npm）。DSH 可以已经装好，也可以完全不装：
启动脚本发现缺少官方 DSH 时，会用 npm 自动安装并在本机创建 web profile。

> 官方 Desktop 应用由 Electron 独占 desktop profile，命令行无法管理它
> （当前锁定版实测：profile "desktop" is managed exclusively by the Electron application）。
> 请用 dsh web 形态运行本启动器；Desktop 用户需在应用内的插件设置中安装。

## 安装（任选当前系统）

- macOS：双击 installer/install-macos.command。若被 Gatekeeper 拦截，右键 → 打开。
- Windows：双击 installer/install-windows.cmd。
- 麒麟 / Linux：终端执行 sh installer/install-linux.sh。

脚本会依次完成：检查 Node.js → 检查/安装官方 DSH → 创建或选择 profile →
校验插件摘要 → 只执行一次 dsh plugin add → 读回配置确认插件已登记。
看到 mounted=unknown 是正常的：运行期挂载需要在下一步确认。

## 安装后

1. 启动 DSH：运行 dsh web（浏览器打开本机地址），或打开 Desktop。
2. 在「设置 → 插件」确认 @heluo/forge-enterprise 已加载。
3. 按企业身份登录，首次登录时录入**你个人**的网关 Key；Key 不随交付包分发。

## 回滚

dsh plugin --profile <desktop|web> remove @heluo/forge-enterprise

卸载插件不会删除对话、工作区或个人凭据。

## 常见问题

- Windows 双击后窗口一闪而过：右键该文件 → 属性 → 勾选“解除锁定”，或在命令提示符里手动运行。日志位于 %TEMP%\\heluo-enterprise-install.log。
- Windows 提示 Node.js was not found：先安装 Node.js LTS，再重跑本文件。
- 提示 dsh 安装失败：确认 npm 可用且能访问企业允许的 registry；也可由管理员先手工安装官方 DSH，再重跑本文件。
- Windows 提示与原生凭据适配器相关：npm 全局安装的 dsh.cmd/.bat 已被支持，脚本会解析 shim 后直接用 node 运行。
- 设置页没有「企业研发 / 企业账号 / Gitee / DevOps」：多半装到了别的 profile。确认安装脚本输出的 profile 与随后启动的 DSH profile 一致。
- 页面仍提示「企业登录尚未设置」：确认安装脚本输出 loginReady 或已包含管理员配置，并确认 IAM Discovery 地址在该机器可达；仍失败时把日志和 profile 名发给管理员。
- 页面提示「凭据存储不可用」：Windows/Linux 需要本包启用原生凭据适配器，并且 Windows 需安装 Microsoft Visual C++ 2015-2022 Redistributable。
- 企业内网地址使用 HTTP 时，登录令牌与个人 Key 会明文传输，请只在可信内网使用。

## 不要做

- 不要把本目录内的插件重新打包、改名或修改配置。
- 不要把个人 Key、token 写入任何文件或发给他人。
`;

function launcherFiles() {
  return Object.entries(LAUNCHERS).map(([name, body]) => ({ name, body }));
}

/**
 * Build the delivery directory and zip.
 *
 * @param {{publicPath: string, publicSha256: string, configPath: string, version: string,
 *   output: string, toolRoot?: string, dryRun?: boolean}} input
 */
export function buildDelivery(input) {
  const publicPath = resolve(input.publicPath);
  if (!existsSync(publicPath)) fail('PUBLIC_MISSING', `public tarball not found: ${publicPath}`);
  const publicInfo = inspectPublicTarball(publicPath);
  if (publicInfo.problems.length > 0) {
    fail('PUBLIC_UNSAFE', `public input failed preflight:\n- ${publicInfo.problems.join('\n- ')}`);
  }
  if (publicInfo.sha256 !== input.publicSha256.toLowerCase()) {
    fail('PUBLIC_DIGEST_MISMATCH', `public tarball digest ${publicInfo.sha256} does not match ${input.publicSha256}`);
  }
  const toolRoot = resolve(input.toolRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const installer = installerSource(toolRoot);
  const { config } = readDeliveryConfig(resolve(input.configPath));
  const digest = planDigest({
    publicSha256: publicInfo.sha256,
    version: input.version,
    config,
    platforms: SUPPORTED_PLATFORMS,
  });
  const output = resolve(input.output);
  assertOutsideRepo(output, toolRoot, 'output');

  if (!input.dryRun) {
    if (input.confirm === undefined || input.confirm.length < 8 || !digest.startsWith(input.confirm)) {
      fail('CONFIRM_MISMATCH', `--confirm must match the plan digest ${digest}; nothing was written`);
    }
  }
  const plan = {
    public: { path: publicPath, sha256: publicInfo.sha256, version: publicInfo.version, files: publicInfo.files },
    version: input.version,
    output,
    archive: `${output}.zip`,
    configKeys: config.keys,
    configValues: 'redacted',
    loginReady: isLoginConfigured(config.iam),
    discovery: input.discovery ?? { checked: false, reason: 'not-run' },
    platforms: [...SUPPORTED_PLATFORMS],
    planDigest: digest,
  };
  if (input.dryRun) return { plan, digest, written: false };

  if (existsSync(output)) {
    if (readdirSync(output).length > 0) fail('OUTPUT_EXISTS', `output directory is not empty: ${output}`);
  }
  const archive = `${output}.zip`;
  if (existsSync(archive)) fail('OUTPUT_EXISTS', `archive already exists: ${archive}`);

  const staging = join(dirname(output), `.release-delivery-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const pluginDir = join(staging, 'enterprise-plugin');
    mkdirSync(pluginDir, { recursive: true });
    const made = makePrivateBundle({
      publicPath,
      expectedSha256: publicInfo.sha256,
      configPath: resolve(input.configPath),
      version: input.version,
      output: pluginDir,
      repoRoot: toolRoot,
    });
    const verified = verifyBundle(made.tarball, { manifestPath: join(pluginDir, 'bundle-manifest.json') });
    if (!verified.ok) {
      fail('VERIFY_FAILED', `private artifact failed verification:\n- ${verified.errors.join('\n- ')}`);
    }

    const installerDir = join(staging, 'installer');
    mkdirSync(installerDir, { recursive: true });
    cpSync(installer, join(installerDir, INSTALLER_SCRIPT));
    for (const launcher of launcherFiles()) {
      const path = join(installerDir, launcher.name);
      const body = launcher.name.endsWith('.cmd') ? launcher.body.replace(/\n/gu, '\r\n') : launcher.body;
      writeFileSync(path, body);
      chmodSync(path, 0o755);
    }
    writeFileSync(join(staging, 'INSTALL.md'), EMPLOYEE_GUIDE);

    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push(relative(staging, path).split(sep).join('/'));
      }
    };
    walk(staging);
    writeFileSync(join(staging, 'SHA256SUMS'), sumsOf(staging, files));
    const parent = dirname(output);
    renameSync(staging, output);
    const zipPath = `${output}.zip`;
    execFileSync('zip', ['-r', '-q', zipPath, basename(output)], { cwd: parent });
    if (!existsSync(zipPath)) fail('ARCHIVE_FAILED', `zip archive was not written: ${zipPath}`);
    const archiveDigest = sha256(readFileSync(zipPath));

    return {
      plan,
      digest,
      written: true,
      output,
      archive: zipPath,
      archiveSha256: archiveDigest,
      privateTarball: join(output, 'enterprise-plugin', basename(made.tarball)),
      privateSha256: made.sha256,
      privateVersion: made.version,
      configKeys: made.configKeys,
      verified: verified.ok,
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { config } = readDeliveryConfig(resolve(options.configPath));
  const discovery = options.skipDiscoveryCheck
    ? { checked: false, reason: 'skipped by --skip-discovery-check' }
    : await verifyDiscovery(config.iam);
  const result = buildDelivery({
    publicPath: options.publicPath,
    publicSha256: options.publicSha256,
    configPath: options.configPath,
    version: options.version,
    output: options.output,
    toolRoot: options.toolRoot,
    dryRun: options.dryRun,
    confirm: options.confirm,
    discovery,
  });
  if (options.dryRun) {
    console.error(JSON.stringify(result.plan, null, 2));
    if (options.confirm === undefined || !result.digest.startsWith(options.confirm)) {
      process.stderr.write(`CONFIRM_REQUIRED: rerun with --confirm ${result.digest.slice(0, 16)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ dryRun: true, planDigest: result.digest })}\n`);
    return;
  }
  const summary = {
    output: result.output,
    archive: result.archive,
    archiveSha256: result.archiveSha256,
    private: {
      tarball: result.privateTarball,
      sha256: result.privateSha256,
      version: result.privateVersion,
      verified: result.verified,
    },
    configKeys: result.configKeys,
    loginReady: result.plan.loginReady,
    discovery: result.plan.discovery,
    planDigest: result.digest,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof PrivateBundleError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments };
