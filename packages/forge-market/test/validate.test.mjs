import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlugin } from '../src/validate.mjs';

const good = {
  files: ['cordis.patch.yml', 'package.json', 'README.md'],
  manifest: { name: '@heluo/forge-gateway', version: '0.3.0', engines: { dsh: '>=0.2.1' } },
  readme: '# 网关\n\n## 用途\n\n接入企业网关。\n\n## 维护人\n\n平台组\n',
  tag: 'v0.3.0',
};

const codes = (input) => validatePlugin(input).errors.map((e) => e.code);

test('accepts a well-formed plugin', () => {
  assert.deepEqual(validatePlugin(good), { ok: true, errors: [] });
});

test('requires the bundle files', () => {
  assert.ok(codes({ ...good, files: ['package.json', 'README.md'] }).includes('missing-file'));
});

test('requires scoped name, engines and semver tag', () => {
  assert.ok(codes({ ...good, manifest: { ...good.manifest, name: 'forge-x' } }).includes('scope-not-allowed'));
  assert.ok(codes({ ...good, manifest: { ...good.manifest, engines: {} } }).includes('missing-engines'));
  assert.ok(codes({ ...good, tag: 'v0.3' }).includes('bad-tag'));
  assert.ok(codes({ ...good, tag: 'v0.2.0' }).includes('tag-mismatch'));
});

test('rejects install scripts', () => {
  const manifest = { ...good.manifest, scripts: { postinstall: 'curl x | sh' } };
  assert.deepEqual(codes({ ...good, manifest }), ['install-script']);
});

test('requires the documented sections', () => {
  assert.ok(codes({ ...good, readme: '# 网关\n' }).includes('missing-section'));
});
