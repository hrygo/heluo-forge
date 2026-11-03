/**
 * 本地 git 命令面（r10 §3.5 / AC-19）：`commit` / `head` / `branch` / `push` 四个固定动词。
 *
 * 三条边界：
 * 1. **执行只有一个出口**。本模块不 import `node:child_process`、不建子进程，只接收
 *    `runner.runGit(...)`（唯一出口在 `gitee-cli.mjs`：固定 argv、`shell:false`、env allowlist、
 *    超时与 1MiB 截断）。argv 表与输出解析集中在这里，工具层永远拿不到「让模型自己拼命令」的入口。
 * 2. **commit 是本地动作，push 是远端写**。`@heluo/forge-policy` 的审批规则对任何 enabled 的
 *    非读动作恒为真，commit 若入目录就只能「默认拒绝」或「永远等审批」，与「提交必须做」冲突；
 *    因此 commit 只在本地做 `[变更号]` 强校验（`git-message.mjs`），push 走 guard + 动作
 *    `gitee.git.push`：默认未登记即 denied，登记后仍要审批台账与 `confirm{repo,object}` 逐字匹配。
 * 3. **只做一件事**：不关闭 PR、不打标签、不改写历史。上面四个动词就是全部能力。
 */

import { GITEE_ACTIONS, ACTION_REASONS, settleActionVerdict } from './gitee-actions.mjs';
import { buildEvidence } from './gitee-session.mjs';
import { assertCommitMessage, CommitMessageError } from './git-message.mjs';

/** 子进程二进制名。argv 由本模块固定拼装，不接受外部传入。 */
export const GIT_BIN = 'git';

/** 支持的动词（顺序即对外描述顺序）。 */
export const GIT_VERBS = Object.freeze(['commit', 'head', 'branch', 'push']);

/**
 * 两个 git 工具名：模型可见契约的**唯一枚举**。写在真正创建工具定义的模块里，
 * `gitee-tools` 从这里 re-export，避免「加了工具忘登记」的两套清单。
 */
export const GITEE_GIT_TOOLS = Object.freeze({
  COMMIT: 'forge_gitee_git_commit',
  PUSH: 'forge_gitee_git_push',
});

/** 拒绝原因码：`GIT_` 前缀与工具层 `ACTION_REASONS` 分属两层，映射在 `gitFailureVerdict`。 */
export const GIT_REASONS = Object.freeze({
  INVALID_VERB: 'GIT_INVALID_VERB',
  MISSING_MESSAGE: 'GIT_MISSING_MESSAGE',
  INVALID_MESSAGE: 'GIT_INVALID_MESSAGE',
  INVALID_REMOTE: 'GIT_INVALID_REMOTE',
  INVALID_BRANCH: 'GIT_INVALID_BRANCH',
  INVALID_ARGUMENT: 'GIT_INVALID_ARGUMENT',
  SPAWN_FAILED: 'GIT_SPAWN_FAILED',
  COMMAND_FAILED: 'GIT_COMMAND_FAILED',
  COMMAND_TIMEOUT: 'GIT_COMMAND_TIMEOUT',
  INVALID_OUTPUT: 'GIT_INVALID_OUTPUT',
  READBACK_UNAVAILABLE: 'GIT_READBACK_UNAVAILABLE',
  INTERNAL: 'GIT_INTERNAL',
});

/** git 动作错误：`code` = 拒绝原因，`detail` 带「是否可能已发生」的判定依据。 */
export class GiteeGitError extends Error {
  constructor(message, { reason = GIT_REASONS.INTERNAL, detail = null } = {}) {
    super(message);
    this.name = 'GiteeGitError';
    this.code = reason;
    this.reason = reason;
    this.detail = detail;
  }
}

const PURPOSE_OF = Object.freeze({
  commit: 'git.commit',
  head: 'git.head',
  branch: 'git.branch',
  push: 'git.push',
});

// 分支/远端名都直接进 argv：只允许不会被打成选项的字符集，并显式拒绝 git 里语义特殊的写法。
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;
// 与 `gitee-actions` 的仓库引用同形（owner/name）；权威的 target 归一仍在动作层，这里只做入参快速拒绝。
const REPO_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const describeError = (error) => text(error?.message) || text(error?.code) || '未知错误';
const clip = (value, max = 180) => {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function assertMessage(value) {
  const message = typeof value === 'string' ? value : '';
  if (message.trim() === '') {
    throw new GiteeGitError('缺少提交信息（message）：git commit 需要一段非空说明', {
      reason: GIT_REASONS.MISSING_MESSAGE,
      detail: { argument: 'message' },
    });
  }
  if (message.includes('\u0000')) {
    throw new GiteeGitError('提交信息包含 NUL 字符：argv 不接受，拒绝执行', {
      reason: GIT_REASONS.INVALID_MESSAGE,
      detail: { argument: 'message' },
    });
  }
  return message;
}

function assertBranch(value) {
  const branch = text(value);
  if (
    branch === '' ||
    !BRANCH_PATTERN.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('@{')
  ) {
    throw new GiteeGitError(
      `分支名「${branch || '（空）'}」不是受支持的形态（字母/数字开头，只含字母/数字/._/-，不含 ..、//、@{、.lock）`,
      { reason: GIT_REASONS.INVALID_BRANCH, detail: { argument: 'branch' } },
    );
  }
  return branch;
}

function assertRemote(value) {
  const remote = text(value);
  if (remote === '' || !REMOTE_PATTERN.test(remote)) {
    throw new GiteeGitError(`远端名「${remote || '（空）'}」不是受支持的形态（字母/数字/._-，以字母或数字开头）`, {
      reason: GIT_REASONS.INVALID_REMOTE,
      detail: { argument: 'remote' },
    });
  }
  return remote;
}

/**
 * 动词 + 参数 → 固定 argv。`push` 只接受显式的 `<remote> <branch>`：不给 `--all`、`--tags`、
 * `--force`、`--delete` 之类留缝，参数里出现任何 `-` 开头都会被上面的非法字符拒绝。
 */
/** 每个动词接受的参数键：多余键（`force`、`tags`、`all` 之类）一律拒绝，不做静默丢弃。 */
const ARGUMENT_KEYS = Object.freeze({
  commit: Object.freeze(['message']),
  head: Object.freeze([]),
  branch: Object.freeze([]),
  push: Object.freeze(['remote', 'branch']),
});

export function gitArgvFor(verb, params = {}) {
  const name = text(verb);
  if (!GIT_VERBS.includes(name)) {
    throw new GiteeGitError(`不支持的 git 动词「${name || '（空）'}」：只允许 ${GIT_VERBS.join(' / ')}`, {
      reason: GIT_REASONS.INVALID_VERB,
      detail: { verb: name },
    });
  }
  const input = isPlainObject(params) ? params : {};
  const unexpected = Object.keys(input).filter((key) => !ARGUMENT_KEYS[name].includes(key));
  if (unexpected.length > 0) {
    throw new GiteeGitError(
      `git ${name} 不接受参数「${unexpected.join('、')}」：只允许 ${ARGUMENT_KEYS[name].join(' / ') || '（无）'}`,
      { reason: GIT_REASONS.INVALID_ARGUMENT, detail: { verb: name, argument: unexpected[0] } },
    );
  }
  switch (name) {
    case 'commit':
      return ['commit', '-m', assertMessage(input.message)];
    case 'head':
      return ['rev-parse', 'HEAD'];
    case 'branch':
      return ['branch', '--show-current'];
    case 'push':
      return ['push', assertRemote(input.remote ?? 'origin'), assertBranch(input.branch)];
    default:
      throw new GiteeGitError(`git 动词「${name}」没有 argv 定义（实现缺陷）`, {
        reason: GIT_REASONS.INVALID_VERB,
        detail: { verb: name },
      });
  }
}

/** 与 `gitArgvFor` 同源：返回 argv 与用途标签（用途进证据/审计，不靠调用方手写）。 */
export function assertGitArgv(verb, params = {}) {
  const argv = gitArgvFor(verb, params);
  return Object.freeze({ argv: Object.freeze(argv), purpose: PURPOSE_OF[text(verb)] });
}

/**
 * git 适配器：只持有执行器（`runner.runGit`）与 cwd，不做门禁判定。
 * 门禁与工具信封在 `createGitPush` / `createGitCommit`；策略在 guard。
 */
export function createGiteeGitAdapter({ runner, cwd = process.cwd(), now = Date.now } = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.runGit !== 'function') {
    throw new TypeError('git 适配器需要 runner.runGit(...)：git 与 gitee CLI 共用唯一执行出口（gitee-cli.mjs）');
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TypeError('git 适配器需要 cwd（仓库目录）：不传就拒绝，不猜当前目录');
  }
  if (typeof now !== 'function') throw new TypeError('git 适配器的 now 必须是函数');
  const root = cwd;
  const clock = now;

  async function run(verb, params) {
    const { argv, purpose } = assertGitArgv(verb, params);
    let outcome;
    try {
      outcome = await runner.runGit({ args: argv, purpose, cwd: root });
    } catch (error) {
      // 唯一出口在真正启动子进程前抛错：没有副作用，可以记 failed。
      throw new GiteeGitError(`git ${verb} 未能启动：${describeError(error)}`, {
        reason: GIT_REASONS.SPAWN_FAILED,
        detail: { timedOut: false, mayHaveSideEffect: false },
      });
    }
    if (!isPlainObject(outcome)) {
      throw new GiteeGitError(`git ${verb} 的执行器返回了非对象结果（实现缺陷）`, {
        reason: GIT_REASONS.INVALID_OUTPUT,
        detail: { mayHaveSideEffect: true, readback: true },
      });
    }
    const exitCode = Number.isInteger(outcome.exitCode) ? outcome.exitCode : null;
    const stdout = typeof outcome.stdout === 'string' ? outcome.stdout : '';
    const stderr = typeof outcome.stderr === 'string' ? outcome.stderr : '';
    if (outcome.timedOut === true) {
      throw new GiteeGitError(`git ${verb} 超时（命令可能已执行）：${clip(stderr) || '无输出'}`, {
        reason: GIT_REASONS.COMMAND_TIMEOUT,
        detail: { timedOut: true, mayHaveSideEffect: true },
      });
    }
    if (exitCode !== 0) {
      throw new GiteeGitError(
        `git ${verb} 失败（exit ${exitCode === null ? '未知' : exitCode}）：${clip(stderr || stdout) || '无输出'}`,
        { reason: GIT_REASONS.COMMAND_FAILED, detail: { exitCode, mayHaveSideEffect: false } },
      );
    }
    return Object.freeze({ exitCode, stdout, stderr, timedOut: false, truncated: outcome.truncated === true });
  }

  async function head() {
    const outcome = await run('head', {});
    const sha = (outcome.stdout.split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim().toLowerCase();
    if (!SHA_PATTERN.test(sha)) {
      throw new GiteeGitError(`git rev-parse HEAD 的输出不是 sha：${clip(sha) || '（空）'}`, {
        reason: GIT_REASONS.INVALID_OUTPUT,
        detail: { readback: true },
      });
    }
    return Object.freeze({ sha });
  }

  async function branch() {
    const outcome = await run('branch', {});
    const name = (outcome.stdout.split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim();
    // 分离头指针时 `--show-current` 输出为空：这不是失败，交给调用方决定怎么表达。
    return Object.freeze({ branch: name });
  }

  async function commit({ changeId, message } = {}) {
    // 适配器自己也校验一次（纵深防御）：即使工具层被绕过，也不会把不合规的提交写进历史。
    const verified = assertCommitMessage({ changeId, message });
    await run('commit', { message });
    let sha;
    let branchName;
    try {
      sha = (await head()).sha;
      branchName = (await branch()).branch;
    } catch (error) {
      // 提交已经发生，只是回读失败：如实标记「可能已落地」，让工具层转人工核对而不是重放。
      throw new GiteeGitError(`提交已执行，但回读 HEAD 失败：${describeError(error)}`, {
        reason: GIT_REASONS.READBACK_UNAVAILABLE,
        detail: { mayHaveSideEffect: true, readback: true },
      });
    }
    return Object.freeze({
      ok: true,
      changeId: verified.changeId,
      sha,
      subject: verified.subject,
      branch: branchName,
      evidence: buildEvidence({
        command: 'git.commit',
        at: new Date(clock()).toISOString(),
        target: verified.changeId,
        sourceType: 'gitee-cli',
      }),
    });
  }

  async function push({ remote = 'origin', branch: branchName } = {}) {
    const remoteName = assertRemote(remote);
    const targetBranch = assertBranch(branchName);
    await run('push', { remote: remoteName, branch: targetBranch });
    return Object.freeze({ ok: true, remote: remoteName, branch: targetBranch });
  }

  return Object.freeze({
    commit,
    push,
    head,
    branch,
    describe: () =>
      Object.freeze({ bin: GIT_BIN, cwd: root, verbs: GIT_VERBS, shell: false, runner: 'runGit' }),
  });
}

/* ------------------------------------------------------------------ 工具层 */

const TOOL_OUTPUT = Object.freeze({
  schema: { type: 'object' },
  render: (_args, value) => json(value).content,
});

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 提交在策略目录里的位置：没有，也不该有（见文件头第 2 条）。 */
const GIT_COMMIT_ACTION = 'gitee.git.commit';

/** 工具层持有的 git 端口：`service.git()` 与 `service.adapter()` 平级（唯一装配点在 index）。 */
function gitPort(service) {
  if (service === null || typeof service !== 'object') {
    throw new TypeError('gitee git 工具需要 service（唯一装配点），不允许直接持有执行器');
  }
  const port = typeof service.git === 'function' ? service.git() : service.git;
  if (port === null || typeof port !== 'object' || typeof port.commit !== 'function' || typeof port.push !== 'function') {
    throw new TypeError('gitee git 工具需要 service.git()（含 commit/push）；缺少即拒绝执行');
  }
  return port;
}

function denyGit(spec, reason, detail, target = null, rule = 'argument-invalid') {
  return settleActionVerdict(
    spec,
    { status: 'denied', reason, rule, detail },
    { target, key: null },
  );
}

/** git 错误 → 动作四状态：只有「确定没启动/没执行」才记 failed，其余一律 unknown（不重放）。 */
function gitFailureVerdict(error, what) {
  const detail = isPlainObject(error?.detail) ? error.detail : {};
  const message = describeError(error);
  if (detail.readback === true) {
    return {
      status: 'unknown',
      reason: ACTION_REASONS.READBACK_UNAVAILABLE,
      rule: 'readback-unavailable',
      detail: `${what}已执行但回读失败，无法确认（不重放）：${message}`,
    };
  }
  if (!(error instanceof GiteeGitError)) {
    // 不是适配器抛的：调用发生在任何子进程之前（端口缺失/参数错误），零副作用。
    return {
      status: 'failed',
      reason: ACTION_REASONS.INTERNAL,
      rule: 'internal-error',
      detail: `${what}未执行：${message}`,
    };
  }
  if (detail.timedOut === true) {
    return {
      status: 'unknown',
      reason: ACTION_REASONS.COMMAND_TIMEOUT,
      rule: 'command-timeout',
      detail: `${what}超时，可能已发生，转人工核对（不自动重放）：${message}`,
    };
  }
  if (error.code === GIT_REASONS.SPAWN_FAILED) {
    return {
      status: 'failed',
      reason: ACTION_REASONS.SPAWN_FAILED,
      rule: 'spawn-failed',
      detail: `${what}命令未启动（无副作用）：${message}`,
    };
  }
  if (detail.mayHaveSideEffect === true) {
    return {
      status: 'unknown',
      reason: ACTION_REASONS.COMMAND_FAILED,
      rule: 'command-uncertain',
      detail: `${what}结果不确定，转人工核对（不自动重放）：${message}`,
    };
  }
  return { status: 'failed', reason: ACTION_REASONS.COMMAND_FAILED, rule: 'command-failed', detail: `${what}失败：${message}` };
}

function assertKnownArguments(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return `不支持的参数「${key}」：只接受 ${allowed.join(' / ')}`;
  }
  return '';
}

/**
 * `forge_gitee_git_commit`：本地提交。
 *
 * 不经 guard/policy（设计 §3.5）：策略目录表达不了「已启用但不需审批」，硬塞进去只能让提交
 * 要么默认拒绝、要么永远等审批。门禁改为「提交信息必须合规」，不通过时**零子进程**。
 */
export function createGitCommit() {
  const spec = Object.freeze({ tool: GITEE_GIT_TOOLS.COMMIT, action: GIT_COMMIT_ACTION });
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      const input = isPlainObject(args) ? args : {};
      const unknown = assertKnownArguments(input, ['changeId', 'message']);
      if (unknown !== '') return denyGit(spec, ACTION_REASONS.INVALID_ARGUMENT, unknown);
      const changeId = text(input.changeId);
      if (changeId === '') {
        return denyGit(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）：提交首行必须是 `[变更号] 描述`');
      }
      let verified;
      try {
        verified = assertCommitMessage({ changeId, message: input.message });
      } catch (error) {
        if (!(error instanceof CommitMessageError)) throw error;
        return denyGit(
          spec,
          ACTION_REASONS.COMMIT_MESSAGE_INVALID,
          `提交信息不合规：${error.message}；期望格式：${error.expectedFormat}`,
          changeId,
          'commit-message-invalid',
        );
      }
      try {
        const result = await gitPort(service).commit({ changeId: verified.changeId, message: input.message });
        return settleActionVerdict(
          spec,
          {
            status: 'done',
            value: {
              status: 'done',
              target: verified.changeId,
              object_ref: result.sha,
              readback: {
                via: 'git-rev-parse',
                ok: true,
                sha: result.sha,
                branch: result.branch === '' ? null : result.branch,
              },
              evidence: result.evidence,
              remote_calls: 0,
            },
          },
          { target: verified.changeId, key: null },
        );
      } catch (error) {
        return settleActionVerdict(spec, gitFailureVerdict(error, '本地提交'), {
          target: changeId,
          key: null,
        });
      }
    },
  });
}

/**
 * `forge_gitee_git_push`：远端写，动作 `gitee.git.push`。
 *
 * 门禁（guard）在入参校验之后：默认目录未登记即 denied、登记后仍要 `confirm{repo,object}`；
 * 这两条都不进 `payload.run`，所以拒绝时 git 适配器一次也不会被调用。
 */
export function createGitPush() {
  const spec = Object.freeze({ tool: GITEE_GIT_TOOLS.PUSH, action: GITEE_ACTIONS.GIT_PUSH });
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      const input = isPlainObject(args) ? args : {};
      const unknown = assertKnownArguments(input, ['target', 'branch', 'remote', 'changeId', 'confirm']);
      if (unknown !== '') return denyGit(spec, ACTION_REASONS.INVALID_ARGUMENT, unknown);
      const target = text(input.target);
      if (target === '') {
        return denyGit(spec, ACTION_REASONS.MISSING_TARGET, '缺少 target：推送目标是 `owner/name` 仓库');
      }
      if (!REPO_TARGET_PATTERN.test(target)) {
        return denyGit(spec, ACTION_REASONS.INVALID_TARGET, `target「${target}」不是 owner/name 形态的仓库引用`);
      }
      const branch = text(input.branch);
      if (branch === '') {
        return denyGit(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少 branch：必须显式给出要推送的分支（不推断远端分支）', target);
      }
      const remote = text(input.remote) || 'origin';
      try {
        assertGitArgv('push', { remote, branch });
      } catch (error) {
        return denyGit(spec, ACTION_REASONS.INVALID_ARGUMENT, `推送参数不合法：${describeError(error)}`, target);
      }
      if (typeof service?.execute !== 'function') {
        throw new TypeError('gitee git 工具需要 service.execute()：写动作不允许绕过门禁');
      }
      let verdict;
      try {
        verdict = await service.execute({
          action: spec.action,
          target,
          tool: spec.tool,
          confirm: isPlainObject(input.confirm) ? input.confirm : undefined,
          payload: {
            arguments: { target, remote, branch, change: text(input.changeId) || null, op: 'push' },
            run: async () => {
              try {
                const result = await gitPort(service).push({ remote, branch });
                return {
                  status: 'done',
                  target,
                  object_ref: `${result.remote}/${result.branch}`,
                  readback: { via: 'git-push', ok: true, remote: result.remote, branch: result.branch },
                  evidence: buildEvidence({
                    command: 'git.push',
                    at: new Date().toISOString(),
                    target,
                    sourceType: 'gitee-cli',
                  }),
                  remote_calls: 1,
                };
              } catch (error) {
                return { ...gitFailureVerdict(error, '推送'), target, remote_calls: 1 };
              }
            },
          },
        });
      } catch (error) {
        return settleActionVerdict(
          spec,
          {
            status: error?.denied === true ? 'denied' : 'failed',
            reason: text(error?.code) || ACTION_REASONS.INTERNAL,
            rule: error?.denied === true ? 'service-refused' : 'internal-error',
            detail: describeError(error),
          },
          { target, key: null },
        );
      }
      return settleActionVerdict(spec, verdict, { target, key: null });
    },
  });
}

/**
 * 两个 git 工具的定义（顺序：commit → push）。输出与既有写工具同形：
 * `{schema:'object', render}` + 一段 JSON 文本，模型按同一套形状读结果。
 */
export function gitToolDefinitions(service) {
  const commit = createGitCommit();
  const push = createGitPush();
  return [
    {
      name: commit.tool,
      description:
        '在本地工作区做一次提交：提交信息首行必须是 `[变更号] 描述`，变更号与 changeId 一致，描述不能为空。' +
        '只提交已暂存的改动，不改写历史、不附加任何开关；返回提交 sha、当前分支与提交信息回读。',
      parameters: {
        type: 'object',
        properties: {
          changeId: {
            type: 'string',
            description: '本变更的变更号（如 CHG-2026-0042）；必须与提交信息开头方括号内逐字一致。',
          },
          message: {
            type: 'string',
            description: '完整提交信息；首行形如 `[CHG-2026-0042] 修复登录超时`，正文可多行。',
          },
        },
        required: ['changeId', 'message'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      execute: async (args) => json(await commit.run(args ?? {}, service)),
    },
    {
      name: push.tool,
      description:
        '把当前分支推送到远端：目标仓库必须是 owner/name，分支必须显式给出。默认未登记即拒绝，' +
        '登记后仍需人工审批与 confirm{repo,object}；只推一个分支，不推标签、不强制、不删除远端分支。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标仓库 owner/name（不含 #编号）。' },
          branch: { type: 'string', description: '要推送的本地分支名。' },
          remote: { type: 'string', description: '远端名，默认 origin。' },
          changeId: { type: 'string', description: '关联变更号（可选，用于证据与台账关联）。' },
          confirm: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: '与 target 逐字相同的仓库。' },
              object: { type: 'string', description: '与 target 逐字相同的对象（推送时就是仓库本身）。' },
            },
            required: ['repo', 'object'],
            additionalProperties: false,
          },
        },
        required: ['target', 'branch'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      execute: async (args) => json(await push.run(args ?? {}, service)),
    },
  ];
}
