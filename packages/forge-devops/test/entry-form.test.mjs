/**
 * T1(r8) 入口形态单点模块（AC-2 / AC-4 / AC-5）：`src/entry-form.mjs` 的自证。
 *
 * 这个模块被保存侧、发现侧与两个运行期适配器共读，所以本文件测的不是"某个调用方的行为"，
 * 而是**规则本身**：后缀词表、四形态分类、两平台可执行判定、未启动归因与脱敏。
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
  describeSpawnFailure,
  entryFormOf,
  isDirectlyExecutable,
  redactPathLike,
  wrapperSuffixOf,
} from '../src/entry-form.mjs';

const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'entry-form.mjs');

/** 假 stat：`mode` 只在 POSIX 有意义，但两个平台都带上，避免用例随宿主不同而漂移。 */
const asFile = (mode = 0o644) => ({ isFile: () => true, mode });
const asDir = () => ({ isFile: () => false, mode: 0o755 });

/** 提示行里不允许出现的机器痕迹：盘符、UNC、POSIX 绝对路径、endpoint、重试字样。 */
const LEAKS = [
  [/[A-Za-z]:\\/u, 'Windows 盘符路径'],
  [/\\\\[A-Za-z]/u, 'UNC 路径'],
  [/(?:^|\s)\/[A-Za-z]/u, 'POSIX 绝对路径'],
  [/https?:\/\//u, 'endpoint'],
  [/重试/u, '"重试"字样（写动作不重放，文案不得暗示）'],
];

function leaksOf(text) {
  return LEAKS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

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

test('describeSpawnFailure：包装脚本三段归因、按实际后缀点名、无路径无 endpoint（AC-5）', () => {
  for (const suffix of WRAPPER_SUFFIXES) {
    const line = describeSpawnFailure({
      bin: `C:\\tools\\dop${suffix}`,
      platform: WIN,
      evidence: 'spawn C:\\tools\\dop EINVAL',
    });
    assert.match(line, new RegExp(`包装脚本`, 'u'), '①入口形态判断');
    assert.ok(line.includes(suffix), `①要点名实际命中的后缀：${suffix}`);
    assert.match(line, /固定 argv 且未经 shell 启动时无法运行/u, '②原因归属运行时能力');
    assert.match(line, /与路径写法无关/u, '②明确不是路径写法问题（用户原话的核心诉求）');
    assert.match(line, /原生可执行文件/u, '③下一步指向原生入口');
    assert.match(line, /提供原生二进制的安装方式/u, '③下一步：换安装方式');
    assert.deepEqual(leaksOf(line), [], `${suffix} 提示不得含路径/endpoint/重试：${line}`);
    assert.ok(line.length <= 200, `提示行不得超过 200 字符：${line.length}`);
  }
  // 归因不依赖 errno：同一句文案，EINVAL 与 ENOENT 各来一次。
  for (const errno of ['spawn EINVAL', 'spawn ENOENT', '']) {
    const line = describeSpawnFailure({ bin: 'C:\\tools\\dop.cmd', platform: WIN, evidence: errno });
    assert.match(line, /包装脚本/u, `errno 变化不该改变归因（${errno || '空证据'}）`);
  }
});

test('describeSpawnFailure：win32 无后缀 shim 独立措辞；原生入口绝不套用包装解释（AC-5）', () => {
  const shim = describeSpawnFailure({
    bin: 'C:\\Users\\me\\AppData\\Roaming\\npm\\dop', // security-scan: allow（夹具：合成路径，用户名是占位符 me）
    platform: WIN,
    evidence: 'spawn C:\\Users\\me\\AppData\\Roaming\\npm\\dop ENOENT', // security-scan: allow（夹具：合成路径，用户名是占位符 me）
  });
  assert.match(shim, /没有扩展名的命令 shim/u, '①形态判断：无扩展名 shim');
  assert.match(shim, /npm 在 Windows 上生成的替身/u, '①点名来源');
  assert.match(shim, /Git Bash/u, '①覆盖另一种可能来源');
  assert.match(shim, /固定 argv 且未经 shell 启动时无法运行/u, '②原因');
  assert.match(shim, /原生可执行文件/u, '③下一步');
  assert.deepEqual(leaksOf(shim), [], `无后缀提示不得含路径/endpoint：${shim}`);

  // 原生入口失败：只回显脱敏后的证据，不解释成包装脚本。
  const native = describeSpawnFailure({
    bin: 'C:\\tools\\dop.exe',
    platform: WIN,
    evidence: 'spawn C:\\tools\\dop.exe EACCES',
  });
  assert.equal(/包装脚本|shim/u.test(native), false, '.exe 启动失败不得套用包装脚本解释');
  assert.match(native, /EACCES/u, '证据行的 errno 要留住');
  assert.match(native, /<路径>/u, '证据里的路径要脱敏');
  assert.equal(native.includes('C:\\tools'), false, '不得回显机器路径');

  // POSIX 上无后缀是 native：同样走证据行，不套 shim 措辞。
  const posix = describeSpawnFailure({ bin: '/opt/dop', platform: POSIX, evidence: 'spawn /opt/dop EACCES' });
  assert.equal(/shim|包装脚本/u.test(posix), false, 'POSIX 无后缀不是 shim');
  assert.equal(posix.includes('/opt/dop'), false, 'POSIX 绝对路径同样脱敏');
  assert.match(posix, /EACCES/u);

  // other（`.sh` 等）：不猜测，回显证据。
  const other = describeSpawnFailure({ bin: 'C:\\tools\\dop.sh', platform: WIN, evidence: 'spawn EINVAL' });
  assert.equal(/包装脚本|shim/u.test(other), false, 'other 形态不替用户臆断原因');
  assert.match(other, /EINVAL/u);

  // 证据为空：给一句人话，不能是空串或 "undefined"。
  for (const empty of [undefined, null, '', '   ']) {
    assert.equal(describeSpawnFailure({ bin: 'C:\\tools\\dop.exe', platform: WIN, evidence: empty }), '进程未能启动');
  }
  assert.equal(describeSpawnFailure(), '进程未能启动', '不传参也不得抛错');
  // 提示按平台归因，与 errno 无关：同一 .cmd 在 win32 与 POSIX 都给包装脚本解释。
  assert.match(describeSpawnFailure({ bin: '/opt/dop.cmd', platform: POSIX, evidence: 'spawn EINVAL' }), /包装脚本/u);
});

test('redactPathLike：盘符 / UNC / POSIX 绝对路径 / endpoint 全部脱敏，纯文本原样（AC-5 ④）', () => {
  assert.equal(redactPathLike('spawn C:\\tools\\dop.exe EACCES'), 'spawn <路径> EACCES');
  assert.equal(redactPathLike('spawn C:/tools/dop.exe EACCES'), 'spawn <路径> EACCES', '正斜杠盘符路径同样处理');
  assert.equal(redactPathLike('open \\\\fileserver\\share\\dop.exe failed'), 'open <路径> failed', 'UNC 路径');
  assert.equal(redactPathLike('exec /usr/local/bin/dop EACCES'), 'exec <路径> EACCES', 'POSIX 绝对路径');
  assert.equal(redactPathLike('exec (/usr/local/bin/dop) EACCES'), 'exec <路径> EACCES', '被括号包住也算');
  assert.equal(
    redactPathLike('spawn C:\\Program Files\\nodejs\\dop.exe ENOENT'),
    'spawn <路径> ENOENT',
    '路径带空格时按续片吞掉，errno 保留',
  );
  assert.equal(redactPathLike('connect https://corp.example/api/dop expired'), 'connect <地址> expired', 'endpoint 不落到提示里');
  assert.equal(redactPathLike('spawn EINVAL'), 'spawn EINVAL', '纯文本不得被改写');
  assert.equal(redactPathLike('这是中文说明'), '这是中文说明');
  assert.equal(redactPathLike(''), '', '空串');
  assert.equal(redactPathLike('   '), '');
  assert.equal(redactPathLike(null), '', '非字符串返回空串，调用方走兜底文案');
  assert.equal(redactPathLike(undefined), '');
  assert.equal(redactPathLike(42), '');
  assert.equal(redactPathLike('C:\\tools\\dop.exe'), '<路径>', '整行只有路径时不留空壳');
  // 截断：上限 200 字符，超出以省略号收尾。
  const long = redactPathLike(`${'很长的一行说明'.repeat(60)}`);
  assert.ok(long.length <= 200, `截断后不得超过 200 字符：${long.length}`);
  assert.ok(long.endsWith('…'), '截断要留可辨识的省略号');
  const longWithPath = redactPathLike(`C:\\tools\\dop.exe ${'x'.repeat(400)}`);
  assert.equal(longWithPath.includes('C:\\tools'), false, '截断不能把路径留在前半段');
  assert.ok(longWithPath.length <= 200);
});

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
