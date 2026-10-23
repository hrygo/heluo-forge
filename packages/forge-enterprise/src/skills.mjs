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

/** Hard requirements that must be visible before the given action runs. */
export function preActionConstraints({ selection, action }) {
  return Object.freeze(
    selection.hard.filter((clause) =>
      clause.references.some((reference) => reference === action) || clause.decision === action || clause.appliesTo.length === 0),
  );
}
