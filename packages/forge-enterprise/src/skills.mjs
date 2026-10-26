/**
 * 按需企业 Skill 与规范条款装配。
 *
 * 只做三件事：按适用性挑选条款、把选中的条款注册为"只读运行时技能"、给出加载记录与
 * 上下文开销。加载不写仓库、不建 Issue、不做"合规通过"结论；模型不能自动冒用企业入口。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

export class EnterpriseSkillError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'EnterpriseSkillError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const LEVELS = new Set(['hard', 'advice']);
const STATUSES = new Set(['active', 'expired']);

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function resolveClausePath(clause, pack) {
  const raw = clause?.body;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new EnterpriseSkillError(`clause "${clause?.id ?? '(unnamed)'}" needs a body path`, 'ENTERPRISE_CLAUSE_INVALID');
  }
  if (isAbsolute(raw)) {
    throw new EnterpriseSkillError(`clause body "${raw}" must be relative to the pack root`, 'ENTERPRISE_PATH_ABSOLUTE', { path: raw });
  }
  const normalized = normalize(raw);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new EnterpriseSkillError(`clause body "${raw}" escapes the pack root`, 'ENTERPRISE_PATH_TRAVERSAL', { path: raw });
  }
  return join(pack.root, normalized);
}

/**
 * Read a clause pack (index + clause bodies). Reading never writes.
 *
 * @param {{root: string, index?: object}} input
 */
export function loadClausePack(input) {
  const root = input.root;
  const indexPath = join(root, input.indexFile ?? 'clauses.json');
  let index = input.index;
  if (index === undefined) {
    const text = readText(indexPath);
    if (text === undefined) {
      throw new EnterpriseSkillError(`clause index "${indexPath}" does not exist`, 'ENTERPRISE_INDEX_MISSING', { path: indexPath });
    }
    try {
      index = JSON.parse(text);
    } catch (error) {
      throw new EnterpriseSkillError(`clause index "${indexPath}" is not valid JSON: ${error.message}`, 'ENTERPRISE_INDEX_INVALID');
    }
  }
  const clauses = index?.clauses;
  if (!Array.isArray(clauses) || clauses.length === 0) {
    throw new EnterpriseSkillError('clause pack needs at least one clause', 'ENTERPRISE_INDEX_INVALID');
  }
  const seen = new Set();
  const normalized = clauses.map((clause) => {
    const id = clause?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new EnterpriseSkillError('every clause needs an id', 'ENTERPRISE_CLAUSE_INVALID');
    }
    if (seen.has(id)) throw new EnterpriseSkillError(`duplicate clause id "${id}"`, 'ENTERPRISE_CLAUSE_DUPLICATE', { id });
    seen.add(id);
    if (!LEVELS.has(clause.level)) {
      throw new EnterpriseSkillError(`clause "${id}" level must be hard or advice`, 'ENTERPRISE_CLAUSE_INVALID', { id });
    }
    const status = clause.status ?? 'active';
    if (!STATUSES.has(status)) {
      throw new EnterpriseSkillError(`clause "${id}" status must be active or expired`, 'ENTERPRISE_CLAUSE_INVALID', { id });
    }
    const appliesTo = Array.isArray(clause.appliesTo) ? clause.appliesTo : [];
    for (const target of appliesTo) {
      if (typeof target?.system !== 'string' || target.system.length === 0) {
        throw new EnterpriseSkillError(`clause "${id}" appliesTo needs a system`, 'ENTERPRISE_CLAUSE_INVALID', { id });
      }
    }
    const bodyPath = resolveClausePath(clause, { root });
    const body = readText(bodyPath);
    if (body === undefined) {
      throw new EnterpriseSkillError(`clause "${id}" body "${clause.body}" is missing`, 'ENTERPRISE_CLAUSE_BODY_MISSING', { id, path: clause.body });
    }
    return Object.freeze({
      id,
      title: clause.title ?? id,
      level: clause.level,
      status,
      owner: clause.owner ?? 'unassigned',
      summary: clause.summary ?? '',
      appliesTo: Object.freeze(appliesTo.map((target) => Object.freeze({ system: target.system, versions: Object.freeze(target.versions ?? []) }))),
      references: Object.freeze(clause.references ?? []),
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
      key: clause.key ?? id,
      decision: clause.decision,
    });
  });
  return Object.freeze({ root, version: index.version ?? 1, clauses: Object.freeze(normalized) });
}

function versionApplies(range, version) {
  if (!Array.isArray(range) || range.length === 0) return true;
  if (typeof version !== 'string' || version.length === 0) return false;
  return range.some((entry) => typeof entry === 'string' && (entry === version || entry === '*' || entry.endsWith('.*') && version.startsWith(entry.slice(0, -1))));
}

function tidOf(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/**
 * Select only the clauses that apply to the task's systems and versions.
 *
 * @param {{pack: object, systems: {name: string, version?: string}[], budgetTokens?: number}} input
 */
export function selectClauses({ pack, systems = [], budgetTokens }) {
  const selected = [];
  const excluded = [];
  for (const clause of pack.clauses) {
    if (clause.status === 'expired') {
      excluded.push({ id: clause.id, reason: 'expired', owner: clause.owner });
      continue;
    }
    if (clause.appliesTo.length === 0) {
      selected.push(clause);
      continue;
    }
    const applicable = clause.appliesTo.some((target) => systems.some((system) => system?.name === target.system && versionApplies(target.versions, system.version)));
    if (applicable) selected.push(clause);
    else excluded.push({ id: clause.id, reason: 'not-applicable', owner: clause.owner, appliesTo: clause.appliesTo.map((target) => target.system) });
  }
  const conflicts = [];
  const byKey = new Map();
  for (const clause of selected.filter((entry) => entry.level === 'hard')) {
    const group = byKey.get(clause.key) ?? [];
    group.push(clause);
    byKey.set(clause.key, group);
  }
  for (const [key, group] of byKey) {
    const decisions = new Set(group.map((clause) => clause.decision ?? clause.id));
    if (group.length > 1 && decisions.size > 1) {
      conflicts.push({ key, owners: group.map((clause) => clause.owner), clauses: group.map((clause) => clause.id) });
    }
  }
  const hard = selected.filter((clause) => clause.level === 'hard');
  const advice = selected.filter((clause) => clause.level === 'advice');
  const bytes = selected.reduce((total, clause) => total + clause.bytes, 0);
  const estimatedTokens = selected.reduce((total, clause) => total + tidOf(clause.body), 0);
  const overBudget = budgetTokens !== undefined && estimatedTokens > budgetTokens;
  if (overBudget) {
    throw new EnterpriseSkillError(
      `selected clauses need about ${estimatedTokens} tokens, above the ${budgetTokens} budget; select fewer systems instead of injecting everything`,
      'ENTERPRISE_BUDGET_EXCEEDED',
      { estimatedTokens, budgetTokens, selected: selected.map((clause) => clause.id) },
    );
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    hard: Object.freeze(hard),
    advice: Object.freeze(advice),
    excluded: Object.freeze(excluded),
    conflicts: Object.freeze(conflicts),
    budget: Object.freeze({ clauses: selected.length, bytes, estimatedTokens, limit: budgetTokens ?? null }),
    loadRecord: Object.freeze({
      pack: pack.version,
      loaded: selected.map((clause) => ({ id: clause.id, level: clause.level, owner: clause.owner, references: clause.references })),
      skipped: excluded,
      conflicts,
    }),
  });
}

/**
 * Register the selected clauses as readonly, user-invocable enterprise skills.
 * Registration performs no writes and never claims compliance.
 *
 * @param {{skills: object}} ctx host context providing `skills`
 * @param {{selection: object, namePrefix?: string, invocation?: object}} input
 */
export function registerEnterpriseSkills(ctx, { selection, namePrefix = 'enterprise', invocation }) {
  const skills = ctx?.skills;
  if (skills === undefined || typeof skills.register !== 'function') {
    throw new EnterpriseSkillError('host has no skills service to register enterprise skills on', 'ENTERPRISE_HOST_UNAVAILABLE');
  }
  const policy = Object.freeze({
    modelInvocable: invocation?.modelInvocable ?? false,
    userInvocable: invocation?.userInvocable ?? true,
  });
  const registered = [];
  for (const clause of selection.hard) {
    const name = `${namePrefix}-${clause.id}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
    const dispose = skills.register({
      name,
      description: clause.summary.length > 0 ? clause.summary : clause.title,
      whenToUse: `当任务涉及 ${clause.appliesTo.map((target) => target.system).join('、') || '企业规范'} 时按需加载；由用户显式触发`,
      content: clause.body,
      source: 'custom',
      invocation: policy,
      metadata: { owner: clause.owner, level: clause.level, references: clause.references },
    });
    registered.push({ id: clause.id, name, dispose });
  }
  return Object.freeze({
    invocation: policy,
    registered: Object.freeze(registered.map(({ id, name }) => ({ id, name }))),
    dispose: () => {
      for (const entry of registered) entry.dispose?.();
    },
  });
}

/**
 * Register the selected clauses through the host lazy provider path.
 *
 * Shape verified by the host probe (`skills-registry-discovery-and-load`,
 * DSH 0.2.1-rc.2): `registerProvider` takes a factory returning
 * `{ name, list, get }`; `list()` yields summaries WITHOUT the body and
 * `get(name)` returns the body on demand. If the host has no provider entry,
 * this throws and the caller falls back to direct registration (eager body).
 * Provider-path availability on newer hosts (rc.3) is NOT RUN here.
 *
 * @param {{skills: object}} ctx host context providing `skills`
 * @param {{selection: object, namePrefix?: string, invocation?: object}} input
 */
export function registerEnterpriseSkillsViaProvider(ctx, { selection, namePrefix = 'enterprise', invocation } = {}) {
  const skills = ctx?.skills;
  if (skills === undefined || typeof skills.registerProvider !== 'function') {
    throw new EnterpriseSkillError('host has no skills provider entry for enterprise skills', 'ENTERPRISE_PROVIDER_UNAVAILABLE');
  }
  const policy = Object.freeze({
    modelInvocable: invocation?.modelInvocable ?? false,
    userInvocable: invocation?.userInvocable ?? true,
  });
  const providerName = `${namePrefix}-clauses`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
  const skillName = (clause) => `${namePrefix}-${clause.id}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
  const byName = new Map(selection.hard.map((clause) => [skillName(clause), clause]));
  const summaryOf = (clause) => ({
    name: skillName(clause),
    description: clause.summary.length > 0 ? clause.summary : clause.title,
    whenToUse: `当任务涉及 ${clause.appliesTo.map((target) => target.system).join('、') || '企业规范'} 时按需加载；由用户显式触发`,
    provider: providerName,
    rank: 0,
    locator: { clause: clause.id },
    invocation: policy,
    metadata: { owner: clause.owner, level: clause.level, references: clause.references },
  });
  const dispose = skills.registerProvider(() => ({
    name: providerName,
    list: async () => [...byName.values()].map(summaryOf),
    get: async (name) => {
      const clause = byName.get(name);
      if (clause === undefined) return undefined;
      return { ...summaryOf(clause), content: clause.body };
    },
  }));
  return Object.freeze({
    invocation: policy,
    provider: providerName,
    registered: Object.freeze([...byName.keys()].map((name, index) => ({ id: selection.hard[index].id, name }))),
    dispose: () => dispose?.(),
  });
}

/** Hard requirements that must be visible before the given action runs. */
export function preActionConstraints({ selection, action }) {
  return Object.freeze(
    selection.hard.filter((clause) =>
      clause.references.some((reference) => reference === action) || clause.decision === action || clause.appliesTo.length === 0),
  );
}

/**
 * FIX-09（#37）：交付 Skill 的单一受管装配入口。
 *
 * 把"加载 → 选择 → 注册"三步收进一个入口：调用一次即完成装配，返回的 `dispose`
 * 一次性注销全部已注册 Skill。发现面只暴露摘要（id/标题/摘要/owner/版本范围），
 * 正文通过 `bodyFor(id)` 按需取用，不在发现面展开；装配本身零写入、不授予任何
 * 权限、不固定 Skill 流程、不产出合规结论。真实企业条款来源仍待企业提供，
 * 安装路径的实际调用待宿主装配完成后记账（见设计文档核验状态表）。
 *
 * @param {{skills: object}} ctx host context providing `skills`
 * @param {{root?: string, pack?: object, systems?: Array, budgetTokens?: number, namePrefix?: string, invocation?: object}} input
 */
export function assembleEnterpriseSkills(ctx, { root, pack, systems = [], budgetTokens, namePrefix = 'enterprise', invocation } = {}) {
  const loaded = pack ?? loadClausePack({ root });
  const selection = selectClauses({ pack: loaded, systems, budgetTokens });
  // Prefer the probe-verified lazy provider path; direct registration (eager
  // body) is the fallback for hosts without a provider entry. Either way the
  // discovery face carries summaries only.
  const registration = typeof ctx?.skills?.registerProvider === 'function'
    ? registerEnterpriseSkillsViaProvider(ctx, { selection, namePrefix, invocation })
    : registerEnterpriseSkills(ctx, { selection, namePrefix, invocation });
  const bodies = new Map(selection.selected.map((clause) => [clause.id, clause.body]));
  return Object.freeze({
    version: loaded.version,
    /** 发现面：只有摘要，没有正文；冲突双方与责任人保持可见。 */
    discovered: Object.freeze(selection.selected.map((clause) => Object.freeze({
      id: clause.id,
      title: clause.title,
      summary: clause.summary,
      level: clause.level,
      owner: clause.owner,
      appliesTo: Object.freeze(clause.appliesTo.map((target) => Object.freeze({ ...target }))),
      references: Object.freeze([...clause.references]),
    }))),
    conflicts: selection.conflicts,
    excluded: selection.excluded,
    budget: selection.budget,
    registered: registration.registered,
    invocation: registration.invocation,
    /** 正文按需取用：发现面不展开，调用时才从已加载的装配中取出。 */
    bodyFor: (id) => bodies.get(id),
    /** 动作前可见性：给定动作的适用硬要求（id + 摘要），由能力入口在真实动作前展示。 */
    constraintsFor: (action) => Object.freeze(
      preActionConstraints({ selection, action }).map((clause) => Object.freeze({ id: clause.id, summary: clause.summary, owner: clause.owner })),
    ),
    dispose: () => registration.dispose(),
  });
}
