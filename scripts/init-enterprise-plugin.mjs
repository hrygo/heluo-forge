#!/usr/bin/env node
/**
 * 员工端企业插件初始化（issue #222 · req-17）。
 *
 * 交付单元是「官方 DSH 宿主 + 企业私版插件 .tgz + 本脚本」，因此本文件**单文件自包含**：
 * 只依赖 `node:` 内置模块，不 import 仓库内任何模块，也不依赖源码工作区结构。把本文件
 * 与私版交付目录一起拷到员工机即可运行。
 *
 * 唯一的写入面是 `dsh plugin --profile <p> add <tgz 绝对路径>`（execFile、shell:false、
 * 固定 argv）。脚本不创建 profile、不启动或重启宿主、不直接编辑 profile 文件、不改
 * plugin_manager 权限、不删除用户文件。
 *
 * 核验只到脚本能证明的层次：L1 安装命令退出码、L2 `--dump-config` 含本插件且 profile
 * 记录对齐；L3 运行期挂载只输出 `mounted=unknown`，必须由员工在设置页确认。
 *
 * 归属：docs/teamflow/20261110-r17-dsh-lite-integration/TECH-CHANGE.md §3.2。
 *
 * 用法：
 *   node scripts/init-enterprise-plugin.mjs --release <交付目录> --profile <desktop|web>
 *     [--sha256 <hex>] [--dsh <path>] [--dry-run] [--json]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本插件在 profile 中的包名；与私版清单、补丁层同源。 */
export const ENTRY_PACKAGE = '@heluo/forge-enterprise';

/** 受支持的目标 profile；`auto` 表示按已有 profile 选择，缺失时创建 web。 */
export const PROFILE_NAMES = Object.freeze(['desktop', 'web']);
export const PROFILE_CHOICES = Object.freeze(['desktop', 'web', 'auto']);

/** 官方宿主 npm 包名与默认安装版本；版本可用 `--host-version` 覆盖。 */
export const HOST_PACKAGE = '@deepseek-ai/dsh';
export const DEFAULT_HOST_VERSION = '0.2.1-rc.5';

/** 私版交付 sidecar 的 schema；与 `scripts/lib/private-bundle.mjs` 同源。 */
export const RELEASE_SCHEMA = 'heluo-private-release/1';

/** 私版交付 sidecar 文件名；制作器写在交付目录顶层，tgz 内另嵌 `heluo-private-release.json`。 */
export const METADATA_FILE = 'private-release.json';

/** pnpm 安装依赖可能较慢，安装步骤超时给足；核验是只读组合，无需那么久。 */
export const INSTALL_TIMEOUT_MS = 300_000;
export const VERIFY_TIMEOUT_MS = 120_000;
/** npm 全局安装宿主可能拉取整棵依赖树，给更长的超时。 */
export const HOST_INSTALL_TIMEOUT_MS = 600_000;

const SHA256 = /^[0-9a-f]{64}$/u;
const HOST_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

export const USAGE = [
  '用法：node scripts/init-enterprise-plugin.mjs --release <交付目录> --profile <desktop|web|auto>',
  '        [--sha256 <hex>] [--dsh <path>] [--install-host] [--host-version <ver>]',
  '        [--dry-run] [--json]',
  '',
  '  --release <目录>   私版交付目录（须含 private-release.json 与同名 tgz）',
  '  --profile <名>     desktop、web 或 auto（auto：已有 desktop/web 优先，都没有则创建 web）',
  '  --sha256 <hex>     独立摘要口径；缺省读 private-release.json（自证）',
  '  --dsh <path>       指定 dsh（原生可执行文件或 npm 的 .cmd/.bat shim）；缺省在 PATH 查找',
  '  --install-host     找不到 dsh 时用 npm 全局安装官方宿主（需要 npm 与网络）',
  '  --host-version <v> 安装宿主时锁定的版本；缺省 ' + DEFAULT_HOST_VERSION,
  '  --dry-run          只打印将执行的命令与核验点，不写入',
  '  --json             输出同一结论的结构化版本',
].join('\n');

/** 可分类的失败：`code` 是稳定判据，`next` 是给员工的下一步。 */
export class InitError extends Error {
  constructor(code, message, next) {
    super(message);
    this.name = 'InitError';
    this.code = code;
    this.next = next ?? '修正上述问题后重跑本脚本；失败时不会删除或覆盖用户文件。';
  }
}

function isExecutableFile(path, platform = process.platform) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    return platform === 'win32' ? true : (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Windows 上 dsh 可能的入口形态；`.cmd`/`.bat` 会解析成 node + JS 入口，不经过 shell。 */
const WINDOWS_DSH_EXTENSIONS = Object.freeze(['.exe', '.cmd', '.bat']);

/**
 * npm 全局安装生成的 Windows shim（`dsh.cmd`）用 `%dp0%\node_modules\...\bin\*.js`
 * 指回真实入口。这里只提取该 `.js` 路径；解析不出返回 null，不猜、不回落到 `cmd.exe`。
 *
 * @param {string} shimPath
 * @returns {string|null} 入口 JS 的绝对路径
 */
export function shimEntryOf(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  for (const pattern of [
    /"(%dp0%|%~dp0)\\([^"\r\n]+?\.js)"/iu,
    /(%dp0%|%~dp0)\\([^\s"\r\n]+?\.js)/iu,
  ]) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const relative = match[2].replace(/\\/gu, '/');
    if (relative.includes('..')) continue;
    const entry = join(dirname(shimPath), relative);
    if (existsSync(entry)) return entry;
  }
  return null;
}

/**
 * 把命令路径解析成可 `execFile(shell:false)` 的调用描述：
 * - 原生 `.exe`（Windows）或 POSIX 可执行文件：直接执行；
 * - Windows `.cmd`/`.bat` shim：解析出 JS 入口，用当前 node 直接执行；
 * 解析失败返回 null（fail closed，不引入 shell 引号风险）。
 *
 * @param {string} path
 * @param {NodeJS.Platform} [platform]
 * @returns {{bin: string, prefix: string[]}|null}
 */
export function resolveCommandLaunch(path, platform = process.platform) {
  if (!isExecutableFile(path, platform)) return null;
  if (platform !== 'win32') return { bin: path, prefix: [] };
  if (path.toLowerCase().endsWith('.exe')) return { bin: path, prefix: [] };
  const entry = shimEntryOf(path);
  if (entry === null) return null;
  return { bin: process.execPath, prefix: [entry] };
}

/** dsh 专用别名；保留旧导出，行为与 `resolveCommandLaunch` 相同。 */
export function resolveDshLaunch(path, platform = process.platform) {
  return resolveCommandLaunch(path, platform);
}

/**
 * 解析参数。值可以是 `--flag value` 或 `--flag=value`；`--profile` 的取值在解析期校验，
 * 缺失或非 desktop/web/auto 直接 fail-closed，不猜 profile。
 *
 * @param {string[]} argv
 * @returns {{release?: string, profile?: string, sha256?: string, dsh?: string,
 *   installHost: boolean, hostVersion: string, dryRun: boolean, json: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const options = {
    release: undefined,
    profile: undefined,
    sha256: undefined,
    dsh: undefined,
    installHost: false,
    hostVersion: DEFAULT_HOST_VERSION,
    dryRun: false,
    json: false,
    help: false,
  };
  const valued = new Map([
    ['--release', 'release'],
    ['--profile', 'profile'],
    ['--sha256', 'sha256'],
    ['--dsh', 'dsh'],
    ['--host-version', 'hostVersion'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--install-host') {
      options.installHost = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    const key = valued.get(flag);
    if (key !== undefined) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
        throw new InitError('BAD_ARGUMENT', `init: ${flag} 需要一个值`, `用 ${flag} <值> 重跑。`);
      }
      if (inline === undefined) index += 1;
      options[key] = value;
      continue;
    }
    throw new InitError('BAD_ARGUMENT', `init: 未知参数「${arg}」`, '可用参数见 --help。');
  }
  if (options.help) return options;
  if (options.release === undefined) {
    throw new InitError('BAD_ARGUMENT', 'init: 缺少 --release <交付目录>', '先提供含 private-release.json 与同名 tgz 的交付目录。');
  }
  if (options.profile === undefined) {
    throw new InitError('BAD_ARGUMENT', 'init: 缺少 --profile <desktop|web|auto>', '用 --profile auto 自动选择/创建 web profile，或显式指定 desktop/web。');
  }
  if (!PROFILE_CHOICES.includes(options.profile)) {
    throw new InitError('PROFILE_INVALID', `init: 不支持的 profile「${options.profile}」`, '只接受 desktop、web 或 auto。');
  }
  if (!HOST_VERSION.test(options.hostVersion)) {
    throw new InitError('HOST_VERSION_INVALID', `init: --host-version 不是合法版本号「${options.hostVersion}」`, '传入纯版本号（如 0.2.1-rc.5），不要带包名或路径。');
  }
  if (options.sha256 !== undefined) {
    if (!SHA256.test(options.sha256.toLowerCase())) {
      throw new InitError('DIGEST_INVALID', 'init: --sha256 不是 64 位十六进制摘要', '从可信渠道取得摘要后重跑；不要用制品同目录的自证摘要。');
    }
    options.sha256 = options.sha256.toLowerCase();
  }
  return options;
}

/** 文件摘要：hex 小写，与 `scripts/lib/release-support.mjs` 的 `sha256` 同口径。 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `DSH_HOME` 优先，否则 `<home>/.dsh`，再拼 `profiles/<name>`。 */
export function dshHomeOf(env = {}, home = homedir()) {
  const configured = env?.DSH_HOME === undefined ? '' : String(env.DSH_HOME).trim();
  return configured === '' ? join(home, '.dsh') : resolve(configured);
}

/**
 * 在 PATH 里找命令。Windows 依次尝试 `.exe`、`.cmd`、`.bat`；`.cmd`/`.bat` 只在能解析出
 * 真实 JS 入口时才算可用。POSIX 直接找同名可执行文件。
 *
 * @returns {{path: string, bin: string, prefix: string[]}|null}
 */
export function locateCommandLaunch(name, env = {}, platform = process.platform) {
  const value = env.PATH ?? env.Path ?? env.path ?? '';
  if (typeof value !== 'string' || value.length === 0) return null;
  const extensions = platform === 'win32' ? WINDOWS_DSH_EXTENSIONS : [''];
  for (const directory of value.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      const launch = resolveCommandLaunch(candidate, platform);
      if (launch !== null) return { path: candidate, ...launch };
    }
  }
  return null;
}

/**
 * 定位 npm 的入口。Windows 的 npm.cmd 同时提到 `npm-prefix.js` 与 `npm-cli.js`，
 * 通用 shim 解析会取到前者，`node npm-prefix.js install -g …` 只会打印前缀并以 0
 * 退出，看似成功却什么都没装。这里对 npm 固定选 npm-cli.js，仍不经过 shell。
 *
 * @returns {{path: string, bin: string, prefix: string[]}|null}
 */
export function locateNpmLaunch(env = {}, platform = process.platform) {
  const npm = locateCommandLaunch('npm', env, platform);
  if (npm === null) return null;
  if (platform !== 'win32') return npm;
  const cli = join(dirname(npm.path), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { path: npm.path, bin: process.execPath, prefix: [cli] };
  return npm;
}

/** dsh 专用别名；保留旧导出。 */
export function locateDshLaunch(env = {}, platform = process.platform) {
  return locateCommandLaunch('dsh', env, platform);
}

/**
 * 在 PATH 里找 dsh，返回入口路径；找不到返回 null。
 *
 * @returns {string|null}
 */
export function locateDsh(env = {}, platform = process.platform) {
  return locateDshLaunch(env, platform)?.path ?? null;
}

/** profile 是否已由宿主初始化（存在 package.json）。 */
export function profileExists(name, { env = {}, home = homedir() } = {}) {
  return existsSync(join(dshHomeOf(env, home), 'profiles', name, 'package.json'));
}

/** 已有 profile 优先 desktop、再 web；都没有返回 null。 */
export function existingProfileName({ env = {}, home = homedir() } = {}) {
  // Prefer web: official dsh 0.2.1-rc.5 refuses to manage the Electron profile
  // from the CLI ("profile \"desktop\" is managed exclusively by the Electron
  // application"), so auto-selecting desktop would only produce a late failure.
  for (const name of ['web', 'desktop']) {
    if (profileExists(name, { env, home })) return name;
  }
  return null;
}

/**
 * 在 npm 全局 prefix 里找命令。npm 安装后当前进程的 PATH 可能还没刷新，这里补一条
 * 不依赖 PATH 的查找路径。
 */
export function commandInNpmPrefix(name, prefix, platform = process.platform) {
  const binDir = platform === 'win32' ? prefix : join(prefix, 'bin');
  const extensions = platform === 'win32' ? WINDOWS_DSH_EXTENSIONS : [''];
  for (const extension of extensions) {
    const launch = resolveCommandLaunch(join(binDir, `${name}${extension}`), platform);
    if (launch !== null) return { path: join(binDir, `${name}${extension}`), ...launch };
  }
  return null;
}

/**
 * 官方 npm 版 `dsh plugin add` 在内部用 pnpm 装依赖；PATH 里没有 pnpm 时它只返回
 * 退出码 1，员工看到的是宿主的 `'pnpm' is not recognized` 而不是缺工具，失败还会
 * 停在半安装状态。安装前先判定，给出可直接执行的下一步。
 *
 * @param {object} env 运行环境（默认 process.env）
 * @param {string} platform
 */
const PNPM_CANDIDATES = Object.freeze({
  win32: ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat'],
  other: ['pnpm'],
});

/**
 * 目录里是否存在 pnpm 启动文件。npm 全局安装的 `pnpm.cmd` 指向 `pnpm.exe` 而不是
 * JS 入口，解析器不会把它当可执行 shim，因此按文件存在判断，运行交给子进程 PATH。
 */
function pnpmLauncherIn(directory, platform = process.platform) {
  const names = platform === 'win32' ? PNPM_CANDIDATES.win32 : PNPM_CANDIDATES.other;
  for (const name of names) {
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      if (platform !== 'win32') accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** 在 PATH 的每个目录里找 pnpm 启动文件，返回其目录。 */
function pnpmDirInPath(env, platform = process.platform) {
  const value = env.PATH ?? env.Path ?? env.path ?? '';
  if (typeof value !== 'string' || value === '') return null;
  for (const directory of value.split(delimiter)) {
    if (directory.length === 0) continue;
    if (pnpmLauncherIn(directory, platform) !== null) return directory;
  }
  return null;
}

/** 把目录放到 PATH 最前，供子进程查找刚装好的 pnpm。 */
function withPathDir(env, dir, platform = process.platform) {
  const key = env.PATH === undefined ? (env.Path === undefined ? 'PATH' : 'Path') : 'PATH';
  const current = env[key] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return { ...env, [key]: current === '' ? dir : `${dir}${separator}${current}` };
}

/**
 * `dsh plugin add` 在官方 npm 版宿主内部调用 pnpm。缺 pnpm 时宿主只回一行
 * "'pnpm' is not recognized" 和退出码 1，员工看到的是安装失败而不是缺工具，
 * 因此这里先用与安装宿主相同的 npm 权限补装，并把它的目录注入子进程 PATH。
 *
 * @returns {Promise<{env: object, dir: string|null}>} dir 为需要注入 PATH 的目录
 */
async function ensurePnpm({ exec, env, platform, lines }) {
  const found = pnpmDirInPath(env, platform);
  if (found !== null) return { env: withPathDir(env, found, platform), dir: found };
  const npm = locateNpmLaunch(env, platform);
  if (npm === null) {
    throw new InitError(
      'PNPM_REQUIRED',
      'init: 找不到 pnpm，且没有 npm 可以补装',
      '先安装 Node.js LTS（自带 npm），再运行 npm install -g pnpm；或在可用 corepack 的环境执行 corepack enable pnpm，确认 pnpm --version 可运行后重跑。',
    );
  }
  lines.push('工具：未找到 pnpm，执行 npm install -g pnpm');
  const installed = await runStep(exec, npm, ['install', '-g', 'pnpm'], HOST_INSTALL_TIMEOUT_MS, 'PNPM_REQUIRED');
  if (installed.code !== 0) {
    throw new InitError(
      'PNPM_REQUIRED',
      `init: npm install -g pnpm 失败（退出码 ${installed.code}）`,
      '检查网络与 npm registry 配置；或由管理员预先安装 pnpm，确认 pnpm --version 可运行后重跑。',
    );
  }
  const afterInstall = pnpmDirInPath(env, platform);
  if (afterInstall !== null) return { env: withPathDir(env, afterInstall, platform), dir: afterInstall };
  const prefixResult = await runStep(exec, npm, ['prefix', '-g'], 60_000, 'PNPM_REQUIRED');
  const prefix = prefixResult.stdout.split(/\r?\n/u).filter((line) => line.trim() !== '').pop();
  if (prefix !== undefined) {
    const binDir = platform === 'win32' ? prefix.trim() : join(prefix.trim(), 'bin');
    if (pnpmLauncherIn(binDir, platform) !== null) {
      return { env: withPathDir(env, binDir, platform), dir: binDir };
    }
  }
  throw new InitError(
    'PNPM_REQUIRED',
    'init: pnpm 安装完成但找不到入口',
    '运行 npm prefix -g，把其 bin 目录加入 PATH；确认 pnpm --version 可运行后重跑。',
  );
}

/**
 * 读取并核验私版交付目录：sidecar schema、包名、secret 标记、tgz 文件名/大小/摘要。
 *
 * sidecar 的摘要只是制作者自证；调用方可用 `--sha256` 覆盖为独立口径。
 *
 * @param {string} directory 交付目录
 * @returns {{dir: string, metadataPath: string, metadata: object, version: string,
 *   tarballName: string, tarballPath: string, sha256: string, bytes: number}}
 */
export function readPrivateRelease(directory) {
  const dir = resolve(directory);
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new InitError('RELEASE_MISSING', `init: 交付目录不存在（${directory}）`, '确认 --release 指向解压后的私版交付目录。');
  }
  if (!stats.isDirectory()) {
    throw new InitError('RELEASE_MISSING', `init: --release 不是目录（${directory}）`, '指向解压后的私版交付目录。');
  }
  const metadataPath = join(dir, METADATA_FILE);
  if (!existsSync(metadataPath)) {
    throw new InitError('SIDECAR_MISSING', `init: 交付目录缺少 ${METADATA_FILE}`, '重新取得完整私版交付目录；不要只拷 tgz。');
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new InitError('SIDECAR_INVALID', `init: ${METADATA_FILE} 不是合法 JSON`, '重新取得完整私版交付目录。');
  }
  if (metadata?.schema !== RELEASE_SCHEMA) {
    throw new InitError('SIDECAR_INVALID', `init: ${METADATA_FILE} schema 不是 ${RELEASE_SCHEMA}`, '确认交付目录与本脚本来自同一发布。');
  }
  if (metadata?.entry?.name !== ENTRY_PACKAGE) {
    throw new InitError('SIDECAR_INVALID', `init: sidecar 包名不是 ${ENTRY_PACKAGE}`, '确认交付的是企业组合插件，而不是公版或其它插件。');
  }
  const version = metadata?.entry?.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new InitError('SIDECAR_INVALID', 'init: sidecar 缺少企业包版本', '重新取得完整私版交付目录。');
  }
  if (metadata?.config?.secretEmbedded !== false) {
    throw new InitError('SECRET_EMBEDDED', 'init: sidecar 未声明 config.secretEmbedded=false，拒绝安装', '企业私版不得内嵌 secret；退回制作端修正后重新制作。');
  }
  const tarball = metadata?.tarball;
  if (typeof tarball?.name !== 'string' || tarball.name === '' || tarball.name !== tarball.name.split(/[\\/]/u).pop()) {
    throw new InitError('SIDECAR_INVALID', 'init: sidecar 的 tarball.name 不是简单文件名', '拒绝可能越界的路径；重新取得完整私版交付目录。');
  }
  if (!SHA256.test(String(tarball?.sha256 ?? ''))) {
    throw new InitError('SIDECAR_INVALID', 'init: sidecar 的 tarball.sha256 不是 64 位十六进制摘要', '重新取得完整私版交付目录。');
  }
  if (typeof tarball?.bytes !== 'number' || !Number.isSafeInteger(tarball.bytes)) {
    throw new InitError('SIDECAR_INVALID', 'init: sidecar 的 tarball.bytes 不是整数', '重新取得完整私版交付目录。');
  }
  const tarballPath = join(dir, tarball.name);
  if (!existsSync(tarballPath)) {
    throw new InitError('TARBALL_MISSING', `init: 交付目录缺少 ${tarball.name}`, '重新取得完整私版交付目录；不要移动或改名 tgz。');
  }
  const bytes = statSync(tarballPath).size;
  if (bytes !== tarball.bytes) {
    throw new InitError('TARBALL_MISMATCH', `init: ${tarball.name} 大小与 sidecar 记录不一致`, '重新取得未损坏的制品；不要拼接或截断 tgz。');
  }
  const digest = sha256File(tarballPath);
  if (digest !== tarball.sha256) {
    throw new InitError('SIDECAR_DIGEST_MISMATCH', `init: ${tarball.name} 摘要与 sidecar 记录不一致`, '重新取得未损坏的制品；sidecar 自证不符时不得继续。');
  }
  return { dir, metadataPath, metadata, version, tarballName: tarball.name, tarballPath, sha256: digest, bytes };
}

/**
 * 读取目标 profile 的 package.json；profile 是外部状态，只读不建。
 *
 * @returns {{name: string, dir: string, manifestPath: string, manifest: object, dshHome: string}}
 */
export function inspectProfile({ profile, env = {}, home = homedir() }) {
  if (!PROFILE_NAMES.includes(profile)) {
    throw new InitError('PROFILE_INVALID', `init: 不支持的 profile「${profile}」`, '只接受 desktop 或 web；脚本不创建 profile。');
  }
  const dshHome = dshHomeOf(env, home);
  const dir = join(dshHome, 'profiles', profile);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    const next = profile === 'desktop'
      ? '先启动一次官方 DeepSeek Harness Desktop 完成 profile 初始化并完全退出，再重跑本脚本。'
      : '先启动一次官方 DSH Web 初始化该 profile，再重跑本脚本。';
    throw new InitError('PROFILE_MISSING', `init: profile「${profile}」尚未初始化（缺少 profiles/${profile}/package.json）`, next);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new InitError('PROFILE_INVALID', `init: profiles/${profile}/package.json 无法解析`, '修复或重建该 profile 后重跑；脚本不会覆盖它。');
  }
  return { name: profile, dir, manifestPath, manifest, dshHome };
}

function installedVersionOf(profile) {
  const path = join(profile.dir, 'node_modules', ...ENTRY_PACKAGE.split('/'), 'package.json');
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : null;
  } catch {
    return null;
  }
}

function profileAligned(profile) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(profile.manifestPath, 'utf8'));
  } catch {
    return { dependencies: false, bundles: false };
  }
  const dependencies = manifest?.dependencies?.[ENTRY_PACKAGE] !== undefined;
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(ENTRY_PACKAGE);
  return { dependencies, bundles };
}

function verificationPoints(profile) {
  return [
    `核验点：L1 安装命令退出码为 0`,
    `核验点：L2 dsh --profile ${profile.name} --dump-config 含 ${ENTRY_PACKAGE}，且 profile dependencies 与 dsh.profile.bundles 对齐`,
    '核验点：L3 运行期挂载不在脚本内断言——启动宿主后在「设置 → 插件」确认，脚本只报 mounted=unknown',
  ];
}

function defaultExec() {
  return (bin, args, options) =>
    new Promise((settle) => {
      execFile(bin, args, { ...options, shell: false }, (error, stdout, stderr) => {
        settle({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      });
    });
}

const resolveExec = (exec) => (typeof exec === 'function' ? exec : defaultExec());

async function runStep(exec, launch, args, timeout, failureCode, { env } = {}) {
  let result;
  try {
    result = await exec(launch.bin, [...launch.prefix, ...args], { timeout, shell: false, ...(env === undefined ? {} : { env }) });
  } catch (error) {
    const reason = typeof error?.code === 'string' ? error.code : (error?.message ?? 'UNKNOWN');
    throw new InitError(failureCode, `init: 调用 dsh 失败（${reason}）`, '确认 --dsh 指向可用的 dsh（原生可执行文件或 npm 的 dsh.cmd）、宿主未在升级中，再重跑。');
  }
  return {
    code: typeof result?.code === 'number' ? result.code : 1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  };
}

/**
 * 用 npm 全局安装官方宿主；安装后先在 PATH 找，再查 npm 全局 prefix，避免当前进程
 * PATH 未刷新导致“装了却找不到”。
 *
 * @returns {Promise<{path: string, bin: string, prefix: string[]}>}
 */
async function installHost({ exec, env, platform, version, lines }) {
  const npm = locateNpmLaunch(env, platform);
  if (npm === null) {
    throw new InitError(
      'HOST_INSTALL_FAILED',
      'init: 未找到 npm，无法自动安装官方宿主',
      '先安装 Node.js（自带 npm）并确保 npm 在 PATH；或从官方渠道安装 DSH 后重跑。',
    );
  }
  const spec = `${HOST_PACKAGE}@${version}`;
  lines.push(`宿主：未找到 dsh，执行 npm install -g ${spec}`);
  const result = await runStep(exec, npm, ['install', '-g', spec], HOST_INSTALL_TIMEOUT_MS, 'HOST_INSTALL_FAILED');
  if (result.code !== 0) {
    throw new InitError(
      'HOST_INSTALL_FAILED',
      `init: npm install -g ${spec} 失败（退出码 ${result.code}）`,
      '检查网络与 npm registry 配置；或从官方渠道安装 DSH 后重跑。',
    );
  }
  const fromPath = locateDshLaunch(env, platform);
  if (fromPath !== null) {
    lines.push(`宿主：已安装并定位到 ${fromPath.path}`);
    return fromPath;
  }
  const prefixResult = await runStep(exec, npm, ['prefix', '-g'], 60_000, 'HOST_INSTALL_FAILED');
  const prefix = prefixResult.stdout.split(/\r?\n/u).filter((line) => line.trim() !== '').pop();
  if (prefix !== undefined) {
    const fromPrefix = commandInNpmPrefix('dsh', prefix.trim(), platform);
    if (fromPrefix !== null) {
      lines.push(`宿主：已安装并定位到 ${fromPrefix.path}`);
      return fromPrefix;
    }
  }
  throw new InitError(
    'HOST_INSTALL_FAILED',
    'init: npm 安装完成但找不到 dsh 入口',
    '确认 npm 全局 bin 目录在 PATH；或运行 npm prefix -g 后手工把其 bin 目录加入 PATH，再重跑。',
  );
}

/** 用官方宿主的 `--dump-config` 创建 shipped web profile 模板；不启动服务。 */
async function createWebProfile({ exec, launch, lines }) {
  const result = await runStep(exec, launch, ['--profile', 'web', '--dump-config'], VERIFY_TIMEOUT_MS, 'PROFILE_CREATE_FAILED');
  if (result.code !== 0) {
    throw new InitError(
      'PROFILE_CREATE_FAILED',
      `init: 创建 web profile 失败（dsh --dump-config 退出码 ${result.code}）`,
      '确认宿主安装完整、DSH_HOME 可写后重跑；脚本不会覆盖已有 profile。',
    );
  }
  lines.push('profile：已用官方宿主创建 web profile 模板（--dump-config，未启动服务）');
}

async function verifyInstall({ exec, launch, profile, lines }) {
  const result = await runStep(exec, launch, ['--profile', profile.name, '--dump-config'], VERIFY_TIMEOUT_MS, 'VERIFY_FAILED');
  if (result.code !== 0) {
    throw new InitError(
      'VERIFY_FAILED',
      `init: 安装后核验失败：dsh --dump-config 退出码 ${result.code}`,
      `手工运行 dsh --profile ${profile.name} --dump-config 查看原因；必要时 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE} 后重装。`,
    );
  }
  if (!result.stdout.includes(ENTRY_PACKAGE)) {
    throw new InitError(
      'VERIFY_FAILED',
      `init: 安装后核验失败：--dump-config 输出不含 ${ENTRY_PACKAGE}`,
      '确认安装命令写入的是目标 profile；必要时移除后重装，不要直接编辑 profile 文件。',
    );
  }
  const aligned = profileAligned(profile);
  if (!aligned.dependencies || !aligned.bundles) {
    throw new InitError(
      'VERIFY_FAILED',
      `init: 安装后核验失败：profile 记录未对齐（dependencies=${aligned.dependencies ? '有' : '无'}，dsh.profile.bundles=${aligned.bundles ? '有' : '无'}）`,
      '不要在脚本外手工改 profile；先 remove 再重装，或检查 profile 是否被其它进程改写。',
    );
  }
  lines.push(`核验：L1 退出码 0；L2 --dump-config 含 ${ENTRY_PACKAGE}，dependencies 与 dsh.profile.bundles 已对齐`);
  return { verified: { exitCode: 0, dumpConfig: true, profileAligned: true } };
}

/**
 * 执行一次初始化。
 *
 * 返回 `{ code, lines, warnings, result }`：`lines` 是要打到 stdout 的逐行回显，`result`
 * 是 `--json` 的结构化版本（与回显同一结论）。`code` 0 = 安装/已安装/演练完成，1 = 任何
 * fail-closed 或核验失败。
 *
 * @param {{argv?: string[], env?: object, home?: string, exec?: Function|null}} [input]
 */
export async function runInit({ argv = [], env = process.env, home = homedir(), exec = null } = {}) {
  const lines = [];
  const warnings = [];
  const requestedJson = argv.includes('--json');
  try {
    const options = parseArgs(argv);
    if (options.help) {
      return { code: 0, lines: [USAGE], warnings, result: { ok: true, status: 'help', usage: USAGE } };
    }
    const release = readPrivateRelease(options.release);
    const digestSource = options.sha256 === undefined ? 'sidecar' : '--sha256';
    if (options.sha256 !== undefined && options.sha256 !== release.sha256) {
      throw new InitError(
        'DIGEST_MISMATCH',
        `init: --sha256 与交付制品实际摘要不一致（制品 ${release.sha256}）`,
        '确认制品未损坏，或从可信渠道重新取得摘要；不按 sidecar 自证放行。',
      );
    }
    const platform = process.platform;
    let launch = null;
    let plannedHostInstall = false;
    if (options.dsh !== undefined) {
      launch = resolveCommandLaunch(resolve(options.dsh), platform);
      if (launch === null) {
        throw new InitError(
          'DSH_MISSING',
          `init: --dsh 指向的文件不可执行或无法解析（${options.dsh}）`,
          '指向官方安装的 dsh：原生可执行文件，或 npm 全局安装的 dsh.cmd/.bat；脚本会把 shim 解析成 node + JS 入口，不通过 shell 启动。',
        );
      }
    } else {
      launch = locateDshLaunch(env, platform);
      if (launch === null && options.installHost && !options.dryRun) {
        launch = await installHost({ exec: resolveExec(exec), env, platform, version: options.hostVersion, lines });
      } else if (launch === null && options.installHost) {
        plannedHostInstall = true;
      } else if (launch === null) {
        throw new InitError(
          'DSH_MISSING',
          'init: 未在 PATH 找到可用的 dsh',
          '加 --install-host 让脚本用 npm 安装官方宿主；或从官方渠道安装 DSH（原生安装，或 npm 全局安装后的 dsh.cmd）并确保 dsh 在 PATH。',
        );
      }
    }

    let profileName = options.profile;
    if (profileName === 'auto') {
      const existing = existingProfileName({ env, home });
      if (existing === 'desktop') {
        throw new InitError(
          'DESKTOP_PROFILE_UNSUPPORTED',
          'init: 只找到 Desktop profile，而官方 dsh 拒绝由命令行管理 desktop profile（managed exclusively by the Electron application）',
          '请在 Desktop 应用的插件设置中安装企业插件，或改用 web 形态；本脚本不会改动 Electron 管理的 profile。',
        );
      }
      profileName = existing ?? 'web';
    }
    let profile;
    let plannedProfileCreate = false;
    if (profileExists(profileName, { env, home })) {
      profile = inspectProfile({ profile: profileName, env, home });
    } else if (profileName === 'desktop') {
      throw new InitError(
        'PROFILE_MISSING',
        'init: profile「desktop」尚未初始化（缺少 profiles/desktop/package.json）',
        'Desktop profile 由官方 Electron 应用独占创建：先启动一次官方 DeepSeek Harness Desktop 并完全退出，再重跑本脚本。',
      );
    } else if (options.dryRun || launch === null) {
      plannedProfileCreate = true;
      const dshHome = dshHomeOf(env, home);
      profile = {
        name: profileName,
        dir: join(dshHome, 'profiles', profileName),
        manifestPath: join(dshHome, 'profiles', profileName, 'package.json'),
        manifest: {},
        dshHome,
      };
    } else {
      await createWebProfile({ exec: resolveExec(exec), launch, lines });
      profile = inspectProfile({ profile: profileName, env, home });
    }

    const command = ['plugin', '--profile', profile.name, 'add', release.tarballPath];
    const artifact = { name: release.tarballName, sha256: release.sha256, source: digestSource };
    const base = {
      ok: true,
      profile: profile.name,
      entry: { name: ENTRY_PACKAGE, version: release.version },
      artifact,
      mounted: 'unknown',
    };

    lines.push('企业插件初始化');
    lines.push(`profile：${profile.name}`);
    lines.push(`插件：${ENTRY_PACKAGE} ${release.version}`);
    lines.push(`制品：${release.tarballName}`);
    lines.push(
      `摘要：${release.sha256}（来源：${digestSource === '--sha256' ? '--sha256 独立口径' : 'private-release.json 自证；建议另用 --sha256 提供独立来源'}）`,
    );

    const installed = installedVersionOf(profile);
    const declared = profile.manifest?.dependencies?.[ENTRY_PACKAGE] !== undefined;
    if (plannedHostInstall) {
      lines.push(`dry-run：未找到 dsh，将执行 npm install -g ${HOST_PACKAGE}@${options.hostVersion}`);
    }
    if (plannedProfileCreate) {
      lines.push(`dry-run：profiles/${profile.name} 不存在，将执行 dsh --profile ${profile.name} --dump-config 创建模板`);
    }
    if (declared || installed !== null) {
      if (installed === null) {
        throw new InitError(
          'VERSION_UNKNOWN',
          `init: profile「${profile.name}」记录了 ${ENTRY_PACKAGE}，但读不出已安装版本`,
          `先运行 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE} 再重跑；脚本不解析 file: spec 猜版本。`,
        );
      }
      if (installed !== release.version) {
        throw new InitError(
          'VERSION_CONFLICT',
          `init: 已安装 ${installed}，交付版本为 ${release.version}`,
          `不自动升级或降级。确认后执行 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE}，再重跑本脚本。`,
        );
      }
      lines.push(`状态：已安装同版本 ${installed}，本次不写入`);
      if (options.dryRun) {
        lines.push('dry-run：未执行安装，未写入 profile');
        lines.push(...verificationPoints(profile));
        return { code: 0, lines, warnings, result: { ...base, status: 'dry-run', command, verified: null } };
      }
      const verification = await verifyInstall({ exec: resolveExec(exec), launch, profile, lines });
      lines.push('mounted=unknown（运行期挂载不在本脚本断言；启动宿主后在「设置 → 插件」确认）');
      lines.push(`下一步：启动官方 DSH（${profile.name} profile），在设置页确认 ${ENTRY_PACKAGE} 已加载。`);
      return { code: 0, lines, warnings, result: { ...base, status: 'already-installed', command, verified: verification.verified } };
    }

    lines.push(`命令：dsh ${command.join(' ')}`);
    if (options.dryRun) {
      lines.push('dry-run：未执行安装，未写入 profile');
      lines.push(...verificationPoints(profile));
      return { code: 0, lines, warnings, result: { ...base, status: 'dry-run', command, verified: null } };
    }

    const cli = resolveExec(exec);
    const pnpm = await ensurePnpm({ exec: cli, env, platform: process.platform, lines });
    const install = await runStep(cli, launch, command, INSTALL_TIMEOUT_MS, 'INSTALL_FAILED', { env: pnpm.env });
    if (install.code !== 0) {
      throw new InitError(
        'INSTALL_FAILED',
        `init: dsh plugin add 失败（退出码 ${install.code}）`,
        `检查上面的命令输出与 profile 占用情况后重跑；回滚用 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE}。`,
      );
    }
    lines.push('安装：dsh 退出码 0');
    const verification = await verifyInstall({ exec: cli, launch, profile, lines });
    lines.push('mounted=unknown（运行期挂载不在本脚本断言；启动宿主后在「设置 → 插件」确认）');
    lines.push(`下一步：启动官方 DSH（${profile.name} profile），在设置页确认 ${ENTRY_PACKAGE} 已加载。`);
    return { code: 0, lines, warnings, result: { ...base, status: 'installed', command, verified: verification.verified } };
  } catch (error) {
    const known = error instanceof InitError
      ? error
      : new InitError(
        'UNEXPECTED',
        `init: 未预期的失败（${typeof error?.code === 'string' ? error.code : error?.message ?? 'UNKNOWN'}）`,
        '检查上述原因后重跑；需要时用 --dry-run 查看将执行的命令。',
      );
    const failure = { ok: false, error: { code: known.code, message: known.message, next: known.next } };
    if (requestedJson) {
      return { code: 1, lines: [], warnings: [], result: failure };
    }
    return { code: 1, lines: [`失败：${known.code}`, known.message, `下一步：${known.next}`], warnings: [], result: failure };
  }
}

/**
 * CLI 入口：`--json` 只输出结构化结论，其余情况逐行输出回显；返回进程退出码。
 */
export async function main(argv = [], env = process.env) {
  const outcome = await runInit({ argv, env, home: homedir() });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  } else {
    for (const line of outcome.lines) process.stdout.write(`${line}\n`);
    for (const warning of outcome.warnings) process.stderr.write(`${warning}\n`);
  }
  return outcome.code;
}

function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    // macOS puts /tmp behind /private/tmp: a symlinked or aliased invocation
    // must still run, instead of silently doing nothing.
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`init: ${error?.message ?? 'UNKNOWN'}\n`);
      process.exitCode = 1;
    },
  );
}
