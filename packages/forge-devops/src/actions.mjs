/**
 * 平台动作：四状态、幂等、回读（T5，设计 §5.4 / §7.1 / §7.3，AC-16 / AC-19）。
 *
 * 所有写动作共用**一套**语义，理由只有一个：分散实现必然漂移（一个动作判 `failed`、
 * 另一个判 `unknown`，报告就没法自证）。
 *
 * 四状态（`ACTION_STATUSES`，与流程态 `blocked/skipped/stale` 严格分开，不互相借用）：
 * - `done`    命令成功**且**回读确认一致（含 `reused:true` 的复用命中）；
 * - `failed`  明确没做成，且能确认平台没有新增对象：门禁拒绝、参数/确认缺失、命令未启动、
 *             创建前查重失败（没查清就不创建，所以确定没写出去）；
 * - `denied`  门禁拒绝 / 白名单没有这条命令 / 配置缺失 / 确认缺失——**适配器零调用**；
 * - `unknown` 超时、输出不可解析、回读不一致、回读失败：写入**可能已发生**，
 *             转人工核对，**不自动重放**（AC-16 判据）。
 *
 * 幂等：`sha256(变更号|对象类型|归一化标题)` 取前 16 位；执行前先用 gh 查 open 对象，
 * 命中即复用（`reused:true` + 既有 ref），不重复创建。**不建内存台账**：平台回查即幂等，
 * 内存台账会造第二真源（会话内台账在 `index.mjs`，只用于展示）。
 *
 * 回读：创建/评论成功后**再读一次**并比对（Issue 比标题，PR 另比 head/base，评论比正文哈希）；
 * 不一致记 `unknown/READBACK_MISMATCH`，报告不得写"已创建"。
 *
 * 边界（AC-19）：本模块**没有**合并 PR、关闭 Issue、`change done`、触发 CI 的通道——
 * 适配器层不存在这些命令，这里也不拼参数去凑；澄清回写的 dop 通道恒
 * `denied/COMMAND_NOT_WHITELISTED`，且一次都不访问 dop 适配器。
 */
import { createHash } from 'node:crypto';

import { FLOW_ACTIONS } from './tools.mjs';
import { GUARD_REASONS } from './policy-guard.mjs';
import { isRepoRef, parseTargetRef } from './repo-ref.mjs';

/** 平台动作状态；顺序即文档顺序（`done`/`failed`/`denied`/`unknown`），不含任何流程态。 */
export const ACTION_STATUSES = Object.freeze(['done', 'failed', 'denied', 'unknown']);

/** 幂等键的对象类型词表（同一变更下的不同对象必须落不同的键）。 */
export const OBJECT_TYPES = Object.freeze({
  ISSUE: 'issue',
  PR: 'pr',
  ISSUE_COMMENT: 'issue-comment',
  PR_COMMENT: 'pr-comment',
});

/** 写动作经门禁时要声明的出网范围：门禁据此走确认通道（AC-16「写动作前必须显示目标」）。 */
export const EGRESS_PLATFORM_WRITE = 'platform-write';

/** 动作层原因码（与 `index.mjs` 的 `FLOW_REASONS.COMMAND_NOT_WHITELISTED` 同字面量）。 */
export const ACTION_REASONS = Object.freeze({
  CONFIRMATION_REQUIRED: GUARD_REASONS.CONFIRMATION_REQUIRED,
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  MISSING_TARGET: 'MISSING_TARGET',
  BUILDING_NOT_RESOLVED: 'BUILDING_NOT_RESOLVED',
  COMMAND_NOT_WHITELISTED: 'COMMAND_NOT_WHITELISTED',
  DUPLICATE_CHECK_FAILED: 'DUPLICATE_CHECK_FAILED',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  READBACK_UNAVAILABLE: 'READBACK_UNAVAILABLE',
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  COMMAND_FAILED: 'COMMAND_FAILED',
  INTERNAL: 'INTERNAL',
});

/**
 * 仓库引用与评论目标的语法**不在本模块定义**（r6）：统一走 `repo-ref.mjs` 的
 * `isRepoRef`（2..3 段）与 `parseTargetRef`（尾部 `#n` / `!n`）。
 *
 * 这里曾自己写一份 `REPO_PATTERN`，与 `gh-adapter.mjs` 的那份判词不同（那份锚定首字符，
 * 这份不锚定），且两段上限让三段 `org/group/repo` 在写路径入口就被拦死——表现为
 * "三段仓库根本写不了"，比报错更难查。判据收敛到单点后，本模块只做"别走到子进程"的
 * 前置拦截，`gh-adapter` 的 `assertRepo` / `assertTarget` 仍是权威校验（不是两套判词）。
 */
const REPO_REF_RULE = 'owner/name 或 org/group/repo';

/** 标题归一化时剥掉的尾部标点（"Fix gate." 与 "fix gate" 是同一个对象）。 */
const TRAILING_PUNCTUATION = /[.。,，;；:：!！?？、]+$/u;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

const asArray = (value) => (Array.isArray(value) ? value : []);

const describeError = (error) => text(error?.message) || text(error?.code) || '未知错误';

/**
 * 标题归一化：NFKC → 折叠空白 → 去首尾 → 小写 → 去尾部标点。
 *
 * 归一化只服务于"这是不是同一个对象"，**不改变写出去的文字**——写进平台的仍是原文。
 */
export function normalizeTitle(title) {
  const raw = typeof title === 'string' ? title : '';
  return raw
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

/**
 * 幂等键：`sha256(变更号|对象类型|归一化标题)` 前 16 位十六进制。
 *
 * 变更号统一大写：`CHANGE_ID_PATTERN` 允许大小写混写（`ARD123456` 与 `ard123456` 是同一个
 * 变更），不归一化就会为同一变更建出两个对象。
 */
export function idempotencyKey({ change, objectType, title } = {}) {
  const changeId = text(change).toUpperCase();
  const type = text(objectType);
  const normalized = normalizeTitle(title);
  if (changeId === '') throw new TypeError('幂等键缺少变更号（change）');
  if (type === '') throw new TypeError('幂等键缺少对象类型（objectType）');
  if (normalized === '') throw new TypeError('幂等键缺少可归一化的标题（title）');
  return createHash('sha256').update(`${changeId}|${type}|${normalized}`, 'utf8').digest('hex').slice(0, 16);
}

/** 正文摘要：评论查重与评论幂等键都用它（大小写敏感，`\r\n` 归一成 `\n`）。 */
function bodyDigest(body) {
  const normalized = (typeof body === 'string' ? body : '').normalize('NFKC').replace(/\r\n/gu, '\n').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 动作结果（唯一形状）。
 *
 * `key` 与 `idempotencyKey` 同值：`index.mjs` 的会话台账读 `idempotencyKey`，
 * 报告与测试读 `key`，两个名字指同一个东西，不另存一份。
 */
function actionResult({
  status,
  action,
  target,
  objectRef = null,
  reason = null,
  rule = null,
  reused = false,
  key = null,
  detail = null,
  calls = null,
  readback = null,
}) {
  return {
    status,
    action,
    target,
    objectRef,
    reason,
    rule,
    reused,
    key,
    idempotencyKey: key,
    detail,
    calls,
    readback,
  };
}

/** 输入不成立：门禁都还没问，适配器零调用。 */
function denyInput(action, target, reason, detail, key = null) {
  return actionResult({ status: 'denied', action, target, reason, detail, key, calls: 0 });
}

function assertGuard(guard) {
  if (guard === null || typeof guard !== 'object' || typeof guard.execute !== 'function') {
    throw new TypeError('平台动作必须经门禁执行：缺少 guard.execute（拒绝绕过门禁）');
  }
}

function assertGh(gh, methods) {
  if (gh === null || typeof gh !== 'object') throw new TypeError('平台动作缺少 gh 适配器');
  for (const method of methods) {
    if (typeof gh[method] !== 'function') throw new TypeError(`gh 适配器缺少方法 ${method}`);
  }
}

/**
 * confirm 前置校验（纵深防御）：工具面已经校验过一次，动作层再校验一次。
 *
 * 理由：命令面与流程装配也能走到这里，不能把"模型自填已确认"当成确认。
 * 缺失与不一致都记 `CONFIRMATION_REQUIRED`（与设计 §7 同一原因码），差异写进 `detail`。
 */
function checkConfirm(confirm, { repo, object }, action, target, key) {
  const source = asObject(confirm);
  if (Object.keys(source).length === 0) {
    return denyInput(action, target, ACTION_REASONS.CONFIRMATION_REQUIRED, `缺少 confirm{repo,object}：写动作前必须显示目标仓库与对象`, key);
  }
  const declaredRepo = text(source.repo);
  const declaredObject = text(source.object);
  if (declaredRepo === '' || declaredObject === '') {
    return denyInput(action, target, ACTION_REASONS.CONFIRMATION_REQUIRED, 'confirm 必须同时给出 repo 与 object', key);
  }
  if (declaredRepo !== repo) {
    return denyInput(action, target, ACTION_REASONS.CONFIRMATION_REQUIRED, `confirm.repo=${declaredRepo} 与实际仓库 ${repo} 不一致`, key);
  }
  if (declaredObject !== object) {
    return denyInput(action, target, ACTION_REASONS.CONFIRMATION_REQUIRED, `confirm.object=${declaredObject} 与实际对象 ${object} 不一致`, key);
  }
  return null;
}

/** 承建未判定（0 或多候选）时**阻断全部写**：宁可 denied，也不写到猜出来的仓库里。 */
function blockedByBuilding(building, action, target, key) {
  const source = asObject(building);
  if (source.status !== 'blocked') return null;
  const reasons = asArray(source.reasons)
    .map((item) => (typeof item === 'string' ? text(item) : text(asObject(item).code) || text(asObject(item).detail)))
    .filter((item) => item !== '');
  const candidates = asArray(source.candidates).map((item) => text(asObject(item).repo)).filter((item) => item !== '');
  const parts = [`承建仓库未判定：${reasons.length > 0 ? reasons.join('、') : '候选不唯一'}`];
  if (candidates.length > 0) parts.push(`候选 ${candidates.join(', ')}`);
  return denyInput(action, target, ACTION_REASONS.BUILDING_NOT_RESOLVED, parts.join('；'), key);
}

/** 门禁裁决 → 动作结果（`denied` 零调用；`failed` 带 `mayHaveSideEffect` 时降级为 `unknown`）。 */
function fromGuard(outcome, { action, target, key }) {
  const source = asObject(outcome);
  const guardStatus = text(source.status);
  const sideEffect = source.mayHaveSideEffect === true;
  const status = guardStatus === 'failed' && sideEffect ? 'unknown' : ACTION_STATUSES.includes(guardStatus) ? guardStatus : 'failed';
  return actionResult({
    status,
    action,
    target,
    reason: text(source.reason) || ACTION_REASONS.INTERNAL,
    rule: text(source.rule) || null,
    detail: text(source.detail) || null,
    key,
    calls: status === 'denied' ? 0 : null,
  });
}

/**
 * 经门禁执行：唯一写入口。
 *
 * `operation` 必须自己把适配器错误收敛成四状态结果（它知道 `spawnFailed` 这类细节）；
 * 走到这里的抛错只可能是程序缺陷，一律按 `failed`（有副作用痕迹则 `unknown`）记。
 */
async function runGuarded({ guard, ctx, action, target, arguments: extra = {}, key = null }, operation) {
  const outcome = await guard.execute(
    { ctx, action, target, egress: EGRESS_PLATFORM_WRITE, arguments: extra },
    operation,
  );
  const source = asObject(outcome);
  if (text(source.status) === 'done') {
    const produced = asObject(source.value);
    if (ACTION_STATUSES.includes(produced.status)) return { blocked: false, result: produced };
    return {
      blocked: true,
      result: actionResult({
        status: 'unknown',
        action,
        target,
        reason: ACTION_REASONS.INTERNAL,
        detail: '门禁已放行但下游没有返回可识别的动作状态，无法核对',
        key,
      }),
    };
  }
  return { blocked: true, result: fromGuard(outcome, { action, target, key }) };
}

/** 归一化标题精确比对；空标题永远不算命中（否则会把"没有标题"的对象当成复用对象）。 */
function sameTitle(candidate, expected) {
  const left = normalizeTitle(candidate);
  return left !== '' && left === normalizeTitle(expected);
}

function findOpenIssue(items, title) {
  for (const item of asArray(items)) {
    const entry = asObject(item);
    if (sameTitle(entry.title, title)) return entry;
  }
  return undefined;
}

/** PR 查重：同分支（`headRefName`）或同标题都算同一交付，命中即复用。 */
function findOpenPr(items, { title, head }) {
  for (const item of asArray(items)) {
    const entry = asObject(item);
    const headRef = text(entry.headRefName);
    if (head !== '' && headRef !== '' && headRef === head) return entry;
    if (sameTitle(entry.title, title)) return entry;
  }
  return undefined;
}

/** 评论查重：正文摘要相同即视为同一条评论（重跑不重复刷评论）。 */
function findComment(object, body) {
  const digest = bodyDigest(body);
  for (const item of asArray(asObject(object).comments)) {
    const comment = asObject(item);
    if (bodyDigest(comment.body) === digest) return comment;
  }
  return undefined;
}

/** 对象引用：优先平台链接（人可直接点开），否则 `owner/name#编号` / `org/group/repo#编号`。 */
function objectRefOf(item, repo) {
  const source = asObject(item);
  const url = text(source.url);
  if (url !== '') return url;
  const number = Number.isInteger(source.number) ? source.number : null;
  return number === null ? null : `${repo}#${number}`;
}

/** 回读用的目标：`owner/name#编号` 或 `org/group/repo#编号`（适配器只接受这一形或链接，不接受裸编号）。 */
function qualifiedRef(repo, number, url) {
  if (Number.isInteger(number)) return `${repo}#${number}`;
  return text(url);
}

/**
 * 写命令失败的分类：**只有确定没启动**才记 `failed`，其余一律 `unknown`。
 *
 * `gh` 的写命令即使非零退出也可能已经落地（AC-16「unknown 转人工核对，不自动重放」）；
 * 把"可能写成功"记成"失败"会让人重跑一次，正是重复创建的开始。
 */
function classifyWriteError(error, what) {
  const detail = asObject(error?.detail);
  const code = text(error?.code) || ACTION_REASONS.COMMAND_FAILED;
  const message = describeError(error);
  if (detail.spawnFailed === true) {
    return { status: 'failed', reason: code, detail: `${what}命令未启动（无副作用）：${message}` };
  }
  if (detail.timedOut === true) {
    return { status: 'unknown', reason: ACTION_REASONS.COMMAND_TIMEOUT, detail: `${what}超时，写入可能已发生，转人工核对（不自动重放）：${message}` };
  }
  return { status: 'unknown', reason: code, detail: `${what}结果不确定，转人工核对（不自动重放）：${message}` };
}

/**
 * 评论目标解析：`owner/name#12` / `owner/name!12`（两段），以及 `org/group/repo#12`
 * （三段，企业 Gitee 命名空间）→ `{ repo, ref, number }`。
 *
 * 语法由 `repo-ref.parseTargetRef` 判定：`repo` 是**完整路径**（三段不折成两段），
 * `ref` 是剥掉首尾空白后的原样目标（写回读与门禁核对都用它），`number` 是尾部编号。
 * 链接与裸编号照旧 `null`（链接的形状校验在 `gh-adapter.assertTarget`）。
 */
function parseCommentTarget(target) {
  const parsed = parseTargetRef(target);
  if (parsed === null) return null;
  return { repo: parsed.repo, ref: text(target), number: parsed.number };
}

/**
 * 建 Issue（幂等 + 回读）。
 *
 * 顺序是刻意的：**先查重、再创建、再回读**。查重失败就不创建（不确定有没有重复时，
 * 不创建是唯一安全的选择），所以那条路径是 `failed` 而不是 `unknown`。
 *
 * @param {{ guard: object, gh: object, ctx?: object, changeId: string, repo: string,
 *           title: string, body: string, confirm?: object, building?: object }} input
 */
export async function createIssueIdempotent({
  guard,
  gh,
  ctx,
  changeId,
  repo,
  title,
  body,
  confirm,
  building,
} = {}) {
  const action = FLOW_ACTIONS.ISSUE;
  assertGuard(guard);
  assertGh(gh, ['listOpenIssues', 'createIssue', 'readIssue']);

  const id = text(changeId);
  const repository = text(repo);
  const subject = typeof title === 'string' ? title.trim() : '';
  const content = typeof body === 'string' ? body : '';

  if (id === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）');
  if (!isRepoRef(repository)) {
    return denyInput(action, repository, ACTION_REASONS.MISSING_TARGET, `目标仓库必须是 ${REPO_REF_RULE}，收到 ${repository === '' ? '空值' : repository}`);
  }
  if (normalizeTitle(subject) === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少标题（title）');
  if (content.trim() === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少正文（body），拒绝创建空 Issue');

  const key = idempotencyKey({ change: id, objectType: OBJECT_TYPES.ISSUE, title: subject });
  const blocked = blockedByBuilding(building, action, repository, key);
  if (blocked !== null) return blocked;
  const unconfirmed = checkConfirm(confirm, { repo: repository, object: repository }, action, repository, key);
  if (unconfirmed !== null) return unconfirmed;

  const outcome = await runGuarded({ guard, ctx, action, target: repository, arguments: { repo: repository }, key }, async () => {
    let existing;
    try {
      existing = await gh.listOpenIssues({ repo: repository });
    } catch (error) {
      return actionResult({
        status: 'failed',
        action,
        target: repository,
        reason: ACTION_REASONS.DUPLICATE_CHECK_FAILED,
        detail: `创建前查重失败，未创建（不重放）：${describeError(error)}`,
        key,
        calls: 1,
      });
    }
    const hit = findOpenIssue(existing?.items, subject);
    if (hit !== undefined) {
      return actionResult({
        status: 'done',
        action,
        target: repository,
        objectRef: objectRefOf(hit, repository),
        reused: true,
        key,
        detail: '平台已有同名 open Issue，复用既有对象',
        calls: 1,
        readback: { via: 'issue-list', title: text(hit.title), state: text(hit.state) },
      });
    }

    let created;
    try {
      created = await gh.createIssue({ repo: repository, title: subject, body: content });
    } catch (error) {
      const classified = classifyWriteError(error, '创建 Issue ');
      return actionResult({ status: classified.status, action, target: repository, reason: classified.reason, detail: classified.detail, key, calls: 1 });
    }

    const ref = qualifiedRef(repository, created?.number, created?.url);
    if (ref === '') {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        reason: ACTION_REASONS.MALFORMED_RESULT,
        detail: '创建命令跑完但结果里没有可回读的编号或链接，转人工核对',
        key,
        calls: 1,
      });
    }
    let observed;
    try {
      observed = await gh.readIssue({ target: ref });
    } catch (error) {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        objectRef: ref,
        reason: ACTION_REASONS.READBACK_UNAVAILABLE,
        detail: `创建后回读失败，无法确认，转人工核对：${describeError(error)}`,
        key,
        calls: 2,
        readback: { target: ref, ok: false },
      });
    }
    const object = asObject(observed?.object);
    if (!sameTitle(object.title, subject)) {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        objectRef: objectRefOf(object, repository) ?? ref,
        reason: ACTION_REASONS.READBACK_MISMATCH,
        detail: `回读标题与写入不一致（写入「${subject}」/ 回读「${text(object.title)}」），转人工核对`,
        key,
        calls: 2,
        readback: { target: ref, title: text(object.title), state: text(object.state), ok: false },
      });
    }
    return actionResult({
      status: 'done',
      action,
      target: repository,
      objectRef: objectRefOf(object, repository) ?? ref,
      key,
      calls: 2,
      readback: { target: ref, title: text(object.title), state: text(object.state), ok: true },
    });
  });
  return outcome.result;
}

/**
 * 建 PR（幂等 + 回读）。
 *
 * 与 Issue 同一套语义，差别只有两处：查重多比一个 `head`（同分支即同一交付），
 * 回读多比 `head`/`base`（分支对不上说明写到了别的交付上）。
 */
export async function createPrIdempotent({
  guard,
  gh,
  ctx,
  changeId,
  repo,
  head,
  base,
  title,
  body,
  confirm,
  building,
} = {}) {
  const action = FLOW_ACTIONS.PR;
  assertGuard(guard);
  assertGh(gh, ['listOpenPrs', 'createPr', 'readPr']);

  const id = text(changeId);
  const repository = text(repo);
  const headRef = text(head);
  const baseRef = text(base);
  const subject = typeof title === 'string' ? title.trim() : '';
  const content = typeof body === 'string' ? body : '';

  if (id === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）');
  if (!isRepoRef(repository)) {
    return denyInput(action, repository, ACTION_REASONS.MISSING_TARGET, `目标仓库必须是 ${REPO_REF_RULE}，收到 ${repository === '' ? '空值' : repository}`);
  }
  if (headRef === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少来源分支（head）');
  if (baseRef === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少目标分支（base）');
  if (normalizeTitle(subject) === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少标题（title）');
  if (content.trim() === '') return denyInput(action, repository, ACTION_REASONS.MISSING_ARGUMENT, '缺少正文（body），拒绝创建空 PR');

  const key = idempotencyKey({ change: id, objectType: OBJECT_TYPES.PR, title: subject });
  const blocked = blockedByBuilding(building, action, repository, key);
  if (blocked !== null) return blocked;
  const unconfirmed = checkConfirm(confirm, { repo: repository, object: repository }, action, repository, key);
  if (unconfirmed !== null) return unconfirmed;

  const outcome = await runGuarded({ guard, ctx, action, target: repository, arguments: { repo: repository }, key }, async () => {
    let existing;
    try {
      existing = await gh.listOpenPrs({ repo: repository });
    } catch (error) {
      return actionResult({
        status: 'failed',
        action,
        target: repository,
        reason: ACTION_REASONS.DUPLICATE_CHECK_FAILED,
        detail: `创建前查重失败，未创建（不重放）：${describeError(error)}`,
        key,
        calls: 1,
      });
    }
    const hit = findOpenPr(existing?.items, { title: subject, head: headRef });
    if (hit !== undefined) {
      return actionResult({
        status: 'done',
        action,
        target: repository,
        objectRef: objectRefOf(hit, repository),
        reused: true,
        key,
        detail: '平台已有同分支或同标题的 open PR，复用既有对象',
        calls: 1,
        readback: { via: 'pr-list', title: text(hit.title), head: text(hit.headRefName) },
      });
    }

    let created;
    try {
      created = await gh.createPr({ repo: repository, head: headRef, base: baseRef, title: subject, body: content });
    } catch (error) {
      const classified = classifyWriteError(error, '创建 PR ');
      return actionResult({ status: classified.status, action, target: repository, reason: classified.reason, detail: classified.detail, key, calls: 1 });
    }

    const ref = qualifiedRef(repository, created?.number, created?.url);
    if (ref === '') {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        reason: ACTION_REASONS.MALFORMED_RESULT,
        detail: '创建命令跑完但结果里没有可回读的编号或链接，转人工核对',
        key,
        calls: 1,
      });
    }
    let observed;
    try {
      observed = await gh.readPr({ target: ref });
    } catch (error) {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        objectRef: ref,
        reason: ACTION_REASONS.READBACK_UNAVAILABLE,
        detail: `创建后回读失败，无法确认，转人工核对：${describeError(error)}`,
        key,
        calls: 2,
        readback: { target: ref, ok: false },
      });
    }
    const object = asObject(observed?.object);
    const readHead = text(object.headRefName);
    const readBase = text(object.baseRefName);
    const consistent = sameTitle(object.title, subject) && readHead === headRef && (readBase === '' || readBase === baseRef);
    if (!consistent) {
      return actionResult({
        status: 'unknown',
        action,
        target: repository,
        objectRef: objectRefOf(object, repository) ?? ref,
        reason: ACTION_REASONS.READBACK_MISMATCH,
        detail: `回读与写入不一致（写入「${subject}」${headRef}→${baseRef} / 回读「${text(object.title)}」${readHead || '空'}→${readBase || '空'}），转人工核对`,
        key,
        calls: 2,
        readback: { target: ref, title: text(object.title), head: readHead, base: readBase, ok: false },
      });
    }
    return actionResult({
      status: 'done',
      action,
      target: repository,
      objectRef: objectRefOf(object, repository) ?? ref,
      key,
      calls: 2,
      readback: { target: ref, title: text(object.title), head: readHead, base: readBase, ok: true },
    });
  });
  return outcome.result;
}

/**
 * 在 Issue 上写一条评论（幂等 + 回读）。澄清单走这里（动作 `change.clarification.write`）。
 *
 * 评论查重按**正文摘要**：同一份澄清单重跑不会刷第二条评论；正文变了就是新评论（可见）。
 */
export async function commentIssueIdempotent({ guard, gh, ctx, changeId, target, body, confirm, building } = {}) {
  const action = FLOW_ACTIONS.CLARIFY;
  assertGuard(guard);
  assertGh(gh, ['readIssue', 'commentIssue']);

  const id = text(changeId);
  const parsed = parseCommentTarget(target);
  const content = typeof body === 'string' ? body : '';
  const shown = text(target);

  if (id === '') return denyInput(action, shown, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）');
  if (parsed === null) {
    return denyInput(action, shown, ACTION_REASONS.MISSING_TARGET, `评论目标必须是 owner/name#编号 或 org/group/repo#编号，收到 ${shown === '' ? '空值' : shown}`);
  }
  if (content.trim() === '') return denyInput(action, parsed.ref, ACTION_REASONS.MISSING_ARGUMENT, '缺少评论正文（body）');

  const key = idempotencyKey({ change: id, objectType: OBJECT_TYPES.ISSUE_COMMENT, title: `${parsed.ref} ${bodyDigest(content)}` });
  const blocked = blockedByBuilding(building, action, parsed.ref, key);
  if (blocked !== null) return blocked;
  const unconfirmed = checkConfirm(confirm, { repo: parsed.repo, object: parsed.ref }, action, parsed.ref, key);
  if (unconfirmed !== null) return unconfirmed;

  const outcome = await runGuarded({ guard, ctx, action, target: parsed.ref, arguments: { repo: parsed.repo }, key }, async () => {
    let before;
    try {
      before = await gh.readIssue({ target: parsed.ref });
    } catch (error) {
      return actionResult({
        status: 'failed',
        action,
        target: parsed.ref,
        reason: ACTION_REASONS.DUPLICATE_CHECK_FAILED,
        detail: `写评论前查重失败，未写入（不重放）：${describeError(error)}`,
        key,
        calls: 1,
      });
    }
    const existing = findComment(before?.object, content);
    if (existing !== undefined) {
      return actionResult({
        status: 'done',
        action,
        target: parsed.ref,
        objectRef: text(existing.url) || null,
        reused: true,
        key,
        detail: '平台上已有相同正文的评论，复用既有对象',
        calls: 1,
        readback: { via: 'issue-read', commentId: text(existing.id) || null },
      });
    }

    let posted;
    try {
      posted = await gh.commentIssue({ target: parsed.ref, body: content });
    } catch (error) {
      const classified = classifyWriteError(error, '写 Issue 评论 ');
      return actionResult({ status: classified.status, action, target: parsed.ref, reason: classified.reason, detail: classified.detail, key, calls: 1 });
    }

    let after;
    try {
      after = await gh.readIssue({ target: parsed.ref });
    } catch (error) {
      return actionResult({
        status: 'unknown',
        action,
        target: parsed.ref,
        objectRef: text(posted?.url) || null,
        reason: ACTION_REASONS.READBACK_UNAVAILABLE,
        detail: `评论已提交但回读失败，无法确认，转人工核对：${describeError(error)}`,
        key,
        calls: 2,
        readback: { target: parsed.ref, ok: false },
      });
    }
    const written = findComment(after?.object, content);
    if (written === undefined) {
      return actionResult({
        status: 'unknown',
        action,
        target: parsed.ref,
        objectRef: text(posted?.url) || null,
        reason: ACTION_REASONS.READBACK_MISMATCH,
        detail: '评论命令成功但回读不到该正文，转人工核对（不重放）',
        key,
        calls: 2,
        readback: { target: parsed.ref, ok: false },
      });
    }
    return actionResult({
      status: 'done',
      action,
      target: parsed.ref,
      objectRef: text(written.url) || text(posted?.url) || null,
      key,
      calls: 2,
      readback: { target: parsed.ref, commentId: text(written.id) || null, ok: true },
    });
  });
  return outcome.result;
}

/**
 * 在 PR 上写一条审查评论（幂等 + 回读），动作 `review.ai.publish`。
 *
 * `commit` 必填：评论必须绑到被审查的提交上（AC-18「模型名与 commit 绑定」），
 * 记进回读记录，报告据此判断"这条审查对应哪个 sha"。
 */
export async function commentPrIdempotent({ guard, gh, ctx, changeId, target, commit, body, confirm, building } = {}) {
  const action = FLOW_ACTIONS.PR_COMMENT;
  assertGuard(guard);
  assertGh(gh, ['readPr', 'commentPr']);

  const id = text(changeId);
  const parsed = parseCommentTarget(target);
  const sha = text(commit);
  const content = typeof body === 'string' ? body : '';
  const shown = text(target);

  if (id === '') return denyInput(action, shown, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）');
  if (parsed === null) {
    return denyInput(action, shown, ACTION_REASONS.MISSING_TARGET, `评论目标必须是 owner/name#编号 或 org/group/repo#编号，收到 ${shown === '' ? '空值' : shown}`);
  }
  if (sha === '') return denyInput(action, parsed.ref, ACTION_REASONS.MISSING_ARGUMENT, '缺少被审查的提交 sha（commit），审查评论必须绑定提交');
  if (content.trim() === '') return denyInput(action, parsed.ref, ACTION_REASONS.MISSING_ARGUMENT, '缺少评论正文（body）');

  const key = idempotencyKey({ change: id, objectType: OBJECT_TYPES.PR_COMMENT, title: `${parsed.ref} ${bodyDigest(content)}` });
  const blocked = blockedByBuilding(building, action, parsed.ref, key);
  if (blocked !== null) return blocked;
  const unconfirmed = checkConfirm(confirm, { repo: parsed.repo, object: parsed.ref }, action, parsed.ref, key);
  if (unconfirmed !== null) return unconfirmed;

  const outcome = await runGuarded({ guard, ctx, action, target: parsed.ref, arguments: { repo: parsed.repo, commit: sha }, key }, async () => {
    let before;
    try {
      before = await gh.readPr({ target: parsed.ref });
    } catch (error) {
      return actionResult({
        status: 'failed',
        action,
        target: parsed.ref,
        reason: ACTION_REASONS.DUPLICATE_CHECK_FAILED,
        detail: `写审查评论前查重失败，未写入（不重放）：${describeError(error)}`,
        key,
        calls: 1,
      });
    }
    const existing = findComment(before?.object, content);
    if (existing !== undefined) {
      return actionResult({
        status: 'done',
        action,
        target: parsed.ref,
        objectRef: text(existing.url) || null,
        reused: true,
        key,
        detail: '平台上已有相同正文的审查评论，复用既有对象',
        calls: 1,
        readback: { via: 'pr-read', commit: sha, commentId: text(existing.id) || null },
      });
    }

    let posted;
    try {
      posted = await gh.commentPr({ target: parsed.ref, body: content });
    } catch (error) {
      const classified = classifyWriteError(error, '写 PR 审查评论 ');
      return actionResult({ status: classified.status, action, target: parsed.ref, reason: classified.reason, detail: classified.detail, key, calls: 1 });
    }

    let after;
    try {
      after = await gh.readPr({ target: parsed.ref });
    } catch (error) {
      return actionResult({
        status: 'unknown',
        action,
        target: parsed.ref,
        objectRef: text(posted?.url) || null,
        reason: ACTION_REASONS.READBACK_UNAVAILABLE,
        detail: `审查评论已提交但回读失败，无法确认，转人工核对：${describeError(error)}`,
        key,
        calls: 2,
        readback: { target: parsed.ref, commit: sha, ok: false },
      });
    }
    const written = findComment(after?.object, content);
    if (written === undefined) {
      return actionResult({
        status: 'unknown',
        action,
        target: parsed.ref,
        objectRef: text(posted?.url) || null,
        reason: ACTION_REASONS.READBACK_MISMATCH,
        detail: '审查评论命令成功但回读不到该正文，转人工核对（不重放）',
        key,
        calls: 2,
        readback: { target: parsed.ref, commit: sha, ok: false },
      });
    }
    return actionResult({
      status: 'done',
      action,
      target: parsed.ref,
      objectRef: text(written.url) || text(posted?.url) || null,
      key,
      calls: 2,
      readback: { target: parsed.ref, commit: sha, commentId: text(written.id) || null, ok: true },
    });
  });
  return outcome.result;
}

/**
 * 澄清回写：把澄清单写到平台上（设计 §7.5）。
 *
 * 两个通道的结局是**结构性的**，不是配置出来的：
 * - `dop`：命令面只有 create/list/view/done，**没有澄清写命令**，所以恒
 *   `denied/COMMAND_NOT_WHITELISTED` 且零调用。`dop` 参数只为显式记录"我们手里有这个适配器
 *   但它没有写通道"，本函数**从不读它**（测试用会抛错的 Proxy 传入即可证明零访问）。
 * - `issue`：必须过门禁 + `confirm{repo,object}` + 回读，否则 `denied`/`unknown`。
 *
 * `targets` 每项可以是字符串（`'dop'` / `'issue'`）或对象
 * `{ channel: 'issue', target: 'owner/name#12', confirm?: {repo,object} }`（三段
 * `'org/group/repo#12'` 同形，`confirm.repo` 必须是完整路径）；
 * 裸 `'issue'` 的目标取 `sheet.issueTarget`，确认取 `sheet.confirm`。
 *
 * 正文**原样写出**，不改写：不合规就拒绝（与提交信息"违规拒绝不改写"同一原则）。
 */
export async function writeClarification(options = {}) {
  const { guard, gh, sheet, targets, ctx } = asObject(options);
  const action = FLOW_ACTIONS.CLARIFY;
  const source = asObject(sheet);
  const changeId = text(source.changeId);
  const body = typeof source.body === 'string' ? source.body : '';
  const revisionId = text(source.revisionId);
  const channels = asArray(targets);

  const reject = (reason, detail) => ({ statuses: [denyInput(action, changeId, reason, detail)] });

  if (channels.length === 0) return reject(ACTION_REASONS.MISSING_ARGUMENT, '没有指定澄清回写通道（targets）');
  if (changeId === '') return reject(ACTION_REASONS.MISSING_ARGUMENT, '澄清单缺少变更号（changeId）');
  if (body.trim() === '') return reject(ACTION_REASONS.MISSING_ARGUMENT, '澄清单缺少正文（body），拒绝写空评论');
  if (revisionId === '') return reject(ACTION_REASONS.MISSING_ARGUMENT, '澄清单缺少修订标识（revisionId），写出去无法与计划/报告对齐');
  if (!body.includes(revisionId)) {
    return reject(ACTION_REASONS.MISSING_ARGUMENT, `澄清评论正文必须包含修订标识 ${revisionId}（本函数不改写正文，请先在正文里写上）`);
  }

  const statuses = [];
  for (const entry of channels) {
    const item = typeof entry === 'string' ? { channel: entry } : asObject(entry);
    const channel = text(item.channel);
    if (channel === 'dop') {
      statuses.push(
        denyInput(
          action,
          changeId,
          ACTION_REASONS.COMMAND_NOT_WHITELISTED,
          'dop 命令面只有 create/list/view/done，没有澄清写命令；拒绝把它改写为其它命令',
          null,
        ),
      );
      continue;
    }
    if (channel === 'issue') {
      const issueTarget = text(item.target) || text(source.issueTarget);
      if (issueTarget === '') {
        statuses.push(denyInput(action, changeId, ACTION_REASONS.MISSING_TARGET, 'issue 通道没有给出目标对象（target 或 sheet.issueTarget）'));
        continue;
      }
      statuses.push(
        await commentIssueIdempotent({
          guard,
          gh,
          ctx,
          changeId,
          target: issueTarget,
          body,
          confirm: item.confirm ?? source.confirm,
          building: source.building,
        }),
      );
      continue;
    }
    statuses.push(
      denyInput(action, changeId, ACTION_REASONS.COMMAND_NOT_WHITELISTED, `通道 ${channel === '' ? '（空）' : channel} 不在白名单内：只有 issue 可写，dop 无写命令`),
    );
  }
  return { statuses };
}
