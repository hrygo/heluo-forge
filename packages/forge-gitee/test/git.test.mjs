/**
 * r10 T2：git 提交信息单源、本地 git 命令面、两个 git 工具与门禁补 push。
 *
 * 这里守四类"看起来能跑、其实会出事"的错误：
 * 1. **提交信息规则不许有第二份**——`git-message.mjs` 是唯一实现，`gitee-delivery` 只 re-export；
 *    用例直接断言两处符号是同一个引用。
 * 2. **不合规提交必须零子进程**——`createGitCommit` 在建 argv 之前就拒，runner 一次都不许被调用。
 * 3. **push 默认不可用**——未登记即 `ACTION_UNREGISTERED`、登记后缺 `confirm` 即
 *    `CONFIRMATION_REQUIRED`，两条都不进 `payload.run`，git 适配器一次都不许被调用。
 * 4. **离线可复现**——端到端用真 git、临时工作仓 + 本地 bare 仓，不联网；断言推到终态
 *    （远端分支 sha 与本地 HEAD 一致、subject 与提交信息一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ACTION_REASONS, GITEE_ACTIONS } from '../src/gitee-actions.mjs';
import { CONFIRM_REQUIRED_ACTIONS, GUARD_REASONS, createGiteeGuard } from '../src/gitee-guard.mjs';
import {
  GIT_BIN,
  GIT_REASONS,
  GIT_VERBS,
  GITEE_GIT_TOOLS,
  GiteeGitError,
  assertGitArgv,
  createGiteeGitAdapter,
  createGitCommit,
  createGitPush,
  detectAuthTransportFailure,
  gitArgvFor,
  gitToolDefinitions,
} from '../src/gitee-git.mjs';
import {
  GITEE_POLICY_WRITE_TOOLS,
  GITEE_TOOLS,
  GITEE_WRITE_TOOLS,
  buildGiteeTools,
} from '../src/gitee-tools.mjs';
import {
  COMMIT_REASONS,
  CommitMessageError,
  assertCommitMessage,
  verifyCommitMessage,
} from '../src/git-message.mjs';
import {
  COMMIT_REASONS as DELIVERY_COMMIT_REASONS,
  assertCommitMessage as deliveryAssertCommitMessage,
} from '../src/gitee-delivery.mjs';

const CHANGE = 'CHG-2026-0042';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const GIT_AVAILABLE = (() => {
  try {
    execFileSync(GIT_BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const execFileAsync = promisify(execFile);

/** 假执行器：记录每次调用，可按需返回指定结果（不启动任何进程）。 */
const RANGE_SHA = 'a'.repeat(40);
const RANGE_BASE = 'b'.repeat(40);

/** 让 readRange 的只读命令都有确定答案；handler 返回非 undefined 时优先。 */
function fakeRangeRunner(handler = null) {
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, truncated: false });
  return fakeRunner(({ args, purpose, cwd }) => {
    if (typeof handler === 'function') {
      const custom = handler({ args, purpose, cwd });
      if (custom !== undefined) return custom;
    }
    if (args[0] === 'rev-parse') return ok(`${RANGE_SHA}\n`);
    if (args[0] === 'merge-base') return ok(`${RANGE_BASE}\n`);
    if (args[0] === 'rev-list') return ok(`${RANGE_SHA}\n`);
    if (args[0] === 'show') return ok(`[${CHANGE}] 待推送正文\n\u0000+diff tok\n`);
    return ok('');
  });
}

function fakeRunner(handler = null) {
  const calls = [];
  return {
    calls,
    runGit: async ({ args, purpose, cwd }) => {
      calls.push({ args: [...args], purpose, cwd });
      if (typeof handler === 'function') return handler({ args, purpose, cwd });
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    },
  };
}

/** 允许策略：decide 放行，executeAction 直接跑 operation（模拟审批台账已通过）。 */
function allowPolicy() {
  const state = { decide: 0, operations: 0 };
  return {
    state,
    decide: () => {
      state.decide += 1;
      return { action: 'allow' };
    },
    executeAction: async (_ctx, _action, exec, operation) => {
      state.operations += 1;
      // 生产过程里内容闸会先解析这一通道；桩也要照着做，否则测出来的不是真实顺序。
      if (exec !== undefined && typeof exec.content === 'function') await exec.content();
      return operation();
    },
  };
}

/** 默认目录语义：动作未登记 → deny/unregistered-action（与真实策略包一致）。 */
function unregisteredPolicy() {
  const state = { decide: 0, operations: 0 };
  return {
    state,
    decide: () => {
      state.decide += 1;
      return { action: 'deny', rule: 'unregistered-action', reason: '动作未登记' };
    },
    executeAction: async () => {
      state.operations += 1;
      throw new Error('未登记的动作不该进 operation');
    },
  };
}

function serviceWith({ adapter, policy }) {
  const guard = createGiteeGuard({ policy });
  return {
    guard,
    service: {
      git: () => adapter,
      execute: (request) => guard.execute(request),
    },
  };
}

function runGitReal() {
  return async ({ args, cwd, purpose }) => {
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(GIT_BIN, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started, timedOut: false, truncated: false };
    } catch (error) {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? ''),
        durationMs: Date.now() - started,
        timedOut: error.killed === true,
        truncated: false,
      };
    }
  };
}

/* ------------------------------------------------------------ 提交信息单源 */

test('r10 §3.5：提交信息规则只有一份实现，delivery 只 re-export', () => {
  assert.equal(DELIVERY_COMMIT_REASONS, COMMIT_REASONS, '两处必须是同一个对象引用');
  assert.equal(deliveryAssertCommitMessage, assertCommitMessage, '两处必须是同一个函数引用');
  assert.deepEqual(Object.values(COMMIT_REASONS), [
    'COMMIT_MISSING_CHANGE_ID',
    'COMMIT_INVALID_CHANGE_ID',
    'COMMIT_MISSING_MESSAGE',
    'COMMIT_PREFIX_MISSING',
    'COMMIT_DESCRIPTION_MISSING',
  ]);
  const cases = [
    [{ message: `[${CHANGE}] 说明` }, COMMIT_REASONS.MISSING_CHANGE_ID],
    [{ changeId: 'bad id', message: `[${CHANGE}] 说明` }, COMMIT_REASONS.INVALID_CHANGE_ID],
    [{ changeId: CHANGE, message: '   ' }, COMMIT_REASONS.MISSING_MESSAGE],
    [{ changeId: CHANGE, message: '没有前缀' }, COMMIT_REASONS.PREFIX_MISSING],
    [{ changeId: 'CHG-2026-9999', message: `[${CHANGE}] 说明` }, COMMIT_REASONS.PREFIX_MISSING],
    [{ changeId: CHANGE, message: `[${CHANGE}]   ` }, COMMIT_REASONS.DESCRIPTION_MISSING],
  ];
  for (const [input, reason] of cases) {
    assert.equal(verifyCommitMessage(input).ok, false, `${reason} 应被拒绝`);
    assert.equal(verifyCommitMessage(input).reason, reason);
    assert.throws(() => assertCommitMessage(input), CommitMessageError);
  }
  const ok = verifyCommitMessage({ changeId: CHANGE, message: `[${CHANGE}] 一句话说明\n\n正文` });
  assert.equal(ok.ok, true);
  assert.equal(ok.changeId, CHANGE);
  assert.equal(ok.subject, '一句话说明');
});

/* ------------------------------------------------------------ argv 表 */

test('git 命令面固定：四个动词、argv 逐字、非法参数在拼 argv 前拒绝', () => {
  assert.equal(GIT_BIN, 'git');
  assert.deepEqual([...GIT_VERBS], ['commit', 'head', 'branch', 'push']);
  assert.deepEqual(gitArgvFor('commit', { message: `[${CHANGE}] 说明` }), ['commit', '-m', `[${CHANGE}] 说明`]);
  assert.deepEqual(gitArgvFor('head', {}), ['rev-parse', 'HEAD']);
  assert.deepEqual(gitArgvFor('branch', {}), ['branch', '--show-current']);
  assert.deepEqual(gitArgvFor('push', { remote: 'origin', branch: 'feat/r10' }), ['push', 'origin', 'feat/r10']);
  assert.deepEqual(assertGitArgv('push', { remote: 'origin', branch: 'feat/r10' }).purpose, 'git.push');
  assert.equal(Object.isFrozen(assertGitArgv('head', {}).argv), true);

  const bad = [
    ['delete', {}, GIT_REASONS.INVALID_VERB],
    ['commit', { message: '   ' }, GIT_REASONS.MISSING_MESSAGE],
    ['commit', { message: 'a\u0000b' }, GIT_REASONS.INVALID_MESSAGE],
    ['push', { remote: 'origin', branch: '--force' }, GIT_REASONS.INVALID_BRANCH],
    ['push', { remote: 'origin', branch: 'feat/../main' }, GIT_REASONS.INVALID_BRANCH],
    ['push', { remote: '--upload-pack=sh', branch: 'feat/x' }, GIT_REASONS.INVALID_REMOTE],
    ['push', { remote: 'origin' }, GIT_REASONS.INVALID_BRANCH],
  ];
  for (const [verb, params, reason] of bad) {
    assert.throws(
      () => gitArgvFor(verb, params),
      (error) => error instanceof GiteeGitError && error.code === reason,
      `${verb} ${JSON.stringify(params)} 应以 ${reason} 拒绝`,
    );
  }
});

/* ------------------------------------------------------------ 适配器 */

test('适配器：commit 走固定三步（commit -m → rev-parse → branch），回读 sha/branch/证据', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${SHA}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'branch') {
      return { exitCode: 0, stdout: 'feat/r10\n', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo', now: () => Date.parse('2026-11-03T00:00:00.000Z') });
  const result = await adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 一句话说明` });
  assert.equal(result.sha, SHA);
  assert.equal(result.subject, '一句话说明');
  assert.equal(result.branch, 'feat/r10');
  assert.equal(result.evidence.command, 'git.commit');
  assert.equal(result.evidence.sourceType, 'gitee-cli');
  assert.equal(result.evidence.at, '2026-11-03T00:00:00.000Z');
  assert.deepEqual(runner.calls.map((call) => call.args[0]), ['commit', 'rev-parse', 'branch']);
  assert.deepEqual(runner.calls[0].args, ['commit', '-m', `[${CHANGE}] 一句话说明`]);
  assert.deepEqual(adapter.describe(), {
    bin: 'git',
    cwd: '/tmp/offline-repo',
    verbs: GIT_VERBS,
    shell: false,
    runner: 'runGit',
  });
});

test('适配器：不合规提交在子进程前拒绝（runner 0 次）', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await assert.rejects(
    () => adapter.commit({ changeId: CHANGE, message: '没有前缀' }),
    (error) => error instanceof CommitMessageError && error.reason === COMMIT_REASONS.PREFIX_MISSING,
  );
  assert.equal(runner.calls.length, 0);
});

test('适配器：超时/非零/坏回读的出口语义（可能已落地必须标出来）', async () => {
  const timeout = createGiteeGitAdapter({
    runner: fakeRunner(() => ({ exitCode: null, stdout: '', stderr: '', durationMs: 5, timedOut: true, truncated: false })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => timeout.commit({ changeId: CHANGE, message: `[${CHANGE}] 说明` }),
    (error) => error.code === GIT_REASONS.COMMAND_TIMEOUT && error.detail.mayHaveSideEffect === true,
  );

  const failed = createGiteeGitAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'hook 拒绝', durationMs: 5, timedOut: false, truncated: false })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => failed.commit({ changeId: CHANGE, message: `[${CHANGE}] 说明` }),
    (error) => error.code === GIT_REASONS.COMMAND_FAILED && error.detail.mayHaveSideEffect === false,
  );

  const badReadback = createGiteeGitAdapter({
    runner: fakeRunner(({ args }) => ({
      exitCode: 0,
      stdout: args[0] === 'rev-parse' ? 'not-a-sha\n' : '',
      stderr: '',
      durationMs: 5,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => badReadback.commit({ changeId: CHANGE, message: `[${CHANGE}] 说明` }),
    (error) =>
      error.code === GIT_REASONS.READBACK_UNAVAILABLE &&
      error.detail.readback === true &&
      error.detail.mayHaveSideEffect === true,
  );
});

test('适配器：MSYS/sh 崩溃特征 → GIT_AUTH_TRANSPORT_UNAVAILABLE（凭据传输通道，不是用户名缺失）', async () => {
  const samples = [
    'sh: 1: /usr/bin/git-credential-store: not found',
    'bash.exe: 1: /usr/bin/git-credential-manager: not found',
    'cannot fork: Resource temporarily unavailable',
    'CreateFileMapping failed: 5',
    '\\\\.\\pipe\\git-credential',
    'fatal: could not create named pipe: Permission denied',
    'C:\\msys64\\usr\\bin\\sh.exe: 1: /usr/bin/helper: not found',
  ];
  for (const stderr of samples) {
    const adapter = createGiteeGitAdapter({
      runner: fakeRunner(() => ({ exitCode: 128, stdout: '', stderr, durationMs: 5, timedOut: false, truncated: false })),
      cwd: '/tmp/offline-repo',
    });
    await assert.rejects(
      () => adapter.push({ remote: 'origin', branch: 'feat/r10' }),
      (error) => {
        assert.equal(error.code, GIT_REASONS.AUTH_TRANSPORT_UNAVAILABLE, `应命中传输层：${stderr}`);
        assert.equal(error.detail.mayHaveSideEffect, false, '认证请求没发出去，零副作用');
        assert.equal(error.detail.authTransport.signs.length > 0, true);
        assert.match(error.message, /不是用户名缺失/u);
        return true;
      },
    );
  }
});

test('适配器：普通认证拒绝/缺凭据/HTTP 断开维持 GIT_COMMAND_FAILED（不冒充传输故障）', async () => {
  const samples = [
    "fatal: could not read Username for 'https://corp.example': terminal prompts disabled",
    "fatal: Authentication failed for 'https://corp.example/group/repo'",
    "fatal: unable to access 'https://corp.example/group/repo': The requested URL returned error: 403",
    'remote: HTTP Basic: Access denied',
    'error: RPC failed; curl 56 Recv failure: Broken pipe',
    'fatal: bad config line 1 in file /opt/msys/etc/gitconfig',
    // 服务端 hook 的资源不足是远端诊断：连接已建立，不能据此改本机凭据。
    'remote: cannot fork: Resource temporarily unavailable',
    'remote: CreateFileMapping failed: 5',
  ];
  for (const stderr of samples) {
    const adapter = createGiteeGitAdapter({
      runner: fakeRunner(() => ({ exitCode: 128, stdout: '', stderr, durationMs: 5, timedOut: false, truncated: false })),
      cwd: '/tmp/offline-repo',
    });
    await assert.rejects(
      () => adapter.push({ remote: 'origin', branch: 'feat/r10' }),
      (error) => {
        assert.equal(error.code, GIT_REASONS.COMMAND_FAILED, `不该命中传输层：${stderr}`);
        assert.equal(error.detail.mayHaveSideEffect, false);
        assert.equal(error.detail.authTransport, undefined);
        return true;
      },
    );
  }
});

test('适配器：服务端 remote: 诊断不参与传输层判定，本机崩溃特征仍归类', async () => {
  const remoteOnly = createGiteeGitAdapter({
    runner: fakeRunner(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'remote: cannot fork: Resource temporarily unavailable\nremote: error: hook declined push',
      durationMs: 5,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => remoteOnly.push({ remote: 'origin', branch: 'feat/r10' }),
    (error) => {
      assert.equal(error.code, GIT_REASONS.COMMAND_FAILED, '远端 hook 失败应维持普通命令失败');
      assert.equal(error.detail.authTransport, undefined);
      return true;
    },
  );

  const localMixed = createGiteeGitAdapter({
    runner: fakeRunner(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'remote: hook accepted\nsh: cannot fork: Resource temporarily unavailable',
      durationMs: 5,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => localMixed.push({ remote: 'origin', branch: 'feat/r10' }),
    (error) => {
      assert.equal(error.code, GIT_REASONS.AUTH_TRANSPORT_UNAVAILABLE, '本机 sh 崩溃仍应归类');
      assert.equal(error.detail.mayHaveSideEffect, false);
      return true;
    },
  );
});

test('适配器：msys 运行时名必须与「凭据拿不到」症状同现才归类（单独环境名不算）', async () => {
  const combined = createGiteeGitAdapter({
    runner: fakeRunner(() => ({
      exitCode: 128,
      stdout: '',
      stderr: [
        'Note: switching to C:\\msys64\\usr\\bin\\sh.exe for credential helper',
        "fatal: could not read Username for 'https://corp.example': terminal prompts disabled",
      ].join('\n'),
      durationMs: 5,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => combined.push({ remote: 'origin', branch: 'feat/r10' }),
    (error) =>
      error.code === GIT_REASONS.AUTH_TRANSPORT_UNAVAILABLE
      && error.detail.authTransport.signs.includes('runtime-environment'),
  );

  assert.deepEqual(detectAuthTransportFailure({ stdout: '', stderr: '' }), null);
  assert.deepEqual(
    detectAuthTransportFailure({ stderr: 'fatal: bad config line 1 in file /opt/msys/etc/gitconfig' }),
    null,
    '只有 msys 字样、没有凭据症状时不能归类',
  );
});

test('适配器：本地 commit 命中同类字样不冒充认证传输故障（只归类远端 push）', async () => {
  const adapter = createGiteeGitAdapter({
    runner: fakeRunner(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'cannot fork: Resource temporarily unavailable',
      durationMs: 5,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  await assert.rejects(
    () => adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 说明` }),
    (error) => error.code === GIT_REASONS.COMMAND_FAILED && error.detail.mayHaveSideEffect === false,
  );
});

test('适配器：push 只拼固定 argv，不提供 force/tags/all', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const result = await adapter.push({ remote: 'origin', branch: 'feat/r10' });
  assert.deepEqual(result, { ok: true, remote: 'origin', branch: 'feat/r10' });
  assert.deepEqual(runner.calls[0].args, ['push', 'origin', 'feat/r10']);
  assert.equal(runner.calls[0].purpose, 'git.push');
  assert.throws(() => gitArgvFor('push', { remote: 'origin', branch: 'feat/r10', force: true }), GiteeGitError);
});

/* ------------------------------------------------------------ 工具与门禁 */

test('工具：不合规提交 denied 且零子进程（runner 0 次）', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const envelope = await createGitCommit().run(
    { changeId: CHANGE, message: '忘了写前缀' },
    { git: () => adapter },
  );
  assert.equal(envelope.status, 'denied');
  assert.equal(envelope.reason, ACTION_REASONS.COMMIT_MESSAGE_INVALID);
  assert.equal(envelope.rule, 'commit-message-invalid');
  assert.equal(envelope.action, 'gitee.git.commit');
  assert.equal(envelope.provider, 'gitee');
  assert.equal(envelope.remote_calls, 0);
  assert.equal(runner.calls.length, 0);
});

test('工具：push 未登记 → ACTION_UNREGISTERED，零子进程、零 operation', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const policy = unregisteredPolicy();
  const { service } = serviceWith({ adapter, policy });
  const envelope = await createGitPush().run(
    { target: 'group/repo', branch: 'feat/r10', confirm: { repo: 'group/repo', object: 'group/repo' } },
    service,
  );
  assert.equal(envelope.status, 'denied');
  assert.equal(envelope.reason, GUARD_REASONS.ACTION_UNREGISTERED);
  assert.equal(envelope.action, GITEE_ACTIONS.GIT_PUSH);
  assert.equal(policy.state.decide, 1);
  assert.equal(policy.state.operations, 0);
  assert.equal(runner.calls.length, 0);
});

test('工具：push 已登记但缺 confirm → CONFIRMATION_REQUIRED，零子进程', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const policy = allowPolicy();
  const { service } = serviceWith({ adapter, policy });
  const envelope = await createGitPush().run({ target: 'group/repo', branch: 'feat/r10' }, service);
  assert.equal(envelope.status, 'denied');
  assert.equal(envelope.reason, GUARD_REASONS.CONFIRMATION_REQUIRED);
  assert.equal(envelope.rule, 'confirm-required');
  assert.equal(policy.state.operations, 0);
  assert.equal(runner.calls.length, 0);
});

test('工具：push 放行 + 正确 confirm → done，argv 固定、证据与回读齐全', async () => {
  const runner = fakeRangeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const policy = allowPolicy();
  const { service } = serviceWith({ adapter, policy });
  const envelope = await createGitPush().run(
    {
      target: 'group/repo',
      branch: 'feat/r10',
      changeId: CHANGE,
      confirm: { repo: 'group/repo', object: 'group/repo' },
    },
    service,
  );
  assert.equal(envelope.status, 'done');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.object_ref, 'origin/feat/r10');
  assert.equal(envelope.readback.via, 'git-push');
  assert.equal(envelope.readback.ok, true);
  assert.equal(envelope.evidence.command, 'git.push');
  assert.equal(envelope.evidence.sourceType, 'gitee-cli');
  assert.equal(envelope.remote_calls, 1);
  assert.equal(policy.state.operations, 1);
  // 推的是"读过正文的那个提交"，不是可变的同名分支。
  assert.deepEqual(runner.calls.at(-1).args, ['push', 'origin', `${RANGE_SHA}:refs/heads/feat/r10`]);
});

test('工具：push 已登记+确认后命中传输崩溃 → failed + use-native-http-credential（可安全重试）', async () => {
  const runner = fakeRangeRunner(({ args }) => (args[0] === 'push' ? {
    exitCode: 128,
    stdout: '',
    stderr: [
      'sh: 1: /usr/bin/git-credential-store: not found',
      "fatal: could not read Username for 'https://corp.example': terminal prompts disabled",
    ].join('\n'),
    durationMs: 5,
    timedOut: false,
    truncated: false,
  } : undefined));
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const policy = allowPolicy();
  const { service } = serviceWith({ adapter, policy });
  const envelope = await createGitPush().run(
    { target: 'group/repo', branch: 'feat/r10', changeId: CHANGE, confirm: { repo: 'group/repo', object: 'group/repo' } },
    service,
  );
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.reason, ACTION_REASONS.AUTH_TRANSPORT_UNAVAILABLE);
  assert.equal(envelope.rule, 'auth-transport-unavailable');
  assert.equal(envelope.next_action, 'use-native-http-credential');
  assert.equal(envelope.replay_blocked, false);
  assert.match(envelope.detail, /不是用户名缺失/u);
  assert.equal(envelope.remote_calls, 1);
  assert.equal(policy.state.operations, 1);
  assert.deepEqual(runner.calls.at(-1).args, ['push', 'origin', `${RANGE_SHA}:refs/heads/feat/r10`]);
});

test('工具：push 被远端 403 拒绝 → failed + COMMAND_FAILED（维持原原因码与 retry）', async () => {
  const runner = fakeRangeRunner(({ args }) => (args[0] === 'push' ? {
    exitCode: 128,
    stdout: '',
    stderr: "fatal: unable to access 'https://corp.example/group/repo': The requested URL returned error: 403",
    durationMs: 5,
    timedOut: false,
    truncated: false,
  } : undefined));
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const { service } = serviceWith({ adapter, policy: allowPolicy() });
  const envelope = await createGitPush().run(
    { target: 'group/repo', branch: 'feat/r10', confirm: { repo: 'group/repo', object: 'group/repo' } },
    service,
  );
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.reason, ACTION_REASONS.COMMAND_FAILED);
  assert.equal(envelope.rule, 'command-failed');
  assert.equal(envelope.next_action, 'retry');
  assert.equal(envelope.replay_blocked, false);
});

test('工具：push 参数不合法时不问策略、零子进程', async () => {
  const runner = fakeRunner();
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const policy = allowPolicy();
  const { service } = serviceWith({ adapter, policy });
  const tool = createGitPush();
  const missing = await tool.run({ target: 'group/repo' }, service);
  assert.equal(missing.status, 'denied');
  assert.equal(missing.reason, ACTION_REASONS.MISSING_ARGUMENT);
  const badTarget = await tool.run({ target: 'not a repo', branch: 'feat/r10' }, service);
  assert.equal(badTarget.reason, ACTION_REASONS.INVALID_TARGET);
  const badBranch = await tool.run({ target: 'group/repo', branch: '--force' }, service);
  assert.equal(badBranch.reason, ACTION_REASONS.INVALID_ARGUMENT);
  assert.equal(policy.state.decide, 0);
  assert.equal(runner.calls.length, 0);
});

/* ------------------------------------------------------------ 注册表 */

test('注册表：固定 11 个（3 读 → 4 写 → 1 判定 → 1 快照 → 2 git），5 条策略写含 push', () => {
  assert.equal(GITEE_TOOLS.length, 11);
  assert.deepEqual(GITEE_TOOLS.slice(-2), [GITEE_GIT_TOOLS.COMMIT, GITEE_GIT_TOOLS.PUSH]);
  assert.deepEqual([...GITEE_POLICY_WRITE_TOOLS], [...GITEE_WRITE_TOOLS, GITEE_GIT_TOOLS.PUSH]);
  assert.equal(GITEE_POLICY_WRITE_TOOLS.length, 5);
  assert.ok(CONFIRM_REQUIRED_ACTIONS.includes(GITEE_ACTIONS.GIT_PUSH));

  const stub = {
    read: async () => ({}),
    execute: async () => ({}),
    invoke: async () => ({}),
    preflight: async () => ({ ok: true }),
    adapter: () => ({ read: async () => ({}) }),
    session: () => ({}),
    git: () => ({ commit: async () => ({}), push: async () => ({}) }),
    snapshot: async () => ({ status: 'succeeded' }),
  };
  const definitions = buildGiteeTools(stub);
  assert.deepEqual(definitions.map((definition) => definition.name), [...GITEE_TOOLS]);
  assert.equal(definitions.length, 11);
  const toolDefinitions = gitToolDefinitions(stub);
  assert.deepEqual(toolDefinitions.map((definition) => definition.name), [GITEE_GIT_TOOLS.COMMIT, GITEE_GIT_TOOLS.PUSH]);
  for (const definition of toolDefinitions) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.parameters.additionalProperties, false);
  }
});

test('静态：gitee-git.mjs 不直接起进程，也不依赖 CLI 出口实现', () => {
  const raw = readFileSync(new URL('../src/gitee-git.mjs', import.meta.url), 'utf8');
  // 只看代码：块注释与整行注释里可以提到进程模块，真正要守的是没有导入/调用。
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\/\/.*$/u, ' '))
    .join('\n');
  for (const forbidden of ['child_process', 'execFile(', 'spawn(', 'spawnSync(', 'execSync(', 'fork(']) {
    assert.equal(source.includes(forbidden), false, `gitee-git.mjs 直接使用了 ${forbidden}（绕过唯一出口）`);
  }
  assert.doesNotMatch(source, /from '\.\/gitee-cli\.mjs'/u);
});

/* ------------------------------------------------------------ 离线端到端 */

test('离线 e2e：真 git 临时工作仓 + 本地 bare 仓，commit → push 到终态', { skip: !GIT_AVAILABLE }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-gitee-git-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const run = (...args) => execFileSync(GIT_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('init', '--bare', bare);
    run('init', work);
    run('-C', work, 'config', 'user.name', '离线用例');
    run('-C', work, 'config', 'user.email', ['offline', 'example.invalid'].join('@'));
    writeFileSync(join(work, 'README.md'), '# 离线仓库\n');
    run('-C', work, 'add', 'README.md');
    // 远端指向本地 bare 仓：不配置任何网络 URL，push 走文件传输，零联网。
    run('-C', work, 'remote', 'add', 'origin', bare);

    const runner = { runGit: runGitReal() };
    const adapter = createGiteeGitAdapter({ runner, cwd: work });
    const policy = allowPolicy();
    const guard = createGiteeGuard({ policy });
    const service = { git: () => adapter, execute: (request) => guard.execute(request) };

    const message = `[${CHANGE}] 初始化离线仓库`;
    const committed = await createGitCommit().run({ changeId: CHANGE, message }, service);
    assert.equal(committed.status, 'done', `提交应成功：${committed.reason ?? ''} ${committed.detail ?? ''}`);
    assert.equal(committed.ok, true);
    const sha = run('-C', work, 'rev-parse', 'HEAD').trim();
    const branch = run('-C', work, 'branch', '--show-current').trim();
    assert.equal(committed.object_ref, sha);
    assert.equal(committed.readback.branch, branch);
    assert.equal(committed.remote_calls, 0);

    const pushed = await createGitPush().run(
      {
        target: 'group/repo',
        branch,
        changeId: CHANGE,
        confirm: { repo: 'group/repo', object: 'group/repo' },
      },
      service,
    );
    assert.equal(pushed.status, 'done', `推送应成功：${pushed.reason ?? ''} ${pushed.detail ?? ''}`);
    assert.equal(pushed.remote_calls, 1);
    assert.equal(pushed.readback.via, 'git-push');
    // 终态：远端分支的 sha 与本地 HEAD 一致，远端最新 subject 与提交信息一致。
    assert.equal(run('-C', bare, 'rev-parse', branch).trim(), sha);
    assert.equal(run('-C', bare, 'log', '-1', '--format=%s', branch).trim(), message);
    assert.equal(policy.state.operations, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('适配器：按次目录覆盖装配期目录（宿主进程目录不能当仓库用）', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${SHA}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'branch') {
      return { exitCode: 0, stdout: 'feat/r11\n', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/spawn-dir' });

  // 显式给出会话目录：commit / rev-parse / branch 三次调用必须全部落在同一个目录。
  await adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 会话目录提交`, cwd: '/tmp/session-repo' });
  assert.deepEqual(runner.calls.map((call) => call.cwd), ['/tmp/session-repo', '/tmp/session-repo', '/tmp/session-repo']);

  // 不给目录时仍用装配期值：覆盖只在「这一次」，不是全局改掉。
  runner.calls.length = 0;
  await adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 兜底目录提交` });
  assert.deepEqual(runner.calls.map((call) => call.cwd), ['/tmp/spawn-dir', '/tmp/spawn-dir', '/tmp/spawn-dir']);

  // 空白字符串一律回落，不把空目录交给子进程。
  runner.calls.length = 0;
  await adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 空目录回落`, cwd: '   ' });
  assert.deepEqual(runner.calls.map((call) => call.cwd), ['/tmp/spawn-dir', '/tmp/spawn-dir', '/tmp/spawn-dir']);
});

test('适配器：失败说明里带实际目录（跑错目录要能一眼看出来）', async () => {
  const runner = fakeRunner(() => ({
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  }));
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/spawn-dir' });
  await assert.rejects(
    () => adapter.commit({ changeId: CHANGE, message: `[${CHANGE}] 说明`, cwd: '/tmp/not-a-repo' }),
    (error) =>
      error.code === GIT_REASONS.COMMAND_FAILED
      && error.detail.cwd === '/tmp/not-a-repo'
      && error.message.includes('/tmp/not-a-repo'),
  );
});

test('工具定义：resolveGitCwd 每次现算目录并交给 git；解析失败回落且不崩', async () => {
  const seen = [];
  const git = {
    commit: async ({ cwd }) => {
      seen.push(cwd);
      return { sha: SHA, branch: 'feat/r11', subject: '说明', evidence: { command: 'git.commit' } };
    },
    push: async ({ cwd }) => {
      seen.push(cwd);
      return { ok: true, remote: 'origin', branch: 'feat/r11' };
    },
  };
  const stub = {
    read: async () => ({}),
    execute: async () => ({ status: 'done' }),
    invoke: async () => ({}),
    preflight: async () => ({ ok: true }),
    adapter: () => ({ read: async () => ({}) }),
    session: () => ({}),
    git: () => git,
  };

  const definitions = gitToolDefinitions(stub, async (exec) => exec?.agent?.workingDirectory);
  const commit = definitions.find((definition) => definition.name === GITEE_GIT_TOOLS.COMMIT);
  await commit.execute({ changeId: CHANGE, message: `[${CHANGE}] 说明` }, { agent: { workingDirectory: '/tmp/session-a' } });
  await commit.execute({ changeId: CHANGE, message: `[${CHANGE}] 说明` }, { agent: { workingDirectory: '/tmp/session-b' } });
  assert.deepEqual(seen, ['/tmp/session-a', '/tmp/session-b']);

  // 解析器抛错：工具照常执行，目录交给适配器兜底（undefined）。
  const broken = gitToolDefinitions(stub, async () => {
    throw new Error('workingDirectory 不可用');
  });
  await broken[0].execute({ changeId: CHANGE, message: `[${CHANGE}] 说明` }, {});
  assert.equal(seen.at(-1), undefined);
});

test('工具：push 把将要推送的提交内容以惰性通道交给策略，被拒时不读', async () => {
  const ONE = 'a'.repeat(40);
  const TWO = 'b'.repeat(40);
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${ONE}\n${TWO}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'show' && args.includes(ONE)) {
      return { exitCode: 0, stdout: 'fix: 第一条\u0000diff --git a/x b/x\n+tok1', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'show' && args.includes(TWO)) {
      return { exitCode: 0, stdout: 'fix: 第二条\u0000diff --git a/y b/y\n+tok2', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  let captured;
  const policy = {
    decide: () => ({ action: 'allow' }),
    executeAction: async (_ctx, _action, exec, operation) => {
      captured = exec;
      return operation();
    },
  };
  const { service } = serviceWith({ adapter, policy });
  const envelope = await createGitPush().run(
    { target: 'group/repo', branch: 'feat/r10', confirm: { repo: 'group/repo', object: 'group/repo' } },
    service,
  );
  assert.equal(envelope.status, 'done');
  assert.equal(typeof captured.content, 'function', '正文按需读取，不在准入前先跑子进程');
  const content = await captured.content();
  assert.deepEqual(content.commits.map((commit) => commit.message), ['fix: 第一条', 'fix: 第二条']);
  assert.match(content.commits[0].diff, /tok1/u);
  assert.match(content.commits[1].diff, /tok2/u);
});

test('工具：推送正文在会话目录读取，不在适配器默认目录', async () => {
  const ONE = 'c'.repeat(40);
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${ONE}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'show') {
      return { exitCode: 0, stdout: 'fix: 一条\u0000+tok', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/adapter-default' });
  let captured;
  const policy = {
    decide: () => ({ action: 'allow' }),
    executeAction: async (_ctx, _action, exec) => {
      captured = exec;
      await exec.content();
      return { status: 'done' };
    },
  };
  const { service } = serviceWith({ adapter, policy });
  const definitions = gitToolDefinitions(service, async () => '/tmp/session-repo');
  const push = definitions.find((definition) => definition.name === GITEE_GIT_TOOLS.PUSH);
  await push.execute(
    { target: 'group/repo', branch: 'feat/r12', confirm: { repo: 'group/repo', object: 'group/repo' } },
    { agent: { workingDirectory: '/tmp/ignored' } },
  );
  assert.equal(typeof captured.content, 'function');
  const dirs = runner.calls
    .filter((call) => ['rev-parse', 'merge-base', 'rev-list', 'show'].includes(call.args[0]))
    .map((call) => call.cwd);
  assert.deepEqual([...new Set(dirs)], ['/tmp/session-repo'], '正文读取必须落在会话仓库目录');
});

test('工具：推送正文读的是命名分支，不是当前检出的 HEAD', async () => {
  const ONE = 'd'.repeat(40);
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${ONE}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: 'fix: 一条\u0000+tok', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await adapter.readRange({ remote: 'origin', branch: 'feat/other' });
  const mergeArgs = runner.calls.find((call) => call.args[0] === 'merge-base').args;
  const listArgs = runner.calls.find((call) => call.args[0] === 'rev-list').args;
  assert.ok(mergeArgs.includes('origin/feat/other'), '基线优先取远端同名分支');
  assert.ok(listArgs.includes(`${SHA}..refs/heads/feat/other`), '提交范围必须落在要推送的分支上');
  assert.equal(listArgs.some((argument) => argument.includes('HEAD')), false, '不能再用 HEAD 冒充目标分支');
});

test('适配器：某条提交的正文读不到时拒绝，不把失败的补丁当成空补丁', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'show failed', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await assert.rejects(
    () => adapter.readRange({ remote: 'origin', branch: 'feat/other' }),
    (error) => error.code === GIT_REASONS.READBACK_UNAVAILABLE && /正文/u.test(error.message),
  );
});

test('适配器：逐条提交读补丁，中间提交引入又删除的凭据也要看得到', async () => {
  const ADDS = 'f'.repeat(40);
  const REMOVES = '0'.repeat(40);
  const secret = `${['AK', 'IA'].join('')}${'Q'.repeat(16)}`;
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${ADDS}\n${REMOVES}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'show' && args.includes(ADDS)) {
      return { exitCode: 0, stdout: `feat: 加配置\u0000+key=${secret}`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: 'chore: 删掉\u0000-key=old', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const content = await adapter.readRange({ remote: 'origin', branch: 'feat/other' });
  assert.equal(content.commits.length, 2);
  assert.match(content.commits[0].diff, new RegExp(secret, 'u'), '引入凭据的提交必须出现在待扫描正文里');
  assert.equal(content.commits[1].message, 'chore: 删掉');
});

test('适配器：单条提交正文被截断时拒绝，不拿半截正文当完整证据', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: 'fix: 一条\u0000+tok', stderr: '', durationMs: 1, timedOut: false, truncated: true };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await assert.rejects(
    () => adapter.readRange({ remote: 'origin', branch: 'feat/other' }),
    (error) => error.code === GIT_REASONS.READBACK_UNAVAILABLE && /上限/u.test(error.message),
  );
});

test('适配器：远端一个基线都没有时读该分支全部历史，而不是最近 N 条', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'no such ref', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  const range = await adapter.readRange({ remote: 'origin', branch: 'feat/other' });
  assert.deepEqual(range.commits, []);
  const listed = runner.calls.filter((call) => call.args[0] === 'rev-list').map((call) => call.args);
  assert.deepEqual(listed, [['rev-list', '--reverse', 'refs/heads/feat/other']], '没有可比基线时读全部历史，不带 -n 上限');
});

test('适配器：提交列表被截断即拒绝，不把残缺列表当完整证据', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') {
      return { exitCode: 0, stdout: SHA, stderr: '', durationMs: 1, timedOut: false, truncated: false };
    }
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${SHA}\n`, stderr: '', durationMs: 1, timedOut: false, truncated: true };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await assert.rejects(
    () => adapter.readRange({ remote: 'origin', branch: 'feat/r10' }),
    (error) => error.code === GIT_REASONS.READBACK_UNAVAILABLE && /无法列出/u.test(error.message),
  );
  assert.equal(runner.calls.some((call) => call.args[0] === 'show'), false, '列表都不完整，就不再假装逐条读过');
});

test('适配器：本地没有该分支时读不到正文，报 READBACK_UNAVAILABLE 而不是读 HEAD', async () => {
  const runner = fakeRunner(({ args }) => {
    if (args[0] === 'rev-parse') {
      return { exitCode: 1, stdout: '', stderr: 'unknown revision', durationMs: 1, timedOut: false, truncated: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  });
  const adapter = createGiteeGitAdapter({ runner, cwd: '/tmp/offline-repo' });
  await assert.rejects(
    () => adapter.readRange({ remote: 'origin', branch: 'feat/other' }),
    (error) => error.code === GIT_REASONS.READBACK_UNAVAILABLE && /feat\/other/u.test(error.message),
  );
  assert.equal(runner.calls.some((call) => call.args[0] === 'rev-list'), false, '分支不存在时不猜 HEAD 的内容');
});
