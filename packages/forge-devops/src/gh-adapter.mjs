/**
 * `@heluo/forge-devops` 的 gh 适配器：仓库 / Issue / PR 事实与动作的唯一出口（T2）。
 *
 * 三层职责里本模块只负责中间那层：**固定 argv**（有没有这条命令）+ **输出解析**。
 * "能不能做"归策略门禁（`policy-guard.mjs`），"该不该做、做完能否核对"归动作层
 * （`actions.mjs`：幂等键、创建前查重、创建后回读）。因此本模块的写操作只把
 * "命令退出码为 0"翻译成结果信封，**不声称事实已核对**；核对由调用方回读完成。
 *
 * 命令面（TECHNICAL §5.3，AC-19/AC-22），禁项在代码里不存在：
 *   repo view | repo list
 *   issue view/list/create/comment
 *   pr view/list/create/comment
 * 没有合并、关闭、发版、触发流水线、通用接口调用、编辑/删除通道，也没有
 * "把 argv 传进来"的通用入口：参数只来自本文件的白名单常量与字段校验。
 *
 * argv 约定：
 * - API 给的是 `repo` 参数（create/list）时用 `-R <repo>`（§5.3）。
 * - API 给的是单一 `target` 时，target 原样作为一个位置参数（gh 原生接受
 *   `owner/repo#12`、编号或 Issue/PR 链接）；不再拆成 `<n> -R <repo>`，因为 target
 *   已经带上仓库，拆参会重复并在 `issue comment` 上改变位置参数形状。
 *
 * 读信封与 `read.mjs` 的只读契约同形（`status` / `source_revision` / `observed_at` /
 * `result_refs`）：单对象读的版本取 gh 对象的 `updatedAt`；拿不到就置 `null`，由
 * `normalizeReadResult` 降级成 `unknown`——本模块不编造版本号。清单是查询快照，
 * 不冻结事实版本，`source_revision` 恒为 `null`，观测时间看 `observed_at`。
 */

import { DevopsReadError, READ_REASONS } from './read.mjs';

/** 允许的命令面（枚举到函数）。测试按此表逐条核对，表里没有的动词不存在。 */
export const GH_COMMANDS = Object.freeze({
  repositoryView: Object.freeze(['repo', 'view']),
  repositoryList: Object.freeze(['repo', 'list']),
  issueView: Object.freeze(['issue', 'view']),
  issueList: Object.freeze(['issue', 'list']),
  issueCreate: Object.freeze(['issue', 'create']),
  issueComment: Object.freeze(['issue', 'comment']),
  prView: Object.freeze(['pr', 'view']),
  prList: Object.freeze(['pr', 'list']),
  prCreate: Object.freeze(['pr', 'create']),
  prComment: Object.freeze(['pr', 'comment']),
});

/** `repo view` 的 JSON 字段：与 §5.3 逐字一致，不额外加推断字段。 */
export const GH_REPO_FIELDS = Object.freeze(['nameWithOwner', 'description', 'url', 'defaultBranchRef', 'isPrivate', 'updatedAt']);

/**
 * `repo list` 的 JSON 字段：比 `repo view` 多 `name` 与 `repositoryTopics`。
 * 输出会被归一成 `nameWithOwner/name/description/topics` —— 正是
 * `resolveBuildingRepository({ visibleRepos })` 直接可用的形状，候选判定不需要再转换一次。
 */
export const GH_REPO_LIST_FIELDS = Object.freeze(['nameWithOwner', 'name', 'description', 'repositoryTopics', 'url', 'isPrivate', 'updatedAt']);

/** Issue 读的字段：含 `comments`，写动作按正文哈希查重要用（§5.2）。 */
export const GH_ISSUE_FIELDS = Object.freeze(['number', 'title', 'state', 'url', 'updatedAt', 'labels', 'comments']);

/** PR 读的字段：含分支与草稿/合并时间，供"同分支已有 PR"与报告核对。 */
export const GH_PR_FIELDS = Object.freeze(['number', 'title', 'state', 'url', 'updatedAt', 'headRefName', 'baseRefName', 'isDraft', 'mergedAt', 'comments']);

/** 清单固定上限（§5.3）：不做分页推断，超出就问用户缩小范围。 */
export const GH_LIST_LIMIT = 100;

/** `--json` 为空时 gh 会输出人类可读文本，必须显式要字段；清单字段按 §5.3 逐字。 */
export const GH_ISSUE_LIST_FIELDS = Object.freeze(['number', 'title', 'url', 'state']);
export const GH_PR_LIST_FIELDS = Object.freeze(['number', 'title', 'url', 'headRefName', 'state']);

/** gh 的固定默认名（PATH 上的程序名，不是本机绝对路径）；dop 则没有默认值。 */
export const GH_DEFAULT_BIN = 'gh';
export const GH_LOGICAL_NAME = 'gh';

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_QUALIFIED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#\d{1,9}$/;
const TARGET_NUMBER_PATTERN = /^\d{1,9}$/;
// Issue/PR 链接：主机名不写死（企业版域名由调用方给），只认 <scheme>://<host>/<owner>/<repo>/(issues|pull)/<n> 结构。
const TARGET_LINK_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^\s/]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:issues|pull)\/\d{1,9}(?:[#?]\S*)?$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DIAGNOSTIC_LIMIT = 160;
const TEXT_LIMIT = 65536;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const token = (value) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

function clip(value, limit = DIAGNOSTIC_LIMIT) {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function failureLine(result) {
  const stderr = text(result?.stderr);
  if (stderr !== '') return clip(stderr.split('\n').find((line) => line.trim() !== ''));
  const stdout = text(result?.stdout);
  if (stdout !== '') return clip(stdout.split('\n').find((line) => line.trim() !== ''));
  return '无输出';
}

function fail(code, message, detail = {}) {
  throw new DevopsReadError(code, message, detail);
}

function assertRepo(repo) {
  const value = text(repo);
  if (value === '') fail(READ_REASONS.MISSING_TARGET, '缺少仓库（形如 owner/repo）', { field: 'repo' });
  if (!REPO_PATTERN.test(value)) {
    fail(READ_REASONS.MISSING_TARGET, `仓库格式非法：${clip(value, 60)}（必须是 owner/repo，且不以连字符开头）`, { field: 'repo' });
  }
  return value;
}

function assertTarget(target, { field = 'target' } = {}) {
  const value = text(target);
  if (value === '') fail(READ_REASONS.MISSING_TARGET, '缺少目标（形如 owner/repo#12、12 或 Issue/PR 链接）', { field });
  const accepted = TARGET_QUALIFIED_PATTERN.test(value) || TARGET_NUMBER_PATTERN.test(value) || TARGET_LINK_PATTERN.test(value);
  if (!accepted) {
    fail(READ_REASONS.MISSING_TARGET, `目标格式非法：${clip(value, 60)}（形如 owner/repo#12、编号或 Issue/PR 链接）`, { field });
  }
  return value;
}

function assertBranch(name, field) {
  const value = text(name);
  if (value === '') fail(READ_REASONS.MISSING_TARGET, `缺少 ${field} 分支名`, { field });
  if (!BRANCH_PATTERN.test(value) || value.includes('..')) {
    fail(READ_REASONS.MISSING_TARGET, `${field} 分支名非法：${clip(value, 60)}`, { field });
  }
  return value;
}

/** 标题/正文/评论：作为独立 argv 元素传递，不做引号转义；这里只挡空值与 NUL。 */
function assertFreeText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(READ_REASONS.MISSING_TARGET, `缺少 ${field}（写动作必须显式给出，不猜默认文案）`, { field });
  }
  if (value.includes('\u0000')) fail(READ_REASONS.MISSING_TARGET, `${field} 含 NUL 字符，拒绝作为 argv 传递`, { field });
  if (value.length > TEXT_LIMIT) fail(READ_REASONS.MISSING_TARGET, `${field} 超过 ${TEXT_LIMIT} 字符上限`, { field });
  return value;
}

function parseJson(stdout, context) {
  const raw = text(stdout);
  if (raw === '') fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 没有输出，无法解析 JSON`, context);
  try {
    return JSON.parse(raw);
  } catch {
    fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 输出不是合法 JSON：${clip(raw)}`, context);
  }
  return undefined;
}

function parseObject(stdout, context) {
  const parsed = parseJson(stdout, context);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 的 JSON 输出必须是对象`, context);
  }
  return parsed;
}

/**
 * 清单解析：正常是数组；命令只回一个对象时按单元素清单处理（不猜第二条，
 * 也不把"单条"读成"空清单"）。
 */
function parseList(stdout, context) {
  const parsed = parseJson(stdout, context);
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') return [parsed];
  fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 的 JSON 输出既不是数组也不是对象`, context);
  return [];
}

/** gh 对象的版本：`updatedAt`；没有就不编版本号（读层会降级 unknown）。 */
const revisionOf = (object) => {
  const updatedAt = text(asObject(object).updatedAt);
  return updatedAt === '' ? null : `gh:${updatedAt}`;
};

/** 仓库归一：输出即可直接作为 `visibleRepos` 元素交给承建判定。 */
function normalizeRepo(raw) {
  const source = asObject(raw);
  const owner = text(source.owner) || text(asObject(source.owner).login);
  const name = text(source.name);
  const nameWithOwner = text(source.nameWithOwner) || (owner !== '' && name !== '' ? `${owner}/${name}` : '');
  const flatTopics = asArray(source.topics).map((topic) => token(topic)).filter((topic) => topic !== '');
  const structuredTopics = asArray(source.repositoryTopics)
    .map((topic) => token(asObject(topic).name) || token(topic))
    .filter((topic) => topic !== '');
  return Object.freeze({
    repo: nameWithOwner,
    nameWithOwner,
    owner,
    name,
    description: text(source.description),
    url: text(source.url),
    isPrivate: source.isPrivate === true,
    defaultBranch: text(asObject(source.defaultBranchRef).name) || null,
    topics: flatTopics.length > 0 ? flatTopics : structuredTopics,
    updatedAt: text(source.updatedAt),
  });
}

function normalizeComments(raw) {
  return asArray(raw).map((entry) => {
    const comment = asObject(entry);
    return Object.freeze({
      id: token(comment.id) || null,
      body: typeof comment.body === 'string' ? comment.body : '',
      url: text(comment.url),
      author: text(asObject(comment.author).login) || null,
      createdAt: text(comment.createdAt) || null,
    });
  });
}

function normalizeWorkItem(raw) {
  const source = asObject(raw);
  const base = {
    number: Number.isInteger(source.number) ? source.number : null,
    title: text(source.title),
    state: text(source.state),
    url: text(source.url),
    updatedAt: text(source.updatedAt),
    comments: normalizeComments(source.comments),
  };
  return Object.freeze({
    ...base,
    headRefName: text(source.headRefName) || null,
    baseRefName: text(source.baseRefName) || null,
    isDraft: source.isDraft === true,
    mergedAt: text(source.mergedAt) || null,
  });
}

/**
 * 创建类命令的输出解析：真实 gh 打印对象链接，`--json` 形态给对象。
 * 两者都读不到引用就抛错（写入可能已经发生，故 `detail.mayHaveSideEffect` 为真，
 * 由动作层判 `unknown` 而不是重放）。
 */
function parseCreatedRef(stdout, context) {
  const raw = text(stdout);
  let parsed = null;
  if (raw.startsWith('{')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const object = asObject(parsed);
  const jsonNumber = Number.isInteger(object.number) ? object.number : null;
  const jsonUrl = text(object.url) || text(object.html_url);
  const lastLine = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? '';
  const linkMatch = lastLine.match(/(?:issues|pull)\/(\d{1,9})/);
  const looksLikeLink = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(lastLine) || lastLine.includes('github.com/');
  const url = jsonUrl !== '' ? jsonUrl : looksLikeLink ? lastLine : '';
  const number = jsonNumber ?? (linkMatch === null ? null : Number(linkMatch[1]));
  if (number === null && url === '') {
    fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 的输出里没有对象编号或链接：${clip(raw)}`, {
      ...context,
      mayHaveSideEffect: true,
    });
  }
  return { number, url: url === '' ? null : url, raw, parsed: object };
}

/** 评论类命令：解析到引用就带上，没有也不猜；是否需要核对由动作层回读决定。 */
function parseCommentRef(stdout, context) {
  const raw = text(stdout);
  let parsed = null;
  if (raw.startsWith('{')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const object = asObject(parsed);
  const lastLine = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? '';
  const looksLikeLink = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(lastLine) || lastLine.includes('github.com/');
  const url = text(object.url) || text(object.html_url) || (looksLikeLink ? lastLine : '');
  const fragment = url.match(/#(?:issuecomment|discussion_r)-?(\d{1,20})/);
  return {
    url: url === '' ? null : url,
    comment_id: fragment === null ? null : fragment[1],
    stdout: raw,
    context,
  };
}

/**
 * 创建 gh 适配器。
 * @param {{runner: {run: Function}, ghBin?: string, now?: () => string}} options
 */
export function createGhAdapter({ runner = null, ghBin = GH_DEFAULT_BIN, now = () => new Date().toISOString() } = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.run !== 'function') {
    throw new TypeError('createGhAdapter 需要可注入的 runner（{ run({bin,args,purpose}) }），不允许在适配器内自建子进程');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是返回 ISO 时间串的函数');

  const bin = text(ghBin) || GH_DEFAULT_BIN;
  const at = () => now();
  const labelOf = (args) => [GH_LOGICAL_NAME, ...args].join(' ');

  async function invoke({ args, purpose }) {
    const command = labelOf(args);
    const observedAt = at();
    const context = { command, observedAt };
    const result = await runner.run({ bin, args, purpose });
    if (result === null || typeof result !== 'object') {
      fail(READ_REASONS.MALFORMED_RESULT, `${command} 没有返回命令结果`, context);
    }
    if (result.timedOut === true) {
      fail(READ_REASONS.COMMAND_TIMEOUT, `${command} 超时：写入可能已生效，须回读核对，不得重放`, {
        ...context,
        timedOut: true,
        mayHaveSideEffect: true,
      });
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      const spawnFailed = result.exitCode === null || result.exitCode === undefined;
      fail(
        READ_REASONS.COMMAND_FAILED,
        `${command} 失败（${spawnFailed ? '未启动' : `退出码 ${result.exitCode}`}）：${failureLine(result)}`,
        {
          ...context,
          exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
          spawnFailed,
          mayHaveSideEffect: true,
        },
      );
    }
    return { result, context };
  }

  const readEnvelope = ({ context, target, object, raw, revision }) => ({
    status: 'succeeded',
    target_ref: target,
    source_revision: revision,
    observed_at: context.observedAt,
    result_refs: text(raw?.url) === '' ? [] : [text(raw.url)],
    command: context.command,
    object,
    raw,
  });

  return Object.freeze({
    /** `repo view <repo> --json …`：只读一个仓库的元数据。 */
    async readRepository({ repo } = {}) {
      const target = assertRepo(repo);
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.repositoryView, target, '--json', GH_REPO_FIELDS.join(',')],
        purpose: 'gh.repository.view',
      });
      const raw = parseObject(result.stdout, context);
      return readEnvelope({ context, target, object: normalizeRepo(raw), raw, revision: revisionOf(raw) });
    },

    /** `repo list <owner> --json …`：仓库候选的可见清单（承建判定的输入）。 */
    async listRepos({ owner } = {}) {
      const scope = text(owner);
      if (scope === '') {
        fail(READ_REASONS.MISSING_TARGET, '缺少仓库扫描范围（FORGE_DEVOPS_GH_OWNER 未配置），不做全量仓库猜测', {
          field: 'ghOwner',
          observedAt: at(),
        });
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scope)) {
        fail(READ_REASONS.MISSING_TARGET, `仓库扫描范围非法：${clip(scope, 60)}`, { field: 'ghOwner' });
      }
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.repositoryList, scope, '--limit', String(GH_LIST_LIMIT), '--json', GH_REPO_LIST_FIELDS.join(',')],
        purpose: 'gh.repository.list',
      });
      const items = parseList(result.stdout, context).map((entry) => normalizeRepo(entry));
      return {
        status: 'succeeded',
        target_ref: scope,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: [],
        command: context.command,
        items,
        count: items.length,
        truncated: result.truncated === true,
      };
    },

    /** `issue view <target> --json …`：只读一个 Issue（含评论，供写动作查重）。 */
    async readIssue({ target } = {}) {
      const ref = assertTarget(target);
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.issueView, ref, '--json', GH_ISSUE_FIELDS.join(',')],
        purpose: 'gh.issue.view',
      });
      const raw = parseObject(result.stdout, context);
      return readEnvelope({ context, target: ref, object: normalizeWorkItem(raw), raw, revision: revisionOf(raw) });
    },

    /** `pr view <target> --json …`：只读一个 PR。 */
    async readPr({ target } = {}) {
      const ref = assertTarget(target);
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.prView, ref, '--json', GH_PR_FIELDS.join(',')],
        purpose: 'gh.pr.view',
      });
      const raw = parseObject(result.stdout, context);
      return readEnvelope({ context, target: ref, object: normalizeWorkItem(raw), raw, revision: revisionOf(raw) });
    },

    /** `issue list -R <repo> --state open --limit 100 --json …`：幂等查重的 open Issue 清单。 */
    async listOpenIssues({ repo } = {}) {
      const target = assertRepo(repo);
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.issueList, '-R', target, '--state', 'open', '--limit', String(GH_LIST_LIMIT), '--json', GH_ISSUE_LIST_FIELDS.join(',')],
        purpose: 'gh.issue.list',
      });
      const items = parseList(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: target,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: [],
        command: context.command,
        items,
        count: items.length,
        truncated: result.truncated === true,
      };
    },

    /** `pr list -R <repo> --state open --limit 100 --json …`：同分支 / 同标题 PR 查重。 */
    async listOpenPrs({ repo } = {}) {
      const target = assertRepo(repo);
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.prList, '-R', target, '--state', 'open', '--limit', String(GH_LIST_LIMIT), '--json', GH_PR_LIST_FIELDS.join(',')],
        purpose: 'gh.pr.list',
      });
      const items = parseList(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: target,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: [],
        command: context.command,
        items,
        count: items.length,
        truncated: result.truncated === true,
      };
    },

    /** `issue create -R <repo> --title <t> --body <b>`：只发命令，不判断是否需要创建。 */
    async createIssue({ repo, title, body } = {}) {
      const target = assertRepo(repo);
      const safeTitle = assertFreeText(title, 'title');
      const safeBody = assertFreeText(body, 'body');
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.issueCreate, '-R', target, '--title', safeTitle, '--body', safeBody],
        purpose: 'gh.issue.create',
      });
      const created = parseCreatedRef(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: target,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: created.url === null ? [] : [created.url],
        command: context.command,
        number: created.number,
        url: created.url,
        stdout: created.raw,
      };
    },

    /** `issue comment <target> --body <b>`：评论正文由调用方给出并经门禁确认。 */
    async commentIssue({ target, body } = {}) {
      const ref = assertTarget(target);
      const safeBody = assertFreeText(body, 'body');
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.issueComment, ref, '--body', safeBody],
        purpose: 'gh.issue.comment',
      });
      const comment = parseCommentRef(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: ref,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: comment.url === null ? [] : [comment.url],
        command: context.command,
        url: comment.url,
        comment_id: comment.comment_id,
        stdout: comment.stdout,
      };
    },

    /** `pr create -R <repo> --head <h> --base <b> --title <t> --body <b>`：不带任何合并类 flag。 */
    async createPr({ repo, head, base, title, body } = {}) {
      const target = assertRepo(repo);
      const safeHead = assertBranch(head, 'head');
      const safeBase = assertBranch(base, 'base');
      const safeTitle = assertFreeText(title, 'title');
      const safeBody = assertFreeText(body, 'body');
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.prCreate, '-R', target, '--head', safeHead, '--base', safeBase, '--title', safeTitle, '--body', safeBody],
        purpose: 'gh.pr.create',
      });
      const created = parseCreatedRef(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: target,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: created.url === null ? [] : [created.url],
        command: context.command,
        number: created.number,
        url: created.url,
        head: safeHead,
        base: safeBase,
        stdout: created.raw,
      };
    },

    /** `pr comment <target> --body <b>`：审查评论，文案必须先经人工确认（门禁 confirm）。 */
    async commentPr({ target, body } = {}) {
      const ref = assertTarget(target);
      const safeBody = assertFreeText(body, 'body');
      const { result, context } = await invoke({
        args: [...GH_COMMANDS.prComment, ref, '--body', safeBody],
        purpose: 'gh.pr.comment',
      });
      const comment = parseCommentRef(result.stdout, context);
      return {
        status: 'succeeded',
        target_ref: ref,
        source_revision: null,
        observed_at: context.observedAt,
        result_refs: comment.url === null ? [] : [comment.url],
        command: context.command,
        url: comment.url,
        comment_id: comment.comment_id,
        stdout: comment.stdout,
      };
    },
  });
}
