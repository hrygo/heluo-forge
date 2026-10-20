import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/index.mjs';
import { CONFIG_FIELDS, Config, validateConfig } from '../src/config.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the patch only sets keys that Config declares', async () => {
  const patch = await readFile(join(here, 'cordis.patch.yml'), 'utf8');
  const block = patch.slice(patch.indexOf('    config:'));
  const keys = [...block.matchAll(/^\s{8}([A-Za-z]+):/gm)].map((match) => match[1]);
  // 可选键留空不写：YAML 的 `~` 会变成 null，而 Config 声明的是 string。
  assert.deepEqual(keys.filter((key) => !CONFIG_FIELDS.includes(key)), []);
  assert.ok(keys.includes('serviceUrl'));
});

test('apply registers the market route when a web server exists', () => {
  const routes = [];
  const ctx = {
    tools: { register: () => () => {} },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer']);
      const host = {
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
        effect: (factory) => { factory(); },
      };
      callback(host);
      return () => {};
    },
  };
  const dispose = apply(ctx, { serviceUrl: 'https://plugins.corp.example' });
  assert.equal(routes.length, 1);
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: '/api/forge-market' });
  assert.equal(typeof dispose, 'function');
});

test('apply refuses an empty service url', () => {
  assert.throws(() => apply({ tools: { register: () => () => {} } }, {}), /serviceUrl/);
});

test('apply registers tools and passes cache and target through', () => {
  const registered = [];
  const dispose = apply(
    { tools: { register: (definition) => { registered.push(definition); return () => {}; } } },
    { serviceUrl: 'https://plugins.corp.example', cachePath: '/tmp/c.json', targetDir: '/tmp/plugins' },
  );
  assert.equal(registered.length, 10);
  assert.equal(typeof dispose, 'function');

  const registration = registered.find((tool) => tool.name === 'market_registration');
  return registration.execute({ name: '@heluo/forge-market' }).then((result) => {
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.ok, true);
    assert.equal(value.row.config.serviceUrl, 'https://plugins.corp.example');
  });
});

test('Config validates through the standard-schema protocol', () => {
  assert.equal(Config['~standard'].version, 1);
  const ok = Config['~standard'].validate({ serviceUrl: 'https://p.example', allowedHosts: ['gitee.corp.example'] });
  assert.equal(ok.issues, undefined);
  assert.deepEqual(ok.value.allowedHosts, ['gitee.corp.example']);
  const bad = Config['~standard'].validate({ timeoutMs: 'soon' });
  assert.equal(bad.value, undefined);
  assert.equal(bad.issues[0].path[0], 'timeoutMs');
});

test('every declared field is checked', () => {
  for (const field of CONFIG_FIELDS) {
    const result = validateConfig({ [field]: field === 'allowedHosts' ? 'nope' : field === 'timeoutMs' ? -1 : 42 });
    assert.ok(result.issues?.some((item) => item.path[0] === field), `${field} accepted a bad value`);
  }
});
