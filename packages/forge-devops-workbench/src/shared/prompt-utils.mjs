/**
 * 工程提示词公共文本清洗、UTF-8 字节安全裁剪与澄清规范常量。
 */
import { Buffer } from 'node:buffer';

export const MAX_ONE_SENTENCE_CHARS = 2000;
export const MAX_DOC_INJECT_BYTES = 16 * 1024;
export const NODATA_HTML_RE = /^\s*<p\s+class=["']nodata["']\s*>\s*<\/p>\s*$/iu;

export const ASK_USER_QUESTION_GUIDE = [
  '【澄清交互规范（重要）】',
  '当你发现业务规则、范围边界、异常兜底、安全与合规口径或故事拆分颗粒度存在缺口需要我确认时，',
  '必须优先调用内置工具 ask_user_question 发起结构化提问（每轮 2–4 个关键问题，提供清晰的 options 单选/多选项与推荐项），',
  '让我直接在对话框中点选；待我提交选择后再输出最终澄清结论或拆分方案。严禁自行编造缺失业务口径，严禁只发纯文本长问卷。',
].join('');

/**
 * 清洗上游 HTML 片段为可读纯文本，精准识别 `<p class="nodata"></p>` 占位。
 *
 * @param {unknown} rawHtml
 * @returns {{ text: string, isEmptyPlaceholder: boolean }}
 */
export function stripHtmlToText(rawHtml) {
  if (rawHtml === null || rawHtml === undefined) {
    return { text: '', isEmptyPlaceholder: true };
  }
  const str = String(rawHtml).trim();
  if (str === '' || NODATA_HTML_RE.test(str)) {
    return { text: '', isEmptyPlaceholder: true };
  }

  const normalized = str
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  if (normalized === '') {
    return { text: '', isEmptyPlaceholder: true };
  }
  return { text: normalized, isEmptyPlaceholder: false };
}

/**
 * 按 UTF-8 字节上限安全截断文本，绝不切半多字节字符。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean, byteLength: number }}
 */
export function truncateUtf8Bytes(text, maxBytes) {
  const source = String(text ?? '');
  const buf = Buffer.from(source, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: source, truncated: false, byteLength: buf.length };
  }
  if (maxBytes <= 0) {
    return { text: '', truncated: true, byteLength: 0 };
  }
  let end = maxBytes;
  // UTF-8 续字节特征为 10xxxxxx (0x80-0xBF)，向左回退至完整字符起止边界
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const sliced = buf.subarray(0, end).toString('utf8');
  return { text: sliced, truncated: true, byteLength: Buffer.byteLength(sliced, 'utf8') };
}

/**
 * 格式化人员对象为可读文本。
 *
 * @param {unknown} person
 * @returns {string}
 */
export function formatPerson(person) {
  if (!person || typeof person !== 'object') return '未指定';
  const name = String(person.name ?? '').trim();
  const code = String(person.loginCode ?? '').trim();
  if (!name && !code) return '未指定';
  return code && name ? `${name}（${code}）` : (name || code);
}
