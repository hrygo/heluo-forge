import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig, CATALOG_MODES, DEFAULT_CONFIG } from '../src/config.mjs';
import { REASONS } from '../src/errors.mjs';
import { baseConfig } from './helpers.mjs';

const valid = (overrides) => validateConfig(baseConfig('https://nacos.corp.example', overrides)).value;

test('required fields default to a complete config', () => {
  const config = valid();
  assert.equal(config.catalogMode, 'console-list');
  assert.equal(config.providerName, 'nacos');
  assert.equal(config.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs);
  assert.equal(config.installStoreQuotaBytes, DEFAULT_CONFIG.installStoreQuotaBytes);
});

test('missing required fields fail loud', () => {
  for (const key of ['endpoint', 'namespaceId', 'credentialRecordId']) {
    const input = baseConfig('https://nacos.corp.example');
    delete input[key];
    assert.throws(() => validateConfig(input), (error) => error.code === REASONS.CONFIG_INVALID && error.detail.issues.some((issue) => issue.includes(key)));
  }
});

test('endpoint must be http(s) and mode must be known', () => {
  assert.throws(() => validateConfig(baseConfig('nacos.corp.example')), (error) => error.code === REASONS.CONFIG_INVALID);
  assert.throws(() => validateConfig(baseConfig('https://nacos.corp.example', { catalogMode: 'magic' })), (error) => error.code === REASONS.CONFIG_INVALID);
  assert.deepEqual(CATALOG_MODES, ['console-list', 'client-search', 'config-index']);
});

test('config-index mode requires its dataId', () => {
  assert.throws(
    () => validateConfig(baseConfig('https://nacos.corp.example', { catalogMode: 'config-index' })),
    (error) => error.code === REASONS.CONFIG_INVALID,
  );
  assert.equal(valid({ catalogMode: 'config-index', configIndexDataId: 'skill-index.json' }).configIndexDataId, 'skill-index.json');
});

test('numeric bounds are enforced', () => {
  assert.throws(() => validateConfig(baseConfig('https://nacos.corp.example', { maxFileCount: 0 })), (error) => error.code === REASONS.CONFIG_INVALID);
  assert.throws(() => validateConfig(baseConfig('https://nacos.corp.example', { requestTimeoutMs: -1 })), (error) => error.code === REASONS.CONFIG_INVALID);
  assert.equal(valid({ catalogRefreshIntervalMs: 0 }).catalogRefreshIntervalMs, 0); // 0 = 仅手动
});

test('caFile stays unsupported until the CA channel is verified', () => {
  assert.throws(
    () => validateConfig(baseConfig('https://nacos.corp.example', { caFile: '/tmp/ca.pem' })),
    (error) => error.code === REASONS.CONFIG_INVALID && /caFile/.test(error.message),
  );
});
