/**
 * 提交信息 `[变更号]` 校验的**唯一实现**（r10 §3.5 / AC-18）。
 *
 * 为什么单独成模块：r10 之前这段规则有两份——`@heluo/forge-devops` 的 `commit-message.mjs`
 * （三个原因码、返回 `{ok:false}`、src 零调用）与 `gitee-delivery.mjs`（五个原因码、抛错）。
 * 两份都会随平台演进各自漂移。r10 把超集搬到这里，devops 删旧件、`gitee-delivery` 反向
 * re-export，于是「全局一份」= 删掉一份，而不是再加第三份。既有 `delivery.test.mjs` 从
 * `gitee-delivery` 取这些符号，re-export 让它们零改动继续成立。
 *
 * 纯模块：不读时钟、不读网络、不碰文件系统，只把输入映射为判定结果；因此 `git push` 与
 * 本地 `git commit` 可以共用同一套规则，而判定体本身保持可重放。
 *
 * 合规定义（只看首行，**不改写** message）：
 *   `[<本变更号>]<空白><非空描述>`
 * 方括号内必须与 changeId 逐字一致（比较时忽略大小写，但空白错位同样拒绝），方括号后必须
 * 至少一个空白字符，描述不能为空。只认首行——git 的 subject 就是首行，正文多行不校验。
 */

import { CHANGE_ID_PATTERN } from './gitee-review.mjs';

/** 拒绝原因码：取值与 r9 逐字一致（日志、门禁与调用方都按这些字符串判定）。 */
export const COMMIT_REASONS = Object.freeze({
  MISSING_CHANGE_ID: 'COMMIT_MISSING_CHANGE_ID',
  INVALID_CHANGE_ID: 'COMMIT_INVALID_CHANGE_ID',
  MISSING_MESSAGE: 'COMMIT_MISSING_MESSAGE',
  PREFIX_MISSING: 'COMMIT_PREFIX_MISSING',
  DESCRIPTION_MISSING: 'COMMIT_DESCRIPTION_MISSING',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** 证据文字：单行、限长（拒绝原因会进工具返回体，不把整段输入原样回显）。 */
function evidenceText(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/**
 * 提交信息不合规：`code` 即拒绝原因，`expectedFormat` 是给人照着改的那句话。
 *
 * 做成**异常**（而不是只返回 `{ok:false}`）是因为调用方用 `try/catch` 判「这次提交不许放行」——
 * 返回对象会被当成通过，门禁静默失效；同时把 `ok/reason/expectedFormat/detail` 挂在异常上，
 * 需要对象形态的调用方直接读字段即可。
 */
export class CommitMessageError extends Error {
  constructor({ reason, expectedFormat, detail } = {}) {
    super(`${reason}: ${detail}`);
    this.name = 'CommitMessageError';
    this.code = reason;
    this.reason = reason;
    this.expectedFormat = expectedFormat;
    this.detail = { expectedFormat };
    this.ok = false;
  }
}

/** 期望格式：给人看的同一句话，异常、工具提示与测试共用（不各写一份）。 */
export function expectedCommitFormat(changeId) {
  return `[${text(changeId) || '<变更号>'}] 一句话说明`;
}

/**
 * 校验提交信息首行是否以**本变更号**为前缀。
 *
 * @param {{ changeId?: string, change?: string, message?: string }} input
 * @returns {{ ok: true, changeId: string, expectedFormat: string, subject: string }}
 * @throws {CommitMessageError} 不合规：`code` = 拒绝原因，`expectedFormat` = 期望格式
 */
export function assertCommitMessage(input = {}) {
  const result = evaluateCommitMessage(input);
  if (!result.ok) throw new CommitMessageError(result);
  return result;
}

/**
 * `assertCommitMessage` 的不抛错形态：结论与抛错形态**同源**（同一个判定函数），
 * 不会出现一处放过一处拦住。
 *
 * @param {{ changeId?: string, change?: string, message?: string }} input
 * @returns {{ ok: true, changeId: string, expectedFormat: string, subject: string }
 *   | { ok: false, reason: string, expectedFormat: string, detail: string }}
 */
export function verifyCommitMessage(input = {}) {
  return evaluateCommitMessage(input);
}

/** 判定本体（不抛错的内部形态）：每个拒绝理由都带期望格式。 */
function evaluateCommitMessage({ changeId, change, message } = {}) {
  const id = text(changeId) || text(change);
  const expectedFormat = expectedCommitFormat(id);
  if (id === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.MISSING_CHANGE_ID,
      expectedFormat,
      detail: '没有变更号：无法确认这条提交属于哪个需求，拒绝（并给不出期望格式里的具体号）',
    };
  }
  if (!CHANGE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: COMMIT_REASONS.INVALID_CHANGE_ID,
      expectedFormat,
      detail: `变更号「${id}」不是合法格式（字母或数字开头，只含字母/数字/下划线/连字符，2–64 位）`,
    };
  }
  if (typeof message !== 'string' || message.trim() === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.MISSING_MESSAGE,
      expectedFormat,
      detail: `提交信息为空（${typeof message === 'string' ? '仅空白' : typeof message}）`,
    };
  }

  // 只剥掉首部空行：带空行开头的提交信息仍按「首行无前缀」拒绝，不替调用方整理格式。
  const subject = message.replace(/^(?:[ \t]*\r?\n)+/u, '').split(/\r?\n/u)[0].trimEnd();
  const matched = /^\[([^\]]*)\]([ \t\u3000]*)([\s\S]*)$/u.exec(subject);
  if (matched === null) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `首行必须以 \`[${id}]\` 开头，当前首行：${subject === '' ? '（空）' : evidenceText(subject)}`,
    };
  }
  const found = matched[1];
  // 方括号内容逐字比较（不 trim）：`[ CHG-2026-0042 ]` 这类空白错误要显出来，否则前缀看着对、
  // 抄进日志却对不上变更号。
  if (found === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `首行的方括号是空的：必须写本变更号 ${id}`,
    };
  }
  if (found.toUpperCase() !== id.toUpperCase()) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `方括号内是本变更号之外的值：${evidenceText(found)}（应为 ${id}）`,
    };
  }
  if (matched[2] === '' || matched[3].trim() === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.DESCRIPTION_MISSING,
      expectedFormat,
      detail: `前缀后必须接空格与非空描述，当前首行：${evidenceText(subject)}`,
    };
  }
  return { ok: true, changeId: id, expectedFormat, subject: evidenceText(matched[3]) };
}
