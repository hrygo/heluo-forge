import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, apply } from '../src/index.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the patch config keys equal the declared Config keys', async () => {
  const patch = await readFile(join(here, 'cordis.patch.yml'), 'utf8');
  const block = patch.slice(patch.indexOf('    config:'));
  const keys = [...block.matchAll(/^ {6}([A-Za-z]+):/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), Object.keys(Config).sort());
});

test('apply registers the market route when a web server exists', () => {
  const routes = [];
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
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
  assert.equal(registered.length, 9);
  assert.equal(typeof dispose, 'function');

  const registration = registered.find((tool) => tool.name === 'market_registration');
  return registration.execute({ name: '@heluo/forge-market' }).then((result) => {
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.ok, true);
    assert.equal(value.row.config.serviceUrl, 'https://plugins.corp.example');
  });
});
