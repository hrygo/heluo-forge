import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../src/shared/config.mjs';
import { createDopClient } from '../src/shared/dop-client.mjs';
import { ERROR_CODES } from '../src/shared/errors.mjs';
import { createRmpClient } from '../src/shared/rmp-sso.mjs';
import { createOverviewApi } from '../src/domains/overview/api.mjs';
import { createWorkbenchService } from '../src/service.mjs';

const MOCK_SERVER_SCRIPT = resolve(
  fileURLToPath(new URL('../../../scripts/probe/mock-dop-server.mjs', import.meta.url)),
);

async function startMockServerProcess(t, envOverrides = {}) {
  const child = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    env: {
      ...process.execPath ? process.env : {},
      ...process.env,
      MOCK_DOP_PORT: '0',
      MOCK_DOP_TOKEN: 'mock-dop-token,mock-refreshed-token',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    if (!child.killed) child.kill();
  });

  const baseUrl = await new Promise((resolveUrl, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Mock server startup timeout: ${stderr}`)), 8000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Mock server exited prematurely (${code}): ${stderr}`));
    });
  });

  return baseUrl;
}

test('DOP adapter sends bare Authorization header, projects myProfile, and refreshes once on 403', async (t) => {
  const baseUrl = await startMockServerProcess(t);

  let tokenCalls = 0;
  const dop = createDopClient({
    apiBaseUrl: baseUrl,
    requestTimeoutMs: 5000,
    async getToken({ forceRefresh }) {
      tokenCalls += 1;
      if (tokenCalls === 1 && !forceRefresh) return 'expired-token-triggers-403';
      return 'mock-dop-token';
    },
  });

  const profile = await dop.getMyProfile();
  assert.equal(tokenCalls, 2);
  assert.ok(profile.loginCode);
  assert.ok(profile.name);
  // 确保 4.77 MB 全量 teams 等未投影键被彻底剔除
  assert.equal('teams' in profile, false);

  // IAM 刷新 1 次后仍 403 -> UPSTREAM_AUTH_DENIED
  let failRefreshCalls = 0;
  const alwaysDeniedClient = createDopClient({
    apiBaseUrl: baseUrl,
    requestTimeoutMs: 5000,
    async getToken() {
      failRefreshCalls += 1;
      return 'always-denied-token';
    },
  });
  const alwaysDeniedOverview = createOverviewApi(() => alwaysDeniedClient);
  await assert.rejects(
    () => alwaysDeniedOverview.getTodoList(),
    (err) => err.code === ERROR_CODES.UPSTREAM_AUTH_DENIED && err.httpStatus === 403,
  );
  assert.equal(failRefreshCalls, 2);
});

test('RMP client exchanges _tk once, caches it, sends form-urlencoded for getOutlineTree, and re-exchanges on 401', async (t) => {
  const baseUrl = await startMockServerProcess(t);

  const realFetch = globalThis.fetch;
  let ssoHits = 0;
  let forceNext401 = false;
  const wrappedFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rms/api/sso')) ssoHits += 1;
    if (forceNext401 && u.includes('listAllNewVerDoc')) {
      forceNext401 = false;
      return new Response('', { status: 401 });
    }
    return realFetch(url, init);
  };

  const rmp = createRmpClient({
    apiBaseUrl: baseUrl,
    requestTimeoutMs: 5000,
    getSsoToken: async () => 'mock-dop-token',
    fetchImpl: wrappedFetch,
  });

  const docs1 = await rmp.listAllVerDoc({ sessionKey: 'u1', quickSearch: '' });
  assert.equal(docs1.infocode, 'VP000000');
  assert.equal(ssoHits, 1);

  // 第二次调用命中内存缓存，不应再次打 /sso
  const outline = await rmp.getOutlineTree({ sessionKey: 'u1', docId: 'DOC-MOCK-1001' });
  assert.ok(Array.isArray(outline.nodes ?? outline.data));
  assert.equal(ssoHits, 1);

  // 注入 401 空响应体，验证缓存淘汰 + 重换 _tk 重试 1 次成功
  forceNext401 = true;
  const docs2 = await rmp.listAllNewVerDoc({ sessionKey: 'u1' });
  assert.equal(docs2.infocode, 'VP000000');
  assert.equal(ssoHits, 2);

  // 空正文识别
  const nodata = await rmp.getTabContent({ sessionKey: 'u1', iid: 'sec-1', emptyContent: '1' });
  assert.equal(nodata?.data?.html, '<p class="nodata"></p>');
});

test('service aggregates 7-channel todos, 3 boards (incl. null avgDays), exclusive views, and partial fault degradation', async (t) => {
  const baseUrl = await startMockServerProcess(t);
  const config = validateConfig({
    enabled: true,
    apiBaseUrl: baseUrl,
    authMode: 'iam',
    requestTimeoutMs: 5000,
  });

  const realFetch = globalThis.fetch;
  let failItsm = false;
  const faultAwareFetch = async (url, init) => {
    const u = String(url);
    if (failItsm && u.includes('/odo/api/online/process/list')) {
      return realFetch(url, {
        ...init,
        headers: { ...(init?.headers ?? {}), 'x-mock-fault': '503' },
      });
    }
    return realFetch(url, init);
  };

  const svc = createWorkbenchService({
    config,
    getIam: () => ({
      getSession: () => ({ signedIn: true, principal: { subject: '000001' } }),
      getAccessToken: async () => 'mock-dop-token',
    }),
    fetchImpl: faultAwareFetch,
  });
  t.after(() => svc.dispose());

  const boot = await svc.getBootstrap();
  assert.equal(boot.ok, true);
  assert.equal(boot.ready, true);
  assert.equal(boot.isLoopbackEndpoint, true);
  assert.equal('teams' in boot.profile, false);

  // 正常视角：reqView=business 时两个 average*Days 为 null
  const summaryBiz = await svc.getSummary({
    reqView: 'business',
    implView: 'participate',
    projView: 'participant',
  });
  assert.equal(summaryBiz.ok, true);
  assert.equal(Object.keys(summaryBiz.todos.categories).length, 7);
  assert.equal(summaryBiz.partialErrors.length, 0);
  assert.equal(summaryBiz.boards.requirement.progress.averageAcceptDays, null);
  assert.equal(summaryBiz.boards.requirement.progress.averageAnalyzeDays, null);

  // 验证真实纯数组公告报文与三大进展板可点击外链映射
  assert.ok(summaryBiz.todos.categories.announcements.count >= 1);
  assert.ok(summaryBiz.todos.categories.announcements.items[0].title);
  assert.equal(summaryBiz.boards.requirement.links.total, `${baseUrl}/dop/asd/dashboard`);
  assert.equal(summaryBiz.boards.implementation.links.release.delayed, `${baseUrl}/dop/asd/dashboard`);
  assert.equal(summaryBiz.boards.implementation.links.story.normal, `${baseUrl}/dop/asd/dashboard`);
  assert.equal(summaryBiz.boards.project.links.delay, `${baseUrl}/dop/asd/dashboard`);

  // ITSM 工单实时换票外链解析
  const itsmOpen = await svc.resolveItsmPortalUrl({ wjbiid: 'WJBI-MOCK-001' });
  assert.equal(itsmOpen.ok, true);
  assert.ok(itsmOpen.url.includes('/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-MOCK-001'));

  // 局部 503 故障注入：ITSM 局部降级，其余 6 路待办与三大看板仍完整可用
  failItsm = true;
  const summaryDegraded = await svc.getSummary({ refresh: true });
  assert.equal(summaryDegraded.ok, true);
  assert.equal(summaryDegraded.todos.categories.itsm.degraded, true);
  assert.equal(summaryDegraded.partialErrors.length, 1);
  assert.equal(summaryDegraded.partialErrors[0].routeKey, 'todo.itsm');
  assert.ok(summaryDegraded.boards.project.progress);

  // 4 互斥需求视角校验与查询
  const managed = await svc.getRequirements({ view: 'managedByMe' });
  assert.equal(managed.ok, true);
  assert.ok(Array.isArray(managed.requirements.items));

  const participant = await svc.getRequirements({ view: 'participantHasMe' });
  assert.equal(participant.ok, true);

  await assert.rejects(
    () => svc.getRequirements({ view: 'invalidView' }),
    (err) => err.code === ERROR_CODES.BAD_REQUEST,
  );

  // 运行时 3 层内网切换：env -> local-override (https://dop.corp.example) -> resetToDefault 回退到 env
  const svcFromEnv = createWorkbenchService({
    baseConfig: validateConfig({}),
    envConfig: { apiBaseUrl: baseUrl, matchedEnvKey: 'HELUO_DOP_BASE_URL' },
    getIam: () => ({
      getSession: () => ({ signedIn: true, principal: { subject: '000001' } }),
      getAccessToken: async () => 'mock-dop-token',
    }),
    fetchImpl: faultAwareFetch,
  });
  t.after(() => svcFromEnv.dispose());

  const envCfgInit = svcFromEnv.getRuntimeConfig();
  assert.equal(envCfgInit.configSource, 'env');
  assert.equal(envCfgInit.inheritedEnvKey, 'HELUO_DOP_BASE_URL');
  assert.equal(envCfgInit.config.apiBaseUrl, baseUrl);

  const updatedCfg = await svcFromEnv.updateRuntimeConfig({ apiBaseUrl: 'https://dop.corp.example' });
  assert.equal(updatedCfg.hasOverride, true);
  assert.equal(updatedCfg.configSource, 'local-override');
  assert.equal(svcFromEnv.isLoopbackEndpoint, false);
  assert.equal(svcFromEnv.endpointKind, 'enterprise');

  const resetCfg = await svcFromEnv.updateRuntimeConfig({ resetToDefault: true });
  assert.equal(resetCfg.hasOverride, false);
  assert.equal(resetCfg.configSource, 'env');
  assert.equal(resetCfg.config.apiBaseUrl, baseUrl);
  assert.equal(svcFromEnv.isLoopbackEndpoint, true);
  assert.equal(svcFromEnv.endpointKind, 'local-loopback');
});
