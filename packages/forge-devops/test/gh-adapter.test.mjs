/**
 * gh 适配器的命令行契约测试（T2）。
 *
 * 断言重点：
 *   1. **argv 逐字**：读写的固定前缀、`-R <repo>` / `--json` 字段列表、清单的 `--state open --limit 100`；
 *   2. **信封**：单对象读的版本取 `updatedAt`，拿不到就 `null`（由 read 层降级 unknown，不编版本号）；
 *   3. **写语义**：只把"退出码为 0"翻译成结果，输出解析不出对象编号时抛带 `mayHaveSideEffect` 的错误；
 *   4. **禁项**：合并/关闭/发版/触发流水线/通用接口/编辑删除通道在适配器上不存在。
 *   5. **平台方言**（r6）：`data.list` / `{ data: {...} }` 包封、`path_with_namespace` 仓库名别名、
 *      2..3 段仓库引用与三段链接命名空间——判词来自 `repo-ref.mjs`，本文件只核对适配器行为。
 *      相关夹具是按 UAT 报告描述构造的 mock，非企业实测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GH_COMMANDS,
  GH_ISSUE_FIELDS,
  GH_ISSUE_LIST_FIELDS,
  GH_LIST_LIMIT,
  GH_PR_FIELDS,
  GH_PR_LIST_FIELDS,
  GH_REPO_FIELDS,
  GH_REPO_LIST_FIELDS,
  createGhAdapter,
} from '../src/gh-adapter.mjs';
import { DevopsReadError, READ_REASONS } from '../src/read.mjs';

const AT = '2026-10-28T12:00:00.000Z';
const now = () => AT;
const LISTS = JSON.parse(readFileSync(new URL('./fixtures/gh-lists.json', import.meta.url), 'utf8'));
// mock · 报告描述的「data.list + path_with_namespace」原生包封形状，非企业实测（见夹具内 `_fixture`）。
const GITEE_REPO_LIST = JSON.parse(readFileSync(new URL('./fixtures/gh-repo-list-gitee.json', import.meta.url), 'utf8'));

function fakeRunner(handler = null) {
  const calls = [];
  const runner = {
    calls,
    run: async (input) => {
      calls.push({ bin: input.bin, args: [...input.args], purpose: input.purpose });
      if (handler !== null) return handler(input, calls.length - 1);
      return { exitCode: 0, stdout: '[]', stderr: '', durationMs: 1, timedOut: false, truncated: false };
    },
  };
  return runner;
}

const adapterWith = (runner, options = {}) => createGhAdapter({ runner, ghBin: 'gh', now, ...options });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DevopsReadError, `应抛 DevopsReadError，实际 ${error?.name}`);
    assert.equal(error.code, code, `原因码应为 ${code}，实际 ${error.code}（${error.message}）`);
    return true;
  });
}

const okWith = (stdout) => () => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, truncated: false });

test('readRepository：repo view <repo> --json 字段按 §5.3 逐字', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({
    nameWithOwner: 'acme/demo',
    description: '演示仓库',
    url: 'https://github.example/acme/demo',
    defaultBranchRef: { name: 'main' },
    isPrivate: false,
    updatedAt: '2026-10-27T08:00:00Z',
  })));
  const result = await adapterWith(runner).readRepository({ repo: 'acme/demo' });

  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    bin: 'gh',
    args: ['repo', 'view', 'acme/demo', '--json', GH_REPO_FIELDS.join(',')],
    purpose: 'gh.repository.view',
  });
  assert.deepEqual(GH_REPO_FIELDS, ['nameWithOwner', 'description', 'url', 'defaultBranchRef', 'isPrivate', 'updatedAt']);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.source_revision, 'gh:2026-10-27T08:00:00Z');
  assert.equal(result.observed_at, AT);
  assert.deepEqual(result.result_refs, ['https://github.example/acme/demo']);
  assert.deepEqual(result.object, {
    repo: 'acme/demo',
    nameWithOwner: 'acme/demo',
    // owner/name 由完整路径拆出（最后一段之前的前缀 / 最后一段），不再因 `--json` 未要 owner 而留空。
    owner: 'acme',
    name: 'demo',
    description: '演示仓库',
    url: 'https://github.example/acme/demo',
    isPrivate: false,
    defaultBranch: 'main',
    topics: [],
    updatedAt: '2026-10-27T08:00:00Z',
  });
});

test('读信封不编版本号：对象没有 updatedAt 时 source_revision 为 null，status 仍如实为 succeeded', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ number: 12, state: 'OPEN' })));
  const result = await adapterWith(runner).readIssue({ target: 'acme/demo#12' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.source_revision, null);
  assert.equal(result.object.number, 12);
});

test('readIssue：issue view <target> --json（含 comments，供写动作按正文查重）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(LISTS.issueDetail)));
  const result = await adapterWith(runner).readIssue({ target: 'acme/ard-sdk#12' });

  assert.deepEqual(runner.calls[0].args, ['issue', 'view', 'acme/ard-sdk#12', '--json', GH_ISSUE_FIELDS.join(',')]);
  assert.equal(result.target_ref, 'acme/ard-sdk#12');
  assert.equal(result.source_revision, 'gh:2026-10-27T10:00:00Z');
  assert.deepEqual(result.object.comments, [{
    id: 'IC_kwDOAbc123',
    body: '澄清回写：AC-2 的验收口径已确认',
    url: 'https://github.example/acme/ard-sdk/issues/12#issuecomment-9001',
    author: 'alice',
    createdAt: '2026-10-27T10:30:00Z',
  }]);
});

test('readPr：pr view <target> --json，带分支/草稿/合并时间与评论', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(LISTS.prDetail)));
  const result = await adapterWith(runner).readPr({ target: 'acme/ard-sdk#7' });

  assert.deepEqual(runner.calls[0].args, ['pr', 'view', 'acme/ard-sdk#7', '--json', GH_PR_FIELDS.join(',')]);
  assert.equal(result.object.headRefName, 'feat/devops-change-flow');
  assert.equal(result.object.baseRefName, 'main');
  assert.equal(result.object.isDraft, false);
  assert.equal(result.object.mergedAt, null);
  assert.equal(result.object.comments.length, 1);
});

test('listOpenIssues：issue list -R <repo> --state open --limit 100 --json 字段按 §5.3', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(LISTS.issues)));
  const result = await adapterWith(runner).listOpenIssues({ repo: 'acme/ard-sdk' });

  assert.deepEqual(runner.calls[0].args, [
    'issue', 'list', '-R', 'acme/ard-sdk', '--state', 'open', '--limit', String(GH_LIST_LIMIT), '--json', GH_ISSUE_LIST_FIELDS.join(','),
  ]);
  assert.deepEqual(GH_ISSUE_LIST_FIELDS, ['number', 'title', 'url', 'state']);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].number, 12);
  assert.equal(result.source_revision, null, '清单是查询快照，不冻结事实版本');
  assert.equal(result.observed_at, AT);
});

test('listOpenPrs：pr list -R <repo> --state open --limit 100（多取 headRefName 判同分支）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(LISTS.prs)));
  const result = await adapterWith(runner).listOpenPrs({ repo: 'acme/ard-sdk' });

  assert.deepEqual(runner.calls[0].args, [
    'pr', 'list', '-R', 'acme/ard-sdk', '--state', 'open', '--limit', '100', '--json', GH_PR_LIST_FIELDS.join(','),
  ]);
  assert.deepEqual(GH_PR_LIST_FIELDS, ['number', 'title', 'url', 'headRefName', 'state']);
  assert.equal(result.items[0].headRefName, 'feat/devops-change-flow');
});

test('listRepos：repo list <owner> --limit 100，输出可直接作为 visibleRepos 交给承建判定', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(LISTS.repos)));
  const result = await adapterWith(runner).listRepos({ owner: 'acme' });

  assert.deepEqual(runner.calls[0].args, ['repo', 'list', 'acme', '--limit', '100', '--json', GH_REPO_LIST_FIELDS.join(',')]);
  assert.equal(result.count, 2);
  assert.deepEqual(result.items[0], {
    repo: 'acme/ard-sdk',
    nameWithOwner: 'acme/ard-sdk',
    owner: 'acme',
    name: 'ard-sdk',
    description: 'AI原生框架套件',
    url: 'https://github.example/acme/ard-sdk',
    isPrivate: true,
    defaultBranch: null,
    topics: ['ard', 'sdd'],
    updatedAt: '2026-10-20T08:00:00Z',
  });
});

test('listRepos：未配置仓库扫描范围 → 明确失败且零调用（不猜全量仓库）', async () => {
  const runner = fakeRunner();
  await rejectsWith(adapterWith(runner).listRepos({}), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapterWith(runner).listRepos({ owner: 'acme/other' }), READ_REASONS.MISSING_TARGET);
  assert.equal(runner.calls.length, 0);
});

test('createIssue：issue create -R <repo> --title --body，链接解析出编号', async () => {
  const runner = fakeRunner(okWith(LISTS.created.issue));
  const result = await adapterWith(runner).createIssue({ repo: 'acme/ard-sdk', title: '[ARD123456] 门禁回读', body: '正文' });

  assert.deepEqual(runner.calls[0].args, [
    'issue', 'create', '-R', 'acme/ard-sdk', '--title', '[ARD123456] 门禁回读', '--body', '正文',
  ]);
  assert.equal(result.number, 13);
  assert.equal(result.url, 'https://github.example/acme/ard-sdk/issues/13');
  assert.deepEqual(result.result_refs, ['https://github.example/acme/ard-sdk/issues/13']);
  assert.equal(result.source_revision, null);
});

test('createIssue：--json 形态的输出同样解析编号与链接', async () => {
  const runner = fakeRunner(okWith(LISTS.created.issueJson));
  const result = await adapterWith(runner).createIssue({ repo: 'acme/ard-sdk', title: 't', body: 'b' });
  assert.equal(result.number, 13);
  assert.equal(result.url, 'https://github.example/acme/ard-sdk/issues/13');
});

test('createIssue：输出里没有编号/链接 → MALFORMED_RESULT，且标注可能已产生副作用', async () => {
  const runner = fakeRunner(okWith(LISTS.created.unrecognized));
  await assert.rejects(adapterWith(runner).createIssue({ repo: 'acme/ard-sdk', title: 't', body: 'b' }), (error) => {
    assert.equal(error.code, READ_REASONS.MALFORMED_RESULT);
    assert.equal(error.detail.mayHaveSideEffect, true, '创建已发出，必须让动作层判 unknown 而不是重放');
    return true;
  });
});

test('commentIssue：issue comment <target> --body，解析评论链接与 comment_id', async () => {
  const runner = fakeRunner(okWith(LISTS.created.issueComment));
  const result = await adapterWith(runner).commentIssue({ target: 'acme/ard-sdk#12', body: '审查记录' });

  assert.deepEqual(runner.calls[0].args, ['issue', 'comment', 'acme/ard-sdk#12', '--body', '审查记录']);
  assert.equal(result.url, 'https://github.example/acme/ard-sdk/issues/12#issuecomment-9100');
  assert.equal(result.comment_id, '9100');
});

test('commentIssue：输出里没有评论引用时不猜，url/comment_id 为 null（核对交回读）', async () => {
  const runner = fakeRunner(okWith(LISTS.created.unrecognized));
  const result = await adapterWith(runner).commentIssue({ target: 'acme/ard-sdk#12', body: '审查记录' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.url, null);
  assert.equal(result.comment_id, null);
});

test('createPr：pr create -R <repo> --head --base --title --body，解析 PR 编号', async () => {
  const runner = fakeRunner(okWith(LISTS.created.pr));
  const result = await adapterWith(runner).createPr({
    repo: 'acme/ard-sdk', head: 'feat/devops-change-flow', base: 'main', title: '[ARD123456] 上下文卡', body: '正文',
  });

  assert.deepEqual(runner.calls[0].args, [
    'pr', 'create', '-R', 'acme/ard-sdk', '--head', 'feat/devops-change-flow', '--base', 'main',
    '--title', '[ARD123456] 上下文卡', '--body', '正文',
  ]);
  assert.equal(result.number, 8);
  assert.equal(result.head, 'feat/devops-change-flow');
  assert.equal(result.base, 'main');
});

test('commentPr：pr comment <target> --body，多余字段（如 commit）不改变命令面', async () => {
  const runner = fakeRunner(okWith(LISTS.created.prComment));
  const result = await adapterWith(runner).commentPr({ target: 'acme/ard-sdk#7', commit: 'abc123', body: '审查结论' });

  assert.deepEqual(runner.calls[0].args, ['pr', 'comment', 'acme/ard-sdk#7', '--body', '审查结论']);
  assert.equal(result.comment_id, '9101');
});

test('写动作缺必填文案 → MISSING_TARGET 且零调用（不猜默认标题/正文）', async () => {
  const runner = fakeRunner(okWith(LISTS.created.issue));
  const adapter = adapterWith(runner);
  await rejectsWith(adapter.createIssue({ repo: 'acme/ard-sdk', title: '', body: 'b' }), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapter.createIssue({ repo: 'acme/ard-sdk', title: 't', body: '   ' }), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapter.commentIssue({ target: 'acme/ard-sdk#12', body: '' }), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapter.commentPr({ target: 'acme/ard-sdk#7', body: '' }), READ_REASONS.MISSING_TARGET);
  await rejectsWith(adapter.createPr({ repo: 'acme/ard-sdk', head: 'feat/x', base: '', title: 't', body: 'b' }), READ_REASONS.MISSING_TARGET);
  assert.equal(runner.calls.length, 0);
});

test('写动作失败：非零退出 → COMMAND_FAILED（mayHaveSideEffect），超时 → COMMAND_TIMEOUT', async () => {
  const failing = adapterWith(fakeRunner(() => ({ exitCode: 4, stdout: '', stderr: 'HTTP 404: Not Found', durationMs: 5, timedOut: false })));
  await assert.rejects(failing.createIssue({ repo: 'acme/ard-sdk', title: 't', body: 'b' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_FAILED);
    assert.equal(error.detail.exitCode, 4);
    assert.equal(error.detail.mayHaveSideEffect, true);
    assert.match(error.message, /404/);
    return true;
  });

  const timingOut = adapterWith(fakeRunner(() => ({ exitCode: null, stdout: '', stderr: '', durationMs: 20000, timedOut: true })));
  await assert.rejects(timingOut.commentPr({ target: 'acme/ard-sdk#7', body: '结论' }), (error) => {
    assert.equal(error.code, READ_REASONS.COMMAND_TIMEOUT);
    assert.match(error.message, /不得重放/);
    return true;
  });
});

test('仓库/目标格式非法 → MISSING_TARGET 且零调用（argv 不接受可疑令牌）', async () => {
  const runner = fakeRunner();
  const adapter = adapterWith(runner);
  // 2..3 段是合法引用；4 段、1 段、空段、连字符开头、含空格一律拒（拒收位由四段顶上）。
  for (const repo of ['', 'acme', 'acme/demo/x/y', '--repo', '-bad/x', 'acme demo', 'acme /demo', 'acme//demo']) {
    await rejectsWith(adapter.readRepository({ repo }), READ_REASONS.MISSING_TARGET);
    await rejectsWith(adapter.createIssue({ repo, title: 't', body: 'b' }), READ_REASONS.MISSING_TARGET);
  }
  for (const target of [
    undefined, '', 'abc', 'acme/demo#x', 'acme/demo#12 extra', 'acme/demo/x/y#12',
    // 链接命名空间同样只放宽到 3 段：四段仍拒。
    'https://git.example/acme/group/demo/x/issues/1',
  ]) {
    await rejectsWith(adapter.readIssue({ target }), READ_REASONS.MISSING_TARGET);
    await rejectsWith(adapter.readPr({ target }), READ_REASONS.MISSING_TARGET);
  }
  assert.equal(runner.calls.length, 0);
});

test('三段仓库引用 org/group/repo 被接受，argv 一字不改（只放宽段数，不拆参）', async () => {
  const runner = fakeRunner((input) => {
    const stdout = input.args[0] === 'repo'
      ? JSON.stringify({ path_with_namespace: 'acme/group/demo', updatedAt: '2026-10-27T08:00:00Z' })
      : input.args[1] === 'create'
        ? 'https://git.example/acme/group/demo/issues/12'
        : '[]';
    return okWith(stdout)();
  });
  const adapter = adapterWith(runner);

  const read = await adapter.readRepository({ repo: 'acme/group/demo' });
  assert.deepEqual(runner.calls[0].args, ['repo', 'view', 'acme/group/demo', '--json', GH_REPO_FIELDS.join(',')]);
  assert.equal(read.object.repo, 'acme/group/demo', '完整路径不折叠');
  assert.equal(read.object.owner, 'acme/group', 'owner 是最后一段之前的完整前缀');
  assert.equal(read.object.name, 'demo');

  await adapter.createIssue({ repo: 'acme/group/demo', title: 't', body: 'b' });
  assert.deepEqual(runner.calls[1].args, [
    'issue', 'create', '-R', 'acme/group/demo', '--title', 't', '--body', 'b',
  ]);
  await adapter.listOpenIssues({ repo: 'acme/group/demo' });
  assert.deepEqual(runner.calls[2].args.slice(0, 5), ['issue', 'list', '-R', 'acme/group/demo', '--state']);
});

test('三段目标：org/group/repo#n 与三段命名空间的 Issue/PR 链接都原样作为位置参数', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ number: 12, updatedAt: '2026-10-27T10:00:00Z' })));
  const adapter = adapterWith(runner);
  await adapter.readIssue({ target: 'acme/group/demo#12' });
  await adapter.readPr({ target: 'acme/group/demo!7' });
  await adapter.readIssue({ target: 'https://git.example/acme/group/demo/issues/12' });
  assert.deepEqual(runner.calls.map((call) => call.args[2]), [
    'acme/group/demo#12',
    'acme/group/demo!7',
    'https://git.example/acme/group/demo/issues/12',
  ]);
});

test('target 支持 owner/repo#n、纯编号与 Issue/PR 链接三种写法，均原样作为一个位置参数', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ number: 12, updatedAt: '2026-10-27T10:00:00Z' })));
  const adapter = adapterWith(runner);
  await adapter.readIssue({ target: 'acme/demo#12' });
  await adapter.readIssue({ target: '12' });
  await adapter.readIssue({ target: 'https://github.example/acme/demo/issues/12' });
  assert.deepEqual(runner.calls.map((call) => call.args[2]), [
    'acme/demo#12',
    '12',
    'https://github.example/acme/demo/issues/12',
  ]);
});

test('清单只回单个对象时按单元素处理（不读成空清单）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ number: 12, title: '单项', url: '', state: 'OPEN' })));
  const result = await adapterWith(runner).listOpenIssues({ repo: 'acme/demo' });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].number, 12);
});

test('原生包封 data.list + path_with_namespace：可见仓库如实列出（mock 夹具，非企业实测）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify(GITEE_REPO_LIST)));
  const result = await adapterWith(runner).listRepos({ owner: 'acme' });

  assert.deepEqual(runner.calls[0].args, ['repo', 'list', 'acme', '--limit', '100', '--json', GH_REPO_LIST_FIELDS.join(',')]);
  assert.equal(result.count, 2);
  assert.equal(result.items[0].repo, 'acme/group/demo', '三段路径不折叠');
  assert.equal(result.items[0].owner, 'acme/group');
  assert.equal(result.items[0].name, 'demo');
  assert.equal(result.items[1].repo, 'acme/points-mall', 'full_name 别名同样被吸收');
  assert.equal(result.items[1].owner, 'acme');
  assert.equal(result.source_revision, null, '清单是查询快照，不冻结事实版本');
});

test('data.list 为空数组 → 空清单，不回落成单元素（否则会凭空造一条脏仓库）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ data: { list: [] } })));
  const result = await adapterWith(runner).listRepos({ owner: 'acme' });
  assert.equal(result.count, 0);
  assert.deepEqual(result.items, []);
});

test('data.list 不是数组 → MALFORMED_RESULT（坏包封不当成一条记录）', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ data: { list: 'oops' } })));
  await rejectsWith(adapterWith(runner).listRepos({ owner: 'acme' }), READ_REASONS.MALFORMED_RESULT);
  assert.equal(runner.calls.length, 1, '命令已执行，失败发生在解析而不是前置校验');
});

test('清单包封的其余两级：data 直接是数组、items 数组都按清单解析', async () => {
  const direct = fakeRunner(okWith(JSON.stringify({ data: [{ number: 1, title: 'a' }] })));
  assert.equal((await adapterWith(direct).listOpenIssues({ repo: 'acme/demo' })).count, 1);

  const wrapped = fakeRunner(okWith(JSON.stringify({ items: [{ number: 2, title: 'b' }] })));
  const result = await adapterWith(wrapped).listOpenIssues({ repo: 'acme/demo' });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].number, 2);
});

test('单对象读解单键 { data: {...} } 包封：字段与版本取内层，无 updatedAt 时 source_revision 为 null', async () => {
  const runner = fakeRunner(okWith(JSON.stringify({ data: { path_with_namespace: 'acme/group/demo', description: '包封内的仓库' } })));
  const result = await adapterWith(runner).readRepository({ repo: 'acme/group/demo' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.source_revision, null);
  assert.equal(result.object.repo, 'acme/group/demo');
  assert.equal(result.object.description, '包封内的仓库');
  assert.equal(result.object.owner, 'acme/group');

  // 多键包装不猜：`{ data, meta }` 不是单键包封，照旧按原对象处理（不静默取内层）。
  const multi = fakeRunner(okWith(JSON.stringify({ data: { nameWithOwner: 'acme/demo' }, meta: { page: 1 } })));
  const kept = await adapterWith(multi).readRepository({ repo: 'acme/demo' });
  assert.equal(kept.object.repo, '', '多键包装不拆，保持"照旧"语义');
});

test('ghBin 缺省用固定名 gh（dop 没有默认值，gh 有）', async () => {
  const runner = fakeRunner(okWith('[]'));
  await createGhAdapter({ runner, now }).listOpenIssues({ repo: 'acme/demo' });
  assert.equal(runner.calls[0].bin, 'gh');
});

test('禁项通道不存在：合并/关闭/发版/流水线/通用接口/编辑删除', () => {
  const adapter = createGhAdapter({ runner: fakeRunner(), now });
  for (const forbidden of ['merge', 'close', 'release', 'workflow', 'api', 'delete', 'edit']) {
    assert.ok(!(forbidden in adapter), `gh 适配器不得有 ${forbidden} 通道（AC-19）`);
  }
  const values = Object.values(GH_COMMANDS);
  assert.equal(values.length, 10);
  for (const argv of values) {
    assert.ok(Object.isFrozen(argv));
    assert.ok(['repo', 'issue', 'pr'].includes(argv[0]));
    assert.ok(['view', 'list', 'create', 'comment'].includes(argv[1]));
  }
  const pairs = values.map((argv) => argv.join(' '));
  for (const banned of ['pr merge', 'pr close', 'issue close', 'issue delete', 'pr edit', 'release', 'workflow', 'api']) {
    assert.ok(!pairs.includes(banned), `命令面不得包含 ${banned}`);
  }
});
