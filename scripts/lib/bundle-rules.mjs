// E01 包体闭包规则（#37）：包体要能在构建内闭合，不靠现场编译、不靠未批 runtime 依赖，
// 也不预建指向不存在包的组合入口。规则只做静态核验；真实 tarball 内容与安装语义由
// scripts/check-bundle-tarballs.mjs 与探针提供证据。
//
// 归属：AGENTS.md §4（包间用 workspace: 引用、不跨包导入源码路径、先满足设计准入再建清单）
// 与 docs/design/plugins/forge-enterprise.md §5.3/§11（组合与包体闭包、AC4/AC5）。

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const KERNEL_PACKAGE = '@deepseek-ai/dsh';
const MARKET_PACKAGE = '@heluo/forge-market';
const PATCH_FILE = 'cordis.patch.yml';
/** 研发叠加层等附加补丁层：同一 bundle 可以带多层，逐层校验。 */
const EXTRA_PATCH_FILE = /^cordis\.patch\.[A-Za-z0-9-]+\.yml$/u;

/**
 * 允许出现在发布物里的 peer：由宿主（DSH Web 外壳）提供的运行时。
 * 浏览器半只 `require('react')`，把它写进 peer 是为了让装错环境时立刻报错，
 * 而不是在页面里炸成 `Cannot find module`。
 */
export const HOST_PEERS = new Set(['react']);

/** 允许的 peer 版本范围：具体 semver 范围（`>=18`、`^18.2.0`、`~18.2.0`），不接受 `workspace:`、`*`、URL 或本地路径。 */
const HOST_PEER_RANGE = /^(?:\^|~|>=)?\s?\d+(?:\.\d+){0,2}$/u;

/**
 * 发布物的 peer 规则（TECHNICAL §9）：只有宿主 peer 可以留在清单里，
 * 且必须同时满足三条——键在白名单、`peerDependenciesMeta[key].optional === true`、
 * 值是具体 semver 范围（禁 `workspace:*`）。peer 不进闭包、不进 `bundledDependencies`、
 * 不出现在 tarball 的 `node_modules/` 里；其余情形保持原有 `unclosed peerDependencies` 文案。
 */
export function peerDependencyErrors(label, pkg, { prefix = 'bundle: ' } = {}) {
  const errors = [];
  const peers = Object.entries(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};
  for (const [dep, spec] of peers) {
    if (!HOST_PEERS.has(dep)) {
      errors.push(`${prefix}${label} has unclosed peerDependencies`);
      continue;
    }
    if (meta?.[dep]?.optional !== true) {
      errors.push(`${prefix}${label} peer ${dep} must be declared optional in peerDependenciesMeta`);
      continue;
    }
    if (typeof spec !== 'string' || spec.startsWith('workspace:') || !HOST_PEER_RANGE.test(spec.trim())) {
      errors.push(`${prefix}${label} peer ${dep} must be a semver range (got ${JSON.stringify(spec)})`);
    }
  }
  if (Object.keys(pkg.optionalDependencies ?? {}).length > 0) errors.push(`${prefix}${label} has unclosed optionalDependencies`);
  return errors;
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 解析组合补丁层里的插入行与被禁用行（只认本仓库实际使用的两种写法）。 */
export function parsePatchLayer(text) {
  const inserted = [];
  const disabled = [];
  let inInsert = false;
  let current = null;
  let lastRowId = null;
  const flush = () => {
    if (current !== null) inserted.push(current);
    current = null;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trimEnd();
    if (line.trim().length === 0) continue;
    if (/^- insert:\s*$/.test(line)) {
      flush();
      inInsert = true;
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      inInsert = false;
    }
    const id = line.match(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/);
    const name = line.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/);
    const off = line.match(/^\s*disabled:\s*(true|false)\s*$/);
    if (id !== null) {
      if (inInsert) {
        flush();
        current = { id: id[1], name: undefined };
      } else {
        lastRowId = id[1];
      }
    }
    if (off !== null && off[1] === 'true' && !inInsert && lastRowId !== null) disabled.push(lastRowId);
    if (inInsert && name !== null && current !== null && current.name === undefined) current.name = name[1];
  }
  flush();
  return { inserted, disabled };
}

function checkManifestShape(label, pkg, errors) {
  if (typeof pkg.name !== 'string' || !/^@heluo\/forge-[a-z0-9-]+$/.test(pkg.name)) {
    errors.push(`bundle: ${label}/package.json name must match @heluo/forge-*`);
  }
  if (typeof pkg.name === 'string' && pkg.name !== `@heluo/${label.split('/')[1]}`) {
    errors.push(`bundle: ${label}/package.json name ${pkg.name} must match its directory name`);
  }
  const dshEngine = pkg.engines?.dsh;
  if (typeof dshEngine !== 'string' || dshEngine.trim().length === 0 || dshEngine.trim() === '*') {
    errors.push(`bundle: ${label}/package.json must pin engines.dsh to a concrete range`);
  }
  const scripts = pkg.scripts ?? {};
  const lifecycle = LIFECYCLE_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  if (lifecycle.length > 0) {
    errors.push(`bundle: ${label}/package.json must not run install-time build scripts (${lifecycle.join(', ')})`);
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field] ?? {};
    if (typeof deps[KERNEL_PACKAGE] === 'string') {
      errors.push(`bundle: ${label}/package.json must not depend on the DSH kernel (${field}.${KERNEL_PACKAGE})`);
    }
  }
}

function checkFileList(label, base, pkg, errors) {
  const files = pkg.files;
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(`bundle: ${label}/package.json must declare a non-empty files list`);
    return;
  }
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.startsWith('/') || entry.split('/').includes('..')) {
      errors.push(`bundle: ${label}/package.json files entry ${JSON.stringify(entry)} must be a relative path without ..`);
      continue;
    }
    if (!existsSync(join(base, entry))) {
      errors.push(`bundle: ${label}/package.json files entry ${entry} does not exist`);
    }
  }
}

function checkEntryPoints(label, base, pkg, errors) {
  const requireTarget = (value, where) => {
    if (typeof value !== 'string') return;
    if (value.includes('*')) {
      const prefix = value.slice(0, value.indexOf('*'));
      const dir = prefix.endsWith('/') ? join(base, prefix) : join(base, dirname(prefix));
      if (!existsSync(dir)) errors.push(`bundle: ${label}/package.json ${where} ${value} has no matching directory`);
      return;
    }
    if (!existsSync(join(base, value))) errors.push(`bundle: ${label}/package.json ${where} ${value} does not exist`);
  };
  requireTarget(pkg.main, 'main');
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    requireTarget(target, `bin.${name}`);
    if (typeof target === 'string' && !target.includes('*')) {
      const full = join(base, target);
      if (existsSync(full) && (statSync(full).mode & 0o100) === 0) {
        errors.push(`bundle: ${label}/package.json bin.${name} ${target} must be executable`);
      }
    }
  }
  const walkExports = (value, where) => {
    if (typeof value === 'string') requireTarget(value, where);
    else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walkExports(nested, `${where}[${key}]`);
    }
  };
  walkExports(pkg.exports, 'exports');
}

function checkWorkspaceDeps(label, pkg, known, errors) {
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith('@heluo/')) continue;
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) {
        errors.push(`bundle: ${label}/package.json ${field}.${name} must use the workspace: protocol`);
        continue;
      }
      if (!known.has(name)) {
        errors.push(`bundle: ${label}/package.json ${field}.${name} has no workspace package`);
      }
    }
  }
}

function checkDeepImports(label, base, errors) {
  const roots = ['src', 'client.js'].map((entry) => join(base, entry)).filter((entry) => existsSync(entry));
  for (const path of roots.flatMap((entry) => (statSync(entry).isDirectory() ? walkFiles(entry) : [entry]))) {
    const text = readFileSync(path, 'utf8');
    const match = text.match(/['"](?:@heluo\/forge-[a-z0-9-]+\/src\/|(?:\.\.\/)+forge-[a-z0-9-]+\/src\/)/);
    if (match !== null) {
      errors.push(`bundle: ${label} imports another package's source path (${match[0].slice(1)})`);
      break;
    }
  }
}

function checkPatchLayer(label, base, pkg, known, errors) {
  const patchPath = join(base, PATCH_FILE);
  const declared = pkg.dsh?.bundle?.patch;
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (existsSync(patchPath)) {
    if (!files.includes(PATCH_FILE)) {
      errors.push(`bundle: ${label}/package.json must list ${PATCH_FILE} in files`);
    }
    if (declared !== `./${PATCH_FILE}`) {
      errors.push(`bundle: ${label}/package.json must declare dsh.bundle.patch ./${PATCH_FILE}`);
    }
  } else if (declared !== undefined) {
    errors.push(`bundle: ${label}/package.json declares dsh.bundle.patch but ${PATCH_FILE} is missing`);
  }
  if (!existsSync(patchPath) && !readdirSync(base).some((name) => EXTRA_PATCH_FILE.test(name))) return;
  // `dsh.bundle.patch` 只声明一层（宿主按 package.json 的应用路径），但同一 bundle
  // 允许携带叠加上层（研发能力层）。附带层不校验就等于"发布时没人管"：行必须能解析、
  // 挂的包必须存在且是构建期依赖，也要列进 files——否则打包后并不随包发布。
  const layers = [PATCH_FILE, ...readdirSync(base).filter((name) => EXTRA_PATCH_FILE.test(name))].filter(
    (name) => existsSync(join(base, name)),
  );
  const seenIds = new Map();
  for (const layer of layers) {
    const isPrimary = layer === PATCH_FILE;
    if (!isPrimary && !files.includes(layer)) {
      errors.push(`bundle: ${label}/package.json files must list the extra patch layer ${layer}`);
    }
    const { inserted } = parsePatchLayer(readFileSync(join(base, layer), 'utf8'));
    for (const entry of inserted) {
      if (entry.name === undefined) {
        errors.push(`bundle: ${label}/${layer} insert row ${entry.id} must declare a package name`);
        continue;
      }
      if (seenIds.has(entry.id)) {
        errors.push(`bundle: ${label}/${layer} insert row ${entry.id} is already declared by ${seenIds.get(entry.id)}`);
      } else {
        seenIds.set(entry.id, layer);
      }
      // 自身子路径入口（如 `@heluo/forge-enterprise/issue-delivery-skill`）指向本包，不是新包：
      // 只要它在 exports 里、且它指向的目录就是本包，就按"本包成员"处理。
      const selfSubpath = typeof pkg.name === 'string'
        && entry.name.startsWith(`${pkg.name}/`)
        && Object.prototype.hasOwnProperty.call(pkg.exports ?? {}, `./${entry.name.slice(pkg.name.length + 1)}`);
      if (!known.has(entry.name) && !selfSubpath) {
        errors.push(`bundle: ${label}/${layer} inserts ${entry.name}, which is not a workspace package`);
      }
      if (entry.name !== pkg.name && !selfSubpath && known.has(entry.name) && pkg.dependencies?.[entry.name] === undefined) {
        errors.push(`bundle: ${label}/${layer} inserts ${entry.name} without a declared build-time dependency`);
      }
      if (entry.name === MARKET_PACKAGE && pkg.name !== MARKET_PACKAGE) {
        errors.push(`bundle: ${label}/${layer} must not mount the legacy market package ${MARKET_PACKAGE}`);
      }
    }
  }
}

function checkLocaleParity(label, base, pkg, errors) {
  const en = join(base, 'locale', 'en.json');
  if (!existsSync(en)) return;
  if (!existsSync(join(base, 'locale', 'zh.json'))) {
    errors.push(`bundle: ${label}/locale must ship both en.json and zh.json`);
  }
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (!files.some((entry) => entry === 'locale' || entry.startsWith('locale/'))) {
    errors.push(`bundle: ${label}/package.json files must include the locale directory`);
  }
}

/**
 * @param {string} root repository root
 * @param {string[]} errors accumulator shared with checkRepo
 */
export function checkBundleClosure(root, errors) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return;
  const dirs = readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const manifests = new Map();
  for (const entry of dirs) {
    const manifest = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      manifests.set(entry.name, JSON.parse(readFileSync(manifest, 'utf8')));
    } catch {
      // package.json 解析错误由 checkRepo 的既有分支报告，这里不重复。
    }
  }
  const known = new Set([...manifests.values()].map((pkg) => pkg.name).filter((name) => typeof name === 'string'));

  for (const [name, pkg] of manifests) {
    const label = `packages/${name}`;
    const base = join(packagesDir, name);
    checkManifestShape(label, pkg, errors);
    checkFileList(label, base, pkg, errors);
    checkEntryPoints(label, base, pkg, errors);
    checkWorkspaceDeps(label, pkg, known, errors);
    checkDeepImports(label, base, errors);
    checkPatchLayer(label, base, pkg, known, errors);
    checkLocaleParity(label, base, pkg, errors);
  }
}

/**
 * 真实 tarball 闭包核验（#37 AC4）：把 `npm pack --dry-run --json` 的结果与清单对照。
 * 只看"包装出来的东西"，不重复静态规则；模式位来自 pack 的实际输出。
 *
 * @param {{label: string, manifest: Record<string, any>, packed: Array<{path: string, mode?: number}>}} input
 */
export function auditTarball({ label, manifest, packed }) {
  const errors = [];
  const paths = new Map();
  for (const entry of packed) {
    if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
      paths.set(entry.path.replace(/^\.\//u, ''), entry.mode);
    }
  }
  const bundled = new Set(manifest.bundledDependencies ?? []);
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!bundled.has(name) || typeof spec !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(spec)) {
      errors.push(`bundle: ${label} tarball has unclosed runtime dependency ${name} (${spec})`);
    }
  }
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    if (field === 'peerDependencies') {
      errors.push(...peerDependencyErrors(`${label} tarball`, manifest));
      continue;
    }
    if (Object.keys(manifest[field] ?? {}).length > 0) errors.push(`bundle: ${label} tarball has unclosed ${field}`);
  }
  for (const name of bundled) {
    if (manifest.dependencies?.[name] === undefined || !paths.has(`node_modules/${name}/package.json`)) {
      errors.push(`bundle: ${label} tarball is missing bundled member ${name}`);
    }
    if (!name.startsWith('@heluo/forge-')) errors.push(`bundle: ${label} tarball must not bundle external/kernel package ${name}`);
  }
  const hasDir = (dir) => [...paths.keys()].some((path) => path.startsWith(`${dir}/`));
  const requirePacked = (value, where) => {
    if (typeof value !== 'string') return;
    if (value.includes('*')) {
      const prefix = value.slice(0, value.indexOf('*'));
      const dir = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix.slice(0, prefix.lastIndexOf('/'))).replace(/^\.\//u, '');
      if (!hasDir(dir)) errors.push(`bundle: ${label} tarball is missing ${where} ${value}`);
      return;
    }
    if (!paths.has(value.replace(/^\.\//u, ''))) errors.push(`bundle: ${label} tarball is missing ${where} ${value}`);
  };

  for (const required of ['package.json', 'README.md']) {
    if (!paths.has(required)) errors.push(`bundle: ${label} tarball is missing ${required}`);
  }
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof entry !== 'string') continue;
    const clean = entry.replace(/\/$/u, '');
    if (!paths.has(clean) && !hasDir(clean)) errors.push(`bundle: ${label} tarball dropped declared files entry ${entry}`);
  }
  requirePacked(manifest.main, 'main');
  const walkExports = (value, where) => {
    if (typeof value === 'string') requirePacked(value, where);
    else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walkExports(nested, `${where}[${key}]`);
    }
  };
  walkExports(manifest.exports, 'exports');
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    requirePacked(target, `bin.${name}`);
    if (typeof target === 'string' && !target.includes('*')) {
      const mode = paths.get(target.replace(/^\.\//u, ''));
      if (typeof mode === 'number' && (mode & 0o100) === 0) {
        errors.push(`bundle: ${label} tarball bin.${name} ${target} is not executable (mode ${(mode & 0o777).toString(8)})`);
      }
    }
  }
  if (paths.has('locale/en.json') && !paths.has('locale/zh.json')) {
    errors.push(`bundle: ${label} tarball is missing locale/zh.json`);
  }
  for (const path of paths.keys()) {
    if (/(?:^|\/)(?:test|tests|coverage)\//u.test(path) || /(?:^|\/)pnpm-lock\.yaml$/u.test(path) || /\.test\.mjs$/u.test(path) || path.includes('node_modules/@deepseek-ai/')) {
      errors.push(`bundle: ${label} tarball must not ship ${path}`);
    }
  }
  return errors;
}

/** Inspect the actual unpacked release, not names in the source workspace. */
export function auditReleaseClosure(base, { allowInstalledBinLinks = false } = {}) {
  const errors = [];
  const seen = new Set();
  const rootModules = join(base, 'node_modules');
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch { errors.push(`bundle: release is missing a valid member manifest at ${dir.slice(base.length) || '.'}`); return; }
    for (const lifecycle of LIFECYCLE_SCRIPTS) {
      if (pkg.scripts?.[lifecycle] !== undefined) errors.push(`bundle: release ${pkg.name} has install-time script ${lifecycle}`);
    }
    checkFileList(`release ${pkg.name}`, dir, pkg, errors);
    checkEntryPoints(`release ${pkg.name}`, dir, pkg, errors);
    const bundled = new Set(pkg.bundledDependencies ?? []);
    errors.push(...peerDependencyErrors(pkg.name, pkg, { prefix: 'bundle: release ' }));
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      const member = join(rootModules, name);
      if (!name.startsWith('@heluo/forge-') || typeof spec !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(spec)) {
        errors.push(`bundle: release ${pkg.name} has unclosed runtime dependency ${name} (${spec})`);
        continue;
      }
      if (!existsSync(join(member, 'package.json'))) { errors.push(`bundle: release is missing member ${name}`); continue; }
      let installed;
      try { installed = JSON.parse(readFileSync(join(member, 'package.json'), 'utf8')); }
      catch { errors.push(`bundle: release member ${name} has an invalid manifest`); continue; }
      if (installed.name !== name || installed.version !== spec) errors.push(`bundle: release member identity/version mismatch for ${name}`);
      if (dir === base && !bundled.has(name)) errors.push(`bundle: release ${name} is not declared bundled`);
      visit(member);
    }
    const patch = pkg.dsh?.bundle?.patch;
    if (typeof patch === 'string' && existsSync(join(dir, patch))) {
      for (const row of parsePatchLayer(readFileSync(join(dir, patch), 'utf8')).inserted) {
        // 自身子路径入口（`@heluo/forge-enterprise/issue-delivery-skill`）也是"本包的成员"：
        // 它由 exports 声明、随同一个 tarball 发行，不引入任何依赖。
        const selfSubpath = typeof row.name === 'string'
          && row.name.startsWith(`${pkg.name}/`)
          && Object.prototype.hasOwnProperty.call(pkg.exports ?? {}, `./${row.name.slice(pkg.name.length + 1)}`);
        if (row.name !== pkg.name && !selfSubpath && pkg.dependencies?.[row.name] === undefined) {
          errors.push(`bundle: release patch inserts undeclared member ${row.name}`);
        }
      }
    }
  };
  visit(base);
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) {
        const binLink = allowInstalledBinLinks && dirname(path).endsWith('/node_modules/.bin') && realpathSync(path).startsWith(`${realpathSync(base)}/`);
        if (!binLink) errors.push(`bundle: release must not contain symlink ${path.slice(base.length + 1)}`);
      }
      else if (entry.isDirectory()) scan(path);
    }
  };
  scan(base);
  return errors;
}

/**
 * 解析 `npm pack --dry-run --json` 的输出，返回文件条目数组。
 * 不同 npm 版本会在 stdout 上打印**一份或两份**相同的 JSON（CI 上的 npm 打印两份），
 * 因此这里按平衡括号切出候选对象逐个尝试，而不是对整个输出直接 JSON.parse。
 */
/**
 * Resolve the npm that belongs to the Node running this check. `npm pack` output
 * shape and file selection are npm-version specific, so a check must not pick up
 * whatever `npm` happens to be first on PATH: on a machine with several Node
 * installs that silently changes what "the tarball contains". Falls back to
 * `npm` only when the sibling binary is absent.
 *
 * @param {string} [execPath] `process.execPath`
 * @param {(path: string) => boolean} [exists]
 * @returns {string}
 */
export function npmExecutable(execPath = process.execPath, exists = existsSync) {
  const dir = dirname(execPath);
  for (const name of process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm']) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return 'npm';
}

/**
 * How to start the npm that belongs to this Node.
 *
 * Windows cannot execute `npm.cmd` through execFile without a shell — Node
 * refuses `.cmd` spawns — and a shell would re-split paths that contain spaces.
 * Every official Node build ships the CLI script next to the binary, so running
 * that file with `process.execPath` keeps the same Node and npm version with no
 * shell in the middle. `npmExecutable` stays the fallback for layouts without it.
 *
 * @param {string} [execPath] `process.execPath`
 * @param {(path: string) => boolean} [exists]
 * @returns {{command: string, prefix: string[]}}
 */
export function npmLaunch(execPath = process.execPath, exists = existsSync) {
  const dir = dirname(execPath);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return { command: execPath, prefix: [candidate] };
  }
  return { command: npmExecutable(execPath, exists), prefix: [] };
}

/** Run npm from the Node that runs this check, with npm's own CLI arguments. */
export function execNpm(args, options = {}) {
  const { command, prefix } = npmLaunch();
  return execFileSync(command, [...prefix, ...args], options);
}

export function parsePackOutput(text) {
  for (const candidate of balancedObjects(text)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    // npm 12 emits an object keyed by package name; npm 11 emits an array of
    // entries. Both carry the file list on the entry itself.
    const entry = Array.isArray(parsed.files) ? parsed : Object.values(parsed)[0];
    if (entry !== null && typeof entry === 'object' && Array.isArray(entry.files)) return entry.files;
    for (const value of Object.values(entry ?? {})) {
      if (value !== null && typeof value === 'object' && Array.isArray(value.files)) return value.files;
    }
  }
  return null;
}

function* balancedObjects(text) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, index + 1);
          start = index;
          break;
        }
      }
    }
  }
}
