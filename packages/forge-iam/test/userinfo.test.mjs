import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { normalizeProfileFields, projectUserInfo, fetchUserInfo } from '../src/userinfo.mjs';
import { IamError } from '../src/errors.mjs';

// 字段口径已由 IAM 确认（2026-11-24，FB-IAM-06 闭环）：工号=employeeNumber、
// 姓名=displayName、OA 账号=giveName（当前无投影槽位，不接入）。内部键固定为
// workNo/name，映射由配置给出；作废的 work_no/pinyin 保留一组用例作机制回归。
const CONFIRMED_FIELDS = Object.freeze({ workNo: 'employeeNumber', name: 'displayName' });
const LEGACY_WORK_NO_PINYIN = Object.freeze({ workNo: 'work_no', name: 'pinyin' });

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
  const raw = { employeeNumber: '10001234', displayName: ' Zhang San ', giveName: 'zhangsan', sub: 'S1', authTime: 1794363364, nested: { name: 'x' } };
  assert.deepEqual(projectUserInfo(raw, CONFIRMED_FIELDS), {
    workNo: '10001234', name: 'Zhang San',
  });
  assert.deepEqual(projectUserInfo(raw, { workNo: 'employeeNumber' }), { workNo: '10001234' });
  assert.equal(projectUserInfo(raw, { workNo: 'missing' }), undefined);
  assert.equal(projectUserInfo({ employeeNumber: 42, displayName: '   ' }, CONFIRMED_FIELDS), undefined);
  assert.equal(projectUserInfo(raw, {}), undefined);
  assert.equal(projectUserInfo(null, { workNo: 'employeeNumber' }), undefined);
});

test('normalizeProfileFields keeps only known string keys', () => {
  assert.deepEqual({ ...normalizeProfileFields({ workNo: 'employeeNumber', name: 'displayName', extra: 'x', unknown: 1 }) },
    { workNo: 'employeeNumber', name: 'displayName' });
  assert.deepEqual({ ...normalizeProfileFields(undefined) }, {});
  assert.deepEqual({ ...normalizeProfileFields(['employeeNumber']) }, {});
});

test('invalid endpoint and empty token surface IamError, never a raw TypeError', async () => {
  await assert.rejects(
    () => fetchUserInfo({ userInfoEndpoint: 'not-a-url', accessToken: 'at', fetchImpl: async () => { throw new Error('must not be called'); } }),
    (error) => error instanceof IamError && error.code === 'IAM_USERINFO_UNAVAILABLE',
  );
  await assert.rejects(
    () => fetchUserInfo({ userInfoEndpoint: '', accessToken: 'at', fetchImpl: async () => { throw new Error('must not be called'); } }),
    (error) => error instanceof IamError && error.code === 'IAM_USERINFO_UNAVAILABLE',
  );
  await assert.rejects(
    () => fetchUserInfo({ userInfoEndpoint: 'http://127.0.0.1:9/userinfo', accessToken: '' }),
    (error) => error instanceof IamError && error.code === 'IAM_USERINFO_UNAVAILABLE',
  );
});

// 口径未定前默认不取 UserInfo、不投影（#433 第 3 项：只保留映射机制）。
test('no profileFields keeps the mechanism idle: no UserInfo request, no projection', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
  assert.equal(mock.counts.userInfo, 0);
});

test('explicit empty profileFields keeps the opt-out: no UserInfo request', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), profileFields: {} });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
  assert.equal(mock.counts.userInfo, 0);
});

// 已确认口径：employeeNumber/displayName。配置给出映射后才取 UserInfo。
test('confirmed mapping employeeNumber/displayName projects workNo and name', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: CONFIRMED_FIELDS,
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  assert.equal(mock.counts.userInfo, 1);
  assert.match(mock.lastUserInfo.authorization, /^Bearer \S+$/);
});

// 作废口径（2026-10-28 答复的 work_no/pinyin）：同一套内部键映射到另一组声明，
// 保留一组用例证明映射机制对 claim 名不敏感，不构成契约。
test('legacy mapping work_no/pinyin projects workNo and name', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'workNoPinyin';
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: LEGACY_WORK_NO_PINYIN,
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  assert.equal(mock.counts.userInfo, 1);
});

// 已确认口径的字段缺失形态：后管删除姓名后其余字段照常返回。
test('missing name degrades to the remaining fields without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'missingName';
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: CONFIRMED_FIELDS,
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234' });
});

// 候选口径 B 的字段缺失形态。
test('missing pinyin degrades to the remaining fields without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  // 候选口径 B 的响应形态 + 姓名缺失：两者由同一模式位表达。
  mock.control.userInfoMode = 'workNoPinyinMissingName';
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    profileFields: LEGACY_WORK_NO_PINYIN,
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234' });
});

test('explicit login and panel polling preserve in-flight optional UserInfo discovery', { timeout: 4000 }, async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const discoveryUrl = `${mock.issuer}/.well-known/openid-configuration`;
  let discoveryReads = 0;
  const service = createIamService(configFor(mock, { userInfoEndpoint: '', revocationEndpoint: '', discoveryUrl }), {
    credentials: new MemoryCredentials(),
    profileFields: { workNo: 'employeeNumber' },
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
  t.after(() => mock.close());
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
  const { grant } = await store.read();
  await store.write({ ...grant, accessToken: 'synthetic-next-access', refreshToken: 'synthetic-next-refresh' });
  assert.equal((await service.syncFromStore()).state, 'ready');
  profileResponse.resolve(Response.json({ work_no: 'first-access-profile' }));
  await setImmediate();
  assert.equal(service.getIdentityProfile(), undefined);
});

test('UserInfo failure degrades without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'http500';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), profileFields: CONFIRMED_FIELDS });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
});

test('UserInfo 401 follows the enterprise contract and degrades', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'unauthorized';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), profileFields: CONFIRMED_FIELDS });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
});

test('malformed UserInfo JSON degrades and sign-out clears the profile', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'malformed';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), profileFields: CONFIRMED_FIELDS });
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
  const service = createIamService(configFor(mock), { credentials, profileFields: CONFIRMED_FIELDS });
  t.after(() => service.dispose());
  await signIn(service);
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  await credentials.deleteRecord('heluo-iam/session');
  await service.syncFromStore();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getIdentityProfile(), undefined, 'a stale profile must not survive its grant');
});

// 刷新换票不清投影（issue #160 澄清后的契约）：刷新保留同一 grantIdentity
// （同一会话同一主体），identity 保持稳定；刷新路径亦不重新请求 UserInfo。
test('identity persists across token refresh for both view and session read paths', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  // 巨大的 skew 让 resolveToken 立即走刷新路径。
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 999999 }), {
    credentials,
    profileFields: CONFIRMED_FIELDS,
  });
  t.after(() => service.dispose());
  await signIn(service);
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  await service.resolveToken();
  assert.equal(mock.counts.refresh, 1, 'the refresh path must have run');
  assert.equal(mock.counts.userInfo, 1, 'refresh must not re-request UserInfo');
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
  assert.deepEqual(service.getView().identity, { workNo: '10001234', name: 'Zhang San' });
  assert.deepEqual(service.getSession().identity, { workNo: '10001234', name: 'Zhang San' });
});

// 企业 IAM 的 profile 端点实测要求 query 传令牌（issue #160 联调口径）。
test('query token transport sends access_token as a URL parameter', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock, { userInfoTokenTransport: 'query' }), {
    credentials: new MemoryCredentials(),
    profileFields: CONFIRMED_FIELDS,
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(mock.lastUserInfo.authorization, null);
  assert.match(mock.lastUserInfo.queryToken, /^\S+$/);
  assert.deepEqual(service.getIdentityProfile(), { workNo: '10001234', name: 'Zhang San' });
});

// 视图/RPC 白名单（issue #160）：identity 只进显示投影，原始响应不进任何读面。
test('view and session expose the projected identity only, never raw UserInfo', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), profileFields: CONFIRMED_FIELDS });
  t.after(() => service.dispose());
  await signIn(service);

  const view = service.getView();
  assert.deepEqual(view.identity, { workNo: '10001234', name: 'Zhang San' });

  const session = service.getSession();
  assert.deepEqual(session.identity, { workNo: '10001234', name: 'Zhang San' });

  // PII 红线：令牌、sub、authTime 不进视图、不进 RPC。
  const viewText = JSON.stringify(view);
  const sessionText = JSON.stringify(session);
  assert.equal(viewText.includes('1794363364'), false, 'authTime must not reach the view');
  assert.equal(sessionText.includes('1794363364'), false, 'authTime must not reach the session RPC');
  assert.equal(viewText.includes('"sub"'), false, 'raw sub must not reach the view');
  assert.equal(viewText.includes('Bearer'), false);

  await service.signOut();
  assert.equal(service.getView().identity, null);
  assert.equal(service.getSession().identity, undefined);
});
