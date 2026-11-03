import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { READ_ACTIONS, READ_REASONS } from '../src/read.mjs';
import { DEVOPS_TOOLS, FLOW_ACTIONS, FLOW_TOOLS, READ_TOOLS, buildDevopsTools } from '../src/tools.mjs';
import { apply, FLOW_KEY, READER_KEY, SERVICE_KEY } from '../src/index.mjs';

/**
 * 工具面契约（r10）：4 个工具、名字→动作映射唯一真源、参数用 target、澄清写前置 confirm。
 * 业务判定（幂等/回读/四状态）不在工具里，所以这里只验证"工具是否把动作与参数原样交下去"。
 * 仓库 / Issue / PR 读写已归 `@heluo/forge-gitee`，本包不再持有跨平台写入口。
 */

const TOOL_NAMES = [
  'forge_devops_change_read',
  'forge_devops_change_context',
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
      clarifyWrite: record('clarifyWrite', { status: 'denied', reason: 'COMMAND_NOT_WHITELISTED' }),
      artifactWrite: record('artifactWrite', { path: '/tmp/x/report.md', bytes: 10 }),
      ...overrides,
    },
  };
}

const parse = (payload) => JSON.parse(payload.content[0].text);
const byName = (tools, name) => tools.find((tool) => tool.name === name);

test('工具面恰好 4 个，映射表与门禁动作逐条对应', () => {
  assert.deepEqual([...DEVOPS_TOOLS], TOOL_NAMES);
  assert.deepEqual(Object.keys(READ_TOOLS), ['forge_devops_change_read']);
  assert.deepEqual(Object.keys(FLOW_TOOLS).sort(), TOOL_NAMES.slice(1).sort());
  assert.equal(READ_TOOLS.forge_devops_change_read, 'change.read');
  assert.equal(FLOW_TOOLS.forge_devops_change_context.action, 'change.read');
  assert.equal(FLOW_TOOLS.forge_devops_clarify_write.action, FLOW_ACTIONS.CLARIFY);
  assert.equal(FLOW_TOOLS.forge_devops_artifact_write.action, null, '产物落盘没有平台动作');
  assert.deepEqual(Object.keys(FLOW_ACTIONS), ['CLARIFY'], '写动作只剩澄清回写');
  assert.equal(FLOW_ACTIONS.CLARIFY, 'change.clarification.write');
});

test('工具名与动作的唯一真源：源码里恰好出现 4 个工具名，且不含跨平台写工具', () => {
  const source = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  const names = new Set(source.match(/forge_devops_[a-z_]+/gu) ?? []);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  assert.match(source, /confirm/u, '澄清写必须要求 confirm{object}');
  assert.doesNotMatch(source, /forge_devops_(issue_write|pr_write|repository_read|issue_read|pr_read)/u);
});

test('只读工具：参数只有 target，正常路径原样返回契约结果', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), 'forge_devops_change_read');
  assert.deepEqual(tool.parameters.required, ['target']);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['target'], '门禁只读 exec.arguments.target');
  const payload = parse(await tool.execute({ target: 'ARD123456' }));
  assert.equal(payload.ok, true);
  assert.equal(payload.result.action, 'change.read');
  assert.deepEqual(calls, [{ method: 'read', args: { action: 'change.read', target: 'ARD123456' } }]);
  assert.deepEqual([...READ_ACTIONS], ['change.read'], '只读面只有 dop 变更一条');
});

test('只读工具失败时给可见拒绝与下一步，而不是空成功', async () => {
  const { service } = fakeService({
    read: async () => {
      throw Object.assign(new Error('no reader'), { code: READ_REASONS.NO_READER });
    },
  });
  const payload = parse(
    await byName(buildDevopsTools(service), 'forge_devops_change_read').execute({ target: 'ARD123456' }),
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

test('澄清写工具：confirm 缺失或与目标不一致时 denied，且零下游调用', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), 'forge_devops_clarify_write');
  const badConfirms = [undefined, {}, { object: 'CHG-2026-0043' }, { object: '  ' }];
  for (const confirm of badConfirms) {
    const payload = parse(await tool.execute({ target: 'CHG-2026-0042', body: '澄清', confirm }));
    assert.equal(payload.ok, false, `${JSON.stringify(confirm)} 应被拒绝`);
    assert.equal(payload.reason, 'CONFIRMATION_REQUIRED');
    assert.equal(payload.action, FLOW_ACTIONS.CLARIFY);
  }
  assert.equal(calls.length, 0, 'confirm 不通过时一次下游都不该调用');

  const ok = parse(
    await tool.execute({ target: 'CHG-2026-0042', body: '澄清', confirm: { object: 'CHG-2026-0042' } }),
  );
  assert.equal(ok.ok, false, 'dop 命令面无澄清写：结果仍是 denied（拒绝必须可见）');
  assert.equal(ok.result.status, 'denied');
  assert.deepEqual(calls[0], { method: 'clarifyWrite', args: { target: 'CHG-2026-0042', body: '澄清' } });
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
  return { provided, registered, teardown, service: provided.get(SERVICE_KEY) };
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

test('装配：4 个工具全部注册，缺命令面时 entryStatus=no-command-face 而工具面照常可用', () => {
  const { registered, service } = mountIndex();
  assert.equal(registered.size, 4);
  assert.deepEqual(service.toolNames(), TOOL_NAMES);
  assert.equal(service.entryStatus(), 'no-command-face');
  assert.deepEqual(service.readActions(), Array.from(READ_ACTIONS));
  assert.equal(service.ledger, undefined, 'r10 删除写动作后不再保留写台账');
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
  assert.equal(provided.get(FLOW_KEY).issueWrite, undefined);
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
      confirm: { object: 'ARD123456' },
    }),
  );
  assert.equal(clarify.ok, false);
  assert.equal(clarify.result.status, 'denied');
  assert.equal(clarify.result.reason, 'COMMAND_NOT_WHITELISTED');
  assert.equal(clarify.result.calls, 0);
});

test('装配：流程协作者就位后工具→服务→协作者逐层交下去，不写任何跨平台台账', async () => {
  const seen = [];
  const flow = {
    context: async (input) => {
      seen.push({ method: 'context', input });
      return { card: { change: input.target }, text: '## 上下文卡' };
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
  assert.deepEqual(seen[0], { method: 'context', input: { target: 'ARD123456' } });
  assert.equal(service.ledger, undefined);
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

test('端到端：变更读取经工具→服务→门禁→流程走到 succeeded，聚合读与落盘复用同一份绑定', async () => {
  const seen = [];
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'forge-devops-e2e-'));
  try {
    const reader = {
      read: async ({ action, target }) => {
        seen.push({ action, target });
        return { status: 'succeeded', action, target_ref: target, source_revision: 'dop:sha' };
      },
    };
    const flow = {
      context: async (input) => ({ card: { change: input.target }, text: '## 上下文卡' }),
      startFromChange: async () => ({ ok: true, text: '## 上下文卡' }),
    };
    const { registered, service } = mountIndex({ flow, reader });
    assert.equal(service.readActions().length, 1);

    const read = parse(await registered.get('forge_devops_change_read').execute({ target: 'ARD123456' }));
    assert.equal(read.ok, true);
    assert.equal(read.result.status, 'succeeded');
    assert.deepEqual(seen, [{ action: 'change.read', target: 'ARD123456' }], '只读面只交付 dop 变更一条事实');

    const context = parse(await registered.get('forge_devops_change_context').execute({ target: 'ARD123456' }));
    assert.equal(context.ok, true);
    assert.equal(context.text, '## 上下文卡', '聚合读复用注入的流程协作者，不另建一份');

    await service.startFromChange('ARD123456');
    const artifact = parse(
      await registered.get('forge_devops_artifact_write').execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        meta: { sourceType: 'mock', sourceRevision: 'dop:sha' },
      }),
    );
    assert.equal(artifact.ok, true, '绑定变更号后落盘可完成（终态 ok:true）');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
