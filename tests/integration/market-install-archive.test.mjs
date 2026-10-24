import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { downloadArchive, installPlugin } from '../../packages/forge-market/src/install.mjs';
import { extractTarball } from '../../packages/forge-market/src/tarball.mjs';
import { buildRegistrationRow, renderPatch } from '../../packages/forge-market/src/registration.mjs';
import { digestOf } from '../../packages/forge-market/src/installer.mjs';
import { readDshVersion } from '../../scripts/lib/dsh-version.mjs';

// 宿主版本从单一真源派生：这条用例断言"装到当前基线宿主上应当成功"，写死版本会在升版后失真。
const HOST_DSH_VERSION = readDshVersion(new URL('../..', import.meta.url).pathname);

// 最小 tar 写入器：测试要真的走 gzip → 解包 → 白名单，而不是喂现成的文件数组。
function header(name, size, type = '0') {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644', 100, 8, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  block.write(type, 156, 1, 'utf8');
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return block;
}

function tar(entries) {
  const parts = [];
  for (const [path, content] of entries) {
    const bytes = Buffer.from(content, 'utf8');
    parts.push(header(path, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

const manifest = JSON.stringify({ name: '@heluo/demo-archive', version: '0.3.0', engines: { dsh: '>=0.2.0' } });
const patch = "- insert:\n    - id: demo-archive\n      name: '@heluo/demo-archive'\n";
const readme = '# @heluo/demo-archive\n\n## 用途\n\n联调用。\n\n## 维护人\n\n平台组\n';

async function serve(bytes) {
  const server = createServer((req, res) => {
    if (req.url !== '/demo-archive-v0.3.0.tar.gz') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/demo-archive-v0.3.0.tar.gz` };
}

test('installs a real gzipped archive served over HTTP and renders its registration', async () => {
  const bytes = tar([
    ['._demo-archive-v0.3.0', 'appledouble'],
    ['demo-archive-v0.3.0/package.json', manifest],
    ['demo-archive-v0.3.0/cordis.patch.yml', patch],
    ['demo-archive-v0.3.0/README.md', readme],
    ['demo-archive-v0.3.0/src/index.mjs', 'export const name = "demo-archive";\n'],
    ['demo-archive-v0.3.0/LICENSE', 'AGPL'],
  ]);
  const { server, url } = await serve(bytes);
  try {
    const downloaded = await downloadArchive(url);
    assert.equal(downloaded.ok, true);
    assert.equal(digestOf(downloaded.bytes), digestOf(bytes));

    const plan = { name: '@heluo/demo-archive', version: '0.3.0', tag: 'v0.3.0', repo: 'https://gitee.corp.example/g/demo-archive' };
    const result = await installPlugin(plan, { download: async () => downloaded, extract: extractTarball, dshVersion: HOST_DSH_VERSION });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.installed.paths, ['package.json', 'cordis.patch.yml', 'README.md', 'src/index.mjs']);

    const built = buildRegistrationRow(result.installed, { serviceUrl: 'http://127.0.0.1:3110' });
    assert.equal(built.ok, true);
    assert.match(renderPatch(built), /- id: heluo-demo-archive/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refuses an archive declared larger than the cap before reading the body', async () => {
  const bytes = tar([['demo-archive-v0.3.0/package.json', manifest]]);
  const { server, url } = await serve(bytes);
  try {
    const downloaded = await downloadArchive(url, { maxBytes: 16 });
    assert.equal(downloaded.ok, false);
    assert.equal(downloaded.reason, 'archive-too-large');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
