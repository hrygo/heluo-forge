// Synthetic in-memory store faults, not claims about an IdP or honest writers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createIamService } from './support/trusted-service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const KEY = 'heluo-iam/session';
const config = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const id = 'A'.repeat(43);
const priorMarker = { version: 1, state: 'complete', id: 'B'.repeat(42) + 'A', base: 'C'.repeat(42) + 'A' };
const now = () => Date.parse('2026-01-01T01:00:00.000Z');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function baseOf(grant, operationId) {
  return createHmac('sha256', operationId).update(JSON.stringify(canonical(grant))).digest('base64url');
}

function initialGrant() {
  return {
    version: 1, issuer: config.issuer, subject: 'original-subject', clientId: config.clientId,
    resource: config.gatewayResource, scope: 'openid profile offline_access',
    obtainedAt: '2026-01-01T00:00:00.000Z', refreshToken: 'synthetic-original-refresh',
    accessToken: 'synthetic-old-access', accessExpiresAt: '2026-01-01T00:00:00.000Z',
    refreshOperation: { ...priorMarker },
  };
}

function completeFrom(initial, overrides = {}) {
  return {
    ...initial, refreshToken: 'synthetic-rotated-refresh', accessToken: 'synthetic-new-access',
    accessExpiresAt: '2026-01-01T02:00:00.000Z',
    refreshOperation: { version: 1, state: 'complete', id, base: baseOf(initial, id) },
    ...overrides,
  };
}

function fetchDouble() {
  let posts = 0;
  const fetch = async (url, init = {}) => {
    if (String(url) === config.jwksUri) return Response.json({ keys: [] });
    if (String(url) === config.tokenEndpoint && init.method === 'POST') {
      posts += 1;
      return Response.json({ access_token: 'synthetic-response-access', token_type: 'Bearer', expires_in: 3600,
        refresh_token: 'synthetic-response-refresh' });
    }
    throw new Error('unexpected synthetic endpoint');
  };
  return { fetch, posts: () => posts };
}

// Replace the shared record after the initial read but before the locked claim.
function injectBeforeClaim(credentials, replacement) {
  const modify = credentials.modifyRecord.bind(credentials);
  let injected = false;
  credentials.modifyRecord = async (key, mutate) => {
    if (key === KEY && !injected) {
      injected = true;
      credentials.records.set(key, { kind: 'grant', payload: replacement });
    }
    return modify(key, mutate);
  };
  return () => injected;
}

for (const [name, change] of [
  ['subject', { subject: 'different-subject' }],
  ['issuer', { issuer: 'https://different.corp.example' }],
  ['clientId', { clientId: 'different-client' }],
  ['resource', { resource: 'https://different.corp.example' }],
  ['obtainedAt', { obtainedAt: '2026-01-01T00:00:01.000Z' }],
  ['unchanged refresh', { refreshToken: 'synthetic-original-refresh' }],
  ['missing access', { accessToken: undefined, accessExpiresAt: undefined }],
  ['expired access', { accessExpiresAt: '2026-01-01T00:59:59.000Z' }],
]) {
  test(`claim loser rejects complete with ${name}`, async (t) => {
    const credentials = new MemoryCredentials();
    const initial = initialGrant();
    credentials.records.set(KEY, { kind: 'grant', payload: initial });
    const injected = injectBeforeClaim(credentials, completeFrom(initial, change));
    const network = fetchDouble();
    const service = createIamService(config, { credentials, fetch: network.fetch, now });
    t.after(() => service.dispose());
    // Never put synthetic token values into assertion failure output.
    const result = await service.resolveToken().then(() => ({ accepted: true }), (error) => ({ accepted: false, code: error.code }));
    assert.equal(injected(), true, 'the claim-failed branch must be exercised');
    assert.equal(network.posts(), 0, 'a losing claim must never POST');
    assert.notEqual(service.getView().state, 'ready');
    assert.equal(result.accepted, false, 'the completion must fail closed');
  });
}

test('claim loser accepts valid completion bound to the entire previous-marker record', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = initialGrant();
  credentials.records.set(KEY, { kind: 'grant', payload: initial });
  const injected = injectBeforeClaim(credentials, completeFrom(initial));
  const network = fetchDouble();
  const service = createIamService(config, { credentials, fetch: network.fetch, now });
  t.after(() => service.dispose());
  const accepted = await service.resolveToken().then((value) => value === 'synthetic-new-access', () => false);
  assert.equal(injected(), true);
  assert.equal(accepted, true);
  assert.equal(service.getView().state, 'ready');
  assert.equal(network.posts(), 0);
});

test('claim loser rejects pending whose base omits the prior complete marker', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = initialGrant();
  credentials.records.set(KEY, { kind: 'grant', payload: initial });
  const { refreshOperation: ignored, ...withoutPreviousMarker } = initial;
  const marker = { version: 1, state: 'pending', id, base: baseOf(withoutPreviousMarker, id) };
  const pending = { ...initial, refreshOperation: marker };
  const injected = injectBeforeClaim(credentials, pending);
  const read = credentials.readRecord.bind(credentials);
  let afterClaim = false;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key !== KEY || !injected()) return record;
    if (!afterClaim) { afterClaim = true; return record; }
    return { kind: 'grant', payload: { ...completeFrom(initial), refreshOperation: { ...marker, state: 'complete' } } };
  };
  const network = fetchDouble();
  const service = createIamService(config, { credentials, fetch: network.fetch, now });
  t.after(() => service.dispose());
  const result = await service.resolveToken().then(() => ({ accepted: true }), (error) => ({ accepted: false, code: error.code }));
  assert.equal(injected(), true);
  assert.equal(network.posts(), 0);
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(result.accepted, false, 'pending must bind the complete original record');
});

test('concurrent refresh from a previous completion uses one POST and binds the full record', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = initialGrant();
  credentials.records.set(KEY, { kind: 'grant', payload: initial });
  let jwksCount = 0;
  let releaseJwks;
  const bothJwks = new Promise((resolve) => { releaseJwks = resolve; });
  let releaseContender;
  const contenderClaimed = new Promise((resolve) => { releaseContender = resolve; });
  let attempts = 0;
  let posts = 0;
  let observedPending;
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = async (key, mutate) => {
    const result = await modify(key, mutate);
    if (key === KEY && ++attempts === 2) releaseContender();
    return result;
  };
  const fetch = async (url, init = {}) => {
    if (String(url) === config.jwksUri) {
      if (++jwksCount === 2) releaseJwks();
      await bothJwks;
      return Response.json({ keys: [] });
    }
    if (String(url) === config.tokenEndpoint && init.method === 'POST') {
      posts += 1;
      observedPending = (await credentials.readRecord(KEY)).payload.refreshOperation;
      await contenderClaimed;
      return Response.json({ access_token: 'synthetic-response-access', token_type: 'Bearer', expires_in: 3600,
        refresh_token: 'synthetic-response-refresh' });
    }
    throw new Error('unexpected synthetic endpoint');
  };
  const services = [createIamService(config, { credentials, fetch, now }), createIamService(config, { credentials, fetch, now })];
  t.after(() => { releaseJwks(); releaseContender(); return Promise.all(services.map((service) => service.dispose())); });
  const results = await Promise.all(services.map((service) => service.resolveToken().then(
    (value) => value === 'synthetic-response-access', () => false,
  )));
  const { refreshOperation: ignored, ...withoutPreviousMarker } = initial;
  assert.deepEqual(results, [true, true]);
  assert.equal(posts, 1);
  assert.equal(observedPending?.state, 'pending');
  assert.equal(observedPending?.base === baseOf(initial, observedPending.id), true);
  assert.equal(observedPending?.base === baseOf(withoutPreviousMarker, observedPending.id), false);
  assert.equal((await credentials.readRecord(KEY)).payload.refreshOperation.state, 'complete');
  assert.equal(services.every((service) => service.getView().state === 'ready'), true);
});
