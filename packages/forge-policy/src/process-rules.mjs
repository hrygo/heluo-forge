/**
 * 流程规则：判定"这一步在 SDD 顺序里该不该发生"。
 *
 * 事实源（dop 变更状态、计划状态）不可用时跳过相关规则、标记 `unevaluated`
 * 并继续；分支名与调用参数恒可用，不适用该降级。保护分支与强制推送因此始终
 * 可判定。
 */

export const PROCESS_RULES = Object.freeze({
  'change-in-progress': Object.freeze({ severity: 'hard', needs: 'change' }),
  'plan-confirmed': Object.freeze({ severity: 'hard', needs: 'plan' }),
  'push-protected-branch': Object.freeze({ severity: 'hard', needs: 'arguments' }),
  'push-force': Object.freeze({ severity: 'hard', needs: 'arguments' }),
  'pr-acceptance-section': Object.freeze({ severity: 'soft', needs: 'arguments' }),
  'review-ai-source': Object.freeze({ severity: 'hard', needs: 'arguments' }),
});

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
 * @param {{rules: readonly string[], facts?: object, severities?: Record<string, 'hard'|'soft'>}} input
 * @returns {{deny: object[], confirm: object[], unevaluated: object[]}}
 */
export function evaluateProcessRules({ rules = [], facts = {}, severities = {} } = {}) {
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
  if (typeof args.body === 'string') facts.prBody = args.body;
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
