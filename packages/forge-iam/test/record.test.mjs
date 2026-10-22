import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRANT_VERSION,
  isAccessExpired,
  isRefreshUsable,
  parseGrant,
  shouldRefresh,
  summarizeGrant,
  validateGrant,
} from '../src/record.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');

function grant(overrides = {}) {
  return {
    version: GRANT_VERSION,
    issuer: 'https://iam.corp.example',
    subject: 'E1001',
    clientId: 'dsh-desktop',
    refreshToken: 'refresh-placeholder',
    scope: 'openid profile offline_access',
    resource: 'https://gateway.corp.example',
    obtainedAt: '2029-12-31T23:55:00.000Z',
    accessToken: 'access-placeholder',
    accessExpiresAt: '2030-01-01T00:05:00.000Z',
    refreshExpiresAt: '2030-01-08T00:00:00.000Z',
    ...overrides,
  };
}

test('a complete IamGrantV1 validates', () => {
  const result = validateGrant(grant());
  assert.equal(result.ok, true);
  assert.equal(result.value.subject, 'E1001');
});

test('version mismatch and missing required fields are rejected', () => {
  const result = validateGrant(grant({ version: 2, subject: '' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('version')));
  assert.ok(result.errors.some((error) => error.includes('subject')));
});

test('access token and expiry must move together', () => {
  const noExpiry = validateGrant(grant({ accessExpiresAt: undefined }));
  assert.equal(noExpiry.ok, false);
  assert.ok(noExpiry.errors.some((error) => error.includes('together')));

  const noToken = validateGrant(grant({ accessToken: undefined }));
  assert.equal(noToken.ok, false);
});

test('invalid dates are rejected', () => {
  const result = validateGrant(grant({ obtainedAt: 'not-a-date' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('ISO')));
});

test('parseGrant accepts JSON and rejects corrupt payloads', () => {
  const parsed = parseGrant(JSON.stringify(grant()));
  assert.equal(parsed.ok, true);
  const broken = parseGrant('{');
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0], /JSON/);
});

test('expiry and refresh decisions use the configured skew', () => {
  const value = grant();
  assert.equal(isAccessExpired(value, now), false);
  assert.equal(shouldRefresh(value, now, 60), false);
  assert.equal(shouldRefresh(value, now, 600), true);
  assert.equal(isAccessExpired(value, Date.parse('2030-01-01T00:06:00.000Z')), true);
  assert.equal(isRefreshUsable(value, now), true);
  assert.equal(isRefreshUsable(grant({ refreshExpiresAt: '2029-12-31T00:00:00.000Z' }), now), false);
});

test('a grant without an access token is treated as expired and in need of refresh', () => {
  const value = grant({ accessToken: undefined, accessExpiresAt: undefined });
  assert.equal(isAccessExpired(value, now), true);
  assert.equal(shouldRefresh(value, now, 60), true);
});

test('summarizeGrant never returns tokens', () => {
  const summary = summarizeGrant(grant());
  assert.equal(summary.subject, undefined);
  assert.equal(summary.principal, 'E1001');
  assert.equal('accessToken' in summary, false);
  assert.equal('refreshToken' in summary, false);
  assert.equal('idToken' in summary, false);
});