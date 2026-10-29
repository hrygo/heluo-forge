import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ENTRY_HELP,
  ENTRY_NAME,
  ENTRY_NEXT_STEPS,
  commandFaceStatus,
  parseChangeId,
  registerEntry,
} from '../src/entry.mjs';

/**
 * 入口契约：只收一个变更号、格式非法早退零调用、没有命令面不阻断挂载。
 * 命令面用最小宿主替身（register 返回 disposer），service 只记录调用。
 */

function host({ withCommands = true } = {}) {
  const registered = new Map();
  const ctx = {
    get: (key) =>
      key === 'commands' && withCommands
        ? {
            register: (definition) => {
              registered.set(definition.name, definition);
              return () => registered.delete(definition.name);
            },
          }
        : undefined,
  };
  return { ctx, registered };
}

function spyService(result = { ok: true, text: '## 上下文卡\n\n- 变更：ARD123456' }) {
  const calls = [];
  return {
    calls,
    service: {
      startFromChange: async (changeId) => {
        calls.push(changeId);
        return typeof result === 'function' ? result(changeId) : result;
      },
    },
  };
}

test('入口名与帮助：只收一个变更号', () => {
  assert.equal(ENTRY_NAME, 'devops-change');
  assert.match(ENTRY_HELP, /变更号/u);
  assert.match(ENTRY_HELP, /不接受其它参数/u);
});

test('parseChangeId：合法只收一个，其余一律 MISSING_OR_INVALID', () => {
  assert.deepEqual(parseChangeId('ARD123456'), { ok: true, changeId: 'ARD123456' });
  assert.deepEqual(parseChangeId('  CHG-2026-0042  '), { ok: true, changeId: 'CHG-2026-0042' });
  for (const bad of ['', '   ', 'ARD 123456', '见附件', 'ARD123456 附加说明', '../evil', 'ARD/123456', null, undefined, 42]) {
    const parsed = parseChangeId(bad);
    assert.equal(parsed.ok, false, `「${String(bad)}」必须被拒绝`);
    assert.equal(parsed.reason, 'MISSING_OR_INVALID');
    assert.match(parsed.expectedFormat, /变更号/u, '错误提示必须给出期望格式');
  }
});

test('没有 commands 服务时：不抛错、返回空卸载函数、状态为 no-command-face', () => {
  const { ctx } = host({ withCommands: false });
  assert.equal(commandFaceStatus(ctx), 'no-command-face');
  const dispose = registerEntry(ctx, spyService().service);
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

test('有命令面时注册入口：名字与 hint 对齐，且不把声明式字段塞给宿主', () => {
  const { ctx, registered } = host();
  assert.equal(commandFaceStatus(ctx), 'registered');
  const dispose = registerEntry(ctx, spyService().service);
  const definition = registered.get(ENTRY_NAME);
  assert.ok(definition, '入口必须注册在 devops-change 名下');
  assert.match(definition.input.hint, /变更号/u);
  assert.equal(typeof definition.handler, 'function');
  assert.ok(!('modelInvocable' in definition), '宿主 CommandDefinition 没有该字段，不能塞进去');
  dispose();
  assert.equal(registered.has(ENTRY_NAME), false, '卸载必须移除命令注册');
});

test('参数非法时零下游调用，只回错误与期望格式', async () => {
  const { ctx, registered } = host();
  const { service, calls } = spyService();
  registerEntry(ctx, service);
  const handler = registered.get(ENTRY_NAME).handler;
  for (const bad of ['', '见附件', 'ARD 123456']) {
    const result = await handler({ commandId: 'c1', rawInput: bad, attachments: [] });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /MISSING_OR_INVALID/u);
    assert.match(result.text, /变更号/u);
  }
  assert.deepEqual(calls, [], '格式非法不得触发任何平台读取');
});

test('参数合法时交给 service，输出上下文卡 + 后续步骤旁白', async () => {
  const { ctx, registered } = host();
  const { service, calls } = spyService();
  registerEntry(ctx, service);
  const result = await registered.get(ENTRY_NAME).handler({ commandId: 'c2', rawInput: ' ARD123456 ' });
  assert.deepEqual(calls, ['ARD123456']);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /## 上下文卡/u);
  assert.ok(result.text.includes(ENTRY_NEXT_STEPS), '旁白必须是入口固定输出的那一份');
});

test('service 拒绝与抛错都转成可见错误，不伪装成功', async () => {
  const { ctx, registered } = host();
  registerEntry(ctx, { startFromChange: async () => ({ ok: false, reason: 'CONFIG_MISSING', detail: 'FORGE_DEVOPS_DOP_BIN' }) });
  const denied = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(denied.kind, 'error');
  assert.match(denied.text, /CONFIG_MISSING/u);

  registerEntry(ctx, {
    startFromChange: async () => {
      throw Object.assign(new Error('boom'), { code: 'POLICY_DENIED' });
    },
  });
  const thrown = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(thrown.kind, 'error');
  assert.match(thrown.text, /INTERNAL/u);
  assert.match(thrown.text, /boom/u);
});

test('源码声明 modelInvocable: false（入口不得由模型自行发起）', () => {
  const source = readFileSync(new URL('../src/entry.mjs', import.meta.url), 'utf8');
  assert.match(source, /modelInvocable\s*:\s*false/u);
});
