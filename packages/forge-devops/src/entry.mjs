/**
 * `@heluo/forge-devops` 的命令入口 `devops-change`（T7 / §7.7）。
 *
 * 入口只做三件事，业务判定一律在 service / 纯函数模块里：
 * 1. **只收一个参数：变更号**。`parseChangeId` 不按前缀推断语义（`ARD`/`CHG` 只是标识符），
 *    格式非法立刻返回错误并**零下游调用**——不让"顺手猜一个变更号"变成一次平台读取。
 * 2. **解析通过后才交给 service**：service 负责取数、承建判定与上下文卡渲染；
 *    入口只把结果排版成"卡 + 后续步骤旁白"。
 * 3. **没有 commands 服务不算失败**：`commandFaceStatus(ctx)` 返回 `no-command-face`，
 *    工具面照常注册（§7.7 第 12 行），入口退化为不可用但整包仍挂载。
 *
 * 变更号格式与落盘路径同源（`artifacts.mjs` 的 `CHANGE_ID_PATTERN`），
 * 否则会出现"命令收得下、产物写不出"的分叉。
 */
import { CHANGE_ID_PATTERN } from './artifacts.mjs';

/** 入口名；与 `cordis.patch.yml`、文档和测试共用这一个字符串。 */
export const ENTRY_NAME = 'devops-change';

/** 参数格式说明（错误提示与帮助共用，保证"期望格式"只有一份）。 */
export const ENTRY_EXPECTED_FORMAT =
  '变更号，例如 ARD123456 或 CHG-2026-0042（字母数字开头，只含字母/数字/下划线/连字符，只接受一个参数）';

export const ENTRY_HELP = [
  `用法：${ENTRY_NAME} <变更号>`,
  `参数：${ENTRY_EXPECTED_FORMAT}`,
  '作用：按变更号取回平台事实、承建仓库判定与关联对象，输出上下文卡与后续步骤。',
  '不接受其它参数，也不按变更号前缀推断类型。',
].join('\n');

/** 解析通过后的固定旁白：把"接下来该做什么"写在入口输出里，而不是让模型自己编流程。 */
export const ENTRY_NEXT_STEPS = [
  '后续步骤：',
  '1. 澄清：改变验收结论或承建范围的歧义必须问清（其余记入已记录假设 H-n）。',
  '2. 交付计划：逐条验收条件 → 实现项 → 验证方式，按真实边界拆分。',
  '3. 实现与平台记录：Issue / PR 先查重再创建，创建后回读确认。',
  '4. 交叉审查：AI 栏与人工确认栏分开记录，commit 变化即判 stale。',
  '5. 完成报告：逐条证据、mock 与真实实测分记；关闭只判定不执行。',
].join('\n');

export const ENTRY_REASONS = Object.freeze({
  MISSING_OR_INVALID: 'MISSING_OR_INVALID',
  CONFIG_MISSING: 'CONFIG_MISSING',
  POLICY_DENIED: 'POLICY_DENIED',
  COMMAND_NOT_WHITELISTED: 'COMMAND_NOT_WHITELISTED',
  INTERNAL: 'INTERNAL',
});

/**
 * 解析入口参数：唯一一个变更号，不允许多参数、空串或中文描述。
 *
 * @param {unknown} input 宿主传进来的原始输入
 * @returns {{ ok: true, changeId: string } | { ok: false, reason: 'MISSING_OR_INVALID', expectedFormat: string }}
 */
export function parseChangeId(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  const tokens = raw.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 1 && CHANGE_ID_PATTERN.test(tokens[0])) {
    return { ok: true, changeId: tokens[0] };
  }
  return { ok: false, reason: ENTRY_REASONS.MISSING_OR_INVALID, expectedFormat: ENTRY_EXPECTED_FORMAT };
}

/** 命令面是否可用：没有 commands 服务时返回 `no-command-face`，不抛错、不阻断挂载。 */
export function commandFaceStatus(ctx) {
  const commands = ctx?.get?.('commands');
  return commands && typeof commands.register === 'function' ? 'registered' : 'no-command-face';
}

function errorText(parsed) {
  return [
    `${ENTRY_NAME}：${parsed.reason}`,
    `期望：${parsed.expectedFormat}`,
    '',
    ENTRY_HELP,
  ].join('\n');
}

/**
 * 注册入口。解析失败时**不调用** service（零下游调用），成功时输出卡 + 旁白。
 *
 * @param {{ get?: (key: string) => unknown }} ctx 宿主上下文
 * @param {{ startFromChange?: (changeId: string) => Promise<{ ok: boolean, text?: string, reason?: string, detail?: string }> }} service
 * @returns {() => void} 卸载函数（无命令面时是空函数）
 */
export function registerEntry(ctx, service) {
  const commands = ctx?.get?.('commands');
  if (!commands || typeof commands.register !== 'function') return () => {};

  const handler = async (invocation) => {
    const parsed = parseChangeId(invocation?.rawInput);
    if (!parsed.ok) return { kind: 'error', text: errorText(parsed) };
    if (typeof service?.startFromChange !== 'function') {
      return { kind: 'error', text: `${ENTRY_NAME}：${ENTRY_REASONS.INTERNAL}（缺少 startFromChange）` };
    }
    let result;
    try {
      result = await service.startFromChange(parsed.changeId);
    } catch (error) {
      return {
        kind: 'error',
        text: `${ENTRY_NAME}：${ENTRY_REASONS.INTERNAL}：${String(error?.message ?? error)}`,
      };
    }
    if (!result?.ok) {
      const reason = result?.reason ?? ENTRY_REASONS.INTERNAL;
      const detail = result?.detail ? `：${result.detail}` : '';
      return { kind: 'error', text: `${ENTRY_NAME}：${reason}${detail}\n\n${result?.text ?? ''}`.trimEnd() };
    }
    const body = String(result.text ?? '').trimEnd();
    return { kind: 'success', text: `${body}\n\n${ENTRY_NEXT_STEPS}`.trim() };
  };

  const definition = {
    name: ENTRY_NAME,
    description: '从系统变更号开始：取回平台事实与上下文卡，并给出后续步骤。只接受一个变更号参数。',
    input: { hint: '变更号，例如 ARD123456' },
    // 本包声明：入口只收变更号，模型不得自行发起。
    // 宿主 CommandDefinition 没有这个字段，故只作声明式标注，不传给 register。
    // modelInvocable: false
    handler,
  };
  return commands.register(definition);
}
