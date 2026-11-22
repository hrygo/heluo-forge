/**
 * #246 预检探针的契约守卫（P9：判据必须会失败）。
 *
 * 探针生成的是一个「Host + Client 夹具」，所以夹具本身写错就等于取证无效：
 * 2026-11-22 的评审发现探针曾用 `inject: { optional: [...] }`（Cordis 把它当成名为
 * `optional` 的服务，插件永不激活）和 `ctx.on('dispose')`（Cordis 4 不派发该事件，
 * 路由与 SSE 永不释放），两项都会让唯一的宿主运行时检查恒 FAIL，而不是暴露真实接缝
 * 问题。这里把这三类形状固定成静态判据，并用变异证明它们会红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'scripts/probe/run-forge-experts-host-preflight.mjs');
const readmePath = join(root, 'scripts/probe/README.md');
const source = readFileSync(scriptPath, 'utf8');
const readme = readFileSync(readmePath, 'utf8');

/** Cordis 的 inject 只能是服务名数组或 name → config 映射。 */
function assertFixtureInjection(text) {
  assert.match(text, /export const inject = \[/u, 'fixture host must declare a service-name array');
  assert.doesNotMatch(text, /export const inject = \{/u, 'Cordis would read the object keys as service names');
}

/** 清理必须交给 ctx.effect；Cordis 4 没有 dispose 事件。 */
function assertFixtureTeardown(text) {
  assert.match(text, /ctx\.effect\?\.\(\(\) => async \(\) => \{/u, 'host fixture teardown must be a ctx.effect');
  assert.doesNotMatch(text, /\.on\?\.\('dispose'/u, "Cordis never emits a 'dispose' event");
}

/** 路由与存储都按 DSH 真实形状调用，不用位置参数或扁平 get/set。 */
function assertFixtureHostContracts(text) {
  assert.match(text, /register\(\{\s*kind: 'prefix',\s*path: API_PREFIX,\s*handler \}\)/u, 'webServer.register needs one WebRoute object');
  assert.doesNotMatch(text, /register\(API_PREFIX, handler\)/u, 'positional register(path, handler) does not exist');
  assert.match(text, /tables: \{ preferences: \{ valueSchema: \{ parse:/u, 'storageDomain.open needs a DomainSpec with valueSchema');
  assert.match(text, /\.table\('preferences'\)/u, 'records are reached through Domain.table(name)');
  assert.match(text, /table\.put\(key, value\)/u, 'durable writes use KvTable.put(key, value)');
}

/** 版本不匹配不得记为 PASS；desktop 未实现的激活路径不得记 FAIL。 */
function assertEvidenceDiscipline(text) {
  assert.match(text, /record\('target-version-pin', versionMatches \? 'PASS' : 'NOT RUN'/u, 'a non-target host version is disclosed as NOT RUN, not disguised as PASS');
  assert.match(text, /record\('desktop-activation', 'BLOCKED'/u, 'desktop activation is unimplemented, not a failure');
  assert.match(text, /record\('host-storage-domain-restart-readback', 'NOT RUN'/u, 'a missing host storageDomain must stay NOT RUN, not PASS');
  assert.match(text, /load\('@deepseek-ai\/dsh-storage-domain'\)/u, 'the harness must mount the shipped storage-domain plugin');
}

test('fixture host, route/storage contracts, and evidence discipline follow the verified DSH shapes', () => {
  assertFixtureInjection(source);
  assertFixtureTeardown(source);
  assertFixtureHostContracts(source);
  assertEvidenceDiscipline(source);
});

test('probe README documents the evidence boundary it actually proves', () => {
  assert.match(readme, /替身/u, 'README must say which provided services are harness stand-ins');
  assert.match(readme, /dsh-storage-domain/u, 'README must name the storage plugin actually mounted');
  assert.match(readme, /不锁定宿主版本/u, 'README must state that the host version is not pinned for seam evidence');
  assert.match(readme, /target-version-pin/u, 'README must name the deviation check');
});

test('P9 mutation proofs: every guard fails on the defect it exists to catch', () => {
  const groupedInject = source.replace("export const inject = ['webServer', 'connection'];", "export const inject = { optional: ['webServer'] };");
  assert.notEqual(groupedInject, source);
  assert.throws(() => assertFixtureInjection(groupedInject));

  const disposeEvent = source.replace("ctx.effect?.(() => async () => {", "ctx.on?.('dispose', async () => {");
  assert.notEqual(disposeEvent, source);
  assert.throws(() => assertFixtureTeardown(disposeEvent));

  const positional = source.replace("register({ kind: 'prefix', path: API_PREFIX, handler })", "register(API_PREFIX, handler)");
  assert.notEqual(positional, source);
  assert.throws(() => assertFixtureHostContracts(positional));

  const flatStorage = source.replace(".table('preferences')", ".get('preferences')");
  assert.notEqual(flatStorage, source);
  assert.throws(() => assertFixtureHostContracts(flatStorage));

  const passOnMismatch = source.replace("record('target-version-pin', versionMatches ? 'PASS' : 'NOT RUN'", "record('target-version-pin', 'PASS'");
  assert.notEqual(passOnMismatch, source);
  assert.throws(() => assertEvidenceDiscipline(passOnMismatch));
});
