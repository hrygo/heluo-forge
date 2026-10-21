import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnapshot, readSnapshot, writeSnapshot } from '../generator/generate.mjs';

const T0 = '2026-10-21T06:00:00Z';
const T1 = '2026-10-21T06:10:00Z';
const REF = { url: 'https://evidence.corp.example/check.json', digest: `sha256:${'a'.repeat(64)}` };

const manifest = () => ({
  schemaVersion: 1,
  registries: [{ id: 'corp-prod', url: 'https://npm.corp.example/' }],
  packages: [{ name: '@heluo/forge-example', registryId: 'corp-prod', origin: 'internal' }],
});

const FILES = ['package.json', 'src/index.mjs', 'client.js', 'cordis.patch.yml', 'assets/icon.png', 'locale/en.json'];

const pkgManifest = (overrides = {}) => ({
  name: '@heluo/forge-example',
  version: '1.0.0',
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  exports: {
    '.': './src/index.mjs',
    './client': './client.js',
    './icon': './assets/icon.png',
    './locale/*.json': './locale/*.json',
  },
  meta: { title: { en: 'Example', zh: '示例' }, description: { en: 'Example', zh: '示例' } },
  ...overrides,
});

const provenance = () => ({ group: 'heluo', repo: 'forge-example', commit: 'c'.repeat(40), buildRef: REF });

const pkg = (overrides = {}) => ({
  manifest: pkgManifest(),
  files: FILES,
  peerBaseline: [],
  versionBytes: Buffer.from('tarball-bytes'),
  publishTimestamp: 1700000000,
  provenance: provenance(),
  externalChecks: [
    { id: 'matrix-smoke', result: 'pass', reason: '', checkedAt: T0, evidenceRefs: [REF] },
  ],
  display: { title: { en: 'Example', zh: '示例' }, description: { en: 'Example plugin', zh: '示例插件' } },
  ...overrides,
});

const baseline = (overrides = {}) => ({
  registryId: 'corp-prod',
  matrixId: 'matrix-win-kylin',
  policyRevision: 'rev-1',
  generation: 1,
  generatedAt: T0,
  expiresAt: T1,
  revision: { allowlistRevision: 'a1', baselineRevision: 'b1', riskRevision: 'r1', generatorRevision: 'g1' },
  urls: {
    indexUrl: 'https://market.corp.example/index.json',
    policyUrl: 'https://market.corp.example/policy.json',
    evidenceUrl: 'https://market.corp.example/evidence.json',
  },
  ...overrides,
});

const input = (overrides = {}) => ({ manifest: manifest(), baseline: baseline(), packages: [pkg()], ...overrides });

test('离线生成 allow 快照与索引', () => {
  const result = generateSnapshot(input());
  assert.equal(result.index.plugins.length, 1);
  assert.equal(result.index.plugins[0].versions[0].version, '1.0.0');
  assert.equal(result.snapshot.policy.entries[0].decision, 'allow');
  assert.match(result.snapshot.policy.entries[0].integrity, /^sha256:[0-9a-f]{64}$/);
});

test('落盘后可读回复核，四个文件齐全', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-generate-'));
  try {
    const result = generateSnapshot(input());
    const paths = await writeSnapshot(dir, result);
    for (const key of ['index', 'policy', 'evidence', 'current']) {
      assert.ok(paths[key].endsWith(`${key}.json`));
      assert.ok((await readFile(paths[key])).length > 0);
    }
    const read = await readSnapshot(dir, { now: Date.parse(T0) });
    assert.equal(read.ok, true, JSON.stringify(read.errors));
    assert.equal(read.index.plugins[0].name, '@heluo/forge-example');
    assert.equal(read.snapshot.policy.entries[0].decision, 'allow');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('检查失败只进 deny，不进索引', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-deny-'));
  try {
    const result = generateSnapshot(input({ packages: [pkg({ manifest: pkgManifest({ dependencies: { 'left-pad': '1.0.0' } }) })] }));
    assert.equal(result.snapshot.policy.entries[0].decision, 'deny');
    assert.equal(result.index.plugins.length, 0);
    await writeSnapshot(dir, result);
    assert.equal((await readSnapshot(dir, { now: Date.parse(T0) })).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未登记包、错误 registry 与重复包名被拒绝', () => {
  const wrongRegistry = input({
    baseline: baseline({ registryId: 'other' }),
  });
  assert.throws(() => generateSnapshot(wrongRegistry), /baseline-registry-unknown/);

  const notListed = input({ manifest: { ...manifest(), packages: [] } });
  assert.throws(() => generateSnapshot(notListed), /package-not-allowlisted/);

  const duplicate = input({ packages: [pkg(), pkg()] });
  assert.throws(() => generateSnapshot(duplicate), /package-version-duplicate/);

  const mismatch = input({ packages: [pkg({ expectedIntegrity: `sha256:${'f'.repeat(64)}` })] });
  assert.throws(() => generateSnapshot(mismatch), /package-integrity-mismatch/);
});

test('同包多版本合并，历史合规版本保留', () => {
  const result = generateSnapshot(
    input({
      packages: [
        pkg(),
        pkg({ manifest: pkgManifest({ version: '1.1.0' }), publishTimestamp: 1700003600 }),
      ],
    }),
  );
  assert.equal(result.index.plugins.length, 1);
  assert.deepEqual(result.index.plugins[0].versions.map((entry) => entry.version), ['1.1.0', '1.0.0']);
  assert.equal(result.snapshot.policy.entries.length, 2);
  assert.ok(result.snapshot.policy.entries.every((entry) => entry.decision === 'allow'));
});

test('只有通过检查的版本进索引，其余留在 policy', () => {
  const result = generateSnapshot(
    input({
      packages: [
        pkg(),
        pkg({
          manifest: pkgManifest({ version: '1.1.0', dependencies: { 'left-pad': '1.0.0' } }),
          publishTimestamp: 1700003600,
        }),
      ],
    }),
  );
  assert.deepEqual(result.index.plugins[0].versions.map((entry) => entry.version), ['1.0.0']);
  const decisions = Object.fromEntries(result.snapshot.policy.entries.map((entry) => [entry.version, entry.decision]));
  assert.deepEqual(decisions, { '1.0.0': 'allow', '1.1.0': 'deny' });
});

test('矩阵与授权字段缺失即拒绝', () => {
  assert.throws(() => generateSnapshot(input({ baseline: baseline({ matrixId: '' }) })), /baseline-matrix-invalid/);
  assert.throws(() => generateSnapshot(input({ baseline: baseline({ registryId: 'other' }) })), /baseline-registry-unknown/);
  assert.throws(() => generateSnapshot(input({ baseline: baseline({ policyRevision: '' }) })), /baseline-policy-revision-invalid/);
});

test('读回时篡改摘要被发现', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-tamper-'));
  try {
    const result = generateSnapshot(input());
    const paths = await writeSnapshot(dir, result);
    const current = JSON.parse(await readFile(paths.current, 'utf8'));
    current.snapshot.policyDigest = `sha256:${'d'.repeat(64)}`;
    await writeFile(paths.current, `${JSON.stringify(current, null, 2)}\n`);
    const read = await readSnapshot(dir, { now: Date.parse(T0) });
    assert.equal(read.ok, false);
    assert.ok(read.errors.some((entry) => entry.code === 'snapshot-digest-mismatch'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});