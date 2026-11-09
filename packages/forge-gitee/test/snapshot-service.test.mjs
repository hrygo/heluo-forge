/**
 * 代码版本快照的**装配到工具**全路径（PR #215 复审 P1）。
 *
 * 复审事实：重构把 `runner` 挪进 `buildFaces()` 之后，装配层还在 `apply` 顶部引用它——
 * ReferenceError 被 catch 吃成「读取器未装配」；同时 service 不再提供 `snapshot(cwd)`，
 * 于是 `forge_gitee_delivery_snapshot` 即使拿到可信工作区也恒返回 `GIT_SNAPSHOT_NO_WORKSPACE`。
 *
 * 这里不用替身：真实补丁层 + 真实策略服务 + 真实插件 + 真 git 仓库，只把宿主换成最小 ctx，
 * 工作目录由 `workingDirectory` 服务给出（与线上同一条解析路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { createFakeHost, invokeTool, readPatch } from './helpers/fake-host.mjs';

const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

/** 真仓库：一次提交，afile 已跟踪。git 的全局身份与本机配置不参与（全部走 -c）。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitee-snapshot-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(dir, 'afile.txt'), 'hello\n');
  git('add', 'afile.txt');
  git('-c', 'user.name=QA', '-c', 'user.email=qa', 'commit', '-q', '-m', '初版');
  return { dir, head: git('rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function mountWithRepo(repoDir) {
  const rows = await readPatch(PATCH_FILE);
  const [policyRow, pluginRow] = rows;
  const host = createFakeHost();
  const mountedPolicy = host.mountPolicy({ catalog: policyRow.catalog, audit: policyRow.audit });
  assert.equal(mountedPolicy.ok, true, `策略层挂载失败：${mountedPolicy.error?.message ?? ''}`);
  // 会话工作目录：快照只认这条解析路径，不接受模型传目录。
  host.ctx.provide('workingDirectory', {
    get: (session) => (session === 'qa-session' ? repoDir : undefined),
  });
  const mounted = host.mount(apply, pluginRow.config, pluginRow.name);
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  return { host, service: host.services.get('gitee') };
}

test('装配层提供 service.snapshot(cwd)：不是「服务没有装配读取器」', async () => {
  const repo = makeRepo();
  try {
    const { service } = await mountWithRepo(repo.dir);
    assert.equal(typeof service.snapshot, 'function', 'service 必须暴露 snapshot(cwd) 供快照工具调用');
  } finally {
    repo.cleanup();
  }
});

test('快照工具走真实仓库返回 succeeded，并给出与 HEAD 一致的 commit', async () => {
  const repo = makeRepo();
  try {
    const { host } = await mountWithRepo(repo.dir);
    const { body } = await invokeTool(host, 'forge_gitee_delivery_snapshot', {}, { agent: { session: 'qa-session' } });
    assert.equal(body.status, 'succeeded', `快照应成功，实际：${body.reason ?? body.status}`);
    assert.equal(body.commit, repo.head);
    assert.equal(body.branch, 'main');
    assert.equal(body.dirty, false);
    assert.match(body.contentId, /^[0-9a-f]{64}$/u);
  } finally {
    repo.cleanup();
  }
});

test('拿不到会话工作目录时不猜目录：仍返回 GIT_SNAPSHOT_NO_WORKSPACE', async () => {
  const repo = makeRepo();
  try {
    const { host } = await mountWithRepo(repo.dir);
    const { body } = await invokeTool(host, 'forge_gitee_delivery_snapshot', {}, { agent: { session: 'unknown' } });
    assert.equal(body.status, 'failed');
    assert.equal(body.reason, 'GIT_SNAPSHOT_NO_WORKSPACE');
  } finally {
    repo.cleanup();
  }
});
