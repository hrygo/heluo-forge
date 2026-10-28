/**
 * Issue → PR 闭环判定（只读）。
 *
 * 依据：docs/design/plugins/forge-gitee.md §13 与 forge-devops-lifecycle.md §2.1——
 * 系统变更明确绑定仓库；Issue 与变更关联；相关提交以 `[变更号]` 开头；
 * 验收有有效证据且交付 PR 已合入后才能关闭 Issue；不自动合并。
 *
 * 本模块只做三件事，且都不产生远端效果：
 * 1. `assessIssueClosure()`：按四项可核对事实给出 closable / not-closable / unknown；
 * 2. `buildWriteSteps()`：把"若获批准要做什么"写成固定 argv 的计划（默认不执行）；
 * 3. `renderLoopHtml()`：离线自包含报告。
 *
 * 边界：验收证据只能由人/平台提供，模型不得自填；CLI 未返回提交列表时
 * 记 `unknown`，不把"看不到"当成"没有前缀"或"已合规"。
 */

export const LOOP_CHECKS = Object.freeze({
  CHANGE_LINKED: 'change-linked',
  PR_MERGED: 'pr-merged',
  COMMIT_PREFIX: 'commit-prefixed',
  ACCEPTANCE_EVIDENCE: 'acceptance-evidence',
});

export const LOOP_REASONS = Object.freeze({
  CHANGE_LINK_MISSING: 'issue does not reference the change id',
  PR_NOT_MERGED: 'no merged closing pull request',
  COMMITS_NOT_RETURNED: 'closing pull request commits were not returned',
  COMMIT_PREFIX_MISSING: 'a commit headline does not start with the change id',
  ACCEPTANCE_MISSING: 'no human/platform acceptance evidence was supplied',
  CROSS_REPOSITORY: 'closing reference points outside the bound repository',
});

const CHANGE_ID = /^[A-Z]{2,6}\d+$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;

/** `[变更号]` 前缀，允许其后跟空白或直接结束；不接受同类前缀的其它编号。 */
export function commitPrefixPattern(changeId) {
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) throw new Error('BAD_CHANGE_ID');
  return new RegExp(`^\\[${changeId}\\]`, 'u');
}

/** 与 rehearsal 相同的关联写法：单独一行 `DOP change: ID`。 */
export function issueReferencesChange(changeId, body) {
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) return false;
  if (typeof body !== 'string') return false;
  return new RegExp(`(?:^|\\n)[ \\-]*DOP change:[ \\t]*${changeId}(?=\\s|$)`, 'u').test(body);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 只采信"合并已完成"：state 为 MERGED 且 mergedAt 是可解析时间。 */
export function isMerged(pr) {
  return isRecord(pr) && pr.state === 'MERGED'
    && typeof pr.mergedAt === 'string' && !Number.isNaN(Date.parse(pr.mergedAt));
}

/**
 * @param {object} input
 * @param {string} input.changeId  显式变更号
 * @param {object} input.issue     issue.read 的 facts
 * @param {object[]} input.pullRequests pr.read 的 facts（关闭引用）
 * @param {object|null} input.acceptance 人工/平台验收记录 {verified,by,at,evidence}
 * @param {string} input.repositoryUrl 绑定的仓库 URL（用于跨仓拒绝）
 */
export function assessIssueClosure({ changeId, issue, pullRequests = [], acceptance = null, repositoryUrl = null, observedAt = new Date().toISOString() } = {}) {
  const prefix = commitPrefixPattern(changeId);
  const merged = pullRequests.filter(isMerged);
  const checks = [];

  checks.push({
    id: LOOP_CHECKS.CHANGE_LINKED,
    ok: issueReferencesChange(changeId, issue?.body),
    detail: issueReferencesChange(changeId, issue?.body) ? 'issue body references the change id' : LOOP_REASONS.CHANGE_LINK_MISSING,
  });

  const crossRepo = repositoryUrl
    ? pullRequests.some((pr) => typeof pr?.url !== 'string' || !pr.url.toLowerCase().startsWith(`${repositoryUrl.replace(/\/$/u, '')}/pull/`.toLowerCase()))
    : false;
  checks.push({
    id: 'same-repository',
    ok: !crossRepo,
    detail: crossRepo ? LOOP_REASONS.CROSS_REPOSITORY : 'closing references stay inside the bound repository',
  });
  checks.push({
    id: LOOP_CHECKS.PR_MERGED,
    ok: merged.length > 0,
    detail: merged.length > 0 ? `${merged.length} merged closing pull request(s)` : LOOP_REASONS.PR_NOT_MERGED,
  });

  // 提交前缀：所有合入 PR 都必须返回提交列表，且每个标题都以 `[变更号]` 开头。
  const missingCommits = merged.filter((pr) => !Array.isArray(pr.commits));
  const offending = merged.flatMap((pr) => (Array.isArray(pr.commits) ? pr.commits : []))
    .filter((commit) => typeof commit?.messageHeadline !== 'string' || !prefix.test(commit.messageHeadline));
  const commitOk = merged.length > 0 && missingCommits.length === 0 && offending.length === 0;
  checks.push({
    id: LOOP_CHECKS.COMMIT_PREFIX,
    ok: commitOk,
    detail: commitOk
      ? 'every returned commit headline starts with the change id'
      : missingCommits.length > 0 ? LOOP_REASONS.COMMITS_NOT_RETURNED : LOOP_REASONS.COMMIT_PREFIX_MISSING,
    ...(offending.length > 0 ? { offendingHeadlines: offending.slice(0, 10).map((c) => String(c?.messageHeadline ?? '').slice(0, 120)) } : {}),
  });

  const acceptanceOk = isRecord(acceptance) && acceptance.verified === true
    && typeof acceptance.by === 'string' && acceptance.by.length > 0
    && typeof acceptance.at === 'string' && !Number.isNaN(Date.parse(acceptance.at));
  checks.push({
    id: LOOP_CHECKS.ACCEPTANCE_EVIDENCE,
    ok: acceptanceOk,
    detail: acceptanceOk ? `acceptance recorded by ${acceptance.by}` : LOOP_REASONS.ACCEPTANCE_MISSING,
  });

  const blockers = checks.filter((check) => !check.ok).map((check) => check.id);
  return Object.freeze({
    changeId,
    repository: repositoryUrl,
    issue: issue ? { number: issue.number, state: issue.state, url: issue.url } : null,
    mergedPullRequests: merged.map((pr) => ({
      number: pr.number, url: pr.url, headRefOid: pr.headRefOid ?? null, mergedAt: pr.mergedAt,
      commits: Array.isArray(pr.commits) ? pr.commits.map((c) => ({ oid: c.oid ?? null, messageHeadline: c.messageHeadline })) : null,
    })),
    checks,
    // 只有四项全部有证据才判可关闭；任何一项缺证据都不是"可关闭"。
    closable: blockers.length === 0,
    state: blockers.length === 0 ? 'closable' : 'not-closable',
    blockers,
    observedAt,
  });
}

/**
 * 计划（不执行）。写动作按设计仍属"待批"：本函数只产出固定 argv 与正文模板，
 * 供获批后在指定仓库执行；调用方不得把它当授权。
 */
export function buildWriteSteps({ changeId, repository, issueTitle, issueBody, branch, baseBranch = 'main', files = [], prTitle, prBody } = {}) {
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) throw new Error('BAD_CHANGE_ID');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)) throw new Error('BAD_REPOSITORY');
  const write = (name, argv, note) => ({ name, argv, note, mode: 'write', executed: false, approval: 'required' });
  return Object.freeze({
    changeId,
    repository,
    mode: 'plan-only',
    executed: false,
    note: '写动作需范围、服务端权限与 C3 分类批准；本计划未执行，也不代表已获批准。',
    steps: Object.freeze([
      write('create-issue', ['issue', 'create', '--repo', repository, '--title', issueTitle ?? `[${changeId}] 待定标题`, '--body', issueBody ?? `- DOP change: ${changeId}`], '正文必须包含 `DOP change: <变更号>` 关联行'),
      write('create-branch', ['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/heads/${branch ?? `feat/${changeId.toLowerCase()}`}`, '-f', `sha=${baseBranch}`], '分支名固定携带变更号'),
      write('commit', ['commit', '-m', `[${changeId}] <message>`, ...files], '提交标题必须以 `[变更号]` 开头'),
      write('push', ['push', 'origin', branch ?? `feat/${changeId.toLowerCase()}`], '推送目标仓库须与绑定仓库一致'),
      write('open-pr', ['pr', 'create', '--repo', repository, '--base', baseBranch, '--head', branch ?? `feat/${changeId.toLowerCase()}`, '--title', prTitle ?? `[${changeId}] <title>`, '--body', prBody ?? `Closes #<issue>`], 'PR 正文含关闭引用；合并需人工批准，不自动合并'),
    ]),
  });
}

const escape = (value) => String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderLoopHtml(assessment, plan = null) {
  const rows = assessment.checks.map((check) => `<tr><td><code>${escape(check.id)}</code></td><td class="${check.ok ? 'ok' : 'bad'}">${check.ok ? '已满足' : '未满足'}</td><td>${escape(check.detail)}</td></tr>`).join('');
  const prs = assessment.mergedPullRequests.map((pr) => `<li>${escape(pr.url)} · <code>${escape(pr.headRefOid ?? '')}</code> · ${escape(pr.mergedAt)}<ul>${(pr.commits ?? []).map((c) => `<li><code>${escape(c.oid ?? '')}</code> ${escape(c.messageHeadline)}</li>`).join('') || '<li>提交列表未返回</li>'}</ul></li>`).join('') || '<li>无已合入的关闭 PR</li>';
  const planHtml = plan ? `<section><h2>写动作计划（未执行）</h2><p class="note">${escape(plan.note)}</p><ol>${plan.steps.map((step) => `<li><code>${escape(step.name)}</code>：<code>${escape(step.argv.join(' '))}</code><br><small>${escape(step.note)}</small></li>`).join('')}</ol></section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>河洛 · Issue → PR 闭环判定</title><style>body{margin:0;background:#f4f6fa;color:#182a40;font:16px/1.75 system-ui,sans-serif}main{max-width:980px;margin:40px auto;padding:0 24px}h1{font-size:30px}section{background:#fff;border:1px solid #dbe2ec;border-radius:14px;padding:24px;margin:20px 0}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #e6ebf3;padding:10px;vertical-align:top}.ok{color:#1a7f5a}.bad{color:#b3261e}.verdict{font-size:22px;font-weight:600}.note{border-left:4px solid #cea240;padding-left:14px;color:#5d563e}code{font-size:12px;overflow-wrap:anywhere}</style></head><body><main><h1>${escape(assessment.changeId)} · Issue → PR 闭环判定</h1><section><p class="verdict ${assessment.closable ? 'ok' : 'bad'}">${assessment.closable ? '可关闭（证据齐全）' : '不可关闭（证据未齐）'}</p><p>绑定仓库：${escape(assessment.repository ?? '未提供')}；Issue：${assessment.issue ? `<a href="${escape(assessment.issue.url)}">#${assessment.issue.number}</a> ${escape(assessment.issue.state)}` : '未提供'}；观察时间：${escape(assessment.observedAt)}</p><table>${rows}</table><p class="note">关闭条件按设计 §13：验收有有效证据且交付 PR 已合入。本判定只读，不代表已执行关闭，也不代替人工验收。</p></section><section><h2>已合入的关闭 PR 与提交</h2><ul>${prs}</ul></section>${planHtml}</main></body></html>`;
}
