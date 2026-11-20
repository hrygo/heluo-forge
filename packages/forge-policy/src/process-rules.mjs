/**
 * 流程规则：判定"这一步在 SDD 顺序里该不该发生"。
 *
 * 事实源（dop 变更状态、计划状态）不可用时跳过相关规则、标记 `unevaluated`
 * 并继续；分支名与调用参数恒可用，不适用该降级。保护分支与强制推送因此始终
 * 可判定。
 *
 * 每条规则声明它作用于哪些动作（`actions`）：流程语义只在对应的写动作上成立，
 * 例如验收小节只对建 PR 有意义，拿去判推送只会产生噪声拒绝。
 */

export const PROCESS_RULES = Object.freeze({
  'change-in-progress': Object.freeze({ severity: 'hard', needs: 'change', actions: Object.freeze(['*']) }),
  'plan-confirmed': Object.freeze({ severity: 'hard', needs: 'plan', actions: Object.freeze(['*']) }),
  'push-protected-branch': Object.freeze({ severity: 'hard', needs: 'arguments', actions: Object.freeze(['gitee.git.push']) }),
  'push-force': Object.freeze({ severity: 'hard', needs: 'arguments', actions: Object.freeze(['gitee.git.push']) }),
  'pr-acceptance-section': Object.freeze({ severity: 'soft', needs: 'arguments', actions: Object.freeze(['gitee.pr.write']) }),
  'review-ai-source': Object.freeze({ severity: 'hard', needs: 'arguments', actions: Object.freeze(['gitee.pr.write']) }),
});

/**
 * 已接入判定链路的规则：只靠调用参数即可判定，不需要外部事实源。
 *
 * 其余两条（`change-in-progress`、`plan-confirmed`）要读 dop 变更状态与计划状态，
 * 事实源未接入前不参与判定——宁可少判一条，也不让"查不到"变成"一律拒绝"。
 */
export const WIRED_PROCESS_RULES = Object.freeze([
  'push-protected-branch',
  'push-force',
  'pr-acceptance-section',
  'review-ai-source',
]);

/** 保护分支的内置名单：本地分支名恒可用，因此不因事实源不可用而降级。 */
export const PROTECTED_BRANCHES = Object.freeze([/^main$/u, /^master$/u, /^release\/.+/u]);

const ACCEPTANCE_SECTION = /(?:^|\n)#{1,6}\s*(?:验收|验收标准|acceptance)/iu;
const AI_SOURCE = /AI\s*(?:生成|辅助|review)|模型\s*(?:生成|评审)|generated\s+with\s+AI|ai-assisted/iu;
const PR_VERSION = /(?:PR|MR)\s*(?:版本|revision|rev)[:：\s]*[A-Za-z0-9._-]+|版本[:：\s]*[A-Za-z0-9._-]+/iu;

export class PolicyProcessError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyProcessError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function reason(rule, text) {
  return Object.freeze({ rule, reason: text });
}

/**
 * @param {{rules: readonly string[], facts?: object, severities?: Record<string, 'hard'|'soft'>, action?: string}} input
 * @returns {{deny: object[], confirm: object[], unevaluated: object[]}}
 */
export function evaluateProcessRules({ rules = [], facts = {}, severities = {}, action } = {}) {
  const deny = [];
  const confirm = [];
  const unevaluated = [];
  const state = facts ?? {};
  const sources = state.sources ?? {};
  const branch = typeof state.branch === 'string' ? state.branch : undefined;
  const changeId = typeof state.changeId === 'string' && state.changeId.trim().length > 0 ? state.changeId : undefined;

  for (const rule of rules) {
    const definition = PROCESS_RULES[rule];
    if (definition === undefined) {
      throw new PolicyProcessError(`unknown process rule "${rule}"`, 'POLICY_PROCESS_RULE_UNKNOWN', { rule });
    }
    // 规则只在它声明的动作上生效：流程语义不适用于其它写动作，硬套只会误伤。
    if (action !== undefined && !definition.actions.includes('*') && !definition.actions.includes(action)) {
      continue;
    }
    const severity = severities[rule] ?? definition.severity;
    switch (rule) {
      case 'change-in-progress': {
        if (changeId === undefined) {
          unevaluated.push(reason(rule, 'no change id is bound to this call'));
          break;
        }
        const source = sources.change;
        if (source?.available !== true) {
          unevaluated.push(reason(rule, 'the change fact source is unavailable'));
          break;
        }
        const status = typeof source.status === 'string' ? source.status.toLowerCase() : '';
        if (!['in-progress', 'in_progress', '进行中', 'active'].includes(status)) {
          deny.push(reason(rule, `change "${changeId}" is not in progress (status: ${source.status ?? 'unknown'})`));
        }
        break;
      }
      case 'plan-confirmed': {
        if (changeId === undefined) {
          unevaluated.push(reason(rule, 'no change id is bound to this call'));
          break;
        }
        const source = sources.plan;
        if (source?.available !== true) {
          unevaluated.push(reason(rule, 'the plan fact source is unavailable'));
          break;
        }
        if (source.confirmed !== true) {
          deny.push(reason(rule, `the plan for change "${changeId}" is not confirmed`));
        }
        break;
      }
      case 'push-protected-branch': {
        if (branch === undefined) {
          deny.push(reason(rule, 'the target branch cannot be verified'));
          break;
        }
        if (PROTECTED_BRANCHES.some((pattern) => pattern.test(branch))) {
          deny.push(reason(rule, `branch "${branch}" is protected and cannot be pushed by an agent`));
        }
        break;
      }
      case 'push-force': {
        if (state.force !== true) break;
        deny.push(reason(rule, 'force push is not allowed'));
        break;
      }
      case 'pr-acceptance-section': {
        // Comments contain comment text, not the pull request description.
        if (state.op === 'comment') break;
        const body = typeof state.prBody === 'string' ? state.prBody : '';
        if (body.length === 0) {
          if (severity === 'hard') deny.push(reason(rule, 'the pull request body is missing'));
          else confirm.push(reason(rule, 'the pull request has no body to check for an acceptance section'));
          break;
        }
        if (!ACCEPTANCE_SECTION.test(body)) {
          if (severity === 'hard') deny.push(reason(rule, 'the pull request body has no acceptance section'));
          else confirm.push(reason(rule, 'the pull request body has no acceptance section'));
        }
        break;
      }
      case 'review-ai-source': {
        // 只看评论式评审：PR 正文不是评审；`forge_gitee_review_publish` 自己追加
        // `> AI 生成：… PR 版本：…` 页脚，模型不必也不该重复声明。
        if (state.op !== 'comment') break;
        const body = typeof state.reviewBody === 'string' ? state.reviewBody : '';
        if (!AI_SOURCE.test(body)) {
          deny.push(reason(rule, 'the review does not state that it was produced with AI assistance'));
          break;
        }
        if (!PR_VERSION.test(body)) {
          deny.push(reason(rule, 'the review does not name the pull request revision it applies to'));
        }
        break;
      }
      default:
        break;
    }
  }
  return {
    deny: Object.freeze(deny),
    confirm: Object.freeze(confirm),
    unevaluated: Object.freeze(unevaluated),
  };
}

/**
 * Extract process facts from the tool arguments without guessing at absent
 * fields. Missing facts stay missing: the rule decides whether that is
 * `unevaluated` or a refusal.
 *
 * @param {Record<string, unknown>} args
 * @returns {object}
 */
export function factsFromArguments(args = {}) {
  const facts = {};
  if (args === null || typeof args !== 'object') return facts;
  if (typeof args.changeId === 'string') facts.changeId = args.changeId;
  else if (typeof args.change === 'string') facts.changeId = args.change;
  if (typeof args.op === 'string') facts.op = args.op;
  if (typeof args.branch === 'string') facts.branch = args.branch;
  else if (typeof args.ref === 'string' && !args.ref.includes(':')) facts.branch = args.ref;
  if (args.force === true) facts.force = true;
  if (typeof args.body === 'string') {
    facts.prBody = args.body;
    // 评论式评审的正文与 PR 正文同走 `body`：是不是评审由 `op` 决定。
    if (args.op === 'comment') facts.reviewBody = args.body;
  }
  if (typeof args.review === 'string') facts.reviewBody = args.review;
  else if (typeof args.comment === 'string') facts.reviewBody = args.comment;
  return facts;
}

/**
 * Merge argument facts with facts supplied by a trusted host provider. The
 * provider is the only source allowed to say a fact source is unavailable.
 *
 * @param {object} facts
 * @param {{change?: object, plan?: object}} sources
 * @returns {object}
 */
export function withSources(facts, sources = {}) {
  const merged = { ...facts };
  if (sources.change !== undefined || sources.plan !== undefined) {
    merged.sources = {
      ...(sources.change === undefined ? {} : { change: sources.change }),
      ...(sources.plan === undefined ? {} : { plan: sources.plan }),
    };
  }
  return merged;
}
