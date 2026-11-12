import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { normalizeProfileFields, projectUserInfo, fetchUserInfo, DEFAULT_PROFILE_FIELDS } from '../src/userinfo.mjs';
import { IamError } from '../src/errors.mjs';

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
  assert.deepEqual(projectUserInfo(raw, DEFAULT_PROFILE_FIELDS), {
    user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan',
  });
  assert.deepEqual(projectUserInfo(raw, { user_id: 'employeeNumber' }), { user_id: '10001234' });
  assert.equal(projectUserInfo(raw, { user_id: 'missing' }), undefined);
  assert.equal(projectUserInfo({ employeeNumber: 42, displayName: '   ' }, { user_id: 'employeeNumber', user_name: 'displayName' }), undefined);
  assert.equal(projectUserInfo(raw, {}), undefined);
  assert.equal(projectUserInfo(null, { user_id: 'employeeNumber' }), undefined);
});

test('normalizeProfileFields keeps only known string keys', () => {
  assert.deepEqual({ ...normalizeProfileFields({ user_id: 'employeeNumber', user_name: 'displayName', extra: 'x', unknown: 1 }) },
    { user_id: 'employeeNumber', user_name: 'displayName' });
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

test('default mapping is the confirmed field contract and requests UserInfo once', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  // 未传 profileFields：默认启用定稿口径（issue #160）。
  const service = createIamService(configFor(mock), { credentials });
  t.after(() => service.dispose());
  const view = await signIn(service);
  assert.equal(view.state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), {
    user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan',
  });
  assert.equal(mock.counts.userInfo, 1);
  assert.match(mock.lastUserInfo.authorization, /^Bearer \S+$/);
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

test('UserInfo failure degrades without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'http500';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
});

test('UserInfo 401 follows the enterprise contract and degrades', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'unauthorized';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(service.getIdentityProfile(), undefined);
});

test('malformed UserInfo JSON degrades and sign-out clears the profile', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'malformed';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
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
  const service = createIamService(configFor(mock), { credentials });
  t.after(() => service.dispose());
  await signIn(service);
  assert.deepEqual(service.getIdentityProfile(), {
    user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan',
  });
  await credentials.deleteRecord('heluo-iam/session');
  await service.syncFromStore();
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getIdentityProfile(), undefined, 'a stale profile must not survive its grant');
});

// Fixture B（issue #160）：后管删除 displayName 后的真实形态——
// 登录成功、投影缺失姓名、其余字段照常返回。
test('missing displayName degrades to the remaining fields without failing login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  mock.control.userInfoMode = 'missingName';
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.deepEqual(service.getIdentityProfile(), { user_id: '10001234', work_no: 'zhangsan' });
});

// 企业 IAM 的 profile 端点实测要求 query 传令牌（issue #160 联调口径）。
test('query token transport sends access_token as a URL parameter', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock, { userInfoTokenTransport: 'query' }), {
    credentials: new MemoryCredentials(),
  });
  t.after(() => service.dispose());
  assert.equal((await signIn(service)).state, 'ready');
  assert.equal(mock.lastUserInfo.authorization, null);
  assert.match(mock.lastUserInfo.queryToken, /^\S+$/);
  assert.deepEqual(service.getIdentityProfile(), {
    user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan',
  });
});

// 视图/RPC 白名单（issue #160）：identity 只进显示投影，原始响应不进任何读面。
test('view and session expose the projected identity only, never raw UserInfo', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  t.after(() => service.dispose());
  await signIn(service);

  const view = service.getView();
  assert.deepEqual(view.identity, { user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan' });

  const session = service.getSession();
  assert.deepEqual(session.identity, { user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan' });

  // PII 红线：令牌、sub、authTime 不进视图、不进 RPC。
  const viewText = JSON.stringify(view);
  const sessionText = JSON.stringify(session);
  assert.equal(viewText.includes('1794363364'), false, 'authTime must not reach the view');
  assert.equal(sessionText.includes('1794363364'), false, 'authTime must not reach the session RPC');
  assert.equal(viewText.includes('"sub"'), false, 'raw sub must not reach the view');
  assert.equal(JSON.stringify(view).includes('Bearer'), false);

  await service.signOut();
  assert.equal(service.getView().identity, null);
  assert.equal(service.getSession().identity, undefined);
});
