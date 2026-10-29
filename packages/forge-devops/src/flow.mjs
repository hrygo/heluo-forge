/**
 * 流程组合根（D-1）：把「运行时配置 → 唯一子进程出口 → dop/gh 适配器 → 门禁 → 平台动作」串成可用的流程协作者。
 *
 * 之前 9 个工具里的 5 个流程工具与 `devops-change` 入口只认 `ctx.get('devopsFlow')`，仓库内没有生产者，
 * 于是流程面恒 `FLOW_UNAVAILABLE`，13 个流程模块成了无人调用的孤儿。本模块就是那个生产者：
 * `apply` 装配一次，工具面与入口照旧通过 `service` 调用。
 *
 * 三条写死在代码里的取舍：
 * 1. **一次聚合**：`dop change view` + `gh repo list` + 关联 Issue/PR 取一轮，再交给纯函数判承建、建卡、渲染；
 * 2. **失败只降级**：任一子查询失败进 unknowns（field/reason/command），卡照样产出并标 blocked，不伪造事实；
 * 3. **写动作不猜**：没有绑定变更号、承建仓库未判定或与目标不一致时，在门禁之前就返回 denied，零下游调用。
 *
 * 配置缺失（AC-22）不是异常：没有运行时环境时 flow 仍然装配，`startFromChange` 产出 blocked 的上下文档
 * 并把 `CONFIG_MISSING` 记进未知项，一个子进程都不发起。
 */
import { createCliRunner } from './cli-runner.mjs';
import { createDopAdapter } from './dop-adapter.mjs';
import { createGhAdapter } from './gh-adapter.mjs';
import { createPolicyGuard, GUARD_REASONS } from './policy-guard.mjs';
import { describeRuntimeConfig, ENV_KEYS, resolveRuntimeConfig } from './runtime-config.mjs';
import { buildContextCard, normalizeChangeRecord, renderContextCard } from './change-context.mjs';
import { resolveBuildingRepository } from './repository-resolver.mjs';
import {
  ACTION_REASONS,
  commentIssueIdempotent,
  commentPrIdempotent,
  createIssueIdempotent,
  createPrIdempotent,
} from './actions.mjs';
import { DevopsReadError, READ_REASONS } from './read.mjs';
import { FLOW_ACTIONS } from './tools.mjs';
import { parseChangeId } from './entry.mjs';

/** 流程面自己的拒绝原因；平台动作四状态之外的值只用于"没走到平台"的早退。 */
export const FLOW_REASONS = Object.freeze({
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  INVALID_CHANGE_ID: 'MISSING_OR_INVALID',
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  UNSUPPORTED_OP: 'UNSUPPORTED_OP',
  REPO_NOT_SELECTED: 'REPO_NOT_SELECTED',
  POLICY_REQUIRED: GUARD_REASONS.POLICY_REQUIRED,
});

/** 只读工具到适配器方法的唯一映射；不改写参数、不拼命令。 */
export const READ_ROUTES = Object.freeze({
  'change.read': (ports, target) => ports.dop.readChange({ changeId: target }),
  'repository.read': (ports, target) => ports.gh.readRepository({ repo: target }),
  'issue.read': (ports, target) => ports.gh.readIssue({ target }),
  'pr.read': (ports, target) => ports.gh.readPr({ target }),
});

/** 关联对象只按变更号匹配：Issue 只有 title，PR 多一个 headRefName。 */
const RELATED_PR_KEY = (changeId) => changeId.toLowerCase();

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 把适配器/门禁抛出的错误压成卡里的一条未知项；错误码原样保留，便于对照门禁目录。 */
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

/** 有完整配置才建端口：runner 是唯一子进程出口，dop/gh 只暴露固定 argv。 */
function createPorts({ runtime, execFile, now }) {
  const runner = createCliRunner({ execFile, timeoutMs: runtime.timeoutMs });
  return {
    runner,
    dop: createDopAdapter({ runner, dopBin: runtime.dopBin, dopEndpoint: runtime.dopEndpoint, now }),
    gh: createGhAdapter({ runner, ghBin: runtime.ghBin, now }),
  };
}

/**
 * 只读工具面的适配器：动作 → 固定方法，未登记的动作在发子进程之前就被拒绝。
 * 配置缺失时保留同一个对象，读取以 CONFIG_MISSING 失败（fail closed，而不是返回空结果）。
 */
export function createDevopsReader({ ports = null, reason = FLOW_REASONS.CONFIG_MISSING } = {}) {
  return Object.freeze({
    async read({ action, target } = {}) {
      const route = READ_ROUTES[action];
      if (route === undefined) {
        throw new DevopsReadError(READ_REASONS.UNKNOWN_ACTION, `只读动作未登记：${String(action)}`, { action });
      }
      if (ports === null) {
        throw new DevopsReadError(reason, `运行时配置不可用（${reason}），未发起 ${action}`, { action, target });
      }
      return route(ports, target);
    },
  });
}

/**
 * 流程协作者工厂。
 *
 * @param {object} [options]
 * @param {object|null} [options.ctx] 宿主注入的 ctx，写动作要交给门禁。
 * @param {object|null} [options.policy] 策略服务；缺省时写动作恒 denied，流程读取照常。
 * @param {object|null} [options.guard] 装配层做好的门禁适配；缺省时按 policy 自建（单独使用本工厂时）。
 * @param {object|null} [options.config] `resolveRuntimeConfig` 的结果或裸配置。
 * @param {object|null} [options.env] 进程环境；与 config 二选一。
 * @param {Function} [options.execFile] 子进程注入点（离线用例用假实现）。
 * @param {Function} [options.now] 时间注入点，默认 ISO 字符串。
 */
export function createDevopsFlow({
  ctx = null,
  policy = null,
  guard = null,
  config = null,
  env = null,
  execFile,
  now = () => new Date().toISOString(),
} = {}) {
  const resolution = normalizeResolution(config, env);
  const runtime = resolution.ok === true ? resolution.value : null;
  const sourceType = text(runtime?.sourceType) === '' ? 'mock' : runtime.sourceType;
  const unavailable = resolution.ok === true ? null : resolution.reason;
  const gate =
    guard !== null && typeof guard === 'object' && typeof guard.execute === 'function'
      ? guard
      : policy !== null && typeof policy === 'object'
        ? createPolicyGuard({ policy })
        : null;
  const ports = runtime === null ? null : createPorts({ runtime, execFile, now });
  const reader = createDevopsReader({ ports, reason: unavailable ?? FLOW_REASONS.CONFIG_MISSING });

  /** 本会话里真的判定过的承建结论：写动作只信这里，不信调用方自报。 */
  const findings = new Map();
  let boundChangeId = null;

  /** 一次聚合：变更记录、可见仓库、关联 Issue/PR；每项失败只降级成未知项。 */
  async function gather({ changeId, explicit = null }) {
    const observedAt = now();
    const unknowns = [];
    const sources = [];
    const related = { issues: [], prs: [] };
    let change = null;
    let visibleRepos = null;

    if (ports === null) {
      for (const field of ['dop.change.view', 'gh.repository.list']) {
        unknowns.push({ field, reason: unavailable ?? FLOW_REASONS.CONFIG_MISSING, command: null });
      }
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

      if (text(runtime.ghOwner) === '') {
        // 没有仓库范围就不扫全量仓库：判定会以 NO_REPO_SCOPE 阻断，写动作因此不落地（AC-12）。
        visibleRepos = null;
      } else {
        try {
          const list = await ports.gh.listRepos({ owner: runtime.ghOwner });
          visibleRepos = asArray(list.items);
          sources.push({
            kind: 'gh',
            command: list.command,
            at: list.observed_at,
            sourceRevision: list.source_revision,
            sourceType,
          });
        } catch (error) {
          unknowns.push(unknownOf(error, 'gh.repository.list'));
        }
      }
    }

    const building = resolveBuildingRepository({ change: change ?? {}, visibleRepos, explicit });

    if (change !== null && building.status === 'resolved' && ports !== null) {
      const repo = building.selected;
      try {
        const list = await ports.gh.listOpenIssues({ repo });
        sources.push({
          kind: 'gh',
          command: list.command,
          at: list.observed_at,
          sourceRevision: list.source_revision,
          sourceType,
        });
        related.issues = asArray(list.items)
          .filter((item) => text(item?.title).includes(changeId))
          .map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            url: item.url,
            matchedBy: 'title',
          }));
      } catch (error) {
        unknowns.push(unknownOf(error, 'gh.issue.list'));
      }
      try {
        const list = await ports.gh.listOpenPrs({ repo });
        sources.push({
          kind: 'gh',
          command: list.command,
          at: list.observed_at,
          sourceRevision: list.source_revision,
          sourceType,
        });
        related.prs = asArray(list.items)
          .filter(
            (item) =>
              text(item?.title).includes(changeId) ||
              text(item?.headRefName).toLowerCase().includes(RELATED_PR_KEY(changeId)),
          )
          .map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            url: item.url,
            matchedBy: text(item?.title).includes(changeId) ? 'title' : 'headRefName',
          }));
      } catch (error) {
        unknowns.push(unknownOf(error, 'gh.pr.list'));
      }
    }

    const card = buildContextCard({ changeId, change, building, related, sources, unknowns });
    return { changeId, change, building, related, sources, unknowns, card, text: renderContextCard(card), observedAt };
  }

  function payloadOf(gathered) {
    return {
      ok: true,
      status: gathered.card.status,
      changeId: gathered.changeId,
      context: gathered.card,
      text: gathered.text,
      building: gathered.building,
      related: gathered.related,
      sources: gathered.sources,
      unknowns: gathered.unknowns,
      sourceType,
      config: describeRuntimeConfig(resolution),
    };
  }

  /** 取事实并绑定变更号：入口与上下文卡工具共用同一条路径，避免两处绑定规则不同。 */
  async function readAndBind(rawChangeId) {
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
    const gathered = await gather({ changeId: parsed.changeId });
    findings.set(parsed.changeId, { building: gathered.building });
    boundChangeId = parsed.changeId;
    return payloadOf(gathered);
  }

  /** 没走到平台就早退的写动作结果：与平台动作同一套四状态，reason 说明为什么零调用。 */
  function denied(action, target, reason, detail) {
    return {
      status: 'denied',
      action,
      target: text(target) === '' ? null : text(target),
      reason,
      detail,
      reused: false,
      key: null,
      calls: 0,
    };
  }

  /** 写前置：门禁、变更号、运行时配置三者缺一即拒绝，且都在子进程之前。 */
  function writeGate(action, target) {
    if (gate === null) {
      return denied(action, target, FLOW_REASONS.POLICY_REQUIRED, '门禁未装配（policy），写动作不执行');
    }
    if (boundChangeId === null) {
      return denied(action, target, FLOW_REASONS.MISSING_CHANGE_ID, '尚未绑定变更号（先跑 devops-change <变更号>）');
    }
    if (ports === null) {
      return denied(action, target, unavailable ?? FLOW_REASONS.CONFIG_MISSING, '运行时配置不可用，写动作不执行');
    }
    return null;
  }

  /** 承建仓库必须已判定且与目标一致：写到候选之外的仓库等于猜。 */
  function repoMismatch(building, target) {
    if (building.status !== 'resolved') return null;
    const expected = text(building.selected).toLowerCase();
    if (expected === '' || expected === text(target).toLowerCase()) return null;
    return { expected: building.selected };
  }

  function buildingOf() {
    const found = findings.get(boundChangeId);
    return found === undefined ? resolveBuildingRepository({ change: {}, visibleRepos: null }) : found.building;
  }

  function repoOf(target) {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)[#!]\d+$/u.exec(text(target));
    return match === null ? null : match[1];
  }

  async function issueWrite(input = {}) {
    const action = FLOW_ACTIONS.ISSUE;
    const target = text(input.target);
    const op = text(input.op);
    const blocked = writeGate(action, target);
    if (blocked !== null) return blocked;
    const building = buildingOf();
    if (op === 'create') {
      const mismatch = repoMismatch(building, target);
      if (mismatch !== null) {
        return denied(
          action,
          target,
          FLOW_REASONS.REPO_NOT_SELECTED,
          `承建仓库已判定为 ${mismatch.expected}，与目标 ${target} 不一致（不写到候选之外）`,
        );
      }
      return createIssueIdempotent({
        guard: gate,
        gh: ports.gh,
        ctx,
        changeId: boundChangeId,
        repo: target,
        title: input.title,
        body: input.body,
        confirm: input.confirm,
        building,
      });
    }
    if (op === 'comment') {
      return commentIssueIdempotent({
        guard: gate,
        gh: ports.gh,
        ctx,
        changeId: boundChangeId,
        target,
        body: input.body,
        confirm: input.confirm,
        building,
      });
    }
    return denied(action, target, FLOW_REASONS.UNSUPPORTED_OP, 'issue 写动作只支持 create/comment');
  }

  async function prWrite(input = {}) {
    const action = input.op === 'comment' ? FLOW_ACTIONS.PR_COMMENT : FLOW_ACTIONS.PR;
    const target = text(input.target);
    const op = text(input.op);
    const blocked = writeGate(action, target);
    if (blocked !== null) return blocked;
    const building = buildingOf();
    if (op === 'create') {
      const mismatch = repoMismatch(building, target);
      if (mismatch !== null) {
        return denied(
          action,
          target,
          FLOW_REASONS.REPO_NOT_SELECTED,
          `承建仓库已判定为 ${mismatch.expected}，与目标 ${target} 不一致（不写到候选之外）`,
        );
      }
      return createPrIdempotent({
        guard: gate,
        gh: ports.gh,
        ctx,
        changeId: boundChangeId,
        repo: target,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        confirm: input.confirm,
        building,
      });
    }
    if (op === 'comment') {
      const mismatch = repoMismatch(building, repoOf(target));
      if (mismatch !== null) {
        return denied(
          action,
          target,
          FLOW_REASONS.REPO_NOT_SELECTED,
          `承建仓库已判定为 ${mismatch.expected}，与评论目标不一致（不写到候选之外）`,
        );
      }
      return commentPrIdempotent({
        guard: gate,
        gh: ports.gh,
        ctx,
        changeId: boundChangeId,
        target,
        commit: input.commit,
        body: input.body,
        confirm: input.confirm,
        building,
      });
    }
    return denied(action, target, FLOW_REASONS.UNSUPPORTED_OP, 'PR 写动作只支持 create/comment');
  }

  return Object.freeze({
    name: 'forge-devops-flow',
    /** 只报"配没配"，不回显值（AC-22）。 */
    describe: () =>
      Object.freeze({
        configured: runtime !== null,
        reason: unavailable,
        missing: resolution.ok === true ? [] : asArray(resolution.missing),
        invalid: resolution.ok === true ? [] : asArray(resolution.invalid),
        sourceType,
        ...describeRuntimeConfig(resolution),
      }),
    reader,
    startFromChange: async ({ changeId } = {}) => readAndBind(changeId),
    context: async (input = {}) => readAndBind(text(input.target) || text(input.changeId)),
    issueWrite,
    prWrite,
  });
}
