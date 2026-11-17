/**
 * T1(r8/r9/r18) 入口形态单点模块（AC-2 / AC-4）：`src/entry-form.mjs` 的自证。
 *
 * r18 采用"两包各自实现 + 根目录交叉对齐"（`tests/cli-entry-parity.test.mjs` 逐条比对
 * devops 与本包 `gh` 入口的同一组判定，任一侧改动而不改另一侧就会在那里变红）。
 * 所以本文件测的是**本包这份实现的规则本身**：后缀词表、四形态分类、以及两个谓词的分工——
 *
 *   - `isStorableEntry`：这个值**存不存得下**（保存侧，win32 普通文件即 true，r8 AC-1 不回归）；
 *   - `isSpawnableEntry`：这个入口**能不能被本插件启动**（自动选中/装配期就绪，win32 只认 `.exe`）。
 *
 * r8 的单一谓词 `isDirectlyExecutable` 已被 r18 删除（它把两个问题合成一个，正是内网现场
 * "页面变绿、调用失败"的根因）；本文件因此按**矩阵**同时断言两个谓词，并钉住它不再被导出。
 *
 * 全部离线：`stat` 是假对象、`platform` 显式注入，Windows 行为因此在 POSIX 主机上
 * 也能被确定性覆盖；**真机仍是 NOT RUN**（企业 Windows 实机保存与启动见验收阶段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as entryFormModule from '../src/entry-form.mjs';
import {
  ENTRY_FORMS,
  WRAPPER_SUFFIXES,
  entryFormOf,
  isSpawnableEntry,
  isStorableEntry,
  wrapperSuffixOf,
} from '../src/entry-form.mjs';

const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'entry-form.mjs');

/** 假 stat：`mode` 只在 POSIX 有意义，但两个平台都带上，避免用例随宿主不同而漂移。 */
const asFile = (mode = 0o644) => ({ isFile: () => true, mode });
const asDir = () => ({ isFile: () => false, mode: 0o755 });

/** 两个谓词在同一份输入上的结论：`[isStorableEntry, isSpawnableEntry]`。 */
const verdictOf = (file, platform, stat) => [
  isStorableEntry({ path: file, platform, stat }),
  isSpawnableEntry({ path: file, platform, stat }),
];

test('形态词表与常量：WRAPPER_SUFFIXES 冻结、ENTRY_FORMS 四值齐全（AC-2）', () => {
  assert.deepEqual([...WRAPPER_SUFFIXES], ['.cmd', '.bat', '.ps1', '.com', '.vbs'], '词表是运行期提示的全集，改动必须是有意的');
  assert.ok(Object.isFrozen(WRAPPER_SUFFIXES), 'WRAPPER_SUFFIXES 必须冻结（防止运行期被改写）');
  for (const suffix of WRAPPER_SUFFIXES) assert.ok(suffix.startsWith('.'), `后缀必须以点开头：${suffix}`);
  assert.deepEqual(
    { ...ENTRY_FORMS },
    { NATIVE: 'native', WRAPPER: 'wrapper', EXTENSIONLESS: 'extensionless', OTHER: 'other' },
    '四形态是消费者的联合类型，键名与取值都不能漂移',
  );
  assert.ok(Object.isFrozen(ENTRY_FORMS), 'ENTRY_FORMS 必须冻结');
});

test('wrapperSuffixOf：全表命中、大小写不敏感、只看 basename 结尾（AC-2）', () => {
  for (const suffix of WRAPPER_SUFFIXES) {
    assert.equal(wrapperSuffixOf(`dop${suffix}`), suffix);
    assert.equal(wrapperSuffixOf(`dop${suffix.toUpperCase()}`), suffix, 'Windows 上后缀大小写不敏感');
    assert.equal(wrapperSuffixOf(`DOP${suffix.toUpperCase()}`), suffix);
  }
  assert.equal(wrapperSuffixOf('dop.exe'), null, '.exe 是原生入口，不在包装脚本表里');
  assert.equal(wrapperSuffixOf('dop'), null);
  assert.equal(wrapperSuffixOf('dop.cmdx'), null, '必须整段后缀命中，不能只匹配前缀');
  assert.equal(wrapperSuffixOf('dop.sh'), null);
  assert.equal(wrapperSuffixOf('dop'), null);
  assert.equal(wrapperSuffixOf(''), null, '空串不是包装脚本');
  assert.equal(wrapperSuffixOf(null), null, '非字符串一律 null（判定不出来不等于"不是"）');
  assert.equal(wrapperSuffixOf(undefined), null);
  assert.equal(wrapperSuffixOf(42), null);
});

test('entryFormOf：四形态 × 两平台（AC-2）', () => {
  const cases = [
    // [输入, 平台, 期望, 说明]
    ['C:\\tools\\dop.cmd', WIN, ENTRY_FORMS.WRAPPER, 'win32 包装脚本'],
    ['C:\\tools\\DOP.PS1', WIN, ENTRY_FORMS.WRAPPER, '大小写不敏感'],
    ['C:\\tools\\dop.exe', WIN, ENTRY_FORMS.NATIVE, 'win32 原生入口'],
    ['C:\\tools\\DOP.EXE', WIN, ENTRY_FORMS.NATIVE, '大写 .EXE 同样是原生入口'],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\dop', WIN, ENTRY_FORMS.EXTENSIONLESS, 'npm 生成的无后缀 shim'], // security-scan: allow（夹具：合成路径，用户名是占位符 me）
    ['C:\\tools\\dop.sh', WIN, ENTRY_FORMS.OTHER, '既非原生也非包装脚本'],
    ['/opt/dop.cmd', POSIX, ENTRY_FORMS.WRAPPER, 'POSIX 口径不变：包装脚本仍是包装脚本'],
    ['/opt/dop.exe', POSIX, ENTRY_FORMS.NATIVE, '.exe 在任何平台都归原生'],
    ['/opt/dop', POSIX, ENTRY_FORMS.NATIVE, 'POSIX 上无后缀就是普通可执行文件'],
    ['/opt/dop.sh', POSIX, ENTRY_FORMS.OTHER, '带其它扩展名归 other'],
  ];
  for (const [file, platform, expected, why] of cases) {
    assert.equal(entryFormOf(file, platform), expected, `${file} @ ${platform}：${why}`);
  }
  // basename 语义：目录名里带 `.cmd` 不算包装脚本。
  assert.equal(entryFormOf('C:\\tools\\dop.cmd\\dop.exe', WIN), ENTRY_FORMS.NATIVE, '只看 basename，目录名不参与判定');
  assert.equal(entryFormOf('C:\\tools\\dop.cmd\\dop', WIN), ENTRY_FORMS.EXTENSIONLESS);
  // 判定不出来统一 other：调用方各自按语义处理，不应被静默当成某一形态。
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(entryFormOf(bad, WIN), ENTRY_FORMS.OTHER, `非法输入必须归 other：${String(bad)}`);
  }
  // 缺省平台取宿主：同一份规则在两台机器上只有"无后缀"这一处分歧。
  assert.equal(
    entryFormOf('dop'),
    process.platform === 'win32' ? ENTRY_FORMS.EXTENSIONLESS : ENTRY_FORMS.NATIVE,
    '缺省平台取 process.platform',
  );
  assert.equal(entryFormOf('dop', null), entryFormOf('dop', process.platform), 'platform 传 null 时回落宿主');
});

test('r18 双谓词（win32 六形态）：`.exe` 才是 [存得下, 起得来]，其余五形态存得下但起不来', () => {
  const sixForms = [
    // [basename, 期望 [isStorableEntry, isSpawnableEntry], 说明]
    ['dop.exe', [true, true], '原生 .exe：唯一能被 execFile(shell:false) 直接启动的形态'],
    ['dop', [true, false], '无后缀 npm shim：存得下（r8 AC-1），起不来（r3 AC-2）'],
    ['dop.cmd', [true, false], '.cmd 需要 cmd.exe 解释'],
    ['dop.ps1', [true, false], '.ps1 需要 PowerShell'],
    ['dop.bat', [true, false], '.bat 需要 cmd.exe 解释'],
    ['dop.com', [true, false], '.com 不在本插件的原生白名单（只认 .exe）'],
  ];
  for (const [name, expected, why] of sixForms) {
    assert.deepEqual(
      verdictOf(`C:\\tools\\${name}`, WIN, asFile()),
      expected,
      `${name}：${why}`,
    );
  }
  assert.deepEqual(verdictOf('C:\\tools\\DOP.EXE', WIN, asFile()), [true, true], '大小写不敏感');
  assert.deepEqual(verdictOf('C:\\tools\\dop.vbs', WIN, asFile()), [true, false], '.vbs 可存（运行期归因解释它起不来）');
  assert.deepEqual(
    verdictOf('C:\\tools\\dop.exe', WIN, { isFile: () => true }),
    [true, true],
    'win32 不看 mode（Windows 没有 POSIX 执行位）',
  );
  // 目录 / 缺 stat / isFile 非函数：两个谓词都必须 false（fail closed，不猜）。
  for (const [label, stat] of [['目录', asDir()], ['缺 stat', undefined], ['stat 为 null', null], ['isFile 非函数', { isFile: 'yes' }]]) {
    assert.deepEqual(verdictOf('C:\\tools\\dop.exe', WIN, stat), [false, false], `${label} 不是入口`);
  }
  for (const bad of ['', '   ', null, undefined]) {
    assert.deepEqual(verdictOf(bad, WIN, asFile()), [false, false], `路径非法：${String(bad)}`);
    assert.deepEqual([isStorableEntry(), isSpawnableEntry()], [false, false], '不传参不抛错，返回 false');
  }
});

test('r18 双谓词（POSIX）：执行位是共同门槛，包装脚本即便有执行位也两票 false（r3 口径不变）', () => {
  // POSIX 上"能启动"与"存得下"在普通文件 + 执行位处重合（这里与 r8 的时代一致）。
  for (const mode of [0o755, 0o750, 0o705, 0o700]) {
    assert.deepEqual(verdictOf('/opt/dop', POSIX, asFile(mode)), [true, true], `mode=${mode.toString(8)} 任一执行位即可`);
  }
  for (const mode of [0o644, 0o444, 0o000]) {
    assert.deepEqual(verdictOf('/opt/dop', POSIX, asFile(mode)), [false, false], `mode=${mode.toString(8)} 没有执行位`);
  }
  assert.deepEqual(verdictOf('/opt/dop', POSIX, asDir()), [false, false]);
  assert.deepEqual(verdictOf('/opt/dop', POSIX, undefined), [false, false]);
  assert.deepEqual(
    verdictOf('/opt/dop', POSIX, { isFile: () => true }),
    [false, false],
    'mode 缺失视为不可判定（POSIX 认执行位）',
  );
  assert.deepEqual(
    verdictOf('/opt/dop.cmd', POSIX, asFile(0o755)),
    [false, false],
    'POSIX 上包装脚本仍不选：不带 shell 起不来，保存侧也不收（r8 的宽松只限 win32）',
  );
  assert.deepEqual(verdictOf('/opt/dop.exe', POSIX, asFile(0o755)), [true, true], 'POSIX 上 .exe 只看执行位');
  assert.deepEqual(verdictOf('/opt/dop', POSIX, asFile(0o755)), [true, true], '判定只看注入的 stat，不做 basename 白名单');
  assert.deepEqual(verdictOf('/opt/dop.sh', POSIX, asFile(0o755)), [true, true], '其它后缀在 POSIX 只受执行位约束');
});

test('r18：单一谓词 isDirectlyExecutable 已删除（不再从转发点导出）', () => {
  assert.equal(
    'isDirectlyExecutable' in entryFormModule,
    false,
    'isDirectlyExecutable 已被 isStorableEntry / isSpawnableEntry 取代：保留别名会让保存侧继续用"能存即能跑"的口径',
  );
  for (const name of ['isStorableEntry', 'isSpawnableEntry']) {
    assert.equal(typeof entryFormModule[name], 'function', `实现必须继续导出 ${name}（消费者与跨包对齐测试都靠它）`);
  }
});

// 未启动归因与脱敏（原 describeSpawnFailure / redactPathLike 用例）已随实现迁到
// test/failure-face.test.mjs（r9 / AC-5：渲染只一处）。本文件只证形态与两个可执行谓词。

test('零 IO / 零子进程 / 本包自带实现（AC-2 / AC-4 静态守门，r18 两包各自实现）', () => {
  const text = readFileSync(MODULE_FILE, 'utf8');
  const imports = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:path'], '本包自己实现形态判定：不得再依赖任何共享包或跨界模块');
  const banned = [
    [/\bchild_process\b/u, 'child_process'],
    [/\b(?:readFileSync|statSync|existsSync|readdirSync)\s*\(/u, '文件系统读取'],
    [/\bprocess\.env\b/u, '环境变量（形态判定不该看环境）'],
    [/shell\s*:\s*true/u, 'shell:true'],
  ];
  const hits = banned.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `entry-form 必须保持纯函数：${hits.join('; ')}`);
  assert.match(text, /export\s+const\s+WRAPPER_SUFFIXES\b/u, '词表在本文件声明（另一份在 gitee，由交叉对齐测试守住）');
  for (const name of ['isStorableEntry', 'isSpawnableEntry']) {
    assert.match(text, new RegExp(`export\\s+function\\s+${name}\\b`, 'u'), `${name} 必须是本文件里的实现`);
  }
  assert.equal(/export\s*\{[^}]*\}\s*from\s*'/u.test(text), false, '不得用再导出冒充实现：C 方案要求两份各自可独立阅读');
  assert.equal(/export\s+(?:function|const)\s+isDirectlyExecutable\b/u.test(text), false, 'isDirectlyExecutable 不得复活');
});
