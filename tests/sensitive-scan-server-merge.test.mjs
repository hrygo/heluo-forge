import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keyIdFromPublicKey, sha256Hex } from '../scripts/sensitive-scan/lib.mjs';

// The verifier is the only place that can accept a commit no local hook saw, so
// these cases pin both what the exception covers and what it still refuses.
process.umask(0o022);

const verifier = resolve(import.meta.dirname, '../scripts/sensitive-scan/verify.mjs');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-server-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test-user', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test-user' };
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: repo, env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  const keys = generateKeyPairSync('ed25519');
  const publicDir = join(repo, '.github', 'sensitive-scan'); mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'team-public-key.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '.']);
  const baseTree = git(['write-tree']);
  const commit = (tree, parents, message) => git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], message);
  const base = commit(baseTree, [], 'base\n');
  git(['update-ref', 'refs/heads/main', base]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const tree = (name, text) => { writeFileSync(join(repo, name), text); git(['add', name]); return git(['write-tree']); };
  const v2 = (targetTree, parentTree, body = 'signed\n') => {
    const fields = { tree: targetTree, parenttree: parentTree, message: sha256Hex(body), scanner: 'heluo-sensitive-scan@1.0.0', time: '1700000000', nonce: 'a'.repeat(32), key: keyIdFromPublicKey(keys.publicKey) };
    const payload = ['v2', `tree=${fields.tree}`, `parent-tree=${fields.parenttree}`, `message=${fields.message}`, `scanner=${fields.scanner}`, `time=${fields.time}`, `nonce=${fields.nonce}`].join('\n');
    fields.sig = sign(null, Buffer.from(payload), keys.privateKey).toString('base64');
    return `${body}\nSensitive-Scan: v2\nSensitive-Scan-Tree: ${fields.tree}\nSensitive-Scan-ParentTree: ${fields.parenttree}\nSensitive-Scan-Message: ${fields.message}\nSensitive-Scan-Scanner: ${fields.scanner}\nSensitive-Scan-Time: ${fields.time}\nSensitive-Scan-Nonce: ${fields.nonce}\nSensitive-Scan-Key: ${fields.key}\nSensitive-Scan-Sig: ${fields.sig}\n`;
  };
  const verify = (head, ...extra) => spawnSync(process.execPath, [verifier, '--base', base, '--head', head, ...extra], { cwd: repo, env, encoding: 'utf8' });
  return { repo, env, git, base, baseTree, commit, tree, verify, v2 };
}

function pullRequest(f, number, headSha) {
  f.git(['update-ref', `refs/pull/${number}/head`, headSha]);
}

test('a squash commit is accepted only when its tree matches the attested head', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const head = f.commit(prTree, [f.base], f.v2(prTree, f.baseTree));
  pullRequest(f, 7, head);
  const squash = f.commit(prTree, [f.base], 'Add the feature (#7)\n\nSquashed body.\n');
  const plain = f.verify(squash);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /missing Sensitive-Scan trailer/u);
  const allowed = f.verify(squash, '--allow-server-merge');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /1 commit\(s\) verified \(1 server-created\)/u);
});

test('a merge commit on the branch is named as such, not as a missing trailer', t => {
  const f = fixture(t);
  const branchTree = f.tree('change.txt', 'change\n');
  const head = f.commit(branchTree, [f.base], f.v2(branchTree, f.baseTree));
  const merged = f.commit(f.baseTree, [head, f.base], 'Merge branch main into topic\n');
  const result = f.verify(merged);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /merge commit on this branch cannot be attested/u);
  assert.match(result.stderr, /git rebase/u);
});

test('a server merge commit is accepted through the same tree binding', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const head = f.commit(prTree, [f.base], f.v2(prTree, f.baseTree));
  pullRequest(f, 8, head);
  const merge = f.commit(prTree, [f.base, head], 'Merge pull request #8 from synthetic/branch\n\nSynthetic title\n');
  const allowed = f.verify(merge, '--allow-server-merge');
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('a differing tree is still rejected with the exception enabled', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const head = f.commit(prTree, [f.base], f.v2(prTree, f.baseTree));
  pullRequest(f, 9, head);
  const other = f.commit(f.tree('other.txt', 'other\n'), [f.base], 'Other change (#9)\n');
  const result = f.verify(other, '--allow-server-merge');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tree does not match/u);
});

test('an unfetched pull request ref fails closed', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const squash = f.commit(prTree, [f.base], 'Add the feature (#99)\n');
  const result = f.verify(squash, '--allow-server-merge');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no local ref for pull request #99/u);
});

test('a pull request head without an attestation does not vouch for anything', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const head = f.commit(prTree, [f.base], 'unsigned head\n');
  pullRequest(f, 10, head);
  const squash = f.commit(prTree, [f.base], 'Add the feature (#10)\n');
  const result = f.verify(squash, '--allow-server-merge');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing Sensitive-Scan trailer/u);
});

test('the exception never rescues a present but invalid attestation', t => {
  const f = fixture(t);
  const prTree = f.tree('change.txt', 'change\n');
  const tampered = f.v2(prTree, f.baseTree).replace(/(Sensitive-Scan-Sig: ).*/u, `$1${Buffer.alloc(64).toString('base64')}`);
  pullRequest(f, 11, f.commit(prTree, [f.base], tampered));
  const squash = f.commit(prTree, [f.base], 'Add the feature (#11)\n');
  const result = f.verify(squash, '--allow-server-merge');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signature verification failed/u);
});
