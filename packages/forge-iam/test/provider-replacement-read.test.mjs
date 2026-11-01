import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = {
  issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize',
  tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks',
  clientId: 'test', redirectUri: 'http://127.0.0.1:4567/iam/callback',
  allowInsecureHttp: true, refreshSkewSeconds: 0,
};

test('a new caller cannot reuse a token promise after the provider changes', async (t) => {
  const old = new MemoryCredentials();
  await createGrantStore(old).write({
    version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  let current = old;
  let checks = 0;
  let second;
  let service;
  service = createIamService(config, { getCredentials: () => {
    if (++checks === 2) queueMicrotask(() => {
      current = new MemoryCredentials();
      second = service.resolveToken();
      second.catch(() => {});
    });
    return current;
  } });
  t.after(() => service.dispose());
  const first = service.resolveToken();
  await assert.rejects(first, { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  await assert.rejects(second, { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getView().principal, null);
  assert.equal(service.getPrincipal(), undefined);
});

test('a token promise cannot return after the service is disposed', async (t) => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  let checks = 0;
  let second;
  let service;
  service = createIamService(config, { getCredentials: () => {
    if (++checks === 2) queueMicrotask(() => {
      second = service.resolveToken();
      second.catch(() => {});
      void service.dispose();
    });
    return credentials;
  } });
  t.after(() => service.dispose());
  const first = service.resolveToken();
  await assert.rejects(first, { code: 'IAM_DISPOSED' });
  await assert.rejects(second, { code: 'IAM_DISPOSED' });
});

for (const lookup of [2, 3, 4]) {
  test(`synchronous provider lookup ${lookup} cannot return a token after disposal`, async (t) => {
    const credentials = new MemoryCredentials();
    await createGrantStore(credentials).write({
      version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
      refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
      obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    let checks = 0;
    let service;
    service = createIamService(config, { getCredentials: () => {
      if (++checks === lookup) void service.dispose();
      return credentials;
    } });
    t.after(() => service.dispose());
    await assert.rejects(service.resolveToken(), { code: 'IAM_DISPOSED' });
    assert.equal(service.getView().principal, null);
  });
}

test('an old empty read cannot invalidate a newer provider session', async (t) => {
  const old = new MemoryCredentials();
  const next = new MemoryCredentials();
  await createGrantStore(next).write({
    version: 1, issuer: config.issuer, subject: 'new-user', clientId: config.clientId,
    refreshToken: 'new-refresh', accessToken: 'new-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const read = old.readRecord.bind(old);
  old.readRecord = async (key) => { const record = await read(key); entered(); await blocked; return record; };
  let current = old;
  const service = createIamService(config, { getCredentials: () => current });
  t.after(() => { release(); service.dispose(); });
  const pending = service.resolveToken();
  await waiting;
  current = next;
  assert.equal(await service.resolveToken(), 'new-access');
  release();
  await assert.rejects(pending, { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().principal, 'new-user');
});

test('a failed old-provider refresh cannot erase a newer provider session', async (t) => {
  const old = new MemoryCredentials();
  const next = new MemoryCredentials();
  const grant = (subject, hours) => ({
    version: 1, issuer: config.issuer, subject, clientId: config.clientId,
    refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + hours * 3600000).toISOString(),
  });
  await createGrantStore(old).write(grant('old-user', 1));
  await createGrantStore(next).write(grant('new-user', 3));
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let current = old;
  const service = createIamService({ ...config, refreshSkewSeconds: 7200 }, {
    getCredentials: () => current,
    verifyAtomicStore: (candidate) => candidate === old || candidate === next,
    fetch: async (url) => {
      if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
      if (String(url).endsWith('/token')) {
        enter();
        await blocked;
        return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      throw new Error('unexpected mock request');
    },
  });
  t.after(() => { release(); service.dispose(); });
  const refresh = service.resolveToken();
  await Promise.race([entered, refresh.then(() => { throw new Error('refresh completed before the mock gate'); })]);
  current = next;
  assert.equal((await service.syncFromStore()).principal, 'new-user');
  release();
  await assert.rejects(refresh);
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().principal, 'new-user');
});

for (const legacy of [false, true]) {
  test(`a failed refresh cannot erase a newer ${legacy ? 'legacy' : 'identified'} session on the same provider`, async (t) => {
  const credentials = new MemoryCredentials();
  const grant = (subject, hours, id) => ({
    version: 1, issuer: config.issuer, subject, clientId: config.clientId,
    ...(legacy ? {} : { sessionInstanceId: Buffer.alloc(32, id).toString('base64url') }),
    refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + hours * 3600000).toISOString(),
  });
  const store = createGrantStore(credentials);
  await store.write(grant('old-user', 1, 1));
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = createIamService({ ...config, refreshSkewSeconds: 7200 }, {
    credentials, verifyAtomicStore: (candidate) => candidate === credentials,
    fetch: async (url) => {
      if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
      if (String(url).endsWith('/token')) {
        enter();
        await blocked;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      throw new Error('unexpected mock request');
    },
  });
  t.after(() => { release(); service.dispose(); });
  const refresh = service.resolveToken();
  await Promise.race([entered, refresh.then(() => { throw new Error('refresh completed before the mock gate'); })]);
  await store.write(grant('new-user', 3, 2));
  assert.equal((await service.syncFromStore()).principal, 'new-user');
  release();
  await assert.rejects(refresh);
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().principal, 'new-user');
  });
}

test('an old empty read cannot erase a later session on the same provider', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const read = credentials.readRecord.bind(credentials);
  let first = true;
  credentials.readRecord = async (key) => {
    const value = await read(key);
    if (first && key === 'heluo-iam/session') { first = false; entered(); await blocked; }
    return value;
  };
  const service = createIamService(config, { credentials });
  t.after(() => { release(); service.dispose(); });
  const oldRead = service.resolveToken();
  await waiting;
  await store.write({
    version: 1, issuer: config.issuer, subject: 'new-user', clientId: config.clientId,
    refreshToken: 'new-refresh', accessToken: 'new-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal((await service.syncFromStore()).principal, 'new-user');
  release();
  await assert.rejects(oldRead, { code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().principal, 'new-user');
});

test('a changed invalid grant cannot leave the unchanged old view ready', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const grant = {
    version: 1, issuer: config.issuer, subject: 'old-user', clientId: config.clientId,
    refreshToken: 'old-refresh', accessToken: 'old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await store.write(grant);
  const service = createIamService(config, { credentials });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  await store.write({ ...grant, clientId: 'different-client' });
  await assert.rejects(service.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getView().principal, null);
});

test('an initial storage read failure clears the unchanged cached session', async (t) => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, subject: 'old-user', clientId: config.clientId,
    refreshToken: 'old-refresh', accessToken: 'old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const service = createIamService(config, { credentials });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  credentials.readRecord = async () => { throw new Error('synthetic storage failure'); };
  await assert.rejects(service.resolveToken(), { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getPrincipal(), undefined);
});

test('a pending refresh does not expose an old ready view while waiting', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const grant = {
    version: 1, issuer: config.issuer, subject: 'old-user', clientId: config.clientId,
    refreshToken: 'old-refresh', accessToken: 'old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await store.write(grant);
  const service = createIamService(config, { credentials, verifyAtomicStore: (candidate) => candidate === credentials });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  await store.write({ ...grant, refreshOperation: {
    version: 1, state: 'pending', id: Buffer.alloc(32, 1).toString('base64url'), base: Buffer.alloc(32, 2).toString('base64url'),
  } });
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const read = credentials.readRecord.bind(credentials);
  let reads = 0;
  credentials.readRecord = async (key) => {
    const value = await read(key);
    if (key === 'heluo-iam/session' && ++reads === 2) { entered(); await blocked; }
    return value;
  };
  t.after(() => release());
  const result = service.resolveToken();
  result.catch(() => {});
  await Promise.race([waiting, result.then(() => { throw new Error('wait completed before the read gate'); })]);
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getPrincipal(), undefined);
  await service.dispose();
  release();
  await assert.rejects(result, { code: 'IAM_DISPOSED' });
});

test('a pending marker for the same session cannot leave its old view ready', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const grant = {
    version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await store.write(grant);
  const service = createIamService(config, { credentials, verifyAtomicStore: (candidate) => candidate === credentials });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  await store.write({ ...grant, refreshOperation: {
    version: 1, state: 'pending', id: Buffer.alloc(32, 1).toString('base64url'), base: Buffer.alloc(32, 2).toString('base64url'),
  } });
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getView().principal, null);
});

for (const replacement of ['other', 'unavailable']) {
  test(`a non-refreshing token read cannot use a ${replacement} provider's predecessor`, async (t) => {
    const old = new MemoryCredentials();
    await createGrantStore(old).write({
      version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
      refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
      obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    let current = old;
    let entered;
    let release;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const read = old.readRecord.bind(old);
    old.readRecord = async (key) => {
      const result = await read(key);
      entered();
      await blocked;
      return result;
    };
    const service = createIamService(config, { getCredentials: () => current });
    t.after(() => { release(); service.dispose(); });
    const pending = service.resolveToken();
    await waiting;
    current = replacement === 'other' ? new MemoryCredentials() : undefined;
    release();
    await assert.rejects(pending, { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
    assert.notEqual(service.getView().state, 'ready');
    assert.equal(service.getView().principal, null);
  });
}
