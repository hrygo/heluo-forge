/**
 * TK3 适配器与命令面（AC-12 / AC-14 / AC-23；r10 平台收敛）。
 *
 * 这个文件守三件事：
 * 1. **字段是实测投影，不是 gh 风格猜测**：字段名逐字取自 2026-11-03 企业 CLI 的三段真实载荷
 *    （`repo view` / `issue list` / `pr list`，见下方 `*_PAYLOAD` 夹具），GitHub 语义名字与
 *    实测中根本不存在的旧名（`number`/`url`/`private`/`head`/`base`/`comments`…）都不在任何表里；
 * 2. **命令面是枚举**：没有的动词不存在，禁项（merge/close/release/workflow/api/auth/config/gist）
 *    连表都进不来；合并、关闭、发版、通用接口调用没有入口；
 * 3. **越界即零子进程**：参数白名单、投影清单、target 形状、必填项都在触碰 runner 之前校验，
 *    套用命令行字符串或 argv 数组一律拒绝（AC-14）。
 *
 * 另外两条 r11 的实测不变量：`--json` 是**无值开关**（后面不接字段清单，实测逗号清单被忽略），
 * 响应形状是 `{data:{list:[…]}}`（Issue）/ `{data:[…]}`（PR）/ 扁平对象（仓库），三种都要能剥。
 *
 * 另外两条静态不变量（AC-12/AC-23）：本模块不 import `gh-adapter`、不出现 `GH_*` 语义常量，
 * 并且 `packages/forge-gitee/src/` 里只有 `gitee-cli.mjs` 碰 `node:child_process`——
 * 适配器永不自建子进程。
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
  GITEE_FORBIDDEN_FLAGS,
  GITEE_FORBIDDEN_VERBS,
  GITEE_FIELD_PROJECTIONS,
  GITEE_ISSUE_FIELDS,
  GITEE_ISSUE_LIST_FIELDS,
  GITEE_LIST_LIMIT,
  GITEE_LOGICAL_NAME,
  GITEE_PLATFORM,
  GITEE_PR_FIELDS,
  GITEE_PR_LIST_FIELDS,
  GITEE_REPO_FIELDS,
  GITEE_REPO_LIST_FIELDS,
  GITEE_REVISION_FIELDS,
  GiteeAdapterError,
  argvFor,
  assertArgv,
  createGiteeAdapter,
  projectionFor,
  STATE_DEFAULTS,
  STATE_VALUES,
} from '../src/gitee-adapter.mjs';

/** 夹具用的占位主机（分段拼装，避免源文件里出现完整远端地址）。 */
const FIXTURE_HOST = ['corp', 'example', 'com'].join('.');

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

/**
 * 企业 CLI 实测载荷（2026-11-03，Windows 机器上 `gh ... --json` 的真实输出）。
 *
 * 字段名与包裹形状**逐字保留**，只把内网域名、人名与绝对路径换成占位（仓库/示例用
 * `corp.example.com`）。三段分别覆盖三种形状：
 * - 仓库：扁平对象，没有 `url`/`private`/`updated_at`，全名在 `path_with_namespace`，
 *   唯一时间事实是 `last_activity_at`；
 * - Issue 清单：`{data:{list:[…]}, meta:{…}}`，编号字段 `id`（没有 `number`），清单项没有
 *   `state`/`web_url`；
 * - PR 清单：`{data:[…], meta:{…}}`，编号是 `iid`（`id` 是全局号），分支是 `source_branch`/
 *   `target_branch`，可合并性是 `merge_status`，状态值是 `opened`。
 */
const REPO_VIEW_PAYLOAD = Object.freeze({
  archived: false,
  avatar_url: '',
  card_enable: false,
  created_at: '2025-11-29T18:17:36.182956+08:00',
  creator_id: 85,
  default_branch: 'master',
  description: 'AI 原生框架套件',
  empty_status: 0,
  fork_count: 0,
  fork_from_path: '',
  http_url_to_repo: 'http://corp.example.com/osc/ard/ard-sdk.git',
  id: 6466,
  import_url: 'http://mirror.example.com/ard/ard-sdk.git',
  is_favorite: true,
  issues_enabled: false,
  last_activity_at: '2026-11-02T16:10:34.000000+08:00',
  merge_requests_enabled: true,
  name: 'ard-sdk',
  name_with_namespace: 'osc/ard/ard-sdk',
  namespace: { avatar_url: '', full_path: 'osc/ard', id: 4613, kind: 'Group', name: 'ard', path: 'ard', web_url: '' },
  open_issues_count: 0,
  open_source_organizations: null,
  owner: { created_at: '2025-11-14T12:19:38.000000+08:00', id: 85, name: 'git' },
  path: 'ard-sdk',
  path_with_namespace: 'osc/ard/ard-sdk',
  readme_url: '',
  repository_storage: '',
  // 远端地址用变量拼装（与 read.test.mjs 同一写法）：脱敏规则按形状识别 SSH 远端，
  // 连着写占位域名也会命中，所以源文件里不出现完整远端字面量（值本身是公开占位符）。
  ssh_url_to_repo: `ssh://git@${FIXTURE_HOST}:30004/osc/ard/ard-sdk.git`,
  star_count: 1,
  statistics: { commit_count: 518, repository_size: 7994, storage_size: 7994, tag_count: 4, wiki_size: 0 },
  tag_list: { labels: [], tags: [] },
  user_permission: { code: 6, permission: 'Operator' },
  visibility: 'private',
  web_url: 'http://corp.example.com/osc/_code/osc/ard/ard-sdk/-/code/',
});

const ISSUE_LIST_PAYLOAD = Object.freeze({
  data: {
    list: [
      {
        description: '<p>测试issue</p>',
        id: 1,
        labels: [],
        title: 'test001',
        updated_at: '2026-11-03T19:40:24.433000+08:00',
      },
    ],
  },
  meta: { current_page: 1, total_count: 1, total_pages: 1 },
});

const PR_LIST_PAYLOAD = Object.freeze({
  data: [
    {
      author: { id: 281, name: '001701-示例', user_name: '001701', web_url: '' },
      can_be_merge: false,
      can_merge: false,
      closed_at: null,
      created_at: '2026-11-03T19:44:06.234928+08:00',
      description: '',
      diff_refs: {
        base_sha: 'e8a67476dbd79259d30145453a20cab980bfc839',
        head_sha: '9f38c9adc591ca42605b2fc206052bd4119c2895',
      },
      full_path: 'osc/ard/ard-cli',
      id: 671766,
      iid: 2,
      is_squash_merged: false,
      labels: [{ color: '#FFAB00', description: '优化了代码', id: 217, name: '优化', target_id: 4613, target_type: 'Namespace' }],
      merge_commit_sha: 'ada683b0ee9f76df0ec2585600a218d420ea479e',
      merge_status: 'can_be_merged',
      merged_at: null,
      merged_by: '',
      pr_auto_merge_enabled: false,
      project_id: 10159,
      project_name: 'ard-cli',
      project_path: 'ard-cli',
      sha: 'ada683b0ee9f76df0ec2585600a218d420ea479e',
      source_branch: 'one',
      target_branch: 'master',
      state: 'opened',
      title: '测试pr',
      updated_at: '2026-11-03T19:44:06.234928+08:00',
      user_notes_count: 0,
      web_url: 'http://corp.example.com/osc/_code/osc/ard/ard-cli/-/pull_requests/2',
      work_items: null,
    },
  ],
  meta: { current_page: 1, total_count: 1, total_pages: 1 },
});

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
  assert.equal(caught.provider, GITEE_PLATFORM);
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
  assert.equal(GITEE_PLATFORM, 'gitee');
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

test('字段投影清单逐字为企业 CLI 实测字段名（AC-12 / r11 实测）', () => {
  assert.deepEqual([...GITEE_REPO_FIELDS], [
    'name', 'path', 'path_with_namespace', 'description', 'default_branch',
    'visibility', 'web_url', 'last_activity_at', 'archived', 'ssh_url_to_repo', 'http_url_to_repo',
  ]);
  // 列表元素与详情对象**不是同一套**：列表没有 visibility/web_url/archived/path，
  // 链接字段是 http_url/ssh_url（无 `_to_repo` 后缀）。
  assert.deepEqual([...GITEE_REPO_LIST_FIELDS], [
    'created_at', 'description', 'fork_from_path', 'http_url', 'id', 'last_activity_at',
    'name', 'path_with_namespace', 'ssh_url',
  ]);
  // 详情载荷没有 updated_at/web_url，`id` 是字符串键（如 I2N6），另带 author/priority。
  assert.deepEqual([...GITEE_ISSUE_FIELDS], [
    'author', 'created_at', 'description', 'id', 'labels', 'priority', 'state', 'title',
  ]);
  // `issue list` 的元素**恰好** 5 个键（实测）：清单载荷没有 state/web_url，倒是有
  // description/labels——表按载荷逐字对，不能拿 view 的字段集来凑。
  assert.deepEqual([...GITEE_ISSUE_LIST_FIELDS], ['description', 'id', 'labels', 'title', 'updated_at']);
  assert.deepEqual([...GITEE_PR_FIELDS], [
    'iid', 'title', 'state', 'web_url', 'updated_at',
    'source_branch', 'target_branch', 'merge_status', 'merged_at', 'user_notes_count',
  ]);
  assert.deepEqual([...GITEE_PR_LIST_FIELDS], [
    'iid', 'title', 'state', 'web_url', 'source_branch', 'target_branch', 'merge_status',
  ]);

  // 实测载荷里**不存在**的旧名字不许回到表里：那些名字是按 gh 风格猜的，实测全部落空。
  const repoDeclared = new Set([...GITEE_REPO_FIELDS, ...GITEE_REPO_LIST_FIELDS]);
  for (const absent of ['url', 'private', 'updated_at', 'nameWithOwner', 'isPrivate', 'defaultBranchRef', 'updatedAt']) {
    assert.ok(!repoDeclared.has(absent), `仓库投影不得含 ${absent}`);
  }
  const issueDeclared = new Set([...GITEE_ISSUE_FIELDS, ...GITEE_ISSUE_LIST_FIELDS]);
  for (const absent of ['number', 'url', 'comments']) {
    assert.ok(!issueDeclared.has(absent), `Issue 投影不得含 ${absent}`);
  }
  const prDeclared = new Set([...GITEE_PR_FIELDS, ...GITEE_PR_LIST_FIELDS]);
  for (const absent of [
    'number', 'url', 'head', 'base', 'comments', 'mergeable', 'draft',
    'mergedAt', 'statusCheckRollup', 'reviewDecision', 'autoMergeRequest', 'mergeableState',
  ]) {
    assert.ok(!prDeclared.has(absent), `PR 投影不得含 ${absent}`);
  }
  // 表里全部是 snake_case/小写标识，没有 camelCase 混入。
  for (const field of new Set([...repoDeclared, ...issueDeclared, ...prDeclared])) {
    assert.match(field, /^[a-z][a-z_]*$/, `字段 ${field} 不是 Gitee 语义命名`);
  }
  // 实测载荷里这些名字确实存在，所以投影取得到（不是"表里写了、载荷里没有"）。
  for (const field of GITEE_REPO_FIELDS) assert.ok(field in REPO_VIEW_PAYLOAD, `仓库载荷没有 ${field}`);
  for (const field of GITEE_PR_FIELDS) assert.ok(field in PR_LIST_PAYLOAD.data[0], `PR 载荷没有 ${field}`);
  // Issue 清单项按实测恰好五个键：投影里每个名字都在载荷里，state/web_url 则根本不在载荷里，
  // 所以它们既不能进清单表，也不能靠"取不到就进 missing_fields"留在表里。
  for (const field of GITEE_ISSUE_LIST_FIELDS) {
    assert.ok(field in ISSUE_LIST_PAYLOAD.data.list[0], `Issue 清单载荷没有 ${field}`);
  }
  for (const absent of ['state', 'web_url', 'number', 'url']) {
    assert.ok(!GITEE_ISSUE_LIST_FIELDS.includes(absent), `Issue 清单投影不得含 ${absent}`);
  }
});

test('事实版本字段按对象类型分开：仓库没有 updated_at，取 last_activity_at', () => {
  assert.deepEqual({ ...GITEE_REVISION_FIELDS }, {
    repositoryView: 'last_activity_at',
    issueView: 'created_at',
    prView: 'updated_at',
  });
  // 仓库载荷确实没有 updated_at：这是"取哪个字段当版本"的事实依据，不是偏好。
  assert.equal('updated_at' in REPO_VIEW_PAYLOAD, false);
  assert.equal(REPO_VIEW_PAYLOAD.last_activity_at, '2026-11-02T16:10:34.000000+08:00');
});

test('本地投影清单与字段表同源（同一对象，不存在两处漂移）', () => {
  assert.equal(GITEE_FIELD_PROJECTIONS.repositoryView, GITEE_REPO_FIELDS);
  assert.equal(GITEE_FIELD_PROJECTIONS.repositoryList, GITEE_REPO_LIST_FIELDS);
  assert.equal(GITEE_FIELD_PROJECTIONS.issueView, GITEE_ISSUE_FIELDS);
  assert.equal(GITEE_FIELD_PROJECTIONS.issueList, GITEE_ISSUE_LIST_FIELDS);
  assert.equal(GITEE_FIELD_PROJECTIONS.prView, GITEE_PR_FIELDS);
  assert.equal(GITEE_FIELD_PROJECTIONS.prList, GITEE_PR_LIST_FIELDS);
  // 写命令没有投影：输出是人类文本，改由解析器取编号/链接。
  for (const writeCommand of ['issueCreate', 'issueComment', 'prCreate', 'prComment']) {
    assert.equal(GITEE_FIELD_PROJECTIONS[writeCommand], undefined);
  }
});

test('argv 形状固定：单对象命令拆成「编号 + -R」，repo list 没有位置参数（AC-14 / 规格 §2.4/§2.5）', () => {
  // `repo view [repository]`：位置参数就是仓库（Usage 里写着 `[repository]`）。
  assert.deepEqual(argvFor('repositoryView', { target: REPO_TARGET }), ['repo', 'view', REPO_TARGET]);
  // `--json` 只追加旗标本身：实测 `--json name,path` 与裸 `--json` 输出完全一样，
  // 逗号清单会被忽略，所以字段清单永远不进 argv（否则 argv 里躺着一段假参数）。
  assert.deepEqual(argvFor('repositoryView', { target: REPO_TARGET, json: true }), [
    'repo', 'view', REPO_TARGET, '--json',
  ]);

  // 单对象命令（规格 §2.4/§2.5：`gh issue view <number>`）：位置参数**只有一个编号**，
  // 仓库由全局 `-R` 给。把 `owner/repo#12` 整串当编号传，CLI 一定解析失败。
  assert.deepEqual(argvFor('issueView', { target: ISSUE_TARGET }), ['issue', 'view', '7', '-R', REPO_TARGET]);
  assert.deepEqual(argvFor('issueView', { target: ISSUE_TARGET, json: true }), [
    'issue', 'view', '7', '-R', REPO_TARGET, '--json',
  ]);
  assert.deepEqual(argvFor('prView', { target: 'osc/ard/ard-sdk#12' }), [
    'pr', 'view', '12', '-R', 'osc/ard/ard-sdk',
  ]);
  assert.deepEqual(argvFor('issueComment', { target: ISSUE_TARGET, body: '评论' }), [
    'issue', 'comment', '7', '-R', REPO_TARGET, '--body', '评论',
  ]);
  assert.deepEqual(argvFor('prComment', { target: 'osc/ard/ard-sdk#12', body: '评论' }), [
    'pr', 'comment', '12', '-R', 'osc/ard/ard-sdk', '--body', '评论',
  ]);

  // 纯数字 target：有意不加 `-R`（规格 §1.2：无 `-R` 时按当前目录 git remote 解析仓库）。
  assert.deepEqual(argvFor('issueView', { target: '12' }), ['issue', 'view', '12']);
  assert.deepEqual(argvFor('prComment', { target: '3', body: '评论' }), ['pr', 'comment', '3', '--body', '评论']);

  // 单对象命令必须有编号：仓库名不是编号，不能当位置参数发出去（零子进程）。
  assertRejected(fakeRunner(), () => assertArgv('issueView', { target: REPO_TARGET }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(fakeRunner(), () => assertArgv('prComment', { target: REPO_TARGET, body: 'x' }), ADAPTER_REASONS.ARG_INVALID);

  // `repo list` 没有位置参数（Usage：`gh repo list [flags]`）：它列的是令牌可见的仓库，
  // target 只校验形状、不进 argv——"按仓库过滤 repo list"这种能力不存在。
  assert.deepEqual(argvFor('repositoryList', { target: REPO_TARGET }), ['repo', 'list']);
  assert.deepEqual(argvFor('repositoryList', { target: REPO_TARGET, limit: 20, json: true }), [
    'repo', 'list', '--json', '--limit', '20',
  ]);

  // 把字段清单塞进 argv 参数位是不合法形状：投影选择器只在 read() 里消费。
  assertRejected(fakeRunner(), () => assertArgv('issueView', { target: ISSUE_TARGET, json: ['id'] }), ADAPTER_REASONS.ARG_INVALID);

  // argvFor 只拼调用方给的参数（`--json` 缺省由 read() 注入，`--state` 缺省归 CLI 默认值）。
  assert.deepEqual(argvFor('issueList', { target: REPO_TARGET, state: 'created', limit: 20 }), [
    'issue', 'list', '-R', REPO_TARGET,
    '--state', 'created',
    '--limit', '20',
  ]);
  assert.deepEqual(argvFor('issueList', { target: REPO_TARGET, state: 'created', limit: 20, json: true }), [
    'issue', 'list', '-R', REPO_TARGET,
    '--json',
    '--state', 'created',
    '--limit', '20',
  ]);
  assert.deepEqual(argvFor('issueCreate', { target: REPO_TARGET, title: '标题', body: '正文' }), [
    'issue', 'create', '-R', REPO_TARGET, '--title', '标题', '--body', '正文',
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
  assert.deepEqual([...plan.args], ['pr', 'view', '7', '-R', REPO_TARGET]);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.args));
});

test('--state 词表按命令分表：issue 与 pr 不共用，`open` 在两边都非法（规格 §2.4/§2.5）', () => {
  // 两套词表各自的合法值都要能原样进 argv。
  for (const state of ['created', 'processing', 'rejected', 'finished', 'all']) {
    assert.deepEqual(argvFor('issueList', { target: REPO_TARGET, state }), [
      'issue', 'list', '-R', REPO_TARGET, '--state', state,
    ]);
  }
  for (const state of ['opened', 'closed', 'merged', 'all']) {
    assert.deepEqual(argvFor('prList', { target: REPO_TARGET, state }), [
      'pr', 'list', '-R', REPO_TARGET, '--state', state,
    ]);
  }
  // `open` 是旧词表留下的值：两个命令都不认——它是读出来归一后的词，不是能发出去的筛选值。
  for (const command of ['issueList', 'prList']) {
    assertRejected(fakeRunner(), () => assertArgv(command, { target: REPO_TARGET, state: 'open' }), ADAPTER_REASONS.ARG_INVALID);
  }
  // 也不许串用：`created` 只属于 issue，`merged` 只属于 pr。
  assertRejected(fakeRunner(), () => assertArgv('prList', { target: REPO_TARGET, state: 'created' }), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(fakeRunner(), () => assertArgv('issueList', { target: REPO_TARGET, state: 'merged' }), ADAPTER_REASONS.ARG_INVALID);
  // 导出的是两张表（工具面的 enum 从这里取），不是并集。
  assert.deepEqual(Object.keys({ ...STATE_VALUES }).sort(), ['issueList', 'prList']);
  assert.deepEqual([...STATE_VALUES.issueList], ['created', 'processing', 'rejected', 'finished', 'all']);
  assert.deepEqual([...STATE_VALUES.prList], ['opened', 'closed', 'merged', 'all']);
  assert.deepEqual({ ...STATE_DEFAULTS }, { issueList: 'created', prList: 'opened' });
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
    // 本 CLI 没有 `--host` 这个全局 flag（规格 §1.1）：主机来自 CLI 自己的配置文件，
    // 传进来就是未声明参数，不是"被忽略的选项"。
    { host: 'evil.example' },
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

test('投影选择器只接受声明的字段名：越界即失败且零子进程（AC-14）', () => {
  const runner = fakeRunner();
  // 未声明字段（含 GitHub 语义与实测不存在的旧名）：白名单是唯一判据。
  assertRejected(runner, () => projectionFor('issueList', ['id', 'number']), ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED);
  assertRejected(runner, () => projectionFor('issueList', ['id', 'url']), ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED);
  for (const undeclared of ['mergedAt', 'statusCheckRollup', 'checks', 'reviewDecision', 'autoMergeRequest', 'number']) {
    assertRejected(
      runner,
      () => projectionFor('prView', ['iid', undeclared]),
      ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED,
    );
  }
  // 写命令没有投影通道（输出是人类文本）。
  assertRejected(runner, () => projectionFor('issueCreate', ['id']), ADAPTER_REASONS.ARG_NOT_WHITELISTED);
  // 空请求视为非法（不静默退化成"返回全部"或人类文本解析）。
  assertRejected(runner, () => projectionFor('issueList', []), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => projectionFor('issueList', ' , '), ADAPTER_REASONS.ARG_INVALID);
  assertRejected(runner, () => projectionFor('issueList', ['id', '  ']), ADAPTER_REASONS.ARG_INVALID);
  // 逗号字符串写法可用，且去重保序；缺省是完整声明集（同一个对象，不复制）。
  assert.deepEqual([...projectionFor('issueList', 'title,id,title')], ['title', 'id']);
  assert.equal(projectionFor('issueList'), GITEE_ISSUE_LIST_FIELDS);
  assert.equal(projectionFor('repositoryView'), GITEE_REPO_FIELDS);
  // 投影只影响归一后的交付键，不产生任何子进程：以上全部是同步校验。
  assert.equal(runner.calls.length, 0, '投影越界必须零子进程');
});

test('runner 只收到 {bin,args,purpose}，读命令只多一个无值的 --json（AC-23 / r11 实测）', async () => {
  const runner = fakeRunner(() => jsonOut(ISSUE_LIST_PAYLOAD));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  await adapter.invoke('issueList', { target: REPO_TARGET, json: true }, 'gitee.issue.read');
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.deepEqual(Object.keys(call).sort(), ['args', 'bin', 'purpose']);
  assert.equal(call.bin, 'gh');
  assert.equal(call.purpose, 'gitee.issue.read');
  // `--json` 后面不许再跟字段清单：实测逗号清单被 CLI 忽略（证据 4）。
  assert.deepEqual(call.args, ['issue', 'list', '-R', REPO_TARGET, '--json']);
  for (const arg of call.args) assert.equal(typeof arg, 'string');
  assert.ok(!call.args.some((arg) => arg.includes(TOKEN_VALUE)), '凭据永不进 argv');
});

test('实测载荷：repo view 是扁平对象，版本取 last_activity_at、链接取 web_url（AC-12）', async () => {
  const runner = fakeRunner(() => jsonOut(REPO_VIEW_PAYLOAD));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const facts = await adapter.read('gitee.repository.read', REPO_TARGET);

  assert.equal(facts.status, 'succeeded');
  assert.equal(facts.source_revision, REPO_VIEW_PAYLOAD.last_activity_at);
  assert.deepEqual([...facts.result_refs], [REPO_VIEW_PAYLOAD.web_url]);
  assert.deepEqual([...facts.missing_fields], [], '投影里的每个名字在实测载荷里都存在');
  assert.deepEqual(Object.keys(facts.object), [...GITEE_REPO_FIELDS]);
  // 实测没有的名字一个都不许"补"出来：url/private/updated_at 必须缺席。
  for (const absent of ['url', 'private', 'updated_at', 'number']) assert.equal(absent in facts.object, false);
  assert.equal(facts.object.path_with_namespace, 'osc/ard/ard-sdk');
  assert.equal(facts.object.visibility, 'private');
  assert.equal(facts.object.archived, false);
  // 载荷里未声明的键（statistics/namespace/owner…）不进 object：投影之外一律不采信。
  assert.equal('statistics' in facts.object, false);
  assert.equal('owner' in facts.object, false);
  assert.deepEqual(runner.calls[0].args, ['repo', 'view', REPO_TARGET, '--json']);
});

test('实测载荷：{data:{…}} 会剥壳，opened 归一到既有词表的 open，缺版本仍降级（AC-15）', async () => {
  // 详情载荷按规格 §2.4 的 8 字段造：`id` 是字符串键、有 created_at、**没有** web_url/updated_at。
  const issueView = {
    data: {
      author: '000002-示例审批人',
      created_at: '2026-11-03T19:40:24.433000+08:00',
      description: '<p>测试issue</p>',
      id: 'I2N6',
      labels: [],
      priority: 'medium',
      state: 'opened',
      title: 'test001',
    },
  };
  const runner = fakeRunner(() => jsonOut(issueView));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const facts = await adapter.read('gitee.issue.read', ISSUE_TARGET);

  assert.equal(facts.status, 'succeeded');
  assert.equal(facts.object.id, 'I2N6', '详情里的 id 是字符串键（列表里才是数字 iid）');
  assert.equal('number' in facts.object, false);
  assert.equal(facts.object.state, 'open', 'opened 归一到信封词表的 open');
  assert.equal(facts.source_revision, issueView.data.created_at, '详情载荷没有 updated_at，版本取 created_at');
  // 详情载荷没有 web_url：宁可 result_refs 为空，也不去猜一个链接出来。
  assert.deepEqual([...facts.result_refs], []);
  assert.deepEqual([...facts.missing_fields], []);

  // 缺 updated_at：不编版本号，整条降级 unknown，并把缺失落进 missing_fields。
  const { created_at: _drop, ...withoutRevision } = issueView.data;
  const noRevision = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut({ data: withoutRevision })),
    env: SECRET_ENV,
  });
  const degraded = await noRevision.read('gitee.issue.read', ISSUE_TARGET);
  assert.equal(degraded.status, 'unknown');
  assert.equal(degraded.error_code, ADAPTER_REASONS.MISSING_SOURCE_REVISION);
  assert.equal(degraded.source_revision, null);
  assert.deepEqual([...degraded.missing_fields], ['created_at']);
  assert.equal(degraded.object.created_at, null);
  assert.equal(degraded.object.title, 'test001', '已取到的字段仍交付，只降级状态');
});

test('投影选择器只决定交付哪些键：事实版本与链接仍从原始载荷取', async () => {
  const runner = fakeRunner(() => jsonOut(ISSUE_LIST_PAYLOAD));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const facts = await adapter.read('gitee.issue.read', REPO_TARGET, { list: true, json: ['id', 'title'] });
  assert.equal(facts.status, 'succeeded');
  assert.deepEqual(Object.keys(facts.items[0]), ['id', 'title']);
  // 没勾的字段不进 missing_fields（那不是"取不到"，是"没要"）。
  assert.deepEqual([...facts.missing_fields], []);
  // argv 依旧只有开关本身：投影是本地行为；没传 state 就不注入默认值（默认归 CLI）。
  assert.deepEqual(runner.calls[0].args, ['issue', 'list', '-R', REPO_TARGET, '--json', '--limit', '100']);
  assert.equal(runner.calls[0].args.includes('--state'), false, '调用方不传 state 时本包不替 CLI 填默认值');

  // 对象读同理：只交付点名的键，但事实版本与链接是"读的事实"，仍从原始载荷取。
  const issueView = {
    data: {
      author: '000002-示例审批人',
      created_at: '2026-11-03T19:40:24.433000+08:00',
      description: '<p>测试issue</p>',
      id: 'I2N6',
      labels: [],
      priority: 'medium',
      state: 'finished',
      title: 'test001',
    },
  };
  const single = await createGiteeAdapter({ runner: fakeRunner(() => jsonOut(issueView)), env: SECRET_ENV })
    .read('gitee.issue.read', ISSUE_TARGET, { json: ['id', 'title'] });
  assert.equal(single.status, 'succeeded');
  assert.deepEqual(Object.keys(single.object), ['id', 'title']);
  assert.equal(single.source_revision, issueView.data.created_at, '版本从原始载荷取，不因投影缺席而丢');
  // 详情载荷没有 web_url：result_refs 为空是事实，不去猜链接。
  assert.deepEqual([...single.result_refs], []);
});

test('实测载荷：Issue 清单在 data.list 里，编号用 id，meta.total_count 作为附加事实（AC-12/AC-14）', async () => {
  const runner = fakeRunner(() => jsonOut(ISSUE_LIST_PAYLOAD));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const listed = await adapter.read('gitee.issue.read', REPO_TARGET, { list: true });

  assert.equal(listed.status, 'succeeded');
  assert.equal(listed.kind, 'list');
  assert.equal(listed.count, 1);
  assert.equal(listed.total_count, 1, 'CLI 的 meta.total_count 原样带出');
  assert.equal(listed.source_revision, null, '清单是查询快照，不冻结事实版本');
  assert.deepEqual(Object.keys(listed.items[0]), [...GITEE_ISSUE_LIST_FIELDS]);
  assert.equal(listed.items[0].id, 1);
  assert.equal('number' in listed.items[0], false);
  // 实测清单项恰好 5 个键：投影里没有 state/web_url（载荷本来就没有），也没有 missing_fields。
  assert.deepEqual([...listed.missing_fields], []);
  assert.equal('state' in listed.items[0], false);
  assert.equal('web_url' in listed.items[0], false);
  // 默认参数逐字进 argv：`--json` 无值、上限 100；`--state` 不传就不发（默认归 CLI 的 created）。
  assert.deepEqual(runner.calls[0].args, [
    'issue', 'list', '-R', REPO_TARGET,
    '--json',
    '--limit', '100',
  ]);
});

test('实测载荷：PR 清单在 data 数组里，编号用 iid、分支用 source_branch/target_branch（AC-12/AC-14）', async () => {
  const runner = fakeRunner(() => jsonOut(PR_LIST_PAYLOAD));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV });
  const listed = await adapter.read('gitee.pr.read', REPO_TARGET, { list: true, state: 'all', limit: 5 });

  assert.equal(listed.status, 'succeeded');
  assert.equal(listed.count, 1);
  assert.equal(listed.total_count, 1);
  const [item] = listed.items;
  assert.deepEqual(Object.keys(item), [...GITEE_PR_LIST_FIELDS]);
  assert.equal(item.iid, 2, 'PR 编号是 iid（id=671766 是全局号，对不上 URL 里的 2）');
  assert.equal(item.id, undefined);
  assert.equal(item.source_branch, 'one');
  assert.equal(item.target_branch, 'master');
  assert.equal(item.merge_status, 'can_be_merged');
  assert.equal(item.state, 'open', 'opened 归一到 open');
  assert.equal('head' in item, false, 'head/base 是 GitHub 语义，Gitee 载荷里没有');
  assert.equal('mergeable' in item, false);
  assert.deepEqual([...listed.missing_fields], []);
  assert.deepEqual(runner.calls[0].args, [
    'pr', 'list', '-R', REPO_TARGET,
    '--json',
    '--state', 'all',
    '--limit', '5',
  ]);

  // 显式投影：只交付点名的键（顺序即声明顺序），事实版本/链接口径不变。
  const raw = await createGiteeAdapter({ runner: fakeRunner(() => jsonOut(PR_LIST_PAYLOAD)), env: SECRET_ENV })
    .read('gitee.pr.read', REPO_TARGET, { list: true, json: ['iid', 'state'] });
  assert.deepEqual(Object.keys(raw.items[0]), ['iid', 'state']);
  assert.equal(raw.items[0].state, 'open');
});

test('包裹形状：扁平对象、{data:[…]}、{data:{list:[…]}}、{items:[…]} 都吃，认不出即畸形', async () => {
  const flatList = [
    { id: 3, title: 'c', updated_at: '2026-11-03T00:00:00Z', web_url: 'http://corp.example.com/c/r/issues/3' },
  ];
  const accepted = [
    flatList,
    { data: flatList },
    { data: { list: flatList }, meta: { total_count: 9 } },
    { items: flatList },
  ];
  for (const payload of accepted) {
    const adapter = createGiteeAdapter({ runner: fakeRunner(() => jsonOut(payload)), env: SECRET_ENV });
    const facts = await adapter.read('gitee.issue.read', REPO_TARGET, { list: true });
    assert.equal(facts.status, 'succeeded', `包裹形状 ${JSON.stringify(payload).slice(0, 24)}… 应当可读`);
    assert.equal(facts.items[0].id, 3);
    if ('meta' in payload) assert.equal(facts.total_count, 9, 'meta.total_count 在剥壳后仍要带出');
    else assert.equal(facts.total_count, null, '没有 meta 时 total_count 是 null（未知，不编 0）');
  }
  // 认不出的形状 → 畸形结果（不把 data/meta 当数据交付）。
  for (const payload of [{ data: { list: 'nope' } }, { data: 42 }, 'nope', 42]) {
    const adapter = createGiteeAdapter({ runner: fakeRunner(() => jsonOut(payload)), env: SECRET_ENV });
    await assertRejectedAsync(
      () => adapter.read('gitee.issue.read', REPO_TARGET, { list: true }),
      ADAPTER_REASONS.MALFORMED_RESULT,
    );
  }
});

test('空 PR 列表不是畸形：`{"message":"No pull requests found."}` 解成 0 条（规格 §4 第 5 条）', async () => {
  const empty = createGiteeAdapter({
    runner: fakeRunner(() => jsonOut({ message: 'No pull requests found.' })),
    env: SECRET_ENV,
  });
  const facts = await empty.read('gitee.pr.read', REPO_TARGET, { list: true });
  assert.equal(facts.status, 'succeeded', '"这仓库没有 PR" 不是工具故障');
  assert.equal(facts.kind, 'list');
  assert.deepEqual([...facts.items], []);
  assert.equal(facts.count, 0);
  assert.deepEqual([...facts.missing_fields], []);
  assert.equal(facts.total_count, null, 'message 信封没有 meta：total_count 是 null（未知，不编 0）');

  // 别顺手把其它畸形形状也放行：多一个键、message 非字符串、空对象与只有 data:null 都要报错。
  for (const payload of [
    { message: 'No pull requests found.', data: null },
    { message: 42 },
    { data: null },
    {},
  ]) {
    const broken = createGiteeAdapter({ runner: fakeRunner(() => jsonOut(payload)), env: SECRET_ENV });
    await assertRejectedAsync(
      () => broken.read('gitee.pr.read', REPO_TARGET, { list: true }),
      ADAPTER_REASONS.MALFORMED_RESULT,
    );
  }
});

test('状态值归一：只映射实测写法与既有词表，不新增状态词', async () => {
  const payloads = [
    ['opened', 'open'],
    ['open', 'open'],
    ['closed', 'closed'],
    // 未实测的值原样保留：不猜同义词，也不悄悄降级。
    ['merged', 'merged'],
    ['locked', 'locked'],
  ];
  for (const [raw, expected] of payloads) {
    const adapter = createGiteeAdapter({
      runner: fakeRunner(() => jsonOut({ data: [{ iid: 1, title: 't', state: raw, web_url: 'http://corp.example.com/c/r/pulls/1' }] })),
      env: SECRET_ENV,
    });
    const facts = await adapter.read('gitee.pr.read', REPO_TARGET, { list: true });
    assert.equal(facts.items[0].state, expected, `状态 ${raw} 应归一为 ${expected}`);
  }
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
    runner: fakeRunner(() => ({ exitCode: 4, stdout: '', stderr: 'HTTP 500 Internal Server Error' })),
    env: SECRET_ENV,
  });
  await assertRejectedAsync(() => nonzero.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.NONZERO_EXIT);

  const unsupported = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'invalid json: unknown field "description"' })),
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

test('对象不存在 → ITEM_NOT_FOUND：保留服务端原文、无副作用；与真实故障分开（UAT-5）', async () => {
  const notFound404 = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' })),
    env: EMPTY_ENV,
  });
  const error404 = await assertRejectedAsync(() => notFound404.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.ITEM_NOT_FOUND);
  assert.equal(error404.detail.mayHaveSideEffect, false, '目标不存在是确定失败：改正目标可安全重试');
  assert.match(error404.message, /HTTP 404: Not Found/u, '保留服务端原文（脱敏+截断），不换成笼统失败文案');
  assert.equal(error404.detail.exitCode, 1);

  // 内网 Gitee 对不存在对象可能回 500，正文才是判据："未找到"不是真实服务故障。
  const notFound500 = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: '{"message":"未找到项目 corp/missing"}' })),
    env: EMPTY_ENV,
  });
  const error500 = await assertRejectedAsync(() => notFound500.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.ITEM_NOT_FOUND);
  assert.match(error500.message, /未找到项目 corp\/missing/u);
  assert.equal(error500.detail.mayHaveSideEffect, false);

  const notFoundEnglish = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'HTTP 500: Not Found' })),
    env: EMPTY_ENV,
  });
  await assertRejectedAsync(() => notFoundEnglish.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.ITEM_NOT_FOUND);

  // "命令找不到"的文案里同样有 not found，但那是环境问题，不能当成目标不存在。
  const missingBinary = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 127, stdout: '', stderr: 'gh: command not found' })),
    env: EMPTY_ENV,
  });
  await assertRejectedAsync(() => missingBinary.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.NONZERO_EXIT);

  // 脱敏规则照样作用于 ITEM_NOT_FOUND 的原文。
  const leaked = createGiteeAdapter({
    runner: fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: `404 未找到 target ${TOKEN_VALUE}` })),
    env: SECRET_ENV,
    authEnv: TOKEN_NAME,
  });
  const leakedError = await assertRejectedAsync(() => leaked.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.ITEM_NOT_FOUND);
  assert.ok(!leakedError.message.includes(TOKEN_VALUE), '消息不得含令牌');
  assert.ok(leakedError.message.includes('[REDACTED]'));
});

test('失败信息脱敏：stderr 里的令牌不回到消息与 detail（AC-22）', async () => {
  const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: `boom for ${TOKEN_VALUE} / ${SECRET_SHAPE}` }));
  const adapter = createGiteeAdapter({ runner, env: SECRET_ENV, authEnv: TOKEN_NAME });
  const error = await assertRejectedAsync(() => adapter.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.NONZERO_EXIT);
  assert.ok(!error.message.includes(TOKEN_VALUE), '消息不得含令牌');
  assert.ok(!error.message.includes(SECRET_SHAPE), '消息不得含令牌');
  assert.ok(error.message.includes('[REDACTED]'), '应显式标注脱敏位置');
  assert.ok(!JSON.stringify(error.detail).includes(TOKEN_VALUE));
});

test('服务端拒绝凭据 → AUTH_MISSING（不再笼统报命令失败），文案指向 gh auth login', async () => {
  const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'HTTP 401 Unauthorized' }));
  const adapter = createGiteeAdapter({ runner, env: EMPTY_ENV });
  const error = await assertRejectedAsync(() => adapter.read('gitee.issue.read', ISSUE_TARGET, {}), ADAPTER_REASONS.AUTH_MISSING);
  assert.match(error.message, /401/);
  assert.match(error.message, /gh auth login/);
  assert.match(error.message, /authEnv/);
  assert.doesNotMatch(error.message, /必须在 authEnv 点名变量/);
  assert.equal(error.detail.mayHaveSideEffect, true);
});

test('preflight 零子进程：缺令牌仍可读、落盘凭据按策略告警或拒绝（AC-22 / r10）', () => {
  const runner = fakeRunner();
  const missing = createGiteeAdapter({ runner, env: EMPTY_ENV });
  const missingResult = missing.preflight();
  // r10：缺令牌不再是拒绝——只读命令照常发，受限仓库由 CLI 的非零退出说明。
  assert.equal(missingResult.ok, true);
  assert.equal(missingResult.reason, null);
  assert.equal(missingResult.tokenSource, 'none');
  assert.equal(missingResult.provider, 'gitee');
  assert.equal(missingResult.mayHaveSideEffect, false);
  assert.equal(missingResult.persistentToken, 'absent');
  assert.match(missingResult.message, /只读命令照常执行/);
  assert.ok(!JSON.stringify(missingResult).includes(TOKEN_VALUE));

  const ready = createGiteeAdapter({ runner, env: SECRET_ENV, authEnv: TOKEN_NAME });
  const readyResult = ready.preflight();
  assert.equal(readyResult.ok, true);
  assert.equal(readyResult.reason, null);
  assert.equal(readyResult.tokenSource, 'env');
  assert.deepEqual([...readyResult.authEnv], [TOKEN_NAME]);
  assert.ok(!JSON.stringify(readyResult).includes(TOKEN_VALUE), 'preflight 只报来源不报值');

  // 落盘凭据：默认 warn 照常放行；只有显式 block 才拒绝。
  const warned = createGiteeAdapter({ runner, env: SECRET_ENV, persistentTokenProbe: () => true });
  const warnedResult = warned.preflight();
  assert.equal(warnedResult.ok, true);
  assert.equal(warnedResult.persistentToken, 'detected');
  assert.equal(warnedResult.persistentTokenPolicy, 'warn');
  assert.match(warnedResult.message, /warn/);

  const blocked = createGiteeAdapter({
    runner,
    env: SECRET_ENV,
    persistentTokenProbe: () => true,
    persistentTokenPolicy: 'block',
  });
  const blockedResult = blocked.preflight();
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.reason, ADAPTER_REASONS.GITEE_PERSISTENT_TOKEN);
  assert.match(blockedResult.message, /gh auth login/);
  assert.doesNotMatch(blockedResult.message, /改用环境变量注入/);
  assert.equal(runner.calls.length, 0, 'preflight 永不起子进程');
});

test('describe() 脱敏：报路径种类与命令面，不回显令牌与绝对路径（AC-22）', () => {
  const runner = fakeRunner();
  const adapter = createGiteeAdapter({ runner, cliPath: ABSOLUTE_BIN, env: SECRET_ENV, authEnv: TOKEN_NAME, host: 'gitee.example' });
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
  assert.equal(described.host, 'gitee.example');

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
  // 适配器里不许出现任何 GH_* 标识：主机也不走环境变量（规格 §1.1/§1.5——主机来自 CLI 自己的
  // `~/.gitee-cli/config.json` 的 base_url），语义常量与凭据默认值同样一个都没有（authEnv 默认空）。
  const ghIdentifiers = [...src.matchAll(/\bGH_[A-Z0-9_]+\b/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(ghIdentifiers)].sort(), []);
  for (const semantic of ['GH_COMMANDS', 'GH_FIELDS', 'GH_LIST_LIMIT', 'GH_ARGV_FLAGS', 'GH_PROVIDER', 'GH_TOKEN']) {
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
  assert.equal(adapter.provider, GITEE_PLATFORM);
  assert.equal(adapter.logicalName, GITEE_LOGICAL_NAME);
  for (const member of ['preflight', 'invoke', 'read', 'describe']) {
    assert.equal(typeof adapter[member], 'function', `缺成员 ${member}`);
  }
  assert.ok(!('run' in adapter) && !('exec' in adapter), '适配器不得暴露通用执行入口');
});

test('仓库标识允许嵌套命名空间：实测企业仓库是三级（osc/ard/ard-sdk）', () => {
  const nested = 'osc/ard/ard-sdk';
  // 两段（`owner/repo`）与三段（嵌套组）都必须成型；只认两段会把真实仓库全部拒掉。
  assert.deepEqual(argvFor('repositoryView', { target: nested }), ['repo', 'view', nested]);
  assert.deepEqual(argvFor('issueList', { target: nested }), ['issue', 'list', '-R', nested]);
  assert.equal(GITEE_FIELD_PROJECTIONS.repositoryView.length > 0, true);
  // 限定引用同样按嵌套命名空间解析：`osc/ard/ard-sdk#12` → 编号 12 + `-R osc/ard/ard-sdk`。
  assert.deepEqual(argvFor('issueView', { target: 'osc/ard/ard-sdk#12' }), [
    'issue', 'view', '12', '-R', 'osc/ard/ard-sdk',
  ]);
  // 单段不是仓库（没有命名空间），仍然拒绝。
  assert.throws(
    () => assertArgv('repositoryView', { target: 'ard-sdk' }),
    (error) => error.code === ADAPTER_REASONS.ARG_INVALID,
  );
  // 超过 8 段的伪路径不当作仓库（段数上限挡住"任意长路径"）。
  assert.throws(
    () => assertArgv('repositoryView', { target: 'a/b/c/d/e/f/g/h/i' }),
    (error) => error.code === ADAPTER_REASONS.ARG_INVALID,
  );
});

test('两处凭据失败文案都指向 gh auth login，不再要求必须在 authEnv 点名变量', async () => {
  const blocked = createGiteeAdapter({
    runner: fakeRunner(),
    env: EMPTY_ENV,
    persistentTokenProbe: () => true,
    persistentTokenPolicy: 'block',
  }).preflight();
  assert.match(blocked.message, /gh auth login/);
  assert.doesNotMatch(blocked.message, /必须在 authEnv|改用环境变量注入/);

  const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'HTTP 403 Forbidden' }));
  const error = await assertRejectedAsync(
    () => createGiteeAdapter({ runner, env: EMPTY_ENV }).read('gitee.issue.read', ISSUE_TARGET, {}),
    ADAPTER_REASONS.AUTH_MISSING,
  );
  assert.match(error.message, /gh auth login/);
  assert.doesNotMatch(error.message, /必须在 authEnv|改用环境变量注入/);
});
