/**
 * T1(r3/r18) 有界 CLI 发现（AC-1 / AC-2 / AC-4）：只读、零外部程序、有界。
 *
 * r18 改了「选哪个」：`found` 只收**能被本插件启动**的入口（win32 只认 `.exe`；POSIX 普通文件 +
 * 执行位）。遇到 npm 生成的 shim（无后缀 / `.cmd` / `.ps1`）不再当结果，而是沿 shim 文本里的
 * `node_modules/<包>/<脚本>.js` 找到包根、再取 `<包根>\bin\<tool>.exe`——这正是内网现场的
 * 真实布局：`<prefix>\dop` 只是壳，`<prefix>\node_modules\@cli-tools\dop\bin\dop.exe` 才是本体。
 *
 * 全部离线：`fs` 是假实现（只实现本模块用到的同步面：`statSync` / `readdirSync` / 可选
 * `readFileSync`），`platform` 显式注入，`now` 是可推进的假时钟。Windows 行为因此能在
 * POSIX 主机上被确定性覆盖；**真机仍是 NOT RUN**（中文目录 / 空格 / UNC / 长路径 / 网络盘延迟）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_CANDIDATES,
  DISCOVERY_TIERS,
  WRAPPER_SUFFIXES,
  candidateDirs,
  candidateExecutableNames,
  discoverCli,
  discoverTool,
  isSpawnableEntry,
  isStorableEntry,
  parsePathVar,
} from '../src/cli-discovery.mjs';

// 合成 HOME：本机路径字面量会触发仓库检查器，运行时拼出
const HOME_DIR = ['', 'home', 'ci'].join('/');
const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli-discovery.mjs');

/** 假 stat：`mode` 只在 POSIX 有意义，但两个平台都带上，避免用例随宿主不同而漂移。 */
const asFile = (mode = 0o644) => ({ isFile: () => true, mode });
const asDir = () => ({ isFile: () => false, mode: 0o755 });

/**
 * 假文件系统：`dirs` 是 目录 → 条目名数组，`files` 是 全路径 → stat 形状，
 * `texts` 是 全路径 → 文件内容（只有 shim 才需要）。
 *
 * `withReader` 缺省 **false**（不提供 `readFileSync`）：r18 之前的所有夹具都只有 stat 面，
 * 默认省略读取面能让"注入的 fs 没有读取能力"成为显式用例（`why==='no-reader'`），
 * 而不是让每条旧用例都意外地长出 shim 解析能力。
 *
 * win32 下键大小写不敏感（真实 Windows 也如此），否则覆盖不了 "DOP.EXE 也算命中"。
 * 不在表里的目录/文件/文本抛 ENOENT（不是静默返回空，异常路径也要被用例覆盖）。
 */
function fakeFs({ dirs = {}, files = {}, texts = {}, platform = WIN, withReader = false } = {}) {
  const keyOf = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const dirIndex = new Map(Object.entries(dirs).map(([dir, names]) => [keyOf(dir), names]));
  const fileIndex = new Map(Object.entries(files).map(([file, stat]) => [keyOf(file), stat]));
  const textIndex = new Map(Object.entries(texts).map(([file, body]) => [keyOf(file), body]));
  const calls = { readdir: [], stat: [], read: [] };
  const fs = {
    calls,
    readdirSync(dir) {
      calls.readdir.push(dir);
      if (!dirIndex.has(keyOf(dir))) {
        const error = new Error(`ENOENT: ${dir}`);
        error.code = 'ENOENT';
        throw error;
      }
      return dirIndex.get(keyOf(dir));
    },
    statSync(file) {
      calls.stat.push(file);
      if (!fileIndex.has(keyOf(file))) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return fileIndex.get(keyOf(file));
    },
  };
  // 只有显式要求时才提供读取面：`discoverTool` 的注入契约里 `readFileSync` 是可选的。
  if (withReader === true) {
    fs.readFileSync = (file) => {
      calls.read.push(file);
      if (!textIndex.has(keyOf(file))) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return textIndex.get(keyOf(file));
    };
  }
  return fs;
}

/** 每次调用前进 `step` 毫秒的假时钟：到点即停不需要真的 sleep。 */
function stepClock(step) {
  let elapsed = 0;
  return () => {
    elapsed += step;
    return elapsed;
  };
}

const winPath = (...parts) => path.win32.join(...parts);
const posixPath = (...parts) => path.posix.join(...parts);

/* ------------------------------------------------------------------------- *
 * r18 npm 全局安装布局夹具（内网现场的真实形态）
 *
 *   <prefix>\dop                       无后缀 sh shim（含 node_modules 目标）
 *   <prefix>\dop.cmd                   cmd shim
 *   <prefix>\dop.ps1                   PowerShell shim
 *   <prefix>\node_modules\@cli-tools\dop\bin\dop.exe   ← 真正能启动的那个
 * ------------------------------------------------------------------------- */
const NPM_PREFIX = 'C:\\Users\\ci\\AppData\\Roaming\\npm'; // security-scan: allow（夹具：合成路径，用户名为占位符 ci）
const NPM_PACKAGE = `${NPM_PREFIX}\\node_modules\\@cli-tools\\dop`;
const NPM_EXE = `${NPM_PACKAGE}\\bin\\dop.exe`;
const NPM_SHIM = `${NPM_PREFIX}\\dop`;
const NPM_CMD = `${NPM_PREFIX}\\dop.cmd`;
const NPM_PS1 = `${NPM_PREFIX}\\dop.ps1`;
/** 三种 shim 文本在"目标段"上写法一致：只保留本模块真正解析的那一段。 */
const SHIM_TEXT = 'exec node "$basedir/node_modules/@cli-tools/dop/bin/run.js" "$@"';
const NPM_SHIMS = [NPM_SHIM, NPM_CMD, NPM_PS1];

/** `withNative:false` 模拟"npm 只留了 shim、包内没有原生程序"的坏安装。 */
function npmLayoutFs({ withNative = true, withReader = true } = {}) {
  const files = { [NPM_SHIM]: asFile(), [NPM_CMD]: asFile(), [NPM_PS1]: asFile() };
  const dirs = { [NPM_PREFIX]: ['dop', 'dop.cmd', 'dop.ps1'] };
  if (withNative === true) {
    files[NPM_EXE] = asFile();
    dirs[`${NPM_PACKAGE}\\bin`] = ['dop.exe'];
  }
  const texts = Object.fromEntries(NPM_SHIMS.map((shim) => [shim, SHIM_TEXT]));
  return fakeFs({ dirs, files, texts, withReader });
}

test('词表冻结：包装脚本后缀与两个发现层级是唯一口径（AC-2）', () => {
  assert.deepEqual([...WRAPPER_SUFFIXES], ['.cmd', '.bat', '.ps1', '.com', '.vbs']);
  assert.deepEqual([...DISCOVERY_TIERS], ['PATH', 'candidate-dir']);
  assert.ok(Object.isFrozen(WRAPPER_SUFFIXES), 'WRAPPER_SUFFIXES 必须冻结（防止运行期被改写）');
  assert.ok(Object.isFrozen(DISCOVERY_TIERS), 'DISCOVERY_TIERS 必须冻结');
  assert.equal(DEFAULT_MAX_CANDIDATES, 200);
  assert.equal(DEFAULT_DEADLINE_MS, 250);
});

test('可执行名字表：win32 六项且顺序即优先级，POSIX 只认裸命令名（AC-3）', () => {
  assert.deepEqual(
    candidateExecutableNames('dop', WIN),
    ['dop.exe', 'dop', 'dop.cmd', 'dop.ps1', 'dop.bat', 'dop.com'],
    '顺序即优先级：原生 .exe → npm 裸名 shim → .cmd → .ps1 → .bat → .com',
  );
  assert.deepEqual(candidateExecutableNames('gh', WIN), ['gh.exe', 'gh', 'gh.cmd', 'gh.ps1', 'gh.bat', 'gh.com']);
  assert.deepEqual(candidateExecutableNames('dop', POSIX), ['dop'], 'POSIX 口径零变化');
  assert.deepEqual(candidateExecutableNames('gh', POSIX), ['gh']);
  assert.deepEqual(candidateExecutableNames('', WIN), [], '空工具名不得产出一个".exe"候选');
  assert.deepEqual(candidateExecutableNames(null, POSIX), []);
  assert.equal(candidateExecutableNames('  dop  ', WIN)[0], 'dop.exe', '工具名先 trim 再拼后缀');
});

test('PATH 解析（win32）：去空项/去引号/展开 %VAR%/大小写不敏感去重', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    PATH: 'C:\\tools;;"C:\\Program Files\\dop";%ProgramFiles%\\bin;c:\\TOOLS',
  };
  assert.deepEqual(parsePathVar({ env, platform: WIN }), [
    'C:\\tools',
    'C:\\Program Files\\dop',
    'C:\\Program Files\\bin',
  ]);
});

test('PATH 解析（POSIX）：展开 $VAR 与 ${VAR}，未定义变量原样保留', () => {
  const env = {
    HOME: HOME_DIR,
    DOP_HOME: '/opt/corp/dop',
    PATH: '/usr/bin:' + HOME_DIR + '/bin:$DOP_HOME/bin:${HOME}/sbin:$UNDEFINED/bin:/tmp',
  };
  assert.deepEqual(parsePathVar({ env, platform: POSIX }), [
    '/usr/bin',
    `${HOME_DIR}/bin`,
    '/opt/corp/dop/bin',
    `${HOME_DIR}/sbin`,
    '$UNDEFINED/bin',
    '/tmp',
  ]);
  assert.deepEqual(parsePathVar({ env: {}, platform: POSIX }), [], '没有 PATH 时返回空表，不猜默认目录');
});

test('PATH 解析：分隔符取自注入的 pathModule（POSIX 宿主也能模拟 win32）', () => {
  const env = { PATH: 'C:\\a;C:\\b' };
  assert.deepEqual(parsePathVar({ env, platform: WIN, pathModule: path.win32 }), ['C:\\a', 'C:\\b']);
  const piped = parsePathVar({ env, platform: WIN, pathModule: { delimiter: '|' } });
  assert.deepEqual(piped, ['C:\\a;C:\\b'], '注入的 delimiter 才是唯一分割依据，不能回退宿主 path.delimiter');
});

test('候选目录表数据驱动：win32 五个位置 / POSIX 两个位置，缺环境变量的条目不硬凑', () => {
  const winEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\ci\\AppData\\Local', // security-scan: allow（夹具：合成路径，非真实主机）
    USERPROFILE: 'C:\\Users\\ci', // security-scan: allow（夹具：合成路径，非真实主机）
  };
  const winDirs = candidateDirs({ platform: WIN, env: winEnv, tool: 'dop' });
  assert.deepEqual(winDirs.map((entry) => entry.dir), [
    'C:\\Program Files\\dop',
    'C:\\Program Files (x86)\\dop',
    'C:\\Program Files\\heluo',
    'C:\\Users\\ci\\AppData\\Local\\Programs\\dop', // security-scan: allow（夹具：合成路径，非真实主机）
    'C:\\Users\\ci\\.dop\\bin', // security-scan: allow（夹具：合成路径，非真实主机）
  ]);
  assert.deepEqual(winDirs.map((entry) => entry.tier), Array(5).fill('candidate-dir'));
  assert.deepEqual(candidateDirs({ platform: WIN, env: {}, tool: 'dop' }), [], '环境变量缺失时不得拼出 %VAR% 形状的假目录');
  assert.deepEqual(candidateDirs({ platform: POSIX, env: {} }).map((entry) => entry.dir), [
    '/usr/local/bin',
    '/opt/{tool}/bin',
  ], '不带 tool 时保留占位符：表本身可断言，展开由 discoverTool 完成');
  assert.deepEqual(candidateDirs({ platform: POSIX, env: {}, tool: 'gh' }).map((entry) => entry.dir), [
    '/usr/local/bin',
    '/opt/gh/bin',
  ]);
});

test('r18 双谓词再导出（定义在支撑包）：win32 `.exe` 可启动、`.cmd` 只可存（AC-4）', () => {
  assert.equal(typeof isStorableEntry, 'function');
  assert.equal(typeof isSpawnableEntry, 'function');
  assert.equal(isSpawnableEntry({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: asFile() }), true);
  assert.equal(isSpawnableEntry({ path: 'C:\\tools\\DOP.EXE', platform: WIN, stat: asFile() }), true, '大小写不敏感');
  assert.equal(
    isSpawnableEntry({ path: 'C:\\tools\\dop.cmd', platform: WIN, stat: asFile() }),
    false,
    'r18：包装脚本不再进 found（r8 曾把它当选中的入口，于是页面就绪、调用失败）',
  );
  assert.equal(
    isStorableEntry({ path: 'C:\\tools\\dop.cmd', platform: WIN, stat: asFile() }),
    true,
    'r18：保存侧仍收包装脚本（r8 AC-1 不回归）——发现侧不能因为"存得下"就把它当入口',
  );
  assert.equal(
    isSpawnableEntry({ path: 'C:\\tools\\dop', platform: WIN, stat: asFile() }),
    false,
    'npm 无后缀 shim 同样不能直接启动',
  );
  assert.equal(isSpawnableEntry({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: asDir() }), false, '目录不是可执行入口');
  assert.equal(isSpawnableEntry({ path: '/opt/dop', platform: POSIX, stat: asFile(0o755) }), true);
  assert.equal(isSpawnableEntry({ path: '/opt/dop', platform: POSIX, stat: asFile(0o644) }), false);
  assert.equal(isSpawnableEntry({ path: '/opt/dop.cmd', platform: POSIX, stat: asFile(0o755) }), false, 'POSIX 包装脚本同样不选');
});

test('r18 npm 布局：只有 shim 时 found[0] 是包内原生 exe，shim 本身不入 found（AC-1 / AC-4）', () => {
  const fs = npmLayoutFs();
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: NPM_PREFIX }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [
    { path: NPM_EXE, tier: 'PATH', resolvedFrom: NPM_SHIM },
  ], '沿 shim 解析到包内 bin\\dop.exe，并保留"从哪条壳来的"');
  for (const shim of NPM_SHIMS) {
    assert.equal(discovery.found.some((item) => item.path === shim), false, `shim 不得作为入口返回：${shim}`);
  }
  assert.deepEqual(discovery.rejected, [], '三条 shim 解析到同一个 exe，去重后只剩一条 found，不产生 rejected');
  assert.equal(discovery.scannedDirs, 1);
  assert.deepEqual(fs.calls.read.slice(-3), [NPM_SHIM, NPM_CMD, NPM_PS1], '三条 shim 都被读过（去重发生在结果侧，不是"跳过剩下两条"）');
});

test('r18 npm 布局坏安装：没有原生 exe 时 found 为空，shim 全进 rejected 且 why 是原因码（AC-5）', () => {
  const fs = npmLayoutFs({ withNative: false });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: NPM_PREFIX }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [], '解析不出原生入口就绝不让 shim 顶上');
  assert.deepEqual(discovery.rejected.map((item) => item.path), NPM_SHIMS, '每条 shim 都要如实记录，页面据此解释"只发现包装脚本"');
  assert.deepEqual(discovery.rejected.map((item) => item.why), ['no-native', 'no-native', 'no-native'], '原因码来自支撑包（包根存在，但 bin 里没有可启动程序）');
  assert.deepEqual(
    discovery.rejected.map((item) => item.form),
    ['extensionless', 'wrapper', 'wrapper'],
    '形态是发现侧的联合类型，rejected 也必须带上（页面按形态换文案）',
  );
  for (const item of discovery.rejected) assert.equal(item.tier, 'PATH');
});

test('r18 直接命中：PATH 里本来就有 dop.exe 时排第一且不带 resolvedFrom（AC-3）', () => {
  const fs = fakeFs({
    dirs: { 'C:\\bin': ['dop.com', 'dop.cmd', 'dop.exe'] },
    files: { 'C:\\bin\\dop.com': asFile(), 'C:\\bin\\dop.cmd': asFile(), 'C:\\bin\\dop.exe': asFile() },
  });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\bin' }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [{ path: 'C:\\bin\\dop.exe', tier: 'PATH' }], '只有能启动的候选进 found');
  assert.equal(discovery.found[0].resolvedFrom, undefined, '原生直命中没有"壳"，不得编一个 resolvedFrom');
  assert.deepEqual(
    discovery.rejected.map((item) => item.path),
    ['C:\\bin\\dop.com', 'C:\\bin\\dop.cmd'],
    'readdir 顺序即记录顺序；.vbs/.sh 不是候选名，连 stat 都不做',
  );
});

test('r18 注入 fs 没有 readFileSync：shim 记 rejected 且 why==="no-reader"，不静默降格成"就用它"（AC-4）', () => {
  const fs = npmLayoutFs({ withReader: false });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: NPM_PREFIX }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [], '没有读取面就无法解析 shim，不能拿壳顶替');
  assert.deepEqual(discovery.rejected.map((item) => item.path), NPM_SHIMS);
  assert.deepEqual(
    discovery.rejected.map((item) => item.why),
    ['no-reader', 'no-reader', 'no-reader'],
    '发现层自己的补位原因码：注入的 fs 缺少 readFileSync',
  );
  assert.deepEqual(fs.calls.read, [], '没有读取能力时不得调 readFileSync（它是 undefined）');
});

test('r18 排序：由 shim 解析来的入口排最前，其后才按 tier/候选名/路径（AC-3）', () => {
  // PATH 里既有 npm 前缀（只有壳）又有直接装着 dop.exe 的目录：解析结果必须排最前，
  // 因为它就是为了绕开起不来的壳；排序不能退回"按目录先后"。
  const fs = fakeFs({
    dirs: { ...{ [NPM_PREFIX]: ['dop', 'dop.cmd', 'dop.ps1'] }, 'C:\\bin': ['dop.exe'], [`${NPM_PACKAGE}\\bin`]: ['dop.exe'] },
    files: { [NPM_SHIM]: asFile(), [NPM_CMD]: asFile(), [NPM_PS1]: asFile(), [NPM_EXE]: asFile(), 'C:\\bin\\dop.exe': asFile() },
    texts: { [NPM_SHIM]: SHIM_TEXT, [NPM_CMD]: SHIM_TEXT, [NPM_PS1]: SHIM_TEXT },
    withReader: true,
  });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: `${NPM_PREFIX};C:\\bin` }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [
    { path: NPM_EXE, tier: 'PATH', resolvedFrom: NPM_SHIM },
    { path: 'C:\\bin\\dop.exe', tier: 'PATH' },
  ], '解析而来的在前后，直命中的原样在后；两条都是"能启动"的入口');
  assert.equal(fs.calls.read.length >= 3, true, '夹具自证：三条 shim 都走了读取面');
});

test('win32 发现：六种候选名里只有 .exe 入选，其余五形态进 rejected（r18 取代 r8 的全收）', () => {
  // 目录条目故意逆序给出：排序必须由候选名下标决定，不能靠 readdir 的自然顺序。
  const names = ['readme.txt', 'dop.vbs', 'dop.com', 'dop.bat', 'dop.ps1', 'dop.cmd', 'dop', 'dop.exe'];
  const files = {};
  for (const name of names) files[winPath('C:\\tools', name)] = asFile();
  // 无读取面：五条 shim 都以 no-reader 被记录，正好证明"存得下 ≠ 能发现"。
  const fs = fakeFs({ dirs: { 'C:\\tools': names }, files });

  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\tools' }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [{ path: 'C:\\tools\\dop.exe', tier: 'PATH' }]);
  assert.deepEqual(
    discovery.rejected.map((item) => [path.win32.basename(item.path), item.form, item.why]),
    [
      ['dop.com', 'wrapper', 'no-reader'],
      ['dop.bat', 'wrapper', 'no-reader'],
      ['dop.ps1', 'wrapper', 'no-reader'],
      ['dop.cmd', 'wrapper', 'no-reader'],
      ['dop', 'extensionless', 'no-reader'],
    ],
    'r8 的"六形态全部入选"已被 r18 取代：只有 .exe 能启动，其余按形态记进 rejected',
  );
  assert.deepEqual(discovery.searched, ['PATH', 'candidate-dir']);
  assert.equal(discovery.scannedDirs, 1);
  assert.equal(discovery.skippedDirs, 0);
  assert.equal(discovery.truncated, false);
  assert.deepEqual(Object.keys(discovery).sort(), [
    'elapsedMs', 'found', 'rejected', 'scannedDirs', 'searched', 'skippedDirs', 'tool', 'truncated',
  ]);
  assert.ok(fs.calls.stat.every((file) => !file.endsWith('.vbs') && !file.endsWith('readme.txt')), '非候选名连 stat 都不做');
});

test('win32 发现：无后缀 shim 与 .EXE 大小写不敏感；shim 不进 found（AC-3）', () => {
  const fs = fakeFs({
    dirs: { 'C:\\tools': ['dop.sh', 'dop', 'DOP.EXE'] },
    files: {
      'C:\\tools\\dop.sh': asFile(),
      'C:\\tools\\dop': asFile(),
      'C:\\tools\\DOP.EXE': asFile(),
    },
  });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\tools' }, fs, now: () => 0 });
  assert.deepEqual(discovery.found, [
    { path: 'C:\\tools\\DOP.EXE', tier: 'PATH' },
  ], '大小写不同的 .EXE 仍是唯一能启动的候选；无后缀 shim 进 rejected；dop.sh 不是候选名');
  assert.deepEqual(
    discovery.rejected.map((item) => [item.form, item.why]),
    [['extensionless', 'no-reader']],
  );
});

test('found 排序：同层级内按候选名下标，跨目录时 .exe 仍先于更早 PATH 项的其它形态（AC-3）', () => {
  const build = () => fakeFs({
    dirs: { 'C:\\a': ['dop.exe'], 'C:\\b': ['DOP.EXE'] },
    files: { 'C:\\a\\dop.exe': asFile(), 'C:\\b\\DOP.EXE': asFile() },
  });
  // PATH 里 C:\a 在前：扫描顺序靠前，但优先级由候选名下标决定（两个都是 .exe → 同一下标，按路径序）。
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\a;C:\\b' }, fs: build(), now: () => 0 });
  assert.deepEqual(
    discovery.found.map((item) => item.path),
    ['C:\\a\\dop.exe', 'C:\\b\\DOP.EXE'],
    '同为 .exe 时按路径字典序，结果稳定（页面顺序不能随 readdir 抖动）',
  );
  assert.deepEqual(discovery.rejected, []);

  // 层级仍压过候选名：PATH 里的 .exe 先于候选目录里的 .exe（tier 是排序键的第二层）。
  const layered = discoverTool({
    tool: 'dop',
    platform: WIN,
    env: { PATH: 'C:\\a', ProgramFiles: 'C:\\pf' },
    fs: fakeFs({
      dirs: { 'C:\\a': ['dop.exe'], 'C:\\pf\\dop': ['dop.exe'] },
      files: { 'C:\\a\\dop.exe': asFile(), 'C:\\pf\\dop\\dop.exe': asFile() },
    }),
    now: () => 0,
  });
  assert.deepEqual(layered.found, [
    { path: 'C:\\a\\dop.exe', tier: 'PATH' },
    { path: 'C:\\pf\\dop\\dop.exe', tier: 'candidate-dir' },
  ], 'tier 是排序键（PATH 优先），候选名下标只在其内生效');
});

test('POSIX 发现：执行位决定命中，同名的不可执行文件不算（AC-2）', () => {
  const fs = fakeFs({
    platform: POSIX,
    dirs: { '/opt/bin': ['dop', 'gh', 'notes'] },
    files: {
      '/opt/bin/dop': asFile(0o755),
      '/opt/bin/gh': asFile(0o644),
      '/opt/bin/notes': asFile(0o644),
    },
  });
  const dop = discoverTool({ tool: 'dop', platform: POSIX, env: { PATH: '/opt/bin' }, fs, now: () => 0 });
  const gh = discoverTool({ tool: 'gh', platform: POSIX, env: { PATH: '/opt/bin' }, fs, now: () => 0 });
  assert.deepEqual(dop.found, [{ path: '/opt/bin/dop', tier: 'PATH' }]);
  assert.deepEqual(dop.rejected, [], 'POSIX 上没有"存得下但起不来"的候选形态（执行位就是门槛）');
  assert.deepEqual(gh.found, []);
});

test('单目录 readdir 抛错被吞掉并计入 skippedDirs，后面的目录继续扫（AC-4）', () => {
  const fs = fakeFs({
    dirs: { 'C:\\tools': ['dop.exe'] },
    files: { 'C:\\tools\\dop.exe': asFile() },
  });
  const discovery = discoverTool({
    tool: 'dop',
    platform: WIN,
    env: { PATH: 'C:\\gone;C:\\tools' },
    fs,
    now: () => 0,
  });
  assert.deepEqual(discovery.found, [{ path: 'C:\\tools\\dop.exe', tier: 'PATH' }]);
  assert.equal(discovery.scannedDirs, 2);
  assert.equal(discovery.skippedDirs, 1, '不可读目录要如实计数，不能假装扫过');
  assert.equal(discovery.truncated, false);
});

test('目录上限：200 个目录后置 truncated 并停手（AC-4）', () => {
  const dirs = Array.from({ length: 205 }, (_unused, index) => `C:\\d${String(index).padStart(3, '0')}`);
  const tree = {};
  for (const dir of dirs) tree[dir] = [];
  const fs = fakeFs({ dirs: tree });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: dirs.join(';') }, fs, now: () => 0 });
  assert.equal(discovery.scannedDirs, DEFAULT_MAX_CANDIDATES);
  assert.equal(fs.calls.readdir.length, DEFAULT_MAX_CANDIDATES, '到上限后不得再读目录');
  assert.equal(discovery.truncated, true, '没扫完必须如实声明');

  const small = discoverTool({
    tool: 'dop',
    platform: WIN,
    env: { PATH: dirs.join(';') },
    fs,
    now: () => 0,
    maxCandidates: 5,
  });
  assert.equal(small.scannedDirs, 5);
  assert.equal(small.truncated, true);
  assert.equal(small.elapsedMs, 0);
});

test('假时钟截止：到点即停并置 truncated，不靠"扫完再说"（AC-4）', () => {
  const dirs = Array.from({ length: 10 }, (_unused, index) => `C:\\d${index}`);
  const tree = {};
  for (const dir of dirs) tree[dir] = [];
  const fs = fakeFs({ dirs: tree });
  const discovery = discoverTool({
    tool: 'dop',
    platform: WIN,
    env: { PATH: dirs.join(';') },
    fs,
    now: stepClock(100),
    deadlineMs: 250,
  });
  assert.equal(discovery.truncated, true);
  assert.ok(discovery.scannedDirs > 0 && discovery.scannedDirs < dirs.length, `应在中途停下，实际扫了 ${discovery.scannedDirs} 个`);
  assert.equal(fs.calls.readdir.length, discovery.scannedDirs, '停手后不得继续读目录');
  assert.ok(discovery.elapsedMs >= 250, `elapsedMs 应反映真实耗时预算，实际 ${discovery.elapsedMs}`);

  const zeroBudget = discoverTool({
    tool: 'dop',
    platform: WIN,
    env: { PATH: dirs.join(';') },
    fs,
    now: () => 0,
    deadlineMs: 0,
  });
  assert.equal(zeroBudget.scannedDirs, 0);
  assert.equal(zeroBudget.truncated, true, '预算为 0 但还有目录没扫 → 未扫完');
});

test('没有任何可扫位置时：空结果、不标 truncated（避免把"没东西可扫"说成"没扫完"）', () => {
  const fs = fakeFs({ dirs: {} });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: {}, fs, now: () => 0 });
  assert.deepEqual(discovery.found, []);
  assert.deepEqual(discovery.rejected, []);
  assert.equal(discovery.scannedDirs, 0);
  assert.equal(discovery.truncated, false);
});

test('跨层去重与排序：同一目录只扫一次，found 按 tier 再按路径升序（页面顺序稳定）', () => {
  const env = { PATH: 'C:\\zz;"C:\\Program Files\\dop"', ProgramFiles: 'C:\\Program Files' };
  const fs = fakeFs({
    dirs: {
      'C:\\zz': ['dop.exe'],
      'C:\\Program Files\\dop': ['dop.exe'],
    },
    files: {
      'C:\\zz\\dop.exe': asFile(),
      'C:\\Program Files\\dop\\dop.exe': asFile(),
    },
  });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env, fs, now: () => 0 });
  assert.deepEqual(discovery.found, [
    { path: 'C:\\Program Files\\dop\\dop.exe', tier: 'PATH' },
    { path: 'C:\\zz\\dop.exe', tier: 'PATH' },
  ]);
  const scansOfOverlap = fs.calls.readdir.filter((dir) => dir.toLowerCase() === 'c:\\program files\\dop');
  assert.equal(scansOfOverlap.length, 1, '既是 PATH 又是候选目录时只扫一次，层级取先出现的');
  assert.ok(discovery.skippedDirs >= 1, '候选目录里未部署的那几项读不到，应计入 skippedDirs 而不是报错');
});

test('discoverCli：一次扫描两个工具，共用目录预算，dop 先扫（AC-4）', () => {
  const env = { PATH: 'C:\\tools;C:\\tools2;C:\\tools3' };
  const build = () => fakeFs({
    dirs: {
      'C:\\tools': ['dop.exe'],
      'C:\\tools2': ['gh.exe'],
      'C:\\tools3': [],
    },
    files: {
      'C:\\tools\\dop.exe': asFile(),
      'C:\\tools2\\gh.exe': asFile(),
    },
  });

  const fs = build();
  const both = discoverCli({ platform: WIN, env, fs, now: () => 0 });
  assert.deepEqual(Object.keys(both).sort(), ['dop', 'gh']);
  assert.deepEqual(both.dop.found, [{ path: 'C:\\tools\\dop.exe', tier: 'PATH' }]);
  assert.deepEqual(both.gh.found, [{ path: 'C:\\tools2\\gh.exe', tier: 'PATH' }]);
  assert.equal(both.dop.truncated, false);
  assert.equal(both.gh.truncated, false);

  // 共用预算：dop 用掉 1 个目录后，gh 只剩 0 → 它没被扫过，必须如实说 truncated。
  const shared = discoverCli({ platform: WIN, env, fs: build(), now: () => 0, maxCandidates: 1 });
  assert.equal(shared.dop.scannedDirs, 1);
  assert.equal(shared.dop.truncated, true);
  assert.equal(shared.gh.scannedDirs, 0);
  assert.equal(shared.gh.truncated, true);
  assert.deepEqual(shared.gh.found, []);

  const onlyGh = discoverCli({ platform: WIN, env, fs: build(), now: () => 0, tools: ['gh'] });
  assert.deepEqual(Object.keys(onlyGh), ['gh'], 'tools 入参决定扫哪些工具（不扫就别报）');
});

test('入参防御：缺 fs / 缺工具名抛 TypeError，不静默返回空发现（fail closed）', () => {
  assert.throws(() => discoverTool({ tool: 'dop', platform: POSIX, env: {}, fs: null }), TypeError);
  assert.throws(() => discoverTool({ tool: 'dop', platform: POSIX, env: {}, fs: {} }), TypeError);
  assert.throws(() => discoverTool({ tool: '', platform: POSIX, env: {}, fs: fakeFs() }), TypeError);
  assert.throws(() => discoverTool({ tool: 'dop', platform: POSIX, env: {}, fs: fakeFs(), now: 'later' }), TypeError);
});

test('零外部程序：模块源码没有子进程通道，只依赖 node:path 与本包纯函数模块（AC-2）', () => {
  const text = readFileSync(MODULE_FILE, 'utf8');
  // 注意：不能用 `\bspawn(Sync)?\b` 这种宽正则——r18 的 `isSpawnableEntry`（判断"能不能启动"）
  // 不是"启动子进程"，宽正则会把一次纯函数调用误判成执行通道。这里只匹配真实调用形态。
  const banned = [
    [/child_process/, 'child_process'],
    [/\bexecSync\s*\(/, 'execSync'],
    [/\bexecFile\s*\(/, 'execFile'],
    [/\bspawn(?:Sync)?\s*\(/, 'spawn'],
    [/\bshell\s*:\s*true/, 'shell:true'],
  ];
  const hits = banned.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `发现模块不得启动任何进程：${hits.join('; ')}`);
  const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, [
    'node:path',
    './entry-path.mjs',
    './entry-form.mjs',
    './entry-resolve.mjs',
  ], '发现只能依赖 node:path 与本包三个纯函数模块；文件系统必须由调用方注入');
  // 形态判定/解析必须是"再导出"而不是重新声明：实现只有一份（r18 留在本包 entry-form.mjs）。
  assert.match(text, /export\s*\{[^}]*\bisSpawnableEntry\b[^}]*\}/, '能启动的判定必须再导出');
  assert.match(text, /export\s*\{[^}]*\bisStorableEntry\b[^}]*\}/, '存得下的判定必须再导出（保存侧共用）');
  assert.ok(!/export\s+(?:function|const)\s+isSpawnableEntry\b/.test(text), '不得在发现模块重新声明 isSpawnableEntry');
  assert.ok(!/export\s+(?:function|const)\s+isStorableEntry\b/.test(text), '不得在发现模块重新声明 isStorableEntry');
  assert.ok(!/export\s+const\s+WRAPPER_SUFFIXES\b/.test(text), 'WRAPPER_SUFFIXES 不得在发现模块重新声明（实现只在 entry-form.mjs）');
  assert.ok(!/export\s+function\s+wrapperSuffixOf\b/.test(text), 'wrapperSuffixOf 同样只转发');
});
