import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repeatable } from './launch-url.mjs';

/**
 * What the shell tells about a failure, in the two places a person can read:
 * the status page, which gets the installer's code, its account of why and of
 * what to do, and the log under the application data, which keeps the whole
 * account. A failure code alone does not say which of several causes stopped the
 * first run: the same page used to read the same for all of them.
 *
 * What the web profile printed is the log's alone: the page gets the code, the
 * guidance and the log's path.
 */

/** The log of the first run, relative to the application's user data directory. */
export const DIAGNOSTIC_LOG_PARTS = ['logs', 'first-run.log'];

/** The status page is loaded through its address: each value is one line of bounded length. */
export const REASON_LIMIT = 600;
export const REMEDY_LIMIT = 400;

/** What one stream of the web profile adds to the log: its last lines, each of bounded length, together of bounded size. */
const OUTPUT_LINES = 60;
const OUTPUT_BYTES = 8 * 1024;
const OUTPUT_LINE = 600;
const OUTPUT_CUT = '…（更早的输出已省略）';

const BLANKS = /\s+/gu;

/** One line of text: line breaks and runs of blanks folded, nothing else changed. */
const oneLine = (text) => String(text ?? '').replace(BLANKS, ' ').trim();

/** `text` on one line, cut to `limit` characters; an ellipsis marks that it was longer. */
export function clipped(text, limit) {
  const value = oneLine(text);
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** Only the strings of a list: whatever else an outcome carried is not repeated. */
const strings = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === 'string') : []);

const stamp = (at) => (at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : String(at));

const section = (title, items) => (items.length === 0 ? '' : [`${title}：`, ...items.map((item) => `  ${item}`)].join('\n'));

/**
 * The installer's verdict as the shell repeats it: the code it stopped with,
 * its own account of why and of what to do about it, and what it printed.
 * What it did not say stays empty; nothing is guessed in its place.
 *
 * @param {{code?: string, reason?: string, next?: string, lines?: string[], warnings?: string[]}} [details]
 *   What the shell's error about the first run carries.
 */
export function installerVerdict(details) {
  return {
    code: typeof details?.code === 'string' && details.code !== '' ? details.code : 'UNKNOWN',
    reason: oneLine(details?.reason),
    remedy: oneLine(details?.next),
    lines: strings(details?.lines),
    warnings: strings(details?.warnings),
  };
}

/** A first run that completed: the installer's conclusion and what it printed. */
export function firstRunDone({ at, outcome }) {
  const status = typeof outcome?.result?.status === 'string' ? outcome.result.status : 'UNKNOWN';
  return [
    `=== ${stamp(at)} 企业配置初始化：完成 ===`,
    `安装器结论：${status}（退出码 ${typeof outcome?.code === 'number' ? outcome.code : 'UNKNOWN'}）`,
    section('回显', strings(outcome?.lines)),
    section('警告', strings(outcome?.warnings)),
  ].filter(Boolean).join('\n');
}

/**
 * A first run that stopped. With the installer's verdict the entry is that
 * verdict, whole; without one (the employee package was refused before the
 * installer ran) it is what the shell itself knows.
 *
 * @param {{at: Date, code: string, verdict?: object, error?: object}} input
 */
export function firstRunStopped({ at, code, verdict, error }) {
  const own = verdict === undefined || verdict === null;
  if (own) {
    return [
      `=== ${stamp(at)} 企业配置初始化：失败 ===`,
      `错误码：${code}`,
      oneLine(error?.message) === '' ? '' : `说明：${oneLine(error?.message)}`,
      section('问题', strings(error?.details?.problems)),
    ].filter(Boolean).join('\n');
  }
  return [
    `=== ${stamp(at)} 企业配置初始化：失败 ===`,
    `错误码：${code}（安装器 ${verdict.code}）`,
    `原因：${verdict.reason === '' ? '（安装器未给出）' : verdict.reason}`,
    `处理：${verdict.remedy === '' ? '（安装器未给出）' : verdict.remedy}`,
    section('回显', verdict.lines),
    section('警告', verdict.warnings),
  ].filter(Boolean).join('\n');
}

/**
 * The end of what one stream printed, as lines of the log. Each line is cut
 * to its length and blank lines are not kept; the last of them stay within
 * the bytes of a stream, and always at least the final line. A first line
 * says when something was left out. The log is the one gate for what the web
 * profile printed: an address loses its query here again, whatever handed the
 * text over.
 */
function outputSection(title, text) {
  const lines = repeatable(text).split('\n').map((line) => clipped(line, OUTPUT_LINE)).filter((line) => line !== '');
  if (lines.length === 0) return '';
  let first = Math.max(0, lines.length - OUTPUT_LINES);
  while (first < lines.length - 1 && Buffer.byteLength(lines.slice(first).join('\n')) > OUTPUT_BYTES) first += 1;
  return section(title, first > 0 ? [OUTPUT_CUT, ...lines.slice(first)] : lines);
}

/**
 * A failure of the web profile's process is also told by how the process
 * ended and by what it printed: the record carries both from the runtime's
 * snapshot (`service`). A process not seen to end has no line about how it
 * ended; a stream that printed nothing has no section.
 *
 * @param {{at: Date, code: string, message?: string, service?: object}} input
 */
export function failureRecord({ at, code, message, service }) {
  const ended = service?.exit ?? null;
  return [
    `=== ${stamp(at)} 应用未能启动 ===`,
    `错误码：${code}`,
    `说明：${oneLine(message)}`,
    ...(ended === null ? [] : [Number.isInteger(ended.code) ? `退出码：${ended.code}` : `退出信号：${ended.signal ?? 'unknown'}`]),
    outputSection('本机服务标准错误（尾部）', service?.output?.stderr),
    outputSection('本机服务标准输出（尾部）', service?.output?.stdout),
  ].filter(Boolean).join('\n');
}

/**
 * What the status page is given. For a failed first run that is the
 * installer's code, why it stopped and what to do about it; where the
 * installer said nothing about what to do, the shell's guidance for the code
 * stands in. Empty values are left out, and none is longer than its limit.
 *
 * @param {{state: string, code?: string, verdict?: object|null, fallback?: string, log?: string}} input
 */
export function statusQuery({ state, code, verdict, fallback, log }) {
  const query = { state };
  if (code !== undefined) query.code = code;
  if (verdict !== undefined && verdict !== null) {
    query.installer = verdict.code;
    if (verdict.reason !== '') query.reason = clipped(verdict.reason, REASON_LIMIT);
  }
  // The installer's own words are kept whole where they exist; the shell's guidance is a stand-in.
  const remedy = verdict?.remedy || fallback;
  if (typeof remedy === 'string' && remedy !== '') query.remedy = clipped(remedy, REMEDY_LIMIT);
  if (typeof log === 'string' && log !== '') query.log = log;
  return query;
}

/**
 * Add one entry to the log: the file is created on first use and readable by
 * its owner only. A log that cannot be written is not a reason to stop the
 * application, so the outcome is returned and nothing is thrown.
 *
 * @returns {boolean} whether the entry was written
 */
export function appendDiagnostic(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${text}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The log's location under the application's user data directory. */
export function diagnosticLogPath(userData) {
  return join(userData, ...DIAGNOSTIC_LOG_PARTS);
}
