import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WORKBENCH_API_PREFIX, WORKBENCH_REQUEST_HEADER } from '../src/http.mjs';
import { apply } from '../src/index.mjs';

const MOCK_SERVER_SCRIPT = resolve(
  fileURLToPath(new URL('../../../scripts/probe/mock-dop-server.mjs', import.meta.url)),
);

async function startMockServerWithAtPrefix(t) {
  const child = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    env: {
      ...process.env,
      MOCK_DOP_PORT: '0',
      MOCK_DOP_ACCEPT_AT_PREFIX: '1',
      MOCK_DOP_TOKEN: 'mock-dop-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });

  return new Promise((resolveUrl, reject) => {
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
  });
}

test('end-to-end Host plugin + webServer HTTP loop against external mock-dop-server', async (t) => {
  const prevCfgPath = process.env.WORKBENCH_CONFIG_PATH;
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'wb-e2e-cfg-'));
  const isolatedCfgPath = join(tmpDir, 'workbench-config.json');
  process.env.WORKBENCH_CONFIG_PATH = isolatedCfgPath;
  t.after(() => {
    if (prevCfgPath === undefined) delete process.env.WORKBENCH_CONFIG_PATH;
    else process.env.WORKBENCH_CONFIG_PATH = prevCfgPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dopBaseUrl = await startMockServerWithAtPrefix(t);

  let tokenCalls = 0;
  let issuedToken = 'expired-invalid-token';
  let refreshCount = 0;

  const mockIam = {
    getSession: () => ({
      signedIn: true,
      principal: { issuer: 'https://iam.corp.example/oidc', subject: '000001' },
    }),
    async getAccessToken(...args) {
      assert.equal(args.length, 0, 'ctx.iam.getAccessToken() 必须无参调用');
      tokenCalls += 1;
      if (tokenCalls === 2) {
        refreshCount += 1;
        issuedToken = 'at-valid-iam-token-9999';
      }
      return issuedToken;
    },
  };

  let mountedHandler = null;
  const disposers = [];
  const fakeCtx = {
    iam: mockIam,
    devops: { available: true },
    gitee: { available: true },
    webServer: {
      register(entry) {
        assert.equal(entry.kind, 'prefix');
        assert.equal(entry.path, WORKBENCH_API_PREFIX);
        mountedHandler = entry.handler;
        return () => {
          mountedHandler = null;
        };
      },
    },
    provide() {},
    inject() {
      return () => {};
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
  };

  apply(fakeCtx, {
    enabled: true,
    apiBaseUrl: dopBaseUrl,
    authMode: 'iam',
    requestTimeoutMs: 5000,
  });

  assert.ok(mountedHandler, 'webServer route handler should be registered');

  const hostServer = createServer((req, res) => mountedHandler(req, res));
  await new Promise((resListen) => hostServer.listen(0, '127.0.0.1', resListen));
  t.after(() => {
    for (const d of disposers) d();
    hostServer.close();
  });

  const port = hostServer.address().port;
  const hostBaseUrl = `http://127.0.0.1:${port}${WORKBENCH_API_PREFIX}`;
  const reqHeaders = { [WORKBENCH_REQUEST_HEADER]: '1' };

  // 1. /bootstrap（触发首包 403 -> IAM 静默刷新 -> 200）
  const bootRes = await fetch(`${hostBaseUrl}/bootstrap`, { headers: reqHeaders });
  assert.equal(bootRes.status, 200);
  const bootJson = await bootRes.json();
  assert.equal(bootJson.ok, true);
  assert.equal(bootJson.ready, true);
  assert.equal(bootJson.isLoopbackEndpoint, true);
  assert.equal(bootJson.capabilities.devopsAvailable, true);
  assert.equal(bootJson.capabilities.giteeAvailable, true);
  assert.equal('teams' in bootJson.profile, false);
  assert.equal(refreshCount, 1);

  // 2. /summary（7 路待办 + 3 大进展板）
  const sumRes = await fetch(`${hostBaseUrl}/summary?reqView=manager&implView=responsible&projView=responsible`, {
    headers: reqHeaders,
  });
  assert.equal(sumRes.status, 200);
  const sumJson = await sumRes.json();
  assert.equal(sumJson.ok, true);
  assert.equal(Object.keys(sumJson.todos.categories).length, 7);
  assert.ok(sumJson.boards.requirement.progress);
  assert.ok(sumJson.boards.implementation.story);
  assert.ok(sumJson.boards.project.progress);

  // 3. /requirements
  const reqListRes = await fetch(`${hostBaseUrl}/requirements?view=managedByMe`, { headers: reqHeaders });
  assert.equal(reqListRes.status, 200);
  const reqListJson = await reqListRes.json();
  assert.equal(reqListJson.ok, true);
  assert.ok(reqListJson.requirements.items.length > 0);
  const firstReqId = reqListJson.requirements.items[0].requirementId;
  const firstStoryId = reqListJson.stories.items[0]?.id || 'STORY-MOCK-1001';

  // 4. /rmp/docs & /rmp/outline
  const docsRes = await fetch(`${hostBaseUrl}/rmp/docs?latestOnly=false`, { headers: reqHeaders });
  assert.equal(docsRes.status, 200);
  const docsJson = await docsRes.json();
  assert.equal(docsJson.ok, true);
  assert.ok(docsJson.items.length > 0);
  const firstDoc = docsJson.items[0];

  const outlineRes = await fetch(`${hostBaseUrl}/rmp/outline?docId=${encodeURIComponent(firstDoc.docid)}`, {
    headers: reqHeaders,
  });
  assert.equal(outlineRes.status, 200);
  const outlineJson = await outlineRes.json();
  assert.equal(outlineJson.ok, true);
  assert.ok(outlineJson.nodes.length > 0);
  const firstNode = outlineJson.nodes[0];

  // 5. POST /prompt/build 覆盖 4 类动作
  const postHeaders = { ...reqHeaders, 'content-type': 'application/json' };

  const pOneRes = await fetch(`${hostBaseUrl}/prompt/build`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ actionKey: 'req.create.one_sentence', idea: '联调新建需求示例' }),
  });
  assert.equal(pOneRes.status, 200);

  const pDocRes = await fetch(`${hostBaseUrl}/prompt/build`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      actionKey: 'req.clarify.from_doc',
      source: 'rmp',
      docId: firstDoc.docid,
      docName: firstDoc.docname,
      docVer: firstDoc.docver,
      sections: [{ iid: firstNode.idoc_id, scode: firstNode.scode, sname: firstNode.sname }],
    }),
  });
  assert.equal(pDocRes.status, 200);
  const pDocJson = await pDocRes.json();
  assert.ok(pDocJson.prompt.includes('示例需求正文'));

  const pReqCardRes = await fetch(`${hostBaseUrl}/prompt/build`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ actionKey: 'req.card.clarify_and_split', requirementId: firstReqId, mode: 'split' }),
  });
  assert.equal(pReqCardRes.status, 200);

  const pStoryCardRes = await fetch(`${hostBaseUrl}/prompt/build`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ actionKey: 'story.card.design_and_prep', storyId: firstStoryId }),
  });
  assert.equal(pStoryCardRes.status, 200);

  // 6. PUT /preferences -> 重查 /bootstrap 生效
  const putPrefRes = await fetch(`${hostBaseUrl}/preferences`, {
    method: 'PUT',
    headers: postHeaders,
    body: JSON.stringify({ rolePreset: 'dev_owner' }),
  });
  assert.equal(putPrefRes.status, 200);

  const bootAfterRes = await fetch(`${hostBaseUrl}/bootstrap`, { headers: reqHeaders });
  const bootAfterJson = await bootAfterRes.json();
  assert.equal(bootAfterJson.preferences.rolePreset, 'dev_owner');
  assert.equal(bootAfterJson.preferences.boardOrder[0], 'implementation');

  // 7. GET /config -> PUT /config 持久化热更新 -> PUT /config resetToDefault -> GET /itsm/open-url
  const cfgInitRes = await fetch(`${hostBaseUrl}/config`, { headers: reqHeaders });
  assert.equal(cfgInitRes.status, 200);
  const cfgInitJson = await cfgInitRes.json();
  assert.equal(cfgInitJson.placeholderApiBaseUrl, 'https://dop.corp.example');
  assert.equal(cfgInitJson.config.authMode, 'iam');
  assert.equal(cfgInitJson.hasOverride, false);

  const cfgUpdateRes = await fetch(`${hostBaseUrl}/config`, {
    method: 'PUT',
    headers: postHeaders,
    body: JSON.stringify({ requestTimeoutMs: 12000 }),
  });
  assert.equal(cfgUpdateRes.status, 200);
  const cfgUpdateJson = await cfgUpdateRes.json();
  assert.equal(cfgUpdateJson.hasOverride, true);
  assert.equal(cfgUpdateJson.config.requestTimeoutMs, 12000);
  assert.equal(existsSync(isolatedCfgPath), true);

  const cfgResetRes = await fetch(`${hostBaseUrl}/config`, {
    method: 'PUT',
    headers: postHeaders,
    body: JSON.stringify({ resetToDefault: true }),
  });
  assert.equal(cfgResetRes.status, 200);
  const cfgResetJson = await cfgResetRes.json();
  assert.equal(cfgResetJson.hasOverride, false);
  assert.equal(cfgResetJson.config.apiBaseUrl, dopBaseUrl);

  const itsmOpenRes = await fetch(`${hostBaseUrl}/itsm/open-url?wjbiid=WJBI-E2E-1`, { headers: reqHeaders });
  assert.equal(itsmOpenRes.status, 200);
  const itsmOpenJson = await itsmOpenRes.json();
  assert.equal(itsmOpenJson.ok, true);
  assert.ok(itsmOpenJson.url.includes('/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-E2E-1'));
});
