/**
 * T1(r9) 失败面单点模块：`src/failure-face.mjs` 的自证（AC-1 / AC-2 / AC-3 / AC-5）。
 *
 * 三个用户可见出口（读信封 message、写动作结果、变更卡片）共用这一处渲染，所以这里测的是
 * **唯一口径本身**：三类文案、`.exe` 不套包装解释、脱敏矩阵、"未启动不读证据"的结构保证。
 * 全部离线，不碰文件系统与子进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAILURE_CODE,
  SPAWN_CATEGORIES,
  SPAWN_FAILURE_REASON,
  failureFaceOf,
  failureMessageOf,
  redactFailureText,
  spawnFailureFace,
  toolFailureOf,
  writeFailureOf,
} from '../src/failure-face.mjs';
import { CLI_PAGE_HINT } from '../src/cli-config.mjs';
import { READ_REASONS } from '../src/read.mjs';

const WIN = 'win32';
const POSIX = 'linux';
const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'failure-face.mjs');

/** 提示行里不允许出现的机器痕迹：盘符、UNC、POSIX 绝对路径、endpoint、errno。 */
const LEAKS = [
  [/[A-Za-z]:[\\/]/u, 'Windows 盘符路径'],
  [/\\\\[A-Za-z]/u, 'UNC 路径'],
  [/(?:^|\s)\/[A-Za-z]/u, 'POSIX 绝对路径'],
  [/https?:\/\//u, 'endpoint'],
  [/\b(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+)\b/u, 'errno'],
];

function leaksOf(value) {
  assert.equal(typeof value, 'string', '只对已序列化的文本做泄漏检查');
  return LEAKS.filter(([pattern]) => pattern.test(value)).map(([, label]) => label);
}

function assertClean(value, label) {
  assert.deepEqual(leaksOf(value), [], `${label} 不得含机器痕迹：${value}`);
}

const WIN_HOME = ['C:', 'Users', '<用户名>', 'AppData', 'Roaming', 'npm'].join('\\');

test('常量与词表：细因 CLI_SPAWN_FAILED、三类别冻结、错误码与读面词表同源', () => {
  assert.equal(SPAWN_FAILURE_REASON, 'CLI_SPAWN_FAILED');
  assert.deepEqual([...Object.values(SPAWN_CATEGORIES)].sort(), ['EXTENSIONLESS_SHIM', 'NATIVE_ENTRY', 'WRAPPER_SCRIPT']);
  assert.ok(Object.isFrozen(SPAWN_CATEGORIES));
  // 字面量而非 import（避免 read.mjs ↔ failure-face.mjs 成环）：用等值断言守住两份不漂移。
  assert.equal(FAILURE_CODE, READ_REASONS.COMMAND_FAILED, '信封错误码必须仍是词表里的 COMMAND_FAILED（§3.4）');
});

test('spawnFailureFace：包装脚本三类后缀 → WRAPPER_SCRIPT，点名后缀并给同源页面指引', () => {
  for (const suffix of ['.cmd', '.bat', '.ps1', '.com', '.vbs']) {
    const face = spawnFailureFace({ bin: `C:\\tools\\dop${suffix}`, platform: WIN });
    assert.equal(face.reason, 'CLI_SPAWN_FAILED');
    assert.equal(face.category, SPAWN_CATEGORIES.WRAPPER_SCRIPT);
    assert.ok(face.message.includes(suffix), `①要点名实际命中的后缀：${face.message}`);
    assert.match(face.message, /包装脚本/u);
    assert.match(face.message, /固定 argv 且未经 shell 无法启动脚本/u, '②原因归属启动方式，不归给路径写法');
    assert.match(face.message, /原生可执行文件/u, '③下一步指向原生入口');
    assert.equal(face.next, CLI_PAGE_HINT, 'next 与 NO_READER 的指引同源');
    assert.ok(face.message.includes(CLI_PAGE_HINT));
    assert.doesNotMatch(face.message, /重试/u, '未启动不得暗示重试');
    assertClean(face.message, `${suffix} 提示`);
    assertClean(JSON.stringify(face), `${suffix} 失败面`);
    assert.ok(face.message.length <= 200, `提示行不得超过 200 字符：${face.message.length}`);
  }
});

test('spawnFailureFace：形态归因与 errno 无关，大小写不敏感', () => {
  for (const bin of ['C:\\tools\\dop.CMD', 'C:\\tools\\dop.Cmd']) {
    assert.equal(spawnFailureFace({ bin, platform: WIN }).category, SPAWN_CATEGORIES.WRAPPER_SCRIPT);
  }
  // 同一 .cmd 在 POSIX 上判成包装脚本（形态来自后缀，与宿主平台无关）。
  assert.equal(spawnFailureFace({ bin: '/opt/dop.cmd', platform: POSIX }).category, SPAWN_CATEGORIES.WRAPPER_SCRIPT);
});

test('spawnFailureFace：win32 无后缀 shim 独立措辞；POSIX 无后缀是原生入口', () => {
  const shim = spawnFailureFace({ bin: `${WIN_HOME}\\dop`, platform: WIN });
  assert.equal(shim.category, SPAWN_CATEGORIES.EXTENSIONLESS_SHIM);
  assert.match(shim.message, /npm 生成的无后缀 shim/u, '①形态判断：无后缀 shim');
  assert.match(shim.message, /固定 argv 且未经 shell 无法启动脚本/u, '②原因');
  assert.match(shim.message, /原生可执行文件/u, '③下一步');
  assertClean(shim.message, '无后缀提示');

  const posix = spawnFailureFace({ bin: '/opt/corp/dop', platform: POSIX });
  assert.equal(posix.category, SPAWN_CATEGORIES.NATIVE_ENTRY, 'POSIX 无后缀是原生可执行文件，不套 Windows shim');
  assert.doesNotMatch(posix.message, /shim|包装脚本/u);
  assertClean(posix.message, 'POSIX 原生提示');
});

test('spawnFailureFace：.exe 与 .sh 绝不套包装脚本解释，不替用户臆断原因', () => {
  for (const bin of ['C:\\tools\\dop.exe', 'C:\\tools\\dop.sh', 'C:\\tools\\dop.mjs']) {
    const face = spawnFailureFace({ bin, platform: WIN });
    assert.equal(face.category, SPAWN_CATEGORIES.NATIVE_ENTRY, `${bin} 归入原生入口`);
    assert.doesNotMatch(face.message, /包装脚本|shim/u, `${bin} 不得被解释成包装脚本`);
    assert.match(face.message, /入口未能启动/u);
  }
  // 不传参也不得抛错（失败面自身绝不能再失败）。
  assert.equal(spawnFailureFace().category, SPAWN_CATEGORIES.NATIVE_ENTRY);
});

test('failureFaceOf：未启动只吃入口形态与 exitCode，六种证据注入对出口零影响（AC-2 结构保证）', () => {
  const bin = `${WIN_HOME}\\dop.cmd`;
  const injections = [
    'spawn EINVAL',
    'spawn ENOENT',
    'spawn EACCES',
    `spawn ${WIN_HOME}\\dop.cmd EINVAL`,
    'spawn \\\\fileserver\\share\\dop.exe ENOENT',
    'connect https://dop.example/api expired',
    'open ../rel/dop failed',
  ];
  const faces = injections.map((evidence) =>
    failureFaceOf({ command: 'dop change view ARD123456 --json', bin, platform: WIN, exitCode: null, evidence, observedAt: '2026-11-02T00:00:00.000Z' }),
  );
  const serialized = faces.map((face) => JSON.stringify(face));
  for (const value of serialized) {
    assert.equal(value, serialized[0], '未启动的出口与证据行逐字节无关（证据压根不进这个分支）');
    assert.doesNotMatch(value, /E[0-9A-Z]{2,}|ENOENT|EINVAL|EACCES/u, 'errno 不得出现');
    assert.doesNotMatch(value, /https?:|\\\\|[A-Za-z]:\\/u, '路径 / endpoint 不得出现');
  }
  const face = faces[0];
  assert.equal(face.code, READ_REASONS.COMMAND_FAILED, '信封错误码词表不变');
  assert.equal(face.detail.reason, 'CLI_SPAWN_FAILED');
  assert.equal(face.detail.category, SPAWN_CATEGORIES.WRAPPER_SCRIPT);
  assert.equal(face.detail.next, CLI_PAGE_HINT);
  assert.equal(face.detail.spawnFailed, true, '写动作据此记 failed（无副作用）');
  assert.equal(face.detail.command, 'dop change view ARD123456 --json');
  assert.ok(!('exitCode' in face.detail), '未启动的 detail 不带退出码');
  assert.equal(face.detail.suffix, '.cmd', '包装脚本类别回显命中的后缀');
});

test('failureFaceOf：非零退出 → 脱敏证据行进 detail，退出码单独成字段', () => {
  const face = failureFaceOf({
    command: 'dop change view ARD123456 --json',
    bin: '/opt/corp/dop',
    platform: POSIX,
    exitCode: 3,
    evidence: 'Error: connect https://dop.example/api failed: open /opt/corp/dop EACCES',
    observedAt: '2026-11-02T00:00:00.000Z',
  });
  assert.equal(face.code, READ_REASONS.COMMAND_FAILED);
  assert.equal(face.detail.spawnFailed, false);
  assert.equal(face.detail.exitCode, 3);
  assert.match(face.message, /退出码 3/u);
  assert.match(face.message, /<地址>/u);
  assert.match(face.message, /<路径>/u);
  assert.match(face.message, /<错误码>/u);
  assertClean(face.message, '非零退出提示');
  assertClean(JSON.stringify(face.detail), '非零退出 detail');

  // 空证据给一句人话，不能是空串或 "undefined"。
  const empty = failureFaceOf({ command: 'dop change view', bin: 'dop', exitCode: 1, evidence: '   ' });
  assert.match(empty.message, /无输出/u);
});

test('failureMessageOf：未启动不读 error.message，其他失败去前缀且只在证据段脱敏', () => {
  // ① 注入桩/第三方适配器把原始 Node 报错塞进 message：出口仍按类别重建，路径一个字都不出现。
  const spawnError = Object.assign(new Error('ENOENT: no such file, open C:\\tools\\dop.cmd'), {
    code: 'COMMAND_FAILED',
    detail: { success: false, spawnFailed: true, category: 'WRAPPER_SCRIPT', suffix: '.cmd', next: CLI_PAGE_HINT, command: 'dop change view CHG-1' },
  });
  const rebuilt = failureMessageOf(spawnError);
  assert.match(rebuilt, /dop change view CHG-1 未启动/u);
  assert.match(rebuilt, /包装脚本/u);
  assertClean(rebuilt, '未启动重建文案');

  // ② `<命令> 失败（退出码 N）：<证据>`：前缀去掉，命令标签与 target 原样，证据段脱敏。
  const failed = new Error('COMMAND_FAILED: gh pr view acme/ard-sdk#12 失败（退出码 1）：open C:\\tools\\gh.exe ENOENT');
  assert.equal(failureMessageOf(failed), 'gh pr view acme/ard-sdk#12 失败（退出码 1）：open <路径> <错误码>');

  // ③ 没有证据段：只收绝对路径/URI/errno，target 的相对片段不得被抹掉。
  assert.equal(failureMessageOf(new Error('COMMAND_FAILED: acme/ard-sdk#12 无法解析')), 'acme/ard-sdk#12 无法解析');

  // ④ 空消息与无 message 的错误。
  assert.equal(failureMessageOf(new Error('')), '');
  assert.equal(failureMessageOf(new Error('COMMAND_FAILED: ')), '');
  assert.equal(failureMessageOf(undefined), '');
});

test('redactFailureText：盘符 / UNC / POSIX / 相对路径 / endpoint / errno 全覆盖，纯文本原样', () => {
  assert.equal(redactFailureText('spawn C:\\tools\\dop.exe EACCES'), '<路径> <错误码>', '行首 spawn 是 Node 措辞，去掉');
  assert.equal(redactFailureText('spawn C:/tools/dop.exe EACCES'), '<路径> <错误码>', '正斜杠盘符路径同样处理');
  assert.equal(redactFailureText('open \\\\fileserver\\share\\dop.exe failed'), 'open <路径> failed', 'UNC 路径');
  assert.equal(redactFailureText('exec /usr/local/bin/dop EACCES'), 'exec <路径> <错误码>', 'POSIX 绝对路径');
  assert.equal(redactFailureText('exec (/usr/local/bin/dop) EACCES'), 'exec <路径> <错误码>', '被括号包住也算');
  assert.equal(redactFailureText('open C:\\Program Files\\nodejs\\dop.exe failed'), 'open <路径> failed', '带空格路径的续片合并成一个占位符');
  assert.equal(redactFailureText('connect https://corp.example/api/dop expired'), 'connect <地址> expired', 'endpoint 不落到提示里');
  assert.equal(redactFailureText('open ../rel/dop failed'), 'open <路径> failed', '相对路径同样不留');
  assert.equal(redactFailureText('读不到 ARD123456 的变更'), '读不到 ARD123456 的变更', '纯文本不得被改写');
  assert.equal(redactFailureText('spawn EINVAL'), '<错误码>', '只剩 errno 时保留占位符');
  assert.equal(redactFailureText('   '), '');
  for (const value of [null, undefined, 42, {}]) {
    assert.equal(redactFailureText(value), '', '非字符串返回空串，调用方走兜底文案');
  }
  assert.equal(redactFailureText('C:\\tools\\dop.exe'), '<路径>', '整行只有路径时不留空壳');
  // 截断：上限 200 字符，超出以省略号收尾，且不能把路径留在前半段。
  const long = redactFailureText('很长的一行说明'.repeat(60));
  assert.ok(long.length <= 200, `截断后不得超过 200 字符：${long.length}`);
  assert.ok(long.endsWith('…'), '截断要留可辨识的省略号');
  const longWithPath = redactFailureText(`C:\\tools\\dop.exe ${'x'.repeat(400)}`);
  assert.ok(!longWithPath.includes('C:\\tools'), '截断不能把路径留在前半段');
  assert.ok(longWithPath.length <= 200);
  // 连续同名占位符合并，避免噪声。
  assert.equal(redactFailureText('C:\\a C:\\b C:\\c'), '<路径>');
});

test('toolFailureOf：工具出口给结构化 detail（类别 + 下一步），不带路径', () => {
  const error = Object.assign(new Error(`spawn EINVAL ${WIN_HOME}\\dop.cmd`), {
    code: 'COMMAND_FAILED',
    detail: { spawnFailed: true, category: 'WRAPPER_SCRIPT', suffix: '.cmd', next: CLI_PAGE_HINT, command: 'dop change view ARD123456 --json', observedAt: '2026-11-02T00:00:00.000Z' },
  });
  const envelope = toolFailureOf('change.read', error);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.action, 'change.read');
  assert.equal(envelope.reason, 'COMMAND_FAILED', 'reason 沿用动作层原因码');
  assert.equal(envelope.next_action, 'configure-reader', '下一步是去重新选入口');
  assert.deepEqual(Object.keys(envelope.detail).sort(), ['category', 'command', 'next', 'observedAt', 'reason']);
  assert.equal(envelope.detail.reason, 'CLI_SPAWN_FAILED');
  assert.equal(envelope.detail.category, 'WRAPPER_SCRIPT');
  assertClean(JSON.stringify(envelope), '工具失败信封');

  // 缺字段的注入桩不得产生 undefined/空壳。
  const bare = toolFailureOf('change.read', Object.assign(new Error('x'), { code: 'COMMAND_FAILED', detail: { spawnFailed: true } }));
  assert.equal(bare.detail.category, 'NATIVE_ENTRY', '认不出的类别按原生入口说人话');
  assert.equal(bare.detail.next, CLI_PAGE_HINT);
  assert.equal(bare.detail.command, '');
});

test('writeFailureOf：未启动 = failed（无副作用）；其他失败返回 null 交回 unknown 分支', () => {
  const face = writeFailureOf({ code: 'COMMAND_FAILED', detail: { spawnFailed: true, category: 'EXTENSIONLESS_SHIM', next: CLI_PAGE_HINT } }, '创建');
  assert.equal(face.status, 'failed');
  assert.equal(face.reason, 'CLI_SPAWN_FAILED');
  assert.equal(face.category, 'EXTENSIONLESS_SHIM');
  assert.equal(face.next, CLI_PAGE_HINT);
  assert.match(face.detail, /^创建命令未启动（无副作用）：/u);
  assert.match(face.detail, /下一步/u);
  assertClean(face.detail, '写动作失败文案');

  // 超时 / 结果不确定：不是"没启动"，交回既有 unknown 分支（可能已写，转人工核对）。
  assert.equal(writeFailureOf({ code: 'COMMAND_TIMEOUT', detail: { timedOut: true } }, '创建'), null);
  assert.equal(writeFailureOf({ code: 'COMMAND_FAILED', detail: { exitCode: 1, spawnFailed: false } }, '创建'), null);
  assert.equal(writeFailureOf(new Error('boom')), null);
});

test('静态守门：不 import read.mjs（防环）、不碰子进程、不拼 shell', () => {
  const source = readFileSync(MODULE_FILE, 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['./cli-config.mjs', './entry-form.mjs'], '叶子模块只依赖指导引与形态判定');
  assert.ok(!imports.includes('./read.mjs'), '不得 import read.mjs（read.mjs 反向依赖本模块，会成环）');
  assert.doesNotMatch(source, /child_process/u);
  assert.doesNotMatch(source, /shell:\s*true/u);
});
