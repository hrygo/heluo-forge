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
  makePrivateBundle,
  parseEnvConfig,
  planDigest,
  PrivateBundleError,
  SUPPORTED_PLATFORMS,
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

function readConfig(configPath) {
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
# 双击运行：把企业插件装入已初始化的官方 DSH profile。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
if [ -f "$DSH_HOME/profiles/desktop/package.json" ]; then
  PROFILE=desktop
elif [ -f "$DSH_HOME/profiles/web/package.json" ]; then
  PROFILE=web
else
  echo "未找到已初始化的 desktop/web profile：请先启动一次官方 DSH 并完全退出。" >&2
  exit 2
fi
HASH=$(/usr/bin/shasum -a 256 "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
exec /usr/bin/env node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile "$PROFILE" --sha256 "$HASH" "$@"
`,
  'install-linux.sh': `#!/bin/sh
# 终端运行：把企业插件装入已初始化的官方 DSH profile。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
if [ -f "$DSH_HOME/profiles/desktop/package.json" ]; then
  PROFILE=desktop
elif [ -f "$DSH_HOME/profiles/web/package.json" ]; then
  PROFILE=web
else
  echo "未找到已初始化的 desktop/web profile：请先启动一次官方 DSH 并完全退出。" >&2
  exit 2
fi
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
else
  HASH=$(shasum -a 256 "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
fi
exec node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile "$PROFILE" --sha256 "$HASH" "$@"
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
set "PROFILE="
if exist "%DSH_HOME%\\profiles\\desktop\\package.json" set "PROFILE=desktop"
if not defined PROFILE if exist "%DSH_HOME%\\profiles\\web\\package.json" set "PROFILE=web"
if not defined PROFILE (
  echo [heluo] ERROR: no initialized desktop/web profile under "%DSH_HOME%".
  echo [heluo] Start the official DSH once, quit it completely, then run this file again.
  echo [heluo] If DSH stores its data elsewhere, set DSH_HOME and retry.
  pause
  exit /b 2
)
echo [heluo] profile=%PROFILE%
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\\nodejs\\node.exe" set "PATH=%ProgramFiles%\\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [heluo] ERROR: Node.js was not found on PATH.
  echo [heluo] Install Node.js LTS first, then run this file again.
  pause
  exit /b 3
)
echo [heluo] Installing into profile %PROFILE% ...
node "%HERE%init-enterprise-plugin.mjs" --release "%ROOT%\\enterprise-plugin" --profile "%PROFILE%" > "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
type "%LOG%"
echo.
if "%CODE%"=="0" (
  echo [heluo] OK: plugin installed and verified locally.
  echo [heluo] Restart DSH, then open Settings -^> Plugins to confirm it is loaded.
) else (
  echo [heluo] FAILED with exit code %CODE%.
  echo [heluo] Log: %LOG%
  echo [heluo] Send this window or the log to your administrator.
)
pause
exit /b %CODE%
`,
};

const EMPLOYEE_GUIDE = `# 企业 DSH 插件安装说明

整个目录是一个交付包，不需要再向管理员索取配置。

## 安装前

1. 从官方渠道安装 DeepSeek Harness（Desktop 或 Web），并**启动一次**完成 profile 初始化。
2. 完全退出 DSH（Windows 关闭托盘，macOS 用“退出”而不是关闭窗口）。

## 安装（任选当前系统）

- macOS：双击 installer/install-macos.command。若被 Gatekeeper 拦截，右键 → 打开。
- Windows：双击 installer/install-windows.cmd。
- 麒麟 / Linux：终端执行 sh installer/install-linux.sh。

脚本会自动找到已初始化的 profile、校验插件摘要，并只执行一次
dsh plugin add。看到 mounted=unknown 是正常的：运行期挂载需要在下一步确认。

## 安装后

1. 重新启动 DSH。
2. 在「设置 → 插件」确认 @heluo/forge-enterprise 已加载。
3. 按企业身份登录，首次登录时录入**你个人**的网关 Key；Key 不随交付包分发。

## 回滚

dsh plugin --profile <desktop|web> remove @heluo/forge-enterprise

卸载插件不会删除对话、工作区或个人凭据。

## 常见问题

- Windows 双击后窗口一闪而过：右键该文件 → 属性 → 勾选“解除锁定”，或在命令提示符里手动运行。日志位于 %TEMP%\\heluo-enterprise-install.log。
- Windows 提示 Node.js was not found：先安装 Node.js LTS，再重跑本文件。
- 设置页没有「企业研发 / 企业账号 / Gitee / DevOps」：多半装到了别的 profile。先确认 DSH 已完全退出，再重跑；也可用 dsh plugin --profile <desktop|web> list 检查。
- 页面仍提示「企业登录尚未设置」：本包已包含管理员配置，先确认 IAM Discovery 地址在该机器可达；仍失败时把日志和 profile 名发给管理员，不要自行修改配置。
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
  const { config } = readConfig(resolve(input.configPath));
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
  const result = buildDelivery({
    publicPath: options.publicPath,
    publicSha256: options.publicSha256,
    configPath: options.configPath,
    version: options.version,
    output: options.output,
    toolRoot: options.toolRoot,
    dryRun: options.dryRun,
    confirm: options.confirm,
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
