/**
 * npm 包装脚本（shim）→ 包内原生可执行文件：**解析单点**（r18 新建）。
 *
 * 背景（r8 现场的根因）：`npm i -g @cli-tools/dop` 在 Windows 上只在 `<prefix>` 里留下三件
 * 包装物——`dop`（sh shim）、`dop.cmd`、`dop.ps1`；真正的原生程序是 **包内** 的
 * `node_modules\@cli-tools\dop\bin\dop.exe`，它从来不在 `PATH` 里。因此"按名字表在 PATH 目录里
 * 找 `.exe`"永远找不到原生入口，只能命中 shim；而 shim 在 `execFile(..., {shell:false})`
 * 下起不来（无后缀 shim 连 CreateProcess 都到不了，`.cmd` 需要 cmd.exe 解释）。
 *
 * 这个模块补的正是缺的那一步：**顺着 shim 的内容找到它要转发的包内脚本，再回到包目录里找
 * 原生可执行文件**。npm 生成的三种 shim 文本里都含有 `<...>/node_modules/<包>/<脚本>.js`
 * 这一段，取它即可定位包根；包根下优先 `<bin>\<tool>.exe`，其次 `bin` 里唯一的 `*.exe`。
 *
 * 纪律：
 *   1. **只读**：只用注入的 `readFileSync` / `statSync` / `readdirSync`，不写盘、不改环境。
 *   2. **零子进程**：绝不"试跑一下 shim"来问它指向谁——那等于在装配期执行一个任意文件。
 *   3. **有界**：单文件读取上限 `SHIM_READ_LIMIT`；读不到、超界、解析不出、跑出包外一律返回
 *      `{ ok: false, reason }`，**不抛**（解析失败是正常结果，不是异常）。
 *   4. **不拼 shell**：解析出的是绝对路径，交给 `execFile(bin, fixedArgv, {shell:false})`。
 */

import path, { win32, posix } from 'node:path';
import {
  ENTRY_FORMS,
  entryFormOf,
  isSpawnableEntry,
  wrapperSuffixOf,
} from './entry-form.mjs';
import {
  candidateExecutableNames,
  fold,
  parsePathVar,
  pathKey,
  pathModuleFor,
} from './entry-path.mjs';

/** 单次读 shim 的上限：npm shim 通常不到 1 KiB，16 KiB 足够覆盖 CRLF/注释/多行变体。 */
export const SHIM_READ_LIMIT = 16 * 1024;

/** 解析失败的原因码。是数据不是文案——文案归各包的失败面/配置页。 */
export const RESOLVE_REASONS = Object.freeze({
  /** 入口本来就不是 shim（例如已是 `.exe`），无需解析。 */
  NOT_SHIM: 'not-shim',
  /** 读不到内容（不存在、权限、非文本）。 */
  READ_FAILED: 'read-failed',
  /** 文件超过读取上限，拒绝按 shim 解析。 */
  TOO_LARGE: 'too-large',
  /** 文本里找不到 `node_modules/<包>/<脚本>.js` 目标。 */
  NO_TARGET: 'no-target',
  /** 解析出的包根跑出了 shim 所在目录（路径穿越/畸形脚本）。 */
  OUTSIDE_PACKAGE: 'outside-package',
  /** 找到包根，但包里没有可启动的原生可执行文件。 */
  NO_NATIVE: 'no-native',
  /** PATH 与显式路径都没找到该命令。 */
  NOT_FOUND: 'not-found',
  /** 找到了文件，但形态不可启动（POSIX 缺执行位等）。 */
  NOT_SPAWNABLE: 'not-spawnable',
  /** 命中的是包装脚本，且解析不到包内原生入口。 */
  WRAPPER_ENTRY: 'wrapper-entry',
  /** 命中的是无后缀 shim，且解析不到包内原生入口。 */
  SHIM_UNRESOLVED: 'shim-unresolved',
});

/** 解析出原生入口时的依据（供页面/诊断显示"凭什么认为这是原生入口"）。 */
export const RESOLVE_BASIS = Object.freeze({
  /** `<包根>\bin\<tool>.exe` 直接命中。 */
  BIN_NAME: 'bin-name',
  /** `<包根>\bin` 下唯一（或唯一同名）的 `*.exe`。 */
  BIN_SINGLE: 'bin-single',
  /** `<包根>\<tool>.exe` 直接命中。 */
  ROOT_NAME: 'root-name',
  /** `<包根>` 下唯一的 `*.exe`。 */
  ROOT_SINGLE: 'root-single',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** 明确"这串字符是路径"（含分隔符或盘符）；裸命令名要交给 PATH 解析。 */
export function looksLikePathValue(value, platform = process.platform) {
  const raw = text(value);
  if (raw === '') return false;
  return platform === 'win32' ? /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) : raw.includes('/');
}

/**
 * 从 shim 文本里抽出 `node_modules/<包>/<脚本>` 目标。
 *
 * 三种 shim（sh / cmd / ps1）在这一段上写法一致，只是引号与变量前缀不同：
 *   sh    `exec node "$basedir/node_modules/@cli-tools/dop/bin/run.js" "$@"`
 *   cmd   `"%_prog%"  "%dp0%\node_modules\@cli-tools\dop\bin\run.js" %*`
 *   ps1   `& "$basedir/node_modules/@cli-tools/dop/bin/run.js" $args`
 *
 * 因此只认"路径形状"：`node_modules` 之后、到 `.js`/`.cjs`/`.mjs` 结尾的一段，字符限定在
 * 包名安全字符内（字母数字 `@ . _ + -` 与分隔符），避免把后面的引号/重定向吞进来。
 * 取**第一处**命中：npm 的 shim 里目标只出现一次，多处出现时第一处就是执行目标。
 */
export function shimTargetOf(source) {
  const body = typeof source === 'string' ? source : '';
  if (body === '') return null;
  const normalized = body.replace(/\\/g, '/');
  const match = /node_modules\/((?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+\.(?:cjs|mjs|js))(?![\w.-])/.exec(
    normalized,
  );
  if (match === null) return null;
  const segments = match[1].split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  // 穿越与畸形：`..`、绝对路径片段、空段一律不认。
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  const scoped = segments[0].startsWith('@');
  if (scoped && segments.length < 3) return null;
  const nameLength = scoped ? 2 : 1;
  const packageName = segments.slice(0, nameLength).join('/');
  const script = segments.slice(nameLength).join('/');
  if (script === '') return null;
  return Object.freeze({ packageName, script, segments: Object.freeze([...segments]) });
}

/** shim 文件名去掉包装后缀后的工具名（`dop.cmd` → `dop`、`dop` → `dop`）。 */
function toolNameOfShim(shimPath, platform) {
  const pm = pathModuleFor(platform);
  const name = pm.basename(shimPath);
  if (name === '') return '';
  const suffix = wrapperSuffixOf(name);
  if (suffix !== null) return name.slice(0, name.length - suffix.length);
  return name;
}

/** 目录下匹配 `*.exe` 的文件名（大小写不敏感）；读不到返回空数组。 */
function exeNamesIn(dir, fs) {
  try {
    const items = fs.readdirSync(dir);
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => (typeof item === 'string' ? item : item !== null && typeof item?.name === 'string' ? item.name : ''))
      .filter((name) => name !== '' && name.toLowerCase().endsWith('.exe'));
  } catch {
    return [];
  }
}

/** 同目录里挑出优先项：名字（大小写不敏感）相等者优先，否则"唯一一个"才算确定。 */
function pickNative(names, wanted, platform) {
  if (names.length === 0) return null;
  const folded = fold(wanted, platform);
  const exact = names.find((name) => fold(name, platform) === folded);
  if (exact !== undefined) return { name: exact, single: names.length === 1 };
  if (names.length === 1) return { name: names[0], single: true };
  return null;
}

/**
 * 在包根里找原生可执行文件。**顺序即优先级**：`bin` 目录优先于包根，名字命中优先于"仅一个"。
 * 返回 `{ path, basis }` 或 `null`；不做任何执行、不做版本判断。
 */
export function nativeEntryOf(options = {}) {
  const { packageRoot, tool = '', platform = process.platform, fs } = options;
  const pm = pathModuleFor(platform);
  const root = text(packageRoot);
  if (root === '') return null;
  if (fs === null || fs === undefined || typeof fs.readdirSync !== 'function' || typeof fs.statSync !== 'function') {
    throw new TypeError('nativeEntryOf 需要注入同步 fs（readdirSync / statSync）');
  }
  const wanted = `${text(tool) || 'tool'}.exe`;
  const accept = (file) => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    return isSpawnableEntry({ path: file, platform, stat });
  };
  const binDir = pm.join(root, 'bin');
  const binNames = exeNamesIn(binDir, fs);
  const named = binNames.find((name) => fold(name, platform) === fold(wanted, platform));
  if (named !== undefined) {
    const file = pm.join(binDir, named);
    if (accept(file)) return Object.freeze({ path: file, basis: RESOLVE_BASIS.BIN_NAME });
  }
  const picked = pickNative(binNames, wanted, platform);
  if (picked !== null) {
    const file = pm.join(binDir, picked.name);
    if (accept(file)) {
      return Object.freeze({ path: file, basis: picked.single ? RESOLVE_BASIS.BIN_SINGLE : RESOLVE_BASIS.BIN_NAME });
    }
  }
  const rootNames = exeNamesIn(root, fs);
  const rootNamed = rootNames.find((name) => fold(name, platform) === fold(wanted, platform));
  if (rootNamed !== undefined) {
    const file = pm.join(root, rootNamed);
    if (accept(file)) return Object.freeze({ path: file, basis: RESOLVE_BASIS.ROOT_NAME });
  }
  const rootPicked = pickNative(rootNames, wanted, platform);
  if (rootPicked !== null) {
    const file = pm.join(root, rootPicked.name);
    if (accept(file)) {
      return Object.freeze({ path: file, basis: rootPicked.single ? RESOLVE_BASIS.ROOT_SINGLE : RESOLVE_BASIS.ROOT_NAME });
    }
  }
  return null;
}

/**
 * 解析一个 npm shim → 包内原生可执行文件。
 *
 * @returns {{ok: true, path: string, packageRoot: string, packageName: string, script: string,
 *            basis: string, shim: string} | {ok: false, reason: string, shim: string}}
 *
 * 已是原生入口（`.exe`）时返回 `NOT_SHIM`——调用方据此把候选原样保留，不要重复解析。
 */
export function resolveNpmShim(options = {}) {
  const { path: shimPath, tool = null, platform = process.platform, fs } = options;
  const raw = text(shimPath);
  if (raw === '') return Object.freeze({ ok: false, reason: RESOLVE_REASONS.READ_FAILED, shim: '' });
  if (fs === null || fs === undefined || typeof fs.readFileSync !== 'function' || typeof fs.statSync !== 'function') {
    throw new TypeError('resolveNpmShim 需要注入同步 fs（readFileSync / statSync）');
  }
  const form = entryFormOf(raw, platform);
  if (form === ENTRY_FORMS.NATIVE) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.NOT_SHIM, shim: raw });
  }
  let stat;
  try {
    stat = fs.statSync(raw);
  } catch {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.READ_FAILED, shim: raw });
  }
  if (typeof stat?.size === 'number' && stat.size > SHIM_READ_LIMIT) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.TOO_LARGE, shim: raw });
  }
  let body;
  try {
    body = fs.readFileSync(raw, 'utf8');
  } catch {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.READ_FAILED, shim: raw });
  }
  if (typeof body !== 'string') {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.READ_FAILED, shim: raw });
  }
  // 没有 stat.size 的假实现（含离线夹具）兜第二道：内容超界同样不解析。
  if (body.length > SHIM_READ_LIMIT) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.TOO_LARGE, shim: raw });
  }
  const target = shimTargetOf(body);
  if (target === null) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.NO_TARGET, shim: raw });
  }
  const pm = pathModuleFor(platform);
  const shimDir = pm.dirname(raw);
  const packageRoot = pm.join(shimDir, 'node_modules', ...target.packageName.split('/'));
  // 防穿越：包根必须落在 shim 所在目录之内（`shimTargetOf` 已挡 `..`，这里防平台差异与拼接意外）。
  const rootKey = pathKey(packageRoot, platform);
  const dirKey = pathKey(shimDir, platform);
  if (!(rootKey === dirKey || rootKey.startsWith(`${dirKey}${platform === 'win32' ? '\\' : '/'}`))) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.OUTSIDE_PACKAGE, shim: raw });
  }
  const native = nativeEntryOf({
    packageRoot,
    tool: text(tool) || toolNameOfShim(raw, platform),
    platform,
    fs,
  });
  if (native === null) {
    return Object.freeze({ ok: false, reason: RESOLVE_REASONS.NO_NATIVE, shim: raw });
  }
  return Object.freeze({
    ok: true,
    path: native.path,
    packageRoot,
    packageName: target.packageName,
    script: target.script,
    basis: native.basis,
    shim: raw,
  });
}

/** 包装/无后缀形态 → "解析不到包内原生入口"时的原因码。 */
/**
 * 命令名去掉包装后缀（`dop.cmd` → `dop`）：`nativeEntryOf` 要找的是包内的 `bin/<name>.exe`，
 * 拿带后缀的名字去比对永远命中不了。只在没有 `tool` 提示时用作原生名。
 */
function wrapperFreeNameOf(name) {
  const value = text(name);
  if (value === '') return '';
  const suffix = wrapperSuffixOf(value);
  return suffix === null ? value : value.slice(0, -suffix.length);
}

function unresolvedReasonOf(form) {
  if (form === ENTRY_FORMS.WRAPPER) return RESOLVE_REASONS.WRAPPER_ENTRY;
  if (form === ENTRY_FORMS.EXTENSIONLESS) return RESOLVE_REASONS.SHIM_UNRESOLVED;
  return RESOLVE_REASONS.NOT_SPAWNABLE;
}

/** stat 一次，失败返回 `null`（不存在/权限都不区分——对解析来说都是"读不到"）。 */
function statOnce(fs, file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * 把一个"入口值"解析成**本插件真能启动的绝对路径**。
 *
 * 两种输入形态（gitee 的 `cliPath` 与 devops 的候选都可能出现）：
 *   1. **显式路径**（含分隔符或盘符）：能启动就直接用；指向 shim 就先解析到包内原生入口；
 *   2. **裸命令名**（`gh` / `dop`）：按 `candidateExecutableNames` 扫 `PATH` 目录，原生优先；
 *      只找到 shim 时，对 shim 逐个解析到包内原生入口。
 *
 * 预算：目录数上限 `maxDirs`（缺省 64）、可选截止时间 `deadlineMs`（缺省不限）。超预算即停并
 * 如实返回 `{ ok:false, reason: NOT_FOUND, truncated:true }`——不猜、不返回"大概能用"的路径。
 *
 * @returns {{ok: true, path: string, form: string, resolvedFrom: string|null} |
 *           {ok: false, reason: string, form?: string, truncated?: boolean}}
 */
export function resolveCommandEntry(options = {}) {
  const {
    tool = null,
    value = null,
    platform = process.platform,
    env = null,
    fs,
    searchDirs = null,
    maxDirs = 64,
    now = Date.now,
    deadlineMs = 0,
  } = options;
  if (fs === null || fs === undefined || typeof fs.statSync !== 'function') {
    throw new TypeError('resolveCommandEntry 需要注入同步 fs（statSync）');
  }
  const resolvedPlatform = platform ?? process.platform;
  const pm = pathModuleFor(resolvedPlatform);
  const raw = text(value);
  const toolName = text(tool).toLowerCase();
  const startedAt = typeof now === 'function' ? now() : 0;
  // 搜索的是**用户配的那个名字**，不是工具名：`tool` 只用来在解析出的包里找原生程序。
  // 认错名字的代价是"配了 dop-alt 却在跑 dop"——静默跑错程序比拒绝配置更糟。
  const name = raw !== '' ? raw : toolName;
  const nativeName = toolName !== '' ? toolName : wrapperFreeNameOf(name);

  /** 显式路径分支：直接用，或解析 shim。 */
  const fromPath = (file) => {
    const stat = statOnce(fs, file);
    if (stat === null) return { ok: false, reason: RESOLVE_REASONS.NOT_FOUND };
    if (isSpawnableEntry({ path: file, platform: resolvedPlatform, stat })) {
      return { ok: true, path: file, form: entryFormOf(file, resolvedPlatform), resolvedFrom: null };
    }
    const resolved = resolveNpmShim({ path: file, tool: nativeName, platform: resolvedPlatform, fs });
    if (resolved.ok === true) {
      return { ok: true, path: resolved.path, form: ENTRY_FORMS.NATIVE, resolvedFrom: file };
    }
    return {
      ok: false,
      reason: unresolvedReasonOf(entryFormOf(file, resolvedPlatform)),
      form: entryFormOf(file, resolvedPlatform),
    };
  };

  if (looksLikePathValue(raw, resolvedPlatform)) return fromPath(raw);

  if (name === '') return { ok: false, reason: RESOLVE_REASONS.NOT_FOUND };

  const dirs = Array.isArray(searchDirs) ? searchDirs : parsePathVar({ env, platform: resolvedPlatform, pathModule: pm });
  const budget = Number.isFinite(maxDirs) ? Math.max(0, Math.floor(maxDirs)) : 64;
  const allowedMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 0;
  const names = candidateExecutableNames(name, resolvedPlatform);
  const shims = [];
  let scanned = 0;
  let truncated = false;
  for (const dir of dirs) {
    if (scanned >= budget) {
      truncated = true;
      break;
    }
    if (allowedMs > 0 && typeof now === 'function' && now() - startedAt >= allowedMs) {
      truncated = true;
      break;
    }
    scanned += 1;
    for (const candidate of names) {
      const file = pm.join(dir, candidate);
      const stat = statOnce(fs, file);
      if (stat === null) continue;
      if (isSpawnableEntry({ path: file, platform: resolvedPlatform, stat })) {
        return { ok: true, path: file, form: entryFormOf(file, resolvedPlatform), resolvedFrom: null };
      }
      const form = entryFormOf(file, resolvedPlatform);
      if (form === ENTRY_FORMS.WRAPPER || form === ENTRY_FORMS.EXTENSIONLESS) shims.push({ path: file, form });
    }
  }
  // 原生入口没找到：对命中的 shim 逐个解析（顺序即名字表优先级：裸名先于 .cmd/.ps1）。
  // 解析失败时保留**最具体**的原因（读不到壳 / 包内没有原生程序 / 指向包外），
  // 只有"壳存在但指向不明"才退回形态级的 `shim-unresolved`——调用方据此给不同的指引。
  let shimFailure = null;
  for (const shim of shims) {
    const resolved = resolveNpmShim({ path: shim.path, tool: nativeName, platform: resolvedPlatform, fs });
    if (resolved.ok === true) {
      return { ok: true, path: resolved.path, form: ENTRY_FORMS.NATIVE, resolvedFrom: shim.path };
    }
    if (shimFailure === null) shimFailure = resolved.reason ?? null;
  }
  if (shims.length > 0) {
    return {
      ok: false,
      reason: shimFailure ?? unresolvedReasonOf(shims[0].form),
      form: shims[0].form,
      truncated,
    };
  }
  return { ok: false, reason: RESOLVE_REASONS.NOT_FOUND, truncated };
}

/** 供测试与调用方复用的 path 实现（避免各处 `path.win32` / `path.posix` 各自分支）。 */
export const PATH_IMPLS = Object.freeze({ win32, posix, host: path });
