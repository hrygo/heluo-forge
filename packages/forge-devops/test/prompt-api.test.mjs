/**
 * 提示词模板的只读下发端点（r20）。
 *
 * 契约只有三条，且都必须可判定：
 *   1. 模板来自维护者在补丁层写的 `config.promptTemplate`，没写就是内置默认值（`source` 说明来源）；
 *   2. 端点**只读**：GET/HEAD 200，其他方法 405 且 `allow: GET`——页面没有编辑入口，
 *      用户配置不好反而更危险（少一步验收、漏掉「缺验收标准先问我」）；
 *   3. 响应头与 `/cli` 同口径（no-store / nosniff / 无 CORS），失败体不透出宿主异常文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROMPT_TEMPLATE, PROMPT_FIELD, promptTemplateOf } from '../src/prompt-template.mjs';
import { PROMPT_HTTP_CODES, PROMPT_ROUTE_PATH, createPromptApi, toPromptRoute } from '../src/prompt-api.mjs';

test('GET：没配置就给内置默认模板，并标明来源', async () => {
  const api = createPromptApi({ resolve: () => promptTemplateOf({}) });
  const result = await api.handleGet();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.template, DEFAULT_PROMPT_TEMPLATE);
  assert.equal(result.body.source, 'default');
  assert.equal(result.body.placeholder, '{code}');
});

test('GET：补丁层配置优先，来源标为 config；非法值回落默认值', async () => {
  const configured = await createPromptApi({ resolve: () => promptTemplateOf({ [PROMPT_FIELD]: '自定义 {code}' }) }).handleGet();
  assert.deepEqual([configured.body.source, configured.body.template], ['config', '自定义 {code}']);

  const invalid = await createPromptApi({ resolve: () => promptTemplateOf({ [PROMPT_FIELD]: '没有占位符' }) }).handleGet();
  assert.deepEqual([invalid.body.source, invalid.body.template], ['default', DEFAULT_PROMPT_TEMPLATE]);
});

test('GET：响应头与 /cli 同口径，且不带 CORS', async () => {
  const { headers } = await createPromptApi({ resolve: () => promptTemplateOf({}) }).handleGet();
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['access-control-allow-origin'], undefined);
});

test('GET：未装配与 resolve 抛错都是 503，不返回空模板充成功', async () => {
  const missing = await createPromptApi({ resolve: null }).handleGet();
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, PROMPT_HTTP_CODES.UNAVAILABLE);

  const throwing = await createPromptApi({
    resolve: () => {
      throw new Error('boom /usr/local/bin/dop');
    },
  }).handleGet();
  assert.equal(throwing.status, 503);
  assert.equal(throwing.body.message.includes('/usr/local/bin'), false);
  assert.equal(throwing.body.message.includes('boom'), false);
});

test('路由：GET/HEAD 通，POST 及其他方法 405 + allow: GET，错路径 404', async () => {
  const route = toPromptRoute(createPromptApi({ resolve: () => promptTemplateOf({ [PROMPT_FIELD]: '变更 {code}' }) }));
  const call = async (method) => {
    const res = { headers: {} };
    await route({ url: PROMPT_ROUTE_PATH, method, headers: {} }, res);
    return { status: res.status, headers: res.headers, body: JSON.parse(res.body) };
  };

  const get = await call('GET');
  assert.equal(get.status, 200);
  assert.equal(get.body.template, '变更 {code}');

  const head = await call('HEAD');
  assert.equal(head.status, 200);

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const rejected = await call(method);
    assert.equal(rejected.status, 405, `${method} 不得被接受`);
    assert.equal(rejected.headers.allow, 'GET');
    assert.match(rejected.body.message, /只读/u);
  }

  const other = { headers: {} };
  await route({ url: '/api/forge-devops/other', method: 'GET', headers: {} }, other);
  assert.equal(other.status, 404);
  assert.equal(JSON.parse(other.body).code, PROMPT_HTTP_CODES.NOT_FOUND);
});

test('客户端：只读端点、默认模板字面量与宿主一致，且没有保存入口', () => {
  const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
  assert.ok(source.includes(`const PROMPT_ENDPOINT = '${PROMPT_ROUTE_PATH}'`), '客户端必须请求同一个模板端点');
  assert.ok(source.includes('fetchPromptTemplate'), '客户端要能取到维护者配置的模板');
  assert.equal(/savePromptTemplate|PromptTemplateSection|devops-prompt/.test(source), false, '页面不提供编辑入口');
  for (const line of DEFAULT_PROMPT_TEMPLATE.split('\n')) {
    if (line === '') continue;
    assert.ok(source.includes(line), `客户端默认模板缺少这一行：${line}`);
  }
});
