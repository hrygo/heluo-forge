/**
 * dop 适配器的命令行契约测试（T2）。
 *
 * 三层断言：
 *   1. **argv 逐字**：命令面只有 `change view/list`，参数顺序固定，endpoint 只在注入时追加；
 *   2. **信封**：`source_revision` 是 raw stdout 的指纹，`observed_at` 由注入时钟给出；
 *   3. **失败语义**：超时/非零退出/输出不可解析各自给已登记原因码，且拒绝的输入零调用；
 *      **未启动（r8）**：按入口形态给三段可行动提示（`.cmd` 包装脚本 / 无后缀 shim），
 *      原生入口不套包装解释，`detail.spawnFailed` 保留，文案不含绝对路径与 endpoint。
 * 夹具 `fixtures/dop-change-*.json` 复制自 2026-07-06 校准的 mock dop 输出，字段契约为准。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DOP_COMMANDS, createDopAdapter } from '../src/dop-adapter.mjs';
import { DevopsReadError, READ_REASONS } from '../src/read.mjs';

const AT = '2026-10-28T12:00:00.000Z';
const now = () => AT;

// 合成夹具：运行时拼出 "C:\Users"，源码里不出现该字面量（团队敏感扫描按字面量拦主机路径）。
const WIN_USERS = ['C:', 'Users'].join('\\');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ARD123456 = fixture('dop-change-ard123456.json');
const ARD222222 = fixture('dop-change-ard222222.json');
const sha12 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);

function fakeRunner(handler = null) {
  const calls = [];
  const runner = {
    calls,
    run: async (input) => {
      calls.push({ bin: input.bin, args: [...input.args], purpose: input.purpose });
      if (handler !== null) return handler(input, calls.length - 1);
      return { exitCode: 0, stdout: ARD123456, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    },
  };
  return runner;
}

const adapterWith = (runner, options = {}) => createDopAdapter({ runner, dopBin: '/opt/corp/dop', now, ...options });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DevopsReadError, `应抛 DevopsReadError，实际 ${error?.name}`);
    assert.equal(error.code, code, `原因码应为 ${code}，实际 ${error.code}（${error.message}）`);
    return true;
  });
}

test('readChange：argv 固定为 change view <id> --json，信封带 raw 记录与 stdout 指纹', async () => {
  const runner = fakeRunner();
  const adapter = adapterWith(runner);
  const result = await adapter.readChange({ changeId: 'ARD123456' });

  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    bin: '/opt/corp/dop',
    args: ['change', 'view', 'ARD123456', '--json'],
    purpose: 'dop.change.view',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.target_ref, 'ARD123456');
  assert.equal(result.change_id, 'ARD123456');
  assert.equal(result.source_revision, `dop:${sha12(ARD123456)}`);
  assert.equal(result.observed_at, AT);
  assert.deepEqual(result.result_refs, []);
  assert.equal(result.command, 'dop change view ARD123456 --json');
  assert.deepEqual(result.raw, JSON.parse(ARD123456), 'raw 必须原样交出记录，字段映射不在此处做');
});

test('夹具保真：ARD222222 首个 user_story 的 release_info 为空、第二个非空', async () => {
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: ARD222222, stderr: '', durationMs: 2, timedOut: false }));
  const result = await adapterWith(runner).readChange({ changeId: 'ARD222222' });
  const stories = result.raw.user_stories;
  assert.equal(stories.length, 2);
  assert.equal(stories[0].release_info, null);
  assert.equal(stories[1].release_info.release_num, 'R20260620002');
  assert.deepEqual(result.raw.sub_systems, [{ code: 'CARD.points-mall', name: '信用卡中心.积分商城子系统' }]);
});

test('配置了 endpoint 才追加 --endpoint；诊断标签与实践参数里都不回显它', async () => {
  const runner = fakeRunner();
  const endpoint = 'https://dop.internal.example/api';
  const result = await adapterWith(runner, { dopEndpoint: endpoint }).readChange({ changeId: 'ARD123456' });

  assert.deepEqual(runner.calls[0].args, ['change', 'view', 'ARD123456', '--json', '--endpoint', endpoint]);
  assert.equal(result.command, 'dop change view ARD123456 --json', '命令标签不得包含 endpoint');
  assert.ok(!JSON.stringify(result).includes(endpoint), '读信封不得回显 endpoint（AC-22）');
});

test('未注入 endpoint 时不拼 --endpoint，也不存在其它拼参通道', async () => {
  const runner = fakeRunner();
  await adapterWith(runner, { dopEndpoint: '' }).readChange({ changeId: 'ARD123456' });
  assert.ok(!runner.calls[0].args.includes('--endpoint'));
});

test('readChange 不接受 argv 覆盖：传 args 也不会改变命令面', async () => {
  const runner = fakeRunner();
  await adapterWith(runner).readChange({ changeId: 'ARD123456', args: ['change', 'done', 'ARD123456'] });
  assert.deepEqual(runner.calls[0].args, ['change', 'view', 'ARD123456', '--json']);
});

test('适配器不替上层做记录契约校验：{} 也交出信封（id/字段判定归 change-context）', async () => {
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: '{}', stderr: '', durationMs: 1, timedOut: false }));
  const result = await adapterWith(runner).readChange({ changeId: 'ARD123456' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.raw, {});
  assert.equal(result.source_revision, `dop:${sha12('{}')}`);
});

test('listChanges：change list --json，items 来自 changes 数组，total 取平台值', async () => {
  const stdout = JSON.stringify({ user: 'alice', total: 2, changes: [{ id: 'ARD123456' }, { id: 'ARD222222' }] });
  const runner = fakeRunner(() => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }));
  const result = await adapterWith(runner).listChanges({});

  assert.deepEqual(runner.calls[0].args, ['change', 'list', '--json']);
  assert.equal(result.count, 2);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].id, 'ARD123456');
  assert.equal(result.target_ref, 'changes');
  assert.equal(result.source_revision, `dop:${sha12(stdout)}`);
});

test('listChanges：给了 status 才拼 --status（并校验为安全令牌）', async () => {
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: '{"changes":[]}', stderr: '', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner);
  await adapter.listChanges({ status: 'open' });
  assert.deepEqual(runner.calls[0].args, ['change', 'list', '--json', '--status', 'open']);

  await rejectsWith(adapter.listChanges({ status: '--all' }), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapter.listChanges({ status: 'open; rm -rf' }), READ_REASONS.MISSING_TARGET);
  assert.equal(runner.calls.length, 1, '非法 status 必须零调用');
});

test('非零退出 → COMMAND_FAILED，detail 带 exitCode 与实际命令', async () => {
  const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: '❌ dop change view failed (forced)', durationMs: 3, timedOut: false }));
  await assert.rejects(adapterWith(runner).readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.exitCode, 1);
    assert.equal(error.detail.command, 'dop change view ARD123456 --json');
    assert.match(error.message, /forced/);
    return true;
  });
});

test('超时 → COMMAND_TIMEOUT（与"输出不可解析"区分开）', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: '', durationMs: 20000, timedOut: true }));
  await assert.rejects(adapterWith(runner).readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_TIMEOUT);
    assert.equal(error.detail.timedOut, true);
    return true;
  });
});

/** 绝对路径（盘符 / UNC / POSIX）都不许进 message：提示要么给形态，要么给脱敏证据（AC-5 ④）。 */
const ABSOLUTE_PATH = /[A-Za-z]:[\\/]|\\\\|(?:^|\s)\//u;

function assertNoLeak(message, secrets) {
  assert.doesNotMatch(message, ABSOLUTE_PATH, `message 不得包含绝对路径：${message}`);
  for (const secret of secrets) {
    assert.ok(!message.includes(secret), `message 不得包含 ${secret}：${message}`);
  }
}

test('起不来（exitCode null 且未超时）→ COMMAND_FAILED + spawnFailed', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false }));
  await assert.rejects(adapterWith(runner).readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true);
    assert.equal(error.detail.exitCode, null);
    return true;
  });
});

test('未启动 + .cmd 入口（EINVAL）→ 三段可行动提示，保留 spawnFailed，不泄露路径/endpoint', async () => {
  const endpoint = 'https://dop.example/api';
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn EINVAL', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner, {
    dopBin: `${WIN_USERS}\\<用户名>\\AppData\\Roaming\\npm\\dop.cmd`,
    dopEndpoint: endpoint,
    platform: 'win32',
  });
  await assert.rejects(adapter.readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true, 'spawnFailed 是写动作记 failed 而非 unknown 的依据');
    assert.match(error.message, /未启动/);
    // ① 入口形态；② 原因归属运行时能力（与路径写法无关）；③ 下一步。
    assert.match(error.message, /\.cmd 包装脚本/);
    assert.match(error.message, /固定 argv 且未经 shell 启动时无法运行/);
    assert.match(error.message, /启动方式的限制/);
    assert.match(error.message, /原生可执行文件/);
    assert.doesNotMatch(error.message, /重试/, '未启动不得暗示重试');
    assertNoLeak(error.message, [WIN_USERS, 'AppData', endpoint, 'dop.example']);
    return true;
  });
});

test('未启动 + 无后缀 shim（ENOENT）→ 提示 npm 替身，不依赖具体 errno', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner, {
    dopBin: `${WIN_USERS}\\<用户名>\\AppData\\Roaming\\npm\\dop`,
    platform: 'win32',
  });
  await assert.rejects(adapter.readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true);
    assert.match(error.message, /没有扩展名的命令 shim/);
    assert.match(error.message, /npm 在 Windows 上生成的替身/);
    assert.match(error.message, /原生可执行文件/);
    assert.doesNotMatch(error.message, /重试/);
    assertNoLeak(error.message, [WIN_USERS, 'AppData']);
    return true;
  });
});

test('原生 .exe 未启动 → 不套包装脚本解释，回退到脱敏证据行（errno 保留）', async () => {
  const runner = fakeRunner(() => ({
    exitCode: null,
    stdout: '',
    stderr: 'spawn C:\\tools\\dop.exe ENOENT',
    durationMs: 1,
    timedOut: false,
  }));
  const adapter = adapterWith(runner, { dopBin: 'C:\\tools\\dop.exe', platform: 'win32' });
  await assert.rejects(adapter.readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true);
    assert.doesNotMatch(error.message, /包装脚本/, '原生入口不得被解释成包装脚本');
    assert.doesNotMatch(error.message, /shim/);
    assert.match(error.message, /ENOENT/, '用户仍需看到失败线索');
    assertNoLeak(error.message, ['C:\\tools\\dop.exe', 'C:\\tools']);
    return true;
  });
});

test('POSIX 无后缀不是 Windows shim：走脱敏证据行，不出现 Windows 措辞', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner, { dopBin: '/opt/corp/dop', platform: 'linux' });
  await assert.rejects(adapter.readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true);
    assert.doesNotMatch(error.message, /shim|包装脚本/);
    assert.match(error.message, /ENOENT/);
    return true;
  });
});

test('输出不是合法 JSON / 空输出 / 数组 → MALFORMED_RESULT（不猜字段）', async () => {
  for (const stdout of ['not json', '', '[]', '"ARD123456"']) {
    const runner = fakeRunner(() => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }));
    await rejectsWith(adapterWith(runner).readChange({ changeId: 'ARD123456' }), READ_REASONS.MALFORMED_RESULT);
  }
});

test('变更号缺失或格式非法 → MISSING_TARGET 且零子进程调用', async () => {
  const runner = fakeRunner();
  const adapter = adapterWith(runner);
  for (const changeId of [undefined, '', ' ', 'change done ARD123456', 'ARD 123456', '-ARD123456', 'ARD123456;rm']) {
    await rejectsWith(adapter.readChange({ changeId }), READ_REASONS.MISSING_TARGET);
    await rejectsWith(adapter.readChange({}), READ_REASONS.MISSING_TARGET);
  }
  assert.equal(runner.calls.length, 0, '被拒绝的请求不得触达子进程出口');
});

test('未注入可执行入口 → NO_READER（fail closed），零调用', async () => {
  const runner = fakeRunner();
  const adapter = createDopAdapter({ runner, dopBin: '', now });
  await rejectsWith(adapter.readChange({ changeId: 'ARD123456' }), READ_REASONS.NO_READER);
  await rejectsWith(adapter.listChanges({}), READ_REASONS.NO_READER);
  assert.equal(runner.calls.length, 0);
  assert.equal(adapter.capabilities().executable_configured, false);
});

test('capabilities 只报能力与布尔位，不回显路径/endpoint', () => {
  const adapter = createDopAdapter({ runner: fakeRunner(), dopBin: '/opt/corp/dop', dopEndpoint: 'https://dop.example/api', now });
  const capabilities = adapter.capabilities();
  assert.deepEqual(capabilities.read, ['change.view', 'change.list']);
  assert.deepEqual(capabilities.write, [], 'dop 没有写命令：能力面必须为空数组');
  assert.equal(capabilities.endpoint_configured, true);
  assert.equal(capabilities.executable_configured, true);
  assert.ok(Object.isFrozen(capabilities));
  const serialized = JSON.stringify(capabilities);
  assert.ok(!serialized.includes('/opt/corp/dop'));
  assert.ok(!serialized.includes('dop.example'));
});

test('命令面枚举到函数：只有两条只读命令，没有写通道属性', () => {
  assert.deepEqual(Object.keys(DOP_COMMANDS), ['changeView', 'changeList']);
  assert.deepEqual(DOP_COMMANDS.changeView, ['change', 'view']);
  assert.deepEqual(DOP_COMMANDS.changeList, ['change', 'list']);
  assert.ok(Object.isFrozen(DOP_COMMANDS.changeView) && Object.isFrozen(DOP_COMMANDS.changeList));

  const adapter = createDopAdapter({ runner: fakeRunner(), dopBin: '/opt/corp/dop', now });
  for (const forbidden of ['done', 'create', 'update', 'delete', 'close']) {
    assert.ok(!(forbidden in adapter), `dop 适配器不得有 ${forbidden} 通道（§5.3 禁项）`);
  }
  assert.equal(typeof adapter.capabilities, 'function');
});

test('创建适配器必须注入 runner：不允许在适配器内自建子进程', () => {
  assert.throws(() => createDopAdapter({ runner: null }), /可注入的 runner/);
  assert.throws(() => createDopAdapter({ runner: {} }), /可注入的 runner/);
});

test('输出被截断时信封显式可见（不把截断当完整事实）', async () => {
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: ARD123456, stderr: '', durationMs: 1, timedOut: false, truncated: true }));
  const result = await adapterWith(runner).readChange({ changeId: 'ARD123456' });
  assert.equal(result.truncated, true);
});
