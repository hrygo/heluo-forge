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
    for (const options of [
      { getOrigin: () => 'http://app.corp.example' },
      { getCallbackOrigin: () => 'http://app.corp.example' },
    ]) {
      const grant = createServiceGrant({ config: { redirectUri, redirectPath: '/iam/callback' }, options });
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
  const matchingLoopback = createServiceGrant({ config, options: { getCallbackOrigin: () => 'http://app.corp.example' } });
  assert.equal(matchingLoopback.redirectUri(), config.redirectUri);
  const mismatchedLoopback = createServiceGrant({ config, options: { getCallbackOrigin: () => 'http://other.corp.example' } });
  assert.throws(() => mismatchedLoopback.redirectUri(), { code: 'IAM_CONFIG_INVALID' });
});
