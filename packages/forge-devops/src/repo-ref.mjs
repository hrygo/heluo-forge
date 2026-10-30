/**
 * `@heluo/forge-devops` 的**仓库引用语法唯一真源**（r6，TECH-CHANGE §3.2）。
 *
 * 为什么单独一个模块：同一个"仓库引用"在五处各写了一份正则，而且已经开始漂移——
 * `gh-adapter.mjs` 的 `REPO_PATTERN` 锚定首字符、`actions.mjs` 的 `REPO_PATTERN` 不锚定
 * （`-bad/x` 在一边被拒、在另一边通过）；`tools.mjs` 与 `flow.mjs` 又各自写了一遍
 * `repo#n` / `repo!n` 的写法；`repository-resolver.mjs` 用"候选最后一段等于输入"兜底。
 * 同一串输入五种判词，正是"三段仓库进不了写路径"与"裸名跨组串仓"两类缺陷的土壤。
 * 收敛到这里以后：判词只有一份，放宽段数只改一处，门禁侧（`tools.checkConfirm`、
 * `flow.repoMismatch`）也不会再因为"取不到仓库名"而误判。
 *
 * 语法（**唯一**定义，别处不得再抄）：
 * - 段：`[A-Za-z0-9][A-Za-z0-9._-]*` —— 首字符必须是字母或数字，所以 `-bad`、`--yes`、
 *   `.hidden` 天然被拒；段内允许 `.`、`_`、`-`，但**不允许** `/`、空格与本模块显式拦下的
 *   控制字符（含 NUL、换行、制表）。
 * - 引用：`段` 重复 **2..3** 次（两段 `owner/name` 是历史形态，三段 `org/group/repo` 是
 *   企业 Gitee 的命名空间形态）。1 段、4 段、空段（`a//b`、`a/`、`/b`）一律不合法。
 * - 目标：引用 + 尾部 `#n` / `!n`（n 为 1..9 位数字）。链接（含主机名与
 *   `issues`/`pull` 路径）与裸编号**不是**本模块的仓库引用：链接的形状校验留在
 *   `gh-adapter.assertTarget`（它的主机名不写死），裸编号本来就不带仓库。
 *
 * 边界：**零依赖、零子进程、零 IO、零时钟**。纯字符串判定，非法输入只回 `null` / `false`，
 * 不抛错、不猜、不补全（`owner/name` 不会因为"看起来像 repo 名"被升级成三段，裸名也不会
 * 在这里跨仓库兜底——候选范围的兜底只发生在 `pickRepoRef`，且必须先有候选）。
 *
 * 一点读法约定：全仓的 `text()` 会先 `trim()`，本模块沿用同一约定——首尾空白被忽略；
 * 段内空白与控制字符（NUL、换行、制表）仍然拒绝，段内出现换行时 `$` 也可能在"末尾换行前"
 * 命中，因此判词一律作用在 `trim()` 之后的串上。
 */

/** 单个仓库段的字符形态（拼正则用；`gh-adapter` 的目标链接正则也引用它，不再自写一份）。 */
export const REPO_SEGMENT_SOURCE = '[A-Za-z0-9][A-Za-z0-9._-]*';

/** 引用最少段数：`owner/name`（历史上唯一支持的形态）。 */
export const REPO_REF_MIN_SEGMENTS = 2;

/** 引用最多段数：`org/group/repo`（企业 Gitee 命名空间）。再宽就是"任意深路径"，不再有仓库语义。 */
export const REPO_REF_MAX_SEGMENTS = 3;

/**
 * 整串匹配 2..3 段仓库引用（`u` 标志；无 `g`，`test()` 不携带状态）。
 * 段数直接由上面两个常量推出，放宽/收紧段数只动常量。
 */
export const REPO_REF_PATTERN = new RegExp(
  `^${REPO_SEGMENT_SOURCE}(?:/${REPO_SEGMENT_SOURCE}){${REPO_REF_MIN_SEGMENTS - 1},${REPO_REF_MAX_SEGMENTS - 1}}$`,
  'u',
);

/** 目标尾部编号：`#12` / `!12`（issue 用 `#`，PR 用 `!`，两者在 gh 的 target 里同形）。 */
const TARGET_SUFFIX_PATTERN = /[#!]\d{1,9}$/u;

/** 控制字符：NUL、换行、制表等。它们不是合法段字符，也不能靠 `trim()` 悄悄吃掉。 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 引用的输入归一：非字符串、段内含控制字符都回 `null`（调用方据此判非法，不再二次解释）。
 * 首尾空白按全仓 `text()` 约定剥掉，段内空白留给字符类去拒。
 */
function refText(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (CONTROL_CHARACTER_PATTERN.test(path)) return null;
  return path;
}

/** 引用是否合法（2..3 段整串）。非字符串、空串、链接、带 `#n` 的目标都返回 `false`。 */
export function isRepoRef(value) {
  const path = refText(value);
  return path !== null && REPO_REF_PATTERN.test(path);
}

/**
 * 解析引用：`{ path, segments }`（`path` 是剥掉首尾空白后的原样路径，大小写不折叠；
 * `segments` 是拆开的段，顺序与输入一致）。非法输入回 `null`。
 */
export function parseRepoRef(value) {
  const path = refText(value);
  if (path === null || !REPO_REF_PATTERN.test(path)) return null;
  return { path, segments: path.split('/') };
}

/**
 * 解析带编号的评论目标：`repo#12` / `repo!12` → `{ repo, number }`。
 * 只接受 2..3 段引用 + 尾部编号；链接、裸编号、1 段裸名、多余尾巴一律 `null`
 * （不带编号的仓库引用请用 `repoOfTarget`）。
 */
export function parseTargetRef(target) {
  const raw = refText(target);
  if (raw === null) return null;
  const suffix = TARGET_SUFFIX_PATTERN.exec(raw);
  if (suffix === null) return null;
  const repo = raw.slice(0, suffix.index);
  if (!REPO_REF_PATTERN.test(repo)) return null;
  return { repo, number: Number.parseInt(raw.slice(suffix.index + 1), 10) };
}

/**
 * 从目标里取出仓库：`acme/demo#12` → `acme/demo`，`org/group/repo!7` → `org/group/repo`，
 * 不带编号的引用（`acme/demo`）原样返回；链接、裸编号与 **1 段裸名（`acme`）** 回 `null`
 * ——段语法是 2..3 段，裸名不在门禁核对里兜底（否则 `acme` 会被当某个组的仓库）。
 *
 * 返回值是**完整路径**（三段不会折成两段）——门禁核对要的是"哪个仓库"，
 * 折叠成 `group/repo` 会把 `org/group/repo` 判成另一个仓库（那是放松门禁，不是修 bug）。
 */
export function repoOfTarget(target) {
  const parsed = parseTargetRef(target);
  if (parsed !== null) return parsed.repo;
  const raw = refText(target);
  return raw !== null && REPO_REF_PATTERN.test(raw) ? raw : null;
}

/**
 * 同一个仓库的比较（整串、去首尾空白、大小写不敏感）。
 *
 * **没有裸名兜底**：`sameRepo('org/group/repo', 'repo')` 恒为 `false`。裸名只在
 * `pickRepoRef` 里、且只在"候选内唯一同名"时生效——没有候选集就无从判断裸名指的是谁，
 * 在这里兜底等于跨组串仓。
 */
export function sameRepo(candidate, explicit) {
  const left = text(candidate).toLowerCase();
  const right = text(explicit).toLowerCase();
  return left !== '' && left === right;
}

/**
 * 在候选集里挑出 `explicit` 指向的仓库（承建仓库选定的唯一实现）。
 *
 * - 先比整串（去空白、大小写不敏感）：命中即选中，**整串优先于任何裸名兜底**；
 * - `explicit` 不含 `/` 时才按"最后一段同名"兜底，且**只在该同名候选唯一时**成立；
 * - 无命中 → `selected: null, ambiguous: []`；跨组同名 → `selected: null` 且
 *   `ambiguous` 列出全部同名候选（调用方据此走 `blocked/MULTIPLE_CANDIDATES`，不猜）。
 *
 * 候选只认合法引用（`isRepoRef`）；重复项按大小写不敏感去重、保留首次出现的原样写法，
 * 保证同一输入在不同机器上给出同一结果。返回的 `selected` 是候选里的原串，不是用户输入。
 */
export function pickRepoRef(candidates, explicit) {
  const wanted = text(explicit);
  const none = { selected: null, ambiguous: [] };
  if (wanted === '') return none;

  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = text(raw);
    if (!isRepoRef(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const wantedKey = wanted.toLowerCase();
  const exact = unique.find((candidate) => candidate.toLowerCase() === wantedKey);
  if (exact !== undefined) return { selected: exact, ambiguous: [] };
  if (wanted.includes('/')) return none;

  const matches = unique.filter((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1).toLowerCase() === wantedKey);
  if (matches.length === 1) return { selected: matches[0], ambiguous: [] };
  if (matches.length > 1) return { selected: null, ambiguous: matches };
  return none;
}
