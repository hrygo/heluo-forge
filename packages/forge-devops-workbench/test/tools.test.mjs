import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { WORKBENCH_TOOLS } from '../src/tools.mjs';

function useIsolatedConfigPath(t) {
  const prev = process.env.WORKBENCH_CONFIG_PATH;
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'wb-tools-cfg-'));
  process.env.WORKBENCH_CONFIG_PATH = join(tmpDir, 'workbench-config.json');
  t.after(() => {
    if (prev === undefined) delete process.env.WORKBENCH_CONFIG_PATH;
    else process.env.WORKBENCH_CONFIG_PATH = prev;
    rmSync(tmpDir, { recursive: true, force: true });
  });
}

const MOCK_SERVER_SCRIPT = resolve(
  fileURLToPath(new URL('../../../scripts/probe/mock-dop-server.mjs', import.meta.url)),
);

async function startMockServer(t) {
  const child = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    env: {
      ...process.env,
      MOCK_DOP_PORT: '0',
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

function parseToolJson(result) {
  const txt = result?.content?.[0]?.text ?? '{}';
  return JSON.parse(txt);
}

test('workbench registers 6 read-only tools via ctx.tools and queries external mock server end-to-end', async (t) => {
  useIsolatedConfigPath(t);
  const baseUrl = await startMockServer(t);
  const registered = new Map();
  const disposers = [];

  const fakeCtx = {
    iam: {
      getSession: () => ({ signedIn: true, principal: { subject: '000001' } }),
      getAccessToken: async () => 'mock-dop-token',
    },
    tools: {
      register(def) {
        registered.set(def.name, def);
        return () => {
          registered.delete(def.name);
        };
      },
    },
    inject() {
      return () => {};
    },
    provide() {},
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
  };

  const service = apply(fakeCtx, {
    enabled: true,
    apiBaseUrl: baseUrl,
    authMode: 'iam',
    requestTimeoutMs: 5000,
  });

  assert.deepEqual(service.toolNames(), [...WORKBENCH_TOOLS]);
  assert.equal(registered.size, 6);
  for (const name of WORKBENCH_TOOLS) {
    assert.ok(registered.has(name), `missing tool ${name}`);
  }

  // 1. forge_workbench_requirement_read
  const reqOut = parseToolJson(await registered.get('forge_workbench_requirement_read').execute({
    requirementId: 'a6524d93122e4aab96022254da0c05cf',
  }));
  assert.equal(reqOut.ok, true);
  assert.equal(reqOut.no, 'REQ-MOCK-1009');
  assert.ok(reqOut.description.includes('汇总报表'));
  assert.ok(reqOut.portalUrl.startsWith(`${baseUrl}/dop/asd/requirement?id=`));

  // 2. forge_workbench_story_read
  const storyOut = parseToolJson(await registered.get('forge_workbench_story_read').execute({
    storyId: 'STORY-MOCK-1004',
  }));
  assert.equal(storyOut.ok, true);
  assert.equal(storyOut.code, 'STORY-MOCK-1004');
  assert.ok(Array.isArray(storyOut.systemChanges) && storyOut.systemChanges.length > 0);
  assert.ok(storyOut.portalUrl.startsWith(`${baseUrl}/dop/asd/storyDetail?id=`));

  // 3. forge_workbench_rmp_doc_search
  const docsOut = parseToolJson(await registered.get('forge_workbench_rmp_doc_search').execute({
    quickSearch: '',
    latestOnly: false,
  }));
  assert.equal(docsOut.ok, true);
  assert.ok(docsOut.items.length > 0);
  assert.ok(docsOut.items[0].portalUrl.startsWith(`${baseUrl}/rdp/vpgatway/vrmprovider/rms/api/viewDocContent?docId=`));

  // 4. forge_workbench_rmp_outline_read
  const outlineOut = parseToolJson(await registered.get('forge_workbench_rmp_outline_read').execute({
    docId: docsOut.items[0].docid,
  }));
  assert.equal(outlineOut.ok, true);
  assert.equal(outlineOut.nodes.length, 3);

  // 5. forge_workbench_rmp_section_read（普通章节 + nodata 空正文识别）
  const sec1 = parseToolJson(await registered.get('forge_workbench_rmp_section_read').execute({
    iid: outlineOut.nodes[0].idoc_id,
  }));
  assert.equal(sec1.ok, true);
  assert.equal(sec1.isEmptyPlaceholder, false);
  assert.ok(sec1.text.includes('导出范围'));

  const sec3Empty = parseToolJson(await registered.get('forge_workbench_rmp_section_read').execute({
    iid: '90002003',
  }));
  assert.equal(sec3Empty.ok, true);
  assert.equal(sec3Empty.isEmptyPlaceholder, true);
  assert.equal(sec3Empty.text, '');

  // 6. forge_workbench_todo_summary
  const sumOut = parseToolJson(await registered.get('forge_workbench_todo_summary').execute({
    reqView: 'manager',
  }));
  assert.equal(sumOut.ok, true);
  assert.equal(typeof sumOut.totalTodos, 'number');
  assert.equal(Object.keys(sumOut.todoCounts).length, 7);

  // 错误收敛测试：读取不存在的需求不应抛错，返回脱敏 JSON
  const errOut = parseToolJson(await registered.get('forge_workbench_requirement_read').execute({
    requirementId: 'NOPE',
  }));
  assert.equal(errOut.ok, false);
  assert.equal(errOut.code, 'BAD_REQUEST');

  // 卸载应释放全部 6 个工具与服务资源
  for (const d of disposers) d();
  assert.equal(registered.size, 0);
});

test('apply survives strict Cordis proxy throwing on uninjected properties and binds via ctx.inject', async (t) => {
  useIsolatedConfigPath(t);
  const baseUrl = await startMockServer(t);
  const injectCallbacks = [];
  const registeredTools = new Map();
  let registeredRoute = null;
  const strictProxyTarget = {
    provide() {},
    effect() {},
    get() {
      return undefined;
    },
    inject(deps, cb) {
      injectCallbacks.push({ deps, cb });
      return () => {};
    },
  };
  const strictCtx = new Proxy(strictProxyTarget, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && ['iam', 'devops', 'gitee', 'webServer', 'tools'].includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const service = apply(strictCtx, {
    enabled: true,
    apiBaseUrl: baseUrl,
    authMode: 'iam',
    requestTimeoutMs: 5000,
  });

  assert.equal(registeredTools.size, 0);
  assert.equal(registeredRoute, null);

  // 模拟 Cordis 异步就绪并触发 inject 回调
  for (const { deps, cb } of injectCallbacks) {
    if (deps.includes('iam')) {
      cb({
        iam: {
          getSession: () => ({ signedIn: true, principal: { subject: '000001' } }),
          getAccessToken: async () => 'mock-dop-token',
        },
      });
    } else if (deps.includes('tools')) {
      cb({
        tools: {
          register(def) {
            registeredTools.set(def.name, def);
            return () => registeredTools.delete(def.name);
          },
        },
      });
    } else if (deps.includes('webServer')) {
      cb({
        webServer: {
          register(route) {
            registeredRoute = route;
            return () => {
              registeredRoute = null;
            };
          },
        },
      });
    }
  }

  assert.equal(registeredTools.size, 6);
  assert.ok(registeredRoute && registeredRoute.path === '/api/forge-devops-workbench');

  // 模拟调用注册的 HTTP route 确认通过凭据服务打通 /bootstrap
  let resStatus = 0;
  let resBody = '';
  await registeredRoute.handler(
    {
      method: 'GET',
      url: '/api/forge-devops-workbench/bootstrap',
      headers: { 'x-forge-workbench-request': '1' },
    },
    {
      setHeader() {},
      end(body) {
        resBody = body;
      },
      set statusCode(code) {
        resStatus = code;
      },
      get statusCode() {
        return resStatus;
      },
    },
  );
  assert.equal(resStatus, 200);
  const bootstrap = JSON.parse(resBody);
  assert.equal(bootstrap.ready, true);

  // 验证 output.render 不对 execute() 的 { content } 返回值二次 JSON 包裹
  const reqTool = registeredTools.get('forge_workbench_requirement_read');
  const execVal = await reqTool.execute({ requirementId: 'a6524d93122e4aab96022254da0c05cf' });
  const rendered = reqTool.output.render({}, execVal);
  assert.deepEqual(rendered, execVal.content);

  service.dispose();
});
