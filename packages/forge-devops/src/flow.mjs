/**
 * 流程组合根（D-1 / r10）：把「运行时配置 → 唯一子进程出口 → dop 适配器 → 只读面 → 上下文卡」串起来。
 *
 * r10（devops / gitee 按平台收敛）砍掉了本模块的写端口：`issueWrite` / `prWrite` 以及判定
 * 「承建仓库」的 `repository-resolver` / `repo-ref` / `actions` 全部删除，理由是同一事实由
 * `@heluo/forge-gitee` 唯一实现——同装时不能有两套仓库事实来源。于是流程只剩三件事：
 *
 * 1. **一次聚合**：`dop change view --json` 取一条变更记录，归一成契约形状；
 * 2. **失败只降级**：子查询失败进 unknowns（field/reason/command），卡照样产出并标 blocked，
 *    不伪造事实；仓库侧的未知项显式指向 Gitee 工具，不在本包猜第二个答案；
 * 3. **配置缺失不是异常**（AC-22）：没有运行时环境时 flow 仍然装配，`startFromChange` 产出
 *    blocked 的上下文档并把 `CONFIG_MISSING` 记进未知项，一个子进程都不发起。
 *
 * 依赖方向只有一个：`flow → (runner, dop-adapter, change-context, read)`。工具层永远拿不到 runner。
 *
 * `ctx` / `policy` / `guard` 仍作为可选入参被接受，但本模块**不再读取它们**：写权限随写端口
 * 一起交给了 forge-gitee，装配层保留同一个门禁适配（`createPolicyGuard`）不在这里复制第二份。
 */
import { createCliRunner } from './cli-runner.mjs';
import { createDopAdapter } from './dop-adapter.mjs';
import { describeRuntimeConfig, ENV_KEYS, resolveRuntimeConfig } from './runtime-config.mjs';
import {
  buildContextCard,
  externalRepoFacts,
  normalizeChangeRecord,
  renderContextCard,
} from './change-context.mjs';
import { createDevopsReader } from './read.mjs';
import { parseChangeId } from './entry.mjs';

/** 流程面自己的拒绝原因；平台动作四状态之外的值只用于"没走到平台"的早退。 */
export const FLOW_REASONS = Object.freeze({
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 把适配器抛出的错误压成卡里的一条未知项；错误码原样保留，便于对照门禁目录。 */
function unknownOf(error, field) {
  const code = text(error?.code) || text(error?.reason) || 'UNKNOWN_ERROR';
  const command = text(error?.detail?.command);
  return { field, reason: code, command: command === '' ? null : command };
}

/**
 * `config` 传 `resolveRuntimeConfig` 的结果或裸配置（显式覆盖）；都没有时读进程环境。
 * 环境也没有就按 CONFIG_MISSING 处理：不猜默认值、不读 PATH（AC-22）。
 * 环境读取只发生在这里（装配层只传显式配置），顺序是"显式 > env > fail closed"。
 */
function normalizeResolution(config, env) {
  if (config !== null && typeof config === 'object') {
    return config.ok === false ? config : { ok: true, value: config };
  }
  const source =
    env !== null && typeof env === 'object'
      ? env
      : typeof process === 'object' && process.env !== undefined
        ? process.env
        : null;
  if (source !== null) return resolveRuntimeConfig(source);
  return { ok: false, reason: FLOW_REASONS.CONFIG_MISSING, missing: [ENV_KEYS.dopBin] };
}

/**
 * 有完整配置才建端口：runner 是唯一子进程出口，dop 只暴露固定 argv。
 *
 * 不再有 `gh` 端口——仓库 / Issue / PR 的读写在 `@heluo/forge-gitee`，这里连 import 都不该出现。
 */
export function createPorts({ runtime, execFile, now }) {
  const runner = createCliRunner({ execFile, timeoutMs: runtime.timeoutMs });
  return {
    runner,
    dop: createDopAdapter({ runner, dopBin: runtime.dopBin, dopEndpoint: runtime.dopEndpoint, now }),
  };
}

/**
 * 流程协作者工厂。
 *
 * @param {object} [options]
 * @param {object|null} [options.ctx] 宿主 ctx（r10 起本模块不写平台，仅保持装配签名稳定）。
 * @param {object|null} [options.policy] 策略服务（同上；只读准入在装配层的 `service.read`）。
 * @param {object|null} [options.guard] 门禁适配（同上；写路径已迁到 forge-gitee）。
 * @param {object|null} [options.config] `resolveRuntimeConfig` 的结果或裸配置。
 * @param {object|null} [options.env] 进程环境；与 config 二选一。
 * @param {object|string|null} [options.unavailable] 装配层给的不可用信封（`{code,message,detail}`）或原因字符串。
 *   有信封时只读面按信封失败（`detail.reason` 带细因）。
 * @param {Function} [options.execFile] 子进程注入点（离线用例用假实现）。
 * @param {Function} [options.now] 时间注入点，默认 ISO 字符串。
 */
export function createDevopsFlow({
  ctx = null,
  policy = null,
  guard = null,
  config = null,
  env = null,
  unavailable = null,
  execFile,
  now = () => new Date().toISOString(),
} = {}) {
  // 入参保持稳定（装配层仍在同一条装配顺序里传它们），但 r10 起本模块没有写端口：
  // 显式 void 掉，避免"看起来在用、其实没人读"的误判。
  void ctx;
  void policy;
  void guard;

  const resolution = normalizeResolution(config, env);
  const runtime = resolution.ok === true ? resolution.value : null;
  const sourceType = text(runtime?.sourceType) === '' ? 'mock' : runtime.sourceType;
  // 可用性优先：调用方直接给的原因字符串/信封压过解析结果（装配层已做过三层合并，解析结论只是兜底）。
  const reasonOverride = typeof unavailable === 'string' && unavailable !== '' ? unavailable : null;
  const unavailableReason = resolution.ok === true ? null : (reasonOverride ?? resolution.reason);
  const ports = runtime === null ? null : createPorts({ runtime, execFile, now });
  const reader = createDevopsReader({
    ports,
    reason: unavailableReason ?? FLOW_REASONS.CONFIG_MISSING,
    unavailable,
  });

  /**
   * 一次聚合：只取 dop 变更这一条事实。
   *
   * 承建仓库与关联 Issue/PR **不在这里判定**：`externalRepoFacts()` 给出 `unknown` +
   * `REPO_FACTS_EXTERNAL` + 下一步（`forge_gitee_repository_read` / `forge_gitee_issue_read`），
   * 由 Gitee 工具回答。本函数因此不会出现第二个仓库事实来源，也不会凭变更号文本猜仓库。
   */
  async function gather({ changeId }) {
    const unknowns = [];
    const sources = [];
    let change = null;

    if (ports === null) {
      unknowns.push({ field: 'dop.change.view', reason: unavailableReason ?? FLOW_REASONS.CONFIG_MISSING, command: null });
    } else {
      try {
        const read = await ports.dop.readChange({ changeId });
        change = normalizeChangeRecord(read.raw, {
          at: read.observed_at,
          sourceRevision: read.source_revision,
          sourceType,
          expectedId: changeId,
        });
        sources.push({
          kind: 'dop',
          command: read.command,
          at: read.observed_at,
          sourceRevision: read.source_revision,
          sourceType,
        });
      } catch (error) {
        unknowns.push(unknownOf(error, 'dop.change.view'));
      }
    }

    const building = externalRepoFacts();
    const card = buildContextCard({
      changeId,
      change,
      building,
      related: { issues: [], prs: [] },
      sources,
      unknowns,
    });
    return { changeId, change, building, sources, unknowns, card, text: renderContextCard(card) };
  }

  function payloadOf(gathered) {
    return {
      ok: true,
      status: gathered.card.status,
      changeId: gathered.changeId,
      context: gathered.card,
      text: gathered.text,
      building: gathered.building,
      related: gathered.card.related,
      sources: gathered.sources,
      unknowns: gathered.unknowns,
      sourceType,
      config: describeRuntimeConfig(resolution),
    };
  }

  /** 取事实：入口与上下文卡工具共用同一条路径，避免两处绑定规则不同。 */
  async function readChange(rawChangeId) {
    const parsed = parseChangeId(rawChangeId);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.reason,
        expectedFormat: parsed.expectedFormat,
        detail: '参数不是单个系统变更号，未取回平台事实',
        text: '上下文卡未产出：请给出一个系统变更号（例如 CHG-2026-0042）。',
      };
    }
    return payloadOf(await gather({ changeId: parsed.changeId }));
  }

  return Object.freeze({
    name: 'forge-devops-flow',
    /** 只报"配没配"，不回显值（AC-22）。 */
    describe: () =>
      Object.freeze({
        configured: runtime !== null,
        reason: unavailableReason,
        missing: resolution.ok === true ? [] : asArray(resolution.missing),
        invalid: resolution.ok === true ? [] : asArray(resolution.invalid),
        sourceType,
        ...describeRuntimeConfig(resolution),
      }),
    reader,
    startFromChange: async ({ changeId } = {}) => readChange(changeId),
    context: async (input = {}) => readChange(text(input.target) || text(input.changeId)),
  });
}
