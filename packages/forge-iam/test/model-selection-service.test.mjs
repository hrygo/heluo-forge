import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, MODEL_SELECTION_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
};

async function setup(t, { subject = 'synthetic-subject', expiresAt = new Date(now + 3600000).toISOString() } = {}) {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, clientId: config.clientId, subject,
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: expiresAt,
  });
  const service = createIamService(config, { credentials, now: () => now, fetch: async () => { throw new Error('no network permitted'); } });
  t.after(() => service.dispose());
  return { credentials, service };
}

test('a saved model selection is readable for the signed-in subject only', async (t) => {
  const f = await setup(t);
  assert.deepEqual(await f.service.readModelSelection(), { subject: 'synthetic-subject', saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 });
  const saved = await f.service.saveModelSelection({ models: { 'corp-chat': {} }, defaultModelId: 'corp-chat' });
  assert.equal(saved.subject, 'synthetic-subject');
  const read = await f.service.readModelSelection();
  assert.equal(read.saved, true);
  assert.deepEqual(read.models, { 'corp-chat': {} });
  assert.equal(read.defaultModelId, 'corp-chat');
});

test('another person’s stored selection reads as unsaved and is never rewritten', async (t) => {
  const f = await setup(t);
  await f.service.saveModelSelection({ models: { 'corp-chat': {} }, defaultModelId: 'corp-chat' });
  const before = structuredClone(f.credentials.records.get(MODEL_SELECTION_KEY));
  // Swap the bound grant to a different person under the same provider.
  await createGrantStore(f.credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-other',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
  const read = await f.service.readModelSelection();
  assert.equal(read.subject, 'synthetic-other');
  assert.equal(read.saved, false);
  assert.deepEqual(read.models, {});
  assert.deepEqual(f.credentials.records.get(MODEL_SELECTION_KEY), before);
});

test('saving needs a live sign-in and never stores credentials', async (t) => {
  const f = await setup(t, { expiresAt: new Date(now - 1000).toISOString() });
  await assert.rejects(f.service.saveModelSelection({ models: {}, defaultModelId: null }), { code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(f.credentials.records.has(MODEL_SELECTION_KEY), false);
});

test('a signed-out service reports no selection instead of an error', async (t) => {
  const credentials = new MemoryCredentials();
  const service = createIamService(config, { credentials, now: () => now, fetch: async () => { throw new Error('no network permitted'); } });
  t.after(() => service.dispose());
  assert.deepEqual(await service.readModelSelection(), { subject: null, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 });
  await assert.rejects(service.saveModelSelection({ models: {}, defaultModelId: null }), { code: 'IAM_NOT_SIGNED_IN' });
});
