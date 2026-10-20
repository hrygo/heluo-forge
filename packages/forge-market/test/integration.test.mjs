import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMarketTools } from '../src/market-tools.mjs';
import { makeTarball } from './support/tar.mjs';
import { digestOf } from '../src/installer.mjs';

const pkg = JSON.stringify({ name: '@heluo/demo', version: '0.1.0' });

function startService() {
  const archive = makeTarball([
    ['package.json', pkg],
    ['cordis.patch.yml', 'insert: []\n'],
    ['README.md', '# demo\n'],
  ]);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (body) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/plugins') {
      return json({
        entries: [
          {
            name: '@heluo/demo',
            title: '演示插件',
            version: '0.1.0',
            repo: `http://127.0.0.1:${server.address().port}/g/demo`,
            stars: 3,
            downloads: 7,
          },
        ],
      });
    }
    if (url.pathname === '/api/plugins/@heluo/demo' || url.pathname === '/api/plugins/%40heluo%2Fdemo') {
      return json({
        name: '@heluo/demo',
        title: '演示插件',
        version: '0.1.0',
        versions: ['0.1.0'],
        repo: `http://127.0.0.1:${server.address().port}/g/demo`,
      });
    }
    if (url.pathname === '/api/plugins' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.statusCode = 202;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ state: 'pending', received: JSON.parse(body || '{}').tag }));
      });
      return;
    }
    if (url.pathname === '/g/demo/archive/refs/tags/v0.1.0.tar.gz') {
      res.end(archive);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, archive })));
}

test('installs a plugin end to end through a stub service', async () => {
  const { server, archive } = await startService();
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-e2e-'));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const tools = buildMarketTools(
      (await import('../src/client.mjs')).createServiceClient({ baseUrl: origin }),
      { allowedHosts: [`127.0.0.1:${server.address().port}`], targetDir: join(dir, 'plugin') },
    );

    const search = JSON.parse((await tools.find((t) => t.name === 'market_search').execute({})).content[0].text);
    assert.deepEqual(search.entries.map((e) => e.name), ['@heluo/demo']);

    const digest = digestOf(archive);
    const installed = JSON.parse(
      (await tools.find((t) => t.name === 'market_install').execute({ name: '@heluo/demo', digest })).content[0].text,
    );
    assert.equal(installed.ok, true);
    assert.equal(installed.installed.version, '0.1.0');
    assert.equal(JSON.parse(await readFile(join(dir, 'plugin', 'package.json'), 'utf8')).name, '@heluo/demo');

    const submitted = JSON.parse(
      (await tools.find((t) => t.name === 'market_submit').execute({
        repo: `http://127.0.0.1:${server.address().port}/g/demo`,
        name: '@heluo/demo',
        tag: 'v0.1.0',
      })).content[0].text,
    );
    assert.deepEqual(submitted, { ok: true, state: 'pending' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
