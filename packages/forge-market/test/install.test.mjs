import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadArchive, installPlugin } from '../src/install.mjs';
import { digestOf } from '../src/installer.mjs';

const plan = { name: '@heluo/a', version: '0.1.0', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' };

const files = [
  { path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) },
  { path: 'cordis.patch.yml', bytes: Buffer.from('insert: []\n') },
  { path: 'README.md', bytes: Buffer.from('# a\n') },
];

const deps = (overrides = {}) => ({
  download: async () => ({ ok: true, bytes: Buffer.from('tar') }),
  extract: async () => ({ ok: true, files }),
  ...overrides,
});

test('installs a well-formed archive and reports it once', async () => {
  let reported;
  const result = await installPlugin(plan, deps({ onInstalled: (value) => { reported = value; } }));
  assert.equal(result.ok, true);
  assert.equal(result.installed.name, '@heluo/a');
  assert.equal(reported.version, '0.1.0');
});

test('stops on digest mismatch before extracting', async () => {
  let extracted = false;
  const result = await installPlugin(plan, deps({
    expectedDigest: digestOf(Buffer.from('other')),
    extract: async () => { extracted = true; return { ok: true, files }; },
  }));
  assert.equal(result.reason, 'digest-mismatch');
  assert.equal(extracted, false);
});

test('rejects unsafe archive paths', async () => {
  const result = await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: [...files, { path: '../evil', bytes: Buffer.from('') }] }) }));
  assert.equal(result.reason, 'unsafe-path');
});

test('rejects a manifest that disagrees with the plan', async () => {
  const mismatched = [{ ...files[0], bytes: Buffer.from(JSON.stringify({ name: '@heluo/other', version: '9.9.9' })) }, ...files.slice(1)];
  const result = await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: mismatched }) }));
  assert.equal(result.reason, 'name-mismatch');
});

test('reports download failures without throwing', async () => {
  const result = await installPlugin(plan, deps({ download: async () => ({ ok: false, reason: 'network' }) }));
  assert.equal(result.reason, 'network');
});

test('times out a hanging download', async () => {
  const result = await downloadArchive('https://gitee.corp.example/a.tar.gz', {
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(result.reason, 'timeout');
});

test('a throwing downloader or extractor is reported, not thrown', async () => {
  const downloadBoom = await installPlugin(plan, { download: () => { throw new Error('dns'); }, extract: async () => ({ ok: true, files: [] }) });
  assert.equal(downloadBoom.reason, 'download-failed');
  const extractBoom = await installPlugin(plan, { download: async () => ({ ok: true, bytes: Buffer.from('x') }), extract: () => { throw new Error('eof'); } });
  assert.equal(extractBoom.reason, 'extract-failed');
});

test('rejects an unparsable manifest and a version that differs from the plan', async () => {
  const broken = [{ ...files[0], bytes: Buffer.from('{not json') }, ...files.slice(1)];
  assert.equal((await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: broken }) }))).reason, 'bad-manifest');

  const other = [{ ...files[0], bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '9.9.9' })) }, ...files.slice(1)];
  assert.equal((await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: other }) }))).reason, 'version-mismatch');
});

test('stops reading a download that exceeds the cap', async () => {
  let cancelled = false;
  const body = {
    getReader: () => ({
      read: async () => ({ done: false, value: Buffer.alloc(1024) }),
      cancel: async () => { cancelled = true; },
    }),
  };
  const result = await downloadArchive('https://gitee.corp.example/g/a/archive.tar.gz', {
    maxBytes: 2048,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, body }),
  });
  assert.equal(result.reason, 'archive-too-large');
  assert.equal(cancelled, true);
});

test('refuses a declared size above the cap before reading the body', async () => {
  const result = await downloadArchive('https://gitee.corp.example/g/a/archive.tar.gz', {
    maxBytes: 1024,
    fetchImpl: async () => ({ ok: true, headers: { get: () => '4096' }, body: { getReader: () => { throw new Error('should not read'); } } }),
  });
  assert.equal(result.reason, 'archive-too-large');
});

test('refuses a patch whose row names another package', async () => {
  const wrong = files.map((file) => file.path === 'cordis.patch.yml'
    ? { ...file, bytes: Buffer.from("insert:\n  - id: a\n    name: '@heluo/other'\n") }
    : file);
  const result = await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: wrong }) }));
  assert.equal(result.reason, 'patch-name-mismatch');
  assert.deepEqual(result.detail, ['@heluo/other']);
});

test('accepts a patch that names the package itself', async () => {
  const right = files.map((file) => file.path === 'cordis.patch.yml'
    ? { ...file, bytes: Buffer.from("insert:\n  - id: a\n    name: '@heluo/a'\n") }
    : file);
  assert.equal((await installPlugin(plan, deps({ extract: async () => ({ ok: true, files: right }) }))).ok, true);
});
