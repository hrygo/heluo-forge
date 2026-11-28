import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { validateConfig } from '../src/shared/config.mjs';
import { ERROR_CODES } from '../src/shared/errors.mjs';
import { createWorkbenchHttpApi, toNodeRoute, WORKBENCH_API_PREFIX, WORKBENCH_REQUEST_HEADER } from '../src/http.mjs';
import { buildPortalLinks, sanitizePortalUrl } from '../src/portal-links.mjs';
import { buildWorkbenchPrompt, MAX_DOC_INJECT_BYTES, stripHtmlToText } from '../src/prompt-builder.mjs';

test('prompt-builder: stripHtmlToText recognizes nodata placeholder and plain HTML', () => {
  const empty = stripHtmlToText('<p class="nodata"></p>');
  assert.equal(empty.isEmptyPlaceholder, true);
  assert.equal(empty.text, '');

  const parsed = stripHtmlToText('<p>前置条件&amp;口径</p><p>第二行</p>');
  assert.equal(parsed.isEmptyPlaceholder, false);
  assert.equal(parsed.text, '前置条件&口径\n第二行');
});

test('prompt-builder: builds all 4 phase-1 prompts and enforces 2000-char / 16 KiB caps', () => {
  // 1. 一句话新建需求
  const p1 = buildWorkbenchPrompt({
    actionKey: 'req.create.one_sentence',
    ownerName: '示例用户1',
    idea: '新增企业研发报表日终导出并校验异常指标',
  });
  assert.equal(p1.meta.promptKind, 'req.create.one_sentence');
  assert.ok(p1.prompt.includes('示例用户1'));
  assert.ok(p1.prompt.includes('新增企业研发报表日终导出'));
  assert.ok(p1.prompt.includes('ask_user_question'));
  assert.ok(p1.prompt.includes('forge_workbench_rmp_doc_search'));
  assert.ok(p1.prompt.length <= 4000);

  assert.throws(
    () => buildWorkbenchPrompt({ actionKey: 'req.create.one_sentence', idea: 'a'.repeat(2001) }),
    (err) => err.code === ERROR_CODES.BAD_REQUEST,
  );

  // 2. 已有文档澄清：nodata 过滤 + 超 16 KiB 截断
  const bigBody = '<p>' + '重要业务规则约束描述文本。'.repeat(1200) + '</p>';
  assert.ok(Buffer.byteLength(bigBody, 'utf8') > MAX_DOC_INJECT_BYTES);
  const p2 = buildWorkbenchPrompt({
    actionKey: 'req.clarify.from_doc',
    source: 'rmp',
    docName: '示例业务需求说明书',
    docVer: '2.1.0',
    sections: [
      { iid: 's1', scode: '1.1', sname: '空白章节', html: '<p class="nodata"></p>' },
      { iid: 's2', scode: '1.2', sname: '核心规则', html: bigBody },
    ],
  });
  assert.equal(p2.meta.truncated, true);
  assert.deepEqual(p2.meta.emptySections, ['1.1 空白章节']);
  assert.ok(p2.prompt.includes('已安全截断'));
  assert.ok(p2.prompt.includes('nodata'));
  assert.ok(p2.prompt.includes('ask_user_question'));
  assert.ok(p2.prompt.includes('forge_workbench_rmp_outline_read'));

  // 本地上传
  const p2Local = buildWorkbenchPrompt({
    actionKey: 'req.clarify.from_doc',
    source: 'local',
    fileName: 'draft.md',
    content: '# 背景\n需要支持批量导出报表。',
  });
  assert.equal(p2Local.meta.truncated, false);
  assert.ok(p2Local.prompt.includes('《draft.md》'));

  // 3. 需求卡片（split & qa）
  const p3 = buildWorkbenchPrompt({
    actionKey: 'req.card.clarify_and_split',
    mode: 'split',
    requirement: {
      no: 'REQ-MOCK-1009',
      name: '示例需求',
      stage: { name: '实施中' },
      state: { name: '正常' },
      manager: { name: '示例用户3', loginCode: '000011' },
      businessOwner: { name: '示例用户1', loginCode: '000009' },
      backGround: '<p>背景说明</p>',
      description: '<p>详情说明</p>',
      reqDocs: [{ docName: '说明书A' }],
      redundantDeepField: 'SHOULD_NOT_APPEAR',
    },
  });
  assert.ok(p3.prompt.includes('REQ-MOCK-1009'));
  assert.equal(p3.prompt.includes('SHOULD_NOT_APPEAR'), false);
  assert.ok(p3.prompt.includes('ask_user_question'));
  assert.ok(p3.prompt.includes('forge_workbench_requirement_read'));

  // 4. 故事卡片
  const p4 = buildWorkbenchPrompt({
    actionKey: 'story.card.design_and_prep',
    story: {
      code: 'STORY-MOCK-1004',
      summary: '示例用户故事',
      requirement: { no: 'REQ-MOCK-1010', name: '父需求' },
      state: { name: '已上线' },
      storyPoint: null,
      systemChanges: [{ code: 'CHG-MOCK-01' }],
      description: '<p>实现接口适配</p>',
    },
    cliHints: { suggestions: ['可调用 forge_devops_change_context 查询变更单 CHG-MOCK-01'] },
  });
  assert.ok(p4.prompt.includes('STORY-MOCK-1004'));
  assert.ok(p4.prompt.includes('CHG-MOCK-01'));
  assert.ok(p4.prompt.includes('forge_devops_change_context'));
  assert.ok(p4.prompt.includes('ask_user_question'));
  assert.ok(p4.prompt.includes('forge_workbench_story_read'));
});

test('portal-links: builds safe http/https URLs aligned with internal DOP routes without tokens', () => {
  const links = buildPortalLinks('http://127.0.0.1:5610///');
  assert.equal(links.isConfigured, true);
  assert.equal(links.requirementUrl('REQ 1'), 'http://127.0.0.1:5610/dop/asd/requirement?id=REQ%201');
  assert.equal(links.storyUrl('STORY-1'), 'http://127.0.0.1:5610/dop/asd/storyDetail?id=STORY-1');
  assert.equal(links.rmpDocUrl('DOC-1'), 'http://127.0.0.1:5610/rdp/vpgatway/vrmprovider/rms/api/viewDocContent?docId=DOC-1');
  assert.equal(links.itsmUrl('WJBI-1'), 'http://127.0.0.1:5610/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-1');
  assert.equal(links.bizFlowUrl('reqFlow', 'T-9'), 'http://127.0.0.1:5610/dop/asd/reqFlow?taskId=T-9');
  assert.equal(links.bizFlowUrl('', ''), 'http://127.0.0.1:5610/dop/asd/dashboard');
  assert.equal(links.todoCenterUrl(), 'http://127.0.0.1:5610/dop/asd/dashboard');
  assert.equal(links.boardLink('requirement', 'total', 'manager'), 'http://127.0.0.1:5610/dop/asd/dashboard');

  assert.equal(sanitizePortalUrl('javascript:alert(1)'), '');
  assert.equal(sanitizePortalUrl('data:text/html,hi'), '');
  const uInfo = ['https', '://u:', 'p', '@corp.example/path'].join('');
  assert.equal(sanitizePortalUrl(uInfo), '');
  assert.equal(sanitizePortalUrl('https://corp.example/dop/asd/requirement?id=1'), 'https://corp.example/dop/asd/requirement?id=1');
});

test('http adapter: enforces x-forge-workbench-request header, security headers, zero CORS, and route matrix', async () => {
  let savedConfig = {
    enabled: true,
    apiBaseUrl: '',
    authMode: 'iam',
    requestTimeoutMs: 10000,
  };
  const stubService = {
    endpointKind: 'enterprise',
    async getBootstrap() {
      return { ok: true, ready: false, reason: 'CONFIG_MISSING', isLoopbackEndpoint: false };
    },
    async getRuntimeConfig() {
      return {
        ok: true,
        config: savedConfig,
        placeholderApiBaseUrl: 'https://dop.corp.example',
        configSource: savedConfig.apiBaseUrl ? 'local-override' : 'unconfigured',
        inheritedSource: 'unconfigured',
        inheritedApiBaseUrl: '',
        inheritedEnvKey: '',
        hasOverride: Boolean(savedConfig.apiBaseUrl),
      };
    },
    async updateRuntimeConfig(body) {
      savedConfig = { ...savedConfig, ...body, authMode: 'iam' };
      return {
        ok: true,
        config: savedConfig,
        placeholderApiBaseUrl: 'https://dop.corp.example',
        configSource: 'local-override',
        inheritedSource: 'unconfigured',
        inheritedApiBaseUrl: '',
        inheritedEnvKey: '',
        hasOverride: true,
      };
    },
    async resolveItsmPortalUrl({ wjbiid }) {
      return { ok: true, url: `http://127.0.0.1:5610/backstage/workflow/serviceApply/applyCopyView?wjbiid=${encodeURIComponent(wjbiid)}` };
    },
    async getSummary(q) {
      return { ok: true, q };
    },
    async getRequirements(q) {
      return { ok: true, q };
    },
    async searchRmpDocs(q) {
      return { ok: true, items: [], q };
    },
    async getRmpOutline(q) {
      return { ok: true, docId: q.docId, nodes: [] };
    },
    async buildPrompt(body) {
      return { ok: true, prompt: `PROMPT:${body.actionKey}`, meta: {} };
    },
    async savePreferences(body) {
      return { ok: true, preferences: body };
    },
  };

  const api = createWorkbenchHttpApi(stubService);
  const handler = toNodeRoute(api);

  async function invoke(method, url, headers = {}, bodyObj = null) {
    const req = {
      method,
      url,
      headers,
      body: bodyObj ? JSON.stringify(bodyObj) : '',
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(txt) {
        this.body = txt;
        this.writableEnded = true;
      },
    };
    await handler(req, res);
    return {
      status: res.statusCode,
      headers: res.headers,
      json: JSON.parse(res.body),
    };
  }

  // 缺自定义预检头返回 403
  const noHeader = await invoke('GET', `${WORKBENCH_API_PREFIX}/bootstrap`);
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.error.code, ERROR_CODES.REQUEST_HEADER_REQUIRED);
  assert.equal(noHeader.headers['cache-control'], 'no-store');
  assert.equal(noHeader.headers['x-content-type-options'], 'nosniff');
  assert.equal(noHeader.headers['access-control-allow-origin'], undefined);

  const noHeaderConfig = await invoke('PUT', `${WORKBENCH_API_PREFIX}/config`, {}, { apiBaseUrl: 'http://127.0.0.1:5610' });
  assert.equal(noHeaderConfig.status, 403);

  const authHeaders = { [WORKBENCH_REQUEST_HEADER]: '1' };

  const boot = await invoke('GET', `${WORKBENCH_API_PREFIX}/bootstrap/`, authHeaders);
  assert.equal(boot.status, 200);
  assert.equal(boot.json.reason, 'CONFIG_MISSING');

  const cfgGet = await invoke('GET', `${WORKBENCH_API_PREFIX}/config`, authHeaders);
  assert.equal(cfgGet.status, 200);
  assert.equal(cfgGet.json.placeholderApiBaseUrl, 'https://dop.corp.example');
  assert.equal(cfgGet.json.config.authMode, 'iam');

  const cfgPut = await invoke('PUT', `${WORKBENCH_API_PREFIX}/config`, authHeaders, { apiBaseUrl: 'http://127.0.0.1:5610' });
  assert.equal(cfgPut.status, 200);
  assert.equal(cfgPut.json.config.apiBaseUrl, 'http://127.0.0.1:5610');
  assert.equal(cfgPut.json.hasOverride, true);

  const itsmRes = await invoke('GET', `${WORKBENCH_API_PREFIX}/itsm/open-url?wjbiid=WJBI-1`, authHeaders);
  assert.equal(itsmRes.status, 200);
  assert.equal(itsmRes.json.url, 'http://127.0.0.1:5610/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-1');

  const promptRes = await invoke(
    'POST',
    `${WORKBENCH_API_PREFIX}/prompt/build`,
    authHeaders,
    { actionKey: 'req.create.one_sentence', idea: 'test' },
  );
  assert.equal(promptRes.status, 200);
  assert.equal(promptRes.json.prompt, 'PROMPT:req.create.one_sentence');

  const badMethod = await invoke('GET', `${WORKBENCH_API_PREFIX}/prompt/build`, authHeaders);
  assert.equal(badMethod.status, 405);

  const notFound = await invoke('GET', `${WORKBENCH_API_PREFIX}/nonexistent`, authHeaders);
  assert.equal(notFound.status, 404);

  // 验证公版默认空 apiBaseUrl 与 pure iam
  const emptyCfg = validateConfig({});
  assert.equal(emptyCfg.apiBaseUrl, '');
  assert.equal(emptyCfg.authMode, 'iam');
});

test('http adapter: enforces DSH connection guard (401 / 403 / 503 / pass) alongside custom header', async () => {
  const stubService = {
    endpointKind: 'enterprise',
    async getRuntimeConfig() {
      return { ok: true, config: { enabled: true, apiBaseUrl: '', authMode: 'iam', requestTimeoutMs: 10000 } };
    },
  };

  let decision = undefined;
  let api = createWorkbenchHttpApi(stubService, {
    getConnection: () => ({
      requestRejection() {
        return decision;
      },
    }),
  });

  const headers = { [WORKBENCH_REQUEST_HEADER]: '1' };

  decision = 401;
  const r401 = await api.dispatch({ method: 'GET', pathname: `${WORKBENCH_API_PREFIX}/config`, headers });
  assert.equal(r401.status, 401);
  assert.equal(r401.body.error.code, ERROR_CODES.UNAUTHORIZED);

  decision = 403;
  const r403 = await api.dispatch({ method: 'GET', pathname: `${WORKBENCH_API_PREFIX}/config`, headers });
  assert.equal(r403.status, 403);
  assert.equal(r403.body.error.code, ERROR_CODES.FORBIDDEN);

  // 返回 Promise（非同步决定）应 fail-closed 返回 503，且不产生未处理拒绝
  decision = Promise.reject(new Error('async boom'));
  const rAsync = await api.dispatch({ method: 'GET', pathname: `${WORKBENCH_API_PREFIX}/config`, headers });
  assert.equal(rAsync.status, 503);
  assert.equal(rAsync.body.error.code, ERROR_CODES.UNAVAILABLE);

  // 无 requestRejection 或抛同步异常时 fail-closed 返回 503
  api = createWorkbenchHttpApi(stubService, {
    getConnection: () => ({
      requestRejection() {
        throw new Error('boom');
      },
    }),
  });
  const rThrow = await api.dispatch({ method: 'GET', pathname: `${WORKBENCH_API_PREFIX}/config`, headers });
  assert.equal(rThrow.status, 503);
  assert.equal(rThrow.body.error.code, ERROR_CODES.UNAVAILABLE);

  // 显式返回 undefined 时放行
  api = createWorkbenchHttpApi(stubService, {
    getConnection: () => ({ requestRejection: () => undefined }),
  });
  const rOk = await api.dispatch({ method: 'GET', pathname: `${WORKBENCH_API_PREFIX}/config`, headers });
  assert.equal(rOk.status, 200);
  assert.equal(rOk.body.ok, true);
});
