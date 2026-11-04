import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { READ_ACTIONS, READ_REASONS } from '../src/read.mjs';
import { DEVOPS_TOOLS, FLOW_ACTIONS, FLOW_TOOLS, QUERY_ACTIONS, QUERY_TOOL, buildDevopsTools } from '../src/tools.mjs';
import { apply, FLOW_KEY, READER_KEY, SERVICE_KEY } from '../src/index.mjs';

/**
 * 工具面契约（D 方案 + 写回）：4 个工具（typed 只读 runner / 聚合读 / 受控写 / 产物落盘）、名字→动作映射唯一真源、
 * 参数用 target、change.list 只接受 @me、clarify/plan 的 data 与 body 互斥。
 * 业务判定（归一、机检、门禁）不在工具里，所以这里只验证"工具是否把动作与参数原样交下去"。
 * 仓库 / Issue / PR 读写已归 `@heluo/forge-gitee`，本包不再持有跨平台写入口。
 */

const CONTEXT_TOOL = 'forge_devops_change_context';
const UPDATE_TOOL = 'forge_devops_change_update';
const ARTIFACT_TOOL = 'forge_devops_artifact_write';
const TOOL_NAMES = [QUERY_TOOL, CONTEXT_TOOL, UPDATE_TOOL, ARTIFACT_TOOL];

const META = Object.freeze({ sourceType: 'mock', sourceRevision: 'dop:abc123456789' });

function fakeService(overrides = {}) {
  const calls = [];
  const record = (method, value) => async (args) => {
    calls.push({ method, args });
    return typeof value === 'function' ? value(args) : value;
  };
  return {
    calls,
    service: {
      read: record('read', (args) => ({
        action: args.action,
        target_ref: args.target,
        status: 'succeeded',
        source_revision: 'dop:abc123456789',
        result_refs: [],
        observed_at: '2026-11-03T00:00:00.000Z',
        error_code: null,
        retry_policy: 'read_recheck',
        command: args.action === 'change.list' ? 'dop change list --json' : `dop change view ${args.target} --json`,
        facts:
          args.action === 'change.list'
            ? { user: 'alice', total: 1, count: 1, filter: null, items: [{ id: 'CHG-1' }], raw: { changes: [{ id: 'CHG-1' }] } }
            : { normalized: null, raw: { id: args.target }, normalize_error: null },
        truncated: false,
      })),
      context: record('context', { card: { change: 'ARD123456' }, text: '## 上下文卡' }),
      changeUpdate: record('changeUpdate', (args) => ({
        status: 'done',
        target_ref: args.target,
        fields: { summary: args.summary, description: args.description, aiAc: args.aiAc },
        readback: { ok: true, fields: { summary: 'match', description: 'match', aiAc: 'match' } },
        retry_policy: 'none',
      })),
      artifactWrite: record('artifactWrite', { path: '/tmp/x/report.md', bytes: 10 }),
      ...overrides,
    },
  };
}

const parse = (payload) => JSON.parse(payload.content[0].text);
const byName = (tools, name) => tools.find((tool) => tool.name === name);

test('工具面恰好 4 个，映射表与门禁动作逐条对应', () => {
  assert.deepEqual([...DEVOPS_TOOLS], TOOL_NAMES);
  assert.equal(QUERY_TOOL, 'forge_devops_query');
  assert.deepEqual([...QUERY_ACTIONS], [...READ_ACTIONS], '只读 runner 的动作词表与只读动作同源');
  assert.deepEqual(Object.keys(FLOW_TOOLS), [CONTEXT_TOOL, UPDATE_TOOL, ARTIFACT_TOOL], '流程工具：聚合读 / 受控写 / 落盘');
  assert.equal(FLOW_TOOLS[CONTEXT_TOOL].action, 'change.read');
  assert.equal(FLOW_TOOLS[UPDATE_TOOL].action, FLOW_ACTIONS.CHANGE_UPDATE, '写回按 change.clarification.write 登记');
  assert.equal(FLOW_TOOLS[ARTIFACT_TOOL].action, null, '产物落盘没有平台动作');
});

test('工具名与动作的唯一真源：源码里恰好 4 个工具名，且不含已被删除/跨平台的工具', () => {
  const source = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  const names = new Set(source.match(/forge_devops_[a-z_]+/gu) ?? []);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  assert.doesNotMatch(
    source,
    /forge_devops_(change_read|clarify_write|issue_write|pr_write|repository_read|issue_read|pr_read)/u,
    '旧的只读工具与澄清写工具必须已删除（澄清写随平台写面一起归 forge-gitee）',
  );
});

test('只读 runner：参数 schema 受枚举约束，action/target 必填，status 可选', async () => {
  const { service } = fakeService();
  const tool = byName(buildDevopsTools(service), QUERY_TOOL);
  assert.deepEqual(tool.parameters.required, ['action', 'target']);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['action', 'target', 'status'], '门禁只读 exec.arguments.target');
  assert.deepEqual(tool.parameters.properties.action.enum, ['change.read', 'change.list']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.parameters.properties.status.description, /change\.list/u, 'status 只对 change.list 生效');
});

test('change.read：正常路径返回信封 + 命令标签 + facts，且不把 status 交给下游', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), QUERY_TOOL);
  const payload = parse(await tool.execute({ action: 'change.read', target: ' ARD123456 ', status: 'open' }));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'change.read');
  assert.equal(payload.target, 'ARD123456', 'target 先 trim 再交下游');
  assert.equal(payload.command, 'dop change view ARD123456 --json');
  assert.equal(payload.envelope.status, 'succeeded');
  assert.deepEqual(payload.facts, { normalized: null, raw: { id: 'ARD123456' }, normalize_error: null });
  assert.equal(payload.truncated, false);
  assert.deepEqual(calls, [{ method: 'read', args: { action: 'change.read', target: 'ARD123456' } }], 'change.read 忽略 status');
});

test('change.list：只接受 @me（大小写不敏感并规范化），并把 status 透传给 service', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), QUERY_TOOL);
  const payload = parse(await tool.execute({ action: 'change.list', target: ' @ME ', status: 'open' }));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'change.list');
  assert.equal(payload.target, '@me', '规范化后的 target 必须回显为 @me');
  assert.deepEqual(calls, [
    { method: 'read', args: { action: 'change.list', target: '@me', status: 'open' } },
  ]);
  assert.equal(payload.facts.user, 'alice');
  assert.equal(payload.facts.count, 1);
});

test('change.list：非 @me 目标在工具层拒绝，零下游调用', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), QUERY_TOOL);
  for (const target of ['alice', '', '@all', 'ARD123456', ' me']) {
    const payload = parse(await tool.execute({ action: 'change.list', target }));
    assert.equal(payload.ok, false, `「${target}」必须被拒绝`);
    assert.equal(payload.action, 'change.list');
    assert.equal(payload.reason, 'UNSUPPORTED_TARGET');
    assert.equal(payload.next_action, 'use-@me');
  }
  assert.equal(calls.length, 0, '目标语义不支持时一次下游都不该调用');
});

test('未知 action：失败信封原样透出原因码与下一步', async () => {
  const { service } = fakeService({
    read: async () => {
      throw Object.assign(new Error('unregistered'), { code: READ_REASONS.UNKNOWN_ACTION });
    },
  });
  const payload = parse(
    await byName(buildDevopsTools(service), QUERY_TOOL).execute({ action: 'issue.close', target: 'x' }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.action, 'issue.close');
  assert.equal(payload.reason, READ_REASONS.UNKNOWN_ACTION);
  assert.equal(payload.next_action, 'report-to-admin');
});

test('只读 runner 失败时给可见拒绝与下一步，而不是空成功', async () => {
  const { service } = fakeService({
    read: async () => {
      throw Object.assign(new Error('no reader'), { code: READ_REASONS.NO_READER });
    },
  });
  const payload = parse(
    await byName(buildDevopsTools(service), QUERY_TOOL).execute({ action: 'change.read', target: 'ARD123456' }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, READ_REASONS.NO_READER);
  assert.equal(payload.next_action, 'configure-reader');
  assert.equal(payload.result, undefined);
});

test('聚合读工具：一次取回上下文卡与渲染文本', async () => {
  const { service, calls } = fakeService();
  const payload = parse(
    await byName(buildDevopsTools(service), CONTEXT_TOOL).execute({ target: 'ARD123456' }),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.text, '## 上下文卡');
  assert.equal(payload.card.change, 'ARD123456');
  assert.deepEqual(calls[0], { method: 'context', args: { target: 'ARD123456' } });
});

test('写回工具：confirm 与目标不一致时拒绝且零下游调用', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), UPDATE_TOOL);
  for (const confirm of [undefined, {}, { object: 'ARD000001' }, { object: '  ' }]) {
    const payload = parse(await tool.execute({ target: 'ARD123456', summary: '新标题', confirm }));
    assert.equal(payload.ok, false, `${JSON.stringify(confirm)} 应被拒绝`);
    assert.equal(payload.reason, 'CONFIRMATION_REQUIRED');
    assert.equal(payload.action, FLOW_ACTIONS.CHANGE_UPDATE);
  }
  assert.equal(calls.length, 0, 'confirm 不通过时一次下游都不该调用');
});

test('写回工具：三个字段都为空 → MISSING_ARGUMENT，零下游调用', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), UPDATE_TOOL);
  const payload = parse(
    await tool.execute({ target: 'ARD123456', confirm: { object: 'ARD123456' }, summary: '   ', description: '' }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'MISSING_ARGUMENT');
  assert.equal(payload.next_action, 'complete-arguments');
  assert.equal(calls.length, 0);
});

test('写回工具：字段原样交给 service，结果 done 才 ok:true', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), UPDATE_TOOL);
  const payload = parse(
    await tool.execute({
      target: ' ARD123456 ',
      summary: '优化启动性能',
      description: '补齐启动链路的重试',
      aiAc: '启动耗时下降 30%',
      confirm: { object: 'ARD123456' },
    }),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.result.status, 'done');
  assert.deepEqual(payload.result.fields, {
    summary: '优化启动性能',
    description: '补齐启动链路的重试',
    aiAc: '启动耗时下降 30%',
  });
  assert.deepEqual(calls[0], {
    method: 'changeUpdate',
    args: { target: 'ARD123456', summary: '优化启动性能', description: '补齐启动链路的重试', aiAc: '启动耗时下降 30%' },
  });
});

test('写回工具：策略拒绝/绑定不符时给可见失败与下一步，而静默成功', async () => {
  const cases = [
    ['POLICY_ACTION_UNREGISTERED', 'report-to-admin'],
    ['TARGET_NOT_BOUND', 'read-the-change'],
    ['MISSING_CHANGE_ID', 'report-to-admin'],
  ];
  for (const [code, next] of cases) {
    const { service } = fakeService({
      changeUpdate: async () => {
        throw Object.assign(new Error('拒绝'), { code });
      },
    });
    const payload = parse(
      await byName(buildDevopsTools(service), UPDATE_TOOL).execute({
        target: 'ARD123456',
        summary: 'x',
        confirm: { object: 'ARD123456' },
      }),
    );
    assert.equal(payload.ok, false, `${code} 必须可见失败`);
    assert.equal(payload.reason, code);
    assert.equal(payload.next_action, next);
  }
});

test('写回工具：unknown 结果不报成功（退出码 0 不算完成）', async () => {
  const { service } = fakeService({
    changeUpdate: async () => ({ status: 'unknown', target_ref: 'ARD123456', readback: { ok: false }, retry_policy: 'none' }),
  });
  const payload = parse(
    await byName(buildDevopsTools(service), UPDATE_TOOL).execute({
      target: 'ARD123456',
      summary: 'x',
      confirm: { object: 'ARD123456' },
    }),
  );
  assert.equal(payload.ok, false, 'unknown 不是成功');
  assert.equal(payload.result.status, 'unknown');
});

test('产物落盘工具：schema 含 data，body 不再是必填；clarify/plan 只交 data', async () => {
  const { service, calls } = fakeService();
  const tool = byName(buildDevopsTools(service), ARTIFACT_TOOL);
  assert.deepEqual(tool.parameters.required, ['repoRoot', 'kind', 'meta'], 'clarify/plan 不带 body，body 不能是必填');
  assert.deepEqual(Object.keys(tool.parameters.properties), ['repoRoot', 'kind', 'body', 'data', 'meta']);
  assert.deepEqual(Object.keys(tool.parameters.properties.data.properties), ['findings', 'criteria', 'items']);
  assert.equal(tool.parameters.properties.data.additionalProperties, false);

  const clarifyData = { findings: [{ kind: 'acceptance', question: '以哪版为准？' }] };
  const clarify = parse(
    await tool.execute({ repoRoot: '/tmp/repo', kind: 'clarify', data: clarifyData, meta: META }),
  );
  assert.equal(clarify.ok, true);
  assert.deepEqual(calls[0], {
    method: 'artifactWrite',
    args: { repoRoot: '/tmp/repo', kind: 'clarify', body: undefined, data: clarifyData, meta: META },
  });

  const planData = { criteria: ['验收一'], items: [{ criterionIndex: 1, change: '实现', verification: ['node --test'] }] };
  parse(await tool.execute({ repoRoot: '/tmp/repo', kind: 'plan', data: planData, meta: META }));
  assert.deepEqual(calls[1].args.data, planData, 'plan 的 criteria/items 原样交下去');
});

test('产物落盘工具：错误码与下一步原样透出（body/data 互斥、机检失败）', async () => {
  const cases = [
    ['ARTIFACT_ARGUMENT_MISMATCH', 'fix-arguments'],
    ['ARTIFACT_CLARIFY_INVALID', 'fix-content'],
    ['ARTIFACT_PLAN_INVALID', 'fix-content'],
  ];
  for (const [code, next] of cases) {
    const { service } = fakeService({
      artifactWrite: async () => {
        throw Object.assign(new Error('拒绝'), { code });
      },
    });
    const payload = parse(
      await byName(buildDevopsTools(service), ARTIFACT_TOOL).execute({
        repoRoot: '/tmp/repo',
        kind: 'plan',
        body: '正文',
        data: {},
        meta: META,
      }),
    );
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, code);
    assert.equal(payload.next_action, next);
  }

  const { service: escaping } = fakeService({
    artifactWrite: async () => {
      throw Object.assign(new Error('逃逸'), { code: 'ARTIFACT_PATH_ESCAPE' });
    },
  });
  const denied = parse(
    await byName(buildDevopsTools(escaping), ARTIFACT_TOOL).execute({
      repoRoot: '/tmp/repo',
      kind: 'context',
      body: '正文',
      meta: META,
    }),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'ARTIFACT_PATH_ESCAPE');
});

test('service 缺方法时工具报 INTERNAL，而不是静默成功', async () => {
  const payload = parse(await byName(buildDevopsTools({}), CONTEXT_TOOL).execute({ target: 'ARD123456' }));
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'INTERNAL');
  assert.equal(payload.next_action, 'report-to-admin');
});

/* ─────────────────────────── 装配层（index.mjs）─────────────────────────── */

/** 假宿主：策略目录齐全、可按需注入只读端口/流程端口/命令面。 */
function mountIndex({ flow, reader, commands, write = false, onAction = null } = {}) {
  const catalog = new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }]));
  if (write === true) {
    catalog.set(FLOW_ACTIONS.CHANGE_UPDATE, { action: FLOW_ACTIONS.CHANGE_UPDATE, kind: 'write', enabled: true });
  }
  const policy = {
    catalog,
    executeAction: async (_ctx, action, exec, operation) => {
      onAction?.({ action, target: exec?.arguments?.target });
      return operation();
    },
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

test('装配：3 个工具全部注册，缺命令面时 entryStatus=no-command-face 而工具面照常可用', () => {
  const { registered, service } = mountIndex();
  assert.equal(registered.size, 4);
  assert.deepEqual(service.toolNames(), TOOL_NAMES);
  assert.equal(service.entryStatus(), 'no-command-face');
  assert.deepEqual(service.readActions(), Array.from(READ_ACTIONS));
  assert.equal(service.clarifyWrite, undefined, '恒 denied 的旧澄清写工具已删除，写回只走 change_update');
  assert.equal(typeof service.changeUpdate, 'function', '受控写服务存在（默认被策略拒绝）');
  assert.equal(service.ledger, undefined, '不保留本地写台账：结果以平台回读为准');
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

  const context = parse(await registered.get(CONTEXT_TOOL).execute({ target: 'ARD123456' }));
  assert.equal(context.ok, true, '流程面应可达：即使配置缺失也产出卡并说明原因');
  assert.equal(context.status, 'blocked');
  assert.equal(context.context.changeId, 'ARD123456');
  assert.equal(context.config.dopBin, false, '配置状态只报"配没配"，不回显值');
  assert.ok(
    context.unknowns.some((item) => item.field === 'dop.change.view' && item.reason === 'CONFIG_MISSING'),
    '未配置 dop 必须作为未知项写在卡里（AC-22 fail closed）',
  );
  assert.match(context.text, /未知项/u);
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

  const context = parse(await registered.get(CONTEXT_TOOL).execute({ target: 'ARD123456' }));
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
      await registered.get(ARTIFACT_TOOL).execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123' },
      }),
    );
    assert.equal(before.ok, false);
    assert.equal(before.reason, 'MISSING_CHANGE_ID');

    const mounted = mountIndex({ flow });
    assert.equal((await mounted.service.startFromChange('ARD123456')).ok, true);
    const written = parse(
      await mounted.registered.get(ARTIFACT_TOOL).execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123', commit: null },
      }),
    );
    assert.equal(written.ok, true);
    assert.ok(written.artifact.path.endsWith(path.join('.dsh-devops', 'ARD123456', 'context.md')));
    const text = readFileSync(written.artifact.path, 'utf8');
    assert.equal(text.split('\n')[0], '---');
    assert.match(text, /^change: ARD123456$/m);
    assert.match(text, /^kind: context$/m);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('写回经装配层：先读再写、目标不一致拒绝、门禁收到动作与目标、done 才 ok', async () => {
  const seen = [];
  const reader = {
    read: async ({ target }) => ({
      status: 'succeeded',
      target_ref: target,
      source_revision: 'dop:sha',
      observed_at: '2026-11-04T00:00:00.000Z',
      raw: { id: target, title: 't', status: 'open' },
    }),
  };
  const flow = {
    startFromChange: async () => ({ ok: true, text: '## 上下文卡' }),
    context: async () => ({ card: { change: 'ARD123456' }, text: '## 上下文卡' }),
    changeUpdate: async ({ changeId, summary }) => ({
      status: 'done',
      target_ref: changeId,
      fields: { summary },
      readback: { ok: true },
      retry_policy: 'none',
    }),
  };
  const { registered, service } = mountIndex({ flow, reader, write: true, onAction: (entry) => seen.push(entry) });
  const writes = () => seen.filter((entry) => entry.action === FLOW_ACTIONS.CHANGE_UPDATE);
  const tool = registered.get(UPDATE_TOOL);
  const ask = (target) => tool.execute({ target, summary: '新标题', confirm: { object: target } });

  const before = parse(await ask('ARD123456'));
  assert.equal(before.ok, false);
  assert.equal(before.reason, 'MISSING_CHANGE_ID', '没读过就不能写');
  assert.equal(writes().length, 0, '绑定不成立时零下游');

  await service.read({ action: 'change.read', target: 'ARD123456' });
  const wrong = parse(await ask('ARD999999'));
  assert.equal(wrong.reason, 'TARGET_NOT_BOUND', '只能写会话已读到的那条变更');
  assert.equal(writes().length, 0);

  const ok = parse(await ask('ARD123456'));
  assert.equal(ok.ok, true);
  assert.equal(ok.result.status, 'done');
  assert.deepEqual(writes().at(-1), { action: FLOW_ACTIONS.CHANGE_UPDATE, target: 'ARD123456' }, '门禁收到动作与目标');
});

test('装配：上下文卡 ready 时绑定变更号，blocked 不绑定', async () => {
  const readyFlow = {
    context: async () => ({
      ok: true,
      status: 'ready',
      changeId: 'ARD123456',
      card: { change: { changeId: 'ARD123456' } },
      text: '## 上下文卡',
    }),
    startFromChange: async () => ({ ok: true, text: '## 上下文卡' }),
  };
  const ready = mountIndex({ flow: readyFlow });
  assert.equal(ready.service.changeId(), null);
  await ready.service.context({ target: 'ARD123456' });
  assert.equal(ready.service.changeId(), 'ARD123456', '卡片 ready 即绑定，落盘不必再走命令入口');

  const blockedFlow = {
    context: async () => ({ ok: true, status: 'blocked', changeId: 'ARD123456', card: {}, text: '## 上下文卡' }),
    startFromChange: async () => ({ ok: true, text: '## 上下文卡' }),
  };
  const blocked = mountIndex({ flow: blockedFlow });
  await blocked.service.context({ target: 'ARD123456' });
  assert.equal(blocked.service.changeId(), null, '事实不全的卡不得绑定变更号');
});

test('装配：artifact_write 的 data 经真实 service 落盘，body/data 互斥与机检失败由 artifacts 报出', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'forge-devops-data-'));
  try {
    const flow = { startFromChange: async () => ({ ok: true, text: '## 上下文卡' }) };
    const { registered, service } = mountIndex({ flow });
    assert.equal((await service.startFromChange('ARD123456')).ok, true);
    const tool = registered.get(ARTIFACT_TOOL);

    // 互斥由 service（真实 artifacts.mjs）判定，工具层原样透出原因码与下一步。
    const mismatch = parse(
      await tool.execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        data: { findings: [] },
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123' },
      }),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'ARTIFACT_ARGUMENT_MISMATCH');
    assert.equal(mismatch.next_action, 'fix-arguments', '参数互斥是可修正的：下一步改参数，而不是找管理员');

    // clarify：data.findings 经机检后渲染落盘（正文不是调用方给的）。
    const clarify = parse(
      await tool.execute({
        repoRoot,
        kind: 'clarify',
        data: {
          findings: [
            {
              id: 'Q-1',
              kind: 'acceptance',
              question: '“可用”指什么？',
              basis: 'acceptance_criteria[1]',
              options: [
                { id: 'O-1', label: '可通过构建', effect: '只看构建', pros: ['快'], cons: ['漏性能'] },
                { id: 'O-2', label: '通过性能基线', effect: '先补基线', pros: ['可量化'], cons: ['慢'] },
              ],
              recommendation: { optionId: 'O-2', why: '与需求一致' },
            },
          ],
        },
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123' },
      }),
    );
    assert.equal(clarify.ok, true);
    const clarifyText = readFileSync(clarify.artifact.path, 'utf8');
    assert.match(clarifyText, /^kind: clarify$/mu);
    assert.match(clarifyText, /## 硬门禁项/u);
    assert.ok(clarify.artifact.path.endsWith(path.join('.dsh-devops', 'ARD123456', 'clarify.md')));

    // plan：缺验证方式 → 机检不通过，错误 detail 带逐条 gaps，且不落盘。
    const plan = parse(
      await tool.execute({
        repoRoot,
        kind: 'plan',
        data: {
          criteria: ['验收一'],
          items: [{ id: 'P-1', criterionIndex: 1, change: '实现', verification: [] }],
        },
        meta: { sourceType: 'mock', sourceRevision: 'dop:abc123' },
      }),
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'ARTIFACT_PLAN_INVALID');
    assert.equal(plan.next_action, 'fix-content');
    assert.match(plan.detail, /交付计划未通过机检/u, '拒绝必须可见：detail 说明是机检不通过');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('端到端：query change.read 经工具→服务→门禁→流程读成功即绑定，artifact_write 无需命令入口', async () => {
  const seen = [];
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'forge-devops-e2e-'));
  try {
    const reader = {
      read: async ({ action, target, status }) => {
        seen.push({ action, target, status });
        if (action === 'change.list') {
          return {
            status: 'succeeded',
            target_ref: 'changes',
            source_revision: 'dop:list',
            command: 'dop change list --json',
            user: 'alice',
            total: 1,
            count: 1,
            filter: null,
            items: [{ id: 'ARD123456' }],
            raw: { user: 'alice', total: 1, changes: [{ id: 'ARD123456' }] },
          };
        }
        return {
          status: 'succeeded',
          target_ref: target,
          source_revision: 'dop:sha',
          observed_at: '2026-11-03T00:00:00.000Z',
          command: `dop change view ${target} --json`,
          raw: { id: 'ARD123456', title: '示例变更', status: 'in_progress' },
        };
      },
    };
    const flow = {
      context: async (input) => ({ card: { change: input.target }, text: '## 上下文卡' }),
      startFromChange: async () => ({ ok: true, text: '## 上下文卡' }),
    };
    const { registered, service } = mountIndex({ flow, reader });
    assert.equal(service.readActions().length, 2);
    assert.equal(service.entryStatus(), 'no-command-face', '本用例没有命令面：落盘只能靠读成功后的绑定');

    // 未读就写：仍然拒绝（绑定不是默认值）。
    const before = parse(
      await registered.get(ARTIFACT_TOOL).execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        meta: { sourceType: 'mock', sourceRevision: 'dop:sha' },
      }),
    );
    assert.equal(before.ok, false);
    assert.equal(before.reason, 'MISSING_CHANGE_ID');

    const read = parse(await registered.get(QUERY_TOOL).execute({ action: 'change.read', target: 'ARD123456' }));
    assert.equal(read.ok, true);
    assert.equal(read.envelope.status, 'succeeded');
    assert.deepEqual(seen, [{ action: 'change.read', target: 'ARD123456', status: undefined }]);
    assert.equal(read.facts.raw.id, 'ARD123456', 'raw 记录原样交回');
    assert.equal(read.facts.normalize_error, null);
    assert.equal(read.facts.normalized.changeId, 'ARD123456', '归一投影与上下文卡同一映射');
    assert.equal(service.changeId(), 'ARD123456', '读成功即绑定');

    const artifact = parse(
      await registered.get(ARTIFACT_TOOL).execute({
        repoRoot,
        kind: 'context',
        body: '## 上下文卡',
        meta: { sourceType: 'mock', sourceRevision: 'dop:sha' },
      }),
    );
    assert.equal(artifact.ok, true, 'change.read 绑定后落盘可完成（Web 会话无命令入口也成立）');
    assert.ok(artifact.artifact.path.endsWith(path.join('.dsh-devops', 'ARD123456', 'context.md')));

    // change.list 不改变绑定：只读清单不是"当前变更"。
    const listed = parse(await registered.get(QUERY_TOOL).execute({ action: 'change.list', target: '@me', status: 'open' }));
    assert.equal(listed.ok, true);
    assert.deepEqual(seen[1], { action: 'change.list', target: '@me', status: 'open' });
    assert.equal(listed.facts.user, 'alice');
    assert.equal(service.changeId(), 'ARD123456', '清单读不覆盖已绑定的变更号');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('装配：change.read 归一失败不抛错，raw 照常返回并写 normalize_error', async () => {
  const reader = {
    read: async ({ target }) => ({
      status: 'succeeded',
      target_ref: target,
      source_revision: 'dop:broken',
      raw: { id: 'ARD123456' },
    }),
  };
  const { service } = mountIndex({ reader });
  const result = await service.read({ action: 'change.read', target: 'ARD123456' });
  assert.equal(result.status, 'succeeded', '读事实成功了，不能因为归一失败而报读失败');
  assert.equal(result.facts.normalized, null);
  assert.equal(result.facts.normalize_error, 'CONTEXT_RECORD_INVALID');
  assert.deepEqual(result.facts.raw, { id: 'ARD123456' }, 'raw 仍然返回');
  assert.equal(service.changeId(), 'ARD123456', '归一失败不影响绑定（读成功即绑定）');
});
