/**
 * `@heluo/forge-devops` 的唯一落盘出口（T7 / AC-20 / AC-23）。
 *
 * 三条纪律都收在这一个文件里，别的模块不得再实现一遍：
 * 1. **路径唯一且不越界**：`<目标仓库根>/.dsh-devops/<变更号>/<kind>.md`。变更号只允许
 *    `[A-Za-z0-9_-]`，kind 只允许枚举值，落盘前再验一次"解析后仍在仓库根内"——
 *    `..`、绝对路径、带分隔符的变更号一律拒绝，不落盘。
 * 2. **front matter 定长定序**：`change` / `kind` / `generatedAt` / `sourceType` /
 *    `sourceRevision` / `commit`，六项缺一即不合格产物；值里出现换行直接拒绝，
 *    否则正文可以伪造头部字段。
 * 3. **写入可核对**：返回 `{ path, bytes, header }`；报告生成时读回同一份文件核对，
 *    而不是相信内存里的对象（AC-23 证据纪律）。
 *
 * 变更号格式的判定也放在这里：入口解析与落盘路径必须同源，否则会出现"命令收得下、
 * 文件写不出"的分叉。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 产物种类；与设计 §4.4 一一对应，顺序即报告引用顺序。 */
export const ARTIFACT_KINDS = Object.freeze(['context', 'clarify', 'plan', 'review', 'report']);

/** front matter 字段的固定顺序（定长，不接受增删改序）。 */
export const FRONT_MATTER_FIELDS = Object.freeze([
  'change',
  'kind',
  'generatedAt',
  'sourceType',
  'sourceRevision',
  'commit',
]);

/** 来源类型：mock 与真实企业实测分记（AC-23），不设第三档。 */
export const SOURCE_TYPES = Object.freeze(['mock', 'enterprise']);

/** 变更号：字母或数字开头，其后允许 `[A-Za-z0-9_-]`，总长 2–64；不按前缀推断语义。 */
export const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/** 落盘与格式校验的拒绝原因。 */
export const ARTIFACT_REASONS = Object.freeze({
  INVALID_ROOT: 'ARTIFACT_INVALID_ROOT',
  INVALID_CHANGE_ID: 'ARTIFACT_INVALID_CHANGE_ID',
  INVALID_KIND: 'ARTIFACT_INVALID_KIND',
  PATH_ESCAPE: 'ARTIFACT_PATH_ESCAPE',
  MISSING_FIELD: 'ARTIFACT_MISSING_FIELD',
  INVALID_VALUE: 'ARTIFACT_INVALID_VALUE',
  MISSING_META: 'ARTIFACT_MISSING_META',
  MISSING_BODY: 'ARTIFACT_MISSING_BODY',
});

export class ArtifactError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'ArtifactError';
    this.code = code;
    this.detail = detail;
  }
}

/** 路径逃逸的最小实现（AGENTS.md 禁止跨包导入 forge-policy 的源码路径）。 */
function assertInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactError(
      ARTIFACT_REASONS.PATH_ESCAPE,
      `产物路径越出目标仓库根：${candidate}`,
      { root, candidate },
    );
  }
  return candidate;
}

/** 变更号校验（入口与落盘共用同一规则）；返回去空白后的值。 */
export function assertChangeId(changeId) {
  const value = typeof changeId === 'string' ? changeId.trim() : '';
  if (!CHANGE_ID_PATTERN.test(value)) {
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_CHANGE_ID,
      `变更号不合法：「${String(changeId ?? '')}」`,
      { changeId: String(changeId ?? '') },
    );
  }
  return value;
}

/** 产物 kind 校验。 */
export function assertArtifactKind(kind) {
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_KIND,
      `产物种类不合法：「${String(kind ?? '')}」，只接受 ${ARTIFACT_KINDS.join('/')}`,
      { kind: String(kind ?? '') },
    );
  }
  return kind;
}

/**
 * 产物绝对路径。repoRoot 只用于定位，不做目录创建（写入时才 `mkdir -p`）。
 *
 * @param {{ repoRoot?: string, changeId?: string, kind?: string }} input
 * @returns {string}
 */
export function artifactPath({ repoRoot, changeId, kind } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new ArtifactError(ARTIFACT_REASONS.INVALID_ROOT, '缺少目标仓库根（repoRoot）');
  }
  const id = assertChangeId(changeId);
  const artifactKind = assertArtifactKind(kind);
  const root = path.resolve(repoRoot);
  const directory = path.resolve(root, '.dsh-devops', id);
  const target = path.resolve(directory, `${artifactKind}.md`);
  assertInsideRoot(root, directory);
  assertInsideRoot(root, target);
  return target;
}

/** 头部值不许带换行/回车：否则正文能伪造 front matter 字段。 */
function singleLine(name, value, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return 'null';
    throw new ArtifactError(ARTIFACT_REASONS.MISSING_FIELD, `front matter 缺字段 ${name}`, { field: name });
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ArtifactError(
      ARTIFACT_REASONS.MISSING_FIELD,
      `front matter 字段 ${name} 必须是非空字符串`,
      { field: name },
    );
  }
  if (/[\r\n]/u.test(value)) {
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_VALUE,
      `front matter 字段 ${name} 不得包含换行`,
      { field: name },
    );
  }
  return value.trim();
}

/**
 * 渲染定长 front matter（六个字段、固定顺序、以 `---` 收尾）。
 *
 * @param {{ changeId?: string, kind?: string, generatedAt?: string, sourceType?: string,
 *   sourceRevision?: string, commit?: string|null }} input
 * @returns {string}
 */
export function renderFrontMatter({
  changeId,
  kind,
  generatedAt,
  sourceType,
  sourceRevision,
  commit = null,
} = {}) {
  const id = assertChangeId(changeId);
  const artifactKind = assertArtifactKind(kind);
  const at = singleLine('generatedAt', generatedAt);
  if (Number.isNaN(Date.parse(at))) {
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_VALUE,
      `generatedAt 不是可解析的时间：${at}`,
      { field: 'generatedAt' },
    );
  }
  const type = singleLine('sourceType', sourceType);
  if (!SOURCE_TYPES.includes(type)) {
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_VALUE,
      `sourceType 只接受 ${SOURCE_TYPES.join('/')}：${type}`,
      { field: 'sourceType' },
    );
  }
  const revision = singleLine('sourceRevision', sourceRevision);
  const sha = singleLine('commit', commit, { nullable: true });
  const lines = [
    '---',
    `change: ${id}`,
    `kind: ${artifactKind}`,
    `generatedAt: ${at}`,
    `sourceType: ${type}`,
    `sourceRevision: ${revision}`,
    `commit: ${sha}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/** 不同 kind 的附加证据要求：缺一项即拒写，避免"报告没有证据也算产物"。 */
function assertMetaFor(kind, meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ArtifactError(ARTIFACT_REASONS.MISSING_META, `产物 ${kind} 缺少 meta`);
  }
  if (kind === 'review') {
    if (typeof meta.commit !== 'string' || meta.commit.trim().length === 0) {
      throw new ArtifactError(ARTIFACT_REASONS.MISSING_META, 'review 产物必须绑定 commit');
    }
    if (typeof meta.model !== 'string' || meta.model.trim().length === 0) {
      throw new ArtifactError(ARTIFACT_REASONS.MISSING_META, 'review 产物必须记录实际模型名');
    }
  }
  if (kind === 'report' && (!Array.isArray(meta.evidence) || meta.evidence.length === 0)) {
    throw new ArtifactError(ARTIFACT_REASONS.MISSING_META, 'report 产物必须带证据数组');
  }
}

/**
 * 写一份产物：路径校验 → 头部渲染 → `mkdir -p` → 临时文件改名（不留半截文件）。
 *
 * @param {{ repoRoot?: string, changeId?: string, kind?: string, body?: string, meta?: object }} input
 * @returns {{ path: string, bytes: number, header: string, changeId: string, kind: string }}
 */
export function writeArtifact({ repoRoot, changeId, kind, body, meta = {} } = {}) {
  const target = artifactPath({ repoRoot, changeId, kind });
  const artifactKind = assertArtifactKind(kind);
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new ArtifactError(ARTIFACT_REASONS.MISSING_BODY, `产物 ${artifactKind} 正文为空`);
  }
  assertMetaFor(artifactKind, meta);
  const header = renderFrontMatter({
    changeId,
    kind: artifactKind,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    sourceType: meta.sourceType,
    sourceRevision: meta.sourceRevision,
    commit: meta.commit ?? null,
  });
  const content = `${header}\n${body.endsWith('\n') ? body : `${body}\n`}`;
  const temporary = `${target}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(
      ARTIFACT_REASONS.INVALID_VALUE,
      `产物写入失败：${String(error?.message ?? error)}`,
      { path: target },
    );
  }
  return {
    path: target,
    bytes: Buffer.byteLength(content, 'utf8'),
    header,
    changeId: assertChangeId(changeId),
    kind: artifactKind,
  };
}
