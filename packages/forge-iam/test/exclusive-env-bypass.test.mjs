import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENV_BYPASS_VARIABLES,
  detectEnvBypass,
  formatEnvBypassWarning,
} from '../src/exclusive.mjs';
import { apply } from '../src/index.mjs';

test('the bypass list is frozen and names the official key', () => {
  assert.equal(Object.isFrozen(ENV_BYPASS_VARIABLES), true);
  assert.deepEqual([...ENV_BYPASS_VARIABLES], ['DEEPSEEK_API_KEY']);
});

test('an empty environment reports no bypass', () => {
  assert.deepEqual(detectEnvBypass({}), []);
  assert.deepEqual(detectEnvBypass(), []);
});

test('a present key is reported by name', () => {
  assert.deepEqual(detectEnvBypass({ DEEPSEEK_API_KEY: 'bypass-value-beta' }), ['DEEPSEEK_API_KEY']);
});

test('blank and non-string values are not bypasses', () => {
  assert.deepEqual(detectEnvBypass({ DEEPSEEK_API_KEY: '' }), []);
  assert.deepEqual(detectEnvBypass({ DEEPSEEK_API_KEY: '   ' }), []);
  assert.deepEqual(detectEnvBypass({ DEEPSEEK_API_KEY: 42 }), []);
  assert.deepEqual(detectEnvBypass({ DEEPSEEK_API_KEY: undefined }), []);
});

test('the diagnostic carries names only, never the value', () => {
  const line = formatEnvBypassWarning(detectEnvBypass({ DEEPSEEK_API_KEY: 'bypass-value-alpha' }));
  assert.equal(line, 'forge-iam: official bypass variables present: DEEPSEEK_API_KEY');
  assert.equal(line.includes('bypass-value-alpha'), false);
});

test('no bypass produces no line', () => {
  assert.equal(formatEnvBypassWarning([]), '');
});

const minimalConfig = {
  discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
  clientId: 'dsh-desktop',
};

function applyWith(env, config = minimalConfig) {
  const warnings = [];
  const provided = new Map();
  const ctx = {
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    get() {
      return undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
    logger: { warn: (line) => warnings.push(line) },
  };
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    apply(ctx, config);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return { warnings, provided };
}

test('apply reports a bypass at load with names only', () => {
  const { warnings, provided } = applyWith({ DEEPSEEK_API_KEY: 'bypass-value-alpha' });
  assert.deepEqual(warnings, ['forge-iam: official bypass variables present: DEEPSEEK_API_KEY']);
  assert.equal(warnings[0].includes('bypass-value-alpha'), false);
  assert.equal(provided.has('iam'), true);
});

test('apply stays quiet without a bypass and under the explicit opt-out', () => {
  assert.deepEqual(applyWith({}).warnings, []);
  assert.deepEqual(applyWith({ DEEPSEEK_API_KEY: 'bypass-value-beta' }, { ...minimalConfig, requireExclusive: false }).warnings, []);
});
