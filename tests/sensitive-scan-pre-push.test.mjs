import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The installer rejects group-writable fixtures; model a conventional umask so a
// host with umask 0002 cannot turn security checks into suite failures.
process.umask(0o022);

const SOURCE = resolve(import.meta.dirname, '../scripts/sensitive-scan');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-pre-push-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  const keys = generateKeyPairSync('ed25519');
  const key = join(dir, 'key.pem');
  writeFileSync(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const rules = join(dir, 'rules.json');
  writeFileSync(rules, JSON.stringify({ literals: { synthetic: ['SYNTHETICWORD'] }, patterns: {}, allow: [], ignorePaths: [] }), { mode: 0o600 });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    SENSITIVE_SCAN_RULES: rules,
    SENSITIVE_SCAN_KEY_FILE: key,
  };
  const spawn = (args, options = {}) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', ...options });
  const git = (args) => {
    const result = spawn(args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Synthetic']);
  git(['config', 'user.email', 'synthetic-test-user']);
  git(['init', '-q', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  mkdirSync(join(repo, '.github/sensitive-scan'), { recursive: true });
  writeFileSync(join(repo, '.github/sensitive-scan/team-public-key.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  for (const [name, script] of [['commit-msg', 'team-commit-msg.mjs'], ['post-rewrite', 'team-post-rewrite.mjs'], ['pre-push', 'team-pre-push.mjs']]) {
    const path = join(repo, '.git/hooks', name);
    writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(SOURCE, script))} "$1"\n`);
    chmodSync(path, 0o755);
  }
  const commit = (file, text, message) => {
    writeFileSync(join(repo, file), text);
    git(['add', file]);
    git(['commit', '-qm', message]);
  };
  return {
    dir, repo, env, git, spawn, remote,
    commit,
    push: (args) => spawn(['push', ...args]),
  };
}

// A root commit has no baseline tree to scan, so the team hook cannot attest it;
// it becomes the base every later push is compared against.
function baseline(f) {
  f.git(['add', '.github']);
  f.git(['commit', '-q', '--no-verify', '-m', 'baseline']);
  assert.equal(f.push(['origin', 'main']).status, 0);
}

test('push of an attested branch is allowed', t => {
  const f = setup(t);
  baseline(f);
  f.git(['checkout', '-qb', 'feat']);
  f.commit('feat.txt', 'fine\n', 'feat');
  const push = f.push(['origin', 'feat']);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(f.spawn(['rev-parse', '--verify', 'origin/feat']).status, 0);
});

test('push of an unsigned commit is blocked without echoing content', t => {
  const f = setup(t);
  baseline(f);
  f.git(['checkout', '-qb', 'leaky']);
  writeFileSync(join(f.repo, 'note.txt'), 'SYNTHETICWORD\n');
  f.git(['add', 'note.txt']);
  f.git(['commit', '-q', '--no-verify', '-m', 'bypass']);
  const push = f.push(['origin', 'leaky']);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /not pushed/u);
  assert.match(push.stderr, /missing Sensitive-Scan trailer/u);
  assert.doesNotMatch(push.stderr, /SYNTHETICWORD/u);
  assert.notEqual(f.spawn(['rev-parse', '--verify', 'origin/leaky']).status, 0);
});

test('a branch replayed onto a newer base still pushes', t => {
  const f = setup(t);
  baseline(f);
  f.git(['checkout', '-qb', 'feat']);
  f.commit('feat.txt', 'fine\n', 'feat');
  assert.equal(f.push(['origin', 'feat']).status, 0);
  // The base branch advances with a server-created squash commit: no trailer,
  // and it is published, so it must not be re-checked when feat is replayed.
  f.git(['checkout', '-q', 'main']);
  writeFileSync(join(f.repo, 'squashed.txt'), 'squashed\n');
  f.git(['add', 'squashed.txt']);
  f.git(['commit', '-q', '--no-verify', '-m', 'squashed feature (#1)']);
  assert.equal(f.push(['--no-verify', 'origin', 'main']).status, 0);
  f.git(['checkout', '-q', 'feat']);
  f.git(['rebase', 'main']);
  const push = f.push(['origin', 'feat', '--force']);
  assert.equal(push.status, 0, push.stderr);
});

test('tag pushes are not verified', t => {
  const f = setup(t);
  baseline(f);
  f.git(['checkout', '-qb', 'leaky']);
  writeFileSync(join(f.repo, 'note.txt'), 'plain\n');
  f.git(['add', 'note.txt']);
  f.git(['commit', '-q', '--no-verify', '-m', 'bypass']);
  f.git(['tag', 'v-synthetic']);
  const push = f.push(['origin', 'v-synthetic']);
  assert.equal(push.status, 0, push.stderr);
});

test('deleting a remote branch is not verified', t => {
  const f = setup(t);
  baseline(f);
  f.git(['checkout', '-qb', 'feat']);
  f.commit('feat.txt', 'fine\n', 'feat');
  assert.equal(f.push(['origin', 'feat']).status, 0);
  const removal = f.push(['origin', '--delete', 'feat']);
  assert.equal(removal.status, 0, removal.stderr);
  assert.notEqual(f.spawn(['rev-parse', '--verify', 'origin/feat']).status, 0);
});