import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketError, createServiceClient } from '../src/client.mjs';

const respond = (status, body) => () => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });

test('requires a service url', () => {
  assert.throws(() => createServiceClient({}), /no-service-url/);
});

test('maps status codes to error codes', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [409, 'version-revoked'], [503, 'service-unavailable']]) {
    const client = createServiceClient({ baseUrl: 'https://plugins.corp.example', fetchImpl: respond(status, {}) });
    await assert.rejects(() => client.list(), (error) => error instanceof MarketError && error.code === code);
  }
});

test('returns parsed payload and sends the bearer token', async () => {
  let seen;
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    token: 't',
    fetchImpl: (url, init) => {
      seen = { url, init };
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve([{ name: 'a' }]) });
    },
  });
  assert.deepEqual(await client.list(), [{ name: 'a' }]);
  assert.equal(seen.url, 'https://plugins.corp.example/api/plugins');
  assert.equal(seen.init.headers.authorization, 'Bearer t');
});

test('turns an abort into a timeout error', async () => {
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    timeoutMs: 10,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  });
  await assert.rejects(() => client.list(), (error) => error.code === 'timeout');
});

test('a rejected request keeps the service explanation', async () => {
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: () => Promise.resolve({
      status: 400,
      ok: false,
      json: () => Promise.resolve({ error: 'bad-tag', detail: ['tag must look like v1.2.3'] }),
    }),
  });
  await assert.rejects(() => client.submit({}), (error) => {
    assert.equal(error.code, 'bad-tag');
    assert.deepEqual(error.body.detail, ['tag must look like v1.2.3']);
    return true;
  });
});

test('a non-JSON rejection still yields a code', async () => {
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: () => Promise.resolve({ status: 400, ok: false, json: () => Promise.reject(new Error('html')) }),
  });
  await assert.rejects(() => client.submit({}), (error) => error.code === 'bad-response');
});

test('sends the token when one is configured', async () => {
  let seen;
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    token: 'secret',
    fetchImpl: async (url, init) => {
      seen = init.headers;
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    },
  });
  await client.list();
  assert.equal(seen.authorization, 'Bearer secret');
});

test('sends no authorization header without a token', async () => {
  let seen;
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: async (url, init) => {
      seen = init.headers;
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    },
  });
  await client.list();
  assert.equal(seen.authorization, undefined);
});
