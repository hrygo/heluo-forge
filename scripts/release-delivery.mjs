/**
 * Release delivery builder (issue #222 items ③④⑤⑥).
 *
 * One command turns a verified public artifact plus a local enterprise
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
 * 发布与失败清理（PR #256 R4）：
 *   - 发布前用独占创建（`wx`）**预留**最终 zip 路径，并发打包者在争用点显式拿到
 *     `OUTPUT_EXISTS`，而不是各自发布完再靠 finally 互相删除；
 *   - 最终目录只在发布 rename 时产生，因此失败清理从不删除它，只删除本次运行创建的
 *     路径，并按创建时记录的 dev+ino 复核：身份变了说明已被别的进程或用户替换，
 *     跳过删除并告警（`OUTPUT_EXISTS` / `ARCHIVE_FAILED` 语义不变）。
 *
 * 用法：
 *   node scripts/release-delivery.mjs --public <tgz> --public-sha256 <hex>
 *     --config <enterprise.env> --version <x.y.z> --output <dir>
 *     [--confirm <digest 前 8+ 位>] [--dry-run] [--tool-root <repo>] [--json]
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBundleEntries } from './lib/bundle-archive.mjs';
import { verifyBundle } from './verify-enterprise-bundle.mjs';
import { readManifest, verifyAsset } from './derive-brand-icons.mjs';
import {
  preflightNacosRelease,
  inspectPublicTarball,
  isLoginConfigured,
  makePrivateBundle,
  planDigest,
  PrivateBundleError,
  resolveBundleConfig,
  SUPPORTED_PLATFORMS,
  verifyDiscovery,
} from './lib/private-bundle.mjs';
import { assertOutsideDirectory, sha256, zipDirectory } from './lib/release-support.mjs';

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
    embedClientSecret: false,
    previousIssuers: [],
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
  const repeatable = new Map([
    ['--previous-issuer', 'previousIssuers'],
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
    // 显式承受「交付目录里存在明文客户端密钥」的风险：安装器会在装完后立即把它写入
    // 目标机凭据库并删除该文件。默认仍然拒绝 HELUO_IAM_CLIENT_SECRET。
    if (argument === '--embed-client-secret') {
      options.embedClientSecret = true;
      continue;
    }
    // 同一 ref 在旧交付里可能绑定过别的 issuer（换环境时最常见）。列出旧 issuer 后，
    // 安装器在遇到绑定冲突时会用 client-secret replace 逐个尝试更正，避免每台机器手工处理。
    if (repeatable.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options[repeatable.get(argument)].push(value);
      index += 1;
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

export function readDeliveryConfig(configPath, { allowSecret = false } = {}) {
  return { config: resolveBundleConfig({ configPath, allowSecret }) };
}

function assertOutsideRepo(path, repoRoot, label) {
  // Containment is decided on canonical paths per component, never by a string
  // prefix: a sibling literally named `..secret` is outside the checkout, and an
  // out-of-checkout symlink that points back in is rejected (issue #254 item 14).
  try {
    assertOutsideDirectory(path, repoRoot, label);
  } catch {
    fail('OUTPUT_INSIDE_REPO', `${label} must be outside the source checkout`);
  }
}

/**
 * 读路径的文本内容；不存在或读不了时返回 null。
 *
 * 「这条路径现在还是我留的那份吗」用内容判断，不用 inode：Linux 与容器文件系统会在
 * 删除后立刻复用 inode，dev+ino 相同不代表是同一个文件，据此删除会误删别人的产物。
 */
function readTextOf(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 发布失败时清理本次运行在最终 zip 位置上的产物。
 *
 * 只删两种确定属于自己的形态：仍是本运行独占创建的那份占位文件（内容带本次运行的
 * 唯一标记），或已被本运行 rename 上位的 zip（内容摘要与刚打出的 zip 相同）。其余
 * 一律保留并告警：路径已被别的打包者或用户替换时，删掉就是销毁别人的产物。
 */
function removeOwnArchive(archive, claimText, archiveSha256, warn) {
  const text = readTextOf(archive);
  if (text === null) return;
  if (text === claimText) {
    rmSync(archive, { force: true });
    return;
  }
  try {
    if (sha256(readFileSync(archive)) === archiveSha256) {
      rmSync(archive, { force: true });
      return;
    }
  } catch {
    // 读不了就当不是自己的：保留并告警，交给人判断。
  }
  warn(`warning: left ${archive} in place: it was replaced by another process while this run was failing`);
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

const BRAND_DIR = join('docs', 'assets', 'branding', 'cyber-long');

/** 外层品牌材料：交付包内文件名 → 品牌套件相对路径，全部经 manifest 校验后复制。 */
const BRAND_FILES = [
  ['app-icon.ico', 'icons/app-icon.ico'],
  ['app-icon.icns', 'icons/app-icon.icns'],
  ...[16, 32, 48, 64, 128, 256, 512, 1024].map((size) => [`app-icon-${size}.png`, `sizes/app-icon-${size}.png`]),
  ['wordmark-color.svg', 'primary/wordmark-color.svg'],
];

/** 桌面壳 §1.1 应用标识：外层快捷方式、deb 元数据与安装包统一以此为准（首个安装包发布后不可更改）。 */
export const APP_IDENTITY = Object.freeze({
  appId: 'com.heluo.forge.enterprise',
  upgradeGuid: '3fa730a8-e95c-45dc-9724-c525f3654136',
  productName: 'Heluo Forge Enterprise',
  executableName: 'heluo-forge-enterprise',
  displayName: '河洛 Forge 企业版',
});

/**
 * Write the outer brand materials of the employee package: verified icon set,
 * the wordmark and the app identity record. The whole suite missing from the
 * toolchain degrades to no branding directory (the GB rule: outer materials
 * fall back, the plugin-level branding is never blocked); a present but
 * tampered suite fails closed through the manifest ledger.
 */
export function writeBrandingAssets(content, toolRoot, version) {
  const brandDir = join(toolRoot, BRAND_DIR);
  if (!existsSync(join(brandDir, 'manifest.json'))) return null;
  const { manifest, byPath } = readManifest(brandDir);
  const brandingDir = join(content, 'branding');
  mkdirSync(brandingDir, { recursive: true });
  const files = [];
  for (const [name, source] of BRAND_FILES) {
    const { bytes } = verifyAsset(brandDir, byPath, source);
    writeFileSync(join(brandingDir, name), bytes);
    files.push(`branding/${name}`);
  }
  writeFileSync(join(brandingDir, 'app-identity.json'), `${JSON.stringify(
    { schema: 'heluo-app-identity/1', ...APP_IDENTITY, version, brandManifest: manifest.version ?? null },
    null,
    2,
  )}\n`);
  files.push('branding/app-identity.json');
  return { manifestVersion: manifest.version ?? null, identity: { ...APP_IDENTITY }, files };
}

const LAUNCHERS = {
  'install-macos.command': `#!/bin/sh
# 河洛 Forge 企业版 · 双击运行：自动准备官方 DSH（必要时 npm 安装）并装入企业插件。
# HASH 是同一交付包内 tgz 的自算摘要：只能发现制品损坏，不构成独立来源。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js：请先安装 Node.js LTS（自带 npm），再运行本脚本。" >&2
  exit 3
fi
HASH=$(/usr/bin/shasum -a 256 "$ROOT/enterprise-plugin"/*.tgz | cut -d' ' -f1)
exec /usr/bin/env node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile "\${HELUO_PROFILE:-auto}" --install-host --sha256 "$HASH" "$@"
`,
  'install-linux.sh': `#!/bin/sh
# 河洛 Forge 企业版 · 终端运行：自动准备官方 DSH（必要时 npm 安装）并装入企业插件。
# HASH 是同一交付包内 tgz 的自算摘要：只能发现制品损坏，不构成独立来源。
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
exec node "$HERE/${INSTALLER_SCRIPT}" --release "$ROOT/enterprise-plugin" --profile "\${HELUO_PROFILE:-auto}" --install-host --sha256 "$HASH" "$@"
`,
  'install-windows.cmd': `@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "ROOT=%%~fI"
set "LOG=%TEMP%\\heluo-enterprise-install.log"
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"
if not defined HELUO_PROFILE set "HELUO_PROFILE=auto"
echo [heluo] Heluo Forge Enterprise - employee plugin installer
echo [heluo] DSH_HOME=%DSH_HOME%
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
node "%HERE%init-enterprise-plugin.mjs" --release "%ROOT%\\enterprise-plugin" --profile "%HELUO_PROFILE%" --install-host > "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
type "%LOG%"
echo.
if "%CODE%"=="0" (
  echo [heluo] OK: plugin installed into profile "%HELUO_PROFILE%" and verified locally.
  if "%HELUO_PROFILE%"=="web" (
    echo [heluo] Start it with: dsh web
  ) else (
    echo [heluo] Start it with: dsh --profile "%HELUO_PROFILE%"
  )
  echo [heluo] Desktop is a separate profile; opening it will NOT show this install.
  echo [heluo] Then open Settings -^> Plugins to confirm it is loaded.
) else (
  echo [heluo] FAILED with exit code %CODE%.
  echo [heluo] Log: %LOG%
  echo [heluo] Send this window or the log to your administrator.
)
pause
`,
};

const EMPLOYEE_GUIDE = `# 河洛 Forge 企业版 · 安装说明

整个目录是「河洛 Forge 企业版」交付包，不需要再向管理员索取配置。

## 安装前

只需要安装 **Node.js LTS**（自带 npm）。DSH 可以已经装好，也可以完全不装：
启动脚本发现缺少官方 DSH 时，会用 npm 自动安装并在本机创建 web profile；安装插件依赖 pnpm，缺少时启动脚本会用同一个 npm 自动补装。

> 官方 Desktop 应用由 Electron 独占 desktop profile，命令行无法管理它
> （锁定基线版实测：profile "desktop" is managed exclusively by the Electron application）。
> 本启动器默认把插件装进 web profile；Desktop 用户按下文「Desktop 用户」单独安装。
> 河洛 Forge 企业版桌面应用（Windows / macOS 安装包）使用自己的 heluo-desktop profile，
> 由应用首次启动时自行安装企业插件，不需要运行本启动器。

## 安装（任选当前系统）

- macOS：双击 installer/install-macos.command。若被 Gatekeeper 拦截，右键 → 打开。
- Windows：双击 installer/install-windows.cmd。
- 麒麟 / Linux：终端执行 sh installer/install-linux.sh。

脚本会依次完成：检查 Node.js → 检查/安装官方 DSH → 创建或选择 profile →
校验插件摘要 → 检查 profile 内是否已有其它版本的企业插件（有旧版本时先执行
dsh plugin remove 卸载旧版本）→ 执行 dsh plugin add → 读回配置确认插件已登记。
已装版本与本次交付相同时，脚本不再写入，只读回配置核对。

要装到别的 profile（例如另留一个 uat 试新版本）：给启动器加环境变量 HELUO_PROFILE
再运行，macOS/Linux 例如「HELUO_PROFILE=uat sh installer/install-linux.sh」，Windows 先
「set HELUO_PROFILE=uat」再双击；也可以直接调用安装器：
node installer/init-enterprise-plugin.mjs --release enterprise-plugin --profile uat。
自定义 profile 不存在时，安装器会用官方宿主的 --from-default-profile web 从 web 模板创建。

安装成功后启动它（profile 名为 uat 时）：dsh --profile uat，换端口用 --port <端口>。
看到 mounted=unknown 是正常的：运行期挂载需要在下一步确认。

启动器传入的摘要是**同一交付包内 tgz 的自算值**（自证）：它只能发现制品在拷贝中损坏，
不能证明制品来自可信渠道。需要独立口径时，请向管理员另行核对摘要后再安装。

## 安装后

1. 在终端运行 dsh web，打开它打印的本机地址（默认安装写入的是 web profile）。
2. 在「设置 → 插件」确认 @heluo/forge-enterprise 已加载。
3. 本包内嵌了企业 IAM 客户端密钥，安装脚本会把它写入本机凭据库并删除包内副本；
   若安装时访问不到企业 IAM，脚本会报 IAM_DISCOVERY_FAILED 并**保留**该文件，
   恢复网络后重跑安装即可重新预置。按企业身份登录后录入**你个人**的网关 Key。

如果本包包含企业技能库，其连接和只读账号已由管理员预置，无需设置 Nacos 环境变量；如不可用请联系管理员。

**不要用「打开 Desktop」代替第 1 步**：Desktop 使用自己的 desktop profile，看不到本次
装进 web profile 的插件。河洛 Forge 企业版桌面应用同理：它使用 heluo-desktop profile，
与 web profile 各自安装、各自升级，在本启动器装好插件后仍需单独打开应用完成它自己的安装。

## Desktop 用户

Desktop 的 desktop profile 由应用独占，本启动器不会写入它（只检测到 Desktop profile
时会直接拒绝）。在 Desktop 中使用企业插件需要：

1. 完全退出 Desktop 应用（含托盘/菜单栏里的进程），确认没有 dsh 进程占用该 profile。
2. 在应用的插件设置中安装同一份 enterprise-plugin/*.tgz；若应用不提供安装入口，则用
   应用自带的命令行在应用完全退出后执行 dsh plugin --profile desktop add <tgz>。
3. 重新打开 Desktop，在「设置 → 插件」确认已加载——desktop profile 的挂载只能在应用内
   确认；命令行 --profile desktop --dump-config 可能被拒绝，不能作为核验依据。

## 换版本与回滚

升级到新交付：用新目录里的启动器重新运行；脚本检测到已装版本与本次交付不同，
会先卸载旧版本再安装。

回到旧版本：用旧交付包里的启动器重新运行，走同一条路。

只卸载不重装：dsh plugin --profile <desktop|web> remove @heluo/forge-enterprise

卸载插件不会删除对话、工作区或个人凭据。卸载失败时脚本不会继续安装，profile
保持原样；按提示完全退出 DSH（Desktop 用户含托盘进程）后重跑即可。

## 常见问题

- Windows 双击后窗口一闪而过：右键该文件 → 属性 → 勾选“解除锁定”，或在命令提示符里手动运行。日志位于 %TEMP%\\heluo-enterprise-install.log。
- Windows 提示 Node.js was not found：先安装 Node.js LTS，再重跑本文件。
- 提示 dsh 安装失败：确认 npm 可用且能访问企业允许的 registry；也可由管理员先手工安装官方 DSH，再重跑本文件。
- 提示卸载旧版本失败：确认没有 dsh 进程占用该 profile（Desktop 用户需完全退出应用含托盘进程），再重跑本文件；本次不会执行安装。
- Windows 上提示 dsh 安装失败但 npm 正常：npm 全局安装的 dsh.cmd/.bat 会被启动脚本解析成 node 入口直接运行，不需要手工改 PATH；仍失败时看日志里的 dsh 输出。
- 提示 pnpm 安装失败：确认 npm 能访问企业允许的 registry；也可由管理员预先执行 npm install -g pnpm 后重跑。
- 提示 PROFILE_STORE_MISMATCH：这个 profile 的 node_modules 是另一个 pnpm 用别的 store 装的。退出所有 DSH 进程（含托盘驻留的），删除 ~/.dsh/profiles/<profile 名>/node_modules，再运行本启动器；该 profile 里其他来源的插件需要能重新获取。启动器不会自动清空它。
- 设置页没有「企业研发 / 企业账号 / Gitee / DevOps」：多半装到了别的 profile。确认安装脚本输出的 profile 与随后启动的 DSH profile 一致。
- 页面仍提示「企业登录尚未设置」：确认安装脚本输出 loginReady 或已包含管理员配置，并确认 IAM Discovery 地址在该机器可达；仍失败时把日志和 profile 名发给管理员。
- 页面提示「凭据存储不可用」：请管理员核对 Host 使用的 SQLite 目录、磁盘空间与权限，以及同级 <目录>.keys/keyring.json 是否可用。
  Linux 优先使用绝对路径 $XDG_DATA_HOME/HeluoForge，否则使用 ~/.local/share/HeluoForge。Windows 默认为 %LOCALAPPDATA%\\HeluoForge，macOS 为 ~/Library/Application Support/HeluoForge。
- 启用企业内网 HTTP 时，对应请求会明文传输凭据。机密 IAM 请求可能携带客户端密钥与令牌，网关请求可能携带个人 Key。

## 不要做

- 不要把本目录内的插件重新打包、改名或修改配置。
- 不要把个人 Key、token 写入任何文件或发给他人。
`;

/** 内嵌客户端密钥时追加到安装说明末尾的章节（未内嵌时整篇不含此段）。 */
const EMBEDDED_SECRET_NOTE = `

## 关于本包内嵌的 IAM 客户端密钥

本交付包携带企业 IAM 客户端的密钥（enterprise-plugin/iam-client-secret.txt，权限 0600），
安装脚本会在插件装好之后：

1. 读取企业 IAM 的 Discovery 文档，取其中声明的 issuer（不用包内写死的第二个 issuer）；
2. 执行 client-secret set，把密钥写进本机 Host 凭据库，绑定 issuer / clientId / 认证方式 / 引用名；
3. 成功后删除 enterprise-plugin/iam-client-secret.txt，失败则保留文件并以
   IAM_CLIENT_SECRET_PROVISION_FAILED 结束，不会留下“装好了但登录不了”的假成功。

因此员工不需要执行任何与密钥有关的命令。看到 \`IAM 客户端密钥：已写入本机凭据库\` 即可。

### 换过 IAM 环境时

凭据库要求同一引用（ref）的 issuer / clientId / 认证方式逐字一致。机器上装过旧交付、
已经预置过旧 issuer 时，set 会被拒绝（退出码 4，底层 IAM_CLIENT_SECRET_BINDING_MISMATCH）。
本包在 client-secret.json 里带了 previousIssuers（制包时用 --previous-issuer 写入的历史
issuer），安装脚本会自动逐个尝试 client-secret replace 把绑定更正到本次 issuer，并打印
\`原先绑定 … 已更正为 …\`；候选都不匹配时才报 IAM_CLIENT_SECRET_BINDING_CONFLICT，
并给出可手工执行的 replace 命令。

失败时按提示在失败的那台机器上重跑启动器即可（文件仍在，会重新预置）；也可以手工执行：

\`\`\`sh
node "$DSH_HOME/profiles/web/node_modules/@heluo/forge-enterprise/node_modules/@heluo/forge-iam/bin/heluo-forge.mjs" \
  client-secret set --issuer <Discovery 文档里的 issuer> --client-id <本包 clientId> \
  --method client_secret_post --ref <本包 clientSecretRef> < enterprise-plugin/iam-client-secret.txt
\`\`\`

预置完成后 \`shasum -a 256 -c SHA256SUMS\` 会因该文件已删除而报一行失败，这是预期的；
其余文件必须全部 OK。

安全边界：这是管理员选择的内网交付方式——密钥在交付目录里是明文。分发、拷贝、终端日志与
备份都应把它当作密钥对待；本机凭据库同样无法阻止同账号进程读取（见凭据存储说明）。
`;

function launcherFiles() {
  return Object.entries(LAUNCHERS).map(([name, body]) => ({ name, body }));
}

/**
 * Build the delivery directory and zip.
 *
 * @param {{publicPath: string, publicSha256: string, configPath?: string,
 *   config?: ReturnType<typeof import('./lib/private-bundle.mjs').buildConfig>, version: string,
 *   output: string, toolRoot?: string, dryRun?: boolean, confirm?: string, zipCommand?: string,
 *   warn?: (message: string) => void}} input
 *   `zipCommand` 仅供测试注入（默认当前平台的原生归档器，POSIX 为 `zip`）：打包失败必须什么也不发布。
 *   `warn` 仅供测试注入（默认写 stderr）：清理时跳过别人的产物必须告警，不能静默。
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
  const previousIssuers = Array.isArray(input.previousIssuers) ? input.previousIssuers : [];
  const config = resolveBundleConfig({
    config: input.config,
    configPath: input.configPath,
    allowSecret: input.embedClientSecret === true,
  });
  const nacosRelease = preflightNacosRelease(readBundleEntries(publicPath, { withContent: true }), config);
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
    clientSecretEmbedded: config.secret !== undefined,
    loginReady: isLoginConfigured(config.iam),
    gatewayConfigured: Boolean(config.iam.managedModels && config.iam.defaultProvider),
    nacosConfigured: nacosRelease.nacosConfigured,
    embeddedSecrets: nacosRelease.embeddedSecrets,
    revocationConfigured: Boolean(config.iam.revocationEndpoint),
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

  const parent = dirname(output);
  const staging = join(parent, `.release-delivery-${process.pid}-${Date.now().toString(36)}`);
  // 暂存目录里先放一个以最终目录名命名的内容根，zip 的内层路径才是 <output>/…。
  const content = join(staging, basename(output));
  const partialArchive = join(staging, 'archive.zip');
  // 未注入时保持 undefined：由 zipDirectory 选当前平台的原生归档器。
  const zipCommand = input.zipCommand;
  const warn = input.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const hadOutput = existsSync(output);
  // 占位文件里写本次运行的唯一标记：清理与「被别人换掉」的判定都按内容做，不按 inode。
  const claimText = `reserved by release-delivery while packaging (run ${process.pid}-${Date.now().toString(36)}); safe to delete if no build is running\n`;
  let archiveSha256;
  let published = false;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    // 预留最终 zip 路径：独占创建（wx）让并发打包者在这里显式失败，而不是各自发布完再靠
    // finally 互相删除。占位文件本身就是「本次运行创建」的第一个登记项。
    try {
      closeSync(openSync(archive, 'wx', 0o600));
    } catch (error) {
      if (error.code === 'EEXIST') {
        fail('OUTPUT_EXISTS', `archive appeared while packaging: ${archive}; nothing was published`);
      }
      throw error;
    }
    // 占位文件里写明来历：进程被强杀时会留下它，操作者要能判断它可删。
    writeFileSync(archive, claimText);
    mkdirSync(content, { recursive: true });
    const pluginDir = join(content, 'enterprise-plugin');
    mkdirSync(pluginDir, { recursive: true });
    const made = makePrivateBundle({
      publicPath,
      expectedSha256: publicInfo.sha256,
      config,
      version: input.version,
      output: pluginDir,
      repoRoot: toolRoot,
    });
    const verified = verifyBundle(made.tarball, { manifestPath: join(pluginDir, 'bundle-manifest.json') });
    if (!verified.ok) {
      fail('VERIFY_FAILED', `private artifact failed verification:\n- ${verified.errors.join('\n- ')}`);
    }

    // 客户端密钥只落在交付目录、不进 tgz（插件拒收内联密钥）：安装器装完后用
    // Discovery 的 issuer 把它写入目标机凭据库，然后删除该文件。
    let clientSecretFile = null;
    if (config.secret !== undefined) {
      clientSecretFile = 'iam-client-secret.txt';
      const secretBytes = Buffer.from(config.secret.clientSecret, 'utf8');
      const secretPath = join(pluginDir, clientSecretFile);
      writeFileSync(secretPath, secretBytes, { mode: 0o600 });
      chmodSync(secretPath, 0o600);
      const bindingPath = join(pluginDir, 'client-secret.json');
      writeFileSync(bindingPath, `${JSON.stringify({
        schema: 'heluo-client-secret/1',
        file: clientSecretFile,
        sha256: sha256(secretBytes),
        bytes: secretBytes.length,
        discoveryUrl: config.iam.discoveryUrl ?? null,
        issuer: config.iam.issuer ?? null,
        clientId: config.iam.clientId ?? null,
        clientAuthMethod: config.iam.clientAuthMethod ?? null,
        clientSecretRef: config.iam.clientSecretRef ?? null,
        previousIssuers: previousIssuers.length === 0 ? [] : previousIssuers,
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(bindingPath, 0o600);
    }

    const installerDir = join(content, 'installer');
    mkdirSync(installerDir, { recursive: true });
    cpSync(installer, join(installerDir, INSTALLER_SCRIPT));
    for (const launcher of launcherFiles()) {
      const path = join(installerDir, launcher.name);
      const body = launcher.name.endsWith('.cmd') ? launcher.body.replace(/\n/gu, '\r\n') : launcher.body;
      writeFileSync(path, body);
      chmodSync(path, 0o755);
    }
    const branding = writeBrandingAssets(content, toolRoot, input.version);
    const guide = clientSecretFile === null
      ? EMPLOYEE_GUIDE
      : `${EMPLOYEE_GUIDE
        .replace('→ 读回配置确认插件已登记。', '→ 读回配置确认插件已登记 → 取 Discovery 的 issuer，把包内客户端密钥写入本机凭据库并删除该文件。')}${EMBEDDED_SECRET_NOTE}`;
    writeFileSync(join(content, 'INSTALL.md'), guide);

    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push(relative(content, path).split(sep).join('/'));
      }
    };
    walk(content);
    writeFileSync(join(content, 'SHA256SUMS'), sumsOf(content, files));

    // 交付物齐了才打包；zip 缺失或失败时不留半成品目录，重跑不会被 OUTPUT_EXISTS 挡住。
    try {
      zipDirectory({ staging, name: basename(output), archive: partialArchive, zipCommand });
    } catch (error) {
      const reason = typeof error?.code === 'string' ? error.code : (error?.message ?? 'UNKNOWN');
      fail('ARCHIVE_FAILED', `zip failed (${reason}) while packaging ${basename(output)} with ${zipCommand ?? 'the platform archiver'}; nothing was published`);
    }
    if (!existsSync(partialArchive)) fail('ARCHIVE_FAILED', `zip did not write ${partialArchive}; nothing was published`);
    const archiveDigest = sha256(readFileSync(partialArchive));
    archiveSha256 = archiveDigest;

    // 发布：先放 zip 再放目录；两步都成功才算完成。
    // 替换前确认路径上仍是本进程那份占位文件：被别人换掉的就绝不覆盖。
    if (readTextOf(archive) !== claimText) {
      fail('OUTPUT_EXISTS', `archive was replaced by another process while packaging: ${archive}; nothing was published`);
    }
    renameSync(partialArchive, archive);
    try {
      if (hadOutput) rmdirSync(output);
      renameSync(content, output);
    } catch (error) {
      // 最终目录在打包期间被别人发布出来：显式失败并把发布权留给先到者，不删任何东西。
      if (existsSync(output)) {
        fail('OUTPUT_EXISTS', `output directory appeared while packaging: ${output}; nothing was published`);
      }
      throw error;
    }
    published = true;

    return {
      plan,
      digest,
      written: true,
      output,
      archive,
      archiveSha256: archiveDigest,
      privateTarball: join(output, 'enterprise-plugin', basename(made.tarball)),
      privateSha256: made.sha256,
      privateVersion: made.version,
      configKeys: made.configKeys,
      clientSecretEmbedded: made.secretEmbedded,
      verified: verified.ok,
      branding,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!published) {
      // 只清理确定属于自己的产物：内容对不上说明已被别人替换，保留并告警。
      // 最终目录从不由本运行创建（只有发布的 rename 才会产生），所以这里绝不碰它；
      // 用户原有的空目录按原样恢复。
      removeOwnArchive(archive, claimText, archiveSha256, warn);
      if (hadOutput && !existsSync(output)) mkdirSync(output, { recursive: true, mode: 0o700 });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { config } = readDeliveryConfig(options.configPath, { allowSecret: options.embedClientSecret });
  preflightNacosRelease(readBundleEntries(resolve(options.publicPath), { withContent: true }), config);
  const discovery = options.skipDiscoveryCheck
    ? { checked: false, reason: 'skipped by --skip-discovery-check' }
    : await verifyDiscovery(config.iam);
  const result = buildDelivery({
    publicPath: options.publicPath,
    publicSha256: options.publicSha256,
    config,
    version: options.version,
    output: options.output,
    toolRoot: options.toolRoot,
    dryRun: options.dryRun,
    confirm: options.confirm,
    discovery,
    embedClientSecret: options.embedClientSecret,
    previousIssuers: options.previousIssuers,
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
    clientSecretEmbedded: result.clientSecretEmbedded,
    loginReady: result.plan.loginReady,
    gatewayConfigured: result.plan.gatewayConfigured,
    nacosConfigured: result.plan.nacosConfigured,
    embeddedSecrets: result.plan.embeddedSecrets,
    revocationConfigured: result.plan.revocationConfigured,
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
