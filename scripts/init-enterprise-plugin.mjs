#!/usr/bin/env node
/**
 * 员工端企业插件初始化（issue #222 · req-17）。
 *
 * 交付单元是「官方 DSH 宿主 + 企业私版插件 .tgz + 本脚本」，因此本文件**单文件自包含**：
 * 只依赖 `node:` 内置模块，不 import 仓库内任何模块，也不依赖源码工作区结构。把本文件
 * 与私版交付目录一起拷到员工机即可运行。
 *
 * 写入面有四处：`dsh plugin --profile <p> remove <包名>`（仅当 profile 里已装的是另一个版本时，
 * 先卸载再安装）、`dsh plugin --profile <p> add <tgz 绝对路径>`（execFile、shell:false、固定 argv）、
 * 安装成功后在本 profile 目录下写一份制品证据（`profiles/<p>/.heluo-enterprise-install.json`：
 * 本次 tgz 摘要 + 已安装目录摘要），供下次同版本重跑判断"已安装的是不是这份交付"；以及
 * 清空 `profiles/<p>/node_modules`（pnpm 的链接产物，不是用户文件）：调用方以
 * `--reinstall-on-store-mismatch` 声明拥有该 profile 时，pnpm 报 store 不一致
 * （node_modules 由另一个 pnpm 的 store 链接）后重试一次；调用方再以 `--pnpm-store`
 * 声明本次将用的 store 且预检发现与 profile 记录的不一致时，则发生在任何包操作之前。
 * 同版本重跑保持零写入；版本不同时按交付包升级或回退，命令都经官方 CLI
 * 转发 pnpm。缺失的 profile 只经官方宿主的 web 模板创建。脚本不启动或重启宿主、不直接
 * 编辑 profile 清单、不改 plugin_manager 权限、不删除用户文件。
 *
 * 核验只到脚本能证明的层次：L1 安装命令退出码、L2 `--dump-config` 含本插件且 profile
 * 记录对齐；L3 运行期挂载只输出 `mounted=unknown`，必须由员工在设置页确认。
 *
 * 归属：docs/teamflow/20261110-r17-dsh-lite-integration/TECH-CHANGE.md §3.2。
 *
 * 用法：
 *   node scripts/init-enterprise-plugin.mjs --release <交付目录> --profile <desktop|web|名称>
 *     [--sha256 <hex>] [--dsh <path>] [--dry-run] [--json]
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本插件在 profile 中的包名；与私版清单、补丁层同源。 */
export const ENTRY_PACKAGE = '@heluo/forge-enterprise';

/** 受支持的目标 profile；`auto` 表示按已有 profile 选择，缺失时创建 web。 */
export const PROFILE_NAMES = Object.freeze(['desktop', 'web']);
export const PROFILE_CHOICES = Object.freeze(['desktop', 'web', 'auto']);

/**
 * 自定义 profile 名（如 `uat`）。官方宿主按 `$DSH_HOME/profiles/<name>` 装载 profile，
 * 名字就是目录名，所以只接受与目录安全一致的字符集，且不把保留字 `auto` 当名字。
 */
export const CUSTOM_PROFILE_PATTERN = Object.freeze(/^[a-z][a-z0-9-]{0,31}$/u);

/** @param {string} name @returns {boolean} */
export function isSupportedProfileName(name) {
  return PROFILE_CHOICES.includes(name) || (name !== 'auto' && CUSTOM_PROFILE_PATTERN.test(name));
}

/**
 * 官方宿主 npm 包名与默认安装版本；版本可用 `--host-version` 覆盖。
 *
 * 交付包离开仓库运行，读不到 `.dsh-version`，只能写成字面量；该字面量必须与仓库根
 * `.dsh-version` 的确认基线一致（`scripts/dsh-version.mjs check` 会断言，升级基线须同步）。
 */
export const HOST_PACKAGE = '@deepseek-ai/dsh';
export const DEFAULT_HOST_VERSION = '0.2.2-rc.5';

/** 私版交付 sidecar 的 schema；与 `scripts/lib/private-bundle.mjs` 同源。 */
export const RELEASE_SCHEMA = 'heluo-private-release/1';

/** 私版交付 sidecar 文件名；制作器写在交付目录顶层，tgz 内另嵌 `heluo-private-release.json`。 */
export const METADATA_FILE = 'private-release.json';

/** 交付目录内可选的内嵌客户端密钥描述文件（`release-delivery --embed-client-secret` 写入）。 */
export const CLIENT_SECRET_BINDING_FILE = 'client-secret.json';
/** 内嵌密钥绑定文件的 schema；与 release-delivery 写出的内容同源。 */
export const CLIENT_SECRET_SCHEMA = 'heluo-client-secret/1';
/** Discovery 文档的超时：企业内网 IAM 通常很快，超过 20 秒视为不可达。 */
export const DISCOVERY_TIMEOUT_MS = 20_000;
/** 预置客户端密钥的子进程超时；写本机凭据库只是本地操作。 */
export const PROVISION_TIMEOUT_MS = 60_000;

/** pnpm 安装依赖可能较慢，安装步骤超时给足；核验是只读组合，无需那么久。 */
export const INSTALL_TIMEOUT_MS = 300_000;
export const VERIFY_TIMEOUT_MS = 120_000;
/** npm 全局安装宿主可能拉取整棵依赖树，给更长的超时。 */
export const HOST_INSTALL_TIMEOUT_MS = 600_000;

const SHA256 = /^[0-9a-f]{64}$/u;
const HOST_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

/** `--pnpm-from-host` 的回显：工具来源写进结论，读日志的人才知道没有查过 PATH。 */
export const PNPM_FROM_HOST_LINE = '工具：pnpm 由宿主提供（--pnpm-from-host），不在 PATH 查找，也不补装';

/**
 * pnpm 在「node_modules 由另一个 store 链接」时拒绝继续安装所用的错误码。
 * 触发条件是 store 目录不同，与 pnpm 版本无关：同一个 profile 被两个 pnpm 写过就会遇到。
 */
export const STORE_MISMATCH_CODE = 'ERR_PNPM_UNEXPECTED_STORE';

/** `--reinstall-on-store-mismatch` 的回显：修复是否获准写进结论，读日志的人才知道 node_modules 可能被清空。 */
export const REINSTALL_LINE = '修复：pnpm 报 store 不一致时，清空目标 profile 的 node_modules 后重试一次（--reinstall-on-store-mismatch）';

/** `--pnpm-store` 的回显：预检的依据写进结论，读日志的人才知道 store 是调用方声明、安装器比对的。 */
export const PNPM_STORE_LINE = '预检：--pnpm-store 由拥有该 pnpm 的调用方声明本次将用的 store，安装器在改动 profile 之前先比对';

/**
 * 本安装器理解的、面向调用方的可选参数。调用方（企业版桌面壳动态加载本模块）先读这份
 * 清单，再决定传哪些参数：清单里有的才传，清单外的一个都不传。早于本导出的安装器没有
 * 这份清单，但其中认识「随包 pnpm」与「修复授权」两个参数的版本导出了对应的回显行常量，
 * 调用方以它们作回退判据——由此，比调用方更旧的安装器得到的是「能力缺失」的准确结论，
 * 而不是「未知参数」。新增面向调用方的参数时同步本清单与调用方的探测。
 */
export const CAPABILITIES = Object.freeze(['pnpm-from-host', 'reinstall-on-store-mismatch', 'pnpm-store']);

export const USAGE = [
  '用法：node scripts/init-enterprise-plugin.mjs --release <交付目录> --profile <desktop|web|auto|名称>',
  '        [--sha256 <hex>] [--dsh <path>] [--install-host] [--host-version <ver>]',
  '        [--dry-run] [--json]',
  '',
  '  --release <目录>   私版交付目录（须含 private-release.json 与同名 tgz）',
  '  --profile <名>     web、auto（已有 web 优先，都没有则创建 web），或自定义名（如 uat，',
  '                     缺失时从 shipped web 模板创建）；desktop 由 Desktop 应用独占，',
  '                     脚本会先探测宿主是否支持命令行核验，不支持就拒绝',
  '  --sha256 <hex>     调用方提供的摘要；脚本无法判断来源是否独立，交付包内启动器传入的',
  '                     是同一 tgz 的自算值（自证，只能发现损坏）',
  '  --dsh <path>       指定 dsh（原生可执行文件或 npm 的 .cmd/.bat shim）；缺省在 PATH 查找',
  '  --pnpm-from-host   --dsh 指向的宿主自带 pnpm（如企业版桌面壳）；不在 PATH 查找 pnpm，也不补装',
  '  --reinstall-on-store-mismatch',
  '                     pnpm 报 store 不一致（该 profile 的 node_modules 由另一个 pnpm 的 store 装入）',
  '                     时，清空 profiles/<名>/node_modules 后重试一次；只由拥有该 profile 的调用方',
  '                     传入（企业版桌面壳）。不带该参数时报 PROFILE_STORE_MISMATCH，不动 profile',
  '  --pnpm-store <目录> 拥有本次所用 pnpm 的调用方（企业版桌面壳）声明该 pnpm 解析出的 store',
  '                     目录（绝对路径）。安装器在执行任何包操作之前先与 profile 的 node_modules',
  '                     记录的 store 比对：不一致且已获修复授权时先清空 node_modules，未获授权时',
  '                     以 PROFILE_STORE_MISMATCH 停止且不改动 profile；未提供时保持失败后修复',
  '  --install-host     找不到 dsh 时用 npm 全局安装官方宿主（需要 npm 与网络）',
  '  --host-version <v> 安装宿主时锁定的版本；缺省 ' + DEFAULT_HOST_VERSION,
  '  --dry-run          只打印将执行的命令与核验点，不写入',
  '  --json             输出同一结论的结构化版本',
  '',
  '已装版本与交付版本不同时，脚本先执行 dsh plugin remove 卸载旧版本，再安装本次交付；',
  '同版本重跑保持零写入。卸载失败则不执行安装。',
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
    pnpmFromHost: false,
    reinstallOnStoreMismatch: false,
    pnpmStore: undefined,
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
    ['--pnpm-store', 'pnpmStore'],
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
    if (arg === '--pnpm-from-host') {
      options.pnpmFromHost = true;
      continue;
    }
    if (arg === '--reinstall-on-store-mismatch') {
      options.reinstallOnStoreMismatch = true;
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
    throw new InitError('BAD_ARGUMENT', 'init: 缺少 --profile <desktop|web|auto|名称>', '用 --profile auto 自动选择/创建 web profile，或显式指定 desktop、web 或自定义 profile 名（如 uat）。');
  }
  if (!isSupportedProfileName(options.profile)) {
    throw new InitError(
      'PROFILE_INVALID',
      `init: 不支持的 profile「${options.profile}」`,
      '只接受 desktop、web、auto，或形如 uat 的自定义 profile 名（小写字母开头，可含数字与连字符）。',
    );
  }
  if (!HOST_VERSION.test(options.hostVersion)) {
    throw new InitError('HOST_VERSION_INVALID', `init: --host-version 不是合法版本号「${options.hostVersion}」`, '传入纯版本号（形如 x.y.z-rc.1），不要带包名或路径。');
  }
  if (options.sha256 !== undefined) {
    if (!SHA256.test(options.sha256.toLowerCase())) {
      throw new InitError('DIGEST_INVALID', 'init: --sha256 不是 64 位十六进制摘要', '从可信渠道取得摘要后重跑；不要用制品同目录的自证摘要。');
    }
    options.sha256 = options.sha256.toLowerCase();
  }
  if (options.pnpmStore !== undefined && !isAbsolute(options.pnpmStore)) {
    throw new InitError('BAD_ARGUMENT', 'init: --pnpm-store 需要一个绝对目录', '调用方传入该 pnpm 解析出的绝对 store 目录后重跑。');
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
  // Prefer web: the official dsh CLI refuses to manage the Electron profile from
  // the command line ("profile \"desktop\" is managed exclusively by the
  // Electron application"), so auto-selecting desktop would only produce a late
  // failure.
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
    const reason = reasonTail(installed);
    throw new InitError(
      'PNPM_REQUIRED',
      `init: npm install -g pnpm 失败（退出码 ${installed.code}）${reason === '' ? '' : `：${reason}`}`,
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
 * sidecar 的摘要只是制作者自证；`--sha256` 可换成调用方提供的口径，但脚本无法判断
 * 该口径是否来自独立渠道（交付包内启动器传入的就是同一 tgz 的自算值）。
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
  const config = metadata?.config;
  const kinds = config?.embeddedSecrets;
  const validKinds = kinds === undefined || (Array.isArray(kinds)
    && (kinds.length === 0 || (kinds.length === 1 && kinds[0] === 'nacos.password')));
  const hasNacos = Array.isArray(kinds) && kinds.includes('nacos.password');
  // Older IAM deliveries declare only secretEmbedded; keep their bound-file flow.
  const hasClientSecret = config?.clientSecretEmbedded === true
    || (config?.clientSecretEmbedded === undefined && config?.secretEmbedded === true && kinds === undefined);
  const validClientFlag = config?.clientSecretEmbedded === undefined || typeof config.clientSecretEmbedded === 'boolean';
  if (!validKinds || !validClientFlag || typeof config?.secretEmbedded !== 'boolean'
    || config.secretEmbedded !== (hasNacos || hasClientSecret)
    || (hasNacos && (!Array.isArray(config.keys)
      || !['nacos.serverUrl', 'nacos.namespaceId', 'nacos.username', 'nacos.password'].every(key => config.keys.includes(key))))) {
    throw new InitError('SECRET_EMBEDDED', 'init: sidecar 的内嵌凭据声明不受支持，拒绝安装', '核对 Nacos 专用只读密码声明与 IAM 客户端密钥绑定文件，重新取得完整交付目录。');
  }
  const secret = hasClientSecret ? readEmbeddedClientSecret(dir) : null;
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
  return { dir, metadataPath, metadata, version, tarballName: tarball.name, tarballPath, sha256: digest, bytes, secret };
}

/**
 * 读取目标 profile 的 package.json；profile 是外部状态，只读不建。
 *
 * @returns {{name: string, dir: string, manifestPath: string, manifest: object, dshHome: string}}
 */

/**
 * 读取交付目录内嵌的客户端密钥与绑定描述。
 *
 * 只返回绑定信息与文件路径，密钥内容留在文件里，由预置步骤直接送进子进程 stdin。
 * 密钥文件已被删除时返回 `path: null`：那是成功预置后的正常状态，重跑安装脚本不能
 * 因此拒绝安装（窗口期只有一次）。
 *
 * @returns {{binding: object, path: string|null, bytes: Buffer|null}}
 */
export function readEmbeddedClientSecret(dir) {
  const bindingPath = join(dir, CLIENT_SECRET_BINDING_FILE);
  if (!existsSync(bindingPath)) {
    throw new InitError(
      'SECRET_BUNDLE_INCOMPLETE',
      `init: sidecar 声明内嵌客户端密钥，但交付目录缺少 ${CLIENT_SECRET_BINDING_FILE}`,
      '重新取得完整私版交付目录；不要只拷 tgz，也不要手工删除绑定文件。',
    );
  }
  let binding;
  try {
    binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  } catch {
    throw new InitError('SECRET_BUNDLE_INCOMPLETE', `init: ${CLIENT_SECRET_BINDING_FILE} 不是合法 JSON`, '重新取得完整私版交付目录。');
  }
  const invalid = (message) => new InitError('SECRET_BUNDLE_INCOMPLETE', `init: ${CLIENT_SECRET_BINDING_FILE} ${message}`, '重新取得完整私版交付目录；不要手写或修改绑定文件。');
  if (binding?.schema !== CLIENT_SECRET_SCHEMA) throw invalid(`schema 不是 ${CLIENT_SECRET_SCHEMA}`);
  const file = binding?.file;
  if (typeof file !== 'string' || file === '' || basename(file) !== file) throw invalid('的 file 不是简单文件名');
  if (!SHA256.test(String(binding?.sha256 ?? ''))) throw invalid('的 sha256 不是 64 位十六进制摘要');
  if (typeof binding?.clientId !== 'string' || binding.clientId === '') throw invalid('缺少 clientId');
  if (!['client_secret_basic', 'client_secret_post'].includes(binding?.clientAuthMethod)) throw invalid('的 clientAuthMethod 不是 client_secret_basic|client_secret_post');
  if (typeof binding?.clientSecretRef !== 'string' || binding.clientSecretRef === '') throw invalid('缺少 clientSecretRef');
  if (typeof binding?.discoveryUrl !== 'string' && typeof binding?.issuer !== 'string') throw invalid('既没有 discoveryUrl 也没有 issuer');
  // 换 IAM 环境时，同一 ref 在旧交付里可能绑定过别的 issuer；制包人知道旧值，就写进绑定文件，
  // 安装器在遇到绑定冲突时用它做 client-secret replace。只接受 http(s)、不带用户信息的 URL。
  const previousIssuers = binding?.previousIssuers;
  if (previousIssuers !== undefined) {
    const wellFormed = Array.isArray(previousIssuers) && previousIssuers.every((entry) => {
      if (typeof entry !== 'string' || !canParseUrl(entry)) return false;
      const parsed = new URL(entry);
      return ['https:', 'http:'].includes(parsed.protocol) && parsed.username === '' && parsed.password === '';
    });
    if (!wellFormed) throw invalid('的 previousIssuers 不是 http(s) URL 数组');
  }
  const path = join(dir, file);
  if (!existsSync(path)) return { binding, path: null, bytes: null };
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw invalid(`指向的 ${file} 是空文件`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== binding.sha256) {
    throw new InitError(
      'SECRET_BUNDLE_MISMATCH',
      `init: ${file} 摘要与 ${CLIENT_SECRET_BINDING_FILE} 记录不一致`,
      '制品在传输中被改动或损坏；重新取得交付目录，不要手工替换密钥文件。',
    );
  }
  return { binding, path, bytes };
}

/** 从 Discovery 文档取 issuer，并核对 IAM 登记的 token 端点认证方式。 */
async function resolveSecretIssuer(binding, fetchImpl) {
  if (typeof binding.discoveryUrl !== 'string' || binding.discoveryUrl === '') {
    return binding.issuer;
  }
  let response;
  try {
    response = await fetchImpl(binding.discoveryUrl, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'follow' });
  } catch (error) {
    throw new InitError(
      'IAM_DISCOVERY_FAILED',
      `init: 读取 IAM Discovery 失败（${error?.message ?? 'UNKNOWN'}）：${binding.discoveryUrl}`,
      '确认这台机器能访问企业 IAM 后重跑本脚本；密钥文件仍保留在交付目录，重跑会重新预置。',
    );
  }
  if (!response.ok) {
    throw new InitError(
      'IAM_DISCOVERY_FAILED',
      `init: IAM Discovery 返回 HTTP ${response.status}：${binding.discoveryUrl}`,
      '确认 Discovery 地址与网络策略后重跑本脚本；密钥文件仍保留。',
    );
  }
  let document;
  try {
    document = await response.json();
  } catch {
    throw new InitError('IAM_DISCOVERY_INVALID', 'init: IAM Discovery 不是合法 JSON', '确认 Discovery 地址指向 openid-configuration 文档。');
  }
  const issuer = document?.issuer;
  if (typeof issuer !== 'string' || issuer.trim() === '') {
    throw new InitError('IAM_DISCOVERY_INVALID', 'init: IAM Discovery 文档缺少 issuer', '确认 IAM 的 Discovery 文档完整后重跑。');
  }
  const methods = document?.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && !methods.includes(binding.clientAuthMethod)) {
    throw new InitError(
      'IAM_CLIENT_AUTH_METHOD_UNSUPPORTED',
      `init: IAM 登记的 token 端点认证方式不含 ${binding.clientAuthMethod}（${methods.join(', ')}）`,
      '与管理员的 IAM 客户端登记对齐（本包 authMethod 与 IAM 登记必须逐字一致），或重新制作交付包。',
    );
  }
  return issuer.trim();
}

/**
 * 本机凭据库目录。规则与 `@heluo/forge-credentials-keychain` 的
 * `selectDefaultStoreDirectory` 一致；安装器单文件自包含、不 import 仓库模块，故在此复刻，
 * 两处规则必须一起改。
 */
export function credentialStoreDirectory({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'HeluoForge');
  if (platform === 'win32') {
    const local = env?.LOCALAPPDATA;
    const usable = typeof local === 'string' && local !== '' && isAbsolute(local) && parse(local).root.length > 1;
    return join(usable ? local : join(home, 'AppData', 'Local'), 'HeluoForge');
  }
  const previous = join(home, '.local', 'share', 'HeluoForge');
  const xdg = env?.XDG_DATA_HOME;
  return platform === 'linux' && typeof xdg === 'string' && isAbsolute(xdg) ? join(xdg, 'HeluoForge') : previous;
}

/** 预检目录能建、能写、能删；只写空探针文件，不碰密钥内容。 */
export function probeStoreDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const probe = join(directory, `.heluo-write-probe-${process.pid}`);
  writeFileSync(probe, '', { mode: 0o600 });
  unlinkSync(probe);
  return directory;
}

/**
 * 校验并修正凭据目录权限，再预检可写。
 *
 * 凭据库要求数据目录与 `<dir>.keys` 都是 0700 且属主是当前用户；不满足时库抛
 * `CRED_STORE_PERMISSIONS`，而 CLI 只把它折叠成一句「无法预置密钥」，退出码 4，
 * 安装器看不到真实原因。目录属主正确、只是模式偏宽时就地收紧到 0700（只收紧，不放松）；
 * 属主不对（sudo 或别的账号建的）不擅自 chown，直接报可执行的修复路径。
 */
export function ensureStoreDirectory(directory, { lines = [], platform = process.platform } = {}) {
  // 数据目录与 `<dir>.keys` 必须成对：凭据库遇到只有一半的存储会抛
  // CRED_STORE_UNAVAILABLE（orphaned keyring exists），CLI 再把它折叠成通用失败。
  const keyDirectory = `${directory}.keys`;
  const keyring = join(keyDirectory, 'keyring.json');
  const database = join(directory, 'credentials.sqlite');
  if ((existsSync(keyring) && !existsSync(directory)) || (existsSync(database) && !existsSync(keyring))) {
    throw new InitError(
      'IAM_SECRET_STORE_ORPHANED',
      `init: 凭据库只剩一半（${existsSync(keyring) ? `有 ${keyDirectory}，缺 ${directory}` : `有 ${database}，缺 ${keyring}`}）`,
      '多为备份/迁移只拷了其中一个目录，或手工删过。能还原就把缺的一半还原，否则把两个目录一起移走（备份后 mv）再重跑；密钥文件保留在交付目录。',
    );
  }
  for (const target of [directory, keyDirectory]) {
    if (!existsSync(target)) continue;
    const info = statSync(target);
    if (!info.isDirectory()) {
      throw new InitError(
        'IAM_SECRET_STORE_UNWRITABLE',
        `init: 凭据目录位置被非目录占用（${target}）`,
        '备份并移走该文件后重跑本脚本。密钥文件保留在交付目录。',
      );
    }
    if (platform === 'win32' || typeof process.getuid !== 'function') continue;
    if (info.uid !== process.getuid()) {
      throw new InitError(
        'IAM_SECRET_STORE_FOREIGN_OWNER',
        `init: 凭据目录不属于当前用户（${target}，owner uid ${info.uid}）`,
        '该目录多半是 sudo 或别的账号创建的。不要用 sudo 运行本脚本；把目录改回当前用户所有后重跑。密钥文件保留在交付目录。',
      );
    }
    const mode = info.mode & 0o777;
    if (mode !== 0o700) {
      chmodSync(target, 0o700);
      lines.push(`IAM 客户端密钥：凭据目录 ${target} 权限 ${mode.toString(8).padStart(3, '0')} 已修正为 700`);
    }
  }
  return probeStoreDirectory(directory);
}

/**
 * 用全新临时目录重跑同一条预置命令，用来区分「本机存储坏了」和「CLI 本身跑不通」。
 * 只写临时目录、随即删除，不碰既有凭据库。
 */
async function diagnoseProvision({ scriptExec, args, bytes }) {
  const scratch = mkdtempSync(join(tmpdir(), 'heluo-secret-probe-'));
  try {
    const result = await scriptExec(args, {
      timeout: PROVISION_TIMEOUT_MS,
      shell: false,
      input: bytes,
      env: { ...process.env, HELUO_FORGE_STORE_DIRECTORY: scratch },
    });
    if (typeof result?.code !== 'number') return { ok: false, reason: '子进程没有返回退出码' };
    return { ok: result.code === 0, reason: result.code === 0 ? '' : reasonTail(result) };
  } catch (error) {
    return { ok: false, reason: typeof error?.code === 'string' ? error.code : (error?.message ?? 'UNKNOWN') };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** URL.canParse 在旧 Node 上不存在时的等价判断。 */
function canParseUrl(value) {
  return typeof URL.canParse === 'function' ? URL.canParse(value) : (() => { try { new URL(value); return true; } catch { return false; } })();
}

/**
 * 同一 ref 已绑定别的 issuer 时，用 client-secret replace 更正绑定。
 *
 * 凭据库的规则是「同一 ref 的 (issuer, clientId, method) 必须逐字一致」，换环境后 set 必然
 * 被拒（IAM_CLIENT_SECRET_BINDING_MISMATCH），而 CLI 把它折叠成退出码 4，安装器看不到真因。
 * 保留的 scope 也读不回来（通用读取被 CRED_STORE_INVALID 拒绝），所以只能由制包人把旧
 * issuer 写进 client-secret.json，安装器逐个候选值试 replace；错的候选会被库拒绝，不会误改。
 */
async function rebindClientSecret({ scriptExec, cli, store, secret, issuer, lines }) {
  const candidates = Array.isArray(secret.binding.previousIssuers) ? secret.binding.previousIssuers : [];
  const attempted = [];
  for (const previous of candidates) {
    const args = [
      cli, 'client-secret', 'replace',
      '--issuer', issuer,
      '--client-id', secret.binding.clientId,
      '--method', secret.binding.clientAuthMethod,
      '--ref', secret.binding.clientSecretRef,
      '--old-issuer', previous,
      '--old-client-id', secret.binding.clientId,
      '--old-method', secret.binding.clientAuthMethod,
    ];
    let result;
    try {
      result = await scriptExec(args, {
        timeout: PROVISION_TIMEOUT_MS,
        shell: false,
        input: secret.bytes,
        env: { ...process.env, HELUO_FORGE_STORE_DIRECTORY: store },
      });
    } catch (error) {
      attempted.push(`${previous} → ${error?.code ?? error?.message ?? 'UNKNOWN'}`);
      continue;
    }
    if (result?.code === 0) {
      lines.push(`IAM 客户端密钥：引用「${secret.binding.clientSecretRef}」原先绑定 ${previous}，已更正为 ${issuer}（旧记录被 replace 覆盖）`);
      return { ok: true, previous };
    }
    attempted.push(`${previous} → ${reasonTail(result)}`);
  }
  return { ok: false, attempted };
}

/**
 * 把交付目录内嵌的客户端密钥写入本机 Host 凭据库。
 *
 * 成功后删除交付目录里的密钥文件；失败保留并抛错——宁可安装报失败，也不要留下
 * “插件装好了但登录不了”的假成功。
 *
 * 预置密钥的三条命令（set、replace、空目录诊断）都不经 dsh：它们以当前 Node 直接运行
 * 已安装插件自带的 CLI（`args[0]` 即脚本路径）。终端形态下缺省就用同一 `exec` 运行
 * `process.execPath`，行为与引入本参数之前逐字一致；桌面壳传入自己的执行器
 * （应用二进制以 Node 运行该脚本），否则它的执行器会把 dsh 入口加在脚本路径前面。
 *
 * @param {{scriptExec?: Function, exec?: Function, profile: object, release: object, lines: string[], fetchImpl?: Function, storeDirectory?: string}} input
 * @returns {Promise<{status: 'provisioned'|'already-removed'|'absent'}>}
 */
export async function provisionClientSecret({ scriptExec, exec, profile, release, lines, fetchImpl = fetch, storeDirectory }) {
  if (scriptExec !== undefined && typeof scriptExec !== 'function') {
    throw new InitError(
      'BAD_ARGUMENT',
      'init: scriptExec 须为 (args, options) => Promise 的函数',
      '终端使用不需要它；桌面壳传入运行插件 CLI 的执行器。',
    );
  }
  const runScript = scriptExec ?? ((args, options) => exec(process.execPath, args, options));
  const secret = release.secret;
  if (secret === null) return { status: 'absent' };
  if (secret.path === null) {
    lines.push('IAM 客户端密钥：交付目录内已无密钥文件，跳过预置（视为已预置；若登录报 IAM_CLIENT_AUTH_UNVERIFIED，请管理员重新下发密钥）。');
    return { status: 'already-removed' };
  }
  const issuer = await resolveSecretIssuer(secret.binding, fetchImpl);
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  if (!existsSync(cli)) {
    throw new InitError(
      'IAM_CLIENT_SECRET_CLI_MISSING',
      `init: 已安装的插件里找不到凭据运维入口（${relative(profile.dir, cli)}）`,
      '确认安装的是完整的企业私版（含 forge-iam）；密钥文件保留在交付目录，修复后重跑。',
    );
  }
  const override = typeof process.env.HELUO_FORGE_STORE_DIRECTORY === 'string' && process.env.HELUO_FORGE_STORE_DIRECTORY !== ''
    ? process.env.HELUO_FORGE_STORE_DIRECTORY
    : null;
  const store = storeDirectory ?? (override === null ? credentialStoreDirectory() : resolve(override));
  try {
    ensureStoreDirectory(store, { lines });
  } catch (error) {
    if (error instanceof InitError) throw error;
    throw new InitError(
      'IAM_SECRET_STORE_UNWRITABLE',
      `init: 凭据目录不可用（${store}）：${error?.code ?? error?.message ?? 'UNKNOWN'}`,
      '检查该目录的所有者与权限；不要用 sudo 运行本脚本——sudo 会把记录写进 root 家目录，员工登录时读不到。修复后重跑本脚本。',
    );
  }
  const args = [
    cli, 'client-secret', 'set',
    '--issuer', issuer,
    '--client-id', secret.binding.clientId,
    '--method', secret.binding.clientAuthMethod,
    '--ref', secret.binding.clientSecretRef,
  ];
  let result;
  try {
    result = await runScript(args, {
      timeout: PROVISION_TIMEOUT_MS,
      shell: false,
      input: secret.bytes,
      env: { ...process.env, HELUO_FORGE_STORE_DIRECTORY: store },
    });
  } catch (error) {
    throw new InitError(
      'IAM_CLIENT_SECRET_PROVISION_FAILED',
      `init: 写入本机凭据库失败（${error?.code ?? error?.message ?? 'UNKNOWN'}）`,
      '密钥文件仍保留在交付目录；按提示修复后重跑本脚本即可重新预置。',
    );
  }
  let reboundFrom;
  if (typeof result?.code === 'number' && result.code !== 0) {
    const reason = reasonTail(result);
    const rebound = await rebindClientSecret({ scriptExec: runScript, cli, store, secret, issuer, lines });
    if (rebound.ok) reboundFrom = rebound.previous;
    if (!rebound.ok) {
      if (rebound.attempted.length > 0) {
        throw new InitError(
          'IAM_CLIENT_SECRET_BINDING_CONFLICT',
          `init: 引用「${secret.binding.clientSecretRef}」在本机凭据库里已绑定另一套 IAM 客户端配置，且候选旧 issuer 都没能更正（${rebound.attempted.join('；')}）`,
          `本包声明的 issuer 是 ${issuer}，clientId ${secret.binding.clientId}，method ${secret.binding.clientAuthMethod}。若旧绑定来自历史交付，用 client-secret replace --old-issuer <旧 issuer> --old-client-id ${secret.binding.clientId} --old-method ${secret.binding.clientAuthMethod} 手工更正，或在制包时加 --previous-issuer <旧 issuer> 重出；密钥文件保留在交付目录。`,
        );
      }
      const diagnostic = await diagnoseProvision({ scriptExec: runScript, args, bytes: secret.bytes });
      if (diagnostic.ok) {
        throw new InitError(
          'IAM_SECRET_STORE_UNHEALTHY',
          `init: 本机凭据存储不可用（${store}）：同一命令在全新临时目录下可以写入，说明问题在既有存储——目录所有者/权限、磁盘空间，或「${secret.binding.clientSecretRef}」已绑定过另一套客户端配置${reason === '' ? '' : `（CLI 原始报错：${reason}）`}`,
          '若确认是历史绑定，制包时加 --previous-issuer <旧 issuer> 重出，或在目标机用 client-secret replace --old-issuer/--old-client-id/--old-method 更正；否则备份并移走该目录（或检查其权限）后重跑。密钥文件保留在交付目录。',
        );
      }
      throw new InitError(
        'IAM_CLIENT_SECRET_PROVISION_FAILED',
        `init: 写入本机凭据库失败（退出码 ${result.code}）${reason === '' ? '' : `：${reason}`}${diagnostic.reason === '' ? '' : `；空目录诊断同样失败（${diagnostic.reason}）`}`,
        '密钥文件仍保留在交付目录；修复凭据存储（磁盘空间、权限、keyring）后重跑本脚本，或用交付目录 INSTALL.md 里的手工命令预置。',
      );
    }
  }
  rmSync(secret.path, { force: true });
  lines.push(`IAM 客户端密钥：已写入本机凭据库（issuer ${issuer}，引用 ${secret.binding.clientSecretRef}），交付目录内密钥文件已删除`);
  return reboundFrom === undefined ? { status: 'provisioned' } : { status: 'provisioned', reboundFrom };
  return { status: 'provisioned' };
}

export function inspectProfile({ profile, env = {}, home = homedir() }) {
  if (profile === 'auto' || !isSupportedProfileName(profile)) {
    throw new InitError(
      'PROFILE_INVALID',
      `init: 不支持的 profile「${profile}」`,
      '只接受 desktop、web 或已创建的自定义 profile 名（如 uat）；desktop 只能由 Desktop 应用创建。',
    );
  }
  const dshHome = dshHomeOf(env, home);
  const dir = join(dshHome, 'profiles', profile);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    const next = profile === 'desktop'
      ? '先启动一次官方 DeepSeek Harness Desktop 完成 profile 初始化并完全退出，再重跑本脚本。'
      : `先运行 dsh --profile ${profile} --dump-config 初始化该 profile（自定义名可加 --from-default-profile web），再重跑本脚本。`;
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

/** 安装时刻留存的制品证据文件名；只放在 profile 目录下，不进 profile 清单。 */
export const INSTALL_RECORD_FILE = '.heluo-enterprise-install.json';

const installedPackageDir = (profile) => join(profile.dir, 'node_modules', ...ENTRY_PACKAGE.split('/'));

/**
 * 已安装包目录的内容摘要：按相对路径排序后逐文件喂入「路径 + 字节」。
 * 符号链接只喂链接目标文本（不跟随），避免跟随到目录外或漏算被替换的链接。
 * 只用于判断"安装后有没有被改动"，同一份内容必得同一摘要。
 */
function installedTreeSha256(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) entries.push({ path, kind: 'file' });
      else if (entry.isSymbolicLink()) entries.push({ path, kind: 'link' });
      else entries.push({ path, kind: 'other' });
    }
  };
  walk(dir);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const { path, kind } of entries) {
    hash.update(`${kind}\0${relative(dir, path).split(sep).join('/')}\0`);
    hash.update(kind === 'link' ? readlinkSync(path) : readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const installRecordPath = (profile) => join(profile.dir, INSTALL_RECORD_FILE);

/** 读取安装时刻证据；缺失、损坏或不是本插件的记录一律当作"没有证据"。 */
function readInstallRecord(profile) {
  const path = installRecordPath(profile);
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (record === null || typeof record !== 'object') return null;
  if (record.package !== ENTRY_PACKAGE) return null;
  if (typeof record.version !== 'string') return null;
  if (typeof record.tarballSha256 !== 'string' || typeof record.installedTreeSha256 !== 'string') return null;
  return record;
}

/**
 * 安装成功后写证据：记下"这次装进去的是哪份 tgz、装完的目录内容是什么"。
 * 下次同版本重跑据此判断已安装的是不是同一制品；写不了就返回 null（下次只能报无法确认）。
 */
function writeInstallRecord(profile, release) {
  const dir = installedPackageDir(profile);
  if (!existsSync(dir)) return null;
  let tree;
  try {
    tree = installedTreeSha256(dir);
  } catch {
    return null;
  }
  const record = {
    schema: 1,
    package: ENTRY_PACKAGE,
    version: release.version,
    tarballName: release.tarballName,
    tarballSha256: release.sha256,
    installedTreeSha256: tree,
    installedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(installRecordPath(profile), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch {
    return null;
  }
  return record;
}

/**
 * 判断"已安装的就是这份交付"。
 *
 * 判据是**安装时刻留存的证据 + 已安装文件本身**，而不是 profile 里 `file:` 路径上
 * 当前的文件：管理员把新交付物放到同一路径、版本号不变时，旧包仍装在 node_modules
 * 里，按路径当前内容比对会把旧安装误判成新交付。
 *
 * 依次核对：证据存在且版本相同 → 证据里的 tgz 摘要等于本次交付（不等即冲突）→
 * 已安装目录内容摘要等于证据记录（安装后被改动则无法确认）。任一环节拿不到可信
 * 证据都返回 unconfirmed，不把版本相同当作制品一致。摘要本身来自交付包（自证），
 * 只能证明字节一致，不证明来源。
 *
 * @returns {{identity: 'confirmed'|'conflict'|'unconfirmed', detail: string}}
 */
function artifactIdentityOf(profile, release) {
  const dir = installedPackageDir(profile);
  if (!existsSync(dir)) {
    return { identity: 'unconfirmed', detail: `profile 的 node_modules 里没有已安装的企业插件目录（${dir}），无法核对已安装内容` };
  }
  const record = readInstallRecord(profile);
  if (record === null) {
    return {
      identity: 'unconfirmed',
      detail: `profile 里没有安装时刻的制品证据（profiles/${profile.name}/${INSTALL_RECORD_FILE} 缺失或不可读；可能由宿主 CLI 或旧版脚本安装），无法证明已安装内容与本次交付一致`,
    };
  }
  if (record.version !== release.version) {
    return { identity: 'unconfirmed', detail: `安装时刻记录的版本为 ${record.version}，与交付版本 ${release.version} 不同，无法核对` };
  }
  if (record.tarballSha256 !== release.sha256) {
    return {
      identity: 'conflict',
      detail: `安装时刻记录的制品摘要（${record.tarballSha256}）与本次交付（${release.sha256}）不一致；同一路径上的文件可能已被替换`,
    };
  }
  let tree;
  try {
    tree = installedTreeSha256(dir);
  } catch {
    return { identity: 'unconfirmed', detail: `读取已安装包内容失败（${dir}），无法核对` };
  }
  if (tree !== record.installedTreeSha256) {
    return { identity: 'unconfirmed', detail: `已安装包内容与安装时刻记录不一致（${dir}），安装后被改动或损坏，无法核对` };
  }
  return { identity: 'confirmed', detail: `安装时刻记录与已安装内容一致（tgz 摘要 ${record.tarballSha256.slice(0, 12)}…，${dir}）` };
}

/** 启动提示按 profile 分开写：默认安装写入 web profile，Desktop 是另一个 profile。 */
function nextStepLine(profileName) {
  return profileName === 'desktop'
    ? `下一步：在 Desktop 应用的「设置 → 插件」确认 ${ENTRY_PACKAGE} 已加载（desktop profile 由应用独占，命令行不再改动它）。`
    : (() => {
      const start = profileName === 'web' ? 'dsh web' : `dsh --profile ${profileName}`;
      return `下一步：在终端运行 ${start}（换端口用 --port <端口>），打开它打印的本机地址，在「设置 → 插件」确认 ${ENTRY_PACKAGE} 已加载（Desktop 是另一个 profile，打开它不会看到本次安装）。`;
    })();
}

function defaultExec() {
  return (bin, args, options) => {
    const { input, ...rest } = options ?? {};
    // 需要往子进程 stdin 送数据（预置客户端密钥时）只能走 spawn：execFile 不提供 stdin。
    if (input === undefined) {
      return new Promise((settle) => {
        execFile(bin, args, { ...rest, shell: false }, (error, stdout, stderr) => {
          settle({
            code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          });
        });
      });
    }
    return new Promise((settle) => {
      const child = spawn(bin, args, { ...rest, shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        settle({ code: 1, stdout, stderr: `${stderr}${error?.message ?? ''}` });
      });
      child.on('close', (code) => {
        settle({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  };
}

const resolveExec = (exec) => (typeof exec === 'function' ? exec : defaultExec());

async function runStep(exec, launch, args, timeout, failureCode, { env, input } = {}) {
  let result;
  try {
    result = await exec(launch.bin, [...launch.prefix, ...args], {
      timeout,
      shell: false,
      ...(env === undefined ? {} : { env }),
      ...(input === undefined ? {} : { input }),
    });
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
 * 只说明「代码走到哪儿」的行：调用栈的一帧、源码位置、源码下方的插入符，或 Node 的版本尾注。
 * 进程因未捕获异常退出时，这些行占满输出末尾，真正的报错行排在它们前面。
 */
const WHERE_LINE = /^(?:at\s.*:\d+(?::\d+)?\)?|file:\/\/\S+:\d+(?::\d+)?|\^+|Node\.js v\d.*)$/u;

/** 一行最多带走的字数。各行分别截断，末尾的报错行不会被前面较长的行挤掉。 */
const REASON_LINE_LIMIT = 160;

/**
 * 取子进程输出的最后几行有效文本。宿主自己知道失败原因（如 `'pnpm' is not
 * recognized`），只回退出码会让员工和排障者都看不出根因，这里把它带回结论里。
 * 只说明代码位置的行不算有效文本。
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {string} 单行摘要；无输出时为空串
 */
export function reasonTail(result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !WHERE_LINE.test(line));
  return lines
    .slice(-3)
    .map((line) => (line.length > REASON_LINE_LIMIT ? `${line.slice(0, REASON_LINE_LIMIT - 1)}…` : line))
    .join(' / ');
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

/**
 * 用官方宿主的 `--dump-config` 创建 profile 模板；不启动服务。
 *
 * `web` 由宿主直接初始化；自定义名（如 `uat`）从 shipped 的 web 模板复制，
 * 因为宿主只为 shipped 名字准备模板，自定义名必须显式给出 `--from-default-profile`。
 */
async function createProfile({ exec, launch, name, lines }) {
  const args = name === 'web'
    ? ['--profile', 'web', '--dump-config']
    : ['--profile', name, '--from-default-profile', 'web', '--dump-config'];
  const result = await runStep(exec, launch, args, VERIFY_TIMEOUT_MS, 'PROFILE_CREATE_FAILED');
  if (result.code !== 0) {
    throw new InitError(
      'PROFILE_CREATE_FAILED',
      `init: 创建 profile「${name}」失败（dsh --dump-config 退出码 ${result.code}）`,
      '确认宿主安装完整、DSH_HOME 可写后重跑；脚本不会覆盖已有 profile。',
    );
  }
  lines.push(`profile：已用官方宿主创建 ${name} 模板（--dump-config，未启动服务）`);
}

/**
 * 显式 desktop 在**写入前**先探测宿主是否支持 `--profile desktop --dump-config`。
 *
 * desktop profile 由 Electron 应用独占：npm 版宿主拒绝任何 `--profile desktop` 调用，
 * Desktop 自带 CLI 允许 `plugin add` 却拒绝 `--dump-config`。两种情况都会让安装写完之后
 * 的核验必然失败、重跑也过不去（留下"已安装却报失败"的状态）。探测失败就拒绝，不写入。
 */
async function assertDesktopVerifiable({ exec, launch, profile, lines }) {
  const result = await runStep(exec, launch, ['--profile', profile.name, '--dump-config'], VERIFY_TIMEOUT_MS, 'DESKTOP_PROFILE_UNSUPPORTED');
  if (result.code !== 0) {
    const reason = reasonTail(result);
    throw new InitError(
      'DESKTOP_PROFILE_UNSUPPORTED',
      `init: 当前宿主不支持命令行核验 desktop profile（dsh --profile desktop --dump-config 退出码 ${result.code}${reason === '' ? '' : `：${reason}`}），已停止且未写入 profile`,
      '在 Desktop 应用的插件设置中安装企业插件；或改用默认的 web 形态（--profile web 或 auto），装好后在终端运行 dsh web。',
    );
  }
  lines.push('profile：宿主支持 desktop 的 --dump-config，继续安装（挂载仍需在应用内确认）');
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
 * 子进程输出里的 pnpm 错误码（如 `ERR_PNPM_UNEXPECTED_STORE`），没有则为 null。
 * 宿主把 pnpm 的两个输出流原样转出；错误码在输出的前部，而结论只带得出末尾几行，
 * 所以单独取一次：只看末尾，员工看到的是「换一个 store 或重装依赖」这类通用提示，
 * 看不出是哪一个 profile、哪一份 node_modules 出的问题。
 *
 * @param {{stdout?: string, stderr?: string}} result
 * @returns {string|null}
 */
export function pnpmErrorCode(result) {
  const match = /\bERR_PNPM_[A-Z0-9_]+\b/u.exec(`${result?.stderr ?? ''}\n${result?.stdout ?? ''}`);
  return match === null ? null : match[0];
}

/**
 * `profiles/<p>/node_modules/.modules.yaml` 里记录的 store 目录：pnpm 链接这份 node_modules
 * 时所用的 store。文件名是 YAML，现行 pnpm（11、12）写入的是 JSON；也兼容逐行
 * `storeDir: …` 的写法。读不出返回 null，结论里就不带它。
 *
 * @param {string} profileDir
 * @returns {string|null}
 */
export function recordedStoreDirectory(profileDir) {
  let text;
  try {
    text = readFileSync(join(profileDir, 'node_modules', '.modules.yaml'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.storeDir === 'string' && parsed.storeDir !== '') return parsed.storeDir;
  } catch {
    // 不是 JSON：按逐行的写法读。
  }
  const match = /^\s*storeDir\s*:\s*(\S.*?)\s*$/mu.exec(text);
  return match === null ? null : match[1].replace(/^"(.*)"$/u, '$1');
}

/**
 * 归一化 store 目录供比对：解析为绝对路径，存在时以真实路径（跟随符号链接）为准，
 * Windows 上大小写不敏感。读不出（非字符串或空白）返回 null。
 *
 * @param {string} value 调用方声明或 profile 记录的 store 目录
 * @returns {string|null}
 */
export function normalizedStoreDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  let resolved;
  try {
    resolved = realpathSync(trimmed);
  } catch {
    resolved = resolve(trimmed);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * store 预检（只读）：把调用方以 `--pnpm-store` 声明的、本次将用的 store，与 profile 的
 * node_modules 记录的 store 比对。调用方没有声明（或值不可用）时返回 null；否则返回：
 *   - `consistent`：一致，无需处理；
 *   - `absent`：profile 未记录 store（全新或已清空）；
 *   - `mismatch`：不一致——预检的全部价值：让处理发生在任何包操作之前。
 * 误报只会让已授权的清空提前发生（与反应式自愈同一个动作）；漏报则回落到反应式自愈。
 *
 * @param {{dir: string, name: string}} profile
 * @param {{pnpmStore?: string}} [options]
 * @returns {{verdict: 'consistent'|'absent'|'mismatch', provided: string, providedLabel: string, recorded?: string}|null}
 */
export function storePreflight(profile, options = {}) {
  if (typeof options?.pnpmStore !== 'string' || options.pnpmStore.trim() === '') return null;
  const providedLabel = options.pnpmStore.trim();
  const provided = normalizedStoreDirectory(providedLabel);
  if (provided === null) return null;
  const recorded = recordedStoreDirectory(profile.dir);
  if (recorded === null) return { verdict: 'absent', provided, providedLabel };
  const recordedKey = normalizedStoreDirectory(recorded) ?? recorded;
  return { verdict: recordedKey === provided ? 'consistent' : 'mismatch', provided, providedLabel, recorded };
}

/** 清空 node_modules 失败时的结论：多半是文件被进程占用，退出后重跑会再清一次。 */
function resetFailure(error, path) {
  return new InitError(
    'PROFILE_RESET_FAILED',
    `init: 无法清空 ${path}（${error?.code ?? error?.message ?? 'UNKNOWN'}）`,
    '退出占用该 profile 的 DSH 进程（含托盘或后台驻留的）后重跑，重跑会再清一次，删到一半不影响；仍失败时请管理员处理该目录。',
  );
}

/**
 * 逐项删除目录里的内容，再由调用方删目录本身。链接只删链接本身，不进入它的目标：
 * pnpm 布局里的链接可以指向 profile 之外，而上游 `apps/desktop` 注明 Electron 的递归删除
 * 在 Windows 上会跟进目录联接，所以这里不使用递归删除。
 */
function removeTree(directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw resetFailure(error, directory);
  }
  for (const name of entries) {
    const path = join(directory, name);
    let stats;
    try {
      stats = lstatSync(path);
      if (stats.isSymbolicLink()) unlinkSync(path);
      else if (stats.isDirectory()) {
        removeTree(path);
        rmdirSync(path);
      } else unlinkSync(path);
    } catch (error) {
      // 里层已经说明过原因的结论原样上抛，不再包一层。
      if (error instanceof InitError) throw error;
      throw resetFailure(error, path);
    }
  }
}

/**
 * 清空目标 profile 的 `node_modules`：pnpm 的链接产物，可由 profile 的清单与锁文件重建。
 * 只动这一个目录，且只由包操作步骤在调用方声明拥有该 profile
 * （`--reinstall-on-store-mismatch`）、pnpm 又报 store 不一致时调用。
 *
 * `node_modules` 本身是链接（符号链接或目录联接）或不是目录时不动它：那不是 pnpm 留下的
 * 普通目录，链接背后可能是别处的东西。
 *
 * @param {string} profileDir
 * @returns {'absent' | 'removed'}
 * @throws {InitError} PROFILE_RESET_FAILED
 */
export function resetProfileNodeModules(profileDir) {
  const target = join(profileDir, 'node_modules');
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw resetFailure(error, target);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new InitError(
      'PROFILE_RESET_FAILED',
      'init: node_modules 是链接或不是目录，未清空',
      '该 profile 的 node_modules 不是 pnpm 留下的普通目录；请管理员确认它指向什么后再处理。',
    );
  }
  removeTree(target);
  return 'removed';
}

/**
 * 执行一次初始化。
 *
 * 返回 `{ code, lines, warnings, result }`：`lines` 是要打到 stdout 的逐行回显，`result`
 * 是 `--json` 的结构化版本（与回显同一结论）。`code` 0 = 安装/已安装/演练完成，1 = 任何
 * fail-closed 或核验失败。
 *
 * @param {{argv?: string[], env?: object, home?: string, exec?: Function|null, scriptExec?: Function, fetchImpl?: Function}} [input]
 *   `scriptExec` 是运行已安装插件自带 CLI 的执行器（`args[0]` 为脚本路径）：桌面壳传入
 *   （应用二进制以 Node 运行该脚本），终端形态缺省时等价于用 `exec` 运行 `process.execPath`。
 */
export async function runInit({ argv = [], env = process.env, home = homedir(), exec = null, scriptExec, fetchImpl = fetch } = {}) {
  const lines = [];
  const warnings = [];
  const requestedJson = argv.includes('--json');
  try {
    if (scriptExec !== undefined && typeof scriptExec !== 'function') {
      throw new InitError(
        'BAD_ARGUMENT',
        'init: scriptExec 须为 (args, options) => Promise 的函数',
        '终端使用不需要它；桌面壳传入运行插件 CLI 的执行器。',
      );
    }
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
      await createProfile({ exec: resolveExec(exec), launch, name: profileName, lines });
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
      digestSource === '--sha256'
        ? `摘要：${release.sha256}（来源：--sha256 由调用方提供；本脚本无法判断它是否来自独立渠道，交付包内启动器传入的是同一 tgz 的自算值，属自证，只能证明未损坏）`
        : `摘要：${release.sha256}（来源：private-release.json，自证；需要独立口径时请另行核对摘要）`,
    );

    const installed = installedVersionOf(profile);
    const declared = profile.manifest?.dependencies?.[ENTRY_PACKAGE] !== undefined;
    if (plannedHostInstall) {
      lines.push(`dry-run：未找到 dsh，将执行 npm install -g ${HOST_PACKAGE}@${options.hostVersion}`);
    }
    if (plannedProfileCreate) {
      const createArgv = profile.name === 'web'
        ? `--profile web --dump-config`
        : `--profile ${profile.name} --from-default-profile web --dump-config`;
      lines.push(`dry-run：profiles/${profile.name} 不存在，将执行 dsh ${createArgv} 创建模板`);
    }
    if (declared && installed === null) {
      throw new InitError(
        'VERSION_UNKNOWN',
        `init: profile「${profile.name}」记录了 ${ENTRY_PACKAGE}，但读不出已安装版本`,
        `先运行 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE} 再重跑；脚本不解析 file: spec 猜版本，也不在安装状态不明时自动卸载。`,
      );
    }
    if (installed !== null && installed === release.version) {
      const identity = artifactIdentityOf(profile, release);
      if (identity.identity === 'conflict') {
        throw new InitError(
          'ARTIFACT_CONFLICT',
          `init: 已安装 ${installed}，但 ${identity.detail}`,
          `同名同版本不保证同一制品（不同 issuer 的私版包会冲突）。确认后用 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE} 移除，再装本次交付；或改用与已安装制品一致的交付包。`,
        );
      }
      lines.push(`状态：已安装同版本 ${installed}，本次不写入`);
      if (identity.identity === 'confirmed') {
        lines.push(`制品一致性：已确认——${identity.detail}（摘要来自交付包，属自证）`);
      } else {
        lines.push(`制品一致性：无法确认——${identity.detail}；仅版本相同不能证明是同一制品`);
        warnings.push(
          `warn: 已安装版本与交付版本相同，但无法确认两者是同一制品；profile 里的配置可能仍来自旧包（例如不同 issuer）。需要确认时先 remove 再重装。`,
        );
      }
      if (options.dryRun) {
        lines.push('dry-run：未执行安装，未写入 profile');
        if (release.secret !== null) lines.push('dry-run：安装完成后会把交付目录内的 IAM 客户端密钥写入本机凭据库，并删除该密钥文件');
        lines.push(...verificationPoints(profile));
        return { code: 0, lines, warnings, result: { ...base, status: 'dry-run', command, verified: null } };
      }
      const verification = await verifyInstall({ exec: resolveExec(exec), launch, profile, lines });
      const secret = await provisionClientSecret({ scriptExec, exec: resolveExec(exec), profile, release, lines, fetchImpl });
      lines.push('mounted=unknown（运行期挂载不在本脚本断言；启动宿主后在「设置 → 插件」确认）');
      lines.push(nextStepLine(profile.name));
      return {
        code: 0,
        lines,
        warnings,
        result: { ...base, status: 'already-installed', command, verified: verification.verified, clientSecret: secret.status, artifact: { ...artifact, identity: identity.identity } },
      };
    }

    // 已装版本与交付版本不同：先卸载再安装（升级和回退走同一条路，正文记录当前交付版本）。
    const replacing = installed !== null && installed !== release.version ? installed : null;
    const removeCommand = ['plugin', '--profile', profile.name, 'remove', ENTRY_PACKAGE];
    if (replacing !== null) {
      lines.push(`状态：已安装 ${replacing}，与交付版本 ${release.version} 不同，先卸载再安装`);
      lines.push(`卸载：dsh ${removeCommand.join(' ')}`);
    }
    // store 预检（--pnpm-store）：这里只做只读比对并把结论带进回显；据此采取的动作写在
    // 演练的计划里，在真实执行里发生在首个包操作之前（见 dry-run 之后）。
    const preflight = storePreflight(profile, options);
    if (preflight !== null) {
      lines.push(PNPM_STORE_LINE);
      if (preflight.verdict === 'consistent') {
        lines.push(`store 预检：profile「${profile.name}」记录的 store 与本次将用的一致（${preflight.recorded}）`);
      } else if (preflight.verdict === 'absent') {
        lines.push(`store 预检：profiles/${profile.name}/node_modules 未记录 store（全新或已清空），无需处理`);
      } else {
        lines.push(`store 预检：profile「${profile.name}」的 node_modules 由另一个 pnpm store 装入（记录的 store：${preflight.recorded}；本次将用：${preflight.providedLabel}）`);
      }
    }
    lines.push(`命令：dsh ${command.join(' ')}`);
    if (options.dryRun) {
      lines.push(replacing === null ? 'dry-run：未执行安装，未写入 profile' : 'dry-run：未执行卸载与安装，未写入 profile');
      if (options.pnpmFromHost) lines.push(PNPM_FROM_HOST_LINE);
      if (options.reinstallOnStoreMismatch) lines.push(REINSTALL_LINE);
      if (preflight?.verdict === 'mismatch') {
        lines.push(options.reinstallOnStoreMismatch
          ? `dry-run：store 不一致，将先清空 profiles/${profile.name}/node_modules 再执行包操作`
          : 'dry-run：store 不一致且未获修复授权，将以 PROFILE_STORE_MISMATCH 停止且不改动 profile');
      }
      if (release.secret !== null) lines.push('dry-run：安装完成后会把交付目录内的 IAM 客户端密钥写入本机凭据库，并删除该密钥文件');
      lines.push(...verificationPoints(profile));
      return {
        code: 0,
        lines,
        warnings,
        result: {
          ...base,
          status: 'dry-run',
          command,
          ...(replacing === null ? {} : { previousVersion: replacing }),
          verified: null,
        },
      };
    }

    const cli = resolveExec(exec);
    if (profile.name === 'desktop') {
      await assertDesktopVerifiable({ exec: cli, launch, profile, lines });
    }
    // 宿主自带 pnpm 时（企业版桌面壳把随包的那一份经宿主参数交给 dsh），既不在 PATH 找 pnpm，
    // 也不补装：宿主的每次包操作都用自己的 pnpm，员工机器上有没有装都不影响安装。
    const pnpm = options.pnpmFromHost ? { env, dir: null } : await ensurePnpm({ exec: cli, env, platform: process.platform, lines });
    if (options.pnpmFromHost) lines.push(PNPM_FROM_HOST_LINE);
    if (options.reinstallOnStoreMismatch) lines.push(REINSTALL_LINE);
    // 包操作遇到 pnpm 的 store 不一致（node_modules 由另一个 pnpm 的 store 链接）时：调用方
    // 声明拥有该 profile，就清空 node_modules 重试一次；否则带着原因停下，不动 profile。
    // 整次初始化只修复一次：修复之后仍不一致，说明两次包操作解析出了不同的 store。
    let storeRepaired = false;
    // 预检发现不一致：未获修复授权，就在改动 profile 之前停下；已获授权，就先清空再执行
    // 卸载与安装——「先删后装」的两侧因此都是确认过健康的操作。反应式自愈保留：预检漏报
    // （比对误判一致）时，包操作撞上的仍是同一条修复路径，只是晚一步。
    if (preflight !== null && preflight.verdict === 'mismatch') {
      if (!options.reinstallOnStoreMismatch) {
        throw new InitError(
          'PROFILE_STORE_MISMATCH',
          `init: store 预检：profile「${profile.name}」的 node_modules 由另一个 pnpm store 装入（记录的 store：${preflight.recorded}；本次将用：${preflight.providedLabel}），未获修复授权，未改动 profile`,
          `退出占用该 profile 的 DSH 进程，删除 profiles/${profile.name}/node_modules 后重跑；该 profile 里其他来源的插件须仍能重新获取。`,
        );
      }
      storeRepaired = true;
      lines.push(`store 预检：先清空 profiles/${profile.name}/node_modules（--reinstall-on-store-mismatch）`);
      lines.push(resetProfileNodeModules(profile.dir) === 'removed'
        ? `已清空 profiles/${profile.name}/node_modules`
        : `profiles/${profile.name}/node_modules 已不存在`);
      warnings.push(`warn: store 预检发现不一致，已按 --reinstall-on-store-mismatch 先行清空 profiles/${profile.name}/node_modules；该 profile 里不由本次交付装入的插件需要重新安装。`);
    }
    const mismatch = (args, detail, next) => new InitError('PROFILE_STORE_MISMATCH', `init: dsh plugin ${args[3]} 失败：${detail}`, next);
    const packageStep = async (args, failureCode) => {
      const run = () => runStep(cli, launch, args, INSTALL_TIMEOUT_MS, failureCode, { env: pnpm.env });
      let result = await run();
      if (result.code === 0 || pnpmErrorCode(result) !== STORE_MISMATCH_CODE) return result;
      const recorded = recordedStoreDirectory(profile.dir);
      const linked = recorded === null ? '' : `（记录的 store：${recorded}）`;
      if (!options.reinstallOnStoreMismatch) {
        throw mismatch(
          args,
          `profile「${profile.name}」的 node_modules 由另一个 pnpm store 装入${linked}，本次使用的 pnpm 不能在它上面继续安装`,
          `退出占用该 profile 的 DSH 进程，删除 ${join('profiles', profile.name, 'node_modules')} 后重跑；该 profile 里其他来源的插件须仍能重新获取。`,
        );
      }
      const environment = '连续两次包操作解析出不同的 store，属该机器的 pnpm 环境问题；请管理员核对该机器的 pnpm 配置（store-dir、PNPM_HOME）后重试。';
      if (storeRepaired) {
        throw mismatch(args, `本次初始化已清空过 profiles/${profile.name}/node_modules，这一步 pnpm 仍报 store 不一致${linked}`, environment);
      }
      storeRepaired = true;
      lines.push(`store 不一致：profile「${profile.name}」的 node_modules 由另一个 pnpm store 装入${linked}，清空后重试本步`);
      lines.push(resetProfileNodeModules(profile.dir) === 'removed'
        ? `已清空 profiles/${profile.name}/node_modules`
        : `profiles/${profile.name}/node_modules 已不存在`);
      warnings.push(`warn: 已按 --reinstall-on-store-mismatch 清空 profiles/${profile.name}/node_modules 并重试；该 profile 里不由本次交付装入的插件需要重新安装。`);
      result = await run();
      if (result.code !== 0 && pnpmErrorCode(result) === STORE_MISMATCH_CODE) {
        throw mismatch(args, `清空 profiles/${profile.name}/node_modules 重试后 pnpm 仍报 store 不一致${linked}`, environment);
      }
      return result;
    };
    if (replacing !== null) {
      const removal = await packageStep(removeCommand, 'UNINSTALL_FAILED');
      if (removal.code !== 0) {
        const reason = reasonTail(removal);
        const code = pnpmErrorCode(removal);
        throw new InitError(
          'UNINSTALL_FAILED',
          `init: dsh plugin remove 失败（退出码 ${removal.code}）${code === null ? '' : `：${code}`}${reason === '' ? '' : `：${reason}`}`,
          `旧版本 ${replacing} 仍在或状态未知，本次未执行安装。确认没有 DSH 进程占用 profile「${profile.name}」后重跑本脚本；需要人工处理时先执行 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE}。`,
        );
      }
      lines.push(`卸载：dsh 退出码 0（旧版本 ${replacing} 已移除）`);
    }
    const install = await packageStep(command, 'INSTALL_FAILED');
    if (install.code !== 0) {
      const reason = reasonTail(install);
      const code = pnpmErrorCode(install);
      throw new InitError(
        'INSTALL_FAILED',
        `init: dsh plugin add 失败（退出码 ${install.code}）${code === null ? '' : `：${code}`}${reason === '' ? '' : `：${reason}`}`,
        replacing === null
          ? `检查上面的命令输出与 profile 占用情况后重跑；回滚用 dsh plugin --profile ${profile.name} remove ${ENTRY_PACKAGE}。`
          : `旧版本 ${replacing} 已卸载，本次安装未完成，profile 当前不含 ${ENTRY_PACKAGE}。排除原因后重跑本脚本会重新安装；需要回到旧版本时用旧交付包重跑本脚本。`,
      );
    }
    lines.push('安装：dsh 退出码 0');
    const record = writeInstallRecord(profile, release);
    // 证据没写成，「装进去的是不是这份交付」就没有可回查的依据，结论必须跟着降级：
    // 否则告警说「没留证据」、JSON 却说 confirmed，调用方会把没核对过的安装当成已核对。
    const identity = record === null
      ? {
        identity: 'unconfirmed',
        detail: `安装已完成，但未能留存安装时刻的制品证据（读不到已安装目录或写入失败），无法核对装进去的是不是本次交付`,
      }
      : { identity: 'confirmed', detail: `安装时刻记录与已安装内容一致（tgz 摘要 ${record.tarballSha256.slice(0, 12)}…）` };
    if (record === null) {
      warnings.push('warn: 安装后未能留存制品证据（读不到已安装目录或写入失败）；下次同版本重跑只能报「无法确认」。');
    } else {
      lines.push(`制品证据：已记录本次安装的 tgz 摘要与已安装目录摘要（profiles/${profile.name}/${INSTALL_RECORD_FILE}，自证）`);
    }
    const verification = await verifyInstall({ exec: cli, launch, profile, lines });
    const secret = await provisionClientSecret({ scriptExec, exec: cli, profile, release, lines, fetchImpl });
    lines.push('mounted=unknown（运行期挂载不在本脚本断言；启动宿主后在「设置 → 插件」确认）');
    lines.push(nextStepLine(profile.name));
    return {
      code: 0,
      lines,
      warnings,
      result: {
        ...base,
        status: 'installed',
        command,
        ...(replacing === null ? {} : { previousVersion: replacing }),
        verified: verification.verified,
        clientSecret: secret.status,
        artifact: { ...artifact, identity: identity.identity, detail: identity.detail },
      },
    };
  } catch (error) {
    const known = error instanceof InitError
      ? error
      : new InitError(
        'UNEXPECTED',
        `init: 未预期的失败（${typeof error?.code === 'string' ? error.code : error?.message ?? 'UNKNOWN'}）`,
        '检查上述原因后重跑；需要时用 --dry-run 查看将执行的命令。',
      );
    const failure = { ok: false, error: { code: known.code, message: known.message, next: known.next } };
    // 走到失败为止的回显，按顺序留给读结论的调用方（桌面壳据此写日志）；终端模式下照旧不打印它们。
    const progress = [...lines];
    if (requestedJson) {
      return { code: 1, lines: [], warnings, result: failure, progress };
    }
    return { code: 1, lines: [`失败：${known.code}`, known.message, `下一步：${known.next}`], warnings: [], result: failure, progress };
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
