import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  DEFAULT_RULES,
  IMPLEMENTED_RULES,
  RULE_KEYS,
  resolveConfig,
  validateConfig,
} from '../src/config.mjs';

const WRITE = { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' };

test('the eight rule keys are all off by default and none is implemented yet', () => {
  assert.deepEqual([...RULE_KEYS].sort(), [
    'confirmDopWrite', 'confirmPush', 'contentGate', 'denyDelegatedWrites',
    'denyHumanRecord', 'denyUnknownAction', 'enforceProcessRules', 'protectPaths',
  ]);
  assert.equal(RULE_KEYS.length, 8);
  for (const key of RULE_KEYS) assert.equal(DEFAULT_RULES[key], false, `${key} defaults to off`);
  assert.deepEqual(IMPLEMENTED_RULES, [], 'P0 implements no switch');
});

test('resolveConfig fills the documented defaults', () => {
  const config = resolveConfig({});
  assert.deepEqual(config.catalog, []);
  assert.deepEqual(config.confirmation, { timeoutMs: 120_000 });
  assert.deepEqual(config.content, { maxBytes: 262_144 });
  assert.deepEqual(config.paths, { append: [] });
  assert.deepEqual(config.audit, { sink: 'memory', buffer: 1_000, keepDays: 7, timeoutMs: 2_000 });
  assert.deepEqual(config.tools, {});
  assert.deepEqual(config.categories, {});
  assert.equal(Object.isFrozen(config.confirmation), true);
  assert.equal(Object.isFrozen(config.audit), true);
});

test('validation reports every problem at once with key paths', () => {
  const { issues } = validateConfig({
    catalog: [
      WRITE,
      { ...WRITE },
      { action: 'gitee.pr.write', target: 'issue', category: 'dev-write' },
      { ...WRITE, action: 'gitee.repository.read' },
    ],
    rules: { confirmPush: true, nope: false },
    confirmation: { timeoutMs: 0 },
    content: { maxBytes: -1 },
    paths: { append: 'not-an-array' },
    audit: { sink: 'cpu', buffer: 1.5 },
    tools: { 'forge.issue': 42 },
    categories: { bash: '' },
    onDecision: 'nope',
    protectedPaths: ['ok', ''],
  });
  const joined = issues.join('; ');
  assert.match(joined, /catalog\[1\]/u, 'duplicates are located');
  assert.match(joined, /catalog\[2\].*(target|category)/u);
  assert.match(joined, /catalog\[3\].*read action/u);
  assert.match(joined, /rules\.confirmPush.*not implemented/u);
  assert.match(joined, /rules\.nope.*unknown/u);
  assert.match(joined, /confirmation\.timeoutMs/u);
  assert.match(joined, /content\.maxBytes/u);
  assert.match(joined, /paths\.append/u);
  assert.match(joined, /audit\.sink/u);
  assert.match(joined, /audit\.buffer/u);
  assert.match(joined, /tools\.forge\.issue/u);
  assert.match(joined, /categories\.bash/u);
  assert.match(joined, /onDecision/u);
  assert.match(joined, /protectedPaths\[1\]/u);
});

test('unknown top-level keys are rejected; the kept config surfaces are accepted', () => {
  const { issues } = validateConfig({ approvals: [], enforce: true, sandbox: 'off' });
  assert.deepEqual(issues, [
    'approvals: unknown config key',
    'enforce: unknown config key',
    'sandbox: unknown config key',
  ]);
  const kept = validateConfig({
    tools: {},
    categories: {},
    observation: {},
    env: { DSH_HOME: '/tmp/x' },
    onDecision() {},
    protectedPaths: ['$DSH_HOME/**'],
  });
  assert.equal(kept.issues, undefined, 'the legacy config surfaces stay accepted');
});

test('any switch that is not implemented refuses to resolve, naming the key', () => {
  for (const key of RULE_KEYS) {
    const { issues } = validateConfig({ rules: { [key]: true } });
    assert.equal(issues.length, 1);
    assert.match(issues[0], new RegExp(`rules\\.${key}`));
    assert.throws(() => resolveConfig({ rules: { [key]: true } }), (error) => error.code === 'POLICY_CONFIG_INVALID');
  }
});

test('Config exposes a Standard Schema validator', () => {
  assert.equal(Config['~standard'].version, 1);
  assert.equal(Config['~standard'].vendor, 'heluo');
  assert.equal(typeof Config['~standard'].validate, 'function');
  const ok = Config['~standard'].validate({ catalog: [WRITE] });
  assert.deepEqual(ok.value.catalog, [WRITE]);
  assert.deepEqual(Config['~standard'].validate({ rules: { confirmPush: true } }).issues.length, 1);
});
