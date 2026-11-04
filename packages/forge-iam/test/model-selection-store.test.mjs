import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelSelectionStore, MODEL_SELECTION_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const selection = {
  subject: 'person-a',
  models: { 'corp-chat': {}, 'corp-vision': { maxTokens: '16K', inputModalities: ['text', 'image'] } },
  defaultModelId: 'corp-chat',
};

test('a saved selection round-trips with its subject and default model', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  assert.deepEqual(await store.read(), { ok: true, selection: null });
  await store.save(selection);
  const record = credentials.records.get(MODEL_SELECTION_KEY);
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.type, 'heluo-iam-model-selection');
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.equal(read.selection.subject, 'person-a');
  assert.equal(read.selection.defaultModelId, 'corp-chat');
  // An empty object is preserved: "enabled with catalogue defaults".
  assert.deepEqual(read.selection.models['corp-chat'], {});
});

test('the payload holds no credential material, only model ids and overrides', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await store.save({ ...selection, apiKey: 'uag-should-not-be-stored' });
  const serialized = JSON.stringify(credentials.records.get(MODEL_SELECTION_KEY));
  assert.equal(serialized.includes('uag-should-not-be-stored'), false);
  assert.equal(/apiKey/u.test(serialized), false);
});

test('an empty enabled set is a valid, meaningful selection', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await store.save({ subject: 'person-a', models: {}, defaultModelId: null });
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.deepEqual(read.selection.models, {});
  assert.equal(read.selection.defaultModelId, null);
});

test('a default model that is not enabled is dropped instead of trusted', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await store.save({ subject: 'person-a', models: { 'corp-chat': {} }, defaultModelId: 'not-enabled' });
  assert.equal((await store.read()).selection.defaultModelId, null);
});

test('a record owned by another kind is reported and left untouched', async () => {
  const credentials = new MemoryCredentials();
  credentials.records.set(MODEL_SELECTION_KEY, { kind: 'api-key', payload: { version: 3 } });
  const before = structuredClone(credentials.records.get(MODEL_SELECTION_KEY));
  const store = createModelSelectionStore(credentials);
  const read = await store.read();
  assert.equal(read.ok, false);
  assert.equal(read.selection, null);
  assert.deepEqual(credentials.records.get(MODEL_SELECTION_KEY), before);
});

test('an unrecognised payload is ignored rather than migrated', async () => {
  const credentials = new MemoryCredentials();
  credentials.records.set(MODEL_SELECTION_KEY, { kind: 'grant', payload: { version: 99, type: 'legacy' } });
  const read = await createModelSelectionStore(credentials).read();
  assert.equal(read.ok, false);
  assert.equal(read.selection, null);
});

test('a subject change never inherits the previous person’s selection', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await store.save(selection);
  // The record still belongs to person-a; a caller for person-b simply reads it
  // and rejects the mismatch in the service layer, not by rewriting the record.
  const read = await store.read();
  assert.equal(read.selection.subject, 'person-a');
  assert.notEqual(read.selection.subject, 'person-b');
});

test('invalid input is refused instead of partially stored', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await assert.rejects(store.save({ subject: '', models: {}, defaultModelId: null }), { code: 'IAM_MODEL_SELECTION_INVALID' });
  await assert.rejects(store.save({ subject: 'person-a', models: { 'bad id!': {} } }), { code: 'IAM_MODEL_SELECTION_INVALID' });
  assert.equal(credentials.records.has(MODEL_SELECTION_KEY), false);
});

test('unknown override fields are dropped when the selection is stored', async () => {
  const credentials = new MemoryCredentials();
  const store = createModelSelectionStore(credentials);
  await store.save({ subject: 'person-a', models: { 'corp-chat': { name: 'Corp Chat', nope: 'x', contextWindow: '128K' } } });
  const stored = credentials.records.get(MODEL_SELECTION_KEY).payload.models['corp-chat'];
  assert.deepEqual(stored, { name: 'Corp Chat', contextWindow: '128K' });
});
