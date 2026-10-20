import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArchivePaths, digestOf, planInstall, verifyDigest } from '../src/installer.mjs';

const entry = { name: '@heluo/a', versions: ['0.1.0', '0.2.0'], repo: 'https://gitee.corp.example/g/a' };

test('plans the latest version by default', () => {
  assert.deepEqual(planInstall(entry, undefined, ['gitee.corp.example']).plan.tag, 'v0.2.0');
});

test('refuses a host outside the allowlist and a bad repo', () => {
  assert.equal(planInstall(entry, '0.1.0', ['other.example']).reason, 'host-not-allowed');
  assert.equal(planInstall({ ...entry, repo: 'not a url' }).reason, 'bad-repo');
});

test('detects a digest mismatch', () => {
  const bytes = Buffer.from('payload');
  assert.equal(verifyDigest(bytes, digestOf(bytes)).ok, true);
  assert.equal(verifyDigest(bytes, digestOf(Buffer.from('other'))).reason, 'digest-mismatch');
  assert.equal(verifyDigest(bytes, '').reason, 'no-digest');
});

test('rejects traversal, absolute and unexpected paths', () => {
  assert.equal(checkArchivePaths(['package.json', 'src/index.mjs']).ok, true);
  const bad = checkArchivePaths(['../evil', '/etc/passwd', 'docs/readme.md']);
  assert.equal(bad.reason, 'unsafe-path');
  assert.deepEqual(bad.detail, ['../evil', '/etc/passwd', 'docs/readme.md']);
});

test('skips revoked versions and refuses an explicitly revoked one', () => {
  const entry = {
    name: '@heluo/a',
    repo: 'https://gitee.corp.example/g/a',
    versions: [
      { version: '0.1.0', tag: 'v0.1.0' },
      { version: '0.2.0', tag: 'v0.2.0', revoked: true },
    ],
  };
  assert.equal(planInstall(entry, undefined, ['gitee.corp.example']).plan.version, '0.1.0');
  assert.equal(planInstall(entry, '0.2.0', ['gitee.corp.example']).reason, 'version-revoked');
});
