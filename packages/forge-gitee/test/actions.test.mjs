/**
 * 受控动作四状态机 + 门禁准入（AC-3 / AC-5 / AC-6 / AC-8 / AC-9 / AC-11 / AC-14 / AC-16）。
 *
 * 这个文件有三块职责，分别对应三件真会出事的事：
 *
 * 1. **默认禁用是真的禁用**（AC-3；r4 编号 AC-17）：四个写动作在未登记的分发目录下必须 `denied`，
 *    且适配器与 `execFile` 各 0 次调用——"工具存在但拒了"与"工具根本不能被调用"要能区分开。
 *    r7 起判定（`gitee.delivery.judge`）是**默认登记的只读能力**，它在这里只保留"目录缺条目
 *    时同样 denied"的单元镜像（AC-8），不再算进"写动作默认禁用"的口径。
 * 2. **`done` 不能只看退出码**（AC-16）：退出码 0 只说明命令跑了。回读不一致、回读失败、超时、
 *    输出畸形一律降格 `unknown`，并且台账记下来挡住重放。
 * 3. **门禁是唯一准入点**（AC-11）：动作名必须 `gitee.*`、目标必须存在、确认必须逐字相符、
 *    审计记录必须自证 provider；这些都在 `gitee-guard.mjs` 里，本文件只断言"它确实在生效"。
 *
 * 夹具全部离线：没有网络、没有真凭据、没有子进程。`execFile` 的调用被计成 `counters.execFile`，
 * 于是"零子进程"是一条可复核的计数，而不是一句保证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GiteeAdapterError, createGiteeAdapter } from '../src/gitee-adapter.mjs';
import {
  ACTION_REASONS,
  ACTION_STATUSES,
  GITEE_ACTIONS,
  publishReview,
  writeToolDefinitions,
} from '../src/gitee-actions.mjs';
import { CONFIRM_REQUIRED_ACTIONS, GUARD_REASONS, createGiteeGuard } from '../src/gitee-guard.mjs';
import { createGiteeSession } from '../src/gitee-session.mjs';
import { GITEE_JUDGE_TOOLS, GITEE_WRITE_TOOLS } from '../src/gitee-tools.mjs';

const SRC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');
const HEX16 = /^[0-9a-f]{16}$/u;
const CLOCK = 1_700_000_000_000;

/** 5 个受控工具（顺序 = 4 写 + 1 判定；名字是 PRD 契约，不能随手改）。 */
const CONTROLLED_TOOLS = [
  'forge_gitee_issue_write',
  'forge_gitee_pr_write',
  'forge_gitee_review_publish',
  'forge_gitee_review_record',
  'forge_gitee_delivery_gate',
];

const ISSUE_CREATE = {
  op: 'create',
  target: 'acme/repo',
  changeId: 'CHG-2026-001',
  title: '同步变更',
  body: '这是变更正文。',
  confirm: { repo: 'acme/repo', object: 'acme/repo' },
};
const PR_CREATE = { ...ISSUE_CREATE, head: 'feat/sync', base: 'main' };
const REVIEW_PUBLISH = {
  target: 'acme/repo!12',
  changeId: 'CHG-2026-001',
  commit: 'a'.repeat(40),
  body: '## 结论\n通过',
  confirm: { repo: 'acme/repo', object: 'acme/repo!12' },
};
const DELIVERY_GATE = {
  changeId: 'CHG-2026-001',
  commit: 'a'.repeat(40),
  message: '[CHG-2026-001] feat: 同步变更',
  criteria: { acceptance: 'pass', merged: 'unknown', pendingDelivery: 'pass', humanConfirmed: 'pass' },
};

/**
 * 判定"全通过"的输入（TECHNICAL §3.2 逐字）：四项条件全部 passed / count 0。
 *
 * 裸结论字符串 `'pass'` 现在与 `status: 'passed'` 同义（r7 QA DEF-1：工具描述声明的取值必须
 * 真的被接受）；这里仍用对象事实写法，让 AC-2/AC-5 覆盖 TECHNICAL §3.2 声明的形状。
 */
const DELIVERY_GATE_READY = {
  changeId: 'CHG-2026-001',
  commit: 'a'.repeat(40),
  message: '[CHG-2026-001] 判定默认登记',
  criteria: {
    acceptance: { status: 'passed', evidence: '离线 CI 全绿', sourceType: 'ci' },
    merged: { status: 'passed', evidence: 'PR 已合入', sourceType: 'platform' },
    pendingDelivery: { count: 0 },
    humanConfirmed: { decision: 'confirmed' },
  },
};

function reviewRecordArgs(repoRoot) {
  return {
    repoRoot,
    changeId: 'CHG-2026-001',
    commit: 'a'.repeat(40),
    model: 'test-model',
    findings: [],
    risks: [],
    opinion: 'approve',
    conclusion: 'pass',
  };
}

/**
 * 假 service 端口：形状与 `index.mjs` 的 `createService` 一致，门禁用**真的** `createGiteeGuard`。
 *
 * 只有策略与子进程是假的：策略用可编程裁决（放行/未登记），子进程用计数桩，于是
 * "denied 时零调用"可以被计数验证。
 */
function createHarness(options = {}) {
  const {
    admit = true,
    admitRule = 'registered-action',
    audit = () => [],
    preflight: preflightOverride,
    invoke: invokeOverride,
    read: readOverride,
  } = options;

  const counters = { decide: 0, operations: 0, invoke: 0, read: 0, execFile: 0 };
  const decided = [];
  const invoked = [];

  const policy = {
    decide(input) {
      counters.decide += 1;
      decided.push({ action: input.action, target: input.target, egress: input.egress });
      if (admit === true) return { action: 'allow', rule: admitRule };
      return { action: 'deny', rule: 'unregistered-action', reason: `${input.action} 未在分发目录登记（默认禁用）` };
    },
    async executeAction(ctx, action, exec, operation) {
      counters.operations += 1;
      return operation();
    },
    auditRecords: () => audit(),
  };

  const guard = createGiteeGuard({ policy, now: () => CLOCK });
  const session = createGiteeSession({ now: () => CLOCK });

  const service = {
    provider: 'gitee',
    async execute(request) {
      return guard.execute(request);
    },
    preflight: () =>
      typeof preflightOverride === 'function'
        ? preflightOverride()
        : {
            ok: true,
            provider: 'gitee',
            reason: null,
            message: null,
            mayHaveSideEffect: false,
            tokenSource: 'env',
            authEnv: 'GITEE_TOKEN',
            host: 'gitee.com',
          },
    async invoke(command, params, purpose) {
      counters.invoke += 1;
      counters.execFile += 1;
      invoked.push({ command, params, purpose });
      if (typeof invokeOverride === 'function') return invokeOverride({ command, params, purpose });
      return {
        provider: 'gitee',
        command,
        label: command,
        args: [],
        purpose,
        stdout: '',
        exitCode: 0,
        observedAt: new Date(CLOCK).toISOString(),
        truncated: false,
      };
    },
    adapter: () => ({
      async read(action, target, params) {
        counters.read += 1;
        counters.execFile += 1;
        if (typeof readOverride === 'function') return readOverride({ action, target, params });
        return {
          provider: 'gitee',
          action,
          kind: 'object',
          target_ref: target,
          status: 'succeeded',
          source_revision: 'rev-1',
          observed_at: new Date(CLOCK + 1_000).toISOString(),
          result_refs: [],
          command: 'issueView',
          missing_fields: [],
          object: {},
          raw: null,
        };
      },
    }),
    session: () => session,
  };

  return { service, counters, decided, invoked, session, guard, policy };
}

/** 走模型可见的工具定义（而不是直接调工厂），顺带验证注册表接得上。 */
async function runTool(service, name, args) {
  const definition = writeToolDefinitions(service).find((item) => item.name === name);
  assert.ok(definition !== undefined, `工具 ${name} 未在注册表里`);
  const output = await definition.execute(args);
  assert.equal(Array.isArray(output?.content), true, `${name} 的返回值不是工具输出形状`);
  return JSON.parse(output.content[0].text);
}

/** 写命令成功输出（Gitee 写命令没有 `--json`，只能从人类可读输出里取链接）。 */
function createdStdout(label, link) {
  return ({ command, params, purpose }) => ({
    provider: 'gitee',
    command,
    label,
    args: [],
    purpose,
    stdout: `创建成功：${link(params)}`,
    exitCode: 0,
    observedAt: new Date(CLOCK).toISOString(),
    truncated: false,
  });
}

function readbackObject(object) {
  return ({ action, target }) => ({
    provider: 'gitee',
    action,
    kind: 'object',
    target_ref: target,
    status: 'succeeded',
    source_revision: 'rev-1',
    observed_at: new Date(CLOCK + 1_000).toISOString(),
    result_refs: [],
    command: 'issueView',
    missing_fields: [],
    object,
    raw: null,
  });
}

// 回读对象按实测字段名给：编号 `id`（不是 `number`）、状态 `open`（适配器已把实测的 `opened`
// 归一，这一层拿到的是归一后的事实）；**没有**评论计数（实测 `issue list` 无该字段、`issue view`
// 形状未实测），所以摘要里的 `comments` 只能是 null——不拿别的字段凑。
const doneReadback = readbackObject({ id: 12, title: '同步变更', state: 'open' });

test('AC-9/14 受控工具面固定 5 个（4 写 + 1 判定），顺序与命名不可随手改，且没有 argv/命令/泛化入口', () => {
  assert.deepEqual([...ACTION_STATUSES], ['done', 'failed', 'denied', 'unknown']);
  // 两处口径必须同字面：测试清单 vs `gitee-tools.mjs` 的常量（本次 r7 拆成 4 写 + 1 判定）。
  assert.deepEqual(CONTROLLED_TOOLS, [...GITEE_WRITE_TOOLS, ...GITEE_JUDGE_TOOLS], '受控工具清单与 gitee-tools 常量不符');
  assert.deepEqual([...GITEE_JUDGE_TOOLS], ['forge_gitee_delivery_gate'], '判定工具名是契约');
  const definitions = writeToolDefinitions(createHarness().service);
  assert.deepEqual(definitions.map((definition) => definition.name), CONTROLLED_TOOLS);
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function');
    assert.ok(definition.description.length > 20, `${definition.name} 缺少可读描述`);
    assert.equal(definition.parameters.type, 'object');
    const properties = definition.parameters.properties ?? {};
    for (const forbidden of ['command', 'argv', 'args', 'bin', 'cliPath', 'token']) {
      assert.equal(forbidden in properties, false, `${definition.name} 暴露了 ${forbidden}（会出现"让模型自己拼命令"的入口）`);
    }
    // 参数描述里不能出现 CLI 旗标：模型描述的是意图，不是 argv。
    assert.doesNotMatch(JSON.stringify(definition.parameters), /--[a-z]/u);
  }
});

// r4 的 AC-17 在这里按 r7 口径拆开：前 4 个写动作 = "默认禁用写"（AC-3）；第 5 个判定在这个
// 用例里 deny 是**单元镜像**（目录里没有这条 = AC-8 的降级），不是分发默认（默认它是登记的只读判定）。
test('AC-3/AC-8 默认禁用：未登记时四个写动作逐个 denied、规则固定、适配器与 execFile 各 0 次调用', async () => {
  const harness = createHarness({ admit: false });
  const writeCases = [
    ['forge_gitee_issue_write', ISSUE_CREATE],
    ['forge_gitee_pr_write', PR_CREATE],
    ['forge_gitee_review_publish', REVIEW_PUBLISH],
    ['forge_gitee_review_record', reviewRecordArgs(mkdtempSync(join(tmpdir(), 'forge-gitee-deny-')))],
  ];
  const cases = [...writeCases, ['forge_gitee_delivery_gate', DELIVERY_GATE]];
  assert.equal(writeCases.length, GITEE_WRITE_TOOLS.length, '写动作清单必须与 GITEE_WRITE_TOOLS 等长');

  for (const [tool, args] of cases) {
    const body = await runTool(harness.service, tool, args);
    assert.equal(body.status, 'denied', `${tool} 未登记却不是 denied`);
    assert.equal(body.rule, 'unregistered-action', `${tool} 的规则必须透出目录事实`);
    assert.equal(body.reason, GUARD_REASONS.ACTION_UNREGISTERED);
    assert.equal(body.remote_calls, 0);
    // 被拒的动作没有证据：留一个空 evidence 会被读成"执行过但没证据"。
    assert.equal('evidence' in body, false, `${tool} 被拒却带了证据`);
    assert.equal(body.ok, false);
    // 拒绝必须可执行：调用方要知道下一步是去登记目录，而不是反复重试同一个调用。
    assert.equal(body.next_action, 'register-policy-action', `${tool} 被拒却没有可执行的下一步`);
    assert.match(body.detail, /heluo-policy/u, `${tool} 的拒绝文案没说清向谁登记、在哪登记`);
  }

  assert.equal(harness.counters.decide, 5, '每个动作都问过目录（拒绝是裁决，不是短路）');
  assert.equal(harness.counters.operations, 0);
  assert.equal(harness.counters.invoke, 0);
  assert.equal(harness.counters.read, 0);
  assert.equal(harness.counters.execFile, 0);
});

test('AC-16 回归：review.publish 与 review.record 同变更同提交，目标不同则幂等键不同（不跨对象复用）', async () => {
  const harness = createHarness({ admit: false });
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-gitee-cross-object-'));
  try {
    const published = await runTool(harness.service, 'forge_gitee_review_publish', REVIEW_PUBLISH);
    const recorded = await runTool(harness.service, 'forge_gitee_review_record', reviewRecordArgs(repoRoot));
    assert.equal(published.status, 'denied');
    assert.equal(recorded.status, 'denied');
    assert.match(published.idempotency_key, HEX16);
    assert.match(recorded.idempotency_key, HEX16);
    assert.notEqual(
      published.idempotency_key,
      recorded.idempotency_key,
      '同一变更同一提交但动作/目标不同：共用键会让后一次写误判 reused=true 并静默返回上一次结果',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('AC-11 非 gitee.* 动作在门禁入口就地拒绝：零策略调用、零子进程', async () => {
  const harness = createHarness();
  let ran = 0;
  const body = await harness.guard.execute({
    action: 'github.issue.write',
    target: 'acme/repo',
    payload: { run: () => { ran += 1; return { status: 'done' }; } },
  });
  assert.equal(body.status, 'denied');
  assert.equal(body.rule, 'provider-mismatch');
  assert.equal(body.reason, GUARD_REASONS.PROVIDER_MISMATCH);
  assert.equal(ran, 0);
  assert.equal(harness.counters.decide, 0, '不属于本 provider 的动作不该进策略目录');
  assert.equal(harness.counters.execFile, 0);
});

test('AC-11 确认是"逐字相符"：缺失或改写目标都 denied，零写入', async () => {
  const missing = createHarness();
  const noConfirm = { ...ISSUE_CREATE };
  delete noConfirm.confirm;
  const first = await runTool(missing.service, 'forge_gitee_issue_write', noConfirm);
  assert.equal(first.status, 'denied');
  assert.equal(first.rule, 'confirm-required');
  assert.equal(first.reason, GUARD_REASONS.CONFIRMATION_REQUIRED);
  assert.equal(first.next_action, 'confirm-object', '确认缺失要指向补确认，而不是泛泛失败');
  assert.equal(missing.counters.invoke, 0);

  const tampered = createHarness();
  const second = await runTool(tampered.service, 'forge_gitee_issue_write', {
    ...ISSUE_CREATE,
    confirm: { repo: 'acme/repo', object: 'acme/other' },
  });
  assert.equal(second.status, 'denied');
  assert.equal(second.rule, 'confirm-required');
  assert.equal(tampered.counters.invoke, 0);
  assert.equal(tampered.counters.execFile, 0);
});

test('AC-16 退出码 0 不算成功：写命令输出里没有可回读的引用 → unknown（且不回读、不落台账为 done）', async () => {
  const harness = createHarness({
    invoke: ({ command, purpose }) => ({
      provider: 'gitee',
      command,
      label: command,
      args: [],
      purpose,
      stdout: '命令执行完毕。',
      exitCode: 0,
      observedAt: new Date(CLOCK).toISOString(),
      truncated: false,
    }),
  });
  const body = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(body.status, 'unknown');
  assert.equal(body.reason, ACTION_REASONS.MALFORMED_RESULT);
  assert.equal(body.rule, 'malformed-result');
  assert.equal(body.readback.ok, false);
  assert.equal(harness.counters.invoke, 1);
  assert.equal(harness.counters.read, 0, '没有对象可回读时不该瞎回读');
  assert.equal(harness.session.lookup(body.idempotency_key)?.status, 'unknown');
});

test('AC-16 done = 写入成功 + 回读一致：标题对上才算做到，证据同时落形状', async () => {
  const harness = createHarness({
    invoke: createdStdout('issueCreate', ({ target }) => `https://gitee.com/${target}/issues/12`),
    read: doneReadback,
  });
  const body = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(body.status, 'done');
  assert.equal(body.ok, true);
  assert.equal(body.object_ref, 'acme/repo#12');
  assert.equal(body.readback.ok, true);
  assert.equal(body.readback.via, 'gitee.issue.read');
  assert.equal(body.readback.state, 'open', 'opened 归一到既有词表');
  assert.equal(body.readback.comments, null, 'Issue 载荷没有已声明的评论计数：摘要不为它编数');
  assert.equal(body.remote_calls, 2, '一次写 + 一次回读');
  assert.equal(body.evidence.provider, 'gitee');
  assert.equal(body.evidence.command, 'issueCreate');
  assert.equal(body.evidence.sourceType, 'gitee-cli');
  assert.equal(body.evidence.target, 'acme/repo#12');
  assert.equal(harness.counters.invoke, 1);
  assert.equal(harness.counters.read, 1);
});

test('AC-16 回读不一致 → unknown，绝不因为"退出码 0"记成功；台账记 unknown 挡住重放', async () => {
  const harness = createHarness({
    invoke: createdStdout('issueCreate', ({ target }) => `https://gitee.com/${target}/issues/12`),
    read: readbackObject({ title: '别的标题', comments: 0 }),
  });
  const first = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(first.status, 'unknown');
  assert.equal(first.reason, ACTION_REASONS.READBACK_MISMATCH);
  assert.equal(first.rule, 'readback-mismatch');
  assert.equal(first.readback.ok, false);
  assert.equal(harness.session.lookup(first.idempotency_key)?.status, 'unknown');

  const second = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(second.status, 'unknown');
  assert.equal(second.replay_blocked, true);
  assert.equal(second.reason, ACTION_REASONS.REPLAY_BLOCKED);
  assert.equal(harness.counters.invoke, 1, 'unknown 之后不得再写一次');
});

test('AC-16 PR 建单回读核对源分支：字段是实测的 source_branch（不是 GitHub 的 head）', async () => {
  const invoke = createdStdout('prCreate', ({ target }) => `https://gitee.com/${target}/pulls/12`);

  const matched = createHarness({
    invoke,
    read: readbackObject({ iid: 12, title: '同步变更', state: 'open', source_branch: 'feat/sync', target_branch: 'main' }),
  });
  const done = await runTool(matched.service, 'forge_gitee_pr_write', PR_CREATE);
  assert.equal(done.status, 'done');
  assert.equal(done.object_ref, 'acme/repo#12');
  assert.equal(done.readback.ok, true);

  // 同标题不同分支是两次交付：源分支对不上就必须 unknown（不许因为标题对就算 done）。
  const mismatched = createHarness({
    invoke,
    read: readbackObject({ iid: 12, title: '同步变更', state: 'open', source_branch: 'other/branch' }),
  });
  const bad = await runTool(mismatched.service, 'forge_gitee_pr_write', PR_CREATE);
  assert.equal(bad.status, 'unknown');
  assert.equal(bad.reason, ACTION_REASONS.READBACK_MISMATCH);
  assert.match(bad.detail, /other\/branch/);
  assert.equal(mismatched.session.lookup(bad.idempotency_key)?.status, 'unknown', '不确定的写要落台账挡住重放');
});

test('AC-16 评论回读按对象类型取计数：PR 用 user_notes_count，Issue 没有已声明字段即 unknown', async () => {
  const prComment = {
    op: 'comment',
    target: 'acme/repo!12',
    changeId: 'CHG-2026-001',
    body: '评论正文。',
    confirm: { repo: 'acme/repo', object: 'acme/repo!12' },
  };
  const landed = createHarness({
    invoke: createdStdout('prComment', () => 'https://gitee.com/acme/repo/pulls/12'),
    read: readbackObject({ iid: 12, title: '同步变更', state: 'open', user_notes_count: 2 }),
  });
  const published = await runTool(landed.service, 'forge_gitee_pr_write', prComment);
  assert.equal(published.status, 'done');
  assert.equal(published.readback.comments, 2, 'PR 的评论数取实测字段 user_notes_count');

  // 计数为 0：评论没落地，转人工核对（不当作成功）。
  const vanished = createHarness({
    invoke: createdStdout('prComment', () => 'https://gitee.com/acme/repo/pulls/12'),
    read: readbackObject({ iid: 12, title: '同步变更', state: 'open', user_notes_count: 0 }),
  });
  const missed = await runTool(vanished.service, 'forge_gitee_pr_write', prComment);
  assert.equal(missed.status, 'unknown');
  assert.equal(missed.reason, ACTION_REASONS.READBACK_MISMATCH);

  // Issue 评论：Issue 载荷没有已声明的计数（实测 issue list 无该字段、issue view 形状未实测），
  // 无法核对 → unknown/readback-unavailable，不重放，也不拿别的字段凑一个数。
  const issueComment = {
    op: 'comment',
    target: 'acme/repo#12',
    changeId: 'CHG-2026-001',
    body: '评论正文。',
    confirm: { repo: 'acme/repo', object: 'acme/repo#12' },
  };
  const unverifiable = createHarness({
    invoke: createdStdout('issueComment', () => 'https://gitee.com/acme/repo/issues/12'),
    read: readbackObject({ id: 12, title: '同步变更', state: 'open' }),
  });
  const body = await runTool(unverifiable.service, 'forge_gitee_issue_write', issueComment);
  assert.equal(body.status, 'unknown');
  assert.equal(body.reason, ACTION_REASONS.READBACK_UNAVAILABLE);
  assert.equal(body.readback.comments, null);
  assert.match(body.detail, /issue list 无该字段/);
  assert.equal(unverifiable.session.lookup(body.idempotency_key)?.status, 'unknown');
});

test('AC-16 超时 → unknown 且不再回读（可能已落地），第二次直接 replay_blocked 零子进程', async () => {
  const harness = createHarness({
    invoke: () => {
      throw new GiteeAdapterError('TIMEOUT', 'gitee cli 超过 15000ms 未返回', { timedOut: true, mayHaveSideEffect: true });
    },
  });
  const first = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(first.status, 'unknown');
  assert.equal(first.reason, ACTION_REASONS.COMMAND_TIMEOUT);
  assert.equal(harness.counters.invoke, 1);
  assert.equal(harness.counters.read, 0);

  const second = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(second.status, 'unknown');
  assert.equal(second.replay_blocked, true);
  assert.equal(second.remote_calls, 0);
  assert.equal(harness.counters.invoke, 1);
  assert.equal(harness.counters.execFile, 1);
});

test('AC-16 命令没启动 → failed（确定未生效）且不写台账，同一个键可以正常重试', async () => {
  let mode = 'spawn';
  const harness = createHarness({
    invoke: (input) => {
      if (mode === 'spawn') throw new GiteeAdapterError('SPAWN_FAILED', 'spawn gitee ENOENT', {});
      return createdStdout('issueCreate', ({ target }) => `https://gitee.com/${target}/issues/12`)(input);
    },
    read: doneReadback,
  });
  const first = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(first.status, 'failed');
  assert.equal(first.reason, ACTION_REASONS.SPAWN_FAILED);
  assert.equal(first.rule, 'spawn-failed');
  assert.equal(harness.session.lookup(first.idempotency_key), undefined, 'failed 不该进台账（否则重试会被自己挡住）');

  mode = 'ok';
  const second = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(second.status, 'done');
  assert.equal(second.reused, false);
});

test('AC-16 幂等命中：同一变更同一对象第二次调用 reused=true 且零远端调用', async () => {
  const harness = createHarness({
    invoke: createdStdout('issueCreate', ({ target }) => `https://gitee.com/${target}/issues/12`),
    read: doneReadback,
  });
  const first = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(first.status, 'done');

  const second = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(second.status, 'done');
  assert.equal(second.reused, true);
  assert.equal(second.remote_calls, 0);
  assert.equal(second.object_ref, 'acme/repo#12');
  assert.equal(second.idempotency_key, first.idempotency_key);
  assert.equal(harness.counters.invoke, 1);
  assert.equal(harness.counters.read, 1);
  assert.equal(harness.counters.execFile, 2, '首次调用 = 一次写 + 一次回读，两次都是同一条 CLI 出口');
});

test('AC-16 预检未过（缺凭据/持久令牌）→ failed 而不是 denied，零子进程', async () => {
  const harness = createHarness({
    preflight: () => ({
      ok: false,
      provider: 'gitee',
      reason: 'AUTH_MISSING',
      message: '缺少 GITEE_TOKEN（环境里没有可用凭据）',
      mayHaveSideEffect: false,
    }),
  });
  const body = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(body.status, 'failed');
  assert.equal(body.reason, ACTION_REASONS.AUTH_MISSING);
  assert.equal(body.rule, 'preflight-failed');
  assert.notEqual(body.status, 'denied', '门禁已经放行，拒它的是环境，不是策略');
  assert.equal(body.next_action, 'configure-credentials', '缺凭据要给凭据修复动作');
  assert.equal(harness.counters.invoke, 0);
  assert.equal(harness.counters.read, 0);
  assert.equal(harness.counters.execFile, 0);
});

test('AC-11 审计自证：记录 subject 不是 gitee → unknown（写可能已发生，证据链不可信）', async () => {
  const harness = createHarness({
    audit: () => [{ action: GITEE_ACTIONS.ISSUE_WRITE, subject: 'github', decision: 'allow' }],
    invoke: createdStdout('issueCreate', ({ target }) => `https://gitee.com/${target}/issues/12`),
    read: doneReadback,
  });
  const body = await runTool(harness.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(body.status, 'unknown');
  assert.equal(body.rule, 'audit-provider-mismatch', '具体原因要保留门禁给的规则，不能被降级成笼统的"可能已落地"');
  assert.equal(body.ok, false);
  assert.equal(harness.counters.invoke, 1, '操作确实跑了，所以不能报 failed 让人重试');
});

test('AC-19/20 人工结论只能人工自己写：模型带 human 入参一律 denied，零写入', async () => {
  const publish = createHarness();
  const published = await runTool(publish.service, 'forge_gitee_review_publish', {
    ...REVIEW_PUBLISH,
    human: { by: 'zhangsan', decision: 'approve' },
  });
  assert.equal(published.status, 'denied');
  assert.equal(published.reason, ACTION_REASONS.HUMAN_CONFIRMATION_FORBIDDEN);
  assert.equal(publish.counters.invoke, 0);

  const record = createHarness();
  const recorded = await runTool(record.service, 'forge_gitee_review_record', {
    ...reviewRecordArgs(mkdtempSync(join(tmpdir(), 'forge-gitee-human-'))),
    human: {},
  });
  assert.equal(recorded.status, 'denied');
  assert.equal(recorded.reason, ACTION_REASONS.HUMAN_CONFIRMATION_FORBIDDEN);
  assert.equal(record.counters.decide, 0, '入参不成立时连门禁都不问');
});

test('AC-11 入参不成立就地拒绝：缺变更号/缺正文/目标形状不对，全部零策略零子进程', async () => {
  const harness = createHarness();
  const cases = [
    ['forge_gitee_issue_write', { ...ISSUE_CREATE, changeId: '  ' }, ACTION_REASONS.MISSING_ARGUMENT],
    ['forge_gitee_issue_write', { ...ISSUE_CREATE, body: '   ' }, ACTION_REASONS.MISSING_ARGUMENT],
    ['forge_gitee_issue_write', { ...ISSUE_CREATE, title: '' }, ACTION_REASONS.MISSING_ARGUMENT],
    ['forge_gitee_issue_write', { ...ISSUE_CREATE, target: 'not-a-repo' }, ACTION_REASONS.INVALID_TARGET],
    ['forge_gitee_issue_write', { ...ISSUE_CREATE, target: 'acme/repo#12' }, ACTION_REASONS.INVALID_TARGET],
    ['forge_gitee_pr_write', { ...PR_CREATE, head: '' }, ACTION_REASONS.MISSING_ARGUMENT],
    ['forge_gitee_review_publish', { ...REVIEW_PUBLISH, commit: 'zzz' }, ACTION_REASONS.INVALID_ARGUMENT],
    ['forge_gitee_delivery_gate', { ...DELIVERY_GATE, changeId: '' }, ACTION_REASONS.MISSING_ARGUMENT],
  ];
  for (const [tool, args, reason] of cases) {
    const body = await runTool(harness.service, tool, args);
    assert.equal(body.status, 'denied', `${tool} ${JSON.stringify(args)} 应当就地拒绝`);
    assert.equal(body.reason, reason);
    assert.equal(body.remote_calls, 0);
  }
  assert.equal(harness.counters.decide, 0);
  assert.equal(harness.counters.execFile, 0);
});

test('AC-21 交付判定入参：缺提交信息或缺关闭条件即拒绝，不发任何命令', async () => {
  const harness = createHarness();
  const missingMessage = await runTool(harness.service, 'forge_gitee_delivery_gate', {
    ...DELIVERY_GATE,
    message: '  ',
  });
  assert.equal(missingMessage.status, 'denied');
  assert.equal(missingMessage.reason, ACTION_REASONS.MISSING_ARGUMENT);

  const missingCriteria = await runTool(harness.service, 'forge_gitee_delivery_gate', {
    ...DELIVERY_GATE,
    criteria: null,
  });
  assert.equal(missingCriteria.status, 'denied');
  assert.equal(missingCriteria.reason, ACTION_REASONS.INVALID_ARGUMENT);
  assert.equal(harness.counters.execFile, 0);
});

test('AC-5: criteria 含 unknown → status unknown、固定 reason、不计通过', async () => {
  const harness = createHarness();
  const body = await runTool(harness.service, 'forge_gitee_delivery_gate', {
    ...DELIVERY_GATE_READY,
    criteria: { ...DELIVERY_GATE_READY.criteria, merged: { status: 'unknown', evidence: 'PR 是否合入取不到' } },
  });
  assert.equal(body.status, 'unknown', `有 unknown 项时不得判通过（实际：${body.status}）`);
  assert.equal(body.ok, false, 'unknown 不计入通过');
  assert.equal(body.rule, 'not-ready');
  assert.equal(body.reason, ACTION_REASONS.DELIVERY_UNAVAILABLE);
  assert.equal(body.readback.ok, false);
  assert.equal(body.readback.ready, false);
  assert.deepEqual(body.readback.unknown_items, ['merged']);
  assert.equal(body.executed, false, '判定只判定不执行');
  assert.equal(body.remote_calls, 0);
  assert.doesNotMatch(JSON.stringify(body), /"status":"done"/u, 'unknown 不得在任何位置写成 done');
  assert.equal(harness.counters.invoke, 0);
  assert.equal(harness.counters.execFile, 0);
});

test('AC-2 模型面描述与判定接受面一致：照描述写也到 done（r7 QA DEF-1 回归门禁）', async () => {
  const harness = createHarness();
  // 描述取自真实注册的工具定义，不从源码里抄文本：描述漂移必须在这里变红。
  const judge = writeToolDefinitions(harness.service)
    .find((definition) => definition.name === 'forge_gitee_delivery_gate');
  assert.ok(judge !== undefined, '工具面必须含交付判定工具');
  const description = judge.parameters.properties.criteria.description;
  // 与 QA 检查器同一段描述语法：`取值 a|b|c`（模型照它写）。
  const advertised = (description.match(/取值\s*([a-z|]+)/u)?.[1] ?? '')
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean);
  assert.ok(advertised.length > 0, `描述必须声明取值（实际：${description}）`);
  for (const item of ['acceptance', 'merged', 'pendingDelivery', 'humanConfirmed']) {
    assert.match(description, new RegExp(item, 'u'), `描述必须点名四项之一：${item}`);
  }

  // 照描述写：四项都填描述声明的取值，应当得到与取值一致的判定，而不是一律 unknown。
  const expected = { pass: 'done', passed: 'done', fail: 'failed', failed: 'failed', unknown: 'unknown' };
  for (const token of advertised) {
    assert.ok(expected[token] !== undefined, `描述声明的取值「${token}」不在实现接受面内（pass|passed|fail|failed|unknown）`);
    const criteria = Object.fromEntries(['acceptance', 'merged', 'pendingDelivery', 'humanConfirmed'].map((item) => [item, token]));
    const body = await runTool(harness.service, 'forge_gitee_delivery_gate', { ...DELIVERY_GATE_READY, criteria });
    assert.equal(
      body.status,
      expected[token],
      `照描述写 criteria=全部 ${token} 应为 ${expected[token]}（实际：${body.status}/${body.reason}）`,
    );
    assert.equal(body.executed, false, '判定只判定不执行');
    assert.equal(body.remote_calls, 0);
    if (token === 'pass' || token === 'passed') {
      assert.equal(body.rule, 'ready');
      assert.equal(body.readback.ok, true);
    }
  }

  // 对象事实写法（TECHNICAL §3.2）仍须 done：新增写法不得挤掉既有接受面。
  const fact = await runTool(harness.service, 'forge_gitee_delivery_gate', DELIVERY_GATE_READY);
  assert.equal(fact.status, 'done', '对象事实写法必须保持可用');
});

test('AC-6: 判定缺参/非法入参 fail closed——零策略、零子进程、零平台调用', async () => {
  const harness = createHarness();
  const cases = [
    ['缺 changeId', { ...DELIVERY_GATE_READY, changeId: undefined }, ACTION_REASONS.MISSING_ARGUMENT],
    ['changeId 空白', { ...DELIVERY_GATE_READY, changeId: '  ' }, ACTION_REASONS.MISSING_ARGUMENT],
    ['缺 message', { ...DELIVERY_GATE_READY, message: undefined }, ACTION_REASONS.MISSING_ARGUMENT],
    ['criteria 缺失', { ...DELIVERY_GATE_READY, criteria: undefined }, ACTION_REASONS.INVALID_ARGUMENT],
    ['criteria 非对象', { ...DELIVERY_GATE_READY, criteria: 'passed' }, ACTION_REASONS.INVALID_ARGUMENT],
  ];
  for (const [label, args, reason] of cases) {
    const body = await runTool(harness.service, 'forge_gitee_delivery_gate', args);
    assert.equal(body.status, 'denied', `${label} 必须 fail closed（实际：${body.status}）`);
    assert.equal(body.ok, false);
    assert.equal(body.reason, reason, `${label} 的原因码不许漂移`);
    assert.equal(body.rule, 'argument-invalid');
    assert.equal(body.remote_calls, 0);
    assert.equal('evidence' in body, false, `${label} 被拒却带了证据`);
    assert.equal(body.executed, undefined, `${label} 被拒不得声称 executed`);
  }
  assert.equal(harness.counters.decide, 0, '入参不成立时不打扰策略层');
  assert.equal(harness.counters.operations, 0);
  assert.equal(harness.counters.invoke, 0);
  assert.equal(harness.counters.read, 0);
  assert.equal(harness.counters.execFile, 0);

  // 提交信息不带变更号：不是缺参，而是判定的确定失败——仍不得发任何命令。
  const badMessage = await runTool(harness.service, 'forge_gitee_delivery_gate', {
    ...DELIVERY_GATE_READY,
    message: 'feat: 忘记带变更号',
  });
  assert.equal(badMessage.status, 'failed');
  assert.equal(badMessage.rule, 'commit-message-invalid');
  assert.equal(badMessage.reason, ACTION_REASONS.COMMIT_MESSAGE_INVALID);
  assert.equal(badMessage.executed, false, '判定即使失败也只判定不执行');
  assert.equal(badMessage.remote_calls, 0);
  assert.equal(harness.counters.execFile, 0);
  assert.equal(harness.counters.invoke, 0);
});

test('AC-11 本地/判定类动作不要求 confirm，但仍过门禁与审计（远程写才需要确认）', async () => {
  assert.deepEqual([...CONFIRM_REQUIRED_ACTIONS], [
    GITEE_ACTIONS.ISSUE_WRITE,
    GITEE_ACTIONS.PR_WRITE,
    GITEE_ACTIONS.REVIEW_PUBLISH,
    GITEE_ACTIONS.GIT_PUSH,
  ]);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-gitee-local-'));
  try {
    const harness = createHarness();
    const recorded = await runTool(harness.service, 'forge_gitee_review_record', reviewRecordArgs(repoRoot));
    assert.notEqual(recorded.status, 'denied', '本地写动作不该被确认门卡住');
    assert.ok(['done', 'failed'].includes(recorded.status), `意外的状态 ${recorded.status}`);
    assert.equal(harness.counters.decide, 1);
    assert.equal(harness.counters.operations, 1, '确认门放行后必须真的进到 operation');
    assert.equal(harness.counters.invoke, 0, '写 review.md 不发子进程');

    const judged = await runTool(harness.service, 'forge_gitee_delivery_gate', DELIVERY_GATE);
    assert.notEqual(judged.status, 'denied');
    assert.ok(['done', 'failed', 'unknown'].includes(judged.status));
    assert.equal(harness.counters.invoke, 0, '交付判定只判定，不执行关闭/合并');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('AC-23 唯一子进程出口：动作层与门禁层不直接起进程，写动作只能经 service.invoke/read', () => {
  // 只看代码：注释里可以解释"不 import node:child_process"，真正要守的是没有导入/调用。
  const codeOnly = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*\/\/.*$/u, ' '))
      .join('\n');
  for (const file of ['gitee-actions.mjs', 'gitee-guard.mjs', 'gitee-session.mjs', 'gitee-git.mjs']) {
    const source = codeOnly(readFileSync(join(SRC_DIR, file), 'utf8'));
    for (const forbidden of ['child_process', 'execFile(', 'execSync(', 'spawn(', 'spawnSync(', 'fork(']) {
      assert.equal(source.includes(forbidden), false, `${file} 直接使用了 ${forbidden}（绕过唯一出口）`);
    }
    assert.doesNotMatch(source, /from '\.\/gitee-cli\.mjs'/u, `${file} 不该直接依赖 CLI 出口实现`);
  }
  // 写动作只出现在一个地方：`createIssueWrite`/`createPrWrite`/`publishReview` 工厂。
  const actions = readFileSync(join(SRC_DIR, 'gitee-actions.mjs'), 'utf8');
  assert.equal(actions.includes('await service.invoke('), true);
  assert.equal(actions.includes("'issueCreate'"), true);
  assert.equal(actions.includes("'prCreate'"), true);
});

test('AC-16 动作名是策略目录的坐标：六个动作都在 gitee.* 命名空间且互不相同', () => {
  const names = Object.values(GITEE_ACTIONS);
  assert.deepEqual(names, [
    'gitee.issue.write',
    'gitee.pr.write',
    'gitee.review.publish',
    'gitee.review.record',
    'gitee.delivery.judge',
    'gitee.git.push',
  ]);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^gitee\.[a-z]+\.[a-z]+$/u);
  // 发布审查与建 Issue/PR 用的是同一类命令面，但动作名必须分得开（审计与目录都按它分流）。
  assert.equal(publishReview().action, GITEE_ACTIONS.REVIEW_PUBLISH);
});

/**
 * 端到端主路径（[7c] 要求）：不满足于"每个函数各自对"。
 *
 * 这里除了 `execFile` 之外全是真件：真工具定义 → 真状态机 → 真门禁 → **真适配器**（argv 白名单、
 * `--json` 子集、输出解析都在跑）→ 桩 runner 顶替子进程 → 真台账。跑到的终态必须是
 * `done` → `reused` → `replay_blocked`，每一步的远端调用次数都要能点名。
 */
test('AC-16 端到端主路径: 工具 → 状态机 → 门禁 → 真适配器 → 桩 CLI，跑到 done / reused / replay_blocked 终态', async () => {
  const CLOCK_ISO = '2026-10-29T00:00:00.000Z';
  const ADAPTER_ENV = { GITEE_TOKEN: `ghp_${'a'.repeat(36)}` };
  // 字段名逐字按 2026-11-03 实测载荷：Issue 编号是 id、状态是 opened、链接是 web_url。
  const ISSUE_JSON = {
    id: 12,
    title: '同步变更',
    description: '变更正文',
    state: 'opened',
    web_url: 'https://gitee.example.com/acme/repo/issues/12',
    updated_at: '2026-10-29T00:00:00.000Z',
    labels: [],
  };

  function wire(runner) {
    const calls = [];
    const counting = {
      async run(invocation) {
        calls.push(invocation.args);
        return runner(invocation);
      },
    };
    const adapter = createGiteeAdapter({
      runner: counting,
      cliPath: 'gitee',
      host: 'gitee.example.com',
      authEnv: 'GITEE_TOKEN',
      env: ADAPTER_ENV,
      now: () => CLOCK_ISO,
    });
    const harness = createHarness();
    const service = {
      ...harness.service,
      preflight: () => adapter.preflight(),
      invoke: (command, params, purpose) => adapter.invoke(command, params, purpose),
      adapter: () => adapter,
    };
    return { service, calls, adapter, harness };
  }

  // ── 场景 A：写入成功 + 回读一致 → done；同参数再来一次 → reused（零远端）─────────────
  const happy = wire(({ args }) => {
    if (args[0] === 'issue' && args[1] === 'create') {
      return {
        exitCode: 0,
        stdout: `创建成功：${ISSUE_JSON.web_url}`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(ISSUE_JSON),
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  });

  assert.equal(happy.adapter.preflight().ok, true, '预检要过：本场景假定凭据由环境变量注入');

  const first = await runTool(happy.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(first.status, 'done');
  assert.equal(first.object_ref, 'acme/repo#12');
  assert.equal(first.readback.ok, true);
  assert.equal(first.readback.title, '同步变更');
  assert.equal(first.evidence.provider, 'gitee');
  assert.equal(typeof first.evidence.command, 'string');
  assert.ok(first.evidence.command.length > 0);
  assert.equal(first.evidence.sourceType, 'gitee-cli');

  // 两条子进程，各是它该是的样子：先建单（无 --json），再只读回读（有 --json）。
  assert.equal(happy.calls.length, 2);
  assert.deepEqual(happy.calls[0].slice(0, 2), ['issue', 'create']);
  assert.ok(happy.calls[0].includes('-R') && happy.calls[0].includes('acme/repo'));
  assert.ok(happy.calls[0].includes('--title') && happy.calls[0].includes('同步变更'));
  assert.ok(happy.calls[0].includes('--body'));
  assert.equal(happy.calls[0].includes('--json'), false, '写命令不该带 --json（Gitee 写命令没有这个开关）');
  assert.deepEqual(happy.calls[1].slice(0, 2), ['issue', 'view']);
  assert.ok(happy.calls[1].includes('--json'), '回读必须显式给出 --json');

  const replay = await runTool(happy.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(replay.status, 'done');
  assert.equal(replay.reused, true);
  assert.equal(replay.remote_calls, 0);
  assert.equal(happy.calls.length, 2, '幂等命中不该再起子进程');

  // ── 场景 B：CLI 超时 → unknown；同参数再来一次 → replay_blocked（仍零子进程）──────────
  const timeout = wire(() => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 15_000,
    timedOut: true,
    truncated: false,
  }));

  const timedOut = await runTool(timeout.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(timedOut.status, 'unknown');
  assert.equal(timedOut.reason, ACTION_REASONS.COMMAND_TIMEOUT);
  assert.equal(timeout.calls.length, 1, '超时后不得自动重试，也不得回读（可能还在跑）');

  const blocked = await runTool(timeout.service, 'forge_gitee_issue_write', ISSUE_CREATE);
  assert.equal(blocked.status, 'unknown');
  assert.equal(blocked.replay_blocked, true);
  assert.equal(blocked.remote_calls, 0);
  assert.equal(timeout.calls.length, 1, 'unknown 之后的第二次调用必须一次子进程都不起');
});

