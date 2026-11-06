import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { canonicalPayload, normalizeMessage, parseTrailer } from '../scripts/sensitive-scan/lib.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The installer rejects group-writable fixtures; model a conventional umask so a
// host with umask 0002 cannot turn security checks into suite failures.
process.umask(0o022);

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'scripts/sensitive-scan');
function run(file, args, options = {}) { return spawnSync(file, args, { encoding: 'utf8', ...options }); }
function ok(file, args, options = {}) {
  const r = run(file, args, options);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'full-team-package-'));
  const repo = join(dir, 'repo');
  const pkg = join(dir, "team 配置's");
  const scriptDir = join(pkg, 'scripts/sensitive-scan');
  const privateDir = join(pkg, 'private');
  const publicDir = join(pkg, '.github/sensitive-scan');
  for (const d of [repo, scriptDir, privateDir, publicDir]) mkdirSync(d, { recursive: true });
  for (const f of ['lib.mjs', 'team-full-install.mjs', 'team-scan.mjs', 'team-commit-msg.mjs', 'team-guard.mjs', 'team-attest.mjs', 'team-post-rewrite.mjs', 'team-pre-push.mjs', 'verify.mjs']) cpSync(join(SOURCE, f), join(scriptDir, f));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const rule = JSON.stringify({ literals: { sample: ['SYNTHETIC_TEAM_TERM'] }, patterns: { numeric: 'SYNTHETIC_[0-9]+' }, allow: ['SYNTHETIC_ALLOWED'], ignorePaths: ['ignored/**'] });
  writeFileSync(join(privateDir, 'device-key.pem'), key, { mode: 0o600 });
  writeFileSync(join(privateDir, 'rules.json'), rule, { mode: 0o600 });
  writeFileSync(join(publicDir, 'team-public-key.pub'), pub);
  // A tester's global gitignore must not decide whether this fixture can add a
  // key file; isolate user/system configuration for every git call here.
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  ok('git', ['init', '-q', repo], { env: gitEnv });
  ok('git', ['config', 'user.name', 'Test'], { cwd: repo, env: gitEnv });
  ok('git', ['config', 'user.email', 'test-user'], { cwd: repo, env: gitEnv });
  mkdirSync(join(repo, '.github/sensitive-scan'), { recursive: true });
  writeFileSync(join(repo, '.github/sensitive-scan/team-public-key.pub'), pub);
  ok('git', ['add', '.'], { cwd: repo, env: gitEnv });
  ok('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: repo, env: gitEnv });
  const base = ok('git', ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv });
  const installedKey = join(dir, 'config', 'device-key.pem');
  const installedRules = join(dir, 'config', 'rules.json');
  const env = { ...gitEnv, SENSITIVE_SCAN_KEY_FILE: installedKey, SENSITIVE_SCAN_RULES: installedRules };
  const installer = join(scriptDir, 'team-full-install.mjs');
  const install = () => run(process.execPath, [installer, '--repo', repo], { cwd: dir, env });
  return { dir, repo, pkg, key, publicKey, rule, env, installedKey, installedRules, base, install };
}

test('complete package installs its own key and real-schema rules, then signs', () => {
  const f = setup();
  try {
    const result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.installedKey, 'utf8'), f.key);
    assert.equal(readFileSync(f.installedRules, 'utf8'), f.rule);
    if (process.platform !== 'win32') assert.equal(statSync(f.installedKey).mode & 0o077, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN PRIVATE KEY|SYNTHETIC_TEAM_TERM/);
    assert.equal(f.install().status, 0);
    writeFileSync(join(f.repo, 'clean.txt'), 'clean\n');
    ok('git', ['add', 'clean.txt'], { cwd: f.repo });
    const commit = run('git', ['commit', '-q', '-m', 'clean'], { cwd: f.repo, env: f.env });
    assert.equal(commit.status, 0, commit.stderr);
    const { body, fields } = parseTrailer(ok('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: f.repo }));
    assert.equal(fields.tree, ok('git', ['rev-parse', 'HEAD^{tree}'], { cwd: f.repo }));
    assert.equal(fields.message, createHash('sha256').update(normalizeMessage(body)).digest('hex'));
    assert.equal(verify(null, Buffer.from(canonicalPayload(fields)), f.publicKey, Buffer.from(fields.sig, 'base64')), true);
    writeFileSync(join(f.repo, 'bad.txt'), 'SYNTHETIC_TEAM_TERM\n');
    ok('git', ['add', 'bad.txt'], { cwd: f.repo });
    const blocked = run('git', ['commit', '-q', '-m', 'bad'], { cwd: f.repo, env: f.env });
    assert.notEqual(blocked.status, 0);
    assert.doesNotMatch(blocked.stderr, /SYNTHETIC_TEAM_TERM/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer makes rebase the default pull strategy and keeps an explicit choice', () => {
  const f = setup();
  try {
    assert.equal(f.install().status, 0);
    assert.equal(ok('git', ['config', '--local', '--get', 'pull.rebase'], { cwd: f.repo, env: f.env }), 'true');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
  const g = setup();
  try {
    ok('git', ['config', '--local', 'pull.rebase', 'false'], { cwd: g.repo, env: g.env });
    assert.equal(g.install().status, 0);
    assert.equal(ok('git', ['config', '--local', '--get', 'pull.rebase'], { cwd: g.repo, env: g.env }), 'false');
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test('installed pre-push hook refuses an unsigned branch before it leaves the machine', () => {
  const f = setup();
  try {
    assert.equal(f.install().status, 0);
    const remote = join(f.dir, 'remote.git');
    ok('git', ['init', '-q', '--bare', remote]);
    ok('git', ['checkout', '-qb', 'topic'], { cwd: f.repo, env: f.env });
    writeFileSync(join(f.repo, 'signed.txt'), 'fine\n');
    ok('git', ['add', 'signed.txt'], { cwd: f.repo, env: f.env });
    ok('git', ['commit', '-qm', 'signed work'], { cwd: f.repo, env: f.env });
    ok('git', ['push', '-q', remote, 'topic'], { cwd: f.repo, env: f.env });
    writeFileSync(join(f.repo, 'unsigned.txt'), 'fine\n');
    ok('git', ['add', 'unsigned.txt'], { cwd: f.repo, env: f.env });
    ok('git', ['commit', '--no-verify', '-qm', 'unsigned work'], { cwd: f.repo, env: f.env });
    const push = run('git', ['push', remote, 'topic'], { cwd: f.repo, env: f.env });
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /push blocked/u);
    assert.match(push.stderr, /missing Sensitive-Scan trailer/u);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installed post-rewrite hook re-signs a rebased branch', () => {
  const f = setup();
  try {
    assert.equal(f.install().status, 0);
    const shim = readFileSync(join(f.repo, '.git/hooks/post-rewrite'), 'utf8');
    assert.match(shim, /team-post-rewrite\.mjs/u);
    const main = ok('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: f.repo, env: f.env });
    ok('git', ['checkout', '-qb', 'topic'], { cwd: f.repo, env: f.env });
    for (const [name, text] of [['a.txt', 'a\n'], ['b.txt', 'b\n']]) {
      writeFileSync(join(f.repo, name), text);
      ok('git', ['add', name], { cwd: f.repo, env: f.env });
      ok('git', ['commit', '-qm', `add ${name}`], { cwd: f.repo, env: f.env });
    }
    ok('git', ['checkout', '-q', main], { cwd: f.repo, env: f.env });
    writeFileSync(join(f.repo, 'moved.txt'), 'moved\n');
    ok('git', ['add', 'moved.txt'], { cwd: f.repo, env: f.env });
    ok('git', ['commit', '-qm', 'advance base'], { cwd: f.repo, env: f.env });
    ok('git', ['checkout', '-q', 'topic'], { cwd: f.repo, env: f.env });
    const rebase = run('git', ['rebase', main], { cwd: f.repo, env: f.env });
    assert.equal(rebase.status, 0, rebase.stderr);
    assert.match(rebase.stderr, /re-signed 2 commit\(s\) after rewrite/u);
    for (const sha of ok('git', ['rev-list', `${main}..topic`], { cwd: f.repo, env: f.env }).split('\n').filter(Boolean)) {
      const { fields } = parseTrailer(ok('git', ['show', '-s', '--format=%B', sha], { cwd: f.repo, env: f.env }));
      assert.equal(fields.tree, ok('git', ['rev-parse', `${sha}^{tree}`], { cwd: f.repo, env: f.env }));
      assert.equal(fields.parenttree, ok('git', ['rev-parse', `${sha}^^{tree}`], { cwd: f.repo, env: f.env }));
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('complete installer refuses conflicting configuration without overwriting it', () => {
  const f = setup();
  try {
    mkdirSync(join(f.dir, 'config'));
    writeFileSync(f.installedRules, 'existing rules');
    const r = f.install();
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(f.installedRules, 'utf8'), 'existing rules');
    assert.equal(existsSync(f.installedKey), false);
    assert.equal(existsSync(join(f.repo, '.git/hooks/commit-msg')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('complete installer refuses an existing hook before writing secrets', () => {
  const f = setup();
  try {
    const hook = join(f.repo, '.git/hooks/commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    assert.notEqual(f.install().status, 0);
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho existing\n');
    assert.equal(existsSync(f.installedKey), false);
    assert.equal(existsSync(f.installedRules), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('complete installer refuses an extracted package inside the repository', () => {
  const f = setup();
  try {
    const unsafe = join(f.repo, 'unpacked-team');
    cpSync(f.pkg, unsafe, { recursive: true });
    const r = run(process.execPath, [join(unsafe, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', f.repo], { env: f.env });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(f.installedKey), false);
    assert.equal(existsSync(join(f.repo, '.git/hooks/commit-msg')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('complete installer refuses a package inside a different Git worktree', () => {
  const f = setup();
  try {
    const other = join(f.dir, 'another-repo');
    ok('git', ['init', '-q', other]);
    const unsafe = join(other, 'unpacked-team');
    cpSync(f.pkg, unsafe, { recursive: true });
    const r = run(process.execPath, [join(unsafe, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', f.repo], { env: f.env });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(f.installedKey), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

function defaultEnv(f) {
  const env = { ...process.env, HOME: join(f.dir, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  delete env.SENSITIVE_SCAN_KEY_FILE;
  delete env.SENSITIVE_SCAN_RULES;
  delete env.XDG_CONFIG_HOME;
  return env;
}

function installDefault(f, env = defaultEnv(f)) {
  return run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', f.repo], { cwd: f.dir, env });
}

test('complete installer defaults to shared Git private storage and hook uses it', () => {
  const f = setup();
  try {
    const r = installDefault(f);
    assert.equal(r.status, 0, r.stderr);
    const dir = join(f.repo, '.git/heluo-sensitive-scan/private');
    assert.equal(readFileSync(join(dir, 'device-key.pem'), 'utf8'), f.key);
    assert.equal(readFileSync(join(dir, 'rules.json'), 'utf8'), f.rule);
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o077, 0);
      assert.equal(statSync(join(dir, 'device-key.pem')).mode & 0o077, 0);
      assert.equal(statSync(join(dir, 'rules.json')).mode & 0o077, 0);
    }
    assert.equal(installDefault(f).status, 0);
    writeFileSync(join(f.repo, 'safe.txt'), 'safe\n');
    ok('git', ['add', 'safe.txt'], { cwd: f.repo });
    const commit = run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env: defaultEnv(f) });
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(ok('git', ['ls-files', '--', 'secrets/sensitive-scan'], { cwd: f.repo }), '');
    writeFileSync(join(f.repo, 'blocked.txt'), 'SYNTHETIC_TEAM_TERM\n');
    ok('git', ['add', 'blocked.txt'], { cwd: f.repo });
    const blocked = run('git', ['commit', '-q', '-m', 'blocked'], { cwd: f.repo, env: defaultEnv(f) });
    assert.notEqual(blocked.status, 0);
    assert.doesNotMatch(blocked.stderr, /SYNTHETIC_TEAM_TERM/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer rejects a Git common directory in a trackable worktree path', () => {
  const f = setup();
  try {
    const repo = join(f.dir, 'separate-repo');
    const metadata = join(repo, 'metadata');
    ok('git', ['init', '-q', '--separate-git-dir', metadata, repo]);
    const result = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', repo], { cwd: f.dir, env: defaultEnv(f) });
    assert.notEqual(result.status, 0, 'trackable Git metadata must fail closed');
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/device-key.pem')), false);
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/rules.json')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer rejects a Git common directory inside another worktree', () => {
  const f = setup();
  try {
    const other = join(f.dir, 'other-repo');
    ok('git', ['init', '-q', other]);
    const repo = join(f.dir, 'separate-repo');
    const metadata = join(other, 'metadata');
    ok('git', ['init', '-q', '--separate-git-dir', metadata, repo]);
    const result = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', repo], { cwd: f.dir, env: defaultEnv(f) });
    assert.notEqual(result.status, 0, 'metadata in another worktree must fail closed');
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/device-key.pem')), false);
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/rules.json')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const withLinked of [false, true]) test(`installer rejects relative core.hooksPath ${withLinked ? 'with' : 'without'} a linked worktree`, () => {
  const f = setup();
  try {
    if (withLinked) ok('git', ['worktree', 'add', '-q', '-b', 'linked', join(f.dir, 'linked')], { cwd: f.repo });
    ok('git', ['config', 'core.hooksPath', 'custom-hooks'], { cwd: f.repo });
    const result = installDefault(f);
    assert.notEqual(result.status, 0, 'relative hooksPath cannot guarantee a shared hook');
    assert.equal(existsSync(join(f.repo, 'custom-hooks/commit-msg')), false);
    assert.equal(existsSync(join(f.repo, '.git/heluo-sensitive-scan/private/device-key.pem')), false);
    assert.equal(existsSync(join(f.repo, '.git/heluo-sensitive-scan/private/rules.json')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('linked installation detects a different main-worktree hook with external Git metadata', () => {
  const f = setup();
  try {
    const main = join(f.dir, 'separate-main');
    const metadata = join(f.dir, 'external-git');
    const linked = join(f.dir, 'linked');
    const mainHooks = join(f.dir, 'main-hooks');
    const env = defaultEnv(f);
    ok('git', ['init', '-q', '--separate-git-dir', metadata, main]);
    ok('git', ['config', 'user.name', 'Test'], { cwd: main, env });
    ok('git', ['config', 'user.email', 'test-user'], { cwd: main, env });
    ok('git', ['commit', '--allow-empty', '--no-verify', '-q', '-m', 'base'], { cwd: main, env });
    ok('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: main, env });
    ok('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: main, env });
    ok('git', ['config', '--worktree', 'core.hooksPath', mainHooks], { cwd: main, env });
    assert.equal(ok('git', ['config', '--path', 'core.hooksPath'], { cwd: main, env }), mainHooks);
    assert.notEqual(run('git', ['config', '--path', 'core.hooksPath'], { cwd: linked, env }).status, 0);
    const result = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', linked], { cwd: f.dir, env });
    assert.notEqual(result.status, 0, 'divergent main-worktree hook must be rejected');
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/device-key.pem')), false);
    assert.equal(existsSync(join(metadata, 'heluo-sensitive-scan/private/rules.json')), false);
    assert.equal(existsSync(join(metadata, 'hooks/commit-msg')), false);
    assert.equal(existsSync(join(mainHooks, 'commit-msg')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installed scanner refuses a common directory moved into a worktree', () => {
  const f = setup();
  try {
    const repo = join(f.dir, 'separate-repo');
    const original = join(f.dir, 'external-metadata');
    const moved = join(repo, 'metadata');
    const env = defaultEnv(f);
    ok('git', ['init', '-q', '--separate-git-dir', original, repo]);
    ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test-user', 'commit', '--allow-empty', '--no-verify', '-qm', 'base'], { cwd: repo, env });
    const installed = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', repo], { cwd: f.dir, env });
    assert.equal(installed.status, 0, installed.stderr);
    const message = join(f.dir, 'message.txt');
    writeFileSync(message, 'safe\n');
    const script = join(original, 'heluo-sensitive-scan/scripts/team-commit-msg.mjs');
    const safe = run(process.execPath, [script, message], { cwd: repo, env });
    assert.equal(safe.status, 0, safe.stderr);
    assert.ok(parseTrailer(readFileSync(message, 'utf8')).fields.sig);
    writeFileSync(message, 'safe\n');
    renameSync(original, moved);
    // Git may mark this gitfile hidden on Windows, where opening it with 'w' can fail.
    const gitfile = openSync(join(repo, '.git'), 'r+');
    try {
      ftruncateSync(gitfile, 0);
      writeFileSync(gitfile, `gitdir: ${moved}\n`);
    } finally { closeSync(gitfile); }
    const unsafe = run(process.execPath, [join(moved, 'heluo-sensitive-scan/scripts/team-commit-msg.mjs'), message], { cwd: repo, env });
    assert.notEqual(unsafe.status, 0, 'scanner must reject trackable common directory');
    assert.equal(readFileSync(message, 'utf8'), 'safe\n');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('XDG_CONFIG_HOME does not override the shared Git default', () => {
  const f = setup();
  try {
    const xdg = join(f.dir, 'xdg');
    const env = { ...defaultEnv(f), XDG_CONFIG_HOME: xdg };
    const result = installDefault(f, env);
    assert.equal(result.status, 0, result.stderr);
    const privateDir = join(f.repo, '.git/heluo-sensitive-scan/private');
    assert.equal(readFileSync(join(privateDir, 'device-key.pem'), 'utf8'), f.key);
    assert.equal(readFileSync(join(privateDir, 'rules.json'), 'utf8'), f.rule);
    assert.equal(existsSync(xdg), false);
    rmSync(f.pkg, { recursive: true, force: true });
    writeFileSync(join(f.repo, 'safe-xdg.txt'), 'safe\n');
    ok('git', ['add', 'safe-xdg.txt'], { cwd: f.repo });
    const commit = run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env });
    assert.equal(commit.status, 0, commit.stderr);
    const { fields } = parseTrailer(ok('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: f.repo }));
    assert.equal(verify(null, Buffer.from(canonicalPayload(fields)), f.publicKey, Buffer.from(fields.sig, 'base64')), true);
    assert.equal(existsSync(xdg), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const installFrom of ['main', 'linked']) test(`installation from ${installFrom} serves both worktrees after package removal`, () => {
  const f = setup();
  try {
    const linked = join(f.dir, 'linked worktree');
    ok('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: f.repo });
    const installRepo = installFrom === 'linked' ? linked : f.repo;
    const result = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', installRepo], { cwd: f.dir, env: defaultEnv(f) });
    assert.equal(result.status, 0, result.stderr);
    const shared = join(f.repo, '.git/heluo-sensitive-scan');
    const privateDir = join(shared, 'private');
    for (const [name, content] of [['device-key.pem', f.key], ['rules.json', f.rule]]) {
      const path = join(privateDir, name);
      assert.equal(readFileSync(path, 'utf8'), content);
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(shared).mode & 0o777, 0o700);
      assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    }
    for (const name of ['lib.mjs', 'team-scan.mjs', 'team-commit-msg.mjs']) {
      assert.equal(existsSync(join(shared, 'scripts', name)), true, name);
    }
    const hook = readFileSync(join(f.repo, '.git/hooks/commit-msg'), 'utf8');
    assert.ok(hook.includes('heluo-sensitive-scan'));
    assert.ok(!hook.includes(f.pkg));
    assert.equal(existsSync(join(f.repo, 'secrets/sensitive-scan')), false);
    assert.equal(existsSync(join(linked, 'secrets/sensitive-scan')), false);
    rmSync(f.pkg, { recursive: true, force: true });
    for (const [repo, filename] of [[f.repo, 'main.txt'], [linked, 'linked.txt']]) {
      writeFileSync(join(repo, filename), 'safe\n');
      ok('git', ['add', filename], { cwd: repo });
      const commit = run('git', ['commit', '-q', '-m', 'safe'], { cwd: repo, env: defaultEnv(f) });
      assert.equal(commit.status, 0, commit.stderr);
      const { fields } = parseTrailer(ok('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: repo }));
      assert.equal(fields.tree, ok('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo }));
      assert.equal(verify(null, Buffer.from(canonicalPayload(fields)), f.publicKey, Buffer.from(fields.sig, 'base64')), true);
      writeFileSync(join(repo, 'blocked.txt'), 'SYNTHETIC_TEAM_TERM\n');
      ok('git', ['add', 'blocked.txt'], { cwd: repo });
      const blocked = run('git', ['commit', '-q', '-m', 'blocked'], { cwd: repo, env: defaultEnv(f) });
      assert.notEqual(blocked.status, 0);
      assert.doesNotMatch(blocked.stderr, /SYNTHETIC_TEAM_TERM/);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('shared installation rejects unknown shared hook without writing private files', () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo, '.gitignore'), '/secrets/sensitive-scan/\n');
    const linked = join(f.dir, 'linked');
    ok('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: f.repo });
    writeFileSync(join(linked, '.gitignore'), '/secrets/sensitive-scan/\n');
    const hook = join(f.repo, '.git/hooks/commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho unknown\n', { mode: 0o700 });
    const result = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', linked], { cwd: f.dir, env: defaultEnv(f) });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho unknown\n');
    assert.equal(existsSync(join(f.repo, '.git/heluo-sensitive-scan/private/device-key.pem')), false);
    assert.equal(existsSync(join(f.repo, '.git/heluo-sensitive-scan/private/rules.json')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('shared installation refuses a symlinked storage directory', () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo, '.gitignore'), '/secrets/sensitive-scan/\n');
    const redirect = join(f.dir, 'redirect');
    mkdirSync(redirect, { mode: 0o700 });
    symlinkSync(redirect, join(f.repo, '.git/heluo-sensitive-scan'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.notEqual(installDefault(f).status, 0);
    assert.equal(existsSync(join(redirect, 'private/device-key.pem')), false);
    assert.equal(existsSync(join(f.repo, '.git/hooks/commit-msg')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('inside-repository destinations must be ignored and untracked', () => {
  const f = setup();
  try {
    const target = join(f.repo, 'device-key.pem');
    const env = { ...f.env, SENSITIVE_SCAN_KEY_FILE: target };
    assert.notEqual(installDefault(f, env).status, 0);
    assert.equal(existsSync(target), false);
    writeFileSync(target, f.key);
    ok('git', ['add', 'device-key.pem'], { cwd: f.repo, env: f.env });
    writeFileSync(join(f.repo, '.gitignore'), '/device-key.pem\n');
    assert.notEqual(installDefault(f, env).status, 0);
    assert.equal(existsSync(f.installedRules), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer rejects already tracked explicit secrets even if ignored', () => {
  const f = setup();
  try {
    const dir = join(f.repo, 'secrets/sensitive-scan');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'rules.json'), f.rule, { mode: 0o600 });
    ok('git', ['add', 'secrets/sensitive-scan/rules.json'], { cwd: f.repo });
    writeFileSync(join(f.repo, '.gitignore'), '/secrets/sensitive-scan/\n');
    const env = { ...f.env, SENSITIVE_SCAN_KEY_FILE: join(dir, 'device-key.pem'), SENSITIVE_SCAN_RULES: join(dir, 'rules.json') };
    assert.notEqual(installDefault(f, env).status, 0);
    assert.equal(existsSync(join(dir, 'device-key.pem')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('explicit ignored repository overrides install and sign', () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo, '.gitignore'), '/custom-private/\n');
    const dir = join(f.repo, 'custom-private');
    const env = { ...f.env, SENSITIVE_SCAN_KEY_FILE: join(dir, 'key.pem'), SENSITIVE_SCAN_RULES: join(dir, 'rules.json') };
    const result = installDefault(f, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(env.SENSITIVE_SCAN_KEY_FILE, 'utf8'), f.key);
    writeFileSync(join(f.repo, 'safe.txt'), 'safe\n');
    ok('git', ['add', 'safe.txt'], { cwd: f.repo });
    const commit = run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env });
    assert.equal(commit.status, 0, commit.stderr);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('hook refuses tracked or insecure repository secrets after installation', () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo, '.gitignore'), '/secrets/sensitive-scan/\n');
    const env = { ...f.env, SENSITIVE_SCAN_KEY_FILE: join(f.repo, 'secrets/sensitive-scan/device-key.pem'), SENSITIVE_SCAN_RULES: join(f.repo, 'secrets/sensitive-scan/rules.json') };
    assert.equal(installDefault(f, env).status, 0);
    const rules = env.SENSITIVE_SCAN_RULES;
    writeFileSync(join(f.repo, 'safe.txt'), 'safe\n');
    ok('git', ['add', 'safe.txt'], { cwd: f.repo });
    if (process.platform !== 'win32') {
      chmodSync(rules, 0o644);
      assert.notEqual(run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env }).status, 0);
      chmodSync(rules, 0o600);
    }
    ok('git', ['add', '-f', 'secrets/sensitive-scan/rules.json'], { cwd: f.repo });
    assert.notEqual(run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env }).status, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('relative explicit configuration is rejected by installer and hook', () => {
  const f = setup();
  try {
    for (const name of ['SENSITIVE_SCAN_KEY_FILE', 'SENSITIVE_SCAN_RULES']) {
      const env = { ...f.env, [name]: 'relative-location' };
      assert.notEqual(installDefault(f, env).status, 0, name);
      assert.equal(existsSync(f.installedKey), false);
    }
    assert.equal(f.install().status, 0);
    writeFileSync(join(f.repo, 'safe.txt'), 'safe\n');
    ok('git', ['add', 'safe.txt'], { cwd: f.repo });
    for (const name of ['SENSITIVE_SCAN_KEY_FILE', 'SENSITIVE_SCAN_RULES']) {
      const env = { ...f.env, [name]: 'relative-location' };
      assert.notEqual(run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env }).status, 0, name);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer and hook reject destinations inside another Git worktree', () => {
  const f = setup();
  try {
    const other = join(f.dir, 'other-repo');
    ok('git', ['init', '-q', other]);
    const key = join(other, 'new-private', 'key.pem');
    const rules = join(other, 'new-private', 'rules.json');
    for (const env of [{ ...f.env, SENSITIVE_SCAN_KEY_FILE: key }, { ...f.env, SENSITIVE_SCAN_RULES: rules }]) {
      assert.notEqual(installDefault(f, env).status, 0);
      assert.equal(existsSync(f.installedKey), false);
      assert.equal(existsSync(f.installedRules), false);
    }
    assert.equal(f.install().status, 0);
    mkdirSync(join(other, 'new-private'), { mode: 0o700 });
    writeFileSync(key, f.key, { mode: 0o600 });
    writeFileSync(rules, f.rule, { mode: 0o600 });
    writeFileSync(join(f.repo, 'safe.txt'), 'safe\n');
    ok('git', ['add', 'safe.txt'], { cwd: f.repo });
    for (const env of [{ ...f.env, SENSITIVE_SCAN_KEY_FILE: key }, { ...f.env, SENSITIVE_SCAN_RULES: rules }]) {
      assert.notEqual(run('git', ['commit', '-q', '-m', 'safe'], { cwd: f.repo, env }).status, 0);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('installer rejects symlink directory escapes and insecure existing files', () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo, '.gitignore'), '/secrets/sensitive-scan/\n');
    mkdirSync(join(f.repo, 'secrets'));
    mkdirSync(join(f.dir, 'redirect'));
    symlinkSync(join(f.dir, 'redirect'), join(f.repo, 'secrets/sensitive-scan'), process.platform === 'win32' ? 'junction' : 'dir');
    const symlinkEnv = { ...f.env, SENSITIVE_SCAN_KEY_FILE: join(f.repo, 'secrets/sensitive-scan/device-key.pem') };
    assert.notEqual(installDefault(f, symlinkEnv).status, 0);
    assert.equal(existsSync(join(f.dir, 'redirect/device-key.pem')), false);
    const env = { ...f.env };
    mkdirSync(join(f.dir, 'config'));
    writeFileSync(f.installedRules, f.rule, { mode: 0o600 });
    chmodSync(f.installedRules, 0o644);
    if (process.platform !== 'win32') assert.notEqual(installDefault(f, env).status, 0);
    assert.equal(existsSync(f.installedKey), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a group-writable package is refused with its path, mode and the fix', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permissions only');
  const f = setup();
  try {
    const script = join(f.pkg, 'scripts/sensitive-scan/team-scan.mjs');
    chmodSync(script, 0o664);
    const r = installDefault(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /group\/other writable/u);
    assert.match(r.stderr, /team-scan\.mjs/u, 'the offender is named');
    assert.match(r.stderr, /0664/u, 'the actual mode is shown');
    assert.match(r.stderr, /umask 022/u, 'the fix is shown');
    assert.equal(existsSync(f.installedKey), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the explicit opt-in accepts an owner-writable package and installs 0600 copies', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permissions only');
  const f = setup();
  try {
    for (const name of ['lib.mjs', 'team-scan.mjs', 'team-commit-msg.mjs', 'team-full-install.mjs']) {
      chmodSync(join(f.pkg, 'scripts/sensitive-scan', name), 0o664);
    }
    chmodSync(join(f.pkg, 'private/device-key.pem'), 0o664);
    chmodSync(join(f.pkg, 'private/rules.json'), 0o664);
    const r = run(process.execPath, [join(f.pkg, 'scripts/sensitive-scan/team-full-install.mjs'), '--repo', f.repo, '--allow-group-writable'], { cwd: f.dir, env: defaultEnv(f) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /owner-writable/u);
    const sharedPrivate = join(f.repo, '.git/heluo-sensitive-scan/private');
    for (const path of [join(sharedPrivate, 'device-key.pem'), join(sharedPrivate, 'rules.json'), join(f.repo, '.git/heluo-sensitive-scan/scripts/lib.mjs')]) {
      assert.equal(statSync(path).mode & 0o077, 0, `${path} stays private`);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
