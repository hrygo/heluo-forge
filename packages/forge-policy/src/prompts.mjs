/**
 * 确认卡片的展示文案。
 *
 * 门禁把确认请求交给人时，界面标题只展示一句文案，宿主按界面语言取用。`reason`
 * （英文审计原文）保持不变：它进入确认事件与错误正文；这里只产出
 * `displayReason`。文案要说清"对哪个仓库做什么""为什么问"，以及"确认只放行
 * 这次调用"——按钮只写"允许一次"，不解释范围就会让人误以为放行了后续同类动作。
 */

/**
 * 动作名由 `action` 与 `args.op` 共同决定：同一个写动作既能建对象也能追加评论，
 * 只说"创建"会让批准评论的人看到错误的操作。
 */
const LABELS = Object.freeze({
  'gitee.pr.write': {
    create: { en: 'creating a pull request', zh: '创建 Pull Request' },
    comment: { en: 'commenting on a Pull Request', zh: '追加 PR 评论' },
  },
  'gitee.issue.write': {
    create: { en: 'creating an issue', zh: '创建 Issue' },
    comment: { en: 'commenting on an Issue', zh: '追加 Issue 评论' },
  },
  'gitee.review.publish': {
    create: { en: 'publishing a review', zh: '发布评审意见' },
  },
  'change.clarification.write': {
    create: { en: 'writing a clarification note', zh: '写入变更澄清记录' },
  },
  'gitee.git.push': {
    create: { en: 'pushing this branch', zh: '推送这个分支' },
  },
});

/** 流程规则里最常见的几条：说清缺什么，用户才知道该补哪里（规则本身在 P2 接入判定）。 */
const PROCESS_LABELS = Object.freeze({
  'pr-acceptance-section': { en: 'the pull request body has no acceptance section', zh: 'PR 描述缺少「验收」小节' },
  'change-in-progress': { en: 'the change is not in progress', zh: '变更没有处于进行中状态' },
  'plan-confirmed': { en: 'the plan is not confirmed yet', zh: '实施计划尚未确认' },
  'push-protected-branch': { en: 'the target is a protected branch', zh: '目标是受保护分支' },
  'push-force': { en: 'the push would rewrite remote history', zh: '推送包含强制改写' },
  'review-ai-source': { en: 'the review does not state how AI was used', zh: '评审没有说明 AI 参与情况' },
});

/** 内容闸跳过的正文：字段与原因的展示名。 */
const FIELD_LABELS = Object.freeze({
  body: { en: 'body', zh: '正文' },
  title: { en: 'title', zh: '标题' },
  command: { en: 'command', zh: '命令' },
});

const SKIP_LABELS = Object.freeze({
  'binary-skipped': { en: 'binary content was not scanned', zh: '二进制内容未扫描' },
  truncated: { en: 'only the beginning was scanned', zh: '内容过长，只扫描了开头' },
});

const SELF = Object.freeze({
  call: {
    en: 'This confirmation covers this call only.',
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

function labelFor(action, op) {
  const byAction = Object.hasOwn(LABELS, action) ? LABELS[action] : undefined;
  if (byAction === undefined) return { en: `running ${action}`, zh: `执行 ${action}` };
  return byAction[op] ?? byAction.create ?? Object.values(byAction)[0];
}

/** The "what would happen" half of the sentence, per locale. */
function subject({ action, repository, changeId, args = {} }) {
  const label = labelFor(action, text(args?.op));
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

/** 未完整扫描的正文：把字段与原因说清楚，不把"扫不全"藏成泛泛的复核提示。 */
function unscanned(skipped, locale) {
  return skipped.map(({ field, reason }) => {
    const name = FIELD_LABELS[field] ?? { en: field, zh: field };
    const why = SKIP_LABELS[reason] ?? { en: reason, zh: reason };
    return `${name[locale]}：${why[locale]}`;
  }).join('；');
}

/**
 * Prompt copy for a per-call confirmation (content or process rules asked again).
 *
 * @param {{action: string, repository?: string, changeId?: string, args?: object,
 *   rules?: readonly string[], skipped?: readonly {field: string, reason: string}[]}} request
 * @returns {{en: string, zh: string}} presentation copy; `en` is the fallback
 */
export function confirmationDisplayReason({ action, repository, changeId, args = {}, rules = [], skipped = [] } = {}) {
  const what = subject({ action, repository, changeId, args });
  const known = [...new Set(rules)].filter((rule) => Object.hasOwn(PROCESS_LABELS, rule)).map((rule) => PROCESS_LABELS[rule]);
  const pending = { en: unscanned(skipped, 'en'), zh: unscanned(skipped, 'zh') };
  const why = {
    en: [known.length > 0 ? known.map((item) => item.en).join('; ') : 'a content check needs review',
      ...(pending.en === '' ? [] : [`content was not fully scanned (${pending.en})`])].join('; '),
    zh: [known.length > 0 ? known.map((item) => item.zh).join('；') : '正文里有需要人工复核的内容',
      ...(pending.zh === '' ? [] : [`有内容未完整扫描（${pending.zh}）`])].join('；'),
  };
  return {
    en: `Allow ${what.en}? This call needs a human decision: ${why.en}. ${SELF.call.en}`,
    zh: `允许${what.zh}？本次调用需要人工确认：${why.zh}。${SELF.call.zh}`,
  };
}
