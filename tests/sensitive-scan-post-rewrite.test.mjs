import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseTrailer } from '../scripts/sensitive-scan/lib.mjs';

// The installer rejects group-writable fixtures; model a conventional umask so a
// host with umask 0002 cannot turn security checks into suite failures.
process.umask(0o022);

const SOURCE = resolve(import.meta.dirname, '../scripts/sensitive-scan');
const rewriter = join(SOURCE, 'team-post-rewrite.mjs');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-rewrite-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
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
  const spawn = (args, options = {}) => spawnSync('git', args, { cwd: repo, env: { ...env, ...options.env }, encoding: 'utf8', ...options });
  const git = (args, options = {}) => {
    const result = spawn(args, options);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Synthetic']);
  git(['config', 'user.email', 'synthetic-test-user']);
  const hook = (name, script) => {
    const path = join(repo, '.git', 'hooks', name);
    writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(SOURCE, script))} "$1"\n`);
    chmodSync(path, 0o755);
  };
  const installHooks = () => { hook('commit-msg', 'team-commit-msg.mjs'); hook('post-rewrite', 'team-post-rewrite.mjs'); };
  const commit = (file, text, message) => {
    writeFileSync(join(repo, file), text);
    git(['add', file]);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };
  const verify = (...extra) => spawnSync(process.execPath, [join(SOURCE, 'verify.mjs'), '--base', 'main', '--head', 'feat', ...extra], { cwd: repo, env, encoding: 'utf8' });
  return { dir, repo, env, git, spawn, installHooks, commit, verify, publicKey: keys.publicKey };
}

function resignRange(f, map) {
  return spawnSync(process.execPath, [rewriter, 'rebase'], {
    cwd: f.repo,
    env: f.env,
    input: map.map(([from, to]) => `${from} ${to}\n`).join(''),
    encoding: 'utf8',
  });
}

test('a conflict-free rebase over an advanced base is re-signed automatically', t => {
  const f = setup(t);
  mkdirSync(join(f.repo, '.github', 'sensitive-scan'), { recursive: true });
  writeFileSync(join(f.repo, '.github', 'sensitive-scan', 'team-public-key.pub'),
    f.publicKey.export({ type: 'spki', format: 'pem' }));
  f.git(['add', '.']);
  f.git(['commit', '-qm', 'base']);
  f.installHooks();
  f.git(['checkout', '-qb', 'feat']);
  f.commit('one.txt', 'one\n', 'add one');
  f.commit('two.txt', 'two\n', 'add two');
  f.git(['checkout', '-q', 'main']);
  writeFileSync(join(f.repo, 'base-move.txt'), 'moved\n');
  f.git(['add', 'base-move.txt']);
  f.git(['commit', '-qm', 'advance main']);
  f.git(['checkout', '-q', 'feat']);
  f.git(['rebase', 'main']);
  const verified = f.verify();
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /2 commit\(s\) verified/u);
  for (const sha of f.git(['rev-list', 'main..feat']).split('\n').filter(Boolean)) {
    const message = f.git(['show', '-s', '--format=%B', sha]);
    const { fields } = parseTrailer(message);
    assert.equal(fields.version, 'v2');
    assert.equal(fields.tree, f.git(['rev-parse', `${sha}^{tree}`]));
    assert.equal(fields.parenttree, f.git(['rev-parse', `${sha}^^{tree}`]));
  }
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('an amend signs against the real parent instead of itself', t => {
  const f = setup(t);
  f.git(['commit', '--allow-empty', '-qm', 'base']);
  f.installHooks();
  f.git(['checkout', '-qb', 'feat']);
  f.commit('one.txt', 'one\n', 'add one');
  f.git(['commit', '-q', '--amend', '-m', 'add one, amended']);
  const { fields } = parseTrailer(f.git(['show', '-s', '--format=%B', 'HEAD']));
  assert.equal(fields.parenttree, f.git(['rev-parse', 'HEAD^^{tree}']));
  assert.equal(fields.tree, f.git(['rev-parse', 'HEAD^{tree}']));
});

test('an already valid commit is left untouched', t => {
  const f = setup(t);
  f.git(['commit', '--allow-empty', '-qm', 'base']);
  f.installHooks();
  f.git(['checkout', '-qb', 'feat']);
  const sha = f.commit('one.txt', 'one\n', 'add one');
  const result = resignRange(f, [[sha, sha]]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(f.git(['rev-parse', 'HEAD']), sha);
});

test('rewritten sensitive content is never signed and never echoed', t => {
  const f = setup(t);
  f.git(['commit', '--allow-empty', '-qm', 'base']);
  f.installHooks();
  f.git(['checkout', '-qb', 'feat']);
  writeFileSync(join(f.repo, 'leak.txt'), 'SYNTHETICWORD\n');
  f.git(['add', 'leak.txt']);
  f.git(['commit', '-q', '--no-verify', '-m', 'unsigned']);
  const sha = f.git(['rev-parse', 'HEAD']);
  const result = resignRange(f, [['0'.repeat(40), sha]]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /SYNTHETICWORD/u);
  assert.equal(f.git(['show', '-s', '--format=%B', 'HEAD']), 'unsigned');
  assert.equal(f.git(['rev-parse', 'HEAD']), sha);
});
