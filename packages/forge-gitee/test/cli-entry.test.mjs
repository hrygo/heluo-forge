/**
 * `cli-entry.mjs` 的判据（r18）：配置里的 `cliPath` 能不能启动、启动哪个 bin。
 *
 * 夹具复刻 npm 全局布局（win32），与 devops 的同名单测同形（两边由根目录交叉对齐测试比对）：
 *   <prefix>\gh            ← 无后缀 sh shim（内容指向 node_modules/@cli-tools/gh/bin/run.js）
 *   <prefix>\gh.cmd        ← cmd shim
 *   <prefix>\gh.ps1        ← ps1 shim
 *   <prefix>\node_modules\@cli-tools\gh\bin\gh.exe  ← 真正能启动的那个
 *
 * 关键判据只有一条：**只扫 PATH 时要把 shim 换成包内原生程序**；解析不出来就如实失败，
 * 不退化成"把 shim 交给启动器试试"。另外守着"模块级零 IO、零子进程、零隐式环境"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ENTRY_FORMS } from '../src/entry-form.mjs';
import { RESOLVE_REASONS } from '../src/entry-resolve.mjs';

import { ENTRY_REASONS, entryFactsOf, resolveCliEntry, runtimeBinOf } from '../src/cli-entry.mjs';
import { NPM_PKG_ROOT, NPM_PREFIX, fakeFs, npmLayout } from './helpers/fake-cli-fs.mjs';

const SOURCE = readFileSync(new URL('../src/cli-entry.mjs', import.meta.url), 'utf8');

const WIN = 'win32';
const POSIX = 'linux';
const PREFIX = NPM_PREFIX;
const EXE = `${NPM_PKG_ROOT}\\bin\\gh.exe`;
const winEnv = (prefix = PREFIX) => ({ PATH: prefix });

test('① 裸名 gh + PATH 只有 shim：解析出包内 gh.exe，来源记为 shim', () => {
  const { fs } = npmLayout();
  const resolved = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, EXE);
  assert.equal(resolved.form, ENTRY_FORMS.NATIVE);
  // 裸名先命中无后缀 shim（候选名表里 `gh` 在 `gh.cmd` 之前），来源就是它。
  assert.equal(resolved.resolvedFrom, `${PREFIX}\\gh`, 'resolvedFrom 必须是 shim 本身');
});

test('② 显式 .cmd 路径：同样换成包内原生 exe（用户填 shim 也能起来）', () => {
  const { fs } = npmLayout();
  const resolved = resolveCliEntry({ cliPath: `${PREFIX}\\gh.cmd`, platform: WIN, env: winEnv(), fs });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, EXE);
  assert.equal(resolved.form, ENTRY_FORMS.NATIVE);
  assert.equal(resolved.resolvedFrom, `${PREFIX}\\gh.cmd`);
});

test('③ 包内没有 exe：如实失败，不把 shim 交出去', () => {
  const { fs } = npmLayout({ withExe: false });
  // 显式 `.cmd`：保存侧就该拒收的后缀形态 → 包装脚本类原因。
  const explicit = resolveCliEntry({ cliPath: `${PREFIX}\\gh.cmd`, platform: WIN, env: winEnv(), fs });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.reason, RESOLVE_REASONS.WRAPPER_ENTRY);
  assert.equal(explicit.form, ENTRY_FORMS.WRAPPER);
  // 裸名：PATH 上只剩 shim、壳读得到但包内没有原生程序 → 给最具体的原因（`no-native`），
  // 不要笼统的"脚本壳"：配置面据此提示"包里找不到原生程序"，而不是让用户再猜一层。
  const bare = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, RESOLVE_REASONS.NO_NATIVE);
  assert.equal(bare.form, ENTRY_FORMS.EXTENSIONLESS);
});

test('④ POSIX 无后缀 + 执行位：直接可用，不需要读 shim', () => {
  const fs = fakeFs({
    files: { '/usr/local/bin/gh': '\u0000ELF' },
    dirs: { '/usr/local/bin': ['gh'] },
    modes: { '/usr/local/bin/gh': 0o755 },
  });
  const resolved = resolveCliEntry({ cliPath: 'gh', platform: POSIX, env: { PATH: '/usr/local/bin' }, fs });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, '/usr/local/bin/gh');
  // POSIX 上"无后缀 + 执行位"就是原生入口（形态判定与 win32 的 npm 壳不同名）。
  assert.equal(resolved.form, ENTRY_FORMS.NATIVE);
  // 裸名给的是"名字"，命中路径与配置值不同 → 来源记为配置值本身（与 devops 的 settle 同口径）。
  assert.equal(resolved.resolvedFrom, 'gh');
});

test('④b 显式路径不存在：ok:false / not-found，且不抛', () => {
  const { fs } = npmLayout();
  const resolved = resolveCliEntry({ cliPath: '/opt/gitee/bin/gh-absent', platform: POSIX, env: {}, fs });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, RESOLVE_REASONS.NOT_FOUND);
});

test('⑤ fs 缺 readFileSync：不抛，退化为"这次解析不了"', () => {
  const { fs } = npmLayout();
  // 只有 statSync 的 fs 面：能看见 shim，但读不了壳文件。
  const statOnly = { statSync: (target) => fs.statSync(target) };
  const resolved = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs: statOnly });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, ENTRY_REASONS.NO_SHIM_READER);
  assert.equal(resolved.form, ENTRY_FORMS.EXTENSIONLESS);
});

test('⑤b 完全没有解析通道（无 statSync / 空值）：ok:false，绝不抛', () => {
  const noStat = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs: {} });
  assert.equal(noStat.ok, false);
  assert.equal(noStat.reason, ENTRY_REASONS.RESOLVER_UNAVAILABLE);
  const nullFs = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs: null });
  assert.equal(nullFs.ok, false);
  assert.equal(nullFs.reason, ENTRY_REASONS.RESOLVER_UNAVAILABLE);
  const empty = resolveCliEntry({ cliPath: '   ', platform: WIN, env: winEnv(), fs: null });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, ENTRY_REASONS.INVALID);
});

test('⑥ 固定约束：模块文本零子进程、零 shell、零隐式环境、零直接 IO', () => {
  const banned = [
    [/child_process/u, 'child_process'],
    [/shell\s*:\s*true/u, 'shell:true'],
    [/process\.env/u, 'process.env'],
    [/from 'node:fs'/u, "node:fs（IO 必须注入）"],
    [/execSync/u, 'execSync'],
  ];
  for (const [pattern, label] of banned) {
    assert.doesNotMatch(SOURCE, pattern, `cli-entry.mjs 不得出现 ${label}`);
  }
  // 只有两个导入，且都在本包内：形态判定与解析各一个（C 方案：两包各自实现）。
  const imports = [...SOURCE.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(imports, ['./entry-form.mjs', './entry-resolve.mjs']);
});

test('快照事实：成功给 candidate / spawnable，失败给 rejected / reason / guidance', () => {
  const { fs } = npmLayout();
  const okResult = resolveCliEntry({ cliPath: 'gh', platform: WIN, env: winEnv(), fs });
  const okFacts = entryFactsOf(okResult, { cliPath: 'gh', platform: WIN });
  assert.deepEqual(Object.keys(okFacts).sort(), [
    'bin', 'candidates', 'form', 'guidance', 'reason', 'rejected', 'resolvedFrom', 'spawnable',
  ]);
  assert.equal(okFacts.spawnable, true);
  assert.equal(okFacts.bin, EXE);
  assert.equal(okFacts.reason, null);
  assert.equal(okFacts.guidance, null);
  assert.deepEqual(okFacts.candidates.map((item) => item.path), [EXE]);
  assert.deepEqual(okFacts.rejected, []);

  // 像路径的值被拒：列进 rejected，带 form / why（页面要能把"我填的这条"指出来）。
  // 用"包里没有 exe"的布局，才能让 `.cmd` 落到真实失败上（否则它会被解析成 exe）。
  const missing = npmLayout({ withExe: false });
  const bad = resolveCliEntry({ cliPath: `${PREFIX}\\gh.cmd`, platform: WIN, env: winEnv(), fs: missing.fs });
  const badFacts = entryFactsOf(bad, { cliPath: `${PREFIX}\\gh.cmd`, platform: WIN });
  assert.equal(badFacts.spawnable, false);
  assert.equal(badFacts.bin, null);
  assert.equal(badFacts.reason, RESOLVE_REASONS.WRAPPER_ENTRY);
  assert.equal(typeof badFacts.guidance, 'string');
  assert.deepEqual(badFacts.rejected, [{ path: `${PREFIX}\\gh.cmd`, why: RESOLVE_REASONS.WRAPPER_ENTRY, form: ENTRY_FORMS.WRAPPER }]);

  // 裸名找不到：没有具体文件可列，但原因与指引照样要给。
  const bareFacts = entryFactsOf(
    resolveCliEntry({ cliPath: 'gh', platform: WIN, env: { PATH: 'C:\\nowhere' }, fs }),
    { cliPath: 'gh', platform: WIN },
  );
  assert.deepEqual(bareFacts.rejected, []);
  assert.equal(bareFacts.reason, RESOLVE_REASONS.NOT_FOUND);
  assert.equal(typeof bareFacts.guidance, 'string');
});

test('装配判断：解析成功用 bin，失败保留原值（不阻断）', () => {
  const { fs } = npmLayout();
  const ok = runtimeBinOf({ cliPath: 'gh', platform: WIN, env: winEnv(), fs });
  assert.equal(ok.bin, EXE);
  assert.equal(ok.entry.ok, true);

  const failed = runtimeBinOf({ cliPath: '/opt/gitee/bin/gh-absent', platform: POSIX, env: {}, fs });
  assert.equal(failed.bin, '/opt/gitee/bin/gh-absent', '解析失败必须退回配置值，装配不因此中断');
  assert.equal(failed.entry.ok, false);
});
