import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { READ_ACTIONS, READ_REASONS } from '../src/read.mjs';
import { FLOW_ACTIONS, FLOW_TOOLS, READ_TOOLS, buildDevopsTools } from '../src/tools.mjs';
import { apply, FLOW_KEY, READER_KEY, SERVICE_KEY } from '../src/index.mjs';

/**
 * 工具面契约：9 个工具、名字→动作映射唯一真源、参数用 target、写工具前置 confirm。
 * 业务判定（幂等/回读/四状态）不在工具里，所以这里只验证"工具是否把动作与参数原样交下去"。
 */

const TOOL_NAMES = [
  'forge_devops_change_read',
  'forge_devops_repository_read',
  'forge_devops_issue_read',
  'forge_devops_pr_read',
  'forge_devops_change_context',
  'forge_devops_issue_write',
  'forge_devops_pr_write',
  'forge_devops_clarify_write',
  'forge_devops_artifact_write',
];

function fakeService(overrides = {}) {
  const calls = [];
  const record = (method, value) => async (args) => {
    calls.push({ method, args });
    return typeof value === 'function' ? value(args) : value;
  };
  return {
    calls,
    service: {
      read: record('read', (args) => ({ status: 'succeeded', action: args.action, target_ref: args.target })),
      context: record('context', { card: { change: 'ARD123456' }, text: '## 上下文卡' }),
      issueWrite: record('issueWrite', { status: 'done', object: 'issue#1' }),
      prWrite: record('prWrite', { status: 'done', object: 'pr#1' }),
      clarifyWrite: record('clarifyWrite', { status: 'denied', reason: 'COMMAND_NOT_WHITELISTED' }),
      artifactWrite: record('artifactWrite', { path: '/tmp/x/report.md', bytes: 10 }),
      ...overrides,
    },
  };
}

const parse = (payload) => JSON.parse(payload.content[0].text);
const byName = (tools, name) => tools.find((tool) => tool.name === name);

test('工具面恰好 9 个，映射表与门禁动作逐条对应', () => {
  const { service } = fakeService();
  const tools = buildDevopsTools(service);
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  assert.deepEqual(Object.keys(READ_TOOLS).sort(), TOOL_NAMES.slice(0, 4).sort());
  assert.deepEqual(Object.keys(FLOW_TOOLS).sort(), TOOL_NAMES.slice(4).sort());
  for (const [name, action] of Object.entries(READ_TOOLS)) {
    assert.ok(READ_ACTIONS.includes(action), `${name} 未映射到已开放的只读动作`);
  }
  assert.equal(FLOW_TOOLS.forge_devops_change_context.action, 'change.read');
  assert.equal(FLOW_TOOLS.forge_devops_issue_write.action, FLOW_ACTIONS.ISSUE);
  assert.equal(FLOW_TOOLS.forge_devops_pr_write.action, FLOW_ACTIONS.PR);
  assert.equal(FLOW_TOOLS.forge_devops_clarify_write.action, FLOW_ACTIONS.CLARIFY);
  assert.equal(FLOW_TOOLS.forge_devops_artifact_write.action, null, '产物落盘没有平台动作');
  assert.deepEqual(
    [FLOW_ACTIONS.ISSUE, FLOW_ACTIONS.PR, FLOW_ACTIONS.CLARIFY],
    ['issue.create_or_update', 'pr.create_or_update', 'change.clarification.write'],
  );
});

test('工具名与动作的唯一真源：源码里恰好出现 9 个工具名', () => {
  const source = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  const names = new Set(source.match(/forge_devops_[a-z_]+/gu) ?? []);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  assert.match(source, /confirm/u, '写工具必须要求 confirm{repo,object}');
});

test('只读工具：参数只有 target，正常路径原样返回契约结果', async () => {
  const { service, calls } = fakeService();
  const tools = buildDevopsTools(service);
  for (const tool of tools.slice(0, 4)) {
    assert.deepEqual(tool.parameters.required, ['target']);
    assert.deepEqual(Object.keys(tool.parameters.properties), ['target'], '门禁只读 exec.arguments.target');
    const payload = parse(await tool.execute({ target: 'X-1' }));
    assert.equal(payload.ok, true);
    assert.equal(payload.result.action, READ_TOOLS[tool.name]);
  }
  assert.deepEqual(calls.map((call) => call.method), ['read', 'read', 'read', 'read']);
});

test('只读工具失败时给可见拒绝与下一步，而不是空成功', async () => {
  const { service } = fakeService({
    read: async () => {
      throw Object.assign(new Error('no reader'), { code: READ_REASONS.NO_READER });
    },
  });
  const payload = parse(
    await byName(buildDevopsTools(service), 'forge_devops_issue_read').execute({ target: 'group/repo#7' }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, READ_REASONS.NO_READER);
  assert.equal(payload.next_action, 'configure-reader');
  assert.equal(payload.result, undefined);
});

test('聚合读工具：一次取回上下文卡与渲染文本', async () => {
  const { service, calls } = fakeService();
  const payload = parse(
    await byName(buildDevopsTools(service), 'forge_devops_change_context').execute({ target: 'ARD123456' }),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.text, '## 上下文卡');
  assert.equal(payload.card.change, 'ARD123456');
  assert.deepEqual(calls[0], { method: 'context', args: { target: 'ARD123456' } });
});

test('写工具：confirm 缺失或不一致时 denied，且零下游调用', async () => {
  const { service, calls } = fakeService();
  const issue = byName(buildDevopsTools(service), 'forge_devops_issue_write');
  const badConfirms = [
    undefined,
    {},
    { repo: 'group/repo' },
    { repo: 'group/other', object: 'group/repo' },
    { repo: 'group/repo', object: 'group/repo#8' },
    { repo: 'group/repo', object: '' },
  ];
  for (const confirm of badConfirms) {
    const payload = parse(await issue.execute({ op: 'comment', target: 'group/repo#9', body: 'x', confirm }));
    assert.equal(payload.ok, false, `confirm=${JSON.stringify(confirm)} 必须被拒`);
    assert.equal(payload.reason, 'CONFIRMATION_REQUIRED');
    assert.equal(payload.next_action, 'confirm-object');
  }
  assert.deepEqual(calls, [], '确认不一致时不得发生任何平台调用');
});

test('写工具：确认一致才交下去，平台四状态原样透出', async () => {
  const { service, calls } = fakeService();
  const issue = byName(buildDevopsTools(service), 'forge_devops_issue_write');
  const confirm = { repo: 'group/repo', object: 'group/repo#9' };
  const done = parse(await issue.execute({ op: 'comment', target: 'group/repo#9', body: '审查意见', confirm }));
  assert.equal(done.ok, true);
  assert.equal(done.result.status, 'done');
  assert.deepEqual(calls[0], {
    method: 'issueWrite',
    args: { op: 'comment', target: 'group/repo#9', title: undefined, body: '审查意见', confirm },
  });

  const denied = parse(
    await byName(buildDevopsTools(service), 'forge_devops_clarify_write').execute({
      target: 'ARD123456',
      body: '澄清',
      confirm: { repo: '', object: 'ARD123456' },
    }),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.result.status, 'denied', '平台拒绝要原样可见，不能被读成流程 blocked');
  assert.equal(denied.result.reason, 'COMMAND_NOT_WHITELISTED');
});

test('写工具：必填参数缺失时早退，不发起调用', async () => {
  const { service, calls } = fakeService();
  const tools = buildDevopsTools(service);
  const issue = parse(
    await byName(tools, 'forge_devops_issue_write').execute({
      op: 'create',
      target: 'group/repo',
      body: 'x',
      confirm: { repo: 'group/repo', object: 'group/repo' },
    }),
  );
  assert.equal(issue.ok, false);
  assert.equal(issue.reason, 'MISSING_ARGUMENT');
  assert.match(issue.detail, /title/u);

  const pr = parse(
    await byName(tools, 'forge_devops_pr_write').execute({
      op: 'comment',
      target: 'group/repo!1',
      body: 'x',
      confirm: { repo: 'group/repo', object: 'group/repo!1' },
    }),
  );
  assert.equal(pr.ok, false);
  assert.equal(pr.reason, 'MISSING_ARGUMENT');
  assert.match(pr.detail, /commit/u);
  assert.deepEqual(calls, []);
});

test('PR 工具：create 与 comment 都走同一入口，参数原样交下去', async () => {
  const { service, calls } = fakeService();
  const pr = byName(buildDevopsTools(service), 'forge_devops_pr_write');
  const created = parse(
    await pr.execute({
      op: 'create',
      target: 'group/repo',
      head: 'feat/x',
      base: 'main',
      title: '[ARD123456] 实现',
      body: 'body',
      confirm: { repo: 'group/repo', object: 'group/repo' },
    }),
  );
  assert.equal(created.ok, true);
  assert.equal(calls[0].method, 'prWrite');
  assert.equal(calls[0].args.head, 'feat/x');

  const commented = parse(
    await pr.execute({
      op: 'comment',
      target: 'group/repo!1',
      body: '审查记录',
      commit: 'abc1234',
      confirm: { repo: 'group/repo', object: 'group/repo!1' },
    }),
  );
  assert.equal(commented.ok, true);
  assert.equal(calls[1].args.commit, 'abc1234');
});

test('产物落盘工具：没有平台动作，错误码原样透出', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), 'forge_devops_artifact_write');
  assert.deepEqual(tool.parameters.required, ['repoRoot', 'kind', 'body', 'meta']);
  const payload = parse(
    await tool.execute({
      repoRoot: '/tmp/repo',
      kind: 'report',
      body: '报告',
      meta: { sourceType: 'mock', sourceRevision: 'dop:abc', evidence: [{}] },
    }),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.artifact.path, '/tmp/x/report.md');
  assert.deepEqual(calls[0].method, 'artifactWrite');

  const { service: failing } = fakeService({
    artifactWrite: async () => {
      throw Object.assign(new Error('逃逸'), { code: 'ARTIFACT_PATH_ESCAPE' });
    },
  });
  const denied = parse(
    await byName(buildDevopsTools(failing), 'forge_devops_artifact_write').execute({
      repoRoot: '/tmp/repo',
      kind: 'report',
      body: '报告',
      meta: { sourceType: 'mock', sourceRevision: 'dop:abc' },
    }),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'ARTIFACT_PATH_ESCAPE');
});

test('service 缺方法时工具报 INTERNAL，而不是静默成功', async () => {
  const payload = parse(
    await byName(buildDevopsTools({}), 'forge_devops_change_context').execute({ target: 'ARD123456' }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'INTERNAL');
  assert.equal(payload.next_action, 'report-to-admin');
});

/* ─────────────────────────── 装配层（index.mjs）─────────────────────────── */

/** 假宿主：策略目录齐全、可按需注入只读端口/流程端口/命令面。 */
function mountIndex({ flow, reader, commands } = {}) {
  const policy = {
    catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
    executeAction: async (_ctx, _action, _exec, operation) => operation(),
  };
  const provided = new Map();
  const registered = new Map();
  const commandsSeen = [];
  const ctx = {
    get: (key) => {
      if (key === 'policy') return policy;
      if (key === READER_KEY) return reader;
      if (key === FLOW_KEY) return flow;
      if (key === 'commands') return commands;
      return undefined;
    },
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
  };
  const teardown = apply(ctx, {});
  return { provided, registered, commandsSeen, teardown, service: provided.get(SERVICE_KEY) };
}

const fakeCommands = () => {
  const registered = [];
  return {
    registered,
    service: {
      register: (definition) => {
        registered.push(definition);
        return () => registered.splice(registered.indexOf(definition), 1);
      },
    },
  };
};

test('装配：9 个工具全部注册，缺命令面时 entryStatus=no-command-face 而工具面照常可用', () => {
  const { registered, service } = mountIndex();
  assert.equal(registered.size, 9);
  assert.equal(service.toolNames().length, 9);
  assert.equal(service.entryStatus(), 'no-command-face');
  assert.deepEqual(service.readActions(), Array.from(READ_ACTIONS));
  assert.equal(service.ledger().length, 0);
});

test('装配：有 commands 服务时注册 devops-change 入口，teardown 一并释放', async () => {
  const commands = fakeCommands();
  const { registered, provided, service, teardown } = mountIndex({ commands: commands.service });
  assert.equal(service.entryStatus(), 'registered');
  assert.equal(commands.registered.length, 1);
  assert.equal(commands.registered[0].name, 'devops-change');
  assert.equal(commands.registered[0].input.hint.includes('变更号'), true);

  const result = await commands.registered[0].handler({ rawInput: '  ' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /变更号/);

  teardown();
  assert.equal(registered.size, 0);
  assert.equal(commands.registered.length, 0);
  assert.equal(provided.has(SERVICE_KEY), false);
});

test('装配：宿主未注入流程协作者时 apply 自建组合根；未配置运行时环境产出 blocked 卡且零调用', async () => {
  const { registered, provided } = mountIndex();
  assert.equal(provided.has(FLOW_KEY), true, 'apply 应把自建的流程协作者提供为 devopsFlow（D-1）');
  assert.equal(typeof provided.get(FLOW_KEY).issueWrite, 'function');
  assert.equal(provided.has(READER_KEY), false, '未配置运行时环境时不提供只读适配器（可见 no-reader）');

  const context = parse(await registered.get('forge_devops_change_context').execute({ target: 'ARD123456' }));
  assert.equal(context.ok, true, '流程面应可达：即使配置缺失也产出卡并说明原因');
  assert.equal(context.status, 'blocked');
  assert.equal(context.context.changeId, 'ARD123456');
  assert.equal(context.config.dopBin, false, '配置状态只报"配没配"，不回显值');
  assert.ok(
    context.unknowns.some((item) => item.field === 'dop.change.view' && item.reason === 'CONFIG_MISSING'),
    '未配置 dop 必须作为未知项写在卡里（AC-22 fail closed）',
  );
  assert.match(context.text, /未知项/u);

  const clarify = parse(
    await registered.get('forge_devops_clarify_write').execute({
      target: 'ARD123456',
      body: '澄清',
      confirm: { repo: 'group/repo', object: 'ARD123456' },
    }),
  );
  assert.equal(clarify.ok, false);
  assert.equal(clarify.result.status, 'denied');
  assert.equal(clarify.result.reason, 'COMMAND_NOT_WHITELISTED');
  assert.equal(clarify.result.calls, 0);
});

test('装配：流程协作者就位后工具→服务→协作者逐层交下去，台账记录四状态', async () => {
  const seen = [];
  const flow = {
    context: async (input) => {
      seen.push({ method: 'context', input });
      return { card: { change: input.target }, text: '## 上下文卡' };
    },
    issueWrite: async (input) => {
      seen.push({ method: 'issueWrite', input });
      return { status: 'done', idempotencyKey: 'k-1', object: 'issue#7' };
    },
    startFromChange: async ({ changeId }) => {
      seen.push({ method: 'startFromChange', changeId });
      return { ok: true, text: '## 上下文卡' };
    },
  };
  const { registered, service } = mountIndex({ flow });

  const context = parse(await registered.get('forge_devops_change_context').execute({ target: 'ARD123456' }));
  assert.equal(context.ok, true);
  assert.equal(context.card.change, 'ARD123456');
  assert.equal(seen[0].input.target, 'ARD123456');

  const issue = parse(
    await registered.get('forge_devops_issue_write').execute({
      op: 'create',
      target: 'group/repo',
      title: '[ARD123456] 实现',
      body: '正文',
      confirm: { repo: 'group/repo', object: 'group/repo' },
    }),
  );
  assert.equal(issue.ok, true);
  assert.equal(issue.result.status, 'done');
  assert.deepEqual(service.ledger(), [
    { action: FLOW_ACTIONS.ISSUE, target: 'group/repo', status: 'done', reason: null, at: service.ledger()[0].at },
  ]);
});

test('装配：产物落盘要先用入口绑定变更号，写出后路径与头部可核对', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'forge-devops-assembly-'));
  try {
    const flow = { startFromChange: async () => ({ ok: true, text: '## 上下文卡' }) };
    const { registered } = mountIndex({ flow });

    const before = parse(
      await registered.get('forge_devops_artifact_write').execute({
        repoRoot,
        kind: 'plan',
        body: '## 交付计划',
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123' },
      }),
    );
    assert.equal(before.ok, false);
    assert.equal(before.reason, 'MISSING_CHANGE_ID');

    const mounted = mountIndex({ flow });
    assert.equal((await mounted.service.startFromChange('ARD123456')).ok, true);
    const written = parse(
      await mounted.registered.get('forge_devops_artifact_write').execute({
        repoRoot,
        kind: 'plan',
        body: '## 交付计划',
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123', commit: null },
      }),
    );
    assert.equal(written.ok, true);
    assert.ok(written.artifact.path.endsWith(path.join('.dsh-devops', 'ARD123456', 'plan.md')));
    const text = readFileSync(written.artifact.path, 'utf8');
    assert.equal(text.split('\n')[0], '---');
    assert.match(text, /^change: ARD123456$/m);
    assert.match(text, /^kind: plan$/m);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
