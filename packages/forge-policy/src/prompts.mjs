/**
 * 审批卡片的展示文案。
 *
 * 门禁把确认请求交给人时，界面标题只展示一句文案，宿主按界面语言取用。`reason`
 * （英文审计原文）保持不变：它进入 `approval/asked` 事件与错误正文；这里只产出
 * `displayReason`。文案要说清"对哪个仓库做什么""为什么问"，以及"允许一次意味着
 * 什么"——按钮只写"允许一次"，不解释范围放行就会让人以为只放行当前这一次动作。
 */

const LABELS = Object.freeze({
  'gitee.pr.write': { en: 'creating a pull request', zh: '创建 Pull Request' },
  'gitee.issue.write': { en: 'creating an issue', zh: '创建 Issue' },
  'gitee.review.publish': { en: 'publishing a review', zh: '发布评审意见' },
  'change.clarification.write': { en: 'writing a clarification note', zh: '写入变更澄清记录' },
  'gitee.git.push': { en: 'pushing this branch', zh: '推送这个分支' },
});

/** 逐次确认里最常见的流程规则：说清缺什么，用户才知道该补哪里。 */
const PROCESS_LABELS = Object.freeze({
  'pr-acceptance-section': { en: 'the pull request body has no acceptance section', zh: 'PR 描述缺少「验收」小节' },
  'change-in-progress': { en: 'the change is not in progress', zh: '变更没有处于进行中状态' },
  'plan-confirmed': { en: 'the plan is not confirmed yet', zh: '实施计划尚未确认' },
  'push-protected-branch': { en: 'the target is a protected branch', zh: '目标是受保护分支' },
  'push-force': { en: 'the push would rewrite remote history', zh: '推送包含强制改写' },
  'review-ai-source': { en: 'the review does not state how AI was used', zh: '评审没有说明 AI 参与情况' },
});

const SELF = Object.freeze({
  scope: {
    en: 'One approval covers this action on this repository for the rest of the session; another repository, change id, or a restart asks again.',
    zh: '允许一次＝本会话内对该仓库的同类写操作不再逐次询问；换仓库、换变更号或重启后需要重新确认。',
  },
  call: {
    en: 'This approval covers this call only.',
    zh: '这条确认只放行本次调用。',
  },
});

/** Bound a caller-controlled string before it reaches presentation copy. */
function text(value, limit = 80) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** The "what would happen" half of the sentence, per locale. */
function subject({ action, repository, changeId, args = {} }) {
  const label = Object.hasOwn(LABELS, action) ? LABELS[action] : { en: `run ${action}`, zh: `执行 ${action}` };
  const place = text(repository) ?? text(changeId) ?? 'the target repository';
  const head = text(args?.head);
  const base = text(args?.base);
  const route = head !== undefined && base !== undefined ? ` (${head} → ${base})` : '';
  const change = text(changeId, 40);
  return {
    en: `${label.en} on ${place}${route}${change === undefined ? '' : ` (change ${change})`}`,
    zh: `在 ${place} 上${label.zh}${route}${change === undefined ? '' : `（变更 ${change}）`}`,
  };
}

/**
 * Prompt copy for a task-scope confirmation.
 *
 * @param {{action: string, repository?: string, changeId?: string, args?: object}} request
 * @returns {{en: string, zh: string}} presentation copy; `en` is the fallback
 */
export function approvalDisplayReason({ action, repository, changeId, args = {} } = {}) {
  const what = subject({ action, repository, changeId, args });
  return {
    en: `Allow ${what.en}? ${SELF.scope.en}`,
    zh: `允许${what.zh}？${SELF.scope.zh}`,
  };
}

/**
 * Prompt copy for a per-call confirmation (content or process rules asked again).
 *
 * @param {{action: string, repository?: string, changeId?: string, args?: object, rules?: readonly string[]}} request
 * @returns {{en: string, zh: string}} presentation copy; `en` is the fallback
 */
export function confirmationDisplayReason({ action, repository, changeId, args = {}, rules = [] } = {}) {
  const what = subject({ action, repository, changeId, args });
  const known = [...new Set(rules)].filter((rule) => Object.hasOwn(PROCESS_LABELS, rule)).map((rule) => PROCESS_LABELS[rule]);
  const why = {
    en: known.length > 0 ? known.map((item) => item.en).join('; ') : 'a content check needs review',
    zh: known.length > 0 ? known.map((item) => item.zh).join('；') : '正文里有需要人工复核的内容',
  };
  return {
    en: `Allow ${what.en}? This call needs a human decision: ${why.en}. ${SELF.call.en}`,
    zh: `允许${what.zh}？本次调用需要人工确认：${why.zh}。${SELF.call.zh}`,
  };
}
