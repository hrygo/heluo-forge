/**
 * 提交信息前缀校验（AC-17，设计 §7.6）。
 *
 * 只做"提交前拦下"：不合规就返回 `{ok:false}` 与期望格式，**不改写** message——
 * 自动补前缀会把"人写错了"变成"工具替人做主"，也会让历史无法回溯真实意图。
 *
 * 规则：首行必须以 `[<本变更号>]` 开头，其后至少一个空白，再接非空描述；
 * 方括号里写别的变更号同样拒绝（避免把改动记到另一个需求名下）。正文多行不校验，
 * 但只认首行——git 的 subject 就是首行。
 *
 * `assertCommitMessage({changeId})` 是唯一入口，`change` 是 TECHNICAL §7.6 的旧写法别名，
 * 两个名字都收、不另立第二套判断。变更号格式本身由 `entry.mjs#parseChangeId` 负责，
 * 这里不复制那条规则（否则两处格式会分叉）。
 *
 * 纯函数：不读 git、不读时钟。
 */

/** 提交信息校验的拒绝原因。 */
export const COMMIT_REASONS = Object.freeze({
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  MISSING_MESSAGE: 'MISSING_MESSAGE',
  PREFIX_MISSING: 'PREFIX_MISSING',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** 期望格式：给人看的同一句话，测试与提示共用（不各写一份）。 */
export function expectedCommitFormat(changeId) {
  return `[${text(changeId) || '<变更号>'}] 一句话说明`;
}

/**
 * 校验提交信息首行是否以本变更号为前缀。
 *
 * @param {{ changeId?: string, change?: string, message?: string }} input
 * @returns {{ ok: true, changeId: string, expectedFormat: string, subject: string }
 *   | { ok: false, reason: string, expectedFormat: string, detail?: string }}
 */
export function assertCommitMessage({ changeId, change, message } = {}) {
  const id = text(changeId) || text(change);
  const expectedFormat = expectedCommitFormat(id);
  if (id === '') {
    return { ok: false, reason: COMMIT_REASONS.MISSING_CHANGE_ID, expectedFormat };
  }
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, reason: COMMIT_REASONS.MISSING_MESSAGE, expectedFormat, detail: `提交信息为空（${typeof message === 'string' ? '仅空白' : typeof message}）` };
  }

  // 只剥掉首部空行：带空行开头的提交信息仍按"首行无前缀"拒绝，不替调用方整理格式。
  const lines = message.replace(/^(?:[ \t]*\r?\n)+/u, '').split(/\r?\n/u);
  const subject = lines[0].trimEnd();
  const match = /^\[([^\]]*)\]([ \t\u3000]+)(\S[\s\S]*)$/u.exec(subject);

  if (match === null) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `首行必须以 ${expectedFormat.split(' ')[0]} 开头，其后接空格与非空描述；当前首行：${subject === '' ? '（空）' : subject}`,
    };
  }
  // 方括号内容逐字比较（不 trim）：`[ ARD123456 ]` 这类空白错误要显出来，
  // 否则前缀看着对、抄进日志却对不上变更号。
  const found = match[1];
  if (found.toUpperCase() !== id.toUpperCase()) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `方括号内是本变更号之外的值：${found === '' ? '（空）' : found}`,
    };
  }

  return { ok: true, changeId: id, expectedFormat, subject: text(match[3]) };
}
