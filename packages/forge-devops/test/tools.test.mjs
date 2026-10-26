import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, buildDevopsTools, inject, name, READ_ACTIONS, READ_REASONS, READ_TOOLS, SERVICE_KEY } from '../src/index.mjs';

/** 最小宿主替身：get/provide/effect + 记录工具注册与卸载。 */
function host({ reader, withTools = true } = {}) {
  const provided = new Map();
  const registered = new Map();
  const ctx = {
    get: (key) =>
      key === 'policy'
        ? {
            catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
            executeAction: async (ctx, action, exec, operation) => operation(),
          }
        : key === 'devopsReader'
          ? reader
          : undefined,
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
  };
  if (withTools) {
    ctx.tools = {
      register: (definition) => {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    };
  }
  return { ctx, provided, registered };
}

const parse = (payload) => JSON.parse(payload.content[0].text);

test('只注册四个只读工具，没有任何写工具', () => {
  const { registered } = (() => {
    const h = host();
    apply(h.ctx, {});
    return h;
  })();
  assert.equal(registered.size, 4);
  assert.deepEqual([...registered.keys()].sort(), Object.keys(READ_TOOLS).sort());
  for (const [name, definition] of registered) {
    assert.ok(name.endsWith('_read'), `${name} 不应出现在只读工具面`);
    assert.ok(READ_ACTIONS.includes(READ_TOOLS[name]), `${name} 未映射到只读动作`);
    assert.ok(!/write|create|update|close|publish|record/u.test(name), `${name} 看起来是写工具`);
  }
});

test('工具参数用门禁认识的 target，且为必填', () => {
  const service = { read: async () => ({}) };
  for (const definition of buildDevopsTools(service)) {
    assert.deepEqual(definition.parameters.required, ['target']);
    assert.equal(definition.parameters.properties.target.type, 'string');
    // 门禁只读 exec.arguments.target；用 command/path 之类的名字会让 target-required 永远不满足。
    assert.deepEqual(Object.keys(definition.parameters.properties), ['target']);
  }
});

test('execute 正常路径返回契约结果，动作与工具名一致', async () => {
  const reader = {
    read: async ({ action, target }) => ({
      status: 'succeeded',
      target_ref: target,
      source_revision: 'rev-1',
      result_refs: [`${target}@rev-1`],
      observed_at: '2026-10-24T12:00:00Z',
      action,
    }),
  };
  const { registered } = (() => {
    const h = host({ reader });
    apply(h.ctx, {});
    return h;
  })();
  for (const [name, definition] of registered) {
    const payload = parse(await definition.execute({ target: 'X-1' }));
    assert.equal(payload.ok, true);
    assert.equal(payload.result.action, READ_TOOLS[name]);
    assert.equal(payload.result.status, 'succeeded');
    assert.equal(payload.result.source_revision, 'rev-1');
    assert.equal(payload.result.retry_policy, 'read_recheck');
  }
});

test('没有适配器时工具返回可见拒绝（ok:false + next_action），不返回空成功', async () => {
  const { registered } = (() => {
    const h = host();
    apply(h.ctx, {});
    return h;
  })();
  const definition = registered.get('forge_devops_issue_read');
  const payload = parse(await definition.execute({ target: 'group/repo#7' }));
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, READ_REASONS.NO_READER);
  assert.equal(payload.next_action, 'configure-reader');
  assert.equal(payload.result, undefined);
});

test('适配器只给退出码时工具报 unknown，而不是成功', async () => {
  const reader = { read: async () => ({ exitCode: 0, stdout: 'ok' }) };
  const { registered } = (() => {
    const h = host({ reader });
    apply(h.ctx, {});
    return h;
  })();
  const payload = parse(await registered.get('forge_devops_change_read').execute({ target: 'CHG-1' }));
  assert.equal(payload.ok, true, '调用本身没失败');
  assert.equal(payload.result.status, 'unknown', '但没有事实就不许报成功');
  assert.equal(payload.result.error_code, READ_REASONS.NO_STRUCTURED_STATUS);
});

test('卸载同时移除服务与全部工具注册（无残留）', () => {
  const { ctx, provided, registered } = host();
  const teardown = apply(ctx, {});
  assert.ok(provided.has(SERVICE_KEY));
  assert.equal(registered.size, 4);
  teardown();
  assert.equal(provided.has(SERVICE_KEY), false);
  assert.equal(registered.size, 0);
});

test('宿主没有 tools 服务时不注册工具，但服务仍可提供（差异可见）', () => {
  const { ctx, provided, registered } = host({ withTools: false });
  apply(ctx, {});
  assert.equal(registered.size, 0);
  assert.ok(provided.has(SERVICE_KEY));
  assert.deepEqual(provided.get(SERVICE_KEY).toolNames(), Object.keys(READ_TOOLS));
});

test('插件声明 name 与 inject：少了 tools 会静默不注册工具，少了 policy 会整项不激活', () => {
  // 两种失败模式都由宿主探针（scripts/probe/devops-read-probe.mjs，2026-10-24）实测到。
  assert.equal(name, 'forge-devops');
  assert.deepEqual([...inject].sort(), ['policy', 'tools']);
});
