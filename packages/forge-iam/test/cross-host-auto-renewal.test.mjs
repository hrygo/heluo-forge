import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createIamService } from './support/trusted-service.mjs';

async function within(promise, ms) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timed out waiting for the renewal')), ms); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('a Host adopts a completed rotation from another Host without a view poll', async (t) => {
  const credentials = new MemoryCredentials();
  const issuer = 'https://iam.corp.example';
  const now = Date.now();
  const oldDeadline = now + 4000;
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, subject: 'E1001', clientId: 'dsh', scope: 'openid',
    refreshToken: 'refresh-a', accessToken: 'access-a',
    obtainedAt: new Date(now).toISOString(),
    accessExpiresAt: new Date(oldDeadline).toISOString(),
    refreshExpiresAt: new Date(now + 60_000).toISOString(),
  });

  let posts = 0;
  const fetch = async (url, init) => {
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    if (init?.method === 'POST') {
      posts += 1;
      return Response.json({ access_token: 'access-b', token_type: 'Bearer',
        expires_in: 30, refresh_token: 'refresh-b' });
    }
    throw new Error('unexpected request');
  };
  const config = { issuer, authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, clientId: 'dsh',
    redirectUri: 'http://127.0.0.1:4567/iam/callback' };
  const first = createIamService({ ...config, refreshSkewSeconds: 1 }, { credentials, fetch });
  const second = createIamService({ ...config, refreshSkewSeconds: 60 }, { credentials, fetch });
  const controller = new AbortController();
  const events = first.watch(controller.signal);
  t.after(async () => {
    controller.abort();
    await events.return();
    await first.dispose();
    await second.dispose();
  });

  await first.hydrate();
  await second.hydrate();
  const initial = await events.next();
  assert.equal(initial.value.accessExpiresAt, new Date(oldDeadline).toISOString());
  const changed = events.next();

  await second.getAccessToken();
  const rotated = (await store.read()).grant;
  assert.equal(rotated.refreshOperation.state, 'complete');
  assert.equal(rotated.refreshToken, 'refresh-b');

  // The first Host's original timer runs before the old access deadline. It
  // must publish the other Host's bound completion without a manual sync.
  const event = await Promise.race([
    changed,
    delay(Math.max(0, oldDeadline - 100 - Date.now())).then(() => null),
  ]);
  assert.equal(posts, 1, 'the same refresh token must be sent only once');
  assert.equal(event?.value?.accessExpiresAt, rotated.accessExpiresAt,
    'the waiting Host must publish the completed rotation before its old deadline');
  assert.equal(first.getView().state, 'ready');
});

for (const change of ['base', 'identity']) {
  test(`an old Host ignores another Host's complete marker with a different ${change}`, async (t) => {
    const credentials = new MemoryCredentials();
    const issuer = 'https://iam.corp.example';
    const now = Date.now();
    const deadline = now + 2500;
    const store = createGrantStore(credentials);
    await store.write({
      version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, subject: 'E1001', clientId: 'dsh', scope: 'openid',
      refreshToken: 'refresh-a', accessToken: 'access-a',
      obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(deadline).toISOString(),
      refreshExpiresAt: new Date(now + 60_000).toISOString(),
    });
    let posts = 0;
    const fetch = async (url, init) => {
      if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
      if (init?.method === 'POST') {
        posts++;
        return Response.json({ access_token: 'access-b', token_type: 'Bearer',
          expires_in: 30, refresh_token: 'refresh-b' });
      }
      throw new Error('unexpected request');
    };
    const config = { issuer, authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, clientId: 'dsh',
      redirectUri: 'http://127.0.0.1:4567/iam/callback' };
    const first = createIamService({ ...config, refreshSkewSeconds: 1 }, { credentials, fetch });
    const second = createIamService({ ...config, refreshSkewSeconds: 60 }, { credentials, fetch });
    t.after(async () => { await first.dispose(); await second.dispose(); });
    await first.hydrate();
    await second.hydrate();
    await second.getAccessToken();
    const completed = (await store.read()).grant;
    assert.equal(completed.refreshOperation.state, 'complete');
    const foreign = change === 'identity'
      ? { ...completed, subject: 'E2002' }
      : { ...completed, refreshOperation: { ...completed.refreshOperation, base: 'A'.repeat(43) } };
    assert.notDeepEqual(foreign, completed);
    await store.write(foreign);

    const observed = Promise.withResolvers();
    const read = credentials.readRecord.bind(credentials);
    credentials.readRecord = async (key) => {
      const record = await read(key);
      if (key === GRANT_KEY) observed.resolve();
      return record;
    };
    await within(observed.promise, 4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posts, 1, 'the old timer must not send a refresh request');
    assert.equal(first.getView().principal, 'E1001');
    assert.equal(first.getView().accessExpiresAt, new Date(deadline).toISOString());
    assert.deepEqual((await store.read()).grant, foreign);
  });
}

test('a completed rotation cannot overwrite a newer local session during client authentication', async (t) => {
  const credentials = new MemoryCredentials();
  const issuer = 'https://iam.corp.example';
  const fixture = createClientSecretFixture(credentials, { issuer, clientId: 'dsh' });
  const now = Date.now();
  const deadline = now + 3000;
  const store = createGrantStore(credentials);
  const original = {
    version: 2, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, subject: 'E1001', clientId: 'dsh', scope: 'openid',
    refreshToken: 'refresh-a', accessToken: 'access-a',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(deadline).toISOString(),
    refreshExpiresAt: new Date(now + 60_000).toISOString(),
    authContext: { mode: 'confidential', method: fixture.config.clientAuthMethod,
      secretRef: fixture.config.clientSecretRef, secretRevision: fixture.snapshot().revision },
  };
  await store.write(original);
  let posts = 0;
  const fetch = async (url, init) => {
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    if (init?.method === 'POST') {
      posts++;
      return Response.json({ access_token: 'access-b', token_type: 'Bearer',
        expires_in: 30, refresh_token: 'refresh-b' });
    }
    throw new Error('unexpected request');
  };
  const config = { issuer, authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', ...fixture.config };
  const options = { ...fixture.options, fetch };
  const first = createIamService({ ...config, refreshSkewSeconds: 1 }, options);
  const second = createIamService({ ...config, refreshSkewSeconds: 60 }, options);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await first.dispose(); await second.dispose(); });
  await first.hydrate();
  await second.hydrate();
  await second.getAccessToken();
  assert.equal((await store.read()).grant.refreshOperation.state, 'complete');
  fixture.setReadBarrier(async () => { entered.resolve(); await release.promise; });
  await within(entered.promise, 4000);

  fixture.setReadBarrier(undefined);
  const replacement = { ...original, subject: 'E2002', refreshToken: 'refresh-c',
    accessToken: 'access-c', obtainedAt: new Date(Date.now()).toISOString(),
    accessExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  await store.write(replacement);
  await first.syncFromStore();
  assert.equal(first.getView().principal, 'E2002');
  release.resolve();
  await delay(100);
  assert.equal(first.getView().principal, 'E2002', 'the old completion must not replace the newer local session');
  assert.equal(posts, 1);
  assert.deepEqual((await store.read()).grant, replacement);
});
