import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPackage, tarballIntegrity } from '../generator/package-check.mjs';

const FILES = [
  'package.json',
  'src/index.mjs',
  'client.js',
  'cordis.patch.yml',
  'assets/icon.png',
  'locale/en.json',
  'locale/zh.json',
];

const manifest = (overrides = {}) => ({
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
  meta: {
    title: { en: 'Example', zh: '示例' },
    description: { en: 'Example plugin', zh: '示例插件' },
  },
  ...overrides,
});

const run = (overrides = {}, options = {}) =>
  inspectPackage({ manifest: manifest(overrides), files: FILES, peerBaseline: ['react'], checkedAt: '2026-10-21T06:00:00Z', ...options });

const byId = (checks) => Object.fromEntries(checks.map((entry) => [entry.id, entry]));

test('自包含且资源齐全的包通过四类检查', () => {
  const checks = run();
  for (const entry of checks) assert.equal(entry.result, 'pass', `${entry.id}:${entry.reason}`);
  assert.deepEqual(checks.map((entry) => entry.id), ['package-shape', 'self-contained', 'peer-baseline', 'display']);
  assert.equal(checks[0].checkedAt, '2026-10-21T06:00:00Z');
  assert.deepEqual(checks[0].evidenceRefs, []);
});

test('运行依赖非空即拒绝，空对象可接受', () => {
  assert.equal(byId(run({ dependencies: {} })).selfContained, undefined);
  assert.equal(byId(run({ dependencies: {} }))['self-contained'].result, 'pass');

  for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const value = field === 'bundleDependencies' ? ['left-pad'] : { 'left-pad': '1.0.0' };
    const entry = byId(run({ [field]: value }))['self-contained'];
    assert.equal(entry.result, 'fail', field);
    assert.match(entry.reason, new RegExp(`runtime-dependency:${field}`));
  }
});

test('拒绝安装期生命周期脚本与终端编译，保留 build/test', () => {
  for (const name of ['preinstall', 'install', 'postinstall']) {
    const entry = byId(run({ scripts: { [name]: 'node x.js' } }))['self-contained'];
    assert.equal(entry.result, 'fail', name);
    assert.match(entry.reason, new RegExp(`lifecycle-script:${name}`));
  }
  assert.equal(byId(run({ scripts: { build: 'tsc', test: 'node --test' } }))['self-contained'].result, 'pass');

  assert.equal(byId(run({ gypfile: true }))['self-contained'].result, 'fail');
  const noBinding = inspectPackage({ manifest: manifest(), files: ['package.json', 'binding.gyp'], peerBaseline: [] });
  assert.match(byId(noBinding)['self-contained'].reason, /terminal-build:node-gyp/);
});

test('peer 只允许基线内条目，缺基线记 unknown', () => {
  assert.equal(byId(run({ peerDependencies: { react: '>=18' } }))['peer-baseline'].result, 'pass');

  const outside = inspectPackage({
    manifest: manifest({ peerDependencies: { react: '>=18', lodash: '^4' } }),
    files: FILES,
    peerBaseline: ['react'],
  });
  assert.match(byId(outside)['peer-baseline'].reason, /peer-outside-baseline:lodash/);

  const unknown = inspectPackage({ manifest: manifest({ peerDependencies: { react: '>=18' } }), files: FILES });
  assert.equal(byId(unknown)['peer-baseline'].result, 'unknown');
});

test('patch、入口导出与文件清单必须一致', () => {
  assert.equal(byId(run({ dsh: {} }))['package-shape'].result, 'fail');
  assert.match(byId(run({ dsh: { bundle: { patch: './missing.yml' } } }))['package-shape'].reason, /patch-not-in-files/);

  const badExport = run({ exports: { '.': './src/nope.mjs', './icon': './assets/icon.png', './locale/*.json': './locale/*.json' } });
  assert.match(byId(badExport)['package-shape'].reason, /export-not-in-files:src\/nope\.mjs/);
});

test('拒绝越界文件路径与非法包名/版本', () => {
  const unsafe = inspectPackage({ manifest: manifest(), files: [...FILES, '../escape.js'], peerBaseline: [] });
  assert.match(byId(unsafe)['package-shape'].reason, /unsafe-file-path/);

  assert.match(byId(run({ name: 'Bad Name' }))['package-shape'].reason, /name-invalid/);
  assert.match(byId(run({ version: '1.0' }))['package-shape'].reason, /version-invalid/);
  assert.match(byId(run({ engines: {} }))['package-shape'].reason, /engines-dsh-missing/);
});

test('内部包缺显示资源拒绝，第三方记 fallback 通过', () => {
  const missing = { exports: { '.': './src/index.mjs' }, meta: undefined };
  const internal = byId(run(missing))['display'];
  assert.equal(internal.result, 'fail');
  assert.match(internal.reason, /icon-export-missing/);
  assert.match(internal.reason, /locale-export-missing/);
  assert.match(internal.reason, /meta-missing/);

  const mirror = inspectPackage({ manifest: manifest(missing), files: FILES, origin: 'public-mirror' });
  const entry = byId(mirror)['display'];
  assert.equal(entry.result, 'pass');
  assert.match(entry.reason, /^fallback:/);
});

test('tarball 完整性格式', () => {
  assert.match(tarballIntegrity(Buffer.from('x')), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => tarballIntegrity('not-bytes'), /tarball-bytes-invalid/);
  assert.throws(() => inspectPackage({ manifest: null, files: [] }), /manifest-invalid/);
});