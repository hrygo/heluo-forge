/**
 * `NOT_A_REPOSITORY` 的一层子目录探测（UAT-7）。
 *
 * 会话工作目录常常是仓库的父目录（例如 `~/work/` 底下才是 `proj/`）：只报"不是仓库"会让
 * 调用方以为目录选错了，而盲目把子目录当仓库根又会误导。本文件只证这一层提示的边界：
 * 1. 命中一层直接子目录仓库时，提示**相对目录名 + 7 位 HEAD**，不回显绝对路径与 stderr；
 * 2. 找不到时保持原文案，探测失败绝不把确定失败（failed）变成不确定（unknown）；
 * 3. 探测本身受约束：固定 argv、候选上限、跳过 `.` 开头与依赖/产物目录、不跟随软链目录；
 * 4. 只认"子目录自己就是仓库根"，上层仓库或别处的 toplevel 不算命中。
 *
 * 全部离线：目录结构用 `mkdtempSync` 造，`git` 出口用固定执行器替换。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  SNAPSHOT_REASONS,
  createGiteeSnapshotReader,
} from '../src/gitee-snapshot.mjs';

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const SHORT_HEAD = COMMIT.slice(0, 7);
const NOT_A_REPOSITORY_TEXT = '确认本次会话的工作目录确实是目标仓库（或它的 linked worktree）后重试。';
const FATAL_NOT_REPO = 'fatal: not a git repository (or any of the parent directories): .git';

/** 命令结果（`gitee-cli.runGit` 的同形状）。 */
function outcome(overrides = {}) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

const notARepo = () => outcome({ exitCode: 128, stderr: FATAL_NOT_REPO });

/** 记录调用并按处理器作答的固定执行器。 */
function fixedRunner(handler) {
  const calls = [];
  return {
    calls,
    async runGit(invocation) {
      calls.push({ args: [...invocation.args], purpose: invocation.purpose, cwd: invocation.cwd });
      return handler(invocation, calls.length);
    },
  };
}

/** `rev-parse --show-toplevel` / `rev-parse HEAD` 两类探测调用的判别。 */
const isTopLevel = (args) => args[0] === 'rev-parse' && args[1] === '--show-toplevel';
const isHead = (args) => args[0] === 'rev-parse' && args[1] === 'HEAD';

function tempDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-snapshot-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function readOnce(runner, cwd) {
  const reader = createGiteeSnapshotReader({ runner, samples: 1 });
  return reader.read(cwd);
}

test('NOT_A_REPOSITORY + 一层子目录是仓库根：提示相对目录名与 7 位 HEAD，status/reason 不变', async (t) => {
  const root = tempDir(t);
  const child = join(root, 'repo');
  mkdirSync(child);

  const runner = fixedRunner(({ args, cwd }) => {
    if (isTopLevel(args)) return cwd === child ? outcome({ stdout: `${child}\n` }) : notARepo();
    if (isHead(args)) return cwd === child ? outcome({ stdout: `${COMMIT}\n` }) : notARepo();
    return notARepo();
  });
  const result = await readOnce(runner, root);

  assert.equal(result.status, 'failed', '探测只补提示：确定失败仍是 failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY, '探测不得改写失败原因');
  assert.match(result.message, /子目录 repo\/ 是仓库根/u);
  assert.match(result.message, new RegExp(`HEAD=${SHORT_HEAD}`, 'u'));
  assert.ok(result.message.includes('不生成代码版本'));
  assert.match(result.next, /把会话工作目录切到 repo\/ 后重试/u);
  assert.equal(Number.isInteger(result.observedAt), true, '失败结果仍标注观测时间');

  // 边界：只回显相对目录名，不泄露绝对路径与 git stderr 原文。
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(root), '结果不得包含工作目录绝对路径');
  assert.doesNotMatch(result.message, /fatal:/u);
  assert.doesNotMatch(result.next, /fatal:/u);
  assert.equal('stderr' in result, false, '失败信封不携带 stderr 原文');

  // 探测 argv 固定：只有两条 rev-parse 只读命令。
  const probeCalls = runner.calls.filter((call) => call.purpose.startsWith('git.snapshot.probe-'));
  assert.deepEqual(probeCalls.map((call) => call.purpose), [
    'git.snapshot.probe-top-level',
    'git.snapshot.probe-head',
  ]);
  assert.deepEqual(probeCalls[0].args, ['rev-parse', '--show-toplevel']);
  assert.deepEqual(probeCalls[1].args, ['rev-parse', 'HEAD']);
});

test('找不到子目录仓库：保持原文案，且不把 failed 变成 unknown', async (t) => {
  const root = tempDir(t);
  for (const name of ['src', '.cache', 'node_modules']) mkdirSync(join(root, name));

  const runner = fixedRunner(() => notARepo());
  const result = await readOnce(runner, root);

  assert.equal(result.status, 'failed', '探测失败不得降级成 unknown');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY);
  assert.equal(result.message, NOT_A_REPOSITORY_TEXT, '找不到就保持原文案');
  assert.equal(result.next, NOT_A_REPOSITORY_TEXT);

  // 隐藏目录与依赖/产物目录不参与探测：只有 `src/` 被问了一次。
  const probed = runner.calls.filter((call) => call.purpose === 'git.snapshot.probe-top-level');
  assert.equal(probed.length, 1);
  assert.equal(basename(probed[0].cwd), 'src');
  assert.equal(runner.calls.some((call) => call.purpose === 'git.snapshot.probe-head'), false);
});

test('只认"子目录自己就是仓库根"：上层仓库的 toplevel 不算命中', async (t) => {
  const root = tempDir(t);
  const child = join(root, 'sub');
  mkdirSync(child);

  const runner = fixedRunner(({ args, cwd }) => {
    if (isTopLevel(args)) return cwd === child ? outcome({ stdout: `${root}\n` }) : notARepo();
    if (isHead(args)) return outcome({ stdout: `${COMMIT}\n` });
    return notARepo();
  });
  const result = await readOnce(runner, root);

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY);
  assert.equal(result.message, NOT_A_REPOSITORY_TEXT, 'toplevel 不是子目录本身就不算命中');
  assert.equal(runner.calls.some((call) => call.purpose === 'git.snapshot.probe-head'), false);
});

test('候选数量有上限：第 9 个及之后的子目录不探测', async (t) => {
  const root = tempDir(t);
  for (let index = 1; index <= 10; index += 1) {
    mkdirSync(join(root, `c${String(index).padStart(2, '0')}`));
  }
  const ninth = join(root, 'c09');
  const tenth = join(root, 'c10');

  // 只有第 10 个是仓库：上限 8 意味着它不该被问到。
  const runner = fixedRunner(({ args, cwd }) => {
    if (isTopLevel(args)) {
      return (cwd === ninth || cwd === tenth) ? outcome({ stdout: `${cwd}\n` }) : notARepo();
    }
    if (isHead(args)) return outcome({ stdout: `${COMMIT}\n` });
    return notARepo();
  });
  const result = await readOnce(runner, root);

  assert.equal(result.message, NOT_A_REPOSITORY_TEXT, '超出上限的候选不得被探测');
  const probed = runner.calls.filter((call) => call.purpose === 'git.snapshot.probe-top-level');
  assert.equal(probed.length, 8);
  assert.deepEqual(probed.map((call) => basename(call.cwd)), [
    'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08',
  ]);
});

test('探测的 HEAD 取不到：保持原文案，仍是 failed/NOT_A_REPOSITORY', async (t) => {
  const root = tempDir(t);
  const child = join(root, 'repo');
  mkdirSync(child);

  const runner = fixedRunner(({ args, cwd }) => {
    if (isTopLevel(args)) return cwd === child ? outcome({ stdout: `${child}\n` }) : notARepo();
    if (isHead(args)) return outcome({ exitCode: 128, stderr: 'fatal: bad revision HEAD' });
    return notARepo();
  });
  const result = await readOnce(runner, root);

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY);
  assert.equal(result.message, NOT_A_REPOSITORY_TEXT);
  assert.equal(result.next, NOT_A_REPOSITORY_TEXT);
});

test('探测执行器抛错：保持原文案，不把异常带进结果', async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, 'repo'));

  const runner = fixedRunner(({ args }) => {
    if (isTopLevel(args) && runner.calls.length > 1) throw new Error(`spawn failed at ${root}`);
    return notARepo();
  });
  const result = await readOnce(runner, root);

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY);
  assert.equal(result.message, NOT_A_REPOSITORY_TEXT);
  assert.ok(!JSON.stringify(result).includes(root));
});
