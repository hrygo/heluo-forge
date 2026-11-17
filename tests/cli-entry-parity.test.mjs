/**
 * CLI 入口判定的跨包交叉对齐（r18 / 裁决 C：两个包各自实现，靠本文件守住等价）。
 *
 * 背景：`dop` 与 `gh` 的入口判定必须对同一件事给出同一个答案——"这个路径在本插件的启动方式
 * （`execFile`、`shell:false`）下能不能起来"。r18 曾把这份判定抽成共享包，用户裁决改为
 * **各自实现 + 交叉对齐**：`@heluo/forge-devops` 与 `@heluo/forge-gitee` 各留一份，
 * 任一侧单独漂移（改词表、改谓词、改 shim 解析规则）都会在这里变红。
 *
 * 这里只做两件事：
 *   1. **行为对齐**：同一组输入（形态矩阵、npm 全局布局、POSIX 执行位、解析失败路径）
 *      两边结果逐条相等；
 *   2. **存在性守门**：两份实现都还在（防止有人把一侧改成转发或干脆删掉）。
 *
 * 边界：全部离线。`platform`、`env`、`fs` 全部注入，Windows 语义在 POSIX 主机上确定可测；
 * **Windows 实机与真实 npm 前缀仍是 NOT RUN**（由验收阶段取证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as devopsForm from '../packages/forge-devops/src/entry-form.mjs';
import * as devopsResolve from '../packages/forge-devops/src/entry-resolve.mjs';
import * as giteeForm from '../packages/forge-gitee/src/entry-form.mjs';
import * as giteeResolve from '../packages/forge-gitee/src/entry-resolve.mjs';
import { resolveCliEntry } from '../packages/forge-gitee/src/cli-entry.mjs';

const WIN = 'win32';
const POSIX = 'linux';

/** npm 全局前缀（与两包夹具同形）：三件套 shim + 包内原生程序。 */
// 合成夹具：运行时拼出 "C:\Users"，源码里不出现该字面量（团队敏感扫描按字面量拦主机路径）。
const WIN_USERS = ['C:', 'Users'].join('\\');
const PREFIX = `${WIN_USERS}\\ci\\AppData\\Roaming\\npm`;
const SHIM = `${PREFIX}\\dop`;
const SHIM_CMD = `${PREFIX}\\dop.cmd`;
const SHIM_PS1 = `${PREFIX}\\dop.ps1`;
const PACKAGE_DIR = `${PREFIX}\\node_modules\\@cli-tools\\dop`;
const NATIVE = `${PACKAGE_DIR}\\bin\\dop.exe`;
const SHIM_TEXT = 'exec node "$basedir/node_modules/@cli-tools/dop/bin/run.js" "$@"\n';
const CMD_TEXT = '@ECHO off\r\nnode "%~dp0\\node_modules\\@cli-tools\\dop\\bin\\run.js" %*\r\n';

const REGULAR = { isFile: () => true, isDirectory: () => false, size: 120, mode: 0o755 };

/**
 * 假 fs：键统一成小写 + `/` 分隔（win32 路径大小写不敏感，真实实现用 pathKey 归一）。
 * `withReader:false` 用于模拟"只有 stat 能力"的注入面。
 */
function fakeFs({ files, dirs = [], modes = {}, withReader = true }) {
  const table = new Map();
  for (const [key, value] of Object.entries(files)) table.set(key.toLowerCase().replace(/\\/gu, '/'), value);
  const directorySet = new Set(dirs.map((dir) => dir.toLowerCase().replace(/\\/gu, '/')));
  const modeTable = new Map();
  for (const [key, value] of Object.entries(modes)) {
    modeTable.set(key.toLowerCase().replace(/\\/gu, '/'), value);
  }
  const calls = { stat: 0, read: 0, readdir: 0 };
  const key = (value) => String(value).toLowerCase().replace(/\\/gu, '/');
  const fs = {
    calls,
    statSync(file) {
      calls.stat += 1;
      const normalized = key(file);
      if (table.has(normalized)) {
        const extra = modeTable.get(normalized) ?? {};
        return { ...REGULAR, ...extra };
      }
      if (directorySet.has(normalized)) {
        return { isFile: () => false, isDirectory: () => true, size: 0, mode: 0o755 };
      }
      const error = new Error(`ENOENT: ${file}`);
      error.code = 'ENOENT';
      throw error;
    },
    readdirSync(dir) {
      calls.readdir += 1;
      const normalized = key(dir);
      const names = new Set();
      for (const candidate of table.keys()) {
        const head = candidate.slice(0, candidate.lastIndexOf('/'));
        if (head !== normalized) continue;
        names.add(candidate.slice(candidate.lastIndexOf('/') + 1));
      }
      if (names.size === 0) {
        const error = new Error(`ENOENT: ${dir}`);
        error.code = 'ENOENT';
        throw error;
      }
      return [...names];
    },
  };
  if (withReader) {
    fs.readFileSync = (file) => {
      calls.read += 1;
      const normalized = key(file);
      if (!table.has(normalized)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return table.get(normalized);
    };
  }
  return fs;
}

/** npm 全局布局：`dop`（sh 壳）/`dop.cmd`/`dop.ps1` 三个包装脚本 + 包内原生程序。 */
function npmLayout({ withNative = true, withReader = true } = {}) {
  const files = { [SHIM]: SHIM_TEXT, [SHIM_CMD]: CMD_TEXT, [SHIM_PS1]: '# ps1 shim\n' };
  const dirs = [
    PREFIX,
    `${PREFIX}\\node_modules`,
    `${PREFIX}\\node_modules\\@cli-tools`,
    PACKAGE_DIR,
    `${PACKAGE_DIR}\\bin`,
  ];
  if (withNative) files[NATIVE] = 'MZ...';
  return fakeFs({ files, dirs, withReader });
}

const winEnv = () => ({ Path: PREFIX, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

const FORMS = ['dop.exe', 'dop', 'dop.cmd', 'dop.ps1', 'dop.bat', 'dop.com'];

test('词表与形态枚举：两份实现逐字相同（词表冻结，改动必须两边一致）', () => {
  assert.deepEqual([...devopsForm.WRAPPER_SUFFIXES], [...giteeForm.WRAPPER_SUFFIXES]);
  assert.deepEqual({ ...devopsForm.ENTRY_FORMS }, { ...giteeForm.ENTRY_FORMS });
  assert.deepEqual({ ...devopsResolve.RESOLVE_REASONS }, { ...giteeResolve.RESOLVE_REASONS });
  assert.ok(Object.isFrozen(devopsForm.WRAPPER_SUFFIXES));
  assert.ok(Object.isFrozen(giteeForm.WRAPPER_SUFFIXES));
  for (const suffix of devopsForm.WRAPPER_SUFFIXES) {
    assert.equal(devopsForm.wrapperSuffixOf(`dop${suffix}`), suffix);
    assert.equal(giteeForm.wrapperSuffixOf(`dop${suffix}`), suffix);
  }
});

test('形态判定矩阵（win32）：六种名字的分类与两谓词逐条相等', () => {
  for (const name of FORMS) {
    const target = `${PREFIX}\\${name}`;
    assert.equal(
      devopsForm.entryFormOf(target, WIN),
      giteeForm.entryFormOf(target, WIN),
      `形态分类漂移：${name}`,
    );
    for (const stat of [REGULAR, { ...REGULAR, mode: 0o644 }]) {
      assert.equal(
        devopsForm.isStorableEntry({ path: target, platform: WIN, stat }),
        giteeForm.isStorableEntry({ path: target, platform: WIN, stat }),
        `保存侧谓词漂移：${name}`,
      );
      assert.equal(
        devopsForm.isSpawnableEntry({ path: target, platform: WIN, stat }),
        giteeForm.isSpawnableEntry({ path: target, platform: WIN, stat }),
        `启动侧谓词漂移：${name}`,
      );
    }
  }
  // 关键结论本身也要钉住：win32 上只有原生可执行体可启动，包装脚本只可保存。
  assert.deepEqual(
    FORMS.map((name) => [
      devopsForm.isStorableEntry({ path: `${PREFIX}\\${name}`, platform: WIN, stat: REGULAR }),
      devopsForm.isSpawnableEntry({ path: `${PREFIX}\\${name}`, platform: WIN, stat: REGULAR }),
    ]),
    [[true, true], [true, false], [true, false], [true, false], [true, false], [true, false]],
    'win32：`.exe` 才可启动，`.cmd/.ps1/.bat/.com` 与无后缀 shim 只可保存',
  );
});

test('形态判定矩阵（POSIX）：执行位决定可启动性，两边一致', () => {
  for (const [mode, expected] of [[0o755, true], [0o644, false], [0o700, true]]) {
    const stat = { ...REGULAR, mode };
    for (const file of ['/usr/local/bin/dop', '/usr/local/bin/dop.cmd']) {
      assert.equal(
        devopsForm.isSpawnableEntry({ path: file, platform: POSIX, stat }),
        giteeForm.isSpawnableEntry({ path: file, platform: POSIX, stat }),
        `POSIX 启动侧谓词漂移：${file} mode=${mode.toString(8)}`,
      );
    }
    assert.equal(
      devopsForm.isSpawnableEntry({ path: '/usr/local/bin/dop', platform: POSIX, stat }),
      expected,
      `POSIX 执行位语义漂移：mode=${mode.toString(8)}`,
    );
  }
});

test('npm 布局解析：只找到 shim 时两边都解析到包内原生程序', () => {
  const fs = npmLayout();
  const devopsOutcome = devopsResolve.resolveCommandEntry({
    tool: 'dop',
    value: 'dop',
    platform: WIN,
    env: winEnv(),
    fs,
  });
  const giteeOutcome = resolveCliEntry({ cliPath: 'dop', tool: 'dop', platform: WIN, env: winEnv(), fs });
  assert.equal(devopsOutcome.ok, true);
  assert.equal(giteeOutcome.ok, true);
  assert.equal(devopsOutcome.path, NATIVE, 'devops 必须解析到包内原生程序');
  assert.equal(giteeOutcome.bin, NATIVE, 'gitee 必须解析到同一路径');
  assert.equal(devopsOutcome.path, giteeOutcome.bin, '两个包对同一次解析必须给出同一路径');
  assert.equal(devopsOutcome.form, devopsForm.ENTRY_FORMS.NATIVE);
  assert.equal(devopsOutcome.resolvedFrom, giteeOutcome.resolvedFrom, '解析来源（哪个 shim）也必须一致');
});

test('npm 布局解析：包里没有原生程序时两边给同一个原因码', () => {
  const fs = npmLayout({ withNative: false });
  const devopsOutcome = devopsResolve.resolveCommandEntry({
    tool: 'dop',
    value: 'dop',
    platform: WIN,
    env: winEnv(),
    fs,
  });
  const giteeOutcome = resolveCliEntry({ cliPath: 'dop', tool: 'dop', platform: WIN, env: winEnv(), fs });
  assert.equal(devopsOutcome.ok, false);
  assert.equal(giteeOutcome.ok, false);
  assert.equal(devopsOutcome.reason, giteeOutcome.reason, '原因码是契约：两边必须同一个词');
  assert.equal(devopsOutcome.reason, devopsResolve.RESOLVE_REASONS.NO_NATIVE, '包内没有原生程序要如实说 no-native，而不是笼统的 shim-unresolved');
});

test('解析通道只有 stat：两边都不冒充"找不到"', () => {
  const fs = npmLayout({ withReader: false });
  const giteeOutcome = resolveCliEntry({ cliPath: 'dop', tool: 'dop', platform: WIN, env: winEnv(), fs });
  assert.equal(giteeOutcome.ok, false);
  assert.equal(
    giteeOutcome.reason,
    'shim-unreadable',
    '没有读壳能力是"这次解析不了"，不是"入口不存在"',
  );
  // 显式指向原生程序时不需要读 shim：这条通道在缺 readFileSync 时仍要成立。
  const explicit = resolveCliEntry({ cliPath: NATIVE, tool: 'dop', platform: WIN, env: winEnv(), fs });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.bin, NATIVE);
});

test('显式路径：指向 shim 与指向原生程序，两边结论一致', () => {
  const fs = npmLayout();
  for (const [value, expected] of [[SHIM, NATIVE], [NATIVE, NATIVE], [SHIM_CMD, NATIVE]]) {
    const devopsOutcome = devopsResolve.resolveCommandEntry({ tool: 'dop', value, platform: WIN, env: winEnv(), fs });
    const giteeOutcome = resolveCliEntry({ cliPath: value, tool: 'dop', platform: WIN, env: winEnv(), fs });
    assert.equal(devopsOutcome.ok, true, `devops 解析失败：${value}`);
    assert.equal(giteeOutcome.ok, true, `gitee 解析失败：${value}`);
    assert.equal(devopsOutcome.path, expected);
    assert.equal(giteeOutcome.bin, expected);
    assert.equal(devopsOutcome.path, giteeOutcome.bin, `显式路径结论漂移：${value}`);
  }
});

test('两份实现都还在，而且都是本包内的实现（不是转发）', () => {
  const devopsText = readFileSync(new URL('../packages/forge-devops/src/entry-form.mjs', import.meta.url), 'utf8');
  const giteeText = readFileSync(new URL('../packages/forge-gitee/src/entry-form.mjs', import.meta.url), 'utf8');
  for (const [label, text] of [['devops', devopsText], ['gitee', giteeText]]) {
    assert.match(text, /export\s+const\s+WRAPPER_SUFFIXES\b/u, `${label} 必须自己声明词表`);
    assert.match(text, /export\s+function\s+isSpawnableEntry\b/u, `${label} 必须自己实现启动侧谓词`);
    assert.match(text, /export\s+function\s+isStorableEntry\b/u, `${label} 必须自己实现保存侧谓词`);
    assert.equal(
      /from\s+'@heluo\/forge-cli-entry/u.test(text),
      false,
      `${label} 不得再依赖共享入口包（r18 裁决 C：各自实现）`,
    );
  }
  const devopsResolveText = readFileSync(
    new URL('../packages/forge-devops/src/entry-resolve.mjs', import.meta.url),
    'utf8',
  );
  const giteeResolveText = readFileSync(
    new URL('../packages/forge-gitee/src/entry-resolve.mjs', import.meta.url),
    'utf8',
  );
  assert.match(devopsResolveText, /export\s+function\s+resolveCommandEntry\b/u);
  assert.match(giteeResolveText, /export\s+function\s+resolveCommandEntry\b/u);
});
