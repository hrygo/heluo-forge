import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Config,
  DEFAULTS,
  isLoopbackUrl,
  PLACEHOLDER_API_BASE_URL,
  resolveEnvConfig,
  validateConfig,
} from '../src/shared/config.mjs';
import { createRuntimeConfigStore } from '../src/shared/runtime-config.mjs';

test('config: undefined / null / {} normalize to DEFAULTS (empty apiBaseUrl, pure iam) and carry corp.example placeholder', () => {
  assert.equal(PLACEHOLDER_API_BASE_URL, 'https://dop.corp.example');
  assert.equal(DEFAULTS.apiBaseUrl, '');
  assert.equal(DEFAULTS.authMode, 'iam');

  for (const input of [undefined, null, {}]) {
    const out = Config['~standard'].validate(input);
    assert.ok('value' in out);
    assert.deepEqual(out.value, DEFAULTS);
  }
});

test('config: normalizes trailing slash and enforces pure iam authentication', () => {
  const iamCfg = validateConfig({
    enabled: true,
    apiBaseUrl: 'https://dop.corp.example/gateway///',
    authMode: 'iam',
    requestTimeoutMs: 15000,
  });
  assert.equal(iamCfg.apiBaseUrl, 'https://dop.corp.example/gateway');
  assert.equal(iamCfg.authMode, 'iam');
  assert.equal(iamCfg.requestTimeoutMs, 15000);
});

test('config: rejects credential mode, credentialRef, mock switches, squad fields, plaintext tokens and unknown keys', () => {
  const forbiddenPayloads = [
    { authMode: 'credential' },
    { authMode: 'mock' },
    { credentialRef: 'WORKBENCH_DOP_TOKEN' },
    { allowMock: true },
    { mock: true },
    { mockMode: 'local' },
    { squadId: 'team-1' },
    { activeSquadId: 'team-1' },
    { token: 'plain-secret' },
    { unknownKey: 123 },
  ];
  for (const payload of forbiddenPayloads) {
    const res = Config['~standard'].validate(payload);
    assert.ok('issues' in res, `expected issues for ${JSON.stringify(payload)}`);
    assert.throws(() => validateConfig(payload), TypeError);
  }
});

test('config: rejects unsafe schemes, userinfo, query/hash, and out-of-range timeout', () => {
  assert.ok('issues' in Config['~standard'].validate({ apiBaseUrl: 'javascript:alert(1)' }));
  assert.ok('issues' in Config['~standard'].validate({ apiBaseUrl: 'file:///tmp/x' }));
  const urlWithUserInfo = ['https://', 'demo-user', ':', 'demo-val', '@corp.example'].join('');
  assert.ok('issues' in Config['~standard'].validate({ apiBaseUrl: urlWithUserInfo }));
  assert.ok('issues' in Config['~standard'].validate({ apiBaseUrl: 'https://corp.example?a=1' }));
  assert.ok('issues' in Config['~standard'].validate({ requestTimeoutMs: 500 }));
  assert.ok('issues' in Config['~standard'].validate({ requestTimeoutMs: 60001 }));
  assert.ok('issues' in Config['~standard'].validate({ requestTimeoutMs: 1000.5 }));
});

test('resolveEnvConfig prioritizes HELUO_DOP_BASE_URL over FORGE_DEVOPS_DOP_ENDPOINT and ignores invalid values', () => {
  const preferred = resolveEnvConfig({
    HELUO_DOP_BASE_URL: 'https://dop.corp.example/',
    FORGE_DEVOPS_DOP_ENDPOINT: 'https://legacy.corp.example',
    HELUO_DOP_TIMEOUT_MS: '15000',
  });
  assert.equal(preferred.apiBaseUrl, 'https://dop.corp.example');
  assert.equal(preferred.matchedEnvKey, 'HELUO_DOP_BASE_URL');
  assert.equal(preferred.requestTimeoutMs, 15000);

  const fallback = resolveEnvConfig({
    FORGE_DEVOPS_DOP_ENDPOINT: 'https://legacy.corp.example/',
  });
  assert.equal(fallback.apiBaseUrl, 'https://legacy.corp.example');
  assert.equal(fallback.matchedEnvKey, 'FORGE_DEVOPS_DOP_ENDPOINT');

  const invalid = resolveEnvConfig({
    HELUO_DOP_BASE_URL: 'javascript:alert(1)',
    HELUO_DOP_TIMEOUT_MS: '999999',
  });
  assert.equal(invalid.apiBaseUrl, '');
  assert.equal(invalid.requestTimeoutMs, undefined);
  assert.deepEqual(invalid.invalidEnvKeys, ['HELUO_DOP_BASE_URL', 'HELUO_DOP_TIMEOUT_MS']);
});

test('runtime-config: persists only apiBaseUrl and requestTimeoutMs and strips credentialRef/token/squadId', (t) => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'wb-rt-cfg-'));
  const filePath = join(tmpDir, 'workbench-config.json');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = createRuntimeConfigStore({ filePath });
  assert.equal(store.readOverride(), null);

  const saved = store.writeOverride({
    apiBaseUrl: 'http://127.0.0.1:5610///',
    requestTimeoutMs: 12000,
    authMode: 'credential',
    credentialRef: 'WORKBENCH_DOP_TOKEN',
    token: 'should-be-stripped',
    squadId: 'should-be-stripped',
  });
  assert.equal(saved.apiBaseUrl, 'http://127.0.0.1:5610');
  assert.equal(saved.requestTimeoutMs, 12000);
  assert.equal('credentialRef' in saved, false);
  assert.equal('authMode' in saved, false);
  assert.equal(existsSync(filePath), true);

  const rawText = readFileSync(filePath, 'utf8');
  assert.equal(rawText.includes('should-be-stripped'), false);
  assert.equal(rawText.includes('credentialRef'), false);
  assert.equal(rawText.includes('token'), false);
  assert.equal(rawText.includes('squadId'), false);

  const loaded = store.readOverride();
  assert.deepEqual(loaded, saved);

  store.clearOverride();
  assert.equal(existsSync(filePath), false);
  assert.equal(store.readOverride(), null);
});

test('isLoopbackUrl distinguishes loopback endpoints from enterprise domains', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:5610'), true);
  assert.equal(isLoopbackUrl('http://localhost:5610/api'), true);
  assert.equal(isLoopbackUrl('http://[::1]:5610'), true);
  assert.equal(isLoopbackUrl('https://corp.example'), false);
  assert.equal(isLoopbackUrl(''), false);
  assert.equal(isLoopbackUrl('not-a-url'), false);
});
