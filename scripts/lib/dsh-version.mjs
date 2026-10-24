/**
 * DSH 版本的单一真源与出现位置审计。
 *
 * 约定：当前目标/基线版本只写在仓库根的 `.dsh-version`。文档里的"当前基线"位置由
 * 本模块的 CANONICAL_SPOTS 精确声明，批量改版只动这些位置；带日期或标注为实测/编制
 * 依据的历史记录一律不动，避免把历史改写成现在。代码与脚本不得硬编码版本号，只有
 * 清单元数据（`engines.dsh`）与版本比较类夹具例外。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DSH_VERSION_FILE = '.dsh-version';

/** 版本形状（允许 `-rc.N` 一类预发布后缀）；只约束形状，不写具体版本。 */
export const DSH_VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * 版本形状匹配。排除 IPv4（后接 `.数字`）与章节编号（前接 `§`），避免把
 * `127.0.0.1`、`§5.1.1` 当成版本。
 */
const SEMVER_IN_TEXT = /(?<![\d.§])v?\d+\.\d+\.\d+(?:-rc\.\d+)?(?![\d.])/g;
/**
 * 行内出现 DSH 名称（作为独立词）或 `engines.dsh`/`dshVersion` 一类键，才算 DSH 版本上下文。
 * 特意排除 `CORP-DSH-*`、`@heluo/...` 这类标识符里的字母组合，避免把文档编号与文档版本
 * 误判成 DSH 版本。
 */
const DSH_WORD = /(?:^|[^A-Za-z0-9_@/-])dsh(?![A-Za-z0-9_/-])/gi;
/** 键名类上下文（`engines.dsh`、`dshVersion`）与紧邻的版本才算 DSH 上下文。 */
const DSH_KEY = /engines\.dsh|dshVersion|dsh_version/i;
/** 版本与 DSH 名称的距离上限：超过就认为是同一行里无关的两件事（例如标题提到 DSH、末列是文档版本）。 */
const DSH_NEAR = 24;

/** 行/上下文中是否出现 DSH 名称或键（不要求邻近，用于判断"这一块在讲 DSH"）。 */
export function mentionsDsh(text) {
  DSH_WORD.lastIndex = 0;
  return DSH_KEY.test(text) || DSH_WORD.test(text);
}

/** 文档清单的登记行：末列是文档版本，不是 DSH 版本，按结构排除。 */
const REGISTER_ROW = /^\| CORP-DSH-/;

/**
 * 文档里是否算 DSH 版本出现：声明位置 / 示例 / 邻近 / 或"本行或所在证据块在讲 DSH"。
 * 最后一条覆盖表格行（表头才提 DSH）与长句（版本离名称很远）的情况。
 */
export function isDocVersionCandidate({ token, line, contextText, baseline, isCanonical, examples }) {
  if (isCanonical || examples) return true;
  if (hasDshContext(line, token)) return true;
  if (REGISTER_ROW.test(line)) return false;
  if (dshReleaseLine(token) !== dshReleaseLine(baseline)) return false;
  const blob = `${line}\n${contextText}`;
  if (mentionsDsh(blob)) return true;
  return HAS_DATE.test(blob) && DATED_MARKERS.test(blob);
}

export function hasDshContext(line, token) {
  if (DSH_KEY.test(line)) return true;
  const at = line.indexOf(token);
  if (at < 0) return false;
  for (const match of line.matchAll(DSH_WORD)) {
    if (Math.abs(match.index - at) <= DSH_NEAR) return true;
  }
  return false;
}

/** 正文里**有意**出现的示例版本（格式说明），既不随基线变，也不算待确认。 */
export const DOC_EXAMPLES = [
  { file: 'docs/design/services/market-index.md', pattern: /engines/, note: 'engines 语法示例' },
  {
    file: 'docs/design/plugins/forge-market.md',
    pattern: /parseEngines/,
    note: '解析规则示例（说明 -rc.N 与基础版本的比较）',
  },
];

/** 由基线版本推出 DSH 发布线（major.minor），据此识别版本字面量而不写死版本。 */
export function dshReleaseLine(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\./);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function dshVersionInLine(version, line, baseline, { allowReleaseLine = false } = {}) {
  if (hasDshContext(line, version)) return true;
  if (!allowReleaseLine) return false;
  const token = dshReleaseLine(version);
  const base = baseline ? dshReleaseLine(baseline) : null;
  return Boolean(token) && token === base;
}

/** 正文里的分类：基线位置 / 历史记录 / 示例 / 待确认。 */
export function classifyDocLine({ line, sectionText, isCanonical, examples }) {
  if (isCanonical) return { kind: 'canonical', reason: 'declared-spot' };
  if (examples) return { kind: 'example', reason: examples.note };
  if (DATED_MARKERS.test(line) || HAS_DATE.test(line)) return { kind: 'dated', reason: 'line' };
  if (sectionText && (DATED_MARKERS.test(sectionText) || HAS_DATE.test(sectionText))) {
    return { kind: 'dated', reason: 'section' };
  }
  return { kind: 'unclassified', reason: 'needs-human' };
}

/** 必须与 `.dsh-version` 一致的正文位置；改版只命中这些。 */
export const CANONICAL_SPOTS = [
  {
    file: 'docs/requirements/requirements-baseline.md',
    label: 'AS-4 锁版本',
    pattern: /锁版本\s*`(\d+\.\d+\.\d+(?:-rc\.\d+)?)`/,
  },
  {
    file: 'docs/architecture/platform-architecture.md',
    label: '一期兼容目标',
    pattern: /一期兼容目标固定 DSH\s*`(\d+\.\d+\.\d+(?:-rc\.\d+)?)`/,
  },
];

/** 允许出现版本字面量的代码位置。 */
export const CODE_ALLOWED = [
  /^packages\/[^/]+\/package\.json$/, // engines.dsh 由宿主读取，必须是字面量
  /^packages\/[^/]+\/test\//, // 版本比较与兼容性的合成夹具
  /^tests\//,
  /^services\/[^/]+\/test\//,
  /^scripts\/lib\/dsh-version\.mjs$/,
];

/** 文档里"历史记录"的判据：编制依据/实测/探针口径，或行内带日期。 */
const DATED_MARKERS = /(编制依据|实测|核验|复核|探针|npm registry|当时|历史)/;
const HAS_DATE = /20\d\d-\d\d-\d\d/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

export function readDshVersion(root = process.cwd()) {
  const raw = readFileSync(join(root, DSH_VERSION_FILE), 'utf8').trim();
  if (!DSH_VERSION_SHAPE.test(raw)) {
    throw new Error(`${DSH_VERSION_FILE} 不是合法版本号：${JSON.stringify(raw)}`);
  }
  return raw;
}

function walk(dir, filter, root, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, filter, root, out);
    else if (filter(relative(root, abs).split(sep).join('/'))) out.push(abs);
  }
  return out;
}

function readLines(abs) {
  try {
    return readFileSync(abs, 'utf8').split('\n');
  } catch {
    return null;
  }
}

/** 文档中出现版本号的所有位置，按行给出分类。 */
export function listDocOccurrences(root = process.cwd(), baseline = readDshVersion(root)) {
  const files = walk(join(root, 'docs'), (rel) => rel.endsWith('.md'), root);
  const canonical = new Map(CANONICAL_SPOTS.map((spot) => [spot.file, spot]));
  const found = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/');
    const lines = readLines(abs);
    if (!lines) continue;
    let sectionText = '';
    lines.forEach((line, index) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      // 仓库常用「**……实测（日期）**」这类加粗段落当小节标题，一并作为上下文。
      const bold = line.match(/^\*\*[^*]{4,400}\*\*/);
      if (heading) sectionText = heading[1];
      else if (bold) sectionText = bold[0];
      for (const match of line.matchAll(SEMVER_IN_TEXT)) {
        const spot = canonical.get(rel);
        const isCanonical = Boolean(spot && spot.pattern.test(line));
        const examples = DOC_EXAMPLES.find((item) => item.file === rel && item.pattern.test(line));
        if (!isDocVersionCandidate({ token: match[0], line, contextText: sectionText, baseline, isCanonical, examples })) continue;
        const { kind, reason } = classifyDocLine({ line, sectionText, isCanonical, examples });
        found.push({
          file: rel,
          line: index + 1,
          version: match[0],
          kind,
          reason,
          text: line.trim().slice(0, 160),
        });
      }
    });
  }
  return found;
}

/** 代码与脚本中出现版本号的位置，按允许清单给出分类。 */
export function listCodeOccurrences(root = process.cwd(), baseline = readDshVersion(root)) {
  const targets = [
    ...walk(join(root, 'scripts'), (rel) => rel.endsWith('.mjs'), root),
    ...walk(join(root, 'tests'), (rel) => rel.endsWith('.mjs'), root),
    ...walk(join(root, 'packages'), (rel) => rel.endsWith('.mjs') || rel.endsWith('.json'), root),
    ...walk(join(root, 'services'), (rel) => rel.endsWith('.mjs') || rel.endsWith('.json'), root),
  ];
  const found = [];
  for (const abs of [...new Set(targets)]) {
    const rel = relative(root, abs).split(sep).join('/');
    const allowed = CODE_ALLOWED.some((re) => re.test(rel));
    const lines = readLines(abs);
    if (!lines) continue;
    lines.forEach((line, index) => {
      for (const match of line.matchAll(SEMVER_IN_TEXT)) {
        if (!dshVersionInLine(match[0], line, baseline, { allowReleaseLine: true })) continue;
        found.push({
          file: rel,
          line: index + 1,
          version: match[0],
          kind: allowed ? 'code-allowed' : 'code-forbidden',
          text: line.trim().slice(0, 160),
        });
      }
    });
  }
  return found;
}

/**
 * 有意与基线不同的下限（必须写明原因）：`apply --engines` 不会覆盖这些包。
 * 市场包按基础版本表达下限——预发布 `-rc.N` 在比较上小于基础版本，若写 `>=x.y.z-rc.N`
 * 会让运行在基础版本上的宿主被判为不兼容。
 */
export const ENGINE_FLOOR_EXCEPTIONS = {
  'packages/forge-market/package.json':
    '按基础版本表达下限（-rc.N 小于基础版本），避免基础版本宿主被自判不兼容；见市场设计。',
};

/** 清单里的 `engines.dsh` 下限；改版时可选择一并提升（例外包除外）。 */
export function listEngineFloors(root = process.cwd()) {
  const files = walk(join(root, 'packages'), (rel) => rel.endsWith('/package.json'), root);
  const floors = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    const match = text.match(/"dsh"\s*:\s*"[^"]*?(\d+\.\d+\.\d+(?:-rc\.\d+)?)"/);
    if (match) {
      floors.push({
        file: rel,
        floor: match[1],
        exception: Boolean(ENGINE_FLOOR_EXCEPTIONS[rel]),
        reason: ENGINE_FLOOR_EXCEPTIONS[rel] ?? null,
      });
    }
  }
  return floors;
}

/** 把正文里的版本替换为目标版本；只替换 canonical 命中处。 */
export function rewriteCanonical(text, file, target) {
  const spot = CANONICAL_SPOTS.find((item) => item.file === file);
  if (!spot) return { text, replaced: 0, from: null };
  const re = new RegExp(spot.pattern.source, spot.pattern.flags.includes('g') ? spot.pattern.flags : `${spot.pattern.flags}g`);
  let replaced = 0;
  let from = null;
  const next = text.replace(re, (full, current) => {
    if (current === target) return full;
    replaced += 1;
    from ??= current;
    return full.replace(current, target);
  });
  return { text: next, replaced, from };
}

/** 提升清单里的 `engines.dsh` 下限。 */
export function rewriteEngineFloors(text, target) {
  let replaced = 0;
  const next = text.replace(/("dsh"\s*:\s*"[^"]*?)(\d+\.\d+\.\d+(?:-rc\.\d+)?)(")/g, (full, head, current, tail) => {
    if (current === target) return full;
    replaced += 1;
    return head + target + tail;
  });
  return { text: next, replaced };
}
