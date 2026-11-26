import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { createNacosClient } from "../lib/nacos.js";
import { readZip } from "../lib/zip.js";
import { fakeNacos, nacosConfig, skillDocument, useNacosEnvironment } from "./fixtures/nacos.mjs";
beforeEach(context => useNacosEnvironment(context));
const fixture = () => { const f = fakeNacos(); return { ...f, client: createNacosClient(nacosConfig, f.fetcher) }; };
const selected = { skillName: "example-skill", version: "1.0.0" };
const rejects = (promise, code) => assert.rejects(promise, e => e.code === `error.nacos.${code}` && !e.message.includes("synthetic"));

test("配置、解码和解压中的程序缺陷保留原异常", async () => {
  const defect = new ReferenceError("synthetic programming defect");
  const brokenConfig = { ...nacosConfig, get serverUrl() { throw defect; } };
  await assert.rejects(createNacosClient(brokenConfig, fakeNacos().fetcher).list(), caught => caught === defect);
  const originalDecoder = globalThis.TextDecoder;
  try {
    globalThis.TextDecoder = class extends originalDecoder { decode() { throw defect; } };
    await assert.rejects(fixture().client.list(), caught => caught === defect);
  } finally { globalThis.TextDecoder = originalDecoder; }
  await assert.rejects(readZip(zipSync({ "example-skill/SKILL.md": strToU8(skillDocument("example-skill")) }), {
    filter() { throw defect; },
  }), caught => caught === defect);
});

test("未配置时返回配置提示且零网络", async () => {
  const client = createNacosClient(undefined, () => { throw new Error("network forbidden"); });
  assert.equal((await client.list()).configured, false);
  await rejects(client.detail(selected), "unconfigured");
});

test("默认和显式环境变量名均从 Host 进程读取账号密码", async () => {
  const { usernameEnv, passwordEnv, ...config } = nacosConfig;
  const first = fakeNacos();
  await createNacosClient(config, first.fetcher).list();
  assert.equal(new URLSearchParams(first.calls[0].options.body).get("username"), "svc-ci");
  const explicit = fakeNacos();
  assert.equal((await createNacosClient({ ...config, usernameEnv, passwordEnv }, explicit.fetcher).list()).configured, true);
  assert.equal(explicit.calls.length, 3);
});
test("仅使用登录和只读白名单，凭据不进 URL，令牌缓存", async () => {
  const { client, calls } = fixture();
  const page = await client.list("example", 2);
  assert.equal(page.items[0].version, "1.0.0");
  assert.equal(calls[1].url.searchParams.get("namespaceId"), "public");
  assert.equal(calls[1].url.searchParams.get("pageNo"), "2");
  assert.equal(calls[1].url.searchParams.get("pageSize"), "20");
  assert.equal(calls[1].url.searchParams.get("orderBy"), "download_count");
  await client.list();
  assert.equal(calls.filter(c => c.options.method === "POST").length, 1);
  assert.ok(calls.every(c => !c.url.href.includes("synthetic")));
  assert.equal(calls[1].options.headers.Authorization, "Bearer synthetic-read-token");
  assert.ok(calls.every(c => c.options.redirect === "error"));
});
test("完整 ZIP 保留资源，内容摘要不依赖 ZIP 字节", async () => {
  const { client, state } = fixture();
  const one = await client.load(selected);
  assert.match(one.id, /^nacos:[a-f0-9]{64}$/);
  assert.deepEqual(one.detail.files.sort(), ["SKILL.md", "assets/binary.dat", "scripts/example.txt"]);
  const pack = Object.fromEntries(one.pack.entries.map(e => [`example-skill/${e.path}`, Buffer.from(e.data, "base64")]));
  state.bytes = zipSync(pack, { level: 0 });
  const two = await client.load(selected);
  assert.equal(one.detail.digest, two.detail.digest);
  assert.equal(one.id, two.id);
});
test("下线、草稿、旧版本不能经直接请求绕过发现页", async () => {
  const { client, state, calls } = fixture();
  state.enable = false;
  assert.equal((await client.list()).items.length, 0);
  await rejects(client.load(selected), "notFound");
  state.enable = true;
  await rejects(client.load({ ...selected, version: "draft" }), "notFound");
  assert.ok(!calls.some(c => c.url.pathname === "/nacos/v3/client/ai/skills"));
});
test("拒绝不安全的服务端配置，未读密码不发送请求", async () => {
  const withCredentials = new URL("https://nacos.corp.example");
  withCredentials.username = "svc-ci";
  withCredentials.password = "synthetic-password";
  for (const serverUrl of ["ftp://nacos.corp.example/nacos", withCredentials.href, "https://nacos.corp.example/?accessToken=x"]) {
    await rejects(createNacosClient({ ...nacosConfig, serverUrl }, () => { throw 0; }).list(), "config");
  }
  delete process.env.TEST_NACOS_PASSWORD;
  await rejects(createNacosClient(nacosConfig, () => { throw 0; }).list(), "config");
});
test("查询、路径和版本输入在联网前验证", async () => {
  const { client, calls } = fixture();
  for (const skillName of ["../escape", "", "Uppercase", {}, null]) await rejects(client.load({ skillName, version: "1.0.0" }), "query");
  for (const page of [0, NaN, 1.5, 10001]) await rejects(client.list("", page), "query");
  await rejects(client.list("x".repeat(101)), "query");
  assert.equal(calls.length, 0);
});
test("认证错误不会回显服务器错误体或密钥", async () => {
  const { client, state } = fixture(); state.status = 403;
  await rejects(client.list(), "auth");
});
test("畸形列表显式拒绝，空列表与错误不混淆", async () => {
  const { client, state } = fixture();
  state.listData = { code: 0, data: { totalCount: 1, pageItems: [{ name: "bad" }] } };
  await rejects(client.list(), "response");
  state.listData = { code: 0, data: { totalCount: 0, pageItems: [] } };
  assert.deepEqual((await client.list()).items, []);
});
test("ZIP 穿越、大小、大小写重名、额外技能和身份不符全部拒绝", async () => {
  const { client, state } = fixture();
  for (const files of [
    { "../SKILL.md": strToU8(skillDocument("example-skill")) },
    { "SKILL.md": strToU8(skillDocument("other-skill")) },
    { "example-skill/SKILL.md": strToU8(skillDocument("example-skill")), "evil/SKILL.md": strToU8(skillDocument("evil")) },
    { "SKILL.md": strToU8(skillDocument("example-skill")), "A.txt": strToU8("a"), "a.txt": strToU8("b") },
    { "SKILL.md": strToU8(skillDocument("example-skill")), "huge": new Uint8Array((32 << 20) + 1) },
  ]) { state.bytes = zipSync(files); await rejects(client.load(selected), "package"); }
  state.bytes = new Uint8Array([1, 2, 3]); await rejects(client.load(selected), "package");
});
test("取消和超时覆盖响应流读取，不泄露底层异常", async () => {
  const slow = async (_url, { signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  const controller = new AbortController();
  const cancelled = createNacosClient(nacosConfig, slow).list("", 1, controller.signal);
  controller.abort(); await rejects(cancelled, "cancelled");
  const timeout = createNacosClient({ ...nacosConfig, timeoutMs: 100 }, slow).list();
  const keepAlive = setTimeout(() => {}, 500); try { await rejects(timeout, "timeout"); } finally { clearTimeout(keepAlive); }
});
test("限制实际流字节数，无需相信 Content-Length", async () => {
  const client = createNacosClient(nacosConfig, async () => new Response(new Uint8Array((64 << 10) + 1)));
  await rejects(client.list(), "size");
});

test('network failures are sanitized; programming failures retain their identity', async () => {
  const network = new TypeError('fetch failed', { cause: new Error('synthetic system failure') });
  await rejects(createNacosClient(nacosConfig, async () => { throw network; }).list(), 'unavailable');
  for (const defect of [new ReferenceError('missing symbol'), new TypeError('bad implementation')]) {
    await assert.rejects(createNacosClient(nacosConfig, async () => { throw defect; }).list(), caught => caught === defect);
  }
});

test("下载次数与命名空间透传，零值保留，缺失或异常统计不补零", async () => {
  const { client, state } = fixture();
  const item = { name: "example-skill", description: "Example", enable: true, labels: { latest: "1.0.0" }, namespaceId: "public" };
  for (const downloadCount of [0, 22, Number.MAX_SAFE_INTEGER, undefined, null, -1, 1.5, "22", Number.MAX_SAFE_INTEGER + 1, {}]) {
    state.listData = { code: 0, data: { totalCount: 1, pageItems: [{ ...item, downloadCount }] } };
    const row = (await client.list()).items[0];
    assert.equal(row.namespaceId, "public");
    if (Number.isSafeInteger(downloadCount) && downloadCount >= 0) assert.equal(row.downloadCount, downloadCount);
    else assert.ok(!Object.hasOwn(row, "downloadCount"));
  }
  delete item.namespaceId;
  state.listData = { code: 0, data: { totalCount: 1, pageItems: [item] } };
  assert.equal((await client.list()).items[0].namespaceId, "public", "older responses use the queried namespace");
  item.namespaceId = "other-namespace";
  await rejects(client.list(), "response");
  await rejects(client.load({ skillName: "example-skill", version: "1.0.0" }), "response");
});

test("搜索、刷新和跨页均请求服务端下载降序，不重排或抓取其他页面", async () => {
  const { client, state, calls } = fixture();
  const row = (name, downloadCount, enable = true) => ({ name, downloadCount, enable, description: "Example", labels: { latest: "1" } });
  state.listData = { code: 0, data: { totalCount: 45, pageItems: [row("first-skill", 2), row("second-skill", 9), row("disabled-skill", 12, false)] } };
  for (const page of [1, 2, 2]) {
    const result = await client.list("skill", page);
    assert.deepEqual(result.items.map(item => item.name), ["first-skill", "second-skill"], "Host preserves the server's order");
    assert.equal(result.total, 45); assert.equal(result.page, page);
    assert.equal(calls.filter(call => call.url.pathname.endsWith("/skills/list")).at(-1).url.searchParams.get("pageNo"), String(page));
  }
  const requests = calls.filter(call => call.url.pathname.endsWith("/skills/list"));
  assert.equal(requests.length, 3);
  for (const call of requests) {
    assert.equal(call.url.searchParams.get("orderBy"), "download_count");
    assert.equal(call.url.searchParams.get("skillName"), "skill");
    assert.equal(call.url.searchParams.get("search"), "blur");
    assert.equal(call.url.searchParams.get("pageSize"), "20");
  }
});
