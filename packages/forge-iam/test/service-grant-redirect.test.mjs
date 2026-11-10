import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { createServiceGrant } from '../src/service-grant.mjs';

test('configuration and runtime reject the same invalid redirect URI shapes', () => {
  for (const redirectUri of [
    'ftp://app.corp.example/iam/callback',
    'http://app.corp.example/other',
    'http://app.corp.example/iam/callback?code=unexpected',
    'http://app.corp.example/iam/callback#fragment',
    'http://app.corp.example/iam/callback?',
    'http://app.corp.example/iam/callback#',
  ]) {
    assert.ok(validateConfig({ redirectUri }).issues?.some(issue => issue.path.includes('redirectUri')));
    for (const [configExtras, options] of [
      [{}, { getOrigin: () => 'http://app.corp.example' }],
      [{ callbackPort: 17890 }, { getCallbackOrigin: () => 'http://127.0.0.1:17890' }],
    ]) {
      const grant = createServiceGrant({ config: { ...configExtras, redirectUri, redirectPath: '/iam/callback' }, options });
      assert.throws(() => grant.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
    }
  }
});

test('runtime accepts a matching HTTP callback and rejects a mismatched live origin', () => {
  const config = { redirectUri: 'http://app.corp.example/iam/callback', redirectPath: '/iam/callback' };
  const matching = createServiceGrant({ config, options: { getOrigin: () => 'http://app.corp.example' } });
  assert.equal(matching.redirectUri(), config.redirectUri);
  const mismatched = createServiceGrant({ config, options: { getOrigin: () => 'http://other.corp.example' } });
  assert.throws(() => mismatched.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
});

test('runtime accepts a matching live loopback callback and rejects a mismatched one', () => {
  const config = {
    callbackPort: 17890,
    redirectUri: 'http://127.0.0.1:17890/iam/callback',
    redirectPath: '/iam/callback',
  };
  const matchingLoopback = createServiceGrant({ config, options: { getCallbackOrigin: () => 'http://127.0.0.1:17890' } });
  assert.equal(matchingLoopback.redirectUri(), config.redirectUri);
  const mismatchedLoopback = createServiceGrant({ config, options: { getCallbackOrigin: () => 'http://127.0.0.1:17891' } });
  assert.throws(() => mismatchedLoopback.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
});

test('runtime accepts a matching HTTPS callback and rejects a mismatched live origin', () => {
  const config = { redirectUri: 'https://app.corp.example/iam/callback', redirectPath: '/iam/callback' };
  const matching = createServiceGrant({ config, options: { getOrigin: () => 'https://app.corp.example' } });
  assert.equal(matching.redirectUri(), config.redirectUri);
  const mismatched = createServiceGrant({ config, options: { getOrigin: () => 'https://other.corp.example' } });
  assert.throws(() => mismatched.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
});

test('without callbackPort a matching host origin allows the redirect despite a different callback origin', () => {
  const config = { redirectUri: 'http://app.corp.example/iam/callback', redirectPath: '/iam/callback' };
  const matchingHost = createServiceGrant({
    config,
    options: { getOrigin: () => 'http://app.corp.example', getCallbackOrigin: () => 'http://other.corp.example' },
  });
  assert.equal(matchingHost.redirectUri(), config.redirectUri);
});

test('without callbackPort a mismatched host origin rejects the redirect despite a matching callback origin', () => {
  const config = { redirectUri: 'http://app.corp.example/iam/callback', redirectPath: '/iam/callback' };
  const mismatchedHost = createServiceGrant({
    config,
    options: { getOrigin: () => 'http://other.corp.example', getCallbackOrigin: () => 'http://app.corp.example' },
  });
  assert.throws(() => mismatchedHost.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
});

test('without callbackPort a callback origin cannot replace a missing host origin', () => {
  const config = { redirectUri: 'http://app.corp.example/iam/callback', redirectPath: '/iam/callback' };
  const grant = createServiceGrant({ config, options: { getCallbackOrigin: () => 'http://app.corp.example' } });
  assert.throws(() => grant.redirectUri(), { code: 'IAM_CALLBACK_UNAVAILABLE' });
});

for (const scheme of ['http', 'https']) {
  for (const [scenario, options] of [
    ['getOrigin is absent', {}],
    ['getOrigin returns undefined', { getOrigin: () => undefined }],
    ['getOrigin throws', { getOrigin: () => { throw new Error('host origin unavailable'); } }],
    ['getOrigin returns an invalid URL', { getOrigin: () => 'not a URL' }],
  ]) {
    test(`explicit ${scheme.toUpperCase()} redirect is unavailable when ${scenario}`, () => {
      const config = { redirectUri: `${scheme}://app.corp.example/iam/callback`, redirectPath: '/iam/callback' };
      const grant = createServiceGrant({ config, options });
      assert.throws(() => grant.redirectUri(), { code: 'IAM_CALLBACK_UNAVAILABLE' });
    });
  }
}

for (const [scenario, config] of [
  ['OS-assigned port', { callbackPort: 0, redirectPath: '/iam/callback' }],
  ['pinned port with derived redirect', { callbackPort: 17890, redirectPath: '/iam/callback' }],
  ['pinned port with explicit redirect', {
    callbackPort: 17890,
    redirectUri: 'http://127.0.0.1:17890/iam/callback',
    redirectPath: '/iam/callback',
  }],
]) {
  for (const [originScenario, callbackOptions] of [
    ['callback origin getter is absent', {}],
    ['callback origin is undefined', { getCallbackOrigin: () => undefined }],
  ]) {
    test(`${scenario} is unavailable when ${originScenario}, even with a host origin`, () => {
      const grant = createServiceGrant({
        config,
        options: { getOrigin: () => 'http://127.0.0.1:17890', ...callbackOptions },
      });
      assert.throws(() => grant.redirectUri(), { code: 'IAM_CALLBACK_UNAVAILABLE' });
    });
  }
}
