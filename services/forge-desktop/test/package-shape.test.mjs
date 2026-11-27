/**
 * Package shape tests for @heluo/forge-desktop.
 *
 * The shell is not an npm artifact: its deliverable is the packaged app, and
 * the two Electron toolchain dependencies are build-time only. That is why
 * they live in devDependencies and why their versions are pinned exactly:
 * the fingerprint allowlist (`{43.0.0,44.0.0,44.7.0,45.0.0-alpha.6}`) makes a
 * floating Electron a different, unverified runtime (plan §4.5-2).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, '..');

/** The only Electron builds the dsh fingerprint allowlist accepts for this shell. */
export const ELECTRON_PIN = '44.7.0';
export const ELECTRON_BUILDER_PIN = '26.0.12';

/** Rule kept pure so the mutation cases below prove it fails. */
export function pinnedProblems(manifest) {
  const problems = [];
  const dev = manifest.devDependencies ?? {};
  const electron = dev.electron;
  if (electron !== ELECTRON_PIN) {
    problems.push(`devDependencies.electron must be exactly "${ELECTRON_PIN}", got ${JSON.stringify(electron)}`);
  }
  const builder = dev['electron-builder'];
  if (builder !== ELECTRON_BUILDER_PIN) {
    problems.push(`devDependencies["electron-builder"] must be exactly "${ELECTRON_BUILDER_PIN}", got ${JSON.stringify(builder)}`);
  }
  for (const [name, range] of Object.entries(dev)) {
    if (/^[~^]| \|\| /u.test(range)) problems.push(`devDependencies.${name} uses a floating range: ${range}`);
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    problems.push('the shell ships no runtime dependencies; the toolchain belongs in devDependencies');
  }
  return problems;
}

test('清单形态：钉版 devDependencies、零运行时依赖、files 闭包不夹带工具链', async () => {
  const manifest = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pinnedProblems(manifest), []);
  assert.deepEqual(manifest.files, ['src', 'README.md']);
  assert.ok(manifest.engines.dsh);
  assert.equal(manifest.private, true);
});

test('钉版反向：浮动范围、未知版本与运行时依赖各自被拒（变异证明）', async () => {
  const manifest = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  const variants = [
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '^44.7.0' } }, /electron.*exactly/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '44.7.0' , 'electron-builder': '~26.0.12' } }, /electron-builder.*exactly/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '44.11.5' } }, /exactly/],
    [{ ...manifest, dependencies: { electron: '44.7.0' } }, /no runtime dependencies/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, foo: '^1.0.0' } }, /floating range/],
  ];
  for (const [variant, pattern] of variants) {
    const problems = pinnedProblems(variant);
    assert.ok(problems.length > 0, 'a mutated manifest must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});

/**
 * The profile the shell owns, and how it is started. `main.mjs` is not run
 * offline (it needs Electron), so the entry is read as text, the same way the
 * entry checks below read it. Kept pure so the mutation cases prove each guard
 * fails.
 *
 * The name is checked by what it must not be rather than by its spelling: `web`
 * is the terminal CLI's profile and `desktop` is reserved by the dsh command
 * line for the official Desktop. Whether the installer accepts the name is the
 * repository's contract test, which knows the installer's own rule.
 *
 * The port is checked the same way (see `portProblem`): the entry must declare
 * one, and it must pass it to the profile.
 */
export function profileProblems(main) {
  const problems = [];
  const declared = /^const PROFILE = '([^']+)';$/mu.exec(main);
  if (declared === null) {
    problems.push("main.mjs must name the profile it owns: `const PROFILE = '<name>'`");
  } else if (declared[1] === 'web' || declared[1] === 'desktop') {
    problems.push(`the shell must own its profile: "${declared[1]}" is the terminal CLI's or the official Desktop's`);
  }
  const port = /^const PORT = '([^']+)';$/mu.exec(main);
  if (port === null) {
    problems.push("main.mjs must name the port it listens on: `const PORT = '<port>'`");
  } else {
    const problem = portProblem(port[1]);
    if (problem !== null) problems.push(`the shell needs a fixed port of its own: ${problem}`);
  }
  // The profile starts on the loopback host, on the shell's own port, and opens no browser.
  if (!/'--profile', PROFILE, '--host', BIND_HOST, '--port', PORT, '--no-open'/u.test(main)) {
    problems.push('the profile must start with --host BIND_HOST, --port PORT and --no-open');
  }
  return problems;
}

/** The terminal's default port (`dsh web`): the shell must not listen on it, the two run at once. */
export const TERMINAL_WEB_PORT = 3080;

/**
 * Why `value` cannot be the shell's port, or null when it can. The port must be
 * fixed, above the privileged range, below the lowest default ephemeral range
 * (Linux starts at 32768), and not the terminal's default. `0` is refused: the
 * system then hands out a port on every start, and the window, whose storage is
 * keyed by origin, changes origin each time.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function portProblem(value) {
  if (!/^\d{1,5}$/u.test(value)) return `not a port number: "${value}"`;
  const port = Number(value);
  if (port === 0) return '0 has the system pick a port, so the window changes origin on every start';
  if (port < 1024 || port > 32767) return `${value} is outside 1024–32767`;
  if (port === TERMINAL_WEB_PORT) return `${value} is the terminal's default (dsh web)`;
  return null;
}

/**
 * dsh is started only through the shell's own entry, which hands it the pnpm
 * of the bundled runtime; and all entry paths come from layout.mjs. Kept pure
 * so the mutation cases below prove each guard fails.
 */
export function entryProblems(main, cli, layout) {
  const problems = [];
  if (!/export const PRIMARY_RUNTIME_PNPM_PARTS/u.test(layout)) problems.push('layout.mjs must export PRIMARY_RUNTIME_PNPM_PARTS');
  if (!/export function primaryRuntimeNodeParts/u.test(layout)) problems.push('layout.mjs must export primaryRuntimeNodeParts');
  if (!/export const DSH_ENTRY_PARTS/u.test(layout)) problems.push('layout.mjs must export DSH_ENTRY_PARTS');
  // The shell's own code and the embedded runtime travel in one archive; its name is the layout's.
  if (!/export const APP_ARCHIVE_PARTS/u.test(layout)) problems.push('layout.mjs must export APP_ARCHIVE_PARTS');
  // The entry takes its resource paths from the layout, and runs as Node: no Electron in it.
  if (!/\{ APP_ARCHIVE_PARTS, DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, primaryRuntimeNodeParts \} from '\.\/layout\.mjs'/u.test(cli)) problems.push('embedded-cli.mjs must read both entries from layout.mjs');
  if (/from 'electron'|import\('electron'\)/u.test(cli)) problems.push('embedded-cli.mjs runs as Node and must not import electron');
  // main.mjs starts the entry for the profile and for the installer, never dsh's own file.
  if (!/\{ EMBEDDED_ENTRY \} from '\.\/embedded-cli\.mjs'/u.test(main)) problems.push("main.mjs must import EMBEDDED_ENTRY from './embedded-cli.mjs'");
  if (!/spawn\(process\.execPath, \[EMBEDDED_ENTRY, /u.test(main)) problems.push('the shell profile must be started through EMBEDDED_ENTRY');
  if (!/embeddedExec\(\{ command: process\.execPath, entry: EMBEDDED_ENTRY, env \}\)/u.test(main)) problems.push('the installer executor must start EMBEDDED_ENTRY');
  if (/\[DSH_ENTRY,/u.test(main)) problems.push('dsh entry must not be started directly: it would look for pnpm on PATH');
  // The embedded runtime is loaded from inside the archive; both readers look for it there.
  if (!/dshEntry: join\(resources, \.\.\.APP_ARCHIVE_PARTS, \.\.\.DSH_ENTRY_PARTS\)/u.test(cli)) problems.push('the embedded runtime entry must be looked for inside the archive');
  if (!/const DSH_ENTRY = join\(process\.resourcesPath, \.\.\.APP_ARCHIVE_PARTS, \.\.\.DSH_ENTRY_PARTS\);/u.test(main)) problems.push('main.mjs must look for the embedded runtime entry inside the archive');
  // The entries' paths are the layout's, never spelled out here.
  if (!/\{ APP_ARCHIVE_PARTS, ASSETS_DIR, BIN_DIR, DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, STATUS_PAGE_PARTS, TITLE_BAR_PARTS, TRAY_ICON_PARTS, primaryRuntimeNodeParts \} from '\.\/layout\.mjs'/u.test(main)) {
    problems.push('main.mjs must read the resource paths from layout.mjs');
  }
  if (/'pnpm', 'bin'|'node_modules', '@deepseek-ai'|'primary-runtime', 'dependencies'/u.test(`${main}\n${cli}`)) problems.push('resource paths must come from layout.mjs, not be inlined');
  if (/'app\.asar'/u.test(`${main}\n${cli}`)) problems.push('the archive name must come from layout.mjs, not be inlined');
  // A runtime loaded from the archive hands the operating system physical paths. That layer is
  // installed before any of dsh is linked: a builtin's named exports are bound when their
  // importer is linked, so a later install would leave dsh with the original functions.
  if (!/install = installPhysicalPaths, load = loadEntry/u.test(cli)) problems.push('the entry must install the physical path layer');
  if (!/if \(archiveRoot !== null\) install\(\{ archiveRoot \}\);\n\s*const entry = await load\(dshEntry\);/u.test(cli)) problems.push('the physical path layer must be installed before dsh is loaded');
  // The title bar page is a staged resource like the others; its bridge is app code, read from beside main.mjs.
  if (!/titleBarPage: join\(process\.resourcesPath, \.\.\.TITLE_BAR_PARTS\)/u.test(main)) problems.push('main.mjs must read the title bar page path from layout.mjs');
  if (!/titleBarPreload: TITLE_BAR_PRELOAD/u.test(main)) problems.push('main.mjs must hand the shell the title bar bridge');
  // A window whose bridge did not load has buttons that do nothing: said before anything is touched, like the runtime.
  if (!/existsSync\(TITLE_BAR_PRELOAD\)\) fail\('TITLE_BAR_MISSING'/u.test(main)) problems.push('main.mjs must check the title bar bridge is there before starting');
  return problems;
}

test('布局契约：main.mjs 消费 layout.mjs 的导出，不内联资源路径', async () => {
  const main = await readFile(join(PKG_ROOT, 'src', 'main.mjs'), 'utf8');
  assert.match(main, /from '\.\/layout\.mjs'/u);
  assert.doesNotMatch(main, /'node_modules', '@deepseek-ai'/u, 'dsh 入口路径必须来自 layout.mjs，不得内联');
  assert.doesNotMatch(main, /'brand', 'tray\.png'/u, '托盘图标路径必须来自 layout.mjs，不得内联');
  assert.doesNotMatch(main, /'brand', 'titlebar\.html'/u, '标题栏页面路径必须来自 layout.mjs，不得内联');
  const layout = await readFile(join(PKG_ROOT, 'src', 'layout.mjs'), 'utf8');
  assert.match(layout, /export const APP_ARCHIVE_PARTS/u);
  assert.match(layout, /export const DSH_ENTRY_PARTS/u);
  assert.match(layout, /export const TRAY_ICON_PARTS/u);
  assert.match(layout, /export const BIN_DIR/u);
  assert.match(layout, /export const ASSETS_DIR/u);
  assert.match(layout, /export const STATUS_PAGE_PARTS/u);
  assert.match(layout, /export const TITLE_BAR_PARTS/u);
  assert.match(main, /STATUS_PAGE_PARTS/u, 'main.mjs must read the setup page path from layout.mjs');
  // The bridge ships in the app itself (`files` carries `src`), not in the staged resources.
  assert.match(main, /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), 'window-chrome\.preload\.cjs'\)/u, 'the title bar bridge must be app code beside main.mjs');
  assert.equal(await readFile(join(PKG_ROOT, 'src', 'window-chrome.preload.cjs'), 'utf8').then((source) => source.length > 0), true);
});

test('入口契约：dsh 只经壳的入口启动（载荷 pnpm 由此交给 dsh），入口路径都取自 layout.mjs', async () => {
  const [main, cli, layout] = await Promise.all(['main.mjs', 'embedded-cli.mjs', 'layout.mjs'].map((name) => readFile(join(PKG_ROOT, 'src', name), 'utf8')));
  assert.deepEqual(entryProblems(main, cli, layout), []);
});

test('入口契约反向：绕过壳的入口、内联路径、入口内引用 electron 各自被拒（变异证明）', async () => {
  const [main, cli, layout] = await Promise.all(['main.mjs', 'embedded-cli.mjs', 'layout.mjs'].map((name) => readFile(join(PKG_ROOT, 'src', name), 'utf8')));
  const variants = [
    [main.replace('spawn(process.execPath, [EMBEDDED_ENTRY, ', 'spawn(process.execPath, [DSH_ENTRY, '), cli, layout, /must be started through EMBEDDED_ENTRY|\[DSH_ENTRY,/],
    [main.replace('entry: EMBEDDED_ENTRY, env', 'entry: DSH_ENTRY, env'), cli, layout, /must start EMBEDDED_ENTRY/],
    [main.replace(', PRIMARY_RUNTIME_PNPM_PARTS', ''), cli, layout, /must read the resource paths from layout\.mjs/],
    [main, cli.replace("import { join } from 'node:path';", "import { join } from 'node:path';\nimport { app } from 'electron';"), layout, /must not import electron/],
    [main, cli.replace('{ APP_ARCHIVE_PARTS, DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, primaryRuntimeNodeParts }', '{ APP_ARCHIVE_PARTS, DSH_ENTRY_PARTS, primaryRuntimeNodeParts }'), layout, /must read both entries from layout\.mjs/],
    [main, cli.replace('join(resources, ...PRIMARY_RUNTIME_PNPM_PARTS)', "join(resources, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')"), layout, /not be inlined/],
    [main, cli, layout.replace('export const PRIMARY_RUNTIME_PNPM_PARTS', 'export const PACKAGE_MANAGER_PARTS'), /must export PRIMARY_RUNTIME_PNPM_PARTS/],
    [main, cli, layout.replace('export function primaryRuntimeNodeParts', 'export function runtimeNodeParts'), /must export primaryRuntimeNodeParts/],
    [main.replace(', TITLE_BAR_PARTS', ''), cli, layout, /must read the resource paths from layout\.mjs/],
    [main.replace('titleBarPage: join(process.resourcesPath, ...TITLE_BAR_PARTS)', "titleBarPage: join(process.resourcesPath, 'brand', 'titlebar.html')"), cli, layout, /must read the title bar page path/],
    [main.replace('titleBarPreload: TITLE_BAR_PRELOAD', 'titleBarPreload: PRELOAD'), cli, layout, /must hand the shell the title bar bridge/],
    [main.replace("existsSync(TITLE_BAR_PRELOAD)) fail('TITLE_BAR_MISSING'", "existsSync(TITLE_BAR_PRELOAD)) fail('OTHER'), false && fail('TITLE_BAR_MISSING'"), cli, layout, /must check the title bar bridge/],
    [main, cli.replace('join(resources, ...APP_ARCHIVE_PARTS, ...DSH_ENTRY_PARTS)', 'join(resources, ...DSH_ENTRY_PARTS)'), layout, /looked for inside the archive/],
    [main.replace('join(process.resourcesPath, ...APP_ARCHIVE_PARTS, ...DSH_ENTRY_PARTS)', 'join(process.resourcesPath, ...DSH_ENTRY_PARTS)'), cli, layout, /must look for the embedded runtime entry inside the archive/],
    [main.replace('{ APP_ARCHIVE_PARTS, ASSETS_DIR,', '{ ASSETS_DIR,'), cli, layout, /must read the resource paths from layout\.mjs/],
    [main, cli, layout.replace('export const APP_ARCHIVE_PARTS', 'export const ARCHIVE_PARTS'), /must export APP_ARCHIVE_PARTS/],
    [main.replace('join(process.resourcesPath, ...APP_ARCHIVE_PARTS, ...DSH_ENTRY_PARTS)', "join(process.resourcesPath, 'app.asar', ...DSH_ENTRY_PARTS)"), cli, layout, /not be inlined/],
    [main, cli.replace('install = installPhysicalPaths, load = loadEntry', 'load = loadEntry'), layout, /must install the physical path layer/],
    [
      main,
      cli.replace('if (archiveRoot !== null) install({ archiveRoot });\n  const entry = await load(dshEntry);', 'const entry = await load(dshEntry);\n  if (archiveRoot !== null) install({ archiveRoot });'),
      layout,
      /before dsh is loaded/,
    ],
  ];
  for (const [variantMain, variantCli, variantLayout, pattern] of variants) {
    const problems = entryProblems(variantMain, variantCli, variantLayout);
    assert.ok(problems.length > 0, `a mutated source must produce at least one problem (expected ${pattern}): got ${JSON.stringify(problems)}`);
    assert.match(problems.join('\n'), pattern);
  }
});

test('profile 契约：壳独占自己的 profile，不与终端的 web、官方 Desktop 的 desktop 同名；监听自己的固定端口', async () => {
  const main = await readFile(join(PKG_ROOT, 'src', 'main.mjs'), 'utf8');
  assert.deepEqual(profileProblems(main), []);
});

test('端口规则：系统分配、终端默认端口、特权与临时端口范围、非数字各自被拒', () => {
  assert.equal(portProblem('30810'), null);
  assert.equal(portProblem('1024'), null);
  assert.equal(portProblem('32767'), null);
  assert.match(portProblem('0'), /changes origin on every start/u);
  assert.match(portProblem('3080'), /terminal's default/u);
  assert.match(portProblem('80'), /outside 1024–32767/u);
  assert.match(portProblem('32768'), /outside 1024–32767/u);
  assert.match(portProblem('http'), /not a port number/u);
});

test('profile 契约反向：共用 web、占用 desktop、不声明 profile、系统分配端口、终端默认端口、不声明端口、去掉启动参数各自被拒（变异证明）', async () => {
  const main = await readFile(join(PKG_ROOT, 'src', 'main.mjs'), 'utf8');
  const declared = /^const PROFILE = '([^']+)';$/mu.exec(main);
  assert.notEqual(declared, null, 'main.mjs names its profile');
  const port = /^const PORT = '([^']+)';$/mu.exec(main);
  assert.notEqual(port, null, 'main.mjs names its port');
  const variants = [
    [main.replace(declared[0], "const PROFILE = 'web';"), /must own its profile.*"web"/],
    [main.replace(declared[0], "const PROFILE = 'desktop';"), /must own its profile.*"desktop"/],
    [main.replace(declared[0], ''), /must name the profile it owns/],
    [main.replace(port[0], "const PORT = '0';"), /fixed port of its own.*changes origin on every start/],
    [main.replace(port[0], "const PORT = '3080';"), /fixed port of its own.*terminal's default/],
    [main.replace(port[0], ''), /must name the port it listens on/],
    [main.replace("'--host', BIND_HOST, '--port', PORT, '--no-open'", "'--host', BIND_HOST, '--no-open'"), /--host BIND_HOST, --port PORT/],
  ];
  for (const [variant, pattern] of variants) {
    const problems = profileProblems(variant);
    assert.ok(problems.length > 0, 'a mutated source must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});
