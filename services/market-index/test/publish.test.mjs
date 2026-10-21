import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnapshot } from '../generator/generate.mjs';
import { buildRejection, publishSnapshot, readCurrent, readPublished, renewCurrent } from '../generator/publish.mjs';

const T0 = '2026-10-21T06:00:00Z';
const T1 = '2026-10-21T06:10:00Z';
const REF = { url: 'https://evidence.corp.example/check.json', digest: `sha256:${'a'.repeat(64)}` };

const manifest = () => ({
  schemaVersion: 1,
  registries: [{ id: 'corp-prod', url: 'https://npm.corp.example/' }],
  packages: [{ name: '@heluo/forge-example', registryId: 'corp-prod', origin: 'internal' }],
});

const FILES = ['package.json', 'src/index.mjs', 'client.js', 'cordis.patch.yml', 'assets/icon.png', 'locale/en.json'];

const pkgManifest = {
  name: '@heluo/forge-example',
  version: '1.0.0',
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  exports: { '.': './src/index.mjs', './client': './client.js', './icon': './assets/icon.png', './locale/*.json': './locale/*.json' },
  meta: { title: { en: 'Example', zh: '示例' }, description: { en: 'Example', zh: '示例' } },
};

const pkg = {
  manifest: pkgManifest,
  files: FILES,
  peerBaseline: [],
  versionBytes: Buffer.from('tarball-bytes'),
  publishTimestamp: 1700000000,
  provenance: { group: 'heluo', repo: 'forge-example', commit: 'c'.repeat(40), buildRef: REF },
  externalChecks: [{ id: 'matrix-smoke', result: 'pass', reason: '', checkedAt: T0, evidenceRefs: [REF] }],
  display: { title: { en: 'Example', zh: '示例' } },
};

const baseline = (generation = 1) => ({
  registryId: 'corp-prod',
  matrixId: 'matrix-win-kylin',
  policyRevision: 'rev-1',
  generation,
  generatedAt: T0,
  expiresAt: T1,
  revision: { allowlistRevision: 'a1', baselineRevision: 'b1', riskRevision: 'r1', generatorRevision: 'g1' },
  urls: {
    indexUrl: 'https://market.corp.example/index.json',
    policyUrl: 'https://market.corp.example/policy.json',
    evidenceUrl: 'https://market.corp.example/evidence.json',
  },
});

const result = (generation = 1) => generateSnapshot({ manifest: manifest(), baseline: baseline(generation), packages: [pkg] });
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'market-publish-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('发布写入不可变代次并切换 current', async () => {
  await withDir(async (dir) => {
    const receipt = await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });
    assert.equal(receipt.generation, 1);
    assert.equal(receipt.baseGeneration, 0);

    const current = await readCurrent(dir);
    assert.equal(current.generation, 1);
    assert.equal((await readPublished(dir, { now: Date.parse(T0) })).ok, true);
  });
});

test('相同代次重复发布被拒绝，current 不变', async () => {
  await withDir(async (dir) => {
    await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });
    await assert.rejects(() => publishSnapshot(dir, result(1), { expectBaseGeneration: 1 }), /stale-generation/);
    assert.equal((await readCurrent(dir)).generation, 1);
  });
});

test('迟到的 r1 不能覆盖已提交的 r2', async () => {
  await withDir(async (dir) => {
    await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });

    // r1 与 r2 都基于 g1；r2 先提交，r1 晚到必须被代际检查拒绝。
    const r1 = result(2);
    const r2 = result(3);
    await publishSnapshot(dir, r2, { expectBaseGeneration: 1 });
    await assert.rejects(() => publishSnapshot(dir, r1, { expectBaseGeneration: 1 }), /stale-base-generation/);

    assert.equal((await readCurrent(dir)).generation, 3);
    assert.equal((await readPublished(dir, { now: Date.parse(T0) })).ok, true);
  });
});

test('续期提升代次、保留 policyRevision 并在租约内', async () => {
  await withDir(async (dir) => {
    await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });
    const receipt = await renewCurrent(dir, { now: new Date('2026-10-21T06:01:00Z'), leaseMs: 5 * 60 * 1000 });
    assert.equal(receipt.generation, 2);

    const current = await readCurrent(dir);
    assert.equal(current.generation, 2);
    assert.equal(current.policyRevision, 'rev-1');
    assert.equal(current.expiresAt, '2026-10-21T06:06:00.000Z');
    assert.equal((await readPublished(dir, { now: Date.parse('2026-10-21T06:02:00Z') })).ok, true);
  });
});

test('过期后不续期，输入变化拒绝续期', async () => {
  await withDir(async (dir) => {
    await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });
    await assert.rejects(() => renewCurrent(dir, { now: new Date(T1) }), /current-not-live/);

    await assert.rejects(
      () => renewCurrent(dir, {
        now: new Date('2026-10-21T06:01:00Z'),
        expectedInputs: { allowlistRevision: 'a2', baselineRevision: 'b1', riskRevision: 'r1', generatorRevision: 'g1' },
      }),
      /inputs-changed/,
    );
    assert.equal((await readCurrent(dir)).generation, 1);
  });
});

test('拒绝快照关闭安装并清空可安装索引', async () => {
  await withDir(async (dir) => {
    await publishSnapshot(dir, result(1), { expectBaseGeneration: 0 });
    const rejection = buildRejection({
      base: { ...baseline(2), policyRevision: 'rev-1', revision: baseline(2).revision },
      indexUrl: 'https://market.corp.example/index.json',
      now: new Date('2026-10-21T06:01:00Z'),
      revocation: { name: '@heluo/forge-example', reason: 'withdrawn' },
    });
    await publishSnapshot(dir, rejection, { expectBaseGeneration: 1 });

    const current = await readCurrent(dir);
    assert.equal(current.installEnabled, false);
    assert.equal(current.generation, 2);
    const read = await readPublished(dir, { now: Date.parse('2026-10-21T06:02:00Z') });
    assert.equal(read.ok, true, JSON.stringify(read.errors));
    assert.equal(read.index.plugins.length, 0);
    assert.equal(read.snapshot.policy.revocations.length, 1);
  });
});