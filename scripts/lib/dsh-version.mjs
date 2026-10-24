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
/** 行内出现 DSH 名称即视为 DSH 版本出现的强上下文。 */
const DSH_CONTEXT = /(dsh|DSH)/;

/** 由基线版本推出 DSH 发布线（major.minor），据此识别版本字面量而不写死版本。 */
export function dshReleaseLine(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\./);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function dshVersionInLine(version, line, baseline) {
  if (DSH_CONTEXT.test(line)) return true;
  const token = dshReleaseLine(version);
  const base = baseline ? dshReleaseLine(baseline) : null;
  return Boolean(token) && token === base;
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
const DATED_MARKERS = /(编制依据|实测|核验|探针|npm registry|当时|历史|回退|沿用)/;
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
    lines.forEach((line, index) => {
      for (const match of line.matchAll(SEMVER_IN_TEXT)) {
        const spot = canonical.get(rel);
        const isCanonical = Boolean(spot && spot.pattern.test(line));
        if (!isCanonical && !dshVersionInLine(match[0], line, baseline)) continue;
        const kind = isCanonical
          ? 'canonical'
          : DATED_MARKERS.test(line) || HAS_DATE.test(line)
            ? 'dated'
            : 'unclassified';
        found.push({
          file: rel,
          line: index + 1,
          version: match[0],
          kind,
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
        if (!dshVersionInLine(match[0], line, baseline)) continue;
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
