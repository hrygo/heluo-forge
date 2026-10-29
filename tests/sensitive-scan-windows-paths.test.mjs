import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';

// Exercise the actual installer helper with Windows path semantics on any host.
test('installer resolves an 8.3 worktree alias despite realpath casing differences', () => {
  const source = readFileSync(new URL('../scripts/sensitive-scan/team-full-install.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeRepoAlias(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const root = 'C:\\Fixtures\\RunnerAdmin\\repo';
  const alias = 'C:\\Fixtures\\RUNNER~1\\repo';
  const helper = runInNewContext(`(${source.slice(start, end)})`, {
    ...win32,
    statIfPresent: (path) => win32.relative(path, alias) === '' ? {} : null,
    realpathSync: Object.assign((path) => path, { native: (path) => path === root ? root : 'c:\\fixtures\\runneradmin\\repo' }),
    process: { platform: 'win32' },
  });
  assert.equal(helper(`${alias}\\device-key.pem`, root), `${root}\\device-key.pem`);
});

function run(file, args, options = {}) {
  return spawnSync(file, args, { encoding: 'utf8', ...options });
}

function ok(file, args, options = {}) {
  const result = run(file, args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function shortPath(path) {
  return ok(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'for %I in ("%SYNTHETIC_PATH%") do @echo %~sI'], {
    env: { ...process.env, SYNTHETIC_PATH: path },
  });
}

test('Windows 8.3 aliases enforce ignored and tracked secret checks', { skip: process.platform !== 'win32' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-path-alias-'));
  try {
    const repo = join(dir, 'synthetic-repository');
    const pkg = join(dir, 'synthetic-package');
    const scripts = join(pkg, 'scripts', 'sensitive-scan');
    const privateDir = join(pkg, 'private');
    const publicDir = join(pkg, '.github', 'sensitive-scan');
    for (const item of [repo, scripts, privateDir, publicDir]) mkdirSync(item, { recursive: true });
    for (const name of ['lib.mjs', 'team-full-install.mjs', 'team-commit-msg.mjs', 'team-scan.mjs']) {
      cpSync(new URL(`../scripts/sensitive-scan/${name}`, import.meta.url), join(scripts, name));
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(privateDir, 'device-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(privateDir, 'rules.json'), JSON.stringify({ literals: {}, patterns: {} }));
    writeFileSync(join(publicDir, 'team-public-key.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    ok('git', ['init', '-q', repo]);
    ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test-user', 'commit', '--allow-empty', '--no-verify', '-qm', 'base'], { cwd: repo });
    const privatePath = join(repo, 'long-sensitive-directory');
    mkdirSync(privatePath);
    const aliasDir = shortPath(privatePath);
    if (aliasDir.toLowerCase() === privatePath.toLowerCase() || !existsSync(aliasDir)) {
      t.skip('Windows volume does not expose a distinct directory 8.3 alias');
      return;
    }
    assert.equal(realpathSync.native(aliasDir).toLowerCase(), realpathSync.native(privatePath).toLowerCase());
    const key = join(aliasDir, 'long-device-key.pem');
    const rules = join(aliasDir, 'long-team-rules.json');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', SENSITIVE_SCAN_KEY_FILE: key, SENSITIVE_SCAN_RULES: rules };
    const installer = join(scripts, 'team-full-install.mjs');
    const install = () => run(process.execPath, [installer, '--repo', repo], { cwd: dir, env });
    assert.notEqual(install().status, 0, 'unignored directory alias must be rejected');
    assert.equal(existsSync(key), false);
    writeFileSync(join(repo, '.gitignore'), '/long-sensitive-directory/\n');
    const installed = install();
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(existsSync(rules));
    const message = join(dir, 'message.txt');
    const hook = join(repo, '.git', 'heluo-sensitive-scan', 'scripts', 'team-commit-msg.mjs');
    writeFileSync(message, 'safe\n');
    const allowed = run(process.execPath, [hook, message], { cwd: repo, env });
    assert.equal(allowed.status, 0, allowed.stderr);
    const aliasFile = shortPath(rules);
    if (aliasFile.toLowerCase() === rules.toLowerCase() || !existsSync(aliasFile)) {
      t.skip('Windows volume does not expose a distinct file 8.3 alias');
      return;
    }
    assert.equal(realpathSync.native(aliasFile).toLowerCase(), realpathSync.native(rules).toLowerCase());
    ok('git', ['add', '-f', 'long-sensitive-directory/long-team-rules.json'], { cwd: repo });
    const trackedEnv = { ...env, SENSITIVE_SCAN_RULES: aliasFile };
    const rejected = run(process.execPath, [installer, '--repo', repo], { cwd: dir, env: trackedEnv });
    assert.notEqual(rejected.status, 0, 'tracked file alias must be rejected');
    writeFileSync(message, 'safe\n');
    const signed = run(process.execPath, [hook, message], { cwd: repo, env: trackedEnv });
    assert.notEqual(signed.status, 0, 'hook must reject a tracked file alias');
    assert.equal(readFileSync(message, 'utf8'), 'safe\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
