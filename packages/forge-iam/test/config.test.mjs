import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, isConfigured, validateConfig, CONFIG_FIELDS } from '../src/config.mjs';

test('normalizes defaults without inventing IAM endpoints', () => {
  const result = validateConfig({});
  assert.ok('value' in result);
  assert.deepEqual(result.value.scopes, ['openid', 'profile', 'offline_access']);
  assert.equal(result.value.redirectPath, '/iam/callback');
  assert.equal(result.value.logoutMode, 'local');
  assert.equal(result.value.requireExclusive, true);
  assert.equal(result.value.refreshSkewSeconds, 60);
  assert.equal(result.value.attemptTimeoutSeconds, 300);
  assert.equal(result.value.httpTimeoutMs, 10000);
  assert.equal(result.value.refreshTimeoutMs, 5000);
  assert.equal(result.value.allowInsecureHttp, false);
  assert.equal(result.value.issuer, '');
  assert.equal(isConfigured(result.value).ok, false);
});

test('a discovery URL plus client id and gateway audience is enough to be configured', () => {
  const result = validateConfig({
    discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
    clientId: 'dsh-desktop',
    gatewayResource: 'https://gateway.corp.example',
  });
  assert.ok('value' in result);
  assert.deepEqual(isConfigured(result.value), { ok: true, missing: [] });
});

test('explicit endpoints can replace discovery', () => {
  const result = validateConfig({
    issuer: 'https://iam.corp.example',
    authorizationEndpoint: 'https://iam.corp.example/authorize',
    tokenEndpoint: 'https://iam.corp.example/token',
    jwksUri: 'https://iam.corp.example/jwks',
    clientId: 'dsh-desktop',
    gatewayResource: 'https://gateway.corp.example',
  });
  assert.ok('value' in result);
  assert.equal(isConfigured(result.value).ok, true);
});

test('missing endpoints stay unconfigured instead of falling back', () => {
  const result = validateConfig({ clientId: 'dsh-desktop', gatewayResource: 'https://gateway.corp.example' });
  assert.ok('value' in result);
  const check = isConfigured(result.value);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri']);
});

test('rejects invalid enums, paths and types', () => {
  const result = validateConfig({
    logoutMode: 'browser',
    redirectPath: 'iam/callback',
    scopes: ['openid', ''],
    refreshSkewSeconds: -1,
    requireExclusive: 'yes',
  });
  assert.ok('issues' in result);
  const paths = result.issues.map((entry) => entry.path[0]);
  assert.ok(paths.includes('logoutMode'));
  assert.ok(paths.includes('redirectPath'));
  assert.ok(paths.includes('scopes'));
  assert.ok(paths.includes('refreshSkewSeconds'));
  assert.ok(paths.includes('requireExclusive'));
});

test('the standard-schema adapter is synchronous and returns issues', () => {
  const adapter = Config['~standard'];
  assert.equal(adapter.version, 1);
  const ok = adapter.validate({ clientId: 'x' });
  assert.ok('value' in ok);
  const bad = adapter.validate({ logoutMode: 'nope' });
  assert.ok('issues' in bad);
  assert.ok(CONFIG_FIELDS.includes('gatewayResource'));
});

test('non-object config is rejected', () => {
  for (const input of [null, 'x', 1, []]) {
    const result = validateConfig(input);
    assert.ok('issues' in result);
  }
});
test('refresh timeout is capped to the lock-hold budget', () => {
  const result = validateConfig({ refreshTimeoutMs: 5001 });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('refreshTimeoutMs')), true);
});

test('RP logout requires an end-session endpoint', () => {
  const result = validateConfig({ logoutMode: 'rp' });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('endSessionEndpoint')), true);
});
