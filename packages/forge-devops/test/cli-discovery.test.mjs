/**
 * T1(r3) 有界 CLI 发现（AC-1 / AC-2 / AC-4）：只读、零外部程序、有界。
 *
 * 全部离线：`fs` 是假实现（只实现本模块用到的同步面），`platform` 显式注入，
 * `now` 是可推进的假时钟。Windows 行为因此能在 POSIX 主机上被确定性覆盖；
 * **真机仍是 NOT RUN**（中文目录 / 空格 / UNC / 长路径 / 网络盘延迟）。
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
  isDirectlyExecutable,
  parsePathVar,
} from '../src/cli-discovery.mjs';

const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli-discovery.mjs');

/** 假 stat：`mode` 只在 POSIX 有意义，但两个平台都带上，避免用例因宿主不同而漂移。 */
const asFile = (mode = 0o644) => ({ isFile: () => true, mode });
const asDir = () => ({ isFile: () => false, mode: 0o755 });

/**
 * 假文件系统：`dirs` 是 目录 → 条目名数组，`files` 是 全路径 → stat 形状。
 * win32 下键大小写不敏感（真实 Windows 也如此），否则覆盖不了 "DOP.EXE 也算命中"。
 * 不在表里的目录/文件抛 ENOENT（不是静默返回空，异常路径也要被用例覆盖）。
 */
function fakeFs({ dirs = {}, files = {}, platform = WIN } = {}) {
  const keyOf = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const dirIndex = new Map(Object.entries(dirs).map(([dir, names]) => [keyOf(dir), names]));
  const fileIndex = new Map(Object.entries(files).map(([file, stat]) => [keyOf(file), stat]));
  const calls = { readdir: [], stat: [] };
  return {
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

test('词表冻结：包装脚本后缀与两个发现层级是唯一口径（AC-2）', () => {
  assert.deepEqual([...WRAPPER_SUFFIXES], ['.cmd', '.bat', '.ps1', '.com', '.vbs']);
  assert.deepEqual([...DISCOVERY_TIERS], ['PATH', 'candidate-dir']);
  assert.ok(Object.isFrozen(WRAPPER_SUFFIXES), 'WRAPPER_SUFFIXES 必须冻结（防止运行期被改写）');
  assert.ok(Object.isFrozen(DISCOVERY_TIERS), 'DISCOVERY_TIERS 必须冻结');
  assert.equal(DEFAULT_MAX_CANDIDATES, 200);
  assert.equal(DEFAULT_DEADLINE_MS, 250);
});

test('可执行名字表：win32 只认 .exe，POSIX 认裸命令名', () => {
  assert.deepEqual(candidateExecutableNames('dop', WIN), ['dop.exe']);
  assert.deepEqual(candidateExecutableNames('gh', WIN), ['gh.exe']);
  assert.deepEqual(candidateExecutableNames('dop', POSIX), ['dop']);
  assert.deepEqual(candidateExecutableNames('gh', POSIX), ['gh']);
  assert.deepEqual(candidateExecutableNames('', WIN), [], '空工具名不得产出一个".exe"候选');
  assert.deepEqual(candidateExecutableNames(null, POSIX), []);
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
    HOME: '/home/ci',
    DOP_HOME: '/opt/corp/dop',
    PATH: '/usr/bin:/home/ci/bin:$DOP_HOME/bin:${HOME}/sbin:$UNDEFINED/bin:/tmp',
  };
  assert.deepEqual(parsePathVar({ env, platform: POSIX }), [
    '/usr/bin',
    '/home/ci/bin',
    '/opt/corp/dop/bin',
    '/home/ci/sbin',
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
    LOCALAPPDATA: 'C:\\Users\\ci\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\ci',
  };
  const winDirs = candidateDirs({ platform: WIN, env: winEnv, tool: 'dop' });
  assert.deepEqual(winDirs.map((entry) => entry.dir), [
    'C:\\Program Files\\dop',
    'C:\\Program Files (x86)\\dop',
    'C:\\Program Files\\heluo',
    'C:\\Users\\ci\\AppData\\Local\\Programs\\dop',
    'C:\\Users\\ci\\.dop\\bin',
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

test('isDirectlyExecutable：win32 只认 .exe，POSIX 认执行位，包装脚本一律 false', () => {
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: asFile() }), true);
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\DOP.EXE', platform: WIN, stat: asFile() }), true, '大小写不敏感');
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.cmd', platform: WIN, stat: asFile() }), false);
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop', platform: WIN, stat: asFile() }), false, '无扩展名在 Windows 上不可直接执行');
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: asDir() }), false, '目录不是可执行入口');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o755) }), true);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o644) }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o700) }), true, '任一执行位即可');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asDir() }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop.cmd', platform: POSIX, stat: asFile(0o755) }), false, '包装脚本在 POSIX 上同样不选');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: undefined }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: { isFile: () => true } }), false, 'mode 缺失视为不可判定');
});

test('win32 发现：.exe 入选；同目录的 .cmd/.bat/.ps1/.com/.vbs 记 rejected 且不参与解析（AC-2）', () => {
  const wrappers = ['dop.cmd', 'dop.bat', 'dop.ps1', 'dop.com', 'dop.vbs'];
  const files = {};
  for (const name of [...wrappers, 'dop.exe', 'readme.txt']) files[winPath('C:\\tools', name)] = asFile();
  const fs = fakeFs({ dirs: { 'C:\\tools': [...wrappers, 'dop.exe', 'readme.txt'] }, files });

  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\tools' }, fs, now: () => 0 });

  assert.deepEqual(discovery.found, [{ path: 'C:\\tools\\dop.exe', tier: 'PATH' }]);
  assert.deepEqual(discovery.rejected, [
    { path: 'C:\\tools\\dop.bat', why: 'wrapper-script' },
    { path: 'C:\\tools\\dop.cmd', why: 'wrapper-script' },
    { path: 'C:\\tools\\dop.com', why: 'wrapper-script' },
    { path: 'C:\\tools\\dop.ps1', why: 'wrapper-script' },
    { path: 'C:\\tools\\dop.vbs', why: 'wrapper-script' },
  ]);
  assert.deepEqual(discovery.searched, ['PATH', 'candidate-dir']);
  assert.equal(discovery.scannedDirs, 1);
  assert.equal(discovery.skippedDirs, 0);
  assert.equal(discovery.truncated, false);
  assert.deepEqual(Object.keys(discovery).sort(), [
    'elapsedMs', 'found', 'rejected', 'scannedDirs', 'searched', 'skippedDirs', 'tool', 'truncated',
  ]);
});

test('win32 发现：无后缀的 dop 与 dop.sh 不入选；大小写不同的 .EXE 仍命中', () => {
  const fs = fakeFs({
    dirs: { 'C:\\tools': ['dop', 'dop.sh', 'DOP.EXE'] },
    files: {
      'C:\\tools\\dop': asFile(),
      'C:\\tools\\dop.sh': asFile(),
      'C:\\tools\\DOP.EXE': asFile(),
    },
  });
  const discovery = discoverTool({ tool: 'dop', platform: WIN, env: { PATH: 'C:\\tools' }, fs, now: () => 0 });
  assert.deepEqual(discovery.found, [{ path: 'C:\\tools\\DOP.EXE', tier: 'PATH' }]);
  assert.deepEqual(discovery.rejected, [], '只有包装脚本后缀才进 rejected，其它名字连记录都不必');
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

test('零外部程序：模块源码没有子进程通道，只依赖 node:path 与注入的 fs（AC-2）', () => {
  const text = readFileSync(MODULE_FILE, 'utf8');
  const banned = [
    [/child_process/, 'child_process'],
    [/\bexecSync\b/, 'execSync'],
    [/\bexecFile\b/, 'execFile'],
    [/\bspawn(?:Sync)?\b/, 'spawn'],
    [/shell\s*:\s*true/, 'shell:true'],
  ];
  const hits = banned.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `发现模块不得启动任何进程：${hits.join('; ')}`);
  const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:path'], '发现只能依赖 node:path；文件系统必须由调用方注入');
});
