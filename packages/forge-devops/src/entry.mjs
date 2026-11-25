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
import { cardReadyFor, cardStatusOf, READY_STATUS } from './change-context.mjs';
import { CLI_PAGE_HINT } from './cli-config.mjs';
import { READ_REASONS } from './read.mjs';

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

/**
 * 这些原因指向"入口配置"，恢复方向是改配置而不是原地重试。
 *
 * 取值与产生处保持同源：`CONFIG_MISSING` / `CONFIG_INVALID` 由 flow 在"运行时没配置"时写进未知项
 * （同 flow.mjs 的 FLOW_REASONS），`NO_READER` 来自只读面未配置 reader（read.mjs 的 READ_REASONS）。
 * 刻意不收 `CLI_SPAWN_FAILED`：适配器把未启动的失败归并成 `COMMAND_FAILED` 再进未知项，
 * 其恢复方向同样是"确认 dop 可用"，与重试句式的提示一致。
 */
const CONFIG_REASONS = Object.freeze(['CONFIG_MISSING', 'CONFIG_INVALID', READ_REASONS.NO_READER]);

/**
 * 已知原因码集合：`card.reason` 只在这些码内原样透出，其余按 `CONTEXT_BLOCKED` 归并。
 *
 * 恢复方向是按原因码分流的；把上游任意字符串当原因码放行，会让自定义码落进
 * "确认 dop 可用后重跑"这类不相干的方向。归并时原码仍写进裁决语，诊断不丢。
 */
const KNOWN_REASONS = Object.freeze([
  ...Object.values(ENTRY_REASONS),
  ...Object.values(READ_REASONS),
  ...CONFIG_REASONS,
  // dop 适配器把子进程失败统一折成这个码（见 dop-adapter.mjs 的 FAILURE_CODE）。
  'COMMAND_FAILED',
]);

/** 裁决语里嵌入的上游字符串长度上限：控制字符已折叠，超长串再截断，别把首行撑爆。 */
const MAX_STATUS_LENGTH = 40;
const MAX_DETAIL_LENGTH = 120;

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

/**
 * 上游字符串压成单行：换行、制表与其他控制字符折成空格，连续空白归一。
 *
 * 阻塞文案是多行结构（裁决 / 缺失项 / 下一步），状态、原因码、字段名都来自上游，
 * 一旦带控制字符就会把后面的行挤乱，所以嵌入前统一单行化。
 */
function singleLine(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 单行化后再截断：超长上游串不把裁决语撑爆，末尾加省略号表示被截过。 */
function clamp(value, max) {
  const text = singleLine(value);
  // 按码点截断：`String#slice` 按 UTF-16 code unit 切，遇到 emoji 会把代理对从中间切开，输出乱码。
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/** 缺失项只取 `(field, reason)` 唯一对：同因多项不重复刷屏，空原因不计。 */
function unknownsOf(result) {
  // 契约形状是 `payloadOf` 的顶层 `unknowns`；卡片内的副本不是第二真源，不再猜第二条路径。
  const list = Array.isArray(result?.unknowns) ? result.unknowns : [];
  const seen = new Set();
  const items = [];
  for (const entry of list) {
    const reason = typeof entry?.reason === 'string' ? singleLine(entry.reason) : '';
    if (reason === '') continue;
    const field = typeof entry?.field === 'string' ? singleLine(entry.field) : '';
    const key = `${field}${UNKNOWN_KEY_SEPARATOR}${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ field, reason });
  }
  return items;
}

/**
 * 阻塞裁决：原因码与首行文案成对决定，避免"改了原因码漏改文案"或两条分支各写一套规则。
 *
 * 结论与 `cardReadyFor` 同源（不通过与否一致），但归因顺序有意微调：显式 `ok === false`
 * （读面失败）最先，其次是卡片状态语义（卡片自称未就绪比"ok 没自报"更准确，恢复方向也不同），
 * 最后才是 `ok` 缺失与自报号不可确认。因此 `status='blocked'` 且未回填 `ok` 时，入口报
 * `CONTEXT_BLOCKED`、装配层按 `ok !== true` 拒绝绑定——两者都不通过，只是入口的裁决语更贴近
 * 卡片的说法。顺序只能按这一处改：改完要同步下面各分支注释与用例。
 *
 * @param {unknown} card service 返回的原始响应（未经 ok 过滤）
 * @returns {{ reason: string, headline: string }}
 */
function blockedOutcomeOf(card) {
  if (card?.ok === false) {
    const raw = typeof card.reason === 'string' ? singleLine(card.reason) : '';
    // 只有已知原因码才进分流：自定义码按 CONTEXT_BLOCKED 处理，原码仍写进裁决语便于诊断。
    const isKnown = KNOWN_REASONS.includes(raw);
    const reason = isKnown ? raw : ENTRY_REASONS.CONTEXT_BLOCKED;
    const unknown = raw !== '' && !isKnown;
    // 入参错误根本没发起读取：别用"读取失败"描述它，否则恢复方向会往 dop 上带偏。
    let headline = '阻塞：上下文读取失败，未取回可推进的变更事实。';
    if (reason === ENTRY_REASONS.MISSING_OR_INVALID) {
      headline = '阻塞：变更号不合法，未发起平台读取。';
    } else if (unknown) {
      headline = `阻塞：上下文读取失败（${clamp(raw, MAX_STATUS_LENGTH)}），未取回可推进的变更事实。`;
    }
    return { reason, headline };
  }
  // 判据走 `cardStatusOf`（只去空白），展示前再 `singleLine` 折控制字符：状态里的换行会打断多行文案。
  const status = clamp(cardStatusOf(card), MAX_STATUS_LENGTH);
  if (status === '') {
    return {
      reason: ENTRY_REASONS.CONTEXT_EMPTY,
      headline: '阻塞：响应没有卡片状态，无法确认已取回匹配的变更事实。',
    };
  }
  // 卡片自己说未就绪时以卡片的说法为准：这是状态语义，比"ok 没自报"更准确，恢复方向也不同。
  if (status !== READY_STATUS) {
    return {
      reason: ENTRY_REASONS.CONTEXT_BLOCKED,
      headline: `阻塞：上下文卡未就绪（状态 ${status}），未取回可推进的变更事实。`,
    };
  }
  // `ok` 缺失同样不可确认：注入实现不回填 `ok` 时不能只靠 status 放行（与 cardReadyFor 同一个 fail-closed 口径）。
  if (card?.ok !== true) {
    return {
      reason: ENTRY_REASONS.CONTEXT_UNCONFIRMED,
      headline: '阻塞：上下文卡未自报成功（缺少 ok=true），按未确认处理，未取回可推进的变更事实。',
    };
  }
  // 走到这里只剩一种形状：`ok === true`、`status === ready`，但自报号与请求号不符或缺省
  // （与 `cardReadyFor` 末项判据对应）。前面新增分支时要同步它，否则新形状会静默落到这里。
  return {
    reason: ENTRY_REASONS.CONTEXT_UNCONFIRMED,
    headline: '阻塞：卡片自报的变更号与请求号不一致或未自报，无法确认该卡属于本次请求。',
  };
}

/**
 * 阻塞输出：先给裁决与恢复方向，再附卡片正文——卡片与缺失项照常可读，只是不再假装成功。
 *
 * `next` 的各分支按 `reason` 互斥：入口配置问题指到配置页，入参错误只要求改参数，
 * 自报号不可确认时提示核对号，其余先确认 dop 可用再重跑。新增原因码时，
 * 须同步检查上方配置分流里的排除项是否仍然适用，别让新原因落进不相干的方向。
 */
function blockedText(result, changeId) {
  const items = unknownsOf(result);
  const chain = [ENTRY_NAME, changeId].join(' ');
  const { reason, headline } = blockedOutcomeOf(result);
  // 读面失败的 `detail` 是"为什么没读到"的第一手说明，保留在首行，不塞进卡片正文。
  const detail =
    result?.ok === false && typeof result?.detail === 'string' && singleLine(result.detail) !== ''
      ? `：${clamp(result.detail, MAX_DETAIL_LENGTH)}`
      : '';
  // 恢复方向按原因并列：配置问题指配置页，变更号不可确认时提示核对号与读面回填；
  // 两条同时成立就都给（配置没通也可能伴随号对不上），都不成立才退到通用重试方向。
  const next = [];
  if (
    reason !== ENTRY_REASONS.MISSING_OR_INVALID &&
    (CONFIG_REASONS.includes(reason) || items.some((item) => CONFIG_REASONS.includes(item.reason)))
  ) {
    next.push(`下一步：先到「${CLI_PAGE_HINT}」配置 dop 入口，再重跑 ${chain}。`);
  }
  if (reason === ENTRY_REASONS.MISSING_OR_INVALID) {
    next.push(`下一步：修正变更号格式后重跑 ${chain}——${ENTRY_EXPECTED_FORMAT}。`);
  }
  if (reason === ENTRY_REASONS.CONTEXT_UNCONFIRMED) {
    next.push(`下一步：核对请求的变更号 ${changeId} 是否确为本次目标；号无误时检查读面为何未回填该号，再重跑 ${chain}。`);
  }
  if (next.length === 0) {
    next.push(`下一步：确认 dop 可用后重跑 ${chain}；仍失败按卡内「未知项」排查。`);
  }
  // 入参错误只给"改参数"一条方向：dop 可用与否与变更号写错无关，不掺配置与重试旁白。
  const missingLineOf = () => {
    if (items.length > 0) {
      const listed = items.map((item) => (item.field === '' ? item.reason : `${item.field}：${item.reason}`));
      return `缺失项：${listed.join('；')}`;
    }
    return reason === ENTRY_REASONS.MISSING_OR_INVALID
      ? '缺失项：无（未发起读取）。'
      : '缺失项：无（卡片未列出未知项，按未就绪处理）。';
  };
  const missing = missingLineOf();
  const lines = [
    `${ENTRY_NAME}：${reason}${detail}`,
    headline,
    missing,
    ...next,
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
    // 就绪与否与装配层同一判据（`cardReadyFor`）：`ok` 只表示读面走完，不代表事实已取回（issue #342）。
    // 读面失败、卡片未就绪、自报号对不上走同一处阻塞裁决，避免两处分流各说一套。
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
