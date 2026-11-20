/**
 * 0–10 判定流水线骨架（TECH-CHANGE §3.3）。
 *
 * 阶段表是装配产物而不是判定分支：关闭的规则在 `buildPipeline` 里根本不出现，
 * 因此不会"进入后 return allow"，也不会因为走过阶段而多写一条审计。P0 只有
 * resolve / identity / audit / receipt 四个常开阶段。
 */

import { IMPLEMENTED_RULES } from './config.mjs';

export const STAGE = Object.freeze({
  RESOLVE: 'resolve',
  DELEGATION: 'delegation',
  IDENTITY: 'identity',
  UNKNOWN_ACTION: 'unknown-action',
  HUMAN_RECORD: 'human-record',
  PROTECTED_PATHS: 'protected-paths',
  PROCESS_RULES: 'process-rules',
  CONTENT_GATE: 'content-gate',
  CONFIRMATION: 'confirmation',
  AUDIT: 'audit',
  RECEIPT: 'receipt',
});

/** 阶段与规则开关的对应关系；未实现的开关永远不会生成阶段。 */
export const STAGE_RULES = Object.freeze({
  [STAGE.DELEGATION]: Object.freeze(['denyDelegatedWrites']),
  [STAGE.UNKNOWN_ACTION]: Object.freeze(['denyUnknownAction']),
  [STAGE.HUMAN_RECORD]: Object.freeze(['denyHumanRecord']),
  [STAGE.PROTECTED_PATHS]: Object.freeze(['protectPaths']),
  [STAGE.PROCESS_RULES]: Object.freeze(['enforceProcessRules']),
  [STAGE.CONTENT_GATE]: Object.freeze(['contentGate']),
  [STAGE.CONFIRMATION]: Object.freeze(['confirmPush', 'confirmDopWrite']),
});

const ORDER = Object.freeze([
  STAGE.RESOLVE,
  STAGE.DELEGATION,
  STAGE.IDENTITY,
  STAGE.UNKNOWN_ACTION,
  STAGE.HUMAN_RECORD,
  STAGE.PROTECTED_PATHS,
  STAGE.PROCESS_RULES,
  STAGE.CONTENT_GATE,
  STAGE.CONFIRMATION,
  STAGE.AUDIT,
  STAGE.RECEIPT,
]);

/**
 * @param {object} [rules]
 * @returns {readonly {stage: string, rule: string | null}[]} the stages actually assembled
 */
export function buildPipeline(rules = {}) {
  const stages = [];
  for (const stage of ORDER) {
    const stageRules = STAGE_RULES[stage];
    if (stageRules === undefined) {
      stages.push(Object.freeze({ stage, rule: null }));
      continue;
    }
    const enabled = stageRules.find((rule) => rules?.[rule] === true && IMPLEMENTED_RULES.includes(rule));
    if (enabled !== undefined) stages.push(Object.freeze({ stage, rule: enabled }));
  }
  return Object.freeze(stages);
}

/**
 * @param {object} [rules]
 * @returns {string[]} enabled-and-implemented rules, in stage order
 */
export function activeRules(rules = {}) {
  return buildPipeline(rules).map((stage) => stage.rule).filter((rule) => rule !== null);
}

/**
 * Observe-only means every rule is off: the gate only records, never blocks.
 *
 * @param {object} [rules]
 */
export function isObserveOnly(rules = {}) {
  return activeRules(rules).length === 0;
}
