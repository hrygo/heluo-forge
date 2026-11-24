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
import { cardReadyFor } from './change-context.mjs';
import { CLI_PAGE_HINT } from './cli-config.mjs';

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
  // 卡片未就绪：事实不全只阻断推进，卡片正文与缺失项仍要能看（issue #342）。
  CONTEXT_BLOCKED: 'CONTEXT_BLOCKED',
  // 响应没有卡片状态：无法确认是否读到匹配变更，按阻塞处理（fail closed）。
  CONTEXT_EMPTY: 'CONTEXT_EMPTY',
  // 卡片自称就绪但自报变更号不符或缺省：不可确认属于本次请求，不成功也不绑定。
  CONTEXT_UNCONFIRMED: 'CONTEXT_UNCONFIRMED',
});

/** 这些原因指向"入口配置"，恢复方向是改配置而不是原地重试。 */
const CONFIG_REASONS = Object.freeze(['CONFIG_MISSING', 'CONFIG_INVALID', 'CLI_SPAWN_FAILED']);

/** 去重 key 用 NUL 拼接：正常 `field` / `reason` 取值里不会出现它，不会拼出歧义键。 */
const UNKNOWN_KEY_SEPARATOR = '\u0000';

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

/** 缺失项只取 `(field, reason)` 唯一对：同因多项不重复刷屏，空原因不计。 */
function unknownsOf(result) {
  const list = Array.isArray(result?.unknowns)
    ? result.unknowns
    : Array.isArray(result?.context?.unknowns)
      ? result.context.unknowns
      : [];
  const seen = new Set();
  const items = [];
  for (const entry of list) {
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (reason === '') continue;
    const field = typeof entry?.field === 'string' ? entry.field.trim() : '';
    const key = `${field}${UNKNOWN_KEY_SEPARATOR}${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ field, reason });
  }
  return items;
}

/**
 * 阻塞输出：先给裁决与恢复方向，再附卡片正文——卡片与缺失项照常可读，只是不再假装成功。
 * 恢复方向按原因分流：入口配置问题指到配置页，其余先确认 dop 可用再重跑。
 */
function blockedText(result, changeId) {
  const status = typeof result?.status === 'string' ? result.status.trim() : '';
  const items = unknownsOf(result);
  const configIssue = items.some((item) => CONFIG_REASONS.includes(item.reason));
  const chain = [ENTRY_NAME, changeId].join(' ');
  const reason =
    status === ''
      ? ENTRY_REASONS.CONTEXT_EMPTY
      : status === 'ready'
        ? ENTRY_REASONS.CONTEXT_UNCONFIRMED
        : ENTRY_REASONS.CONTEXT_BLOCKED;
  const headline =
    status === ''
      ? '阻塞：响应没有卡片状态，无法确认已取回匹配的变更事实。'
      : status === 'ready'
        ? '阻塞：卡片自报的变更号与请求号不一致或未自报，无法确认该卡属于本次请求。'
        : `阻塞：上下文卡未就绪（状态 ${status}），未取回可推进的变更事实。`;
  const lines = [
    `${ENTRY_NAME}：${reason}`,
    headline,
    items.length === 0
      ? '缺失项：无（卡片未列出未知项，按未就绪处理）。'
      : `缺失项：${items.map((item) => (item.field === '' ? item.reason : `${item.field}：${item.reason}`)).join('；')}`,
    configIssue
      ? `下一步：先到「${CLI_PAGE_HINT}」配置 dop 入口，再重跑 ${chain}。`
      : `下一步：确认 dop 可用后重跑 ${chain}；仍失败按卡内「未知项」排查。`,
    '本次不进入澄清/计划/实现步骤，也不改写会话绑定。',
  ];
  const body = String(result?.text ?? '').trimEnd();
  return body === '' ? lines.join('\n') : `${lines.join('\n')}\n\n${body}`;
}

/**
 * 注册入口。解析失败时**不调用** service（零下游调用）；就绪卡输出卡 + 旁白，未就绪输出阻塞与恢复方向。
 *
 * @param {{ get?: (key: string) => unknown }} ctx 宿主上下文
 * @param {{ startFromChange?: (changeId: string) => Promise<{
 *   ok: boolean, status?: string, changeId?: string, text?: string, reason?: string, detail?: string,
 *   unknowns?: Array<{ field?: string, reason?: string }>,
 * }> }} service
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
    // 就绪与否与装配层同一判据（`cardReadyFor`）：`ok` 只表示读面走完，不代表事实已取回（issue #342）。
    if (!cardReadyFor(result, parsed.changeId)) {
      return { kind: 'error', text: blockedText(result, parsed.changeId) };
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
