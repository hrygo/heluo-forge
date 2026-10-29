/**
 * TK3 适配器与命令面（AC-12 / AC-14 / AC-23）。
 *
 * 这个文件守三件事：
 * 1. **provider 分流是实体表**：字段/命令/参数全部按 Gitee 语义（snake_case）分表，GitHub 字段
 *    （`mergedAt`/`statusCheckRollup`/`isPrivate`…）在本包里请求即失败、返回即降级；
 * 2. **命令面是枚举**：没有的动词不存在，禁项（merge/close/release/workflow/api/auth/config/gist）
 *    连表都进不来；合并、关闭、发版、通用接口调用没有入口；
 * 3. **越界即零子进程**：参数白名单、`--json` 子集、target 形状、必填项都在触碰 runner 之前校验，
 *    套用命令行字符串或 argv 数组一律拒绝（AC-14）。
 *
 * 另外两条静态不变量（AC-12/AC-23）：本模块不 import `gh-adapter`、不出现 `GH_*` 语义常量
 * （`GH_TOKEN` 作为凭据环境变量名是唯一例外），并且 `packages/forge-gitee/src/` 里只有
 * `gitee-cli.mjs` 碰 `node:child_process`——适配器永不自建子进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTER_REASONS,
  GITEE_ARGV_FLAGS,
  GITEE_COMMANDS,
  GITEE_FORBIDDEN_FIELDS,
  GITEE_FORBIDDEN_FLAGS,
  GITEE_FORBIDDEN_VERBS,
  GITEE_ISSUE_FIELDS,
  GITEE_ISSUE_LIST_FIELDS,
  GITEE_JSON_SUBSETS,
  GITEE_LIST_LIMIT,
  GITEE_LOGICAL_NAME,
  GITEE_PR_FIELDS,
  GITEE_PR_LIST_FIELDS,
  GITEE_PROVIDER,
  GITEE_REPO_FIELDS,
  GITEE_REPO_LIST_FIELDS,
  GiteeAdapterError,
  argvFor,
  assertArgv,
  createGiteeAdapter,
} from '../src/gitee-adapter.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const ADAPTER_SRC = path.join(SRC_DIR, 'gitee-adapter.mjs');

/** 令牌与路径都拼出来：仓库检查器禁止源码/夹具出现真实形态的凭据字面量。 */
const TOKEN_NAME = 'GH_TOKEN';
const TOKEN_VALUE = ['gitee', 'pat', 'fixture', 'value'].join('-');
const SECRET_SHAPE = ['ghp', 'fixture', 'token', 'value', 'xyz'].join('_');
const SECRET_ENV = { [TOKEN_NAME]: TOKEN_VALUE };
const EMPTY_ENV = {};
const ABSOLUTE_BIN = ['', 'opt', 'bin', 'gh'].join('/');
const REPO_TARGET = 'corp/repo';
const ISSUE_TARGET = 'corp/repo#7';

/** 假 runner：记录每次调用（只应收到 `{bin,args,purpose}`），返回预设结果。 */
function fakeRunner(handler = () => ({})) {
  const calls = [];
  return {
    calls,
    async run(invocation) {
      calls.push({ ...invocation, args: [...invocation.args] });
      const outcome = handler(invocation) ?? {};
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false, ...outcome };
    },
  };
}

const jsonOut = (payload, extra = {}) => ({ stdout: JSON.stringify(payload), ...extra });

/** 断言某个同步校验失败：错误码 + 零子进程（越界不是"先发出去再问"）。 */
function assertRejected(runner, run, code) {
  let caught = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, `期望抛出 ${code}`);
  assert.ok(caught instanceof GiteeAdapterError, `期望 GiteeAdapterError，实际 ${caught?.name}`);
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught?.code}（${caught?.message}）`);
  assert.equal(caught.provider, GITEE_PROVIDER);
  assert.equal(runner.calls.length, 0, '校验失败必须零子进程');
  return caught;
}

/** 断言异步调用失败（此时允许已发命令，用于超时/退出码一类"事实"失败）。 */
async function assertRejectedAsync(run, code) {
  let caught = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, `期望抛出 ${code}`);
  assert.ok(caught instanceof GiteeAdapterError, `期望 GiteeAdapterError，实际 ${caught?.name}`);
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught?.code}（${caught?.message}）`);
  return caught;
}

test('provider 常量与命令面是 Gitee 语义的枚举（AC-12）', () => {
  assert.equal(GITEE_PROVIDER, 'gitee');
  assert.equal(GITEE_LOGICAL_NAME, 'gitee');
  assert.equal(GITEE_LIST_LIMIT, 100);

  const commands = Object.keys(GITEE_COMMANDS);
  assert.deepEqual(commands.sort(), [
    'issueComment',
    'issueCreate',
    'issueList',
    'issueView',
    'prComment',
    'prCreate',
    'prList',
    'prView',
    'repositoryList',
    'repositoryView',
  ]);
  assert.deepEqual(GITEE_COMMANDS.repositoryView, ['repo', 'view']);
  assert.deepEqual(GITEE_COMMANDS.repositoryList, ['repo', 'list']);
  assert.deepEqual(GITEE_COMMANDS.issueCreate, ['issue', 'create']);
  assert.deepEqual(GITEE_COMMANDS.prComment, ['pr', 'comment']);

  // 禁项连表都进不来：任何命令的动词前缀都不等于禁项的动词前缀。
  const lines = commands.map((command) => GITEE_COMMANDS[command].join(' '));
  for (const forbidden of GITEE_FORBIDDEN_VERBS) {
    const word = forbidden.join(' ');
    assert.ok(!lines.includes(word), `命令面不得含禁项 ${word}`);
  }
  const verbs = new Set(Object.values(GITEE_COMMANDS).map((words) => words[0]));
  for (const banned of ['release', 'workflow', 'api', 'auth', 'config', 'gist']) {
    assert.ok(!verbs.has(banned), `命令面不得含 ${banned}`);
  }

  // 每条命令都有 argv 参数表；表里只允许声明过的旗标。
  for (const command of commands) {
    assert.ok(Array.isArray(GITEE_ARGV_FLAGS[command]), `${command} 缺 argv 参数表`);
    for (const flag of GITEE_ARGV_FLAGS[command]) {
      assert.ok(flag.startsWith('-'), `${command} 的 ${flag} 不是旗标`);
      assert.ok(!GITEE_FORBIDDEN_FLAGS.includes(flag), `${command} 的 ${flag} 属禁项`);
    }
  }
});

test('字段表逐字为 Gitee snake_case，且 GitHub 字段不在任何表里（AC-12）', () => {
  assert.deepEqual([...GITEE_REPO_FIELDS], ['name', 'path', 'description', 'url', 'default_branch', 'private', 'updated_at']);
  assert.deepEqual([...GITEE_REPO_LIST_FIELDS], ['name', 'path', 'url', 'private', 'updated_at']);
  assert.deepEqual([...GITEE_ISSUE_FIELDS], ['number', 'title', 'state', 'url', 'updated_at', 'labels', 'comments']);
  assert.deepEqual([...GITEE_ISSUE_LIST_FIELDS], ['number', 'title', 'url', 'state']);
  assert.deepEqual([...GITEE_PR_FIELDS], ['number', 'title', 'state', 'url', 'updated_at', 'head', 'base', 'draft', 'mergeable', 'comments']);
  assert.deepEqual([...GITEE_PR_LIST_FIELDS], ['number', 'title', 'url', 'head', 'state']);
  assert.deepEqual([...GITEE_FORBIDDEN_FIELDS], ['mergedAt', 'merged_at', 'statusCheckRollup', 'checks', 'reviewDecision', 'autoMergeRequest']);

  const all = [GITEE_REPO_FIELDS, GITEE_REPO_LIST_FIELDS, GITEE_ISSUE_FIELDS, GITEE_ISSUE_LIST_FIELDS, GITEE_PR_FIELDS, GITEE_PR_LIST_FIELDS];
  const declared = new Set(all.flat());
  for (const forbidden of GITEE_FORBIDDEN_FIELDS) {
    assert.ok(!declared.has(forbidden), `禁用字段 ${forbidden} 不得出现在 GITEE_* 表里`);
  }
  for (const githubOnly of ['nameWithOwner', 'isPrivate', 'defaultBranchRef', 'updatedAt', 'mergeableState', 'statusCheckRollup']) {
    assert.ok(!declared.has(githubOnly), `Gitee 表不得含 GitHub 字段 ${githubOnly}`);
  }
  // 表里全部是 snake_case/小写标识（Gitee 语义），没有 camelCase 混入。
  for (const field of declared) {
    assert.match(field, /^[a-z][a-z_]*$/, `字段 ${field} 不是 Gitee 语义命名`);
  }
});

test('--json 子集与字段表同源（同一对象，不存在两处漂移）', () => {
  assert.equal(GITEE_JSON_SUBSETS.repositoryView, GITEE_REPO_FIELDS);
  assert.equal(GITEE_JSON_SUBSETS.repositoryList, GITEE_REPO_LIST_FIELDS);
  assert.equal(GITEE_JSON_SUBSETS.issueView, GITEE_ISSUE_FIELDS);
  assert.equal(GITEE_JSON_SUBSETS.issueList, GITEE_ISSUE_LIST_FIELDS);
  assert.equal(GITEE_JSON_SUBSETS.prView, GITEE_PR_FIELDS);
  assert.equal(GITEE_JSON_SUBSETS.prList, GITEE_PR_LIST_FIELDS);
  // 写命令没有 --json：输出是人类文本，改由解析器取编号/链接。
  for (const writeCommand of ['issueCreate', 'issueComment', 'prCreate', 'prComment']) {
    assert.equal(GITEE_JSON_SUBSETS[writeCommand], undefined);
  }
});

test('argv 形状固定：位置参数与 -R 的分工逐条钉住（AC-14）', () => {
  assert.deepEqual(argvFor('repositoryView', { target: REPO_TARGET }), ['repo', 'view', REPO_TARGET]);
  assert.deepEqual(argvFor('repositoryView', { target: REPO_TARGET, json: ['name', 'url'] }), [
    'repo', 'view', REPO_TARGET, '--json', 'name,url',
  ]);
  assert.deepEqual(argvFor('repositoryList', { target: REPO_TARGET }), ['repo', 'list', REPO_TARGET]);
  assert.deepEqual(argvFor('issueView', { target: ISSUE_TARGET }), ['issue', 'view', ISSUE_TARGET]);
  // argvFor 只拼调用方给的参数（`--json` 缺省由 read() 注入字段表，见只读归一用例）。
  assert.deepEqual(argvFor('issueList', { target: REPO_TARGET, state: 'open', limit: 20 }), [
    'issue', 'list', '-R', REPO_TARGET,
    '--state', 'open',
    '--limit', '20',
  ]);
  assert.deepEqual(argvFor('issueCreate', { target: REPO_TARGET, title: '标题', body: '正文' }), [
    'issue', 'create', '-R', REPO_TARGET, '--title', '标题', '--body', '正文',
  ]);
  assert.deepEqual(argvFor('issueComment', { target: ISSUE_TARGET, body: '评论' }), [
    'issue', 'comment', ISSUE_TARGET, '--body', '评论',
  ]);
  assert.deepEqual(argvFor('prCreate', {
    target: REPO_TARGET, title: 't', body: 'b', head: 'feat/x', base: 'main', draft: true,
  }), ['pr', 'create', '-R', REPO_TARGET, '--title', 't', '--body', 'b', '--head', 'feat/x', '--base', 'main', '--draft']);
  // draft=false 不出现 --draft（开关参数只在为真时入列）。
  assert.ok(!argvFor('prCreate', {
    target: REPO_TARGET, title: 't', body: 'b', head: 'feat/x', base: 'main', draft: false,
  }).includes('--draft'));

  const plan = assertArgv('prView', { target: ISSUE_TARGET });
  assert.equal(plan.command, 'prView');
  assert.deepEqual([...plan.words], ['pr', 'view']);
  assert.equal(plan.target, ISSUE_TARGET);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.args));
});

test('命令面拒绝未枚举动词与套字符串/数组写法（AC-14/AC-23）', () => {
  const runner = fakeRunner();
  // 未知命令：连 "pr merge"/"issue close" 这类禁项都只会得到 UNKNOWN_COMMAND。
  for (const command of ['prMerge', 'pr merge', 'issue close', 'release create', 'api', 'workflow run', 'gist create', '']) {
    assertRejected(runner, () => assertArgv(command, { target: REPO_TARGET }), ADAPTER_REASONS.UNKNOWN_COMMAND);
  }
  // 参数不是键值对象（命令行字符串 / argv 数组）一律拒绝。
  assertRejected(runner, () => assertArgv('issueList', 'issue list -R corp/repo'), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', ['issue', 'list']), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueView', null), ADAPTER_REASONS.ARG_INVALID);
});

test('参数白名单：未声明键、状态值、上限、必填项都在起进程前拒绝（AC-14）', () => {
  const runner = fakeRunner();
  // 未声明的键（含 CLI 的危险旗标名）→ ARG_NOT_WHITELISTED。
  for (const extra of [
    { web: true }, { template: '{{.}}' }, { rawField: 'a=b' }, { field: 'x' },
    { method: 'DELETE' }, { admin: true }, { paginate: true }, { merge: true }, { args: ['--json', 'x'] },
    { bin: 'git' }, { exec: 'rm -rf /' },
  ]) {
    assertRejected(runner, () => assertArgv('issueView', { target: ISSUE_TARGET, ...extra }), ADAPTER_REASONS.ARG_NOT_WHITELISTED);
  }
  // state/limit 只对清单动作存在，且值域固定。
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, state: 'ALL' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, state: 'merged' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, limit: 0 }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, limit: GITEE_LIST_LIMIT + 1 }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, limit: 1.5 }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, limit: 'many' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, limit: '--state' }), ADAPTER_REASONS.ARG_INVALID);
  assert.equal(argvFor('issueList', { target: REPO_TARGET, limit: GITEE_LIST_LIMIT }).includes('100'), true);
  assert.equal(argvFor('issueList', { target: REPO_TARGET, limit: '7' }).includes('7'), true);
  // 必填项缺失。
  assertRejected(runner, () => assertArgv('issueCreate', { target: REPO_TARGET, title: 't' }), ADAPTER_REASONS.ARG_MISSING);
  assertRejected(runner, () => assertArgv('prCreate', { target: REPO_TARGET, title: 't', body: 'b' }), ADAPTER_REASONS.ARG_MISSING);
  assertRejected(runner, () => assertArgv('issueComment', { target: ISSUE_TARGET }), ADAPTER_REASONS.ARG_MISSING);
  // target 形状：空、越界、带旗标注入。
  assertRejected(runner, () => assertArgv('issueView', {}), ADAPTER_REASONS.MISSING_TARGET);
  assertRejected(runner, () => assertArgv('issueView', { target: '  ' }), ADAPTER_REASONS.MISSING_TARGET);
  for (const target of ['corp', 'corp/repo --web', '-R', 'corp/repo#abc', 'corp/repo;rm']) {
    assertRejected(runner, () => assertArgv('issueView', { target }), ADAPTER_REASONS.ARG_INVALID);
  }
  // 文本参数不能以 - 开头（防参数注入），标题/正文都必须是字符串。
  assertRejected(runner, () => assertArgv('issueCreate', { target: REPO_TARGET, title: '-R', body: 'b' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueCreate', { target: REPO_TARGET, title: 't', body: '-f x' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueCreate', { target: REPO_TARGET, title: 42, body: 'b' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('prCreate', {
    target: REPO_TARGET, title: 't', body: 'b', head: '-x', base: 'main',
  }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('prCreate', {
    target: REPO_TARGET, title: 't', body: 'b', head: 'feat/x', base: 'main', draft: 'yes',
  }), ADAPTER_REASONS.ARG_INVALID);
});

test('--json 只接受声明的子集，GitHub 语义字段请求即失败（AC-12/AC-14）', () => {
  const runner = fakeRunner();
  // 未声明字段。
  assertRejected(runner, () => assertArgv('issueView', { target: ISSUE_TARGET, json: ['number', 'body'] }), ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED);
  // GitHub 语义字段即使在别的 provider 的字段表里"存在"，这里也不认。
  for (const forbidden of GITEE_FORBIDDEN_FIELDS) {
    assertRejected(
      runner,
      () => assertArgv('prView', { target: ISSUE_TARGET, json: ['number', forbidden] }),
      ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED,
    );
  }
  // 写命令没有 --json 通道。
  assertRejected(
    runner,
    () => assertArgv('issueCreate', { target: REPO_TARGET, title: 't', body: 'b', json: ['number'] }),
    ADAPTER_REASONS.ARG_NOT_WHITELISTED,
  );
  // 空请求视为非法（不静默退化成人类文本解析）。
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, json: [] }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => assertArgv('issueList', { target: REPO_TARGET, json: ' , ' }), ADAPTER_REASONS.ARG_INVALID);
  // 逗号字符串写法可用，且去重保序。
  assert.deepEqual(argvFor('issueList', { target: REPO_TARGET, json: 'title,number,title' }), [
    'issue', 'list', '-R', REPO_TARGET, '--json', 'title,number',
  ]);
});

test('runner 只收到 {bin,args,purpose}，命令面不含写后合并/关闭通道（AC-23）', async () => {
  const runner = fakeRunner(() => jsonOut({ number: 1, title: 't', state: 'open', url: 'https://gitee.example/corp/repo/issues/1', updated_at: '2026-10-29T00:00:00Z', labels: [], comments: 0 }));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  await adapter.invoke('issueView', { target: ISSUE_TARGET, json: GITEE_ISSUE_FIELDS }, 'gitee.issue.read');
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.deepEqual(Object.keys(call).sort(), ['args', 'bin', 'purpose']);
  assert.equal(call.bin, 'gh');
  assert.equal(call.purpose, 'gitee.issue.read');
  assert.deepEqual(call.args, ['issue', 'view', ISSUE_TARGET, '--json', GITEE_ISSUE_FIELDS.join(',')]);
  for (const arg of call.args) assert.equal(typeof arg, 'string');
  assert.ok(!call.args.some((arg) => arg.includes(TOKEN_VALUE)), '凭据永不进 argv');
});

test('只读归一：事实版本缺失即 unknown，混入 GitHub 字段即 unknown（AC-12）', async () => {
  const base = { number: 7, title: '修复', state: 'open', url: 'https://gitee.example/corp/repo/issues/7', updated_at: '2026-10-29T01:02:03Z', labels: [], comments: 2 };

  const happyRunner = fakeRunner(() => jsonOut(base));
  const happy = createGiteeAdapter({ runner: happyRunner, env: SECRET_ENV });
  const okResult = await happy.read('gitee.issue.read', ISSUE_TARGET, {});
  assert.equal(okResult.status, 'succeeded');
  assert.equal(okResult.source_revision, '2026-10-29T01:02:03Z');
  assert.deepEqual([...okResult.result_refs], [base.url]);
  assert.deepEqual([...okResult.missing_fields], []);
  assert.deepEqual(okResult.object, base);
  assert.equal(okResult.provider, 'gitee');
  assert.equal(okResult.action, 'gitee.issue.read');

  // 缺 updated_at：不给"编出来的版本号"，整条降级 unknown。
  const noRevision = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut({ ...base, updated_at: undefined })),
    env: SECRET_ENV,
  });
  const degraded = await noRevision.read('gitee.issue.read', ISSUE_TARGET, {});
  assert.equal(degraded.status, 'unknown');
  assert.equal(degraded.error_code, ADAPTER_REASONS.MISSING_SOURCE_REVISION);
  assert.equal(degraded.source_revision, null);
  assert.ok(degraded.missing_fields.includes('updated_at'));
  assert.equal(degraded.object.updated_at, null);

  // GitHub 语义字段混入：不接受"顺手推断"，整条 unknown。
  const mixed = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut({ ...base, mergedAt: '2026-10-29T02:00:00Z' })),
    env: SECRET_ENV,
  });
  const mixedResult = await mixed.read('gitee.pr.read', ISSUE_TARGET, {});
  assert.equal(mixedResult.status, 'unknown');
  assert.equal(mixedResult.error_code, ADAPTER_REASONS.MIXED_PROVIDER_FIELDS);
  assert.equal(mixedResult.rejected_field, 'mergedAt');
  assert.ok(!('mergedAt' in mixedResult.object));

  const checks = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut({ ...base, head: { ref: 'feat/x', statusCheckRollup: ['ci'] } })),
    env: SECRET_ENV,
  });
  const nested = await checks.read('gitee.pr.read', ISSUE_TARGET, {});
  assert.equal(nested.error_code, ADAPTER_REASONS.MIXED_PROVIDER_FIELDS);
  assert.equal(nested.rejected_field, 'statusCheckRollup');
});

test('清单只读：默认 --state open 与 --limit 100，数组归一为字段表（AC-12/AC-14）', async () => {
  const items = [
    { number: 1, title: 'a', state: 'open', url: 'https://gitee.example/c/r/issues/1', body: '不该出现', labels: ['x'] },
    { number: 2, title: 'b', state: 'open', url: 'https://gitee.example/c/r/issues/2' },
  ];
  const runner = fakeRunner(() => jsonOut(items));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const listed = await adapter.read('gitee.issue.read', REPO_TARGET, { list: true });
  assert.equal(listed.status, 'succeeded');
  assert.equal(listed.count, 2);
  assert.equal(listed.kind, 'list');
  assert.equal(listed.source_revision, null);
  assert.deepEqual(Object.keys(listed.items[0]), [...GITEE_ISSUE_LIST_FIELDS]);
  assert.ok(!('body' in listed.items[0]));
  // 默认参数逐字进 argv：状态 open、上限 100、--json 为字段表。
  assert.deepEqual(runner.calls[0].args, [
    'issue', 'list', '-R', REPO_TARGET,
    '--json', GITEE_ISSUE_LIST_FIELDS.join(','),
    '--state', 'open',
    '--limit', '100',
  ]);

  // 显式 state/limit 覆盖默认；仓库清单没有状态维度。
  await adapter.read('gitee.pr.read', REPO_TARGET, { list: true, state: 'all', limit: 5 });
  assert.deepEqual(runner.calls[1].args, [
    'pr', 'list', '-R', REPO_TARGET,
    '--json', GITEE_PR_LIST_FIELDS.join(','),
    '--state', 'all',
    '--limit', '5',
  ]);
});

test('只读参数面：未知动作、越界键、字符串写法、仓库清单带 state 都拒绝（AC-14）', async () => {
  const runner = fakeRunner(() => jsonOut([]));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  await assertRejectedAsync(() => adapter.read('gitee.repo.read', REPO_TARGET, {}), ADAPTER_REASONS.UNKNOWN_READ_ACTION);
  await assertRejectedAsync(() => adapter.read('gitee.issue.write', REPO_TARGET, {}), ADAPTER_REASONS.UNKNOWN_READ_ACTION);
  await assertRejectedAsync(() => adapter.read('issue.read', REPO_TARGET, { shell: true }), ADAPTER_REASONS.ARG_NOT_WHITELISTED);
  await assertRejectedAsync(() => adapter.read('issue.read', REPO_TARGET, { list: 'yes' }), ADAPTER_REASONS.ARG_INVALID);
  await assertRejectedAsync(() => adapter.read('issue.read', REPO_TARGET, 'issue view corp/repo#7'), ADAPTER_REASONS.ARG_INVALID);
  await assertRejectedAsync(() => adapter.read('issue.read', REPO_TARGET, { state: 'open' }), ADAPTER_REASONS.ARG_NOT_WHITELISTED);
  await assertRejectedAsync(
    () => adapter.read('gitee.repository.read', REPO_TARGET, { list: true, state: 'open' }),
    ADAPTER_REASONS.ARG_NOT_WHITELISTED,
  );
  await assertRejectedAsync(
    () => adapter.read('gitee.issue.read', REPO_TARGET, { list: true, json: ['mergedAt'] }),
    ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED,
  );
  assert.equal(runner.calls.length, 0, '全部为校验失败，零子进程');
});

test('命令结果翻译：超时/非零退出/字段不支持/起不来/畸形 JSON 各有固定 reason（§8.3）', async () => {
  const timedOut = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
    env: SECRET_ENV,
  });
  const timeoutError = await assertRejectedAsync(() => timedOut.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.TIMEOUT);
  assert.equal(timeoutError.detail.mayHaveSideEffect, true, '超时意味着远端可能已生效：必须回读不得重放');

  const nonzero = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 4, stdout: '', stderr: 'HTTP 404' })),
    env: SECRET_ENV,
  });
  await assertRejectedAsync(() => nonzero.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.NONZERO_EXIT);

  const unsupported = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'unknown field "comments" in --json' })),
    env: SECRET_ENV,
  });
  await assertRejectedAsync(() => unsupported.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.UNSUPPORTED_FIELD);

  const unsupportedJson = createGiteeAdapter({
    runner: fakeRunner(() => ({ stdout: 'not json' })),
    env: SECRET_ENV,
  });
  await assertRejectedAsync(() => unsupportedJson.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.MALFORMED_RESULT);

  const wrongShape = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut(['unexpected'])  ),
    env: SECRET_ENV,
  });
  await assertRejectedAsync(() => wrongShape.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.MALFORMED_RESULT);

  const noOutcome = createGiteeAdapter({ runner: { async run() { return null; } }, env: SECRET_ENV });
  await assertRejectedAsync(() => noOutcome.invoke('issueView', { target: ISSUE_TARGET }), ADAPTER_REASONS.MALFORMED_RESULT);
});

test('失败信息脱敏：stderr 里的令牌不回到消息与 detail（AC-22）', async () => {
  const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: `auth failed for ${TOKEN_VALUE} / ${SECRET_SHAPE}` }));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const error = await assertRejectedAsync(() => adapter.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.NONZERO_EXIT);
  assert.ok(!error.message.includes(TOKEN_VALUE), '消息不得含令牌');
  assert.ok(!error.message.includes(SECRET_SHAPE), '消息不得含令牌');
  assert.ok(error.message.includes('[REDACTED]'), '应显式标注脱敏位置');
  assert.ok(!JSON.stringify(error.detail).includes(TOKEN_VALUE));
});

test('preflight 返回原因码而不抛错：缺令牌/持久令牌都零子进程（AC-22）', () => {
  const runner = fakeRunner();
  const missing = createGiteeAdapter({ runner, env: EMPTY_ENV });
  const missingResult = missing.preflight();
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, ADAPTER_REASONS.AUTH_MISSING);
  assert.equal(missingResult.tokenSource, 'none');
  assert.equal(missingResult.provider, 'gitee');
  assert.equal(missingResult.mayHaveSideEffect, false);
  assert.ok(!JSON.stringify(missingResult).includes(TOKEN_VALUE));

  const ready = createGiteeAdapter({ runner, env: SECRET_ENV });
  const readyResult = ready.preflight();
  assert.equal(readyResult.ok, true);
  assert.equal(readyResult.reason, null);
  assert.equal(readyResult.tokenSource, 'env');
  assert.deepEqual([...readyResult.authEnv], [TOKEN_NAME]);
  assert.ok(!JSON.stringify(readyResult).includes(TOKEN_VALUE), 'preflight 只报来源不报值');

  const persistent = createGiteeAdapter({ runner, env: SECRET_ENV, persistentTokenProbe: () => true });
  const persistentResult = persistent.preflight();
  assert.equal(persistentResult.ok, false);
  assert.equal(persistentResult.reason, ADAPTER_REASONS.GITEE_PERSISTENT_TOKEN);
  assert.equal(runner.calls.length, 0, 'preflight 永不起子进程');
});

test('describe() 脱敏：报路径种类与命令面，不回显令牌与绝对路径（AC-22）', () => {
  const runner = fakeRunner();
  const adapter = createGiteeAdapter({ runner, cliPath: ABSOLUTE_BIN, env: SECRET_ENV, host: 'gitee.corp.example' });
  const described = adapter.describe();
  const text = JSON.stringify(described);
  assert.equal(described.provider, 'gitee');
  assert.equal(described.cliPathKind, 'absolute');
  assert.equal(described.cliPathName, 'gh');
  assert.ok(!text.includes(ABSOLUTE_BIN), '不导出绝对路径');
  assert.ok(!text.includes(TOKEN_VALUE), '不导出令牌');
  assert.equal(described.tokenSource, 'env');
  assert.equal(described.listLimit, GITEE_LIST_LIMIT);
  assert.equal(described.commands.length, Object.keys(GITEE_COMMANDS).length);
  assert.deepEqual([...described.readActions], ['gitee.repository.read', 'gitee.issue.read', 'gitee.pr.read']);
  assert.equal(described.host, 'gitee.corp.example');

  const nameOnly = createGiteeAdapter({ runner, env: SECRET_ENV }).describe();
  assert.equal(nameOnly.cliPathKind, 'name');
  assert.equal(nameOnly.cliPathName, 'gh');
});

test('静态不变量：零 gh-adapter 导入、零 GH_ 语义常量、唯一 child_process 出口（AC-12/AC-23）', () => {
  const src = readFileSync(ADAPTER_SRC, 'utf8');
  // 包间零源码依赖：不 import devops 的适配器，也不搬它的符号（注释里的"同形不同表"引用不算导入）。
  assert.ok(!/import\s+[^;]*['"][^'"]*gh-adapter[^'"]*['"]/.test(src), '适配器不得 import gh-adapter');
  assert.ok(!/require\(\s*['"][^'"]*gh-adapter/.test(src), '适配器不得 require gh-adapter');
  assert.ok(!/[f]rom\s+['"]?\.\.?\/[^'"]*devops/.test(src), '适配器不得引用 devops 源码');
  assert.ok(!/\bDevopsReadError\b/.test(src), '不得搬用 devops 的错误类型');
  // GH_* 只允许作为凭据/环境变量名出现（企业 CLI 的令牌与主机变量），语义常量一个都不许有。
  const ghIdentifiers = [...src.matchAll(/\bGH_[A-Z0-9_]+\b/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(ghIdentifiers)].sort(), ['GH_HOST', 'GH_TOKEN']);
  for (const semantic of ['GH_COMMANDS', 'GH_FIELDS', 'GH_LIST_LIMIT', 'GH_ARGV_FLAGS', 'GH_PROVIDER']) {
    assert.ok(!src.includes(semantic), `适配器不得含 ${semantic}`);
  }
  // 唯一 execFile 出口：适配器不建子进程、不 import child_process。
  assert.ok(!/node:child_process/.test(src), '适配器不得 import child_process');
  assert.ok(!/\bspawn\w*\s*\(/.test(src), '适配器不得 spawn');
  assert.ok(!/\bexecSync\b|\bexecFileSync\b/.test(src), '适配器不得用同步子进程');

  // 全包静态唯一性：只有 gitee-cli.mjs 碰子进程 API。
  const offenders = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => /from\s+['"]node:child_process['"]|require\(['"]node:child_process['"]\)/.test(
      readFileSync(path.join(SRC_DIR, name), 'utf8'),
    ));
  assert.deepEqual(offenders, ['gitee-cli.mjs'], '子进程出口必须唯一');

  // 禁项清单是"代码里不存在"的证明：写动作只有 create/comment，没有任何 close/merge/release。
  const writeCommands = ['issueCreate', 'issueComment', 'prCreate', 'prComment'];
  assert.equal(writeCommands.length, 4);
  for (const command of Object.keys(GITEE_COMMANDS)) {
    const line = GITEE_COMMANDS[command].join(' ');
    for (const banned of ['merge', 'close', 'delete', 'release', 'workflow', 'api', 'auth', 'config', 'gist']) {
      assert.ok(!line.split(' ').includes(banned), `${command} 不得含 ${banned}`);
    }
  }
  assert.equal(GITEE_FORBIDDEN_FLAGS.length > 0, true);
  assert.ok(GITEE_FORBIDDEN_FLAGS.includes('--web'));
  assert.ok(GITEE_FORBIDDEN_FLAGS.includes('--template'));
  assert.ok(GITEE_FORBIDDEN_FLAGS.includes('-f'));
  assert.ok(GITEE_FORBIDDEN_FLAGS.includes('--raw-field'));
});

test('构造期拒绝不自建子进程：runner 必填且必须是对象（AC-23）', () => {
  assert.throws(() => createGiteeAdapter(), {
    name: 'TypeError',
    message: /runner/,
  });
  assert.throws(() => createGiteeAdapter({ runner: { run: 'nope' } }), {
    name: 'TypeError',
    message: /runner/,
  });
  const runner = fakeRunner();
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  assert.equal(adapter.provider, GITEE_PROVIDER);
  assert.equal(adapter.logicalName, GITEE_LOGICAL_NAME);
  for (const member of ['preflight', 'invoke', 'read', 'describe']) {
    assert.equal(typeof adapter[member], 'function', `缺成员 ${member}`);
  }
  assert.ok(!('run' in adapter) && !('exec' in adapter), '适配器不得暴露通用执行入口');
});
