import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeRegistryUrl, validateManifest } from '../generator/manifest.mjs';

const base = () => ({
  schemaVersion: 1,
  registries: [{ id: 'corp-prod', url: 'https://npm.corp.example/' }],
  packages: [{ name: '@heluo/forge-example', registryId: 'corp-prod', origin: 'internal' }],
});

const codes = (result) => result.errors.map((entry) => entry.code);

test('接受有效清单并规范化地址', () => {
  const result = validateManifest({
    schemaVersion: 1,
    registries: [{ id: 'corp-prod', url: 'HTTPS://NPM.Corp.Example:443' }],
    packages: [
      { name: '@heluo/forge-example', registryId: 'corp-prod', origin: 'internal' },
      { name: 'left-pad', registryId: 'corp-prod', origin: 'public-mirror' },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.manifest.registries, [{ id: 'corp-prod', url: 'https://npm.corp.example/' }]);
  assert.equal(result.manifest.packages.length, 2);
});

test('拒绝非对象输入', () => {
  for (const value of [null, undefined, [], 'x', 1]) {
    assert.deepEqual(codes(validateManifest(value)), ['manifest-not-object']);
  }
});

test('拒绝未知字段，含嵌套对象', () => {
  const root = { ...base(), extra: true };
  assert.ok(codes(validateManifest(root)).includes('unknown-field'));

  const nested = base();
  nested.registries[0].token = 'x';
  assert.ok(codes(validateManifest(nested)).includes('unknown-field'));

  const pkg = base();
  pkg.packages[0].version = '1.0.0';
  assert.equal(validateManifest(pkg).ok, false);
});

test('只接受 schemaVersion 1', () => {
  for (const version of [0, 2, '1', 1.0 + Number.EPSILON]) {
    const result = validateManifest({ ...base(), schemaVersion: version });
    assert.deepEqual(codes(result), ['schema-version-unsupported']);
  }
});

test('拒绝重复 registry id 与规范化后相同的地址', () => {
  const result = validateManifest({
    schemaVersion: 1,
    registries: [
      { id: 'a', url: 'https://npm.corp.example/' },
      { id: 'a', url: 'https://npm.corp.example/other' },
      { id: 'b', url: 'https://NPM.corp.example:443' },
    ],
    packages: [],
  });
  assert.deepEqual(codes(result).sort(), ['registry-id-duplicate', 'registry-url-duplicate']);
});

test('拒绝非法 registry 地址', () => {
  const bad = [
    'http://npm.corp.example/',
    `https://${['user', 'secret'].join(':')}@npm.corp.example/`,
    'https://npm.corp.example/?x=1',
    'https://npm.corp.example/#frag',
    'https://npm.corp.example/a b',
    'https://npm.corp.example/a%2fb',
    'https://npm.corp.example/a//b',
    'not-a-url',
    '',
  ];
  for (const url of bad) {
    assert.equal(canonicalizeRegistryUrl(url), null, url);
  }
});

test('路径保留且补齐单斜杠', () => {
  assert.equal(canonicalizeRegistryUrl('https://npm.corp.example'), 'https://npm.corp.example/');
  assert.equal(canonicalizeRegistryUrl('https://npm.corp.example/registry'), 'https://npm.corp.example/registry/');
  assert.equal(canonicalizeRegistryUrl('https://npm.corp.example/registry/'), 'https://npm.corp.example/registry/');
});

test('拒绝悬空的 registryId', () => {
  const manifest = base();
  manifest.packages[0].registryId = 'missing';
  assert.deepEqual(codes(validateManifest(manifest)), ['package-registry-unknown']);
});

test('拒绝重复包名与非法来源', () => {
  const duplicate = base();
  duplicate.packages.push({ name: '@heluo/forge-example', registryId: 'corp-prod', origin: 'internal' });
  assert.deepEqual(codes(validateManifest(duplicate)), ['package-name-duplicate']);

  for (const origin of ['public', 'PUBLIC-MIRROR', 'internal ', '']) {
    const manifest = base();
    manifest.packages[0].origin = origin;
    assert.deepEqual(codes(validateManifest(manifest)), ['package-origin-invalid']);
  }
});

test('拒绝通配、范围、tag、大写与非法包名', () => {
  const bad = [
    '*',
    '@heluo/*',
    '@heluo/forge-example@1.0.0',
    '@heluo/forge-example@latest',
    'left-pad@^1.0.0',
    'Left-Pad',
    '.hidden',
    '_private',
    '@scope',
    'https://example.com/x.tgz',
    'git+https://example.com/x.git',
    'file:../x',
  ];
  for (const name of bad) {
    const manifest = base();
    manifest.packages[0].name = name;
    assert.equal(validateManifest(manifest).ok, false, name);
  }
});

test('接受合法 scoped 与非 scoped 包名', () => {
  const good = ['@heluo/forge-example', '@a/b', 'left-pad', 'x', 'a.b-c_d', 'a~b'];
  for (const name of good) {
    const manifest = base();
    manifest.packages[0].name = name;
    assert.equal(validateManifest(manifest).ok, true, name);
  }
});

test('非数组 registries/packages 报对应错误', () => {
  assert.ok(codes(validateManifest({ schemaVersion: 1, registries: {}, packages: [] })).includes('registries-not-array'));
  assert.ok(codes(validateManifest({ schemaVersion: 1, registries: [], packages: 'x' })).includes('packages-not-array'));
});