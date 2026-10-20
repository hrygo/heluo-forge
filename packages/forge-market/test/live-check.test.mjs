import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrlFor, checkRemote } from '../src/live-check.mjs';
import { digestOf } from '../src/installer.mjs';
import { makeTarball } from './support/tar.mjs';

const archive = makeTarball([
  ['package.json', JSON.stringify({ name: '@heluo/demo', version: '0.1.0', engines: { dsh: '>=0.2.1' } })],
  ['cordis.patch.yml', 'insert: []\n'],
  ['README.md', '# demo\n\n## 用途\n\nx\n\n## 维护人\n\ny\n'],
]);
const repo = 'https://gitee.corp.example/g/demo';
const respond = (bytes, status = 200) => () => Promise.resolve({ ok: status < 400, status, arrayBuffer: () => Promise.resolve(bytes) });

test('derives the tag archive address', () => {
  assert.equal(archiveUrlFor(`${repo}/`, 'v0.1.0'), `${repo}/archive/refs/tags/v0.1.0.tar.gz`);
});

test('passes a well formed archive and reports the digest', async () => {
  const report = await checkRemote({ repo, tag: 'v0.1.0', fetchImpl: respond(archive) });
  assert.equal(report.ok, true);
  assert.equal(report.digest, digestOf(archive));
  assert.ok(report.steps.some((step) => step.step === 'validate' && step.ok));
});

test('stops on a download failure, a digest mismatch or a bad package', async () => {
  assert.equal((await checkRemote({ repo, tag: 'v0.1.0', fetchImpl: respond(null, 404) })).ok, false);
  const mismatch = await checkRemote({ repo, tag: 'v0.1.0', digest: digestOf(Buffer.from('other')), fetchImpl: respond(archive) });
  assert.equal(mismatch.ok, false);
  const bad = makeTarball([['package.json', '{"name":"@heluo/demo","version":"0.1.0"}']]);
  assert.equal((await checkRemote({ repo, tag: 'v0.1.0', fetchImpl: respond(bad) })).ok, false);
});

test('refuses a host outside the allowlist before downloading', async () => {
  let called = false;
  const report = await checkRemote({ repo, tag: 'v0.1.0', allowedHosts: ['other.example'], fetchImpl: () => { called = true; } });
  assert.equal(report.ok, false);
  assert.equal(called, false);
});
