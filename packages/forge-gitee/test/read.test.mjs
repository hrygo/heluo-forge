/**
 * 只读面契约：AC-15（读信封与固定 reason 枚举）+ AC-14 的读参数面 + AC-9 的三个读工具。
 *
 * 用例全部离线：子进程出口被替换成**桩 runner**（`{ run({bin,args,purpose}) }`），
 * 六类失败按 AC-15 的方式注入：CLI 未找到（未启动）、主机非企业、输出非 JSON、令牌缺失、
 * 退出码非 0、输出截断。每条用例都同时断言"读通道只发只读命令、失败不重试"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GITEE_LIST_LIMIT,
  createGiteeAdapter,
} from '../src/gitee-adapter.mjs';
import {
  GITEE_READ_ACTIONS,
  GITEE_READ_BOUNDARY_STATUSES,
  GITEE_READ_STATUSES,
  READ_REASONS,
  assertGiteeReadRequest,
  GiteeReadError,
  normalizeGiteeReadError,
  normalizeGiteeReadResult,
  readToolDefinitions,
} from '../src/gitee-read.mjs';
import { hostSchemaViolations } from './helpers/fake-host.mjs';

const TOKEN = `ghp_${'a'.repeat(36)}`;
const HOST = 'gitee.example.com';

/** 适配器期望的命令结果（唯一构造点，避免每个用例手抄五个键）。 */
function outcome({
  stdout = '',
  exitCode = 0,
  stderr = '',
  timedOut = false,
  truncated = false,
} = {}) {
  return { exitCode, stdout, stderr, durationMs: 1, timedOut, truncated };
}

/** 桩 runner：记录每次调用，按注入的处理器返回命令结果。 */
function stubRunner(handler) {
  const calls = [];
  return {
    calls,
    async run(invocation) {
      calls.push(invocation);
      return handler(invocation, calls.length);
    },
  };
}

/** 只读通道不变量：每一次子进程都必须是 `repo|issue|pr` + `view|list`。 */
function assertReadOnlyCalls(calls) {
  const verbs = new Set(['repo', 'issue', 'pr']);
  const modes = new Set(['view', 'list']);
  for (const call of calls) {
    assert.equal(call.bin, 'gh');
    assert.ok(verbs.has(call.args[0]), `只读通道发送了非只读命令族：${call.args[0]}`);
    assert.ok(modes.has(call.args[1]), `只读通道发送了非只读动词：${call.args[1]}`);
    assert.ok(call.args.includes('--json'), '读命令必须显式给出 --json');
  }
}

function makeAdapter({ runner, host = '', env = { GH_TOKEN: TOKEN }, persistentTokenProbe = null, now = () => '2026-10-30T08:00:00.000Z' } = {}) {
  return createGiteeAdapter({ runner, cliPath: 'gh', host, authEnv: 'GH_TOKEN', env, now, persistentTokenProbe });
}

/** 真实适配器 + 服务端口（等价于 index.mjs 装配出来的只读最小面）。 */
function adapterService(adapter, overrides = {}) {
  return {
    read: (request) => adapter.read(request.action, request.target, request.params),
    preflight: () => adapter.preflight(),
    adapter: () => adapter,
    ...overrides,
  };
}

const REPO_JSON = Object.freeze({
  name: 'repo',
  path: 'group/repo',
  description: '示例仓库',
  url: `https://${HOST}/group/repo`,
  default_branch: 'main',
  private: true,
  updated_at: '2026-10-29T12:00:00+08:00',
});

const ISSUE_JSON = Object.freeze({
  number: 12,
  title: '示例 Issue',
  state: 'open',
  url: `https://${HOST}/group/repo/issues/12`,
  updated_at: '2026-10-29T12:30:00+08:00',
  labels: Object.freeze(['bug']),
  comments: 3,
});

const ISSUE_LIST = Object.freeze([
  { number: 12, title: '示例 Issue', state: 'open', url: `https://${HOST}/group/repo/issues/12` },
  { number: 11, title: '另一个', state: 'open', url: `https://${HOST}/group/repo/issues/11` },
]);

function parseBody(output) {
  assert.ok(Array.isArray(output?.content), '工具返回必须带 content 数组');
  const [first] = output.content;
  assert.equal(first.type, 'text');
  return JSON.parse(first.text);
}

async function catchError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail('期望这一次调用抛错，但没有抛');
}

test('AC-15: 只读动作与信封状态枚举固定', () => {
  assert.deepEqual([...GITEE_READ_ACTIONS], ['gitee.repository.read', 'gitee.issue.read', 'gitee.pr.read']);
  assert.deepEqual([...GITEE_READ_STATUSES], ['succeeded', 'failed', 'partial', 'unknown']);
  assert.deepEqual([...GITEE_READ_BOUNDARY_STATUSES], ['denied']);
  assert.equal(GITEE_READ_STATUSES.includes('denied'), false, 'denied 不是读结果状态，单列');
});

test('AC-15: 仓库读信封五项齐全，事实版本取 updated_at，链接进 result_refs', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner });
  const facts = await adapter.read('gitee.repository.read', 'group/repo');
  const envelope = normalizeGiteeReadResult({ action: 'gitee.repository.read', target: 'group/repo', result: facts });

  for (const key of ['provider', 'status', 'source_revision', 'observed_at', 'result_refs']) {
    assert.ok(key in envelope, `读信封缺少 ${key}`);
  }
  assert.equal(envelope.provider, 'gitee');
  assert.equal(envelope.action, 'gitee.repository.read');
  assert.equal(envelope.target_ref, 'group/repo');
  assert.equal(envelope.status, 'succeeded');
  assert.equal(envelope.source_revision, '2026-10-29T12:00:00+08:00');
  assert.match(envelope.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual([...envelope.result_refs], [`https://${HOST}/group/repo`]);
  assert.equal(envelope.error_code, null);
  assert.equal(envelope.retry_policy, 'read_recheck');
  assert.deepEqual([...envelope.missing_fields], []);
  assert.equal(envelope.object.updated_at, '2026-10-29T12:00:00+08:00');
  assert.equal(envelope.message, undefined);
  assert.equal('rule' in envelope, false);
  assertReadOnlyCalls(runner.calls);
});

test('AC-15: 清单读是查询快照 —— source_revision 为 null 仍算 succeeded（不误降级）', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(ISSUE_LIST) }));
  const adapter = makeAdapter({ runner });
  const facts = await adapter.read('gitee.issue.read', 'group/repo', { list: true, state: 'all', limit: 2 });
  const envelope = normalizeGiteeReadResult({ action: 'gitee.issue.read', target: 'group/repo', result: facts });

  assert.equal(envelope.status, 'succeeded');
  assert.equal(envelope.source_revision, null, '清单不冻结事实版本');
  assert.equal(envelope.kind, 'list');
  assert.equal(envelope.count, 2);
  assert.equal(envelope.items.length, 2);
  assert.ok(runner.calls[0].args.includes('--limit'));

  // 归一幂等：服务边界已经归一过的信封不许被二次降级（index.mjs 会再传一次）。
  const again = normalizeGiteeReadResult({ action: 'gitee.issue.read', target: 'group/repo', result: envelope });
  assert.deepEqual(again, envelope);
});

test('AC-15: 取不到 updated_at 的对象读降级 unknown，不编事实版本', async () => {
  const { updated_at: _ignored, ...withoutRevision } = REPO_JSON;
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(withoutRevision) }));
  const adapter = makeAdapter({ runner });
  const facts = await adapter.read('gitee.repository.read', 'group/repo');
  const envelope = normalizeGiteeReadResult({ action: 'gitee.repository.read', target: 'group/repo', result: facts });

  assert.equal(envelope.status, 'unknown');
  assert.equal(envelope.error_code, READ_REASONS.MISSING_SOURCE_REVISION);
  assert.equal(envelope.source_revision, null);
  assert.equal(envelope.retry_policy, 'read_recheck');
  assert.equal(envelope.object.name, 'repo', '已取到的字段仍要交付，只把状态降级');
});

test('AC-15: 结果混入 GitHub 语义字段 → unknown（MIXED_PROVIDER_FIELDS），不采信', async () => {
  const mixed = { ...REPO_JSON, mergedAt: '2026-10-29T00:00:00Z' };
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(mixed) }));
  const adapter = makeAdapter({ runner });
  const facts = await adapter.read('gitee.repository.read', 'group/repo');
  const envelope = normalizeGiteeReadResult({ action: 'gitee.repository.read', target: 'group/repo', result: facts });

  assert.equal(envelope.status, 'unknown');
  assert.equal(envelope.error_code, READ_REASONS.MIXED_PROVIDER_FIELDS);
  assert.match(envelope.message, /未声明的字段/);
  assert.equal('mergedAt' in envelope.object, false);
});

test('AC-15: 输出截断 → unknown（OUTPUT_TRUNCATED），载荷标记 truncated', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(ISSUE_LIST), truncated: true }));
  const adapter = makeAdapter({ runner });
  const facts = await adapter.read('gitee.issue.read', 'group/repo', { list: true });
  assert.equal(facts.truncated, true, '适配器必须把命令结果的截断标记带出来');
  const envelope = normalizeGiteeReadResult({ action: 'gitee.issue.read', target: 'group/repo', result: facts });

  assert.equal(envelope.status, 'unknown');
  assert.equal(envelope.error_code, READ_REASONS.OUTPUT_TRUNCATED);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.retry_policy, 'read_recheck');
  assert.equal(envelope.items.length, 2, '截断不吞掉已取到的条目，只把状态降级');
});

test('AC-15: 输出非 JSON → unknown（MALFORMED_RESULT），读层归一不抛错', async () => {
  const runner = stubRunner(() => outcome({ stdout: 'not json at all' }));
  const adapter = makeAdapter({ runner });
  const thrown = await catchError(() => adapter.read('gitee.repository.read', 'group/repo'));
  const envelope = normalizeGiteeReadError({ action: 'gitee.repository.read', target: 'group/repo', error: thrown });

  assert.equal(thrown.code, READ_REASONS.MALFORMED_RESULT);
  assert.equal(envelope.status, 'unknown');
  assert.equal(envelope.error_code, READ_REASONS.MALFORMED_RESULT);
  assert.equal(envelope.source_revision, null);
  assert.equal(envelope.retry_policy, 'read_recheck');
});

test('AC-15: CLI 未找到 / 退出码非 0 / 超时三类失败原因固定', async () => {
  const cases = [
    {
      label: 'CLI 未找到（未启动）',
      result: outcome({ exitCode: null, stderr: 'spawn gh ENOENT' }),
      code: READ_REASONS.SPAWN_FAILED,
      status: 'failed',
    },
    {
      label: '退出码非 0',
      result: outcome({ exitCode: 1, stderr: 'boom' }),
      code: READ_REASONS.NONZERO_EXIT,
      status: 'failed',
    },
    {
      label: '超时',
      result: outcome({ exitCode: null, timedOut: true }),
      code: READ_REASONS.TIMEOUT,
      status: 'unknown',
    },
  ];
  for (const entry of cases) {
    const runner = stubRunner(() => entry.result);
    const adapter = makeAdapter({ runner });
    const thrown = await catchError(() => adapter.read('gitee.issue.read', 'group/repo#12'));
    const envelope = normalizeGiteeReadError({ action: 'gitee.issue.read', target: 'group/repo#12', error: thrown });
    assert.equal(thrown.code, entry.code, entry.label);
    assert.equal(envelope.status, entry.status, entry.label);
    assert.equal(envelope.error_code, entry.code, entry.label);
    assert.equal(envelope.retry_policy, 'read_recheck', entry.label);
    assert.equal(runner.calls.length, 1, `${entry.label}：读失败不许自动重试`);
    assertReadOnlyCalls(runner.calls);
  }
});

test('AC-15: 令牌缺失 → failed（AUTH_MISSING），且一次子进程都不起', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner, env: {} });
  const [repository] = readToolDefinitions(adapterService(adapter));
  const body = parseBody(await repository.execute({ target: 'group/repo' }));

  assert.equal(runner.calls.length, 0);
  assert.equal(body.status, 'failed');
  assert.equal(body.error_code, READ_REASONS.AUTH_MISSING);
  assert.equal(body.provider, 'gitee');
  assert.match(body.message, /GH_TOKEN/);
});

test('AC-15: 主机非企业 → failed（HOST_NOT_ENTERPRISE）', async () => {
  // 情形一：配置的是公共 SaaS 域 —— 读之前就拒，零子进程。
  const publicRunner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const publicAdapter = makeAdapter({ runner: publicRunner, host: 'github.com' });
  const [repository] = readToolDefinitions(adapterService(publicAdapter));
  const publicBody = parseBody(await repository.execute({ target: 'group/repo' }));
  assert.equal(publicRunner.calls.length, 0);
  assert.equal(publicBody.status, 'failed');
  assert.equal(publicBody.error_code, READ_REASONS.HOST_NOT_ENTERPRISE);

  // 情形二：结果链接指向别的主机 —— 命令执行了一次，但事实不采信。
  const otherHostJson = { ...REPO_JSON, url: 'https://github.com/group/repo' };
  const wrongLinkRunner = stubRunner(() => outcome({ stdout: JSON.stringify(otherHostJson) }));
  const wrongLinkAdapter = makeAdapter({ runner: wrongLinkRunner, host: HOST });
  const wrongLinkBody = parseBody(await readToolDefinitions(adapterService(wrongLinkAdapter))[0]
    .execute({ target: 'group/repo' }));
  assert.equal(wrongLinkRunner.calls.length, 1);
  assert.equal(wrongLinkBody.status, 'failed');
  assert.equal(wrongLinkBody.error_code, READ_REASONS.HOST_NOT_ENTERPRISE);
  assert.deepEqual([...wrongLinkBody.result_refs], []);
  assert.match(wrongLinkBody.message, /github\.com/);

  // 情形三：目标链接自带的主机与配置的不一致 —— 读之前就拒，零子进程。
  const targetRunner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const targetAdapter = makeAdapter({ runner: targetRunner, host: HOST });
  const targetBody = parseBody(await readToolDefinitions(adapterService(targetAdapter))[2]
    .execute({ target: 'https://gitlab.com/group/repo/pulls/3' }));
  assert.equal(targetRunner.calls.length, 0);
  assert.equal(targetBody.status, 'failed');
  assert.equal(targetBody.error_code, READ_REASONS.HOST_NOT_ENTERPRISE);
});

test('AC-15/AC-22: 失败消息里不出现令牌值', async () => {
  const runner = stubRunner(() => outcome({ exitCode: 1, stderr: `HTTP 401 invalid token ${TOKEN}` }));
  const adapter = makeAdapter({ runner });
  const thrown = await catchError(() => adapter.read('gitee.repository.read', 'group/repo'));
  const envelope = normalizeGiteeReadError({ action: 'gitee.repository.read', target: 'group/repo', error: thrown });
  assert.equal(envelope.status, 'failed');
  assert.equal(JSON.stringify(envelope).includes(TOKEN), false, '信封里不许回显令牌');
});

test('AC-16 读侧: 一次 execute 只发一次子进程 —— 读失败不自动重试', async () => {
  const runner = stubRunner(() => outcome({ exitCode: 1, stderr: 'boom' }));
  const adapter = makeAdapter({ runner });
  const [repository] = readToolDefinitions(adapterService(adapter));

  const first = parseBody(await repository.execute({ target: 'group/repo' }));
  assert.equal(runner.calls.length, 1);
  assert.equal(first.status, 'failed');

  // 模型可以再发一次**新的**只读调用（read_recheck），这是调用方的决定，不是本模块的重试。
  await repository.execute({ target: 'group/repo' });
  assert.equal(runner.calls.length, 2);
});

test('AC-15/AC-16: 策略拒绝 → denied 信封（retry_policy 为 null），零子进程', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner });
  const denied = new Error('POLICY_DENIED: 动作未登记');
  denied.code = READ_REASONS.POLICY_DENIED;
  denied.denied = true;
  const service = adapterService(adapter, {
    read: async () => {
      throw denied;
    },
  });
  const body = parseBody(await readToolDefinitions(service)[0].execute({ target: 'group/repo' }));

  assert.equal(runner.calls.length, 0);
  assert.equal(body.status, 'denied');
  assert.equal(body.error_code, READ_REASONS.POLICY_DENIED);
  assert.equal(body.rule, 'policy-denied');
  assert.equal(body.retry_policy, null);
});

test('AC-15/AC-22: 持久令牌 → denied（GITEE_PERSISTENT_TOKEN），零子进程', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner, persistentTokenProbe: () => true });
  const body = parseBody(await readToolDefinitions(adapterService(adapter))[0].execute({ target: 'group/repo' }));

  assert.equal(runner.calls.length, 0);
  assert.equal(body.status, 'denied');
  assert.equal(body.error_code, READ_REASONS.GITEE_PERSISTENT_TOKEN);
  assert.equal(body.rule, 'persistent-credential');
  assert.equal(body.retry_policy, null);
});

test('AC-15: 请求越界在读之前被拒（UNKNOWN_ACTION / MISSING_TARGET / ARG_NOT_WHITELISTED）', async () => {
  assert.throws(() => assertGiteeReadRequest('change.read', 'group/repo'), (error) => {
    assert.ok(error instanceof GiteeReadError);
    assert.equal(error.code, READ_REASONS.UNKNOWN_ACTION);
    return true;
  });
  assert.throws(() => assertGiteeReadRequest('gitee.issue.read', '   '), (error) => {
    assert.equal(error.code, READ_REASONS.MISSING_TARGET);
    return true;
  });
  assert.equal(assertGiteeReadRequest('gitee.pr.read', '  group/repo#3  '), 'group/repo#3');

  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner });
  const [repository] = readToolDefinitions(adapterService(adapter));

  const empty = parseBody(await repository.execute({ target: '' }));
  assert.equal(empty.status, 'failed');
  assert.equal(empty.error_code, READ_REASONS.MISSING_TARGET);

  // 参数面越界交给适配器（单一校验点）：仓库对象读不接受 state。
  const stray = parseBody(await repository.execute({ target: 'group/repo', state: 'open' }));
  assert.equal(stray.status, 'failed');
  assert.equal(stray.error_code, READ_REASONS.ARG_NOT_WHITELISTED);
  assert.equal(runner.calls.length, 0);
});

test('AC-15: 归一不抛错（只有请求形状错误才抛），并保留缺状态/非对象两类降级', () => {
  const noStatus = normalizeGiteeReadResult({ action: 'gitee.issue.read', target: 'group/repo#12', result: { kind: 'object' } });
  assert.equal(noStatus.status, 'unknown');
  assert.equal(noStatus.error_code, READ_REASONS.NO_STRUCTURED_STATUS);

  const notObject = normalizeGiteeReadResult({ action: 'gitee.issue.read', target: 'group/repo#12', result: 'oops' });
  assert.equal(notObject.status, 'unknown');
  assert.equal(notObject.error_code, READ_REASONS.MALFORMED_RESULT);

  const foreignProvider = normalizeGiteeReadResult({
    action: 'gitee.pr.read',
    target: 'group/repo#3',
    result: {
      provider: 'github',
      status: 'succeeded',
      kind: 'object',
      source_revision: '2026-10-29T12:00:00Z',
      observed_at: '2026-10-30T08:00:00.000Z',
      result_refs: [],
      missing_fields: [],
    },
  });
  assert.equal(foreignProvider.status, 'unknown');
  assert.equal(foreignProvider.error_code, READ_REASONS.MIXED_PROVIDER_FIELDS);
  assert.equal(foreignProvider.provider, 'gitee', '信封 provider 恒为 gitee');

  // 请求形状错误仍抛：读层不对"要读什么"做猜测。
  assert.throws(
    () => normalizeGiteeReadResult({ action: 'change.read', target: 'x', result: {} }),
    /只读动作必须是/,
  );
});

test('AC-9/14: 三个读工具名、顺序与参数面固定', async () => {
  const runner = stubRunner(() => outcome({ stdout: JSON.stringify(REPO_JSON) }));
  const adapter = makeAdapter({ runner });
  const definitions = readToolDefinitions(adapterService(adapter));

  assert.deepEqual(definitions.map((entry) => entry.name), [
    'forge_gitee_repository_read',
    'forge_gitee_issue_read',
    'forge_gitee_pr_read',
  ]);
  for (const definition of definitions) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.deepEqual([...definition.parameters.required], ['target']);
    assert.equal(typeof definition.execute, 'function');
    assert.ok(definition.description.length > 40);
    assert.match(definition.description, /Gitee read envelope/);
    assert.equal(typeof definition.output.render, 'function');
  }
  assert.deepEqual(Object.keys(definitions[0].parameters.properties), ['target']);
  for (const definition of definitions.slice(1)) {
    assert.deepEqual(Object.keys(definition.parameters.properties), ['target', 'list', 'state', 'limit', 'json']);
    assert.deepEqual([...definition.parameters.properties.state.enum], ['open', 'closed', 'all']);
    // D-1：参数面只能用宿主支持的子集（`minimum`/`maximum` 会被宿主判为不支持的关键字，
    // 取数边界由适配器 `ARG_INVALID` 强制）。范围仍要以文案写出来，模型看得见。
    assert.deepEqual(hostSchemaViolations(definition.parameters, 'parameters'), []);
    assert.equal(definition.parameters.properties.limit.type, 'integer');
    assert.match(definition.parameters.properties.limit.description, new RegExp(`1-${GITEE_LIST_LIMIT}`, 'u'));
  }

  assert.throws(() => readToolDefinitions(null), (error) => {
    assert.equal(error.code, READ_REASONS.NO_READER);
    return true;
  });
});

test('AC-15: 工具把读参数原样交给服务端口（单一校验点在适配器）', async () => {
  let seen = null;
  let preflights = 0;
  const service = {
    read: async (request) => {
      seen = request;
      return {
        provider: 'gitee',
        action: 'gitee.issue.read',
        kind: 'list',
        status: 'succeeded',
        source_revision: null,
        observed_at: '2026-10-30T08:00:00.000Z',
        result_refs: [],
        missing_fields: [],
      };
    },
    preflight: () => {
      preflights += 1;
      return { ok: true, reason: null };
    },
    adapter: () => ({ describe: () => ({ host: null }) }),
  };
  const [, issue] = readToolDefinitions(service);
  const body = parseBody(await issue.execute({ target: 'group/repo', list: true, state: 'all', limit: 5, json: ['number', 'title'] }));

  assert.deepEqual(seen, {
    action: 'gitee.issue.read',
    target: 'group/repo',
    params: { list: true, state: 'all', limit: 5, json: ['number', 'title'] },
  });
  assert.equal(preflights, 1);
  assert.equal(body.status, 'succeeded');
  assert.equal(body.kind, 'list');
});

test('端到端主路径: 工具 → 装配端口 → 适配器 → 桩 CLI，跑到终态并核对计数与只读通道', async () => {
  const runner = stubRunner((invocation) => {
    if (invocation.args[0] === 'repo') return outcome({ stdout: JSON.stringify(REPO_JSON) });
    if (invocation.args[0] === 'issue' && invocation.args[1] === 'list') {
      return outcome({ stdout: JSON.stringify(ISSUE_LIST) });
    }
    return outcome({ stdout: JSON.stringify(ISSUE_JSON) });
  });
  const adapter = makeAdapter({ runner, host: HOST });
  const [repository, issue] = readToolDefinitions(adapterService(adapter));

  const repositoryEnvelope = parseBody(await repository.execute({ target: 'group/repo' }));
  assert.equal(repositoryEnvelope.status, 'succeeded');
  assert.equal(repositoryEnvelope.source_revision, REPO_JSON.updated_at);
  assert.equal(runner.calls.length, 1);

  const listEnvelope = parseBody(await issue.execute({ target: 'group/repo', list: true, limit: 2 }));
  assert.equal(listEnvelope.status, 'succeeded');
  assert.equal(listEnvelope.count, 2);
  assert.equal(runner.calls.length, 2);

  const singleEnvelope = parseBody(await issue.execute({ target: 'group/repo#12' }));
  assert.equal(singleEnvelope.status, 'succeeded');
  assert.equal(singleEnvelope.source_revision, ISSUE_JSON.updated_at);
  assert.deepEqual([...singleEnvelope.result_refs], [ISSUE_JSON.url]);
  assert.equal(runner.calls.length, 3);

  // 终态核对：三次调用都是只读命令，没有写通道被触发，也没有重试。
  assertReadOnlyCalls(runner.calls);
  assert.equal(runner.calls.length, 3);
  for (const envelope of [repositoryEnvelope, listEnvelope, singleEnvelope]) {
    assert.equal(envelope.provider, 'gitee');
    assert.equal(envelope.retry_policy, 'read_recheck');
    assert.equal(envelope.error_code, null);
  }
});
