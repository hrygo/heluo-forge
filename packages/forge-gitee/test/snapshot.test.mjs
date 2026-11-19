/**
 * 只读代码版本快照（r12 §6.1 / AC-11 / AC-14）。
 *
 * 两个层次分开证：
 * 1. **真实本地 Git**：证明暂存、未暂存、删除、重命名、未跟踪确实进版本，且"同一棵树换提交"
 *    会换 contentId——这是"旧证据不得自动沿用"的机制，不是文案。
 * 2. **固定执行器**：证明 argv 白名单、截断/超时/并发/未支持形态都退成 unknown/failed，
 *    不截掉余项后凑一个"有效版本"；也证明失败面不回显绝对路径与 stderr 原文。
 *
 * 本文件不启动 `git daemon`、不联网、不写仓库之外的东西：临时仓库都在 `mkdtempSync` 下。
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  GITEE_SNAPSHOT_TOOLS,
  SNAPSHOT_REASONS,
  createGiteeSnapshotReader,
  snapshotToolDefinitions,
} from '../src/gitee-snapshot.mjs';
import { GIT_BIN } from '../src/gitee-git.mjs';

const execFileAsync = promisify(execFile);

const GIT_AVAILABLE = (() => {
  try {
    execFileSync(GIT_BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'forge-test',
  GIT_AUTHOR_EMAIL: 'forge-test@localhost',
  GIT_COMMITTER_NAME: 'forge-test',
  GIT_COMMITTER_EMAIL: 'forge-test@localhost',
};

/** 真实执行器：只转发已装配好的 argv（与 `gitee-cli.runGit` 同形状）。 */
function realRunner() {
  const calls = [];
  return {
    calls,
    runGit: async ({ args, cwd, purpose }) => {
      calls.push({ args: [...args], purpose, cwd });
      const started = Date.now();
      try {
        const { stdout, stderr } = await execFileAsync(GIT_BIN, args, {
          cwd,
          env: GIT_ENV,
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started, timedOut: false, truncated: false };
      } catch (error) {
        return {
          exitCode: typeof error.code === 'number' ? error.code : 1,
          stdout: String(error.stdout ?? ''),
          stderr: String(error.stderr ?? ''),
          durationMs: Date.now() - started,
          timedOut: error.killed === true,
          truncated: false,
        };
      }
    },
  };
}

async function git(cwd, ...args) {
  return execFileAsync(GIT_BIN, args, { cwd, env: GIT_ENV, timeout: 30000 });
}

const repos = [];
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-snapshot-'));
  repos.push(dir);
  return dir;
}

async function initRepo({ commit = true } = {}) {
  const dir = makeRepo();
  await git(dir, 'init', '-q');
  // 分支名显式固定：不同 git 版本的默认分支名不同，用例不依赖列表顺序。
  await git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (commit) {
    writeFileSync(join(dir, 'README.md'), '基线\n');
    await git(dir, 'add', 'README.md');
    await git(dir, 'commit', '-q', '-m', '初始提交');
  }
  return dir;
}

/** 固定执行器：按 argv 逐字返回预置输出（不启动任何进程）。 */
function fakeRunner(handler) {
  const calls = [];
  return {
    calls,
    runGit: async ({ args, cwd, purpose }) => {
      calls.push({ args: [...args], purpose, cwd });
      const result = await handler({ args: [...args], key: args.join(' '), index: calls.length, cwd });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        truncated: false,
        ...result,
      };
    },
  };
}

/** 一份形状完整的固定输出（toplevel 用真实临时目录，供 realpathSync 通过）。 */
function fixedOutputs(root, overrides = {}) {
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  return {
    'rev-parse --show-toplevel': `${root}\n`,
    'rev-parse HEAD': `${sha}\n`,
    'rev-parse HEAD^{tree}': `${tree}\n`,
    'branch --show-current': 'main\n',
    'status --porcelain=v1 -z --untracked-files=all': '',
    'ls-files --stage -z': `100644 ${'c'.repeat(40)} 0\tsrc/a.mjs\u0000`,
    'ls-files --others --exclude-standard -z': '',
    'show -s --format=%H%x00%B HEAD': `${sha}\u0000初始提交\n`,
    ...overrides,
  };
}

function fakeReaderFor(root, overrides = {}, extras = {}) {
  const outputs = fixedOutputs(root, overrides);
  const runner = fakeRunner(({ key }) => {
    const value = outputs[key];
    if (value === undefined) return { exitCode: 1, stderr: 'unexpected command' };
    return typeof value === 'function' ? value() : { stdout: value };
  });
  return { reader: createGiteeSnapshotReader({ runner, now: () => 1_700_000_000_000, ...extras }), runner };
}

test.after(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------- 真实本地 Git */

test('AC-11 干净仓库：commit/tree/branch/contentId 齐备，且两次采样一致', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  const runner = realRunner();
  const reader = createGiteeSnapshotReader({ runner, now: () => 1_700_000_000_000 });
  const result = await reader.read(dir);

  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.match(result.tree, /^[0-9a-f]{40}$/u);
  assert.equal(result.branch, 'main');
  assert.equal(result.dirty, false);
  assert.match(result.contentId, /^[0-9a-f]{64}$/u);
  assert.equal(result.commitMessage.trim().split('\n')[0], '初始提交');
  assert.equal(result.samples, 2, '默认前后两次采样');
  assert.equal(result.evidence.length, 8, '8 条固定只读命令都进证据');
  for (const entry of result.evidence) {
    assert.equal(entry.kind, 'local-execution');
    assert.match(entry.command, /^git /u);
  }
  // 失败面与成功面都不回显绝对路径：整份结果里不该出现临时目录。
  assert.equal(JSON.stringify(result).includes(dir), false, '结果里不得出现绝对路径');

  const again = await reader.read(dir);
  assert.equal(again.contentId, result.contentId, '未改动时版本必须一致');
  assert.equal(again.commit, result.commit);
});

test('AC-11 未暂存修改与环境（含权限位）改变 contentId，而 commit 不变', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  writeFileSync(join(dir, 'app.mjs'), 'export const a = 1;\n');
  await git(dir, 'add', 'app.mjs');
  await git(dir, 'commit', '-q', '-m', '加上 app');
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const clean = await reader.read(dir);
  assert.equal(clean.status, 'succeeded', JSON.stringify(clean));

  writeFileSync(join(dir, 'app.mjs'), 'export const a = 2;\n');
  const dirty = await reader.read(dir);
  assert.equal(dirty.status, 'succeeded', JSON.stringify(dirty));
  assert.equal(dirty.commit, clean.commit, '未提交的修改不改变 HEAD');
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.contentId, clean.contentId, '未暂存修改必须进版本');

  // 内容相同但权限位不同：git 记录的是 100644/100755，权限变化同样是版本变化。
  chmodSync(join(dir, 'app.mjs'), 0o755);
  const executable = await reader.read(dir);
  assert.equal(executable.status, 'succeeded', JSON.stringify(executable));
  assert.notEqual(executable.contentId, dirty.contentId, '模式变化必须进版本');
});

test('AC-11 暂存未提交、未跟踪、删除三种形态分别改变 contentId', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const clean = await reader.read(dir);
  assert.equal(clean.dirty, false);

  // 暂存未提交。
  writeFileSync(join(dir, 'staged.mjs'), 'export const s = 1;\n');
  await git(dir, 'add', 'staged.mjs');
  const staged = await reader.read(dir);
  assert.equal(staged.dirty, true);
  assert.notEqual(staged.contentId, clean.contentId, '暂存内容必须进版本');

  // 未跟踪：与已暂存内容不同，版本必须再变。
  writeFileSync(join(dir, 'untracked.mjs'), 'export const u = 1;\n');
  const untracked = await reader.read(dir);
  assert.notEqual(untracked.contentId, staged.contentId, '未跟踪文件必须进版本');

  // 删除：把已提交的 README 从工作树删掉。
  unlinkSync(join(dir, 'README.md'));
  const deleted = await reader.read(dir);
  assert.notEqual(deleted.contentId, untracked.contentId, '删除必须进版本');
  assert.equal(deleted.commit, clean.commit, '删除未提交时 HEAD 不动');
});

test('AC-14 同一棵树换提交：contentId 必须变（切提交不自动沿用旧证据）', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const first = await reader.read(dir);
  await git(dir, 'commit', '-q', '--allow-empty', '-m', '空提交');
  const second = await reader.read(dir);
  assert.equal(first.tree, second.tree, '前提：两次是同一棵树');
  assert.notEqual(first.commit, second.commit);
  assert.notEqual(first.contentId, second.contentId, 'HEAD 是版本的一部分：同树不同提交也不能复用旧证据');
});

test('AC-11 未提交的空仓库：failed/EMPTY_HEAD，不编 SHA', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo({ commit: false });
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const result = await reader.read(dir);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.EMPTY_HEAD);
  assert.equal(result.commit, undefined);
  assert.equal(typeof result.next, 'string');
});

test('AC-11 分离 HEAD：branch 为 null 但仍是有效版本', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  const { stdout } = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'checkout', '-q', '--detach', stdout.trim());
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const result = await reader.read(dir);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.branch, null);
  assert.equal(result.commit, stdout.trim());
});

test('AC-11 仓库内软链进版本，越界软链整份 unknown/failed 而不是"少一项也算版本"', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  symlinkSync('README.md', join(dir, 'inside-link'));
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const inside = await reader.read(dir);
  assert.equal(inside.status, 'succeeded', JSON.stringify(inside));
  assert.equal(inside.dirty, true, '未跟踪的软链也是工作树内容');

  symlinkSync('/etc/hostname', join(dir, 'outside-link'));
  const outside = await reader.read(dir);
  assert.notEqual(outside.status, 'succeeded', '越界软链不得产出有效版本');
  assert.equal(outside.reason, SNAPSHOT_REASONS.UNSUPPORTED_ENTRY);
});

test('AC-11 非仓库目录：failed/NOT_A_REPOSITORY，不回显路径与 stderr 原文', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = makeRepo();
  const reader = createGiteeSnapshotReader({ runner: realRunner() });
  const result = await reader.read(dir);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.NOT_A_REPOSITORY);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(dir), false, '失败面不得回显绝对路径');
  assert.equal(/fatal:/u.test(serialized), false, '不得直传 stderr 原文');
});

/* --------------------------------------------------------- 固定执行器 */

test('§6.1 argv 白名单：只发 8 条固定只读命令，没有任何写命令或通用入口', { skip: GIT_AVAILABLE ? false : 'git 不可用' }, async () => {
  const dir = await initRepo();
  const runner = realRunner();
  const reader = createGiteeSnapshotReader({ runner });
  await reader.read(dir);

  const allowed = new Set([
    'rev-parse --show-toplevel',
    'rev-parse HEAD',
    'rev-parse HEAD^{tree}',
    'branch --show-current',
    'status --porcelain=v1 -z --untracked-files=all',
    'ls-files --stage -z',
    'ls-files --others --exclude-standard -z',
    'show -s --format=%H%x00%B HEAD',
  ]);
  assert.equal(runner.calls.length, 16, '两次采样 × 8 条命令');
  for (const call of runner.calls) {
    assert.equal(allowed.has(call.args.join(' ')), true, `出现了未声明的 git 命令：${call.args.join(' ')}`);
    assert.equal(call.args.some((arg) => ['write-tree', 'update-index', 'add', 'commit', 'push', 'stash', 'checkout'].includes(arg)), false);
    assert.equal(typeof call.cwd, 'string');
  }
});

test('§6.1 拿不到可信调用根：failed/NO_WORKSPACE 且零子进程', async () => {
  const runner = fakeRunner(() => ({ stdout: '' }));
  const reader = createGiteeSnapshotReader({ runner });
  for (const cwd of [undefined, null, '', '   ']) {
    const result = await reader.read(cwd);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, SNAPSHOT_REASONS.NO_WORKSPACE);
  }
  assert.equal(runner.calls.length, 0, '没有可信根就一次子进程都不起');
});

test('§6.1 截断与超时：unknown，不截掉余项后给有效版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-snapshot-'));
  repos.push(dir);
  for (const [flag, reason] of [['truncated', SNAPSHOT_REASONS.OUTPUT_TRUNCATED], ['timedOut', SNAPSHOT_REASONS.COMMAND_TIMEOUT]]) {
    const runner = fakeRunner(({ key }) => (key === 'status --porcelain=v1 -z --untracked-files=all' ? { [flag]: true, stdout: '' } : { stdout: fixedOutputs(dir)[key] }));
    const result = await createGiteeSnapshotReader({ runner }).read(dir);
    assert.equal(result.status, 'unknown', `${flag} 必须退成 unknown`);
    assert.equal(result.reason, reason);
    assert.equal(result.contentId, undefined);
  }
});

test('§6.1 前后采样不一致：unknown/CONCURRENT_CHANGE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-snapshot-'));
  repos.push(dir);
  const outputs = fixedOutputs(dir);
  let statusCalls = 0;
  // 第二次采样时才出现的文件先落盘：否则失败原因是"文件不存在"，而不是并发变化。
  writeFileSync(join(dir, 'late.mjs'), 'export const late = true;\n');
  const runner = fakeRunner(({ key }) => {
    if (key !== 'status --porcelain=v1 -z --untracked-files=all') return { stdout: outputs[key] };
    statusCalls += 1;
    return { stdout: statusCalls === 1 ? '' : '?? late.mjs\u0000' };
  });
  const result = await createGiteeSnapshotReader({ runner }).read(dir);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, SNAPSHOT_REASONS.CONCURRENT_CHANGE);
  assert.equal(result.contentId, undefined);
});

test('§6.1 未支持形态：gitlink（160000）判 failed 而不是跳过该条后继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-snapshot-'));
  repos.push(dir);
  const runner = fakeRunner(({ key }) => {
    if (key === 'ls-files --stage -z') return { stdout: `160000 ${'d'.repeat(40)} 0\tvendor/sub\u0000` };
    return { stdout: fixedOutputs(dir)[key] };
  });
  const result = await createGiteeSnapshotReader({ runner }).read(dir);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, SNAPSHOT_REASONS.UNSUPPORTED_ENTRY);
});

test('AC-11 工作树内容只做内存散列：内容与路径都不进返回值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-snapshot-'));
  repos.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const token = "not-a-real-secret";\n');
  const outputs = fixedOutputs(dir, { 'ls-files --stage -z': '', 'ls-files --others --exclude-standard -z': 'src/a.mjs\u0000' });
  const runner = fakeRunner(({ key }) => ({ stdout: outputs[key] }));
  const result = await createGiteeSnapshotReader({ runner }).read(dir);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('not-a-real-secret'), false, '文件内容不进返回值');
  assert.equal(serialized.includes('src/a.mjs'), false, '文件路径不进返回值');
  assert.equal(serialized.includes(dir), false, '绝对路径不进返回值');

  // 内容变、路径不变 → contentId 必须变（散列的是内容，不是路径清单）。
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const token = "changed";\n');
  const second = await createGiteeSnapshotReader({ runner }).read(dir);
  assert.notEqual(second.contentId, result.contentId);
});

/* --------------------------------------------------------------- 工具层 */

test('工具层：零参数、目录来自真实调用上下文、不接 cwd/argv/sourceType', async () => {
  const calls = [];
  const service = {
    snapshot: async (cwd) => {
      calls.push(cwd);
      return { status: 'succeeded', contentId: 'x' };
    },
  };
  const definitions = snapshotToolDefinitions(service, async () => '/work/repo');
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, GITEE_SNAPSHOT_TOOLS[0]);
  assert.equal(definitions[0].name, 'forge_gitee_delivery_snapshot');
  assert.deepEqual(definitions[0].parameters.properties, {});
  assert.equal(definitions[0].parameters.additionalProperties, false);
  assert.equal(definitions[0].parameters.required, undefined, '不接受任何模型传入参数');

  const output = await definitions[0].execute({}, { agent: {} });
  assert.deepEqual(calls, ['/work/repo'], '目录由装配层从调用上下文解析');
  assert.equal(JSON.parse(output.content[0].text).status, 'succeeded');
});

test('工具层：解析不到调用根或装配缺失时返回 failed，不猜目录、不崩', async () => {
  const definitions = snapshotToolDefinitions({ snapshot: async () => assert.fail('不该被调用') }, async () => undefined);
  const missing = JSON.parse((await definitions[0].execute({}, {})).content[0].text);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.reason, SNAPSHOT_REASONS.NO_WORKSPACE);

  const throwing = snapshotToolDefinitions({}, async () => {
    throw new Error('no session');
  });
  const noPort = JSON.parse((await throwing[0].execute({}, {})).content[0].text);
  assert.equal(noPort.status, 'failed');
});

test('AC-11 读取器装配守卫：没有 runGit 就拒绝装配', () => {
  assert.throws(() => createGiteeSnapshotReader({}), /runGit/u);
  assert.throws(() => createGiteeSnapshotReader({ runner: { runGit: async () => ({}) }, now: 1 }), /now/u);
});
