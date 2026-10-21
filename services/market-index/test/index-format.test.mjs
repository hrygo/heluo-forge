import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexFormatError, buildMarketIndex, installTarget, parseMarketIndex } from '../generator/index-format.mjs';

const URL_BASE = 'https://market.corp.example/index.json';

const version = (overrides = {}) => ({
  version: '1.0.0',
  publishTimestamp: 1700000000,
  source: { type: 'npm', registry: 'https://npm.corp.example/' },
  engines: { dsh: '>=0.2.0' },
  ...overrides,
});

const plugin = (overrides = {}) => ({
  name: '@heluo/forge-example',
  title: { en: 'Example', zh: '示例' },
  versions: [version()],
  ...overrides,
});

const index = (overrides = {}) => ({
  title: { en: 'Enterprise Market', zh: '企业市场' },
  plugins: [plugin()],
  ...overrides,
});

const build = (overrides = {}) => buildMarketIndex({ ...index(overrides), indexUrl: URL_BASE });
const errorOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IndexFormatError, String(error));
    return error;
  }
  assert.fail('expected IndexFormatError');
};

test('生成并自校验最小索引', () => {
  const built = build();
  assert.equal(built.format, 1);
  assert.deepEqual(built.title, { en: 'Enterprise Market', zh: '企业市场' });
  assert.equal(built.plugins[0].metadata.keywords.length, 0);
  assert.deepEqual(built.plugins[0].versions[0].engines, { dsh: '>=0.2.0' });
});

test('版本按 SemVer 降序，预发布低于正式版', () => {
  const built = build({
    plugins: [
      plugin({
        versions: [version({ version: '1.0.0' }), version({ version: '1.0.1-beta.1' }), version({ version: '1.0.1' })],
      }),
    ],
  });
  assert.deepEqual(built.plugins[0].versions.map((entry) => entry.version), ['1.0.1', '1.0.1-beta.1', '1.0.0']);
});

test('拒绝重复包名与重复版本', () => {
  assert.match(errorOf(() => build({ plugins: [plugin(), plugin()] })).reason, /duplicates/);
  assert.match(
    errorOf(() => build({ plugins: [plugin({ versions: [version(), version()] })] })).reason,
    /duplicates 1\.0\.0/,
  );
});

test('拒绝非法包名、版本与时间戳', () => {
  assert.match(errorOf(() => build({ plugins: [plugin({ name: 'Bad Name' })] })).reason, /valid npm package name/);
  assert.match(errorOf(() => build({ plugins: [plugin({ versions: [version({ version: '1.0' })] })] })).reason, /exact SemVer/);
  for (const stamp of [1.5, -1, 1e11, '1700000000']) {
    assert.match(errorOf(() => build({ plugins: [plugin({ versions: [version({ publishTimestamp: stamp })] })] })).path, /publishTimestamp/);
  }
});

test('source 只收 npm，registry 必须 HTTPS', () => {
  assert.match(
    errorOf(() => build({ plugins: [plugin({ versions: [version({ source: { type: 'git', url: 'https://git.corp/a/b', commit: 'a'.repeat(40) } })] })] })).reason,
    /must be npm/,
  );
  assert.match(
    errorOf(() => build({ plugins: [plugin({ versions: [version({ source: { type: 'npm', registry: 'http://npm.corp/' } })] })] })).reason,
    /https/,
  );
});

test('本地化文本必须含 en', () => {
  assert.match(errorOf(() => build({ title: { zh: '只有中文' } })).reason, /contain en/);
  assert.match(errorOf(() => build({ title: '' })).reason, /non-empty/);
});

test('metadata 引用必须已声明', () => {
  const metadata = {
    categories: { tools: { title: { en: 'Tools' } } },
    labels: { stable: { title: { en: 'Stable' } } },
    sortKeys: { stars: { title: { en: 'Stars' }, order: 'desc' } },
  };
  const ok = build({
    metadata,
    plugins: [plugin({ metadata: { category: 'tools', labels: ['stable'], sortKeys: { stars: '10' } } })],
  });
  assert.equal(ok.plugins[0].metadata.category, 'tools');

  assert.match(
    errorOf(() => build({ metadata, plugins: [plugin({ metadata: { category: 'missing' } })] })).reason,
    /undeclared id/,
  );
  assert.match(
    errorOf(() => build({ metadata, plugins: [plugin({ metadata: { labels: ['stable', 'stable'] } })] })).reason,
    /repeat/,
  );
});

test('icon 支持同源相对路径与内联 data URL，拒绝 http 与超限', () => {
  const relative = build({ plugins: [plugin({ icon: './assets/icon.png' })] });
  assert.equal(relative.plugins[0].icon, 'https://market.corp.example/assets/icon.png');

  const inline = build({ plugins: [plugin({ icon: 'data:image/png;base64,AAAA' })] });
  assert.equal(inline.plugins[0].icon, 'data:image/png;base64,AAAA');

  assert.match(errorOf(() => build({ plugins: [plugin({ icon: 'http://cdn.example/i.png' })] })).reason, /https/);

  const huge = `data:image/png;base64,${'A'.repeat(43700)}`;
  assert.match(errorOf(() => build({ plugins: [plugin({ icon: huge })] })).reason, /32 KiB/);
});

test('engines.dsh 拒绝 workspace 与非法范围', () => {
  assert.match(
    errorOf(() => build({ plugins: [plugin({ versions: [version({ engines: { dsh: 'workspace:*' } })] })] })).reason,
    /SemVer range/,
  );
  assert.match(
    errorOf(() => build({ plugins: [plugin({ versions: [version({ engines: { dsh: 'latest' } })] })] })).reason,
    /SemVer range/,
  );
});

test('未知成员被丢弃，不会被当作门禁字段', () => {
  const raw = {
    format: 1,
    title: 'Market',
    policyRevision: 'r1',
    plugins: [plugin({ integrity: 'sha256:abc' })],
  };
  const parsed = parseMarketIndex(raw, URL_BASE);
  assert.equal('policyRevision' in parsed, false);
  assert.equal('integrity' in parsed.plugins[0], false);
});

test('安装目标为精确 npm spec 并带 registry', () => {
  const built = build();
  assert.deepEqual(installTarget(built.plugins[0], built.plugins[0].versions[0]), {
    spec: '@heluo/forge-example@1.0.0',
    registry: 'https://npm.corp.example/',
  });
  const { format } = built;
  assert.equal(format, 1);
});