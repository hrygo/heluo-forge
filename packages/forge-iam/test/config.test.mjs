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
test('redirectUri must use the configured callback path', () => {
  const result = validateConfig({ redirectUri: 'https://app.example/other' });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('redirectUri')), true);
});

test('redirectPath rejects query and fragment', () => {
  const result = validateConfig({ redirectPath: '/iam/callback?x=1' });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('redirectPath')), true);
});

test('an absolute redirectUri matching redirectPath is accepted', () => {
  const result = validateConfig({ redirectUri: 'https://app.example/iam/callback' });
  assert.ok('value' in result);
  assert.equal(result.value.redirectUri, 'https://app.example/iam/callback');
});

test('non-loopback redirectUri cannot use plaintext HTTP', () => {
  const result = validateConfig({ redirectUri: 'http://app.example/iam/callback' });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('redirectUri')), true);
});

test('RP logout requires an end-session endpoint', () => {
  const result = validateConfig({ logoutMode: 'rp' });
  assert.equal('issues' in result, true);
  assert.equal(result.issues.some((issue) => issue.path.includes('endSessionEndpoint')), true);
});

test('a gateway console URL is optional but must be absolute http(s)', () => {
  const ok = validateConfig({ clientId: 'c', discoveryUrl: 'https://iam.example/.well-known', gatewayConsoleUrl: 'https://uag.example/console' });
  assert.equal(ok.issues, undefined);
  assert.equal(ok.value.gatewayConsoleUrl, 'https://uag.example/console');
  const bad = validateConfig({ gatewayConsoleUrl: 'javascript:alert(1)' });
  assert.equal(bad.issues[0].path[0], 'gatewayConsoleUrl');
  assert.deepEqual(validateConfig({}).value.gatewayConsoleUrl, '');
});

test('a gateway audience is no longer required to configure IAM', () => {
  const result = validateConfig({
    clientId: 'c',
    issuer: 'https://iam.example',
    authorizationEndpoint: 'https://iam.example/authorize',
    tokenEndpoint: 'https://iam.example/token',
    jwksUri: 'https://iam.example/jwks',
  });
  assert.equal(result.issues, undefined);
  assert.equal(isConfigured(result.value).ok, true);
  assert.deepEqual(isConfigured(result.value).missing, []);
});
