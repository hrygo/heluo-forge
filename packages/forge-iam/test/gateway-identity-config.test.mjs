import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { modelFetchOptions } from '../src/model-transport.mjs';
import {
  DEFAULT_EXCLUSIVE_SERVICES,
  checkExclusive,
  exclusiveServices,
  officialServicePresent,
} from '../src/exclusive.mjs';
import { PROFILE_FIELD_KEYS as CONFIG_PROFILE_KEYS } from '../src/config.mjs';
import { PROFILE_FIELD_KEYS as USERINFO_PROFILE_KEYS } from '../src/userinfo.mjs';

const ENDPOINT = 'https://gateway.corp.example/v1/chat/completions';

async function sentHeaders(identity) {
  let captured;
  const fetch = async (input, init) => {
    captured = new Headers(init.headers);
    return new Response('{}', { status: 200 });
  };
  const options = { fetch };
  await modelFetchOptions(options, 'https://gateway.corp.example/v1', () => 'access-token-value', identity)
    .fetch(ENDPOINT, { method: 'POST' });
  return captured;
}

test('gateway identity defaults stay unchanged', async () => {
  const headers = await sentHeaders(undefined);
  assert.equal(headers.get('X-IAM-Token'), 'access-token-value');
  assert.equal(headers.get('X-Consumer-Type'), 'personal');
});

test('configured header names and consumer type replace the defaults', async () => {
  const headers = await sentHeaders({
    tokenHeader: 'X-IAM-Ticket',
    consumerHeader: 'X-Consumer-Kind',
    consumerType: 'agent-host',
  });
  assert.equal(headers.get('X-IAM-Ticket'), 'access-token-value');
  assert.equal(headers.get('X-Consumer-Kind'), 'agent-host');
  assert.equal(headers.get('X-IAM-Token'), null);
  assert.equal(headers.get('X-Consumer-Type'), null);
});

test('identity defaults are exposed as config values', () => {
  const { value } = validateConfig({});
  assert.equal(value.iamTokenHeader, 'X-IAM-Token');
  assert.equal(value.consumerTypeHeader, 'X-Consumer-Type');
  assert.equal(value.consumerType, 'personal');
  assert.deepEqual(value.exclusiveServices, ['deepseekAccount']);
  assert.equal(value.profileFields, null);
});

test('header names and consumer type must be HTTP tokens', () => {
  for (const bad of ['X-IAM-Token\r\nX-Evil: 1', 'X-IAM Token', '', 42]) {
    const result = validateConfig({ iamTokenHeader: bad });
    assert.equal('issues' in result, true, `${JSON.stringify(bad)} must be rejected`);
  }
  const injected = validateConfig({ consumerType: 'personal\r\nX-Evil: 1' });
  assert.equal('issues' in injected, true);
});

test('exclusive services must be a non-empty token list', () => {
  assert.equal('issues' in validateConfig({ exclusiveServices: [] }), true);
  assert.equal('issues' in validateConfig({ exclusiveServices: ['deepseekAccount', 'bad name'] }), true);
  const ok = validateConfig({ exclusiveServices: ['deepseekAccount', 'llm-deepseek'] });
  assert.deepEqual(ok.value.exclusiveServices, ['deepseekAccount', 'llm-deepseek']);
});

test('profile fields accept only workNo/name mapped to claim tokens', () => {
  const ok = validateConfig({ profileFields: { workNo: 'work_no', name: 'pinyin' } });
  assert.deepEqual(ok.value.profileFields, { workNo: 'work_no', name: 'pinyin' });
  assert.equal('issues' in validateConfig({ profileFields: { dept: 'department' } }), true);
  assert.equal('issues' in validateConfig({ profileFields: { workNo: 'work no' } }), true);
  assert.equal('issues' in validateConfig({ profileFields: { workNo: 7 } }), true);
});

test('an extra configured service is part of the exclusivity check', () => {
  const mounted = new Set(['llm-deepseek']);
  const ctx = { get: (name) => (mounted.has(name) ? {} : undefined) };
  assert.deepEqual(checkExclusive(ctx, {}), { ok: true });
  assert.deepEqual(checkExclusive(ctx, { exclusiveServices: ['deepseekAccount', 'llm-deepseek'] }),
    { ok: false, reason: 'exclusive-violation' });
  assert.equal(officialServicePresent(ctx, { exclusiveServices: ['deepseekAccount', 'llm-deepseek'] }), 'llm-deepseek');
  assert.equal(officialServicePresent(ctx, { exclusiveServices: ['deepseekAccount'] }), undefined);
});

test('an empty configured list falls back to the default service', () => {
  const ctx = { get: (name) => (name === 'deepseekAccount' ? {} : undefined) };
  assert.deepEqual(checkExclusive(ctx, { exclusiveServices: [] }), { ok: false, reason: 'exclusive-violation' });
});

test('the schema default and the assertion fallback name the same services', () => {
  // config.mjs keeps its own literal because its import closure is fixed (the
  // maker toolchain ships exactly config/model-options/http-url/errors), and
  // exclusive.mjs keeps the fallback a bare-config caller such as the Host probe
  // gets. Drift between them would make the probe and the runtime disagree.
  assert.deepEqual([...DEFAULT_EXCLUSIVE_SERVICES], [...validateConfig({}).value.exclusiveServices]);
  assert.deepEqual([...exclusiveServices({})], [...validateConfig({}).value.exclusiveServices]);
});

test('the config schema and the UserInfo projection agree on the profile keys', () => {
  // config.mjs ships in the standalone maker toolchain and must not import the
  // UserInfo client, so the key list is mirrored; this test keeps them equal.
  assert.deepEqual([...CONFIG_PROFILE_KEYS], [...USERINFO_PROFILE_KEYS]);
});
