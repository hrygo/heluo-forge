/**
 * `@heluo/forge-gitee` 的 Gitee 适配器：命令面、`GITEE_*` 字段分表与 argv 白名单（TK3）。
 *
 * 与 `@heluo/forge-devops` 的 `gh-adapter.mjs` **同形不同表**（AC-12）：不 import 对方的任何
 * 符号，也不复用 `GH_*` 常量；provider 由本文件常量与 `gitee.*` 动作名声明，字段名按 Gitee
 * 语义的 snake_case 重写。共享的是"不变量"（固定 argv、固定字段子集、只把退出码翻译成
 * 事实、禁项在代码里不存在），对齐靠契约用例而不是共享代码——PRD 非目标禁止改写 devops。
 *
 * 三层职责里本模块只负责中间那层：**argv 构造**（有没有这条命令、参数是否在白名单里）与
 * **输出归一**（字段表逐字取，取不到就记 `missing_fields`，绝不猜）。
 * "能不能做"归策略门禁（`gitee-guard.mjs`），"做完能否核对"归动作层（`gitee-actions.mjs`：
 * 幂等、回读、四状态）。因此这里不会声称"写成功"，只把命令结果翻译成事实。
 *
 * 四条硬约束（AC-14/AC-23）：
 * 1. 命令面是**枚举**：`GITEE_COMMANDS` 里没有的动词不存在；禁项（`pr merge`/`pr close`/
 *    `issue close`/`release`/`workflow`/`api`/`auth`/`config`/`gist`/`repo delete|create`）
 *    连表都进不来，另有一道 argv 结构扫描做纵深防御。
 * 2. 参数只来自本文件的表：`assertArgv` 先校验再拼 argv，**越界即抛错且零子进程**；不接受
 *    命令行字符串、不接受 argv 数组、不接受 `bin`/`args`/`purpose` 之类的"透传键"。
 * 3. 只有 `--json` 声明的字段子集能出现在 argv 里，`GITEE_FORBIDDEN_FIELDS`
 *    （`mergedAt`/`statusCheckRollup` 等 GitHub 语义）**请求即失败、返回即降级**。
 * 4. 本模块不建子进程：`runner` 由 `gitee-cli.mjs` 的唯一 `execFile` 出口注入；这里连
 *    `child_process` 都不 import。
 *
 * F1（企业 CLI 的 `--json` 字段集合未验）的收缩策略（TECHNICAL §4.2）：字段表是本文件唯一
 * 副本，实测不符时只改这一处；取不到的字段记 `missing_fields` 并置 `null`；`source_revision`
 * 取不到则整条降级 `unknown`（`MISSING_SOURCE_REVISION`），不编版本号。
 */

/** provider 常量：信封、工具返回、动作名都靠它自证来源，不从调用点推断（AC-12）。 */
export const GITEE_PROVIDER = 'gitee';

/**
 * provider 的逻辑名（诊断标签前缀），不是可执行文件名：可执行文件来自配置 `cliPath`
 * （缺省 `gh`，见 `runtime-config.mjs` 的 `DEFAULT_CLI_PATH`，PATH 解析、不写绝对路径）。
 */
export const GITEE_LOGICAL_NAME = 'gitee';

/** 清单固定上限（§5.3）：不做分页推断，超出就问用户缩小范围。 */
export const GITEE_LIST_LIMIT = 100;

/**
 * 允许的命令面（枚举到 argv 动词）。表里没有的动词在本包里不存在：合并、关闭、发版、
 * 触发流水线、通用接口调用、编辑/删除通道都没有入口（AC-23）。
 */
export const GITEE_COMMANDS = Object.freeze({
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

/**
 * `repo view` 的 JSON 字段：Gitee 语义（snake_case），逐字取自 TECHNICAL §4.2，不额外加推断字段。
 *
 * 注意与 devops 的同位表不同名也不同形：`nameWithOwner`/`isPrivate`/`defaultBranchRef`/
 * `updatedAt` 是 GitHub 语义，本包一个都不认（AC-12）。
 */
export const GITEE_REPO_FIELDS = Object.freeze(['name', 'path', 'description', 'url', 'default_branch', 'private', 'updated_at']);

/** `repo list` 的 JSON 字段：比 `repo view` 少 `description`/`default_branch`，多用于列表展示的 `updated_at`。 */
export const GITEE_REPO_LIST_FIELDS = Object.freeze(['name', 'path', 'url', 'private', 'updated_at']);

/** Issue 读的字段：含 `comments`，写动作按正文查重要用。 */
export const GITEE_ISSUE_FIELDS = Object.freeze(['number', 'title', 'state', 'url', 'updated_at', 'labels', 'comments']);

/** `issue list` 的字段：清单只取识别项所需，状态与链接够用。 */
export const GITEE_ISSUE_LIST_FIELDS = Object.freeze(['number', 'title', 'url', 'state']);

/** PR 读的字段：含分支、草稿与可合并标记；**不含**合并时间（合并态不在本包判定范围内）。 */
export const GITEE_PR_FIELDS = Object.freeze(['number', 'title', 'state', 'url', 'updated_at', 'head', 'base', 'draft', 'mergeable', 'comments']);

/** `pr list` 的字段：清单取识别项 + 头分支（判"同分支已有 PR"）。 */
export const GITEE_PR_LIST_FIELDS = Object.freeze(['number', 'title', 'url', 'head', 'state']);

/**
 * GitHub 语义字段的黑名单（AC-12）：请求即 `JSON_FIELD_NOT_DECLARED`，返回即整条降级
 * `unknown`（`MIXED_PROVIDER_FIELDS`）。列在这里的名字**永远**不会出现在任何 `GITEE_*` 表里。
 */
export const GITEE_FORBIDDEN_FIELDS = Object.freeze([
  'mergedAt',
  'merged_at',
  'statusCheckRollup',
  'checks',
  'reviewDecision',
  'autoMergeRequest',
]);

/**
 * 每个命令允许的 argv 参数，**按实际发命令行顺序**排列（表即真源，`argvFor` 照抄）。
 *
 * 目标（`target`）的落位规则：
 * - 单对象命令（`repo|issue|pr view`、`issue|pr comment`、`repo list`）走**位置参数**——
 *   target 已经带上仓库，不再拆成 `<n> -R <repo>`（拆参会在 `issue comment` 上改变位置参数形状）；
 * - 仓库作用域的集合/创建命令（`issue|pr list|create`）走 `-R <target>`：AC-14 把
 *   `--repo`/`-R` 列为有限参数，而 §5.3 的参数列只列了读写差异项。**F1 未验**（企业 CLI 的
 *   argv 形状未联调），若实测不符只改本表与 `GITEE_COMMANDS` 两处（TECHNICAL R-1）。
 * - `--host` 是声明过的有限参数（AC-14），但默认只读路径**不**注入它：`host` 经 `GH_HOST`
 *   环境变量（runner 的 env 白名单）生效，避免"看着配了其实没生效"（TECHNICAL R-5）。
 */
export const GITEE_ARGV_FLAGS = Object.freeze({
  repositoryView: Object.freeze(['--json', '--host']),
  repositoryList: Object.freeze(['--json', '--limit']),
  issueView: Object.freeze(['--json', '--host']),
  issueList: Object.freeze(['-R', '--json', '--state', '--limit']),
  issueCreate: Object.freeze(['-R', '--title', '--body']),
  issueComment: Object.freeze(['--body']),
  prView: Object.freeze(['--json', '--host']),
  prList: Object.freeze(['-R', '--json', '--state', '--limit']),
  prCreate: Object.freeze(['-R', '--title', '--body', '--head', '--base', '--draft']),
  prComment: Object.freeze(['--body']),
});

/**
 * 每个读命令的 `--json` 子集：与字段表**同一对象**（不是抄一份），所以"表改了子集跟着改"，
 * 不存在两处漂移。写命令没有 `--json`（输出是人类文本，由解析器取编号/链接）。
 */
export const GITEE_JSON_SUBSETS = Object.freeze({
  repositoryView: GITEE_REPO_FIELDS,
  repositoryList: GITEE_REPO_LIST_FIELDS,
  issueView: GITEE_ISSUE_FIELDS,
  issueList: GITEE_ISSUE_LIST_FIELDS,
  prView: GITEE_PR_FIELDS,
  prList: GITEE_PR_LIST_FIELDS,
});

/** 不带值、出现即为真的开关参数（`pr create --draft`）。 */
const BOOLEAN_FLAGS = Object.freeze(['--draft']);

/** 走位置参数的命令（其余仓库作用域命令用 `-R`）。 */
const POSITIONAL_TARGET_COMMANDS = Object.freeze([
  'repositoryView',
  'repositoryList',
  'issueView',
  'issueComment',
  'prView',
  'prComment',
]);

/** 必填参数：缺一个就拒绝，而不是让 CLI 报错（那样会先起子进程）。 */
const REQUIRED_PARAMS = Object.freeze({
  issueCreate: Object.freeze(['title', 'body']),
  prCreate: Object.freeze(['title', 'body', 'head', 'base']),
  issueComment: Object.freeze(['body']),
  prComment: Object.freeze(['body']),
});

/**
 * 禁项（AC-23）：任何位置出现即拒绝且零子进程。表里本来就拼不出这些动词，这里再挡一层，
 * 让"以后有人往表里加动词"必须先撞红这道门。
 */
export const GITEE_FORBIDDEN_VERBS = Object.freeze([
  Object.freeze(['pr', 'merge']),
  Object.freeze(['pr', 'close']),
  Object.freeze(['pr', 'review', '--approve']),
  Object.freeze(['issue', 'close']),
  Object.freeze(['issue', 'delete']),
  Object.freeze(['repo', 'delete']),
  Object.freeze(['repo', 'create']),
  Object.freeze(['release']),
  Object.freeze(['workflow']),
  Object.freeze(['api']),
  Object.freeze(['auth']),
  Object.freeze(['config']),
  Object.freeze(['gist']),
]);

/** 声明之外的参数一律不进 argv（`--web`/`--template`/`-f`/`--raw-field` 属 AC-14 明确拒绝项）。 */
export const GITEE_FORBIDDEN_FLAGS = Object.freeze([
  '--web',
  '--template',
  '-f',
  '--raw-field',
  '--field',
  '--input',
  '--body-file',
  '--method',
  '--approve',
  '--request-changes',
  '--merge',
  '--close',
  '--delete',
  '--admin',
  '--paginate',
  '--jq',
  '--hostname',
]);

/** 失败原因固定枚举（TECHNICAL §8.3）：自由文本只进 `message`，不新增枚举值。 */
export const ADAPTER_REASONS = Object.freeze({
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  MISSING_TARGET: 'MISSING_TARGET',
  ARG_NOT_WHITELISTED: 'ARG_NOT_WHITELISTED',
  JSON_FIELD_NOT_DECLARED: 'JSON_FIELD_NOT_DECLARED',
  ARG_INVALID: 'ARG_INVALID',
  ARG_MISSING: 'ARG_MISSING',
  FORBIDDEN_ARGV: 'FORBIDDEN_ARGV',
  AUTH_MISSING: 'AUTH_MISSING',
  GITEE_PERSISTENT_TOKEN: 'GITEE_PERSISTENT_TOKEN',
  TIMEOUT: 'TIMEOUT',
  NONZERO_EXIT: 'NONZERO_EXIT',
  SPAWN_FAILED: 'SPAWN_FAILED',
  UNSUPPORTED_FIELD: 'UNSUPPORTED_FIELD',
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  MIXED_PROVIDER_FIELDS: 'MIXED_PROVIDER_FIELDS',
  MISSING_SOURCE_REVISION: 'MISSING_SOURCE_REVISION',
  UNKNOWN_READ_ACTION: 'UNKNOWN_READ_ACTION',
});

/** 只读动作 → 命令族（`gitee.` 前缀是动作命名空间的证据，AC-12）。 */
const READ_ACTION_SUBJECTS = Object.freeze({
  'gitee.repository.read': 'repository',
  'gitee.issue.read': 'issue',
  'gitee.pr.read': 'pr',
});

/** 证据用途标签：审计里一眼看出是哪个逻辑动作发的子进程。 */
const PURPOSES = Object.freeze({
  repositoryView: 'gitee.repository.view',
  repositoryList: 'gitee.repository.list',
  issueView: 'gitee.issue.view',
  issueList: 'gitee.issue.list',
  issueCreate: 'gitee.issue.create',
  issueComment: 'gitee.issue.comment',
  prView: 'gitee.pr.view',
  prList: 'gitee.pr.list',
  prCreate: 'gitee.pr.create',
  prComment: 'gitee.pr.comment',
});

const STATE_VALUES = Object.freeze(['open', 'closed', 'all']);
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_QUALIFIED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#\d{1,9}$/;
const TARGET_NUMBER_PATTERN = /^\d{1,9}$/;
// Gitee 的 Issue/PR 链接：`/issues/<n>` 与 `/pulls/<n>`（GitHub 的 `/pull/<n>` 也认，只认结构不认域名）。
const TARGET_LINK_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^\s/]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:issues|issue|pulls|pull)\/\d{1,9}(?:[#?]\S*)?$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TITLE_LIMIT = 512;
const BODY_LIMIT = 65536;
const DIAGNOSTIC_LIMIT = 160;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const clip = (value, limit = DIAGNOSTIC_LIMIT) => {
  const flat = text(value).replace(/\s+/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/**
 * 适配器错误：带固定 `code`（可被 `gitee-read`/`gitee-actions` 直接映射成状态与 reason），
 * 以及 `detail.mayHaveSideEffect`——超时/非零退出意味着"远端可能已经变了"，调用方必须回读
 * 而不是重放（AC-16）。
 */
export class GiteeAdapterError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'GiteeAdapterError';
    this.code = code;
    this.provider = GITEE_PROVIDER;
    this.detail = Object.freeze({ provider: GITEE_PROVIDER, ...detail });
  }
}

const fail = (code, message, detail = {}) => {
  throw new GiteeAdapterError(code, message, detail);
};

/** 参数键 → argv 旗标（`--state` ← `state`；`-R` 由 `target` 提供）。 */
function allowedParamKeys(command) {
  const keys = new Set(['target']);
  for (const flag of GITEE_ARGV_FLAGS[command] ?? []) {
    if (flag === '-R') continue;
    keys.add(flag.slice(2));
  }
  return keys;
}

/** 归一 `--json` 入参：字符串按逗号切、数组照收，其余拒绝。 */
function normalizeJsonRequest(command, value) {
  const declared = GITEE_JSON_SUBSETS[command];
  if (declared === undefined) {
    fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受 --json`, { command, field: 'json' });
  }
  const requested = typeof value === 'string'
    ? value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    : Array.isArray(value)
      ? value
      : null;
  if (requested === null || requested.length === 0) {
    fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 json 必须是非空的字段名数组或逗号分隔字符串`, {
      command,
      field: 'json',
    });
  }
  const picked = [];
  for (const entry of requested) {
    const name = text(entry);
    if (name === '') {
      fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 json 含空字段名`, { command, field: 'json' });
    }
    if (GITEE_FORBIDDEN_FIELDS.includes(name) || !declared.includes(name)) {
      // GitHub 语义字段与"没声明过的字段"是同一类错误：都不许进 argv（AC-12/AC-14）。
      fail(ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED, `${command} 的 json 字段 "${name}" 未在本包声明`, {
        command,
        field: 'json',
        rejected: name,
        declared: [...declared],
      });
    }
    if (!picked.includes(name)) picked.push(name);
  }
  return picked;
}

/** 单个参数的取值校验：类型、边界、形状；**不回显值**（值里可能有人贴了凭据）。 */
function assertParamValue(command, flag, value) {
  const field = flag === '-R' ? 'target' : flag.slice(2);
  if (BOOLEAN_FLAGS.includes(flag)) {
    if (typeof value !== 'boolean') {
      fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 ${field} 只能是布尔值`, { command, field });
    }
    return value;
  }
  switch (flag) {
    case '-R':
      // 仓库作用域把 target 作为 `-R` 的值：形状校验与位置参数完全相同，只换落位。
      return assertTargetFor(command, value);
    case '--json':
      return normalizeJsonRequest(command, value).join(',');
    case '--state': {
      const state = text(value);
      if (!STATE_VALUES.includes(state)) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 state 必须是 ${STATE_VALUES.join('|')}`, {
          command,
          field,
          allowed: [...STATE_VALUES],
        });
      }
      return state;
    }
    case '--limit': {
      const raw = typeof value === 'number' ? value : (typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN);
      if (!Number.isInteger(raw) || raw < 1 || raw > GITEE_LIST_LIMIT) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 limit 必须是 1..${GITEE_LIST_LIMIT} 的整数`, {
          command,
          field,
          min: 1,
          max: GITEE_LIST_LIMIT,
        });
      }
      return String(raw);
    }
    case '--host': {
      const host = text(value);
      if (!HOST_PATTERN.test(host)) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 host 形状非法`, { command, field });
      }
      return host;
    }
    case '--title': {
      const title = typeof value === 'string' ? value.trim() : '';
      if (title === '' || title.length > TITLE_LIMIT || CONTROL_PATTERN.test(title) || title.startsWith('-')) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 title 必须是非空单行文本（≤${TITLE_LIMIT} 字符，不以 - 开头）`, {
          command,
          field,
        });
      }
      return title;
    }
    case '--body': {
      const body = typeof value === 'string' ? value.trim() : '';
      if (body === '' || body.length > BODY_LIMIT || body.startsWith('-')) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 body 必须是非空文本（≤${BODY_LIMIT} 字符，不以 - 开头）`, {
          command,
          field,
        });
      }
      return body;
    }
    case '--head':
    case '--base': {
      const branch = typeof value === 'string' ? value.trim() : '';
      if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.startsWith('-')) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 ${field} 不是合法分支名`, { command, field });
      }
      return branch;
    }
    default:
      fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受参数 ${flag}`, { command, field });
  }
}

/** 位置参数/`-R` 的 target 校验：按读动作区分"仓库"与"工作项"。 */
function assertTargetFor(command, value) {
  const target = typeof value === 'string' ? value.trim() : '';
  if (target === '') {
    fail(ADAPTER_REASONS.MISSING_TARGET, `${command} 缺少 target`, { command, field: 'target' });
  }
  const repoScoped = command === 'repositoryView' || command === 'repositoryList'
    || command === 'issueList' || command === 'prList'
    || command === 'issueCreate' || command === 'prCreate';
  const ok = repoScoped
    ? REPO_PATTERN.test(target) || TARGET_LINK_PATTERN.test(target)
    : REPO_PATTERN.test(target) || TARGET_QUALIFIED_PATTERN.test(target)
      || TARGET_NUMBER_PATTERN.test(target) || TARGET_LINK_PATTERN.test(target);
  if (!ok) {
    fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 target 不是仓库标识（owner/repo）或工作项引用`, {
      command,
      field: 'target',
    });
  }
  return target;
}

/** argv 结构扫描：任何以 `-` 开头的 token 都必须是本命令声明过的旗标（纵深防御）。 */
function assertNoForbiddenArgv(command, args) {
  const declared = new Set(GITEE_ARGV_FLAGS[command] ?? []);
  for (const token of args) {
    const word = text(token);
    if (word === '' || !word.startsWith('-')) continue;
    if (declared.has(word)) continue;
    if (GITEE_FORBIDDEN_FLAGS.includes(word)) {
      fail(ADAPTER_REASONS.FORBIDDEN_ARGV, `${command} 的 argv 含禁项 ${word}`, { command, rejected: word });
    }
    fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 的 argv 含未声明旗标 ${word}`, {
      command,
      rejected: word,
      allowed: [...declared],
    });
  }
  const verbs = GITEE_COMMANDS[command];
  const line = verbs.join(' ');
  for (const forbidden of GITEE_FORBIDDEN_VERBS) {
    if (line === forbidden.join(' ') || line.startsWith(`${forbidden.join(' ')} `)) {
      fail(ADAPTER_REASONS.FORBIDDEN_ARGV, `${command} 触及禁项 ${forbidden.join(' ')}`, {
        command,
        rejected: forbidden.join(' '),
      });
    }
  }
}

/**
 * 校验命令与参数并算出 argv：**唯一的参数入口**（AC-14）。
 *
 * 顺序固定：未知命令 → 参数形状（必须键值对象）→ 键白名单 → 必填 → 逐个取值校验 → 拼 argv
 * → argv 结构扫描。任一步失败都在触碰 runner 之前抛出，因此"越界参数零子进程"是结构性保证，
 * 而不是靠调用方自律。
 *
 * @param {string} command `GITEE_COMMANDS` 的键
 * @param {object} params 只接受表里声明过的键；字符串/数组（命令行字符串、argv 数组）一律拒绝
 * @returns {{command: string, words: readonly string[], args: readonly string[], target: string}}
 */
export function assertArgv(command, params = {}) {
  const words = GITEE_COMMANDS[command];
  if (words === undefined) {
    fail(ADAPTER_REASONS.UNKNOWN_COMMAND, `"${String(command)}" 不是本包的子命令`, {
      command: String(command),
      commands: Object.keys(GITEE_COMMANDS),
    });
  }
  if (!isPlainObject(params)) {
    fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的参数必须是键值对象；不接受命令行字符串或 argv 数组`, { command });
  }
  const allowed = allowedParamKeys(command);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受参数 "${key}"`, {
        command,
        field: key,
        allowed: [...allowed],
      });
    }
  }
  const required = REQUIRED_PARAMS[command] ?? [];
  const missing = required.filter((key) => params[key] === undefined);
  if (missing.length > 0) {
    fail(ADAPTER_REASONS.ARG_MISSING, `${command} 缺少必填参数：${missing.join(', ')}`, { command, missing });
  }
  const target = assertTargetFor(command, params.target);
  const positional = POSITIONAL_TARGET_COMMANDS.includes(command);
  const args = [...words];
  if (positional) args.push(target);
  for (const flag of GITEE_ARGV_FLAGS[command]) {
    const value = flag === '-R' ? target : params[flag.slice(2)];
    if (value === undefined) continue;
    const safe = assertParamValue(command, flag, value);
    if (BOOLEAN_FLAGS.includes(flag)) {
      if (safe === true) args.push(flag);
      continue;
    }
    args.push(flag, safe);
  }
  assertNoForbiddenArgv(command, args);
  return Object.freeze({ command, words, args: Object.freeze(args), target });
}

/**
 * argv 构造的薄壳：`argvFor('issueList', { target:'g/r', state:'open' })`
 * → `['issue','list','-R','g/r','--state','open',…]`（`--json` 显式要字段，否则 CLI 输出人类文本）。
 */
export function argvFor(command, params = {}) {
  return assertArgv(command, params).args;
}

/** 读动作 → 命令。`kind:'list'` 时用 `*List`，否则 `*View`；动作名可带/不带 `gitee.` 前缀。 */
function commandForReadAction(action, kind) {
  const name = text(action);
  const key = name.startsWith(`${GITEE_PROVIDER}.`) ? name : `${GITEE_PROVIDER}.${name}`;
  const subject = READ_ACTION_SUBJECTS[key];
  if (subject === undefined) {
    fail(ADAPTER_REASONS.UNKNOWN_READ_ACTION, `"${String(action)}" 不是本包的只读动作`, {
      action: String(action),
      actions: Object.keys(READ_ACTION_SUBJECTS),
    });
  }
  return { key, command: `${subject}${kind === 'list' ? 'List' : 'View'}` };
}

/** 解析 JSON 输出：解析不动就是畸形结果，不拿自由文本当事实。 */
function parseJsonOutcome(stdout, command, expected) {
  const raw = text(stdout);
  if (raw === '') {
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 没有输出 JSON（期望 ${expected}）`, { command });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出不是合法 JSON`, { command });
  }
  if (expected === 'array') {
    if (Array.isArray(parsed)) return parsed;
    if (isPlainObject(parsed) && Array.isArray(parsed.items)) return parsed.items;
    if (isPlainObject(parsed) && Array.isArray(parsed.data)) return parsed.data;
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出不是数组`, { command });
  }
  if (isPlainObject(parsed)) return parsed;
  fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出不是对象`, { command });
}

/** 递归找禁用字段（AC-12）：命中即整条降级，绝不拿 GitHub 语义推断 Gitee 状态。 */
function findForbiddenField(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (GITEE_FORBIDDEN_FIELDS.includes(key)) return key;
    const nested = findForbiddenField(child, seen, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** 按字段表逐字取；取不到的键置 `null` 并记进 `missing_fields`（不猜、不省略）。 */
function pickFields(raw, fields) {
  const object = {};
  const missing = [];
  for (const field of fields) {
    if (raw[field] === undefined) {
      object[field] = null;
      missing.push(field);
    } else {
      object[field] = raw[field];
    }
  }
  return { object, missing };
}

/**
 * 构造 Gitee 适配器。
 *
 * @param {object} options
 * @param {{run: ({bin: string, args: string[], purpose: string}) => Promise<object>}} options.runner
 *   唯一子进程出口（`gitee-cli.mjs`），本模块不自建子进程
 * @param {string} [options.cliPath] 可执行文件名或路径；缺省 `gh`（PATH 解析，不写绝对路径）
 * @param {string} [options.host] 企业 Gitee 域名（只做诊断与 `--host` 显式参数，默认不注入 argv）
 * @param {string|string[]} [options.authEnv] 承载令牌的环境变量名，缺省 `GH_TOKEN`
 * @param {(() => string)} [options.now] 时间源（测试可注入固定时钟）
 * @param {object} [options.env] 环境变量来源（令牌只从这里取，缺省 `process.env`）
 * @param {(() => boolean)} [options.persistentTokenProbe]
 *   持久令牌探测（由配置/CLI 层注入的文件系统探测；本模块只负责判定与给出固定 reason）
 */
export function createGiteeAdapter({
  runner = null,
  cliPath = 'gh',
  host = '',
  authEnv = 'GH_TOKEN',
  now = () => new Date().toISOString(),
  env = process.env,
  persistentTokenProbe = null,
} = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.run !== 'function') {
    throw new TypeError('createGiteeAdapter 需要可注入的 runner（{ run({bin,args,purpose}) }），不允许在适配器内自建子进程');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是返回 ISO 时间串的函数');
  if (persistentTokenProbe !== null && typeof persistentTokenProbe !== 'function') {
    throw new TypeError('persistentTokenProbe 必须是返回布尔值的函数');
  }

  const bin = text(cliPath) || 'gh';
  const at = () => now();
  const labelOf = (args) => [GITEE_LOGICAL_NAME, ...args].join(' ');
  const authNames = Object.freeze(
    (Array.isArray(authEnv) ? authEnv : [authEnv]).map((entry) => text(entry)).filter((entry) => entry !== ''),
  );
  const source = isPlainObject(env) ? env : {};
  const tokenValues = () => authNames
    .map((name) => (typeof source[name] === 'string' ? source[name].trim() : ''))
    .filter((value) => value !== '');

  /** 令牌不进消息、不进 detail、不进 describe：出现在 stderr 里的也一并抹掉。 */
  const redact = (value, tokens = tokenValues()) => {
    let out = typeof value === 'string' ? value : '';
    for (const token of tokens) {
      if (token.length >= 8) out = out.split(token).join('[REDACTED]');
    }
    // 形如凭据的串一律抹掉（与 CLI 层的脱敏口径一致：令牌可能出现在 stderr 的任意位置）。
    return out.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|gitee_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]');
  };

  const failureLine = (outcome) => redact(clip(outcome?.stderr) || clip(outcome?.stdout));

  /**
   * preflight：令牌与持久令牌判定（AC-22）。**零子进程、不抛错、不返回令牌值**。
   *
   * 返回值固定形状：`{ ok, provider, reason, message, authEnv, tokenSource, host, mayHaveSideEffect:false }`。
   * 调用方（`gitee-actions.mjs` 的状态机：`admission → confirm → preflight → invoke`）按 `ok`
   * 决定拒绝，`reason` 直接进信封；`tokenSource ∈ {'env','none'}` 只说明来源，不含令牌本身。
   * 之所以"返回而不抛"：状态机要使拒绝可见（`denied` + 固定 reason），抛错会被上层当成
   * 未知异常，反而丢掉"为什么拒绝"。
   *
   * `persistentTokenProbe` 由配置/CLI 层注入（探测配置目录里的持久凭据文件）；探测到即拒绝，
   * 因为凭据必须只来自环境变量，文件里的令牌会让"这次用的是谁的令牌"不可审计。
   */
  function preflight() {
    const tokens = tokenValues();
    const base = {
      provider: GITEE_PROVIDER,
      authEnv: [...authNames],
      host: text(host) || null,
      mayHaveSideEffect: false,
    };
    if (persistentTokenProbe !== null && persistentTokenProbe() === true) {
      return Object.freeze({
        ...base,
        ok: false,
        reason: ADAPTER_REASONS.GITEE_PERSISTENT_TOKEN,
        message: '检测到 CLI 配置目录存在持久令牌：请改用环境变量注入后重启；本包不读不写该文件',
        tokenSource: tokens.length === 0 ? 'none' : 'env',
      });
    }
    if (tokens.length === 0) {
      return Object.freeze({
        ...base,
        ok: false,
        reason: ADAPTER_REASONS.AUTH_MISSING,
        message: `缺少令牌环境变量（${authNames.join('|') || '未配置'}）：本包只从环境变量读取，缺令牌即拒绝`,
        tokenSource: 'none',
      });
    }
    return Object.freeze({ ...base, ok: true, reason: null, message: '', tokenSource: 'env' });
  }

  /**
   * 发一条命令：先 `assertArgv`（越界即抛、零子进程），再把命令结果翻译成事实。
   *
   * 不抛"成功/失败以外"的东西：超时 → `TIMEOUT`（`mayHaveSideEffect: true`，须回读不得重放）；
   * 非零退出 → `NONZERO_EXIT`（stderr 说字段不支持时是 `UNSUPPORTED_FIELD`）；起不来 →
   * `SPAWN_FAILED`。只有调用方代码写错（未知命令、越界参数）才是"先抛"的那一类。
   */
  async function invoke(command, params = {}, purpose = '') {
    const plan = assertArgv(command, params);
    const label = labelOf(plan.args);
    const observedAt = at();
    const reason = text(purpose) || PURPOSES[command] || `${GITEE_PROVIDER}.${command}`;
    const outcome = await runner.run({ bin, args: [...plan.args], purpose: reason });
    if (!isPlainObject(outcome)) {
      fail(ADAPTER_REASONS.MALFORMED_RESULT, `${label} 没有返回命令结果`, { command, purpose: reason });
    }
    if (outcome.timedOut === true) {
      fail(ADAPTER_REASONS.TIMEOUT, `${label} 超时：远端可能已生效，须回读核对，不得重放`, {
        command,
        purpose: reason,
        observedAt,
        timedOut: true,
        mayHaveSideEffect: true,
      });
    }
    if (!Number.isInteger(outcome.exitCode) || outcome.exitCode !== 0) {
      const spawned = outcome.exitCode !== null && outcome.exitCode !== undefined;
      const line = failureLine(outcome);
      const unsupported = /unknown field|unsupported field|invalid field|no such field|invalid json/i.test(`${outcome?.stderr ?? ''}`);
      fail(
        unsupported ? ADAPTER_REASONS.UNSUPPORTED_FIELD : (spawned ? ADAPTER_REASONS.NONZERO_EXIT : ADAPTER_REASONS.SPAWN_FAILED),
        `${label} 失败（${spawned ? `退出码 ${outcome.exitCode}` : '未启动'}）${line === '' ? '' : `：${line}`}`,
        {
          command,
          purpose: reason,
          observedAt,
          exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
          mayHaveSideEffect: true,
        },
      );
    }
    return Object.freeze({
      provider: GITEE_PROVIDER,
      command,
      label,
      args: Object.freeze([...plan.args]),
      purpose: reason,
      stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
      exitCode: 0,
      observedAt,
      truncated: outcome.truncated === true,
    });
  }

  /**
   * 只读动作（AC-12/AC-15 的适配器侧）：`read('gitee.issue.read', target, { list, state, limit, json })`。
   *
   * 返回**事实**而不是完整信封（信封由 `gitee-read.mjs` 归一）：`status` 只有
   * `succeeded`/`unknown`，`source_revision` 取不到就 `null` 并由 `error_code` 说明原因；
   * `missing_fields` 记录字段表里取不到的键。命令级失败（超时/非零退出）**抛错**，由读层归一。
   */
  async function read(action, target, params = {}) {
    const options = isPlainObject(params) ? params : null;
    if (options === null) {
      fail(ADAPTER_REASONS.ARG_INVALID, '只读参数必须是键值对象；不接受命令行字符串或 argv 数组', {
        action: String(action),
      });
    }
    for (const key of Object.keys(options)) {
      if (!['list', 'state', 'limit', 'json'].includes(key)) {
        fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `只读动作不接受参数 "${key}"`, {
          action: String(action),
          field: key,
          allowed: ['list', 'state', 'limit', 'json'],
        });
      }
    }
    if (options.list !== undefined && typeof options.list !== 'boolean') {
      fail(ADAPTER_REASONS.ARG_INVALID, 'list 只能是布尔值', { action: String(action), field: 'list' });
    }
    const kind = options.list === true ? 'list' : 'object';
    const { key: actionKey, command } = commandForReadAction(action, kind);
    const argvParams = { target };
    const acceptsState = (GITEE_ARGV_FLAGS[command] ?? []).includes('--state');
    if (kind === 'list') {
      argvParams.limit = options.limit === undefined ? GITEE_LIST_LIMIT : options.limit;
      if (options.state !== undefined && !acceptsState) {
        fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受 state（仓库清单没有状态维度）`, {
          action: actionKey,
          command,
          field: 'state',
        });
      }
      // 清单默认 `--state open`：与"当前需要处理的项"一致，显式传 all/closed 才扩大范围。
      if (acceptsState) argvParams.state = options.state === undefined ? 'open' : options.state;
    } else if (options.state !== undefined || options.limit !== undefined) {
      fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受 state/limit（只有清单动作有这两个参数）`, {
        action: actionKey,
        command,
        field: options.state !== undefined ? 'state' : 'limit',
      });
    }
    // `--json` 永远显式给出：省略时 CLI 会输出人类文本，解析不出来就只能算畸形结果。
    argvParams.json = options.json === undefined ? GITEE_JSON_SUBSETS[command] : options.json;

    const outcome = await invoke(command, argvParams, PURPOSES[command]);
    const declared = GITEE_JSON_SUBSETS[command];
    if (kind === 'list') {
      const items = parseJsonOutcome(outcome.stdout, outcome.label, 'array');
      const forbidden = findForbiddenField(items);
      const normalized = [];
      const missing = new Set();
      for (const entry of items) {
        const { object, missing: gaps } = pickFields(isPlainObject(entry) ? entry : {}, declared);
        for (const gap of gaps) missing.add(gap);
        normalized.push(object);
      }
      const degraded = forbidden !== null;
      return Object.freeze({
        provider: GITEE_PROVIDER,
        action: actionKey,
        kind: 'list',
        target_ref: text(target),
        status: degraded ? 'unknown' : 'succeeded',
        // 清单是查询快照，不冻结事实版本：`source_revision` 恒为 `null`，观测时间看 observed_at。
        source_revision: null,
        observed_at: outcome.observedAt,
        result_refs: Object.freeze([]),
        command: outcome.label,
        missing_fields: Object.freeze([...missing]),
        error_code: degraded ? ADAPTER_REASONS.MIXED_PROVIDER_FIELDS : null,
        rejected_field: forbidden,
        items: Object.freeze(normalized),
        count: normalized.length,
        truncated: outcome.truncated,
        raw: items,
      });
    }
    const raw = parseJsonOutcome(outcome.stdout, outcome.label, 'object');
    const forbidden = findForbiddenField(raw);
    const { object, missing } = pickFields(raw, declared);
    const revision = typeof raw.updated_at === 'string' && raw.updated_at.trim() !== '' ? raw.updated_at.trim() : null;
    const link = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : null;
    // 降级优先级：混入 GitHub 语义（不许推断）> 缺事实版本（不许编）。
    const errorCode = forbidden !== null
      ? ADAPTER_REASONS.MIXED_PROVIDER_FIELDS
      : (revision === null ? ADAPTER_REASONS.MISSING_SOURCE_REVISION : null);
    return Object.freeze({
      provider: GITEE_PROVIDER,
      action: actionKey,
      kind: 'object',
      target_ref: text(target),
      status: errorCode === null ? 'succeeded' : 'unknown',
      source_revision: revision,
      observed_at: outcome.observedAt,
      result_refs: Object.freeze(link === null ? [] : [link]),
      command: outcome.label,
      missing_fields: Object.freeze(missing),
      error_code: errorCode,
      rejected_field: forbidden,
      object: Object.freeze(object),
      raw,
    });
  }

  /** 脱敏描述：provider/命令面/令牌**来源**；不含令牌，也不含绝对路径（AC-22）。 */
  function describe() {
    const absolute = bin.includes('/') || bin.includes('\\');
    const name = absolute ? (bin.split(/[\\/]/).pop() || bin) : bin;
    return Object.freeze({
      provider: GITEE_PROVIDER,
      logicalName: GITEE_LOGICAL_NAME,
      cliPathKind: absolute ? 'absolute' : 'name',
      cliPathName: name,
      authEnv: [...authNames],
      tokenSource: tokenValues().length === 0 ? 'none' : 'env',
      host: text(host) || null,
      listLimit: GITEE_LIST_LIMIT,
      commands: Object.freeze(Object.keys(GITEE_COMMANDS)),
      readActions: Object.freeze(Object.keys(READ_ACTION_SUBJECTS)),
      jsonSubsets: Object.freeze(Object.keys(GITEE_JSON_SUBSETS)),
    });
  }

  return Object.freeze({
    provider: GITEE_PROVIDER,
    logicalName: GITEE_LOGICAL_NAME,
    preflight,
    invoke,
    read,
    describe,
  });
}
