/**
 * CLI 入口解析的离线夹具（r18）：极简只读 fs + npm 全局安装布局（win32）。
 *
 * 两个测试文件共用这一份，避免"解析层一份布局、配置面另一份布局"的漂移：
 *   - `test/cli-entry.test.mjs`：解析层自己的判据（shim → 包内 exe / 失败原因）；
 *   - `test/config-access.test.mjs`：配置快照里的解析事实（`bin` / `candidates` / `reason`）。
 *
 * 布局复刻真实 npm 产物：
 *   <prefix>\gh        ← 无后缀 sh shim（目标指向 node_modules/@cli-tools/gh/bin/run.js）
 *   <prefix>\gh.cmd    ← cmd shim
 *   <prefix>\gh.ps1    ← ps1 shim
 *   <prefix>\node_modules\@cli-tools\gh\bin\gh.exe  ← 真正能启动的那个
 */

export const NPM_PREFIX = 'C:\\Users\\u\\AppData\\Roaming\\npm';
export const NPM_TOOL = 'gh';
export const NPM_PKG = '@cli-tools/gh';
export const NPM_PKG_ROOT = `${NPM_PREFIX}\\node_modules\\@cli-tools\\gh`;

const SHIM_SH = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node "$basedir/node_modules/@cli-tools/${NPM_TOOL}/bin/run.js" "$@"
`;
const SHIM_CMD = `@ECHO off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@cli-tools\\${NPM_TOOL}\\bin\\run.js" %*\r\n`;
const SHIM_PS1 = `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "$basedir/node_modules/@cli-tools/${NPM_TOOL}/bin/run.js" $args\n`;

const fileStat = (size = 0, mode = 0o644) => ({ isFile: () => true, isDirectory: () => false, size, mode });
const dirStat = () => ({ isFile: () => false, isDirectory: () => true, size: 0, mode: 0o755 });

/**
 * 极简只读 fs：`statSync` / `readFileSync` / `readdirSync` 三面，path 大小写与斜杠方向不敏感
 * （win32 语义）。`modes` 用来给 POSIX 用例开/关执行位。
 */
export function fakeFs({ files = {}, dirs = {}, modes = {} } = {}) {
  const key = (value) => String(value)
    .replace(/\\/g, '/')
    .replace(/[A-Za-z]:/, (drive) => drive.toLowerCase())
    .toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([name, body]) => [key(name), body]));
  const dirMap = new Map(Object.entries(dirs).map(([name, items]) => [key(name), items]));
  const modeMap = new Map(Object.entries(modes).map(([name, mode]) => [key(name), mode]));
  return {
    statSync(target) {
      const k = key(target);
      if (fileMap.has(k)) return fileStat(String(fileMap.get(k)).length, modeMap.get(k) ?? 0o644);
      if (dirMap.has(k)) return dirStat();
      throw new Error(`ENOENT: ${target}`);
    },
    readFileSync(target) {
      const k = key(target);
      if (!fileMap.has(k)) throw new Error(`ENOENT: ${target}`);
      return fileMap.get(k);
    },
    readdirSync(target) {
      const k = key(target);
      if (!dirMap.has(k)) throw new Error(`ENOENT: ${target}`);
      return [...dirMap.get(k)];
    },
  };
}

/**
 * npm 全局布局：三个 shim + 包内原生 `gh.exe`。
 * `withExe=false` 模拟"包装脚本装上了、包内程序没装成"（r18 现场），用于失败路径。
 */
export function npmLayout({ withExe = true } = {}) {
  const files = {
    [`${NPM_PREFIX}\\${NPM_TOOL}`]: SHIM_SH,
    [`${NPM_PREFIX}\\${NPM_TOOL}.cmd`]: SHIM_CMD,
    [`${NPM_PREFIX}\\${NPM_TOOL}.ps1`]: SHIM_PS1,
    [`${NPM_PKG_ROOT}\\bin\\run.js`]: '// wrapper\n',
  };
  const dirs = {
    [NPM_PREFIX]: withExe
      ? [`${NPM_TOOL}`, `${NPM_TOOL}.cmd`, `${NPM_TOOL}.ps1`, 'node_modules']
      : [`${NPM_TOOL}`, `${NPM_TOOL}.cmd`, `${NPM_TOOL}.ps1`],
    [`${NPM_PREFIX}\\node_modules`]: ['@cli-tools'],
    [`${NPM_PREFIX}\\node_modules\\@cli-tools`]: [NPM_TOOL],
    [NPM_PKG_ROOT]: ['bin'],
    [`${NPM_PKG_ROOT}\\bin`]: withExe ? [`${NPM_TOOL}.exe`, 'run.js'] : ['run.js'],
  };
  if (withExe) files[`${NPM_PKG_ROOT}\\bin\\${NPM_TOOL}.exe`] = 'MZ';
  return { fs: fakeFs({ files, dirs }), exe: `${NPM_PKG_ROOT}\\bin\\${NPM_TOOL}.exe` };
}
