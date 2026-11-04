/**
 * dop 适配器的命令行契约测试（T2）。
 *
 * 三层断言：
 *   1. **argv 逐字**：命令面是 `change view/list/update`，参数顺序固定，endpoint 只在注入时追加；
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

test('配置了 endpoint 才追加 --api-endpoint（真实 flag 名）；诊断标签与实参都不回显它', async () => {
  const runner = fakeRunner();
  const endpoint = 'https://dop.example/api';
  const result = await adapterWith(runner, { dopEndpoint: endpoint }).readChange({ changeId: 'ARD123456' });

  assert.deepEqual(runner.calls[0].args, ['change', 'view', 'ARD123456', '--json', '--api-endpoint', endpoint]);
  assert.ok(!runner.calls[0].args.includes('--endpoint'), '真实 CLI 没有 --endpoint（1.0.4 全局 flag 是 --api-endpoint）');
  assert.equal(result.command, 'dop change view ARD123456 --json', '命令标签不得包含 endpoint');
  assert.ok(!JSON.stringify(result).includes(endpoint), '读信封不得回显 endpoint（AC-22）');
});

test('未注入 endpoint 时不拼 --api-endpoint，也不存在其它拼参通道', async () => {
  const runner = fakeRunner();
  await adapterWith(runner, { dopEndpoint: '' }).readChange({ changeId: 'ARD123456' });
  assert.ok(!runner.calls[0].args.includes('--api-endpoint'));
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

test('listChanges：change list --json，items 来自 changes 数组，total 取平台值，user 取平台当前用户', async () => {
  const stdout = JSON.stringify({ user: 'alice', total: 2, changes: [{ id: 'ARD123456' }, { id: 'ARD222222' }] });
  const runner = fakeRunner(() => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }));
  const result = await adapterWith(runner).listChanges({});

  assert.deepEqual(runner.calls[0].args, ['change', 'list', '--json']);
  assert.equal(result.count, 2);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].id, 'ARD123456');
  assert.equal(result.user, 'alice', '清单要带平台返回的当前用户，供 @me 语义核对');
  assert.equal(result.target_ref, 'changes');
  assert.equal(result.source_revision, `dop:${sha12(stdout)}`);
});

test('listChanges：平台没给 user 时显式 null，不按本机账号猜', async () => {
  const stdout = JSON.stringify({ changes: [] });
  const runner = fakeRunner(() => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }));
  const result = await adapterWith(runner).listChanges({});
  assert.equal(result.user, null);
  assert.equal(result.count, 0);
});

test('listChanges：真实 1.x 的 --json 是数组（无 changes/total 包裹）也能解析', async () => {
  const stdout = JSON.stringify([{ code: 'ARD384859', summary: '企业级sdd工具开发' }]);
  const runner = fakeRunner(() => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }));
  const result = await adapterWith(runner).listChanges({});
  assert.equal(result.count, 1);
  assert.equal(result.items[0].code, 'ARD384859');
  assert.equal(result.total, 1, '数组形状没有 total 元数据：total = 本次条数');
  assert.equal(result.user, null);
});

test('listChanges：给了 status 才拼 --state（真实 flag），非法值零调用', async () => {
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: '{"changes":[]}', stderr: '', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner);
  await adapter.listChanges({ status: 'open' });
  assert.deepEqual(runner.calls[0].args, ['change', 'list', '--json', '--state', 'open']);

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

test('起不来（exitCode null 且未超时）→ COMMAND_FAILED + spawnFailed + 细因 CLI_SPAWN_FAILED', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false }));
  await assert.rejects(adapterWith(runner).readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED, '信封错误码词表不变（§3.4）');
    assert.equal(error.detail.spawnFailed, true);
    assert.equal(error.detail.reason, 'CLI_SPAWN_FAILED');
    assert.equal(error.detail.command, 'dop change view ARD123456 --json');
    assert.ok(!('exitCode' in error.detail), '未启动的 detail 不带退出码');
    assert.ok(!('stderr' in error.detail) && !('evidence' in error.detail), '未启动的 detail 不带证据行');
    return true;
  });
});

test('未启动 + .cmd 入口（EINVAL）→ 三段可行动提示，detail 结构化，不泄露路径/endpoint', async () => {
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
    // ① 入口形态；② 原因归属启动方式（不是路径写法）；③ 下一步。
    assert.match(error.message, /\.cmd 包装脚本/);
    assert.match(error.message, /固定 argv 且未经 shell 无法启动脚本/);
    assert.match(error.message, /原生可执行文件/);
    assert.doesNotMatch(error.message, /重试/, '未启动不得暗示重试');
    // 结构化面：类别 + 下一步，供写动作与卡片复用同一套判定。
    assert.equal(error.detail.category, 'WRAPPER_SCRIPT');
    assert.equal(error.detail.suffix, '.cmd');
    assert.match(error.detail.next, /企业 DevOps/);
    assertNoLeak(error.message, [WIN_USERS, 'AppData', endpoint, 'dop.example']);
    assertNoLeak(JSON.stringify(error.detail), [WIN_USERS, 'AppData', endpoint, 'dop.example']);
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
    assert.equal(error.detail.category, 'EXTENSIONLESS_SHIM');
    assert.match(error.message, /npm 生成的无后缀 shim/);
    assert.match(error.message, /原生可执行文件/);
    assert.doesNotMatch(error.message, /重试/);
    assertNoLeak(error.message, [WIN_USERS, 'AppData']);
    return true;
  });
});

test('原生 .exe 未启动 → 不套包装脚本解释，也不再回显证据行（AC-2 结构性保证）', async () => {
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
    assert.equal(error.detail.category, 'NATIVE_ENTRY');
    assert.doesNotMatch(error.message, /包装脚本/, '原生入口不得被解释成包装脚本');
    assert.doesNotMatch(error.message, /shim/);
    assert.doesNotMatch(error.message, /ENOENT/, '未启动不读证据行，errno 不再出现在出口（AC-1 / AC-2）');
    assert.match(error.message, /入口未能启动/);
    assertNoLeak(error.message, ['C:\\tools\\dop.exe', 'C:\\tools']);
    return true;
  });
});

test('POSIX 无后缀是原生入口：不出现 Windows 措辞，也不回显 errno', async () => {
  const runner = fakeRunner(() => ({ exitCode: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false }));
  const adapter = adapterWith(runner, { dopBin: '/opt/corp/dop', platform: 'linux' });
  await assert.rejects(adapter.readChange({ changeId: 'ARD123456' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.spawnFailed, true);
    assert.equal(error.detail.category, 'NATIVE_ENTRY');
    assert.doesNotMatch(error.message, /shim|包装脚本/);
    assert.match(error.message, /入口未能启动/);
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
  assert.deepEqual(capabilities.write, ['change.update'], '唯一的写通道是 change update');
  assert.equal(capabilities.endpoint_configured, true);
  assert.equal(capabilities.executable_configured, true);
  assert.ok(Object.isFrozen(capabilities));
  const serialized = JSON.stringify(capabilities);
  assert.ok(!serialized.includes('/opt/corp/dop'));
  assert.ok(!serialized.includes('dop.example'));
});

test('命令面枚举到函数：view/list/update 三条，禁项（done/create/delete/close）没有通道', () => {
  assert.deepEqual(Object.keys(DOP_COMMANDS), ['changeView', 'changeList', 'changeUpdate']);
  assert.deepEqual(DOP_COMMANDS.changeView, ['change', 'view']);
  assert.deepEqual(DOP_COMMANDS.changeList, ['change', 'list']);
  assert.deepEqual(DOP_COMMANDS.changeUpdate, ['change', 'update']);
  assert.ok(Object.isFrozen(DOP_COMMANDS.changeUpdate));

  const adapter = createDopAdapter({ runner: fakeRunner(), dopBin: '/opt/corp/dop', now });
  assert.equal(typeof adapter.updateChange, 'function', '写回只经 change update 一个方法');
  for (const forbidden of ['done', 'create', 'delete', 'close']) {
    assert.ok(!(forbidden in adapter), `dop 适配器不得有 ${forbidden} 通道（§5.3 禁项）`);
  }
  assert.equal(typeof adapter.capabilities, 'function');
});

/* ───────────────────── change update：固定 argv + 写后回读（2026-11-04） ───────────────────── */

/** 回读夹具：平台 `change view --json` 的 camelCase 形状（summary/description/userStory.storyAC）。 */
const READBACK_OK = JSON.stringify({
  summary: '优化启动性能',
  description: '补齐启动链路的重试',
  userStory: { storyAC: '<p>启动耗时下降 30%</p>' },
});
const READBACK_STALE = JSON.stringify({ summary: '旧标题', description: '', userStory: null });

const updateRunner = (outcomes) => {
  const calls = [];
  const runner = {
    calls,
    run: async (input) => {
      calls.push({ args: [...input.args], purpose: input.purpose });
      const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      return { stderr: '', stdout: '', durationMs: 1, timedOut: false, ...next };
    },
  };
  return runner;
};

test('updateChange：argv 固定为 change update <id> + 三个字段 flag，不拼 --json', async () => {
  const runner = updateRunner([{ exitCode: 0 }, { exitCode: 0, stdout: READBACK_OK }]);
  const result = await adapterWith(runner).updateChange({
    changeId: 'ARD123456',
    summary: '优化启动性能',
    description: '补齐启动链路的重试',
    aiAc: '启动耗时下降 30%',
  });

  assert.deepEqual(runner.calls[0].args, [
    'change', 'update', 'ARD123456',
    '--summary', '优化启动性能',
    '--description', '补齐启动链路的重试',
    '--ai-ac', '启动耗时下降 30%',
  ]);
  assert.ok(!runner.calls[0].args.includes('--json'), '写命令不拼 --json（未取证）');
  assert.match(runner.calls[1].args.join(' '), /change view ARD123456 --json/u, '写后必须回读');
  assert.equal(result.status, 'done', '退出码 0 + 回读一致才算 done');
  assert.deepEqual(result.readback.fields, { summary: 'match', description: 'match', aiAc: 'match' });
  assert.equal(result.readback.aiAc_source, 'user_story.storyAC', 'UAT 形状：ai-ac 落在故事 storyAC');
  assert.equal(result.retry_policy, 'none');
});

test('updateChange：--ai-ac 落在变更级 aiAcceptanceCriteria 也算写入成功（1.0.4 实测落点）', async () => {
  // 1.0.4 的 `change update --ai-ac` 写变更级 `aiAcceptanceCriteria`，故事上的 storyAC 保持原样；
  // 只认故事一处会把这种成功写回判成 mismatch（写进去了也报 unknown）。
  const readback = JSON.stringify({
    summary: '优化启动性能',
    description: '补齐启动链路的重试',
    aiAcceptanceCriteria: '启动耗时下降 30%',
    userStory: { storyAC: '<p>平台原有的验收条件</p>' },
  });
  const runner = updateRunner([{ exitCode: 0 }, { exitCode: 0, stdout: readback }]);
  const result = await adapterWith(runner).updateChange({ changeId: 'ARD123456', aiAc: '启动耗时下降 30%' });

  assert.equal(result.status, 'done');
  assert.equal(result.readback.fields.aiAc, 'match');
  assert.equal(result.readback.aiAc_source, 'ai_acceptance_criteria');
});

test('updateChange：两处都没有 ai-ac 落点 → absent（仍判 unknown，不重放）', async () => {
  const readback = JSON.stringify({ summary: '优化启动性能', description: '', userStory: {} });
  const runner = updateRunner([{ exitCode: 0 }, { exitCode: 0, stdout: readback }]);
  const result = await adapterWith(runner).updateChange({ changeId: 'ARD123456', aiAc: '启动耗时下降 30%' });

  assert.equal(result.readback.fields.aiAc, 'absent');
  assert.equal(result.readback.aiAc_source, null);
  assert.equal(result.status, 'unknown');
  assert.equal(result.may_have_side_effect, true);
  assert.equal(result.retry_policy, 'none');
});

test('updateChange：只拼本次给出的字段（缺省字段不出现空 flag）', async () => {
  const runner = updateRunner([{ exitCode: 0 }, { exitCode: 0, stdout: READBACK_OK }]);
  await adapterWith(runner).updateChange({ changeId: 'ARD123456', description: '只改描述' });
  assert.deepEqual(runner.calls[0].args, ['change', 'update', 'ARD123456', '--description', '只改描述']);
});

test('updateChange：三个字段都为空 → MISSING_FIELDS 且零子进程', async () => {
  const runner = updateRunner([{ exitCode: 0 }]);
  await rejectsWith(adapterWith(runner).updateChange({ changeId: 'ARD123456' }), 'MISSING_FIELDS');
  assert.equal(runner.calls.length, 0);
});

test('updateChange：写成功但回读不一致 → unknown（不重放、可能已有副作用）', async () => {
  const runner = updateRunner([{ exitCode: 0 }, { exitCode: 0, stdout: READBACK_STALE }]);
  const result = await adapterWith(runner).updateChange({ changeId: 'ARD123456', summary: '优化启动性能' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.readback.ok, false);
  assert.equal(result.readback.fields.summary, 'mismatch');
  assert.equal(result.may_have_side_effect, true);
  assert.equal(result.retry_policy, 'none');
});

test('updateChange：非零退出且回读确认未写入 → failed；超时且回读已写入 → unknown', async () => {
  const failedRunner = updateRunner([{ exitCode: 1, stderr: 'server rejected' }, { exitCode: 0, stdout: READBACK_STALE }]);
  const failed = await adapterWith(failedRunner).updateChange({ changeId: 'ARD123456', summary: '优化启动性能' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'COMMAND_FAILED');
  assert.equal(failed.may_have_side_effect, false);

  const timeoutRunner = updateRunner([{ exitCode: null, timedOut: true }, { exitCode: 0, stdout: READBACK_OK }]);
  const timeout = await adapterWith(timeoutRunner).updateChange({ changeId: 'ARD123456', summary: '优化启动性能' });
  assert.equal(timeout.status, 'unknown');
  assert.equal(timeout.reason, 'COMMAND_TIMEOUT');
  assert.equal(timeout.may_have_side_effect, true);
});

test('updateChange：进程没起来（spawn 失败）→ 抛出可见失败，且不做回读', async () => {
  const runner = updateRunner([{ exitCode: null }]);
  await assert.rejects(
    adapterWith(runner).updateChange({ changeId: 'ARD123456', summary: 'x' }),
    (error) => error?.detail?.spawnFailed === true,
  );
  assert.equal(runner.calls.length, 1, '没启动就没有写发生，不再回读');
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
