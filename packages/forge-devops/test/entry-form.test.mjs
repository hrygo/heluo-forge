/**
 * T1(r8/r9) 入口形态单点模块（AC-2 / AC-4）：`src/entry-form.mjs` 的自证。
 *
 * 这个模块被保存侧、发现侧与两个运行期适配器共读，所以本文件测的不是"某个调用方的行为"，
 * 而是**规则本身**：后缀词表、四形态分类、两平台可执行判定。
 * r9 收窄后本模块只做判定，未启动的归因与脱敏迁到 `failure-face.mjs`（渲染只一处），
 * 对应用例在 test/failure-face.test.mjs。
 * 全部离线：`stat` 是假对象、`platform` 显式注入，Windows 行为因此在 POSIX 主机上
 * 也能被确定性覆盖；**真机仍是 NOT RUN**（企业 Windows 实机保存与启动见验收阶段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENTRY_FORMS,
  WRAPPER_SUFFIXES,
  entryFormOf,
  isDirectlyExecutable,
  wrapperSuffixOf,
} from '../src/entry-form.mjs';

const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'entry-form.mjs');

/** 假 stat：`mode` 只在 POSIX 有意义，但两个平台都带上，避免用例随宿主不同而漂移。 */
const asFile = (mode = 0o644) => ({ isFile: () => true, mode });
const asDir = () => ({ isFile: () => false, mode: 0o755 });

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

test('isDirectlyExecutable：win32 六形态全 true，目录/缺 stat 一律 false（AC-1 / AC-4）', () => {
  const sixForms = ['dop.exe', 'dop', 'dop.cmd', 'dop.ps1', 'dop.bat', 'dop.com'];
  for (const name of sixForms) {
    assert.equal(
      isDirectlyExecutable({ path: `C:\\tools\\${name}`, platform: WIN, stat: asFile() }),
      true,
      `win32 不再按后缀拒收：${name} 只要是普通文件就可存可发现`,
    );
  }
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\DOP.EXE', platform: WIN, stat: asFile() }), true, '大小写不敏感');
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.vbs', platform: WIN, stat: asFile() }), true, '.vbs 可存（运行期归因负责解释它起不来）');
  assert.equal(
    isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: { isFile: () => true } }),
    true,
    'win32 不看 mode（Windows 没有 POSIX 执行位）',
  );
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: asDir() }), false, '目录不是可直接启动入口');
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: undefined }), false);
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: null }), false);
  assert.equal(isDirectlyExecutable({ path: 'C:\\tools\\dop.exe', platform: WIN, stat: { isFile: 'yes' } }), false, 'isFile 不是函数视为不可判定');
  assert.equal(isDirectlyExecutable({ path: '', platform: WIN, stat: asFile() }), false);
  assert.equal(isDirectlyExecutable({ path: '   ', platform: WIN, stat: asFile() }), false);
  assert.equal(isDirectlyExecutable({ path: null, platform: WIN, stat: asFile() }), false);
  assert.equal(isDirectlyExecutable({ platform: WIN, stat: asFile() }), false, '路径缺失');
  assert.equal(isDirectlyExecutable(), false, '不传参不抛错，返回 false');
});

test('isDirectlyExecutable：POSIX 执行位矩阵与 r3 逐条一致（POSIX 行为零变化）', () => {
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o755) }), true);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o750) }), true, 'group 执行位也算');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o705) }), true, 'other 执行位也算');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o700) }), true);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o644) }), false, '没有执行位');
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o444) }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asFile(0o000) }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: asDir() }), false);
  assert.equal(isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: undefined }), false);
  assert.equal(
    isDirectlyExecutable({ path: '/opt/dop', platform: POSIX, stat: { isFile: () => true } }),
    false,
    'mode 缺失视为不可判定（POSIX 认执行位）',
  );
  assert.equal(
    isDirectlyExecutable({ path: '/opt/dop.cmd', platform: POSIX, stat: asFile(0o755) }),
    false,
    'POSIX 上包装脚本仍不选：不带 shell 起不来，口径不变',
  );
  assert.equal(isDirectlyExecutable({ path: '/opt/dop.exe', platform: POSIX, stat: asFile(0o755) }), true, 'POSIX 上 .exe 只看执行位');
  assert.equal(isDirectlyExecutable({ path: '/opt', platform: POSIX, stat: asFile(0o755) }), true, '判定只看注入的 stat，不做 basename 白名单');
});

// 未启动归因与脱敏（原 describeSpawnFailure / redactPathLike 用例）已随实现迁到
// test/failure-face.test.mjs（r9 / AC-5：渲染只一处）。本文件从此只证形态与可执行判定。


test('零 IO / 零子进程 / 唯一依赖 node:path（AC-2 / AC-4 静态守门）', () => {
  const text = readFileSync(MODULE_FILE, 'utf8');
  const imports = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:path'], '纯模块只允许 node:path（basename），文件系统必须由调用方注入');
  const banned = [
    [/\bchild_process\b/u, 'child_process'],
    [/\b(?:readFileSync|statSync|existsSync|readdirSync)\s*\(/u, '文件系统读取'],
    [/\bprocess\.env\b/u, '环境变量（形态判定不该看环境）'],
    [/shell\s*:\s*true/u, 'shell:true'],
  ];
  const hits = banned.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `entry-form 必须保持纯函数：${hits.join('; ')}`);
  assert.match(text, /export\s+const\s+WRAPPER_SUFFIXES\b/u, '词表的唯一定义点在这里');
  assert.match(text, /export\s+function\s+isDirectlyExecutable\b/u, '「可直接启动」的唯一定义点在这里');
});
