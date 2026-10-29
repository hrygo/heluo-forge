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
const SEMVER_IN_TEXT = /(?<![\d.§])v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?![\d.])/g;
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
  {
    file: 'docs/design/services/market-index.md',
    pattern: /目标 `engines\.dsh`，形如|`engines\.dsh` 只接受/,
    note: 'engines 语法示例',
  },
  {
    file: 'docs/design/plugins/forge-market.md',
    pattern: /`parseEngines` 只认/,
    note: 'engines 解析规则示例（说明 -rc.N 与基础版本的比较）',
  },
];

/** 由基线版本推出 DSH 发布线（major.minor），据此识别版本字面量而不写死版本。 */
export function dshReleaseLine(version) {
  const match = String(version).replace(/^v/i, '').match(/^(\d+)\.(\d+)\./);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function dshVersionInLine(version, line, baseline, { allowReleaseLine = false } = {}) {
  if (hasDshContext(line, version)) return true;
  if (!allowReleaseLine) return false;
  const token = dshReleaseLine(version);
  const base = baseline ? dshReleaseLine(baseline) : null;
  return Boolean(token) && token === base;
}

/** 声明位置在文本里的**全部**命中：版本、行号，以及该行是否属于带日期的历史记录。 */
export function spotMatches(text, spot) {
  const re = new RegExp(
    spot.pattern.source,
    spot.pattern.flags.includes('g') ? spot.pattern.flags : `${spot.pattern.flags}g`,
  );
  const lines = text.split('\n');
  const out = [];
  for (const match of text.matchAll(re)) {
    const lineIndex = (text.slice(0, match.index).match(/\n/g) ?? []).length;
    const line = lines[lineIndex] ?? '';
    // "历史命中"只看版本**紧邻处**的措辞：整行提到"历史节奏"或"已实测"不改变这句就是当前声明的事实。
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    const quoted = /^\s*>/.test(line);
    out.push({
      version: match[1],
      line: lineIndex + 1,
      dated: HISTORICAL_BEFORE.test(before) || (quoted && (DATED_MARKERS.test(line) || HAS_DATE.test(line))),
    });
  }
  return out;
}

/** 紧邻版本之前的"这是旧记录"措辞；`>` 引用块里的带日期记录也算。 */
const HISTORICAL_BEFORE = /(曾|当时|此前|原本|旧|历史|过去)[^，。；]{0,6}$/;

/** 版本比较（预发布小于同号正式版）；无法解析返回 NaN。 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value).replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/);
    return match ? { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 「目标 DSH 与 SDK」是设计模板里的目标声明行：目标由单一真源给出，行内版本只能是带判据的证据。 */
const TARGET_ROW = /^\|\s*目标 DSH 与 SDK\s*\|/;
const EVIDENCE_NEAR = /(核验|实测|依据|当时|复核)/;

/** 目标声明行不得写死目标版本（核验/实测版本可另注日期保留）。 */
export function checkTargetDeclarations(root = process.cwd()) {
  const problems = [];
  for (const abs of walk(join(root, 'docs'), (rel) => rel.endsWith('.md'), root)) {
    const rel = relative(root, abs).split(sep).join('/');
    const lines = readLines(abs) ?? [];
    lines.forEach((line, index) => {
      if (!TARGET_ROW.test(line)) return;
      for (const match of line.matchAll(SEMVER_IN_TEXT)) {
        const before = line.slice(Math.max(0, match.index - 24), match.index);
        if (EVIDENCE_NEAR.test(before)) continue;
        problems.push(
          `${rel}:${index + 1}：「目标 DSH 与 SDK」写死目标版本 ${match[0]}，应指向仓库根 ${DSH_VERSION_FILE}（核验版本可另注日期）`,
        );
      }
    });
  }
  return problems;
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
    pattern: /锁版本\s*`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`/,
  },
  {
    file: 'docs/architecture/platform-architecture.md',
    label: '一期兼容目标',
    pattern: /一期兼容目标固定 DSH\s*`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`/,
  },
];

/** 代码/脚本的扫描面：全仓（跳过依赖与产物目录），只排除 docs/（另有正文规则）。 */
const CODE_EXT = /\.(?:mjs|cjs|js|ts|json|yml|yaml|sh|bash|zsh)$/;

/**
 * 允许出现版本字面量的代码位置。
 * 清单不在此列：清单只放行 `engines.dsh` 里实际写的那个版本（见 MANIFEST_RE），
 * 免得整文件放行后 dependencies 里钉死的 DSH 版本溜过去。
 */
const TEST_CODE = /\.(?:mjs|cjs|js|ts)$/;
export const CODE_ALLOWED = [
  // 只放行测试**代码**：测试目录里的 .json 数据夹具若确需写死版本，仍要登记例外，避免整目录静默放行。
  { re: /^packages\/[^/]+\/test\//, only: TEST_CODE },
  { re: /^tests\//, only: TEST_CODE },
  { re: /^services\/[^/]+\/test\//, only: TEST_CODE },
  { re: /^scripts\/lib\/dsh-version\.mjs$/, only: null },
];

/** 包与服务清单：只放行 engines.dsh 的值。 */
const MANIFEST_RE = /^(?:packages|services)\/[^/]+\/package\.json$/;

/**
 * 测试夹具里有意写死的版本字面量（模拟旧宿主或第三方包形状），登记原因后可放行，
 * 但在 report/check 里单独列出：它们是"不会随基线更新"的显式例外，不是静默放行。
 */
export const TEST_FIXTURE_EXCEPTIONS = {
  'tests/bundle-closure.test.mjs':
    '合成清单夹具，复刻真实 engines/dependencies 形状；版本仅作样例，断言的是闭包规则而非基线版本。',
};

function manifestEnginesTokens(abs) {
  try {
    const manifest = JSON.parse(readFileSync(abs, 'utf8'));
    const range = manifest?.engines?.dsh;
    if (typeof range !== 'string') return new Set();
    return new Set([...range.matchAll(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g)].map((m) => m[0]));
  } catch {
    return new Set();
  }
}

/** 文档里"历史记录"的判据：编制依据/实测/探针口径，或行内带日期。 */
const DATED_MARKERS = /(编制依据|实测|核验|复核|探针|npm registry|当时|历史)/;
const HAS_DATE = /20\d\d-\d\d-\d\d/;

/**
 * 不作为当前仓库版本检查输入的目录：依赖与构建产物、工具本地工作副本（Paperclip、AI 工具），
 * 以及 TeamFlow 运行日志（宿主托管的临时区，跑完即归档并删除，不是交付源码）。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.paperclip',
  '.agents',
  'dist',
  'build',
  '.cache',
  'coverage',
  'artifacts',
  'logs',
]);

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
    // 嵌套检出（`.git` 文件或目录）自成仓库，不属当前仓库的受管源码。
    if (st.isDirectory() && !existsSync(join(abs, '.git'))) walk(abs, filter, root, out);
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

/** 代码与脚本中出现版本号的位置：全仓扫描，按允许清单与清单精确规则分类。 */
export function listCodeOccurrences(root = process.cwd(), baseline = readDshVersion(root)) {
  const targets = walk(root, (rel) => CODE_EXT.test(rel) && !rel.startsWith('docs/'), root);
  const found = [];
  for (const abs of targets) {
    const rel = relative(root, abs).split(sep).join('/');
    const allowed = CODE_ALLOWED.some((entry) =>
      entry.only ? entry.re.test(rel) && entry.only.test(rel) : entry.re.test(rel),
    );
    const manifestTokens = MANIFEST_RE.test(rel) ? manifestEnginesTokens(abs) : null;
    const fixtureNote = TEST_FIXTURE_EXCEPTIONS[rel] ?? null;
    const lines = readLines(abs);
    if (!lines) continue;
    lines.forEach((line, index) => {
      for (const match of line.matchAll(SEMVER_IN_TEXT)) {
        if (!dshVersionInLine(match[0], line, baseline, { allowReleaseLine: true })) continue;
        let kind;
        if (manifestTokens) kind = manifestTokens.has(match[0]) ? 'code-allowed' : 'code-forbidden';
        else if (allowed) kind = fixtureNote ? 'fixture-exception' : 'code-allowed';
        else kind = 'code-forbidden';
        found.push({
          file: rel,
          line: index + 1,
          version: match[0],
          kind,
          reason: fixtureNote,
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

/** 清单里的 `engines.dsh` 下限（包与服务）；改版时可选择一并提升（例外除外）。 */
export function listEngineFloors(root = process.cwd()) {
  const floors = [];
  for (const dir of ['packages', 'services']) {
    for (const abs of walk(join(root, dir), (rel) => rel.endsWith('/package.json'), root)) {
      const rel = relative(root, abs).split(sep).join('/');
      let range;
      try {
        range = JSON.parse(readFileSync(abs, 'utf8'))?.engines?.dsh;
      } catch {
        range = null;
      }
      const match = typeof range === 'string' ? range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/) : null;
      if (match) {
        floors.push({
          file: rel,
          floor: match[0],
          exception: Boolean(ENGINE_FLOOR_EXCEPTIONS[rel]),
          reason: ENGINE_FLOOR_EXCEPTIONS[rel] ?? null,
        });
      }
    }
  }
  return floors;
}

/**
 * 下限断言：下限必须与基线同发布线、不得高于基线；低于该发布线的基础版本必须登记例外；
 * 只是低于基线（保留已核验的候选版）给提示，理由写在开发约定 §7.1。
 */
export function checkEngineFloors(root = process.cwd(), baseline = readDshVersion(root)) {
  const problems = [];
  const warnings = [];
  const baseLine = dshReleaseLine(baseline);
  const baseVersion = String(baseline).replace(/^v/i, '').split('-')[0];
  for (const floor of listEngineFloors(root)) {
    const line = dshReleaseLine(floor.floor);
    if (line !== baseLine) {
      problems.push(
        `${floor.file}：engines.dsh ${floor.floor} 与基线 ${baseline} 不在同一发布线（${line ?? '无法解析'} vs ${baseLine}）`,
      );
      continue;
    }
    if (compareVersions(floor.floor, baseline) > 0) {
      problems.push(`${floor.file}：engines.dsh ${floor.floor} 高于基线 ${baseline}，基线宿主也满足不了该下限`);
      continue;
    }
    // 基线本身是预发布（如 0.2.1-rc.3）时，"低于基础版本"不是问题：预发布在比较上本就更低。
    const floorBase = floor.floor.split('-')[0];
    if (floorBase !== baseVersion && !floor.exception) {
      problems.push(
        `${floor.file}：engines.dsh ${floor.floor} 与该发布线基础版本 ${baseVersion} 不同且未登记例外（ENGINE_FLOOR_EXCEPTIONS）`,
      );
      continue;
    }
    if (floor.floor !== baseline && !floor.exception) {
      warnings.push(`${floor.file}：engines.dsh ${floor.floor} 低于基线 ${baseline}（保留已核验候选版，理由见开发约定 §7.1）`);
    }
  }
  return { problems, warnings };
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
  const next = text.replace(/("dsh"\s*:\s*"[^"]*?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(")/g, (full, head, current, tail) => {
    if (current === target) return full;
    replaced += 1;
    return head + target + tail;
  });
  return { text: next, replaced };
}
