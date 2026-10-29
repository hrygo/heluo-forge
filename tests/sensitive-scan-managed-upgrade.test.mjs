import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalPayload, parseTrailer } from '../scripts/sensitive-scan/lib.mjs';

// Public program sources from commit 513f, pinned for shallow CI checkouts.
const OLD = resolve(import.meta.dirname, 'fixtures/sensitive-scan-v1');
const HASHES = { 'lib.mjs': '9973e15ad4b9ce7077e2c18bd0b334cad6055fbd534ade422b380101dff9dcc8', 'team-commit-msg.mjs': '1dcdf2b1ff8da88f7366d7b67568037a27363749b5e4e9e62e60253e2eafb54a', 'team-scan.mjs': '761ad1e8fb517e589505884113bc3f9194d46b96be985860d2899ed647c1c90b' };
const source = resolve(import.meta.dirname, '../scripts/sensitive-scan');
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', ...options });
function ok(file, args, options) { const r = run(file, args, options); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'managed-upgrade-'));
  const repo = join(dir, 'repo'), pkg = join(dir, 'package'), scripts = join(pkg, 'scripts/sensitive-scan');
  for (const d of [repo, scripts, join(pkg, 'private'), join(pkg, '.github/sensitive-scan')]) mkdirSync(d, { recursive: true });
  cpSync(join(source, 'team-full-install.mjs'), join(scripts, 'team-full-install.mjs'));
  for (const name of Object.keys(HASHES)) {
    const content = readFileSync(join(OLD, name));
    assert.equal(createHash('sha256').update(content).digest('hex'), HASHES[name]);
    writeFileSync(join(scripts, name), content);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(pkg, 'private/device-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(pkg, 'private/rules.json'), JSON.stringify({ literals: { sample: ['SYNTHETIC_SECRET'] }, patterns: {} }), { mode: 0o600 });
  writeFileSync(join(pkg, '.github/sensitive-scan/team-public-key.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  delete env.SENSITIVE_SCAN_KEY_FILE; delete env.SENSITIVE_SCAN_RULES; delete env.XDG_CONFIG_HOME;
  ok('git', ['init', '-q', repo], { env });
  ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test-user', 'commit', '--allow-empty', '--no-verify', '-qm', 'base'], { cwd: repo, env });
  const installer = join(scripts, 'team-full-install.mjs');
  const install = (...args) => run(process.execPath, [installer, '--repo', repo, ...args], { cwd: dir, env });
  const initial = install(); assert.equal(initial.status, 0, initial.stderr);
  for (const n of ['lib.mjs', 'team-commit-msg.mjs']) cpSync(join(source, n), join(scripts, n));
  const shared = join(repo, '.git/heluo-sensitive-scan');
  const hook = join(repo, '.git/hooks/commit-msg');
  return { dir, repo, pkg, scripts, shared, hook, env, install, publicKey };
}
const snapshot = (f) => Object.fromEntries(['scripts/lib.mjs', 'scripts/team-scan.mjs', 'scripts/team-commit-msg.mjs', 'private/device-key.pem', 'private/rules.json'].map(n => [n, readFileSync(join(f.shared, n)).toString('base64')]).concat([['hook', readFileSync(f.hook).toString('base64')]]));

test('known v1 upgrade backs up public scripts and signs in both worktrees', () => {
  const f = setup();
  try {
    const linked = join(f.dir, 'linked');
    ok('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: f.repo, env: f.env });
    const before = snapshot(f), result = f.install('--upgrade-known-v1');
    assert.equal(result.status, 0, result.stderr);
    const after = snapshot(f);
    for (const n of ['lib.mjs', 'team-commit-msg.mjs']) assert.equal(after['scripts/' + n], readFileSync(join(f.scripts, n)).toString('base64'));
    for (const n of ['scripts/team-scan.mjs', 'private/device-key.pem', 'private/rules.json', 'hook']) assert.equal(after[n], before[n]);
    const backups = join(f.shared, 'backups');
    const dirs = readdirSync(backups); assert.equal(dirs.length, 1);
    const backup = join(backups, dirs[0]);
    if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(backup).sort(), ['lib.mjs', 'team-commit-msg.mjs']);
    for (const n of ['lib.mjs', 'team-commit-msg.mjs']) assert.equal(readFileSync(join(backup,n)).toString('base64'), before['scripts/' + n]);
    assert.equal(f.install('--upgrade-known-v1').status, 0);
    for (const repo of [f.repo, linked]) {
      ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test-user', 'commit', '--allow-empty', '-qm', 'safe'], { cwd: repo, env: f.env });
      const fields = parseTrailer(ok('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: repo, env: f.env })).fields;
      assert.equal(fields.version, 'v2');
      assert.equal(fields.parenttree, ok('git', ['rev-parse', 'HEAD^' + '^{tree}'], { cwd: repo, env: f.env }));
      assert.equal(verify(null, Buffer.from(canonicalPayload(fields)), f.publicKey, Buffer.from(fields.sig, 'base64')), true);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('interrupted upgrade resumes from mixed v1 and v2 without touching previous backup', () => {
  const f = setup();
  try {
    const linked = join(f.dir, 'linked');
    ok('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: f.repo, env: f.env });
    const previous = join(f.shared, 'backups', 'previous');
    mkdirSync(previous, { recursive: true, mode: 0o700 });
    for (const name of ['lib.mjs', 'team-commit-msg.mjs']) cpSync(join(f.shared, 'scripts', name), join(previous, name));
    cpSync(join(f.scripts, 'lib.mjs'), join(f.shared, 'scripts/lib.mjs'));
    chmodSync(join(f.shared, 'scripts/lib.mjs'), 0o600);
    const before = snapshot(f);
    const oldBackup = Object.fromEntries(readdirSync(previous).map(name => [name, readFileSync(join(previous, name)).toString('base64')]));
    const result = f.install('--upgrade-known-v1');
    assert.equal(result.status, 0, result.stderr);
    const after = snapshot(f);
    for (const name of ['lib.mjs', 'team-commit-msg.mjs']) assert.equal(after['scripts/' + name], readFileSync(join(f.scripts, name)).toString('base64'));
    for (const name of ['scripts/team-scan.mjs', 'private/device-key.pem', 'private/rules.json', 'hook']) assert.equal(after[name], before[name]);
    assert.deepEqual(Object.fromEntries(readdirSync(previous).map(name => [name, readFileSync(join(previous, name)).toString('base64')])), oldBackup);
    const backups = readdirSync(join(f.shared, 'backups')).filter(name => name !== 'previous');
    assert.equal(backups.length, 1);
    assert.deepEqual(readdirSync(join(f.shared, 'backups', backups[0])), ['team-commit-msg.mjs']);
    assert.equal(readFileSync(join(f.shared, 'backups', backups[0], 'team-commit-msg.mjs')).toString('base64'), before['scripts/team-commit-msg.mjs']);
    for (const repo of [f.repo, linked]) {
      ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test-user', 'commit', '--allow-empty', '-qm', 'safe'], { cwd: repo, env: f.env });
      const fields = parseTrailer(ok('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: repo, env: f.env })).fields;
      assert.equal(fields.version, 'v2');
      assert.equal(fields.parenttree, ok('git', ['rev-parse', 'HEAD^' + '^{tree}'], { cwd: repo, env: f.env }));
      assert.equal(verify(null, Buffer.from(canonicalPayload(fields)), f.publicKey, Buffer.from(fields.sig, 'base64')), true);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('missing script in a partially upgraded installation is not recreated', () => {
  const f = setup();
  try {
    cpSync(join(f.scripts, 'lib.mjs'), join(f.shared, 'scripts/lib.mjs'));
    chmodSync(join(f.shared, 'scripts/lib.mjs'), 0o600);
    unlinkSync(join(f.shared, 'scripts/team-commit-msg.mjs'));
    const before = ['scripts/lib.mjs', 'scripts/team-scan.mjs', 'private/device-key.pem', 'private/rules.json'].map(name => readFileSync(join(f.shared, name)).toString('base64'));
    const hook = readFileSync(f.hook);
    assert.notEqual(f.install('--upgrade-known-v1').status, 0);
    assert.equal(existsSync(join(f.shared, 'scripts/team-commit-msg.mjs')), false);
    assert.deepEqual(['scripts/lib.mjs', 'scripts/team-scan.mjs', 'private/device-key.pem', 'private/rules.json'].map(name => readFileSync(join(f.shared, name)).toString('base64')), before);
    assert.deepEqual(readFileSync(f.hook), hook);
    assert.equal(existsSync(join(f.shared, 'backups')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('without explicit upgrade flag old scripts are untouched', () => {
  const f = setup(); try { const before = snapshot(f); assert.notEqual(f.install().status, 0); assert.deepEqual(snapshot(f), before); assert.equal(existsSync(join(f.shared, 'backups')), false); } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const name of ['lib.mjs', 'team-scan.mjs', 'team-commit-msg.mjs']) test(`tampered ${name} rejects upgrade without changes`, () => {
  const f = setup(); try { writeFileSync(join(f.shared, 'scripts', name), 'unknown'); const before = snapshot(f); assert.notEqual(f.install('--upgrade-known-v1').status, 0); assert.deepEqual(snapshot(f), before); assert.equal(existsSync(join(f.shared, 'backups')), false); } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const name of ['private/device-key.pem', 'private/rules.json', 'hook']) test(`changed ${name} rejects upgrade without changes`, () => {
  const f = setup();
  try {
    writeFileSync(name === 'hook' ? f.hook : join(f.shared, name), 'different');
    const before = snapshot(f);
    assert.notEqual(f.install('--upgrade-known-v1').status, 0);
    assert.deepEqual(snapshot(f), before);
    assert.equal(existsSync(join(f.shared, 'backups')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('insecure script permissions reject upgrade before any backup', { skip: process.platform === 'win32' }, () => {
  const f = setup();
  try {
    chmodSync(join(f.shared, 'scripts/team-scan.mjs'), 0o644);
    const before = snapshot(f);
    assert.notEqual(f.install('--upgrade-known-v1').status, 0);
    assert.deepEqual(snapshot(f), before);
    assert.equal(existsSync(join(f.shared, 'backups')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
