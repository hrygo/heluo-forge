import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const configured = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pauseNextRead(credentials, { fail = false } = {}) {
  const entered = deferred();
  const release = deferred();
  const read = credentials.readRecord.bind(credentials);
  let paused = false;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (!paused) {
      paused = true;
      entered.resolve();
      await release.promise;
      if (fail) throw new Error('synthetic read failure');
    }
    return record;
  };
  return { entered: entered.promise, release: release.resolve };
}

async function seedGrant(credentials) {
  const grant = {
    version: 1,
    issuer: configured.issuer,
    subject: 'E1001',
    clientId: configured.clientId,
    resource: configured.gatewayResource,
    scope: 'openid profile offline_access',
    obtainedAt: new Date().toISOString(),
    refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await createGrantStore(credentials).write(grant);
  return grant;
}

function callbackFor(started) {
  const url = new URL(configured.redirectUri);
  url.searchParams.set('state', new URL(started.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', 'synthetic-code');
  return url.href;
}

for (const fail of [false, true]) {
  test(`a pending ${fail ? 'failed' : 'successful'} poll cannot overwrite a newer sign-in`, async (t) => {
    const credentials = new MemoryCredentials();
    const gate = pauseNextRead(credentials, { fail });
    const service = createIamService(configured, { credentials });
    t.after(() => service.dispose());
    t.after(() => gate.release());

    const pending = service.syncFromStore();
    await gate.entered;
    const started = await service.startSignIn();
    assert.equal(started.view.state, 'authenticating');
    gate.release();
    await pending;

    assert.equal(service.getView().state, 'authenticating');
    assert.equal(service.getView().error, null);
  });

  test(`a pending ${fail ? 'failed' : 'successful'} hydration cannot revive a disposed service`, async (t) => {
    const credentials = new MemoryCredentials();
    const grant = await seedGrant(credentials);
    const gate = pauseNextRead(credentials, { fail });
    const service = createIamService(configured, { credentials });
    t.after(() => service.dispose());
    t.after(() => gate.release());

    const pending = service.hydrate();
    await gate.entered;
    await service.dispose();
    assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
    gate.release();
    await pending;

    assert.equal(service.getView().state, 'signed-out');
    assert.equal(service.getView().principal, null);
    assert.equal(service.getView().error, null);
    assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
    assert.equal((await credentials.readRecord('heluo-iam/session')).payload.refreshToken, grant.refreshToken);
  });
}

test('a failed callback from a cancelled attempt cannot cancel its replacement', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const entered = deferred();
  const release = deferred();
  let firstExchange = true;
  const service = createIamService({ ...configured, ...mock.endpoints, allowInsecureHttp: true }, {
    credentials: new MemoryCredentials(),
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && firstExchange) {
        firstExchange = false;
        entered.resolve();
        await release.promise;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return fetch(url, init);
    },
  });
  t.after(() => service.dispose());
  t.after(() => release.resolve());
  const first = await service.startSignIn();
  const pending = service.handleCallback(callbackFor(first)).catch((error) => error);
  await entered.promise;
  await service.cancelSignIn();
  const replacement = await service.startSignIn();
  release.resolve();
  const failure = await pending;

  assert.equal(service.getView().state, 'authenticating');
  assert.equal(service.getView().error, null);
  assert.equal(failure.code, 'IAM_ATTEMPT_CANCELLED');
  const authorized = await fetch(replacement.authorizationUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const completed = await service.handleCallback(authorized.headers.get('location'));
  assert.equal(completed.state, 'ready');
  assert.equal(completed.principal, 'E1001');
});

test('a failed callback cannot publish an error after disposal', async (t) => {
  const entered = deferred();
  const release = deferred();
  const service = createIamService(configured, {
    credentials: new MemoryCredentials(),
    fetch: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    },
  });
  t.after(() => service.dispose());
  t.after(() => release.resolve());
  const started = await service.startSignIn();
  const pending = service.handleCallback(callbackFor(started)).catch((error) => error);
  await entered.promise;
  await service.dispose();
  release.resolve();
  const failure = await pending;

  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getView().error, null);
  assert.equal(failure.code, 'IAM_ATTEMPT_CANCELLED');
});

test('a callback losing its mirror grant cannot delete a newer stored session', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const entered = deferred();
  const release = deferred();
  const set = credentials.set.bind(credentials);
  credentials.set = async (...args) => {
    entered.resolve();
    await release.promise;
    return set(...args);
  };
  const service = createIamService({ ...configured, ...mock.endpoints, allowInsecureHttp: true }, { credentials });
  t.after(() => service.dispose());
  t.after(() => release.resolve());
  const started = await service.startSignIn();
  const authorized = await fetch(started.authorizationUrl, { redirect: 'manual' });
  const callback = service.handleCallback(authorized.headers.get('location')).catch((error) => error);
  await entered.promise;
  const newer = await seedGrant(credentials);
  release.resolve();
  const failure = await callback;

  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.deepEqual((await credentials.readRecord('heluo-iam/session'))?.payload, newer);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
});

for (const action of ['signOut', 'dispose']) {
  test(`a token read begun before ${action} cannot return credentials or revive ready`, async (t) => {
    const credentials = new MemoryCredentials();
    await seedGrant(credentials);
    const service = createIamService(configured, { credentials });
    t.after(() => service.dispose());
    await service.hydrate();
    const gate = pauseNextRead(credentials);
    t.after(() => gate.release());

    const pending = service.resolveToken().catch((error) => error);
    await gate.entered;
    await service[action]();
    assert.equal(service.getView().state, 'signed-out');
    gate.release();
    const failure = await pending;

    assert.equal(service.getView().state, 'signed-out');
    assert.equal(service.getView().principal, null);
    assert.equal(failure.code, action === 'dispose' ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN');
    assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  });
}
