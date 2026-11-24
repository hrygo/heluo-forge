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

function spyService(result = { ok: true, status: 'ready', changeId: 'ARD123456', text: '## 上下文卡\n\n- 变更：ARD123456' }) {
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

test('卡片 blocked：命令报阻塞并给配置方向，阻塞卡与缺失项仍可查看，不追加成功旁白', async () => {
  const { ctx, registered } = host();
  const { service } = spyService({
    ok: true,
    status: 'blocked',
    changeId: 'ARD123456',
    unknowns: [
      { field: 'dop.change.view', reason: 'CONFIG_MISSING' },
      { field: 'dop.change.view', reason: 'CONFIG_MISSING' },
    ],
    text: '## 上下文卡\n\n## 未知项\n\n- `dop.change.view`：`CONFIG_MISSING`',
  });
  registerEntry(ctx, service);
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error', 'blocked 不是成功');
  assert.match(result.text, /CONTEXT_BLOCKED/u);
  assert.match(result.text, /未取回可推进的变更事实/u);
  assert.match(result.text, /`?dop\.change\.view`?：`?CONFIG_MISSING`?/u);
  assert.match(result.text, /设置 → 企业 DevOps/u, '配置类原因指向配置页');
  assert.match(result.text, /## 未知项/u, '阻塞卡与缺失项仍可查看');
  assert.match(result.text, /devops-change ARD123456/u, '恢复方向要带可重跑的命令');
  assert.ok(!result.text.includes(ENTRY_NEXT_STEPS), '阻塞时不得追加成功后的步骤指引');
});

test('读取失败：恢复方向是先确认 dop 可用再重跑', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({
      ok: true,
      status: 'blocked',
      changeId: 'ARD123456',
      unknowns: [{ field: 'dop.change.view', reason: 'COMMAND_FAILED', command: 'dop change view ARD123456 --json' }],
      text: '## 上下文卡\n\n- 状态：`blocked`',
    }).service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /COMMAND_FAILED/u);
  assert.match(result.text, /确认 dop 可用后重跑 devops-change ARD123456/u);
  assert.ok(!result.text.includes('设置 → 企业 DevOps'), '读取失败不是配置问题，不误导去改配置');
  assert.ok(!result.text.includes(ENTRY_NEXT_STEPS));
});

test('空响应或无状态：命令报 CONTEXT_EMPTY，不伪装成功', async () => {
  const { ctx, registered } = host();
  registerEntry(ctx, spyService({ ok: true, text: '' }).service);
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /CONTEXT_EMPTY/u);
  assert.match(result.text, /没有卡片状态/u);
  assert.match(result.text, /devops-change ARD123456/u);
  assert.ok(!result.text.includes(ENTRY_NEXT_STEPS));
});

test('就绪卡自报变更号与请求不一致：CONTEXT_UNCONFIRMED，不报成功', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({ ok: true, status: 'ready', changeId: 'ARD999999', text: '## 上下文卡\n\n- 变更：ARD999999' }).service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /CONTEXT_UNCONFIRMED/u);
  assert.match(result.text, /变更号与请求号不一致或未自报/u);
  assert.match(result.text, /核对请求的变更号 ARD123456/u, '恢复方向是核对变更号，不是原地重试');
  assert.ok(!result.text.includes('确认 dop 可用后重跑'), '号不符与 dop 可用性无关，不得误导重试');
  assert.match(result.text, /devops-change ARD123456/u);
  assert.ok(!result.text.includes(ENTRY_NEXT_STEPS));
});

test('就绪卡未自报变更号：按不可确认处理，fail closed', async () => {
  const { ctx, registered } = host();
  registerEntry(ctx, spyService({ ok: true, status: 'ready', text: '## 上下文卡' }).service);
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /CONTEXT_UNCONFIRMED/u);
  assert.ok(!result.text.includes(ENTRY_NEXT_STEPS));
});

test('读面失败但卡片自称 ready：仍按读面失败报原因，不误报变更号不符', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({ ok: false, reason: 'NO_READER', status: 'ready', changeId: 'ARD123456', text: '## 上下文卡' }).service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /NO_READER/u, 'ok=false 的原因是读面失败，必须原样透出');
  assert.match(result.text, /上下文读取失败/u, '裁决顺序与装配层一致：先判读面失败，再看状态');
  assert.ok(!result.text.includes('CONTEXT_UNCONFIRMED'), '读面失败不得被说成变更号不符');
});

test('配置类原因与变更号不可确认同时成立：两条恢复方向并列给出', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({
      ok: true,
      status: 'ready',
      changeId: 'ARD999999',
      unknowns: [{ field: 'dop.change.view', reason: 'CONFIG_MISSING' }],
      text: '## 上下文卡',
    }).service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /设置 → 企业 DevOps/u);
  assert.match(result.text, /核对请求的变更号 ARD123456/u, '两条恢复方向不得互相截断');
});

test('状态带空白：入口与装配层同一归一化口径，按就绪处理而不是报变更号不符', async () => {
  const { ctx, registered } = host();
  registerEntry(ctx, spyService({ ok: true, status: ' ready ', changeId: 'ARD123456', text: '## 上下文卡' }).service);
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'success', '去空白后是 ready，两处判据必须给同一结论');
  assert.ok(result.text.includes(ENTRY_NEXT_STEPS));
});

test('卡片不回填 ok：状态 ready 也不报成功，按未确认处理', async () => {
  const { ctx, registered } = host();
  registerEntry(ctx, spyService({ status: 'ready', changeId: 'ARD123456', text: '## 上下文卡' }).service);
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error', 'ok 缺失不能靠 status 单独放行');
  assert.match(result.text, /CONTEXT_UNCONFIRMED/u);
  assert.match(result.text, /缺少 ok=true/u);
  assert.ok(!result.text.includes('澄清/计划/实现的后续步骤'), '不追加成功旁白');
});

test('阻塞归因按固定顺序归口：读面失败 / 空状态 / 未自报成功 / 未就绪各归各码', async () => {
  const cases = [
    { card: { ok: false, reason: 'COMMAND_FAILED' }, expect: 'COMMAND_FAILED', why: 'ok:false 先归读面失败' },
    { card: { ok: false }, expect: 'CONTEXT_BLOCKED', why: 'ok:false 且无状态仍归读面失败' },
    { card: {}, expect: 'CONTEXT_EMPTY', why: '空响应无状态' },
    { card: { ok: true }, expect: 'CONTEXT_EMPTY', why: 'ok:true 但缺状态' },
    { card: { ok: true, status: 'blocked', changeId: 'ARD123456' }, expect: 'CONTEXT_BLOCKED', why: '未就绪' },
    { card: { status: 'ready', changeId: 'ARD123456' }, expect: 'CONTEXT_UNCONFIRMED', why: 'ok 缺失按不可确认' },
    { card: { status: 'blocked', changeId: 'ARD123456' }, expect: 'CONTEXT_BLOCKED', why: '卡片自报未就绪优先于 ok 缺失' },
    { card: { ok: true, status: 'ready', changeId: 'ARD999999' }, expect: 'CONTEXT_UNCONFIRMED', why: '号不符' },
  ];
  for (const item of cases) {
    const { ctx, registered } = host();
    registerEntry(ctx, spyService(item.card).service);
    const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
    assert.equal(result.kind, 'error', item.why);
    assert.match(result.text, new RegExp(item.expect, 'u'), item.why);
    assert.ok(!result.text.includes(ENTRY_NEXT_STEPS), `${item.why}：不得追加成功旁白`);
  }
});

test('未知原因码与超长状态：归并成 CONTEXT_BLOCKED 并截断，原码仍可见', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({ ok: false, reason: 'TEAM_CUSTOM_FAIL', detail: 'x'.repeat(400) }).service,
  );
  const failed = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /CONTEXT_BLOCKED/u, '未知码按阻塞归并，不进不相干方向');
  assert.match(failed.text, /TEAM_CUSTOM_FAIL/u, '原码仍可见，便于诊断');
  assert.match(failed.text, /…/u, '超长 detail 被截断');
  assert.ok(!/x{200,}/u.test(failed.text), '不得把 400 字符原样塞进首行');

  // 代理对不能被从中间切开：截断点上放 emoji，输出里不得出现孤立代理。
  const { ctx: ctx3, registered: reg3 } = host();
  const emojiDetail = `${'x'.repeat(118)}😀${'y'.repeat(10)}`;
  registerEntry(ctx3, spyService({ ok: false, reason: 'COMMAND_FAILED', detail: emojiDetail }).service);
  const emoji = await reg3.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.match(emoji.text, /…/u, '超长 detail 被截断');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(emoji.text), '不得留下孤立高位代理');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(emoji.text), '不得留下孤立低位代理');

  const { ctx: ctx2, registered: reg2 } = host();
  registerEntry(ctx2, spyService({ ok: true, status: 'bl'.repeat(60), changeId: 'ARD123456' }).service);
  const long = await reg2.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(long.kind, 'error');
  assert.match(long.text, /状态 blbl[^\n]*…/u, '超长状态截断后仍单行');
  assert.ok(!long.text.includes('bl'.repeat(41)), '状态不超过上限');
});

test('入参错误信封：只给修正变更号格式的方向，不掺配置与 dop 重试旁白', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({ ok: false, reason: 'MISSING_OR_INVALID', text: '上下文卡未产出：请给出一个系统变更号（例如 CHG-2026-0042）。' })
      .service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /变更号不合法，未发起平台读取/u);
  assert.match(result.text, /缺失项：无（未发起读取）/u);
  assert.match(result.text, /修正变更号格式后重跑 devops-change ARD123456/u);
  assert.ok(!result.text.includes('设置 → 企业 DevOps'), '入参错误不是配置问题');
  assert.ok(!result.text.includes('确认 dop 可用'), '不要把人引去排查 dop');
});

test('状态里带控制字符：压成单行再嵌入，不打断多行阻塞文案', async () => {
  const { ctx, registered } = host();
  registerEntry(
    ctx,
    spyService({ ok: true, status: 'ready\nblocked', changeId: 'ARD123456', text: '## 上下文卡' }).service,
  );
  const result = await registered.get(ENTRY_NAME).handler({ rawInput: 'ARD123456' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /状态 ready blocked/u, '控制字符折成空格后仍可读');
  assert.ok(!result.text.includes('ready\nblocked'), '不得把原始换行拼进文案');
  assert.match(result.text, /缺失项：/u, '后续行结构没有被挤掉');
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
