import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  DEFAULT_RULES,
  IMPLEMENTED_RULES,
  RULE_KEYS,
  resolveConfig,
  validateConfig,
} from '../src/config.mjs';

const WRITE = { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' };

test('the seven rule keys are all off by default; P2 implements three of them', () => {
  assert.deepEqual([...RULE_KEYS].sort(), [
    'confirmDopWrite', 'confirmPush', 'contentGate',
    'denyHumanRecord', 'denyUnknownAction', 'enforceProcessRules', 'protectPaths',
  ]);
  assert.equal(RULE_KEYS.length, 7);
  for (const key of RULE_KEYS) assert.equal(DEFAULT_RULES[key], false, `${key} defaults to off`);
  assert.deepEqual([...IMPLEMENTED_RULES].sort(), ['confirmDopWrite', 'confirmPush', 'contentGate']);
  assert.equal(DEFAULT_CONFIRMATION_TIMEOUT_MS, 120_000);
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

test('the four implemented switches can be enabled and keep their defaults off', () => {
  for (const key of IMPLEMENTED_RULES) {
    const result = validateConfig({ rules: { [key]: true } });
    assert.equal(result.issues, undefined, `${key} is implemented in this phase`);
    assert.equal(resolveConfig({ rules: { [key]: true } }).rules[key], true);
  }
});

test('validation reports every problem at once with key paths', () => {
  const { issues } = validateConfig({
    catalog: [
      WRITE,
      { ...WRITE },
      { action: 'gitee.pr.write', target: 'issue', category: 'dev-write' },
      { ...WRITE, action: 'gitee.repository.read' },
    ],
    rules: { protectPaths: true, nope: false },
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
  assert.match(joined, /rules\.protectPaths.*not implemented/u);
  assert.match(joined, /rules\.nope.*unknown/u);
  assert.match(joined, /confirmation\.timeoutMs/u);
  assert.match(joined, /content\.maxBytes/u);
  assert.match(joined, /paths\.append/u);
  assert.match(joined, /audit\.sink/u);
  assert.match(joined, /audit\.buffer/u);
  assert.match(joined, /tools\.forge\.issue/u);
  assert.match(joined, /categories: not implemented/u);
  assert.match(joined, /onDecision/u);
  assert.match(joined, /protectedPaths: not implemented/u);
});

test('unknown top-level keys are rejected', () => {
  const { issues } = validateConfig({ approvals: [], enforce: true, sandbox: 'off' });
  assert.deepEqual(issues, [
    'approvals: unknown config key',
    'enforce: unknown config key',
    'sandbox: unknown config key',
  ]);
});

test('the wired config surfaces are accepted', () => {
  const kept = validateConfig({
    tools: {},
    observation: {},
    env: { DSH_HOME: '/tmp/x' },
    onDecision() {},
    audit: { sink: 'file', buffer: 10, keepDays: 1, timeoutMs: 100 },
  });
  assert.equal(kept.issues, undefined);
});

test('a surface that is not wired into the decision path is refused at load time', () => {
  const cases = [
    ['categories', { categories: { bash: 'shell.execute' } }],
    ['protectedPaths', { protectedPaths: ['$DSH_HOME/**'] }],
    ['paths.append', { paths: { append: ['$DSH_HOME/secrets/**'] } }],
  ];
  for (const [label, input] of cases) {
    const { issues } = validateConfig(input);
    assert.equal(issues.length, 1, `${label} is refused on its own`);
    assert.match(issues[0], /not implemented in this phase/u);
    assert.match(issues[0], new RegExp(label.replace('.', '\\.'), 'u'), `${label} is named`);
    assert.throws(
      () => resolveConfig(input),
      (error) => error.code === 'POLICY_CONFIG_INVALID',
      `${label} cannot resolve`,
    );
  }
  // content 段已接入内容闸：可以设置，并会带进解析结果作为扫描预算。
  assert.equal(validateConfig({ content: { maxBytes: 1_024 } }).issues, undefined);
  assert.deepEqual(resolveConfig({ content: { maxBytes: 1_024 } }).content, { maxBytes: 1_024 });
  assert.deepEqual(resolveConfig({}).content, { maxBytes: 262_144 });
  // 空值等同于没配：默认层保持原样，插件照常装配。
  assert.equal(validateConfig({ categories: {}, paths: { append: [] } }).issues, undefined);
  const defaults = resolveConfig({});
  assert.deepEqual(defaults.paths, { append: [] });
  assert.deepEqual(defaults.categories, {});
  assert.deepEqual(defaults.confirmation, { timeoutMs: 120_000 });
  assert.deepEqual(defaults.content, { maxBytes: 262_144 });
});

test('the four switches without an implementation still refuse to resolve, naming the key', () => {
  const pending = RULE_KEYS.filter((key) => !IMPLEMENTED_RULES.includes(key));
  assert.equal(pending.length, 4);
  for (const key of pending) {
    const { issues } = validateConfig({ rules: { [key]: true } });
    assert.equal(issues.length, 1);
    assert.match(issues[0], new RegExp(`rules\\.${key}`));
    assert.throws(() => resolveConfig({ rules: { [key]: true } }), (error) => error.code === 'POLICY_CONFIG_INVALID');
  }
});

test('the confirmation section only accepts a positive timeoutMs', () => {
  assert.deepEqual(validateConfig({ confirmation: { timeoutMs: 500 } }).value.confirmation, { timeoutMs: 500 });
  for (const timeoutMs of [0, -1, 1.5, '120000']) {
    const { issues } = validateConfig({ confirmation: { timeoutMs } });
    assert.deepEqual(issues, ['confirmation.timeoutMs: must be a positive integer'], `timeoutMs ${timeoutMs}`);
  }
  // 写进配置却没人读的键在装载期就报错，避免"配了以为生效"。
  assert.deepEqual(validateConfig({ confirmation: { timeout: 10 } }).issues, ['confirmation.timeout: unknown config key']);
});

test('Config exposes a Standard Schema validator', () => {
  assert.equal(Config['~standard'].version, 1);
  assert.equal(Config['~standard'].vendor, 'heluo');
  assert.equal(typeof Config['~standard'].validate, 'function');
  const ok = Config['~standard'].validate({ catalog: [WRITE] });
  assert.deepEqual(ok.value.catalog, [WRITE]);
  assert.equal(Config['~standard'].validate({ rules: { confirmPush: true } }).issues, undefined);
  assert.equal(Config['~standard'].validate({ rules: { protectPaths: true } }).issues.length, 1);
});
