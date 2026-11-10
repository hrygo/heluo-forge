#!/usr/bin/env node
// Explicit synthetic storage + mock IAM/UAG; actual installed Cordis/LLM/PiAiAdapter.
// No production credentials, installation writes or host patches.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshProbeHost } from '../lib/dsh-probe-runtime.mjs';
import { createIamService } from '../../packages/forge-iam/test/support/trusted-service.mjs';
import { createAtomicGatewayFixture } from '../../packages/forge-iam/test/support/atomic-gateway.mjs';
import { startMockOidc } from '../../packages/forge-iam/test/support/mock-oidc.mjs';
import { validateConfig } from '../../packages/forge-iam/src/config.mjs';
import { createManagedModelRuntime } from '../../packages/forge-iam/src/managed-models.mjs';

const location = resolveDshProbeHost({ dsh: process.env.DSH_BIN ?? 'dsh', modules: process.env.DSH_NODE_MODULES });
if ((location.runtime && realpathSync(process.execPath) !== location.runtime)
  || !process.execArgv.includes('--experimental-import-meta-resolve')) {
  const child = spawnSync(location.runtime ?? process.execPath,
    ['--expose-internals', '--experimental-import-meta-resolve', fileURLToPath(import.meta.url)], {
      env: { ...process.env, ...(location.runtime ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'inherit',
    });
  process.exit(child.status ?? 1);
}
const load = specifier => import(import.meta.resolve(specifier, pathToFileURL(location.anchor).href));
const { Context } = await load('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const ctx = new Context();
const llmFiber = ctx.plugin(LlmRuntime); await llmFiber.await();
let lists = 0; let chats = 0;
const key = 'synthetic-probe-only';
const gateway = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
  if (req.url === '/v1/models') {
    lists++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic-chat', object: 'model' }] })); return;
  }
  if (req.url === '/v1/chat/completions') {
    chats++; for await (const _chunk of req) { /* drain only synthetic content */ }
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'synthetic-chat', choices: [{ index: 0, delta: { content: '模拟对话成功' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'synthetic-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${gateway.address().port}/v1`;
const mock = await startMockOidc({ accessTtl: 5 }); const fixture = createAtomicGatewayFixture();
let clock = Date.now(); let runtime;
const config = validateConfig({ ...mock.endpoints, clientId: mock.clientId,
  redirectUri: 'http://127.0.0.1:9/iam/callback', refreshSkewSeconds: 1 }).value;
const iam = createIamService(config, { credentials: fixture.credentials, ...fixture.options,
  now: () => clock, getManagedModelRuntime: () => runtime });
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values; };
const request = { provider: 'enterprise', model: 'synthetic-chat', messages: [{ role: 'user', content: [{ type: 'text', text: '模拟测试' }] }] };
let standaloneCalls = 0;
class Standalone extends LlmAdapter { async *stream() { standaloneCalls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
const offStandalone = ctx.llm.registerAdapter(['standalone'], new Standalone());
let managedFiber;
try {
  managedFiber = ctx.plugin({ name: 'managed-models-probe-owner', inject: ['llm'], apply(owned) {
    const host = { llm: owned.llm, on: owned.on.bind(owned), emit: owned.emit.bind(owned), loader: { import: load } };
    runtime = createManagedModelRuntime({ host, iam, config });
    owned.effect(() => () => runtime.dispose());
  } });
  await managedFiber.await(); await runtime.ready;
  assert.equal((await collect(ctx.llm.stream(request))).at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
  assert.equal(lists, 0); assert.equal(chats, 0);
  const started = await iam.startSignIn();
  const authorization = await fetch(started.authorizationUrl, { redirect: 'manual' });
  await iam.handleCallback(authorization.headers.get('location'));
  await iam.saveGatewayCredential({ key, baseURL });
  await runtime.refresh();
  assert.equal((await ctx.llm.listModels('enterprise'))[0].id, 'synthetic-chat');
  const forbidden = await collect(ctx.llm.stream({ ...request, provider: 'standalone' }));
  assert.equal(forbidden.at(-1).reason.failure.code, 'ENTERPRISE_MODEL_NOT_ALLOWED'); assert.equal(standaloneCalls, 0);
  const reply = await collect(ctx.llm.stream(request));
  assert.equal(reply.filter(item => item.type === 'text-delta').map(item => item.text).join(''), '模拟对话成功');
  assert.equal(reply.at(-1).reason.kind, 'stop'); assert.equal(chats, 1);
  const preparedBeforeRefresh = await ctx.llm.prepareCall({ provider: request.provider, model: request.model });
  clock += 4500; await iam.resolveToken();
  assert.equal((await collect(preparedBeforeRefresh.stream({ ...request, ...preparedBeforeRefresh.config }))).at(-1).reason.kind, 'stop');
  assert.equal(chats, 2);
  await runtime.refresh();
  assert.equal(mock.counts.refresh, 1);
  assert.equal((await collect(ctx.llm.stream(request))).at(-1).reason.kind, 'stop'); assert.equal(chats, 3);
  const before = lists;
  await iam.signOut();
  assert.deepEqual(await ctx.llm.listModels('enterprise'), []);
  await assert.rejects(runtime.refresh(), { code: 'IAM_LOGIN_REQUIRED' });
  const denial = await collect(ctx.llm.stream(request));
  assert.equal(denial.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
  assert.match(denial.at(-1).reason.failure.message, /重新登录/);
  assert.equal(chats, 3); assert.equal(lists, before);
  console.log(JSON.stringify({ ok: true, host: 'installed Cordis + LLM + PiAiAdapter',
    scope: 'mock IAM and gateway; synthetic in-memory storage; no enterprise authorization claim',
    login: 'passed', standardModels: 'passed', conversation: 'passed', refresh: 'passed', logout: 'passed', callsAfterLogout: 0 }));
} finally {
  await managedFiber?.dispose(); await runtime?.dispose(); offStandalone(); await iam.dispose(); await llmFiber.dispose();
  await mock.close(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
}
