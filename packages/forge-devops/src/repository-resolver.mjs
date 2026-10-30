/**
 * `@heluo/forge-devops` 的承建仓库判定（AC-12 的唯一实现）。
 *
 * 只做三件事：**限定候选来源**、**逐项记录命中证据**、**把 0／1／多候选分成可继续与阻断**。
 * 候选只来自 `dop.sub_systems`（平台声明的承建系统）× `gh` 可见仓库（已核实的仓库清单）；
 * 变更号文本、仓库名相似度、"上次好像是它"都不参与推断——信息不足就是 `blocked`，
 * 由调用方据此拒绝全部写动作（本模块自身不发任何动作，只判定）。
 *
 * 纯函数：不读环境、不调平台、不读时钟。`visibleRepos` 由调用方经 gh 只读查询取来传入：
 * - `null` 表示清单不可得（未配置仓库范围或查询失败）→ `NO_REPO_SCOPE`，不猜；
 * - `[]` 表示查过但没有可见仓库 → `NO_VISIBLE_REPOS`；
 * - 数组元素可以是纯字符串（`owner/name`）或 gh 的结构化对象（`nameWithOwner/name/description/topics`）。
 *
 * `explicit`（用户在候选里点名的那个）的匹配交给 `repo-ref.mjs` 的 `pickRepoRef`：
 * 整串（去空白、大小写不敏感）优先；裸名只在**候选内唯一同名**时命中；跨组同名一律
 * `blocked/MULTIPLE_CANDIDATES`。本模块不再自己写"候选最后一段等于输入"的兜底——那份兜底
 * 会在 `orgA/repo` 与 `orgB/repo` 两个候选里静默挑第一个，等于跨组串仓（幂等复用会落到错的仓库）。
 *
 * 不允许做的三件事（写在这里是因为它们最容易被"顺手"加回来）：
 * - 不按变更号/需求标题去 gh 搜索仓库——那是网络推断，不是候选来源；
 * - `explicit` 只能从已算出的候选里挑一个，不得引入候选之外的新仓库；
 * - 不自己写裸名兜底：同名唯一性只有 `pickRepoRef` 一处实现，否则两处判词迟早分叉。
 */

import { pickRepoRef } from './repo-ref.mjs';

/** 判定结果只有两态：可继续 / 阻断（区别于平台动作的 done/failed/denied/unknown 词表）。 */
export const RESOLVE_STATUSES = Object.freeze(['resolved', 'blocked']);

/** 阻断与选择原因；渲染与报告直接展示这些码，不做二次解释。 */
export const RESOLVE_REASONS = Object.freeze({
  MISSING_CHANGE: 'MISSING_CHANGE',
  NO_SUB_SYSTEMS: 'NO_SUB_SYSTEMS',
  NO_REPO_SCOPE: 'NO_REPO_SCOPE',
  NO_VISIBLE_REPOS: 'NO_VISIBLE_REPOS',
  NO_CANDIDATE: 'NO_CANDIDATE',
  MULTIPLE_CANDIDATES: 'MULTIPLE_CANDIDATES',
  EXPLICIT_NOT_CANDIDATE: 'EXPLICIT_NOT_CANDIDATE',
});

/** 证据只有两个来源，报告里的"来源类型分记"依赖它。 */
export const EVIDENCE_SOURCES = Object.freeze({
  SUB_SYSTEMS: 'dop.sub_systems',
  REPOSITORIES: 'gh.visible_repos',
});

/** 证据种类：命中发生在哪个字段上（渲染成人能核对的短语）。 */
export const EVIDENCE_KINDS = Object.freeze([
  'sub_system.code',
  'sub_system.name',
  'repo.name',
  'repo.description',
  'repo.topic',
]);

const TERM_SEPARATORS = /[.·、，,;；:：/\\|()[\]{}\s]+/;
const ASCII = /^[\x20-\x7e]+$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ASCII 词按词边界命中（`ard` 不得命中 `award`）；CJK 词按包含命中（中文没有词边界）。 */
function termMatches(haystack, term) {
  if (haystack === '' || term === '') return false;
  const hay = haystack.toLowerCase();
  const needle = term.toLowerCase();
  if (!ASCII.test(needle)) return hay.includes(needle);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(hay);
}

/** 太短的词（`AI`、`SDK`、单字）命中率高但证据价值低，不参与判定，避免自造"看起来很确定"。 */
function usableTerm(term) {
  const value = text(term);
  if (value === '') return false;
  return ASCII.test(value) ? value.length >= 3 : [...value].length >= 2;
}

/** 一条承建系统声明切成若干可命中词；保留连字符词（`points-mall` 是一个词，不拆）。 */
function termsOf(kind, value) {
  const full = text(value);
  if (!usableTerm(full)) return [];
  const terms = [{ kind, value: full }];
  for (const token of full.split(TERM_SEPARATORS)) {
    const piece = text(token);
    if (piece !== '' && piece !== full && usableTerm(piece)) terms.push({ kind, value: piece });
  }
  return terms;
}

function subSystemTerms(subSystem) {
  const item = typeof subSystem === 'string' ? { code: subSystem } : asObject(subSystem);
  return [...termsOf('sub_system.code', item.code), ...termsOf('sub_system.name', item.name)];
}

function normalizeSubSystems(change) {
  const source = asArray(change.subSystems ?? change.sub_systems);
  const normalized = [];
  for (const entry of source) {
    if (typeof entry === 'string') {
      const code = text(entry);
      if (code !== '') normalized.push({ code, name: '' });
      continue;
    }
    const item = asObject(entry);
    const code = text(item.code);
    const name = text(item.name);
    if (code !== '' || name !== '') normalized.push({ code, name });
  }
  return normalized;
}

/** 仓库清单归一：只取接口给出的标识与可检索字段，不拼接推断出来的 owner。 */
function normalizeRepos(visibleRepos) {
  if (visibleRepos === null || visibleRepos === undefined) return null;
  const source = Array.isArray(visibleRepos) ? visibleRepos : [visibleRepos];
  const repos = [];
  for (const entry of source) {
    if (typeof entry === 'string') {
      const repo = text(entry);
      if (repo !== '') repos.push({ repo, fields: [{ kind: 'repo.name', value: repo }] });
      continue;
    }
    const item = asObject(entry);
    const owner = text(item.owner) || text(asObject(item.owner).login);
    const bare = text(item.name);
    const repo = text(item.nameWithOwner) || (owner !== '' && bare !== '' ? `${owner}/${bare}` : bare || owner);
    if (repo === '') continue;
    const fields = [{ kind: 'repo.name', value: repo }];
    const description = text(item.description);
    if (description !== '') fields.push({ kind: 'repo.description', value: description });
    for (const topic of asArray(item.topics)) {
      const value = text(topic);
      if (value !== '') fields.push({ kind: 'repo.topic', value });
    }
    repos.push({ repo, fields });
  }
  return repos;
}

function addEvidence(evidence, item) {
  const exists = evidence.some((entry) => entry.kind === item.kind && entry.value === item.value);
  if (!exists) evidence.push(item);
}

/** 候选 = 仓库清单里能被任何一条承建系统声明命中的仓库，命中双方都留证据。 */
function findCandidates(subSystems, repos) {
  const byKey = new Map();
  for (const subSystem of subSystems) {
    for (const term of subSystemTerms(subSystem)) {
      for (const repo of repos) {
        for (const field of repo.fields) {
          if (!termMatches(field.value, term.value)) continue;
          const key = repo.repo.toLowerCase();
          const candidate = byKey.get(key) ?? { repo: repo.repo, evidence: [] };
          addEvidence(candidate.evidence, { kind: term.kind, value: term.value, source: EVIDENCE_SOURCES.SUB_SYSTEMS });
          addEvidence(candidate.evidence, { kind: field.kind, value: field.value, source: EVIDENCE_SOURCES.REPOSITORIES });
          byKey.set(key, candidate);
        }
      }
    }
  }
  return [...byKey.values()]
    .map((candidate) => ({
      ...candidate,
      evidence: [...candidate.evidence].sort((left, right) => compareText(`${left.kind}:${left.value}`, `${right.kind}:${right.value}`)),
    }))
    .sort((left, right) => compareText(left.repo.toLowerCase(), right.repo.toLowerCase()));
}

/** 定序不依赖 locale：同一输入在不同机器上必须给出同一候选顺序（报告要能逐字复现）。 */
function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function blocked(reasons, candidates) {
  return { status: 'blocked', selected: null, candidates, reasons: [...reasons] };
}

/**
 * 判定承建仓库。
 * `explicit` 只能从候选里挑（用户在候选里选一个，不是自由填一个仓库）——它不扩大候选集；
 * "挑中哪个"由 `pickRepoRef` 判定：整串优先、裸名需候选内唯一，跨组同名不猜。
 */
export function resolveBuildingRepository({ change = null, visibleRepos = null, explicit = null } = {}) {
  const changeObject = asObject(change);
  const subSystems = normalizeSubSystems(changeObject);
  const repos = normalizeRepos(visibleRepos);
  const explicitId = text(explicit);
  const reasons = [];

  if (Object.keys(changeObject).length === 0) reasons.push(RESOLVE_REASONS.MISSING_CHANGE);
  else if (subSystems.length === 0) reasons.push(RESOLVE_REASONS.NO_SUB_SYSTEMS);
  if (repos === null) reasons.push(RESOLVE_REASONS.NO_REPO_SCOPE);
  else if (repos.length === 0) reasons.push(RESOLVE_REASONS.NO_VISIBLE_REPOS);

  const candidates = subSystems.length === 0 || repos === null || repos.length === 0 ? [] : findCandidates(subSystems, repos);

  if (explicitId !== '') {
    const picked = pickRepoRef(
      candidates.map((candidate) => candidate.repo),
      explicitId,
    );
    if (picked.selected !== null) return { status: 'resolved', selected: picked.selected, candidates, reasons: [] };
    // 裸名在候选内同名不唯一：不替用户挑第一个（那是跨组串仓），显式阻断并列出全部同名候选。
    if (picked.ambiguous.length > 0) return blocked([RESOLVE_REASONS.MULTIPLE_CANDIDATES], candidates);
    if (candidates.length > 0) return blocked([RESOLVE_REASONS.EXPLICIT_NOT_CANDIDATE], candidates);
    return blocked(reasons.length > 0 ? reasons : [RESOLVE_REASONS.NO_CANDIDATE], candidates);
  }

  if (candidates.length === 1) return { status: 'resolved', selected: candidates[0].repo, candidates, reasons: [] };
  if (candidates.length > 1) reasons.push(RESOLVE_REASONS.MULTIPLE_CANDIDATES);
  else if (reasons.length === 0) reasons.push(RESOLVE_REASONS.NO_CANDIDATE);
  return blocked(reasons, candidates);
}
