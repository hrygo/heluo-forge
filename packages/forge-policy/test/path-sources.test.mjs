import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_PATH_CANDIDATES,
  MAX_PATH_DEPTH,
  MAX_PATH_VALUE_LENGTH,
  PATH_SOURCE_KEYS,
  collectPathCandidates,
  targetAsPath,
} from '../src/path-sources.mjs';

// P3 · 路径候选来源：path/file 键任意深度恒判；target 只在"确实像路径"时判；
// 其余字段（分支、仓库、issue 编号）不按路径判定，避免把业务标识误拒。
test('the source keys and limits are the documented ones', () => {
  assert.deepEqual(PATH_SOURCE_KEYS, ['path', 'file']);
  assert.equal(MAX_PATH_DEPTH, 4);
  assert.equal(MAX_PATH_CANDIDATES, 32);
  assert.equal(MAX_PATH_VALUE_LENGTH, 4_096);
});

test('path and file keys are collected case-insensitively at any depth', () => {
  const collected = collectPathCandidates({
    Path: '/tmp/a/.env',
    FILE: '/tmp/b/c.pem',
    config: { file: '/tmp/c/.npmrc' },
    files: [{ path: '/tmp/d/.netrc' }],
    labels: ['/tmp/e/.key'],
  });
  assert.deepEqual(collected.candidates.map((item) => [item.field, item.value]), [
    ['Path', '/tmp/a/.env'],
    ['FILE', '/tmp/b/c.pem'],
    ['file', '/tmp/c/.npmrc'],
    ['path', '/tmp/d/.netrc'],
  ]);
  assert.equal(collected.truncated, false);
  assert.equal(Object.isFrozen(collected), true);
});

test('business identifiers are not treated as paths', () => {
  const collected = collectPathCandidates({
    branch: 'feature/login',
    repository: 'acme/demo',
    issue: 'I-42',
    title: 'fix: path handling',
  });
  assert.deepEqual(collected.candidates, []);
});

test('target counts only when it is confirmably a path', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-policy-sources-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n');

  assert.equal(targetAsPath('acme/demo!1'), undefined);
  assert.equal(targetAsPath('/tmp/abs.txt'), '/tmp/abs.txt');
  assert.equal(targetAsPath('./relative.txt'), './relative.txt');
  assert.equal(targetAsPath('../up.txt'), '../up.txt');
  assert.equal(targetAsPath('notes.txt', { workspaceRoot: workspace }), 'notes.txt');
  assert.equal(targetAsPath('missing.txt', { workspaceRoot: workspace }), undefined);

  const collected = collectPathCandidates(
    { target: join(workspace, 'notes.txt'), path: join(workspace, '.env') },
    { workspaceRoot: workspace },
  );
  assert.deepEqual(collected.candidates.map((item) => item.field), ['target', 'path']);
});

test('depth is capped: level four is read, level five is not', () => {
  const atLimit = { a: { b: { c: { path: '/tmp/.env' } } } };
  assert.equal(collectPathCandidates(atLimit).candidates.length, 1);
  const tooDeep = { a: { b: { c: { d: { e: { path: '/tmp/.env' } } } } } };
  assert.deepEqual(collectPathCandidates(tooDeep).candidates, []);
});

test('more than the candidate limit is reported as truncated, never sampled', () => {
  const files = Array.from({ length: MAX_PATH_CANDIDATES + 1 }, (_, index) => `/tmp/f-${index}.env`);
  const collected = collectPathCandidates({ file: files });
  assert.equal(collected.candidates.length, MAX_PATH_CANDIDATES);
  assert.equal(collected.truncated, true);
});

test('over-long values are truncated before judging', () => {
  const value = `/tmp/${'x'.repeat(MAX_PATH_VALUE_LENGTH + 10)}.env`;
  const collected = collectPathCandidates({ path: value });
  assert.equal(collected.candidates.length, 1);
  assert.equal(collected.candidates[0].value.length, MAX_PATH_VALUE_LENGTH);
  assert.equal(collected.truncated, false);
});
