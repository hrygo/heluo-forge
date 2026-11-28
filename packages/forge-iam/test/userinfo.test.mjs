import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { normalizeProfileFields, projectUserInfo } from '../src/userinfo.mjs';

function configFor(mock, overrides = {}) {
  return validateConfig({
    ...mock.endpoints,
    userInfoEndpoint: `${mock.issuer}/userinfo`,
    clientId: mock.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  }).value;
}

async function signIn(service) {
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return service.handleCallback(response.headers.get('location'));
}

test('projection takes only mapped string fields and drops the rest', () => {
  const raw = { work_no: '10001234', pinyin: ' Zhang San ', employeeNumber: 'E9', name: 'Li Si', nested: { name: 'x' } };
  assert.deepEqual(projectUserInfo(raw, { workNo: 'work_no', name: 'pinyin' }), { workNo: '10001234', name: 'Zhang San' });
  assert.deepEqual(projectUserInfo(raw, { workNo: 'employeeNumber', name: 'name' }), { workNo: 'E9', name: 'Li Si' });
  assert.equal(projectUserInfo(raw, { workNo: 'missing' }), undefined);
  assert.equal(projectUserInfo({ work_no: 42, pinyin: '   ' }, { workNo: 'work_no', name: 'pinyin' }), undefined);
  assert.equal(projectUserInfo(raw, {}), undefined);
  assert.equal(projectUserInfo(null, { workNo: 'work_no' }), undefined);
});

test('normalizeProfileFields keeps only known string keys', () => {
  assert.deepEqual({ ...normalizeProfileFields({ workNo: 'work_no', name: 'pinyin', extra: 'x', workNo2: 1 }) },
    { workNo: 'work_no', name: 'pinyin' });
  assert.deepEqual({ ...normalizeProfileFields(undefined) }, {});
  assert.deepEqual({ ...normalizeProfileFields(['work_no']) }, {});
});

test('login loads UserInfo once with a Bearer token and projects configured fields', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials,
    profileFields: { workNo: 'work_no', name: 'pinyin' },
  });
  t.after(() => service.dispose());
  const view = await signIn(service);
  assert.equal(view.state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  assert.equal(mock.counts.userInfo, 1);
  assert.match(mock.lastUserInfo.authorization, /^Bearer \S+$/);
  assert.equal(JSON.stringify(view).includes('Zhang San'), false, 'the profile is not in the view yet');
});

test('no field mapping means no UserInfo request', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
  assert.equal(await service.resolveIdentityProfile(), undefined);
  assert.equal(mock.counts.userInfo, 0);
});

test('a restored login retrieves the configured work number once for concurrent callers', async (t) => {
  const mock = await startMockOidc();
  const credentials = new MemoryCredentials();
  const config = configFor(mock, { profileFields: { workNo: 'employeeNumber' } });
  const first = createIamService(config, { credentials });
  const restored = createIamService(config, { credentials });
  t.after(async () => {
    await first.dispose();
    await restored.dispose();
    await mock.close();
  });

  assert.equal((await signIn(first)).state, 'ready');
  assert.deepEqual(first.getIdentityProfile(), { workNo: '10001234' });
  assert.equal(mock.counts.userInfo, 1);
  await first.dispose();

  assert.equal((await restored.syncFromStore()).state, 'ready');
  assert.equal(restored.getIdentityProfile(), undefined);
  const profiles = await Promise.all([restored.resolveIdentityProfile(), restored.resolveIdentityProfile()]);
  assert.deepEqual(profiles, [{ workNo: '10001234' }, { workNo: '10001234' }]);
  assert.deepEqual(await restored.resolveIdentityProfile(), { workNo: '10001234' });
  assert.equal(mock.counts.userInfo, 2);
  assert.equal(JSON.stringify(restored.getSession()).includes('workNo'), false);
});

test('explicit login and panel polling preserve in-flight optional UserInfo discovery', { timeout: 4000 }, async (t) => {
  const mock = await startMockOidc();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const discoveryUrl = `${mock.issuer}/.well-known/openid-configuration`;
  let discoveryReads = 0;
  const service = createIamService(configFor(mock, { userInfoEndpoint: '', revocationEndpoint: '', discoveryUrl }), {
    credentials: new MemoryCredentials(),
    profileFields: { workNo: 'work_no' },
    async fetch(url, init) {
      if (String(url) === discoveryUrl) {
        discoveryReads++;
        entered.resolve();
        await release.promise;
        return Response.json({
          issuer: mock.issuer,
          userinfo_endpoint: `${mock.issuer}/userinfo`,
          revocation_endpoint: null,
        });
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { release.resolve(); await service.dispose(); await mock.close(); });
  assert.equal(service.getView().state, 'signed-out');
  const login = signIn(service);
  await entered.promise;
  assert.equal((await login).state, 'ready');
  assert.equal((await service.syncFromStore()).state, 'ready');
  assert.equal((await service.syncFromStore()).state, 'ready');
  assert.equal(mock.counts.userInfo, 0);
  release.resolve();
  const deadline = Date.now() + 1500;
  while (!service.getIdentityProfile() && Date.now() < deadline) await delay(10);
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234' });
  assert.equal(mock.counts.userInfo, 1);
  assert.equal((await service.signOut()).revocation, 'unknown');
  assert.equal(service.getView().canSignOut, true);
  assert.equal(discoveryReads, 2, 'malformed revoke metadata cached by UserInfo must be checked again on sign-out');
});

test('late UserInfo for the previous access token is discarded after the same login rotates', { timeout: 4000 }, async (t) => {
  const mock = await startMockOidc();
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const profileRequest = Promise.withResolvers();
  const profileResponse = Promise.withResolvers();
  const service = createIamService(configFor(mock, {
    userInfoEndpoint: '',
    discoveryUrl: `${mock.issuer}/.well-known/openid-configuration`,
  }), {
    credentials,
    profileFields: { workNo: 'work_no' },
    async fetch(url, init) {
      if (String(url) !== `${mock.issuer}/userinfo`) return fetch(url, init);
      profileRequest.resolve();
      return profileResponse.promise;
    },
  });
  t.after(async () => {
    profileResponse.resolve(Response.json({ work_no: 'first-access-profile' }));
    await service.dispose();
    await mock.close();
  });
  assert.equal((await signIn(service)).state, 'ready');
  await profileRequest.promise;
  const pendingProfile = service.resolveIdentityProfile();
  const { grant } = await store.read();
  await store.write({ ...grant, accessToken: 'synthetic-next-access', refreshToken: 'synthetic-next-refresh' });
  assert.equal((await service.syncFromStore()).state, 'ready');
  profileResponse.resolve(Response.json({ work_no: 'first-access-profile' }));
  assert.equal(await pendingProfile, undefined);
  await setImmediate();
  assert.equal(service.getIdentityProfile(), undefined);
});

test('UserInfo failure degrades without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'http500';
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: { workNo: 'work_no' },
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
});

test('malformed UserInfo JSON degrades and sign-out clears the profile', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'malformed';
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: { workNo: 'work_no' },
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
  mock.control.userInfoMode = 'ok';
  await service.signOut();
  assert.equal(service.getIdentityProfile(), undefined);
});

test('profile never outlives the grant that produced it', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials,
    profileFields: { workNo: 'work_no' },
  });
  t.after(() => service.dispose());
  await signIn(service);
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234' });
  await credentials.deleteRecord('heluo-iam/session');
  await service.syncFromStore();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getIdentityProfile(), undefined, 'a stale profile must not survive its grant');
});
