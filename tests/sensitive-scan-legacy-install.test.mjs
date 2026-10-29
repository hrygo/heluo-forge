import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(import.meta.dirname, '../scripts/sensitive-scan/install-hook.mjs');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-legacy-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const template = join(dir, 'empty-template');
  mkdirSync(repo); mkdirSync(template);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: template };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT']) delete env[name];
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  const hooks = join(repo, '.git', 'hooks');
  const target = join(hooks, 'commit-msg');
  const run = () => spawnSync(process.execPath, [installer], { cwd: repo, env, encoding: 'utf8' });
  return { hooks, target, run };
}

for (const [name, content] of [
  ['unknown hook', '#!/bin/sh\necho team-gate\n'],
  ['team managed shim', '#!/bin/sh\n# managed by scripts/sensitive-scan/team-full-install.mjs\nexec team-gate "$1"\n'],
  ['different legacy managed shim', '#!/bin/sh\n# managed by scripts/sensitive-scan/install-hook.mjs\nexit 1\n'],
]) {
  test(`refuses ${name} without changing or backing up the hook`, t => {
    const { hooks, target, run } = setup(t);
    mkdirSync(hooks, { recursive: true });
    writeFileSync(target, content, { mode: 0o700 });
    const result = run();
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(readFileSync(target, 'utf8'), content);
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(hooks), ['commit-msg']);
  });
}

test('refuses a dangling hook symlink without creating its target', t => {
  const { hooks, target, run } = setup(t);
  mkdirSync(hooks, { recursive: true });
  try { symlinkSync('missing-hook', target); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('symbolic link privilege unavailable');
    throw error;
  }
  const result = run();
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(hooks), ['commit-msg']);
});

test('installs the original executable legacy hook when absent', t => {
  const { target, run } = setup(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(target, 'utf8');
  assert.match(content, /^#!\/bin\/sh\n# managed by scripts\/sensitive-scan\/install-hook\.mjs\n/);
  assert.match(content, /scripts\/sensitive-scan\/commit-msg\.mjs/);
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o111, 0o111);
});

test('reinstalling identical legacy hook is idempotent', t => {
  const { hooks, target, run } = setup(t);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(target);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFileSync(target), original);
  assert.deepEqual(readdirSync(hooks), ['commit-msg']);
});
