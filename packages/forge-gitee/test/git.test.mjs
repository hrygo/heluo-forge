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
    executeAction: async (_ctx, _action, _exec, operation) => {
      state.operations += 1;
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
  const runner = fakeRunner();
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
  assert.deepEqual(runner.calls[0].args, ['push', 'origin', 'feat/r10']);
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

test('注册表：固定 10 个（3 读 → 4 写 → 1 判定 → 2 git），5 条策略写含 push', () => {
  assert.equal(GITEE_TOOLS.length, 10);
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
  };
  const definitions = buildGiteeTools(stub);
  assert.deepEqual(definitions.map((definition) => definition.name), [...GITEE_TOOLS]);
  assert.equal(definitions.length, 10);
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
