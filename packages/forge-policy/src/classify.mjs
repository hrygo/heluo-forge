/**
 * 动作分类与默认决策。
 *
 * 分类随包编译，不从工具自报属性推导；目录只能登记分类中已有的动作，并把
 * 决策收紧或放宽到分类允许的范围。三态按 `deny > confirm > allow` 取最严。
 */

export const CATEGORY = Object.freeze({
  READ: 'read',
  DEV_WRITE: 'dev-write',
  REVIEW_WRITE: 'review-write',
  REMOTE_WRITE: 'remote-write',
  HUMAN_RECORD: 'human-record',
});

const DECISION_RANK = Object.freeze({ allow: 0, confirm: 1, deny: 2 });

export class PolicyClassifyError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyClassifyError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * @param {...string} decisions
 * @returns {'allow' | 'confirm' | 'deny'} the strictest of the inputs
 */
export function strictestDecision(...decisions) {
  let result = 'allow';
  for (const decision of decisions) {
    if (!Object.hasOwn(DECISION_RANK, decision)) {
      throw new PolicyClassifyError(`unknown decision "${decision}"`, 'POLICY_DECISION_INVALID', { decision });
    }
    if (DECISION_RANK[decision] > DECISION_RANK[result]) result = decision;
  }
  return result;
}

/**
 * @param {'allow' | 'confirm' | 'deny'} current
 * @param {'allow' | 'confirm' | 'deny'} ceiling
 * @returns {boolean} true when applying `current` would relax `ceiling`
 */
export function relaxes(current, ceiling) {
  return DECISION_RANK[current] < DECISION_RANK[ceiling];
}

function entry(action, category, target, decision, extra = {}) {
  return Object.freeze({
    action,
    category,
    target,
    decision,
    contentGate: category !== CATEGORY.READ,
    processRules: Object.freeze(extra.processRules ?? []),
    confirmation: extra.confirmation ?? 'none',
    revision: extra.revision ?? false,
  });
}

const R = CATEGORY.READ;
const D = CATEGORY.DEV_WRITE;
const W = CATEGORY.REVIEW_WRITE;
const P = CATEGORY.REMOTE_WRITE;
const H = CATEGORY.HUMAN_RECORD;

/**
 * 随包内置的动作分类。动作标识与工程工具契约 §3.1 的实现映射同源。
 * `decision` 是动作名本身的默认决策；内容与流程规则在其上逐次叠加。
 */
export const BUILTIN_ACTIONS = Object.freeze(new Map([
  ['change.read', entry('change.read', R, 'change', 'allow')],
  ['change.list', entry('change.list', R, 'changes', 'allow')],
  ['gitee.repository.read', entry('gitee.repository.read', R, 'repository', 'allow')],
  ['gitee.issue.read', entry('gitee.issue.read', R, 'issue', 'allow')],
  ['gitee.pr.read', entry('gitee.pr.read', R, 'pull-request', 'allow')],
  ['gitee.delivery.judge', entry('gitee.delivery.judge', R, 'change', 'allow')],
  ['gitee.issue.write', entry('gitee.issue.write', D, 'issue', 'allow', {
    processRules: ['change-in-progress'],
    confirmation: 'scope',
    revision: false,
  })],
  ['gitee.pr.write', entry('gitee.pr.write', D, 'pull-request', 'allow', {
    processRules: ['pr-acceptance-section'],
    confirmation: 'scope',
  })],
  ['change.clarification.write', entry('change.clarification.write', D, 'change', 'allow', {
    processRules: ['change-in-progress'],
    confirmation: 'scope',
  })],
  ['gitee.review.publish', entry('gitee.review.publish', W, 'pull-request', 'allow', {
    processRules: ['review-ai-source'],
    confirmation: 'scope',
  })],
  ['gitee.git.push', entry('gitee.git.push', P, 'repository', 'confirm', {
    processRules: ['push-protected-branch', 'push-force', 'change-in-progress', 'plan-confirmed'],
    confirmation: 'each',
  })],
  ['gitee.review.record', entry('gitee.review.record', H, 'pull-request', 'deny', {
    confirmation: 'none',
  })],
]));

/**
 * @param {string} action
 * @returns {object | undefined} the builtin classification
 */
export function classifyAction(action) {
  return BUILTIN_ACTIONS.get(action);
}

/**
 * The decision a registered action would take on its own, before content and
 * process rules. 未登记的动作没有默认决策：调用方必须先按未登记拒绝。
 *
 * @param {string} action
 * @returns {'allow' | 'confirm' | 'deny'}
 */
export function defaultDecision(action) {
  const classified = BUILTIN_ACTIONS.get(action);
  if (classified === undefined) {
    throw new PolicyClassifyError(`action "${action}" is not classified`, 'POLICY_ACTION_UNKNOWN', { action });
  }
  return classified.decision;
}

/**
 * An action is a write when it is not read-only. `gitee.review.record` is a
 * human record: it is denied for agents regardless of identity.
 *
 * @param {string} action
 * @returns {boolean}
 */
export function isWriteAction(action) {
  const classified = BUILTIN_ACTIONS.get(action);
  return classified !== undefined && classified.category !== CATEGORY.READ;
}

/**
 * List the actions of one category, in declaration order.
 *
 * @param {string} category
 * @returns {string[]}
 */
export function actionsIn(category) {
  return [...BUILTIN_ACTIONS.values()].filter((item) => item.category === category).map((item) => item.action);
}
