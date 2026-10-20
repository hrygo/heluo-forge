import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlugin } from '../src/validate.mjs';

const good = {
  files: ['cordis.patch.yml', 'package.json', 'README.md'],
  manifest: { name: '@heluo/forge-gateway', version: '0.3.0', engines: { dsh: '>=0.2.1' } },
  readme: '# 网关\n\n## 用途\n\n接入企业网关。\n\n## 维护人\n\n平台组\n',
  tag: 'v0.3.0',
  patch: "insert:\n  - id: forge-gateway\n    name: '@heluo/forge-gateway'\n",
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

test('accepts range forms and still rejects wildcards', () => {
  assert.ok(!codes({ ...good, manifest: { ...good.manifest, engines: { dsh: '^0.2.1' } } }).includes('bad-engines'));
  assert.ok(codes({ ...good, manifest: { ...good.manifest, engines: { dsh: '~0.2.1' } } }).includes('bad-engines') === false);
  assert.ok(codes({ ...good, manifest: { ...good.manifest, engines: { dsh: '*' } } }).includes('bad-engines'));
});

test('rejects patches that weaken the security baseline', () => {
  const cases = [
    ["insert:\n  - id: x\n    name: y\n    disabled: true\n", 'patch-disables-row'],
    ["insert:\n  - id: forge-policy\n", 'patch-overrides-protected'],
    ["insert:\n  - id: x\n    name: y\n    config:\n      a: !!js ctx.get('x')\n", 'patch-js-expr'],
    ["insert:\n  - id: x\n    name: cordis:include\n", 'patch-include'],
    ["insert:\n  - id: x\n    name: '../../outside'\n", 'patch-unsafe-path'],
  ];
  for (const [patch, code] of cases) {
    assert.ok(codes({ ...good, patch }).includes(code), `${code} not reported`);
  }
});

test('requires the documented sections', () => {
  assert.ok(codes({ ...good, readme: '# 网关\n' }).includes('missing-section'));
});

test('says where a missing file was found instead', () => {
  const result = validatePlugin({
    files: ['package.json', 'cordis.patch.yml', 'docs/README.md'],
    manifest: { name: '@heluo/a', version: '0.1.0', engines: { dsh: '>=0.2.1' } },
    readme: '## 用途\n\nx\n\n## 维护人\n\ny\n',
    patch: 'insert: []\n',
    tag: 'v0.1.0',
  });
  const missing = result.errors.find((error) => error.code === 'missing-file');
  assert.equal(missing.detail, 'README.md');
  assert.match(missing.hint, /docs\/README\.md/);
  assert.match(missing.hint, /repository root/);
});
