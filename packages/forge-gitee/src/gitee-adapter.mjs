/**
 * `@heluo/forge-gitee` 的 Gitee 适配器：命令面、`GITEE_*` 字段投影清单与 argv 白名单（TK3）。
 *
 * 与 `@heluo/forge-devops` 的 `gh-adapter.mjs` **同形不同表**（AC-12）：不 import 对方的任何
 * 符号，也不复用 `GH_*` 常量；provider 由本文件常量与 `gitee.*` 动作名声明，字段名按企业
 * CLI 的实测输出逐字取。共享的是"不变量"（固定 argv、固定字段白名单、只把退出码翻译成
 * 事实、禁项在代码里不存在），对齐靠契约用例而不是共享代码——PRD 非目标禁止改写 devops。
 *
 * 三层职责里本模块只负责中间那层：**argv 构造**（有没有这条命令、参数是否在白名单里）与
 * **输出归一**（先按实测形状剥壳，再按投影清单逐字取；取不到就记 `missing_fields`，绝不猜）。
 * "能不能做"归策略门禁（`gitee-guard.mjs`），"做完能否核对"归动作层（`gitee-actions.mjs`：
 * 幂等、回读、四状态）。因此这里不会声称"写成功"，只把命令结果翻译成事实。
 *
 * 四条硬约束（AC-14/AC-23）：
 * 1. 命令面是**枚举**：`GITEE_COMMANDS` 里没有的动词不存在；禁项（`pr merge`/`pr close`/
 *    `issue close`/`release`/`workflow`/`api`/`auth`/`config`/`gist`/`repo delete|create`）
 *    连表都进不来，另有一道 argv 结构扫描做纵深防御。
 * 2. 参数只来自本文件的表：`assertArgv` 先校验再拼 argv，**越界即抛错且零子进程**；不接受
 *    命令行字符串、不接受 argv 数组、不接受 `bin`/`args`/`purpose` 之类的"透传键"。
 * 3. **`--json` 是无值开关，后面不接字段清单**（2026-11-03 实测：`repo view --json name,path`
 *    与裸 `repo view --json` 输出完全一样，逗号清单被忽略）。字段子集因此降级为**本地投影
 *    清单**：只决定归一后交付哪些键，永远不进 argv。投影名仍按白名单校验，越界即
 *    `JSON_FIELD_NOT_DECLARED` 且零子进程——白名单仍是唯一判据，不做"发出去再问 CLI"。
 * 4. 本模块不建子进程：`runner` 由 `gitee-cli.mjs` 的唯一 `execFile` 出口注入；这里连
 *    `child_process` 都不 import。
 *
 * 实测形状（2026-11-03，企业 Windows 机器上的 CLI，载荷进 `test/adapter.test.mjs` 当夹具）：
 * - `repo view --json`：扁平对象；**没有** `url`/`private`/`updated_at`——链接是 `web_url`、
 *   可见性是 `visibility`、全名在 `path_with_namespace`（`path` 只是仓库 slug），唯一时间事实
 *   是 `last_activity_at`；
 * - `issue list --json`：`{data:{list:[…]}, meta:{…}}`；编号字段是 `id`（**没有** `number`），
 *   清单项恰好 `description`/`id`/`labels`/`title`/`updated_at` 五个键；
 * - `pr list --json`：`{data:[…], meta:{…}}`；编号是 `iid`（`id` 是全局号），分支是
 *   `source_branch`/`target_branch`，可合并性是 `merge_status`，状态值是 `opened`；
 *   空列表不是 `data` 包裹，而是一行 `{"message":"No pull requests found."}`（规格 §4 第 5 条）。
 * `issue view`/`pr view`/`repo list` 的**字段投影**尚未按规格 §2.3/§2.4 重写（README 的
 * 未验第 1 条列了与本 CLI 实测字段的差异）：缺字段一律走 `missing_fields` 如实上报，不按
 * 别的平台的习惯补齐；`source_revision` 取不到就整条降级 `unknown`
 * （`MISSING_SOURCE_REVISION`），不编版本号。
 */

import {
  DEFAULT_PERSISTENT_TOKEN_POLICY,
  PERSISTENT_TOKEN_POLICIES,
} from './runtime-config.mjs';

/**
 * 平台常量：信封、工具返回、动作名都靠它自证来源，不从调用点推断（AC-12）。
 *
 * r10 把旧的「provider」措辞常量改名（值仍 `'gitee'`）：只有一个平台之后那个词只剩
 * 历史意义，信封与诊断里的字段名不变。本模块**不**从 `gitee-guard.mjs` 导入同值常量——
 * 适配器不能反向依赖策略层，`gitee.` 前缀由本文件自己声明。
 */
export const GITEE_PLATFORM = 'gitee';

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
 * `repo view` 的本地投影清单：逐字取自 2026-11-03 实测载荷。
 *
 * 注意与 devops 的同位表不同名也不同形：`nameWithOwner`/`isPrivate`/`defaultBranchRef`/
 * `updatedAt` 是 GitHub 语义，本包一个都不认（AC-12）。仓库载荷里没有 `url`/`private`/
 * `updated_at` 这三个常见名字，所以链接取 `web_url`、可见性取 `visibility`、全名取
 * `path_with_namespace`——把 GitHub 名字写进投影清单，只会让每个字段都掉进
 * `missing_fields`，那才是真正的"猜"。
 */
export const GITEE_REPO_FIELDS = Object.freeze([
  'name',
  'path',
  'path_with_namespace',
  'description',
  'default_branch',
  'visibility',
  'web_url',
  'last_activity_at',
  'archived',
  'ssh_url_to_repo',
  'http_url_to_repo',
]);

/**
 * `repo list` 的投影清单：`repo view` 去掉 `description`/`default_branch`（列表只用于识别），
 * 也去掉 `ssh_url_to_repo`（列表不需要远端地址）。`repo list` 的真实形状**未实测**。
 */
// `repo list` 的元素只有 9 个字段（规格 §2.3 实测），与 `repo view` 的完整对象**不是同一套**：
// 列表里没有 visibility/web_url/archived/path，链接字段叫 http_url/ssh_url（没有 `_to_repo` 后缀）。
export const GITEE_REPO_LIST_FIELDS = Object.freeze([
  'created_at',
  'description',
  'fork_from_path',
  'http_url',
  'id',
  'last_activity_at',
  'name',
  'path_with_namespace',
  'ssh_url',
]);

/**
 * Issue 读的投影清单：编号字段是 `id`（实测**没有** `number`），正文是 `description`
 * （实测是 HTML 片段），链接是 `web_url`。`issue view` 的真实形状未实测。
 */
// issue **详情**的字段集与列表元素不是同一套（规格 §2.4「issue view --json 恰好 8 字段」）：
// 详情里 `id` 是字符串键（如 `I2N6`），没有 `updated_at`/`web_url`，多出 `author`/`priority`。
export const GITEE_ISSUE_FIELDS = Object.freeze([
  'author',
  'created_at',
  'description',
  'id',
  'labels',
  'priority',
  'state',
  'title',
]);

/**
 * `issue list` 的投影清单：2026-11-03 实测清单项**恰好**这五个键（规格 §2.4）。
 *
 * 此前表里写着 `state`/`web_url` 而丢掉了 `description`/`labels`：清单载荷根本没有前两个，
 * 于是每一行都掉进 `missing_fields`，真正存在的两个反而交付不出去。表按载荷逐字对。
 */
export const GITEE_ISSUE_LIST_FIELDS = Object.freeze([
  'description',
  'id',
  'labels',
  'title',
  'updated_at',
]);

/**
 * PR 读的投影清单：编号是 `iid`（`id` 是 671766 这类全局号，对不上 URL 里的 2），分支是
 * `source_branch`/`target_branch`，可合并性是 `merge_status`，评论数是 `user_notes_count`。
 * `pr view` 的真实形状未实测。
 */
export const GITEE_PR_FIELDS = Object.freeze([
  'iid',
  'title',
  'state',
  'web_url',
  'updated_at',
  'source_branch',
  'target_branch',
  'merge_status',
  'merged_at',
  'user_notes_count',
]);

/** `pr list` 的投影清单：识别项 + 头/目标分支（判"同分支已有 PR"）与可合并性。 */
export const GITEE_PR_LIST_FIELDS = Object.freeze([
  'iid',
  'title',
  'state',
  'web_url',
  'source_branch',
  'target_branch',
  'merge_status',
]);

/**
 * 单个对象读的**事实版本**字段（`source_revision`）。
 *
 * Issue/PR 取 `updated_at`；仓库实测没有 `updated_at`，CLI 给出的唯一时间事实是
 * `last_activity_at`，因此仓库以它作版本。这是一次有意的口径选择，不是补字段：如果为了
 * "取不到版本"就让仓库读永远 `unknown`，那份工具就没有可用状态；反过来也不能拿
 * `created_at` 之类冒充"最近更新"。真正取不到时才降级 `MISSING_SOURCE_REVISION`。
 */
// 每个载荷能证明"这份事实是哪个版本"的字段各不相同：详情载荷没有 `updated_at` 时
// 不能拿它当版本（否则每次读都降级 unknown），用载荷里真实存在的时间事实。
export const GITEE_REVISION_FIELDS = Object.freeze({
  repositoryView: 'last_activity_at',
  issueView: 'created_at',
  prView: 'updated_at',
});

/**
 * 每个命令允许的 argv 参数，**按实际发命令行顺序**排列（表即真源，`argvFor` 照抄）。
 *
 * 目标（`target`）的落位规则（与规格 §2.4/§2.5 的 Usage 逐条对应）：
 * - 单对象命令（`issue|pr view|comment`）的位置参数**只有编号**，仓库由 `-R <owner/repo>` 给：
 *   `gh issue view <number>`。把 `owner/repo#12` 整串当编号传给 CLI 必然失败，所以
 *   `assertArgv` 先把 target 拆成 `<number>` + `-R <repo>`；纯数字 target **有意不加** `-R`
 *   ——规格 §1.2：无 `-R` 时按当前目录的 git remote 解析仓库，"读当前仓库某号"是合法用法。
 * - `repo view [repository]` 仍是位置参数（Usage 里就写着 `[repository]`）。
 * - `repo list` **没有**位置参数（Usage：`gh repo list [flags]`），target 只做形状校验、不进
 *   argv：它列的是令牌可见的仓库，不是"某个仓库里的清单"，按仓库过滤这种能力不存在。
 * - 仓库作用域的集合/创建命令（`issue|pr list|create`）走 `-R <target>`。
 *
 * 全局 flag 只有 `-R/--repo`、`--json`、`--debug`、`-h`、`-v`（规格 §1.1）：主机地址来自
 * `~/.gitee-cli/config.json` 的 `base_url`，既不是参数也不是环境变量，所以这里没有 `--host`；
 * 配置键 `host` 只用于诊断与企业域校验，不拼进 argv 或环境。
 */
export const GITEE_ARGV_FLAGS = Object.freeze({
  repositoryView: Object.freeze(['--json']),
  repositoryList: Object.freeze(['--json', '--limit']),
  issueView: Object.freeze(['-R', '--json']),
  issueList: Object.freeze(['-R', '--json', '--state', '--limit']),
  issueCreate: Object.freeze(['-R', '--title', '--body']),
  issueComment: Object.freeze(['-R', '--body']),
  prView: Object.freeze(['-R', '--json']),
  prList: Object.freeze(['-R', '--json', '--state', '--limit']),
  prCreate: Object.freeze(['-R', '--title', '--body', '--head', '--base', '--draft']),
  prComment: Object.freeze(['-R', '--body']),
});

/**
 * 每个读命令的**本地投影清单**：与字段表**同一对象**（不是抄一份），所以"表改了投影跟着改"，
 * 不存在两处漂移。写命令没有投影（输出是人类文本，由解析器取编号/链接）。
 *
 * 名字里的 projection 是有意的：旧名 `GITEE_JSON_SUBSETS` 会让人以为这份清单会拼进 argv，
 * 而实测表明 CLI 根本不做字段过滤。清单决定的是"归一时交付哪些键"，与命令行无关。
 */
export const GITEE_FIELD_PROJECTIONS = Object.freeze({
  repositoryView: GITEE_REPO_FIELDS,
  repositoryList: GITEE_REPO_LIST_FIELDS,
  issueView: GITEE_ISSUE_FIELDS,
  issueList: GITEE_ISSUE_LIST_FIELDS,
  prView: GITEE_PR_FIELDS,
  prList: GITEE_PR_LIST_FIELDS,
});

/** 不带值、出现即为真的开关参数（`pr create --draft`；读命令的 `--json` 同样不接值）。 */
const BOOLEAN_FLAGS = Object.freeze(['--draft', '--json']);

/**
 * 位置参数就是 target 本体的命令：只有 `repo view [repository]`。
 * 单对象命令的位置参数只有编号，见 `SINGLE_OBJECT_COMMANDS`；`repo list` 没有位置参数。
 */
const POSITIONAL_TARGET_COMMANDS = Object.freeze(['repositoryView']);

/**
 * 单对象命令（规格 §2.4/§2.5：`gh issue view <number>`、`gh pr comment <number>` …）：
 * 位置参数只放数字号，仓库拆到 `-R`。
 */
const SINGLE_OBJECT_COMMANDS = Object.freeze(['issueView', 'prView', 'issueComment', 'prComment']);

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

/**
 * `--state` 的取值词表：**按命令分表**，两个命令不共用（规格 §2.4/§2.5 的 flag 说明）：
 * `issue list` 是 `created/processing/rejected/finished/all`，`pr list` 是
 * `opened/closed/merged/all`。这是本包对 `--state` 的**唯一**校验点，工具面的 enum 也从这里
 * 取（`gitee-read.mjs`），不在两处各写一份——写两份的下场就是一边改了另一边还在收旧值。
 */
export const STATE_VALUES = Object.freeze({
  issueList: Object.freeze(['created', 'processing', 'rejected', 'finished', 'all']),
  prList: Object.freeze(['opened', 'closed', 'merged', 'all']),
});

/**
 * 两个命令的 `--state` 默认值：**CLI 自己的默认**（规格 §2.4/§2.5），本包不注入。
 * 写在这里只为工具面文案与文档同源，argv 里不出现它——替 CLI 填默认值等于把两份默认值
 * 抄进本包，CLI 改了这里就会漂移。
 */
export const STATE_DEFAULTS = Object.freeze({ issueList: 'created', prList: 'opened' });

/**
 * 载荷状态值 → 既有交付词表。只映射实测过的写法（`opened` 出现于 PR 与 Issue 载荷）；
 * 不认识的状态原样保留、不新增词——`merged`/`locked` 这类值尚未实测，猜一个同义词就等于替平台
 * 作决定。注意它与上面的 `--state` 筛选词表是两件事：这里归一的是**读出来的**状态，
 * 筛选词表是**发出去的**参数，二者不互相推导。
 */
const STATE_ALIASES = Object.freeze({
  opened: 'open',
  open: 'open',
  closed: 'closed',
});

// 仓库标识允许**嵌套命名空间**：实测企业仓库全名是三级（`name_with_namespace: "osc/ard/ard-sdk"`），
// 只认 `owner/repo` 两段会把真实仓库全部按形状拒掉。段数上限放到 8 段，够覆盖嵌套组，
// 又不至于把任意长路径当仓库名。
const REPO_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*';
/** 仓库标识的**唯一**形状源：读/写/git 三条路径共用，避免三处各写一份正则。 */
export const REPO_TARGET_SOURCE = `${REPO_SEGMENT}(?:/${REPO_SEGMENT}){1,7}`;
export const REPO_PATTERN = new RegExp(`^${REPO_TARGET_SOURCE}$`);
/** 限定引用（`owner/repo#12`、`owner/repo!12`），捕获组 1 是仓库部分。 */
export const QUALIFIED_TARGET_PATTERN = new RegExp(`^(${REPO_TARGET_SOURCE})[#!](\\d{1,9})$`, 'u');
const TARGET_QUALIFIED_PATTERN = new RegExp(`^${REPO_TARGET_SOURCE}#\\d{1,9}$`);
const TARGET_NUMBER_PATTERN = /^\d{1,9}$/;
// Gitee 的 Issue/PR 链接：`/issues/<n>` 与 `/pulls/<n>`（GitHub 的 `/pull/<n>` 也认，只认结构不认域名）。
// 命名空间同样允许嵌套（`.../osc/ard/ard-cli/-/pull_requests/2` 这类路径里取最后两段）。
const TARGET_LINK_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^\s/]+\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\/(?:issues|issue|pulls|pull|pull_requests|merge_requests)\/\d{1,9}(?:[#?]\S*)?$/;
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
    this.provider = GITEE_PLATFORM;
    this.detail = Object.freeze({ provider: GITEE_PLATFORM, ...detail });
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

/**
 * 归一读命令的投影选择：字符串按逗号切、数组照收，缺省即完整声明集。
 *
 * 这是投影名的**唯一校验点**：只认声明过的名字，越界 → `JSON_FIELD_NOT_DECLARED` 且零子进程；
 * 去重保序。返回值决定归一后交付哪些键，**不进 argv**——实测 CLI 不认字段清单，把它拼上去
 * 只会多一个被忽略的 token（旧实现正是这么做的）。
 *
 * @param {string} command `GITEE_COMMANDS` 的键
 * @param {string | string[]} [value] 投影选择；省略即完整声明集
 * @returns {readonly string[]} 投影清单（顺序即交付顺序）
 */
export function projectionFor(command, value = undefined) {
  const declared = GITEE_FIELD_PROJECTIONS[command];
  if (declared === undefined) {
    fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受字段投影（没有 JSON 输出）`, {
      command,
      field: 'json',
    });
  }
  if (value === undefined) return declared;
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
    if (!declared.includes(name)) {
      // 只认声明过的名字：白名单之外的名字既不能进 argv（本来也不进），也不能进投影。
      fail(ADAPTER_REASONS.JSON_FIELD_NOT_DECLARED, `${command} 的 json 字段 "${name}" 未在本包声明`, {
        command,
        field: 'json',
        rejected: name,
        declared: [...declared],
      });
    }
    if (!picked.includes(name)) picked.push(name);
  }
  return Object.freeze(picked);
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
    case '--state': {
      const allowed = STATE_VALUES[command] ?? [];
      const state = text(value);
      if (!allowed.includes(state)) {
        fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 state 必须是 ${allowed.join('|')}`, {
          command,
          field,
          allowed: [...allowed],
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

/**
 * target 落到 argv 的哪里：由 Usage 决定，不是偏好（规格 §2.4/§2.5）。
 *
 * 单对象命令的位置参数只有编号，仓库拆到 `-R`；纯数字 target 的 `repo` 是 `null`，因此
 * 不发 `-R`——规格 §1.2：无 `-R` 时按当前目录 git remote 解析仓库，这是有意保留的用法，
 * 不在这里替调用方猜一个仓库。链接只能取到编号：Gitee 的 web 路径形态不唯一
 * （`/osc/_code/.../-/pull_requests/2` 与 `/owner/issues/1` 都见过），反推仓库不可靠，
 * 宁可退回 git remote 也不猜。
 *
 * `repo list` 没有任何位置参数：它的 target 只做形状校验（工具面要求必填），不进 argv。
 */
function placementFor(command, target) {
  if (SINGLE_OBJECT_COMMANDS.includes(command)) {
    const qualified = QUALIFIED_TARGET_PATTERN.exec(target);
    if (qualified !== null) return { positional: qualified[2], repo: qualified[1] };
    if (TARGET_NUMBER_PATTERN.test(target)) return { positional: target, repo: null };
    const link = TARGET_LINK_PATTERN.test(target) ? /(\d{1,9})(?:[#?]\S*)?$/u.exec(target) : null;
    if (link !== null) return { positional: link[1], repo: null };
    fail(ADAPTER_REASONS.ARG_INVALID, `${command} 的 target 必须带工作项编号（owner/repo#12 或纯数字号）`, {
      command,
      field: 'target',
    });
  }
  if (POSITIONAL_TARGET_COMMANDS.includes(command)) return { positional: target, repo: null };
  return { positional: undefined, repo: target };
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
  const placement = placementFor(command, target);
  const args = [...words];
  if (placement.positional !== undefined) args.push(placement.positional);
  for (const flag of GITEE_ARGV_FLAGS[command]) {
    const value = flag === '-R' ? placement.repo : params[flag.slice(2)];
    if (value === undefined || value === null) continue;
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
 * argv 构造的薄壳：`argvFor('issueList', { target:'g/r', state:'created', json: true })`
 * → `['issue','list','-R','g/r','--json','--state','created']`。
 *
 * 读命令的 `json` 在这里只是**布尔开关**（`true` → 追加 `--json` 一个 token）：字段清单是
 * 本地投影清单，由 `projectionFor()` 决定，永远不进 argv。
 */
export function argvFor(command, params = {}) {
  return assertArgv(command, params).args;
}

/** 读动作 → 命令。`kind:'list'` 时用 `*List`，否则 `*View`；动作名可带/不带 `gitee.` 前缀。 */
function commandForReadAction(action, kind) {
  const name = text(action);
  const key = name.startsWith(`${GITEE_PLATFORM}.`) ? name : `${GITEE_PLATFORM}.${name}`;
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
function parseJsonOutcome(stdout, command) {
  const raw = text(stdout);
  if (raw === '') {
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 没有输出 JSON`, { command });
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出不是合法 JSON`, { command });
  }
}

/**
 * 空结果信封：只有 `message` 一个字符串键（`pr list` 没有 PR 时的实测形状）。
 *
 * 判据故意**只要这一种形状**：多一个键、message 不是字符串、或是数组，都不算空列表——
 * "这仓库没有 PR" 与 "CLI 换了一种包裹" 必须能区分开，否则以后任何畸形输出都会被读成空。
 */
function isEmptyMessageEnvelope(value) {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'message' && typeof value.message === 'string';
}

/**
 * 剥壳：实测出现过四种包裹形态，扁平形状也必须能吃。
 *
 * - `{data:{list:[…]}, meta:{…}}`（`issue list`，2026-11-03 实测）
 * - `{data:[…], meta:{…}}`（`pr list`，实测）
 * - `{"message":"No pull requests found."}`（`pr list` **空**结果，规格 §4 第 5 条）
 * - `{data:{…}}` 与**扁平对象**（`repo view` 实测是扁平对象；`issue|pr view`、`repo list` 未实测）
 *
 * 只剥已知的壳，不做"猜哪一层是数据"的递归：认不出就报畸形结果——把 `data` 或 `meta`
 * 当对象交付出去，下游会拿到一堆 null 还以为读到了东西。`meta` 只把 `total_count` 交给调用方，
 * 其余键丢弃：它不是"取不到的字段"，只是没声明要用的元数据，不该混进 `missing_fields`。
 */
function unwrapOutput(parsed, expected, command) {
  const meta = isPlainObject(parsed) && isPlainObject(parsed.meta) ? parsed.meta : null;
  if (expected === 'array') {
    if (Array.isArray(parsed)) return { value: parsed, meta };
    if (isPlainObject(parsed)) {
      if (Array.isArray(parsed.data)) return { value: parsed.data, meta };
      if (isPlainObject(parsed.data) && Array.isArray(parsed.data.list)) return { value: parsed.data.list, meta };
      // `{items:[…]}` 是 r10 之前就接受的旧形状，留着以免把"包裹形状变了"误报成畸形。
      if (Array.isArray(parsed.items)) return { value: parsed.items, meta };
      // **空列表**不是畸形：`pr list` 没有 PR 时只回一行 `{"message":"…"}`，没有 data/items。
      // 只放行"恰好只有一个 message 字符串"的对象——其它畸形形状（data 非数组、message 之外
      // 还有别的键）照旧报错，别让这道口子把认不出的载荷也放过去。
      if (isEmptyMessageEnvelope(parsed)) return { value: [], meta: null };
    }
    fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出里没有数组（认得的包裹：data / data.list / items）`, {
      command,
    });
  }
  if (isPlainObject(parsed)) {
    if ('data' in parsed) {
      if (isPlainObject(parsed.data)) return { value: parsed.data, meta };
      fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出 data 不是对象`, { command });
    }
    return { value: parsed, meta };
  }
  fail(ADAPTER_REASONS.MALFORMED_RESULT, `${command} 的输出不是对象`, { command });
}

/** 状态值归一：只映射实测过的写法，其余原样保留（不新增词表，见 `STATE_ALIASES`）。 */
function normalizeState(value) {
  if (typeof value !== 'string') return value;
  return STATE_ALIASES[value.trim().toLowerCase()] ?? value;
}

/**
 * 按投影清单逐字取；取不到的键置 `null` 并记进 `missing_fields`（不猜、不省略）。
 *
 * `state` 在这里过一遍归一（实测是 `opened`，信封词表里叫 `open`），其余字段原样交付——
 * 深挖嵌套结构（如 `namespace`/`diff_refs`）不在投影清单里，也就不解析。
 */
function pickFields(raw, fields) {
  const object = {};
  const missing = [];
  for (const field of fields) {
    if (raw[field] === undefined) {
      object[field] = null;
      missing.push(field);
    } else {
      object[field] = field === 'state' ? normalizeState(raw[field]) : raw[field];
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
 * @param {string} [options.host] 企业 Gitee 域名（只做诊断与企业域校验，不进 argv、不进环境：
 *   本 CLI 的主机来自它自己的 `~/.gitee-cli/config.json` 的 `base_url`，没有 `--host` 参数）
 * @param {string|string[]} [options.authEnv] 承载令牌的环境变量名，缺省空（不点名就不注入）
 * @param {(() => string)} [options.now] 时间源（测试可注入固定时钟）
 * @param {object} [options.env] 环境变量来源（令牌只从这里取，缺省 `process.env`）
 * @param {(() => boolean)} [options.persistentTokenProbe]
 *   持久令牌探测（由配置/CLI 层注入的文件系统探测；本模块只负责判定与给出固定 reason）
 * @param {'warn' | 'block'} [options.persistentTokenPolicy]
 *   探测到落盘凭据时的处置：`warn`（默认）只告警放行，`block` 才拒绝
 */
export function createGiteeAdapter({
  runner = null,
  cliPath = 'gh',
  host = '',
  authEnv = [],
  now = () => new Date().toISOString(),
  env = process.env,
  persistentTokenProbe = null,
  persistentTokenPolicy = DEFAULT_PERSISTENT_TOKEN_POLICY,
} = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.run !== 'function') {
    throw new TypeError('createGiteeAdapter 需要可注入的 runner（{ run({bin,args,purpose}) }），不允许在适配器内自建子进程');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是返回 ISO 时间串的函数');
  if (persistentTokenProbe !== null && typeof persistentTokenProbe !== 'function') {
    throw new TypeError('persistentTokenProbe 必须是返回布尔值的函数');
  }
  if (!PERSISTENT_TOKEN_POLICIES.includes(persistentTokenPolicy)) {
    throw new TypeError(`persistentTokenPolicy 只接受 ${PERSISTENT_TOKEN_POLICIES.join(' / ')}`);
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
   * preflight：凭据面诊断（AC-22）。**零子进程、不抛错、不返回令牌值**。
   *
   * 返回值固定形状：`{ ok, provider, reason, message, authEnv, tokenSource, host,
   * persistentToken, persistentTokenPolicy, mayHaveSideEffect:false }`。调用方
   * （`gitee-actions.mjs` 的状态机：`admission → confirm → preflight → invoke`）按 `ok`
   * 决定是否继续，`reason` 直接进信封；`tokenSource ∈ {'env','none'}` 只说明来源。
   *
   * r10 的两处放宽：
   * - **缺令牌不再是拒绝**。默认 `authEnv` 为空，`ok:true, tokenSource:'none'`，只在
   *   `message` 里提示"受限仓库会被 CLI 拒绝"——企业里大量只读命令在无令牌下也能跑，
   *   用 `AUTH_MISSING` 拦住它们等于让用户为一个不缺的东西配置凭据。
   * - **落盘凭据默认只告警**。`persistentTokenPolicy:'warn'` 时 `ok:true`，策略 `block`
   *   才 `ok:false` 并给出固定 reason（合规场景的显式选择）。
   */
  function preflight() {
    const tokens = tokenValues();
    const detected = persistentTokenProbe !== null && persistentTokenProbe() === true;
    const base = {
      provider: GITEE_PLATFORM,
      authEnv: [...authNames],
      host: text(host) || null,
      mayHaveSideEffect: false,
      persistentToken: detected ? 'detected' : 'absent',
      persistentTokenPolicy,
    };
    if (detected && persistentTokenPolicy === 'block') {
      return Object.freeze({
        ...base,
        ok: false,
        reason: ADAPTER_REASONS.GITEE_PERSISTENT_TOKEN,
        message: '检测到 CLI 配置目录存在持久令牌：当前策略为 block，已停止执行；请改用环境变量注入后重启',
        tokenSource: tokens.length === 0 ? 'none' : 'env',
      });
    }
    if (tokens.length === 0) {
      // 缺令牌是提示不是拒绝：命令照常发，受限仓库由 CLI 自己的非零退出说明原因。
      // 落盘凭据（warn）同时存在时也要说出来，否则告警会被"无凭据"掩盖。
      const noTokenGuide = authNames.length === 0
        ? '未配置凭据变量（authEnv 为空）：只读命令照常执行，受限仓库会由 CLI 的非零退出说明'
        : `未在环境里找到 ${authNames.join('|')}：只读命令照常执行，受限仓库会由 CLI 的非零退出说明`;
      return Object.freeze({
        ...base,
        ok: true,
        reason: null,
        message: detected
          ? `检测到待确认的落盘凭据：当前策略为 warn，照常执行；${noTokenGuide}`
          : noTokenGuide,
        tokenSource: 'none',
      });
    }
    return Object.freeze({
      ...base,
      ok: true,
      reason: null,
      message: detected ? '检测到待确认的落盘凭据：当前策略为 warn，照常执行' : '',
      tokenSource: 'env',
    });
  }

  /**
   * 发一条命令：先 `assertArgv`（越界即抛、零子进程），再把命令结果翻译成事实。
   *
   * 不抛"成功/失败以外"的东西：超时 → `TIMEOUT`（`mayHaveSideEffect: true`，须回读不得重放）；
   * 非零退出 → `NONZERO_EXIT`（stderr 说字段不支持时是 `UNSUPPORTED_FIELD`，说凭据被拒时是
   * `AUTH_MISSING`）；起不来 → `SPAWN_FAILED`。只有调用方代码写错（未知命令、越界参数）
   * 才是"先抛"的那一类。
   */
  async function invoke(command, params = {}, purpose = '') {
    const plan = assertArgv(command, params);
    const label = labelOf(plan.args);
    const observedAt = at();
    const reason = text(purpose) || PURPOSES[command] || `${GITEE_PLATFORM}.${command}`;
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
      const stderr = `${outcome?.stderr ?? ''}`;
      const unsupported = /unknown field|unsupported field|invalid field|no such field|invalid json/i.test(stderr);
      // 凭据问题单独归一：缺令牌不再是客户端拒绝，服务端拒了就要说清是"凭据"而不是
      // 笼统的"命令失败"——否则模型只能靠猜（r10 的 AUTH_MISSING 只剩这一个触发点）。
      const authRefused = /\b401\b|\b403\b|unauthori[sz]ed|authenticat|permission denied|invalid (?:token|credential)/i.test(stderr);
      const code = unsupported
        ? ADAPTER_REASONS.UNSUPPORTED_FIELD
        : (spawned ? (authRefused ? ADAPTER_REASONS.AUTH_MISSING : ADAPTER_REASONS.NONZERO_EXIT) : ADAPTER_REASONS.SPAWN_FAILED);
      const hint = authRefused ? '（服务端拒绝了当前凭据：私有仓库请在 authEnv 点名令牌变量后重启）' : '';
      fail(
        code,
        `${label} 失败（${spawned ? `退出码 ${outcome.exitCode}` : '未启动'}）${line === '' ? '' : `：${line}`}${hint}`,
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
      provider: GITEE_PLATFORM,
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
   * `missing_fields` 记录投影清单里取不到的键。命令级失败（超时/非零退出）**抛错**，由读层归一。
   *
   * `json` 是**本地投影选择器**（见 `projectionFor`）：它决定归一后交付哪些键，argv 里只多一个
   * 无值的 `--json` 开关。投影之外、但仍属于事实的键（`source_revision`/`result_refs`）照旧
   * 从**原始载荷**取——它们是读的事实，不该因为调用方没勾某个字段就消失。
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
    // 投影先算、越界先拒：投影名不合法时连子进程都不该起（与其它参数同一口径）。
    const projection = projectionFor(command, options.json);
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
      // 调用方不传就不发 `--state`：默认值归 CLI 自己（issue 默认 created、pr 默认 opened，
      // 规格 §2.4/§2.5）。替 CLI 填默认值等于把两份默认值抄进本包，CLI 一改这里就漂移。
      if (options.state !== undefined) argvParams.state = options.state;
    } else if (options.state !== undefined || options.limit !== undefined) {
      fail(ADAPTER_REASONS.ARG_NOT_WHITELISTED, `${command} 不接受 state/limit（只有清单动作有这两个参数）`, {
        action: actionKey,
        command,
        field: options.state !== undefined ? 'state' : 'limit',
      });
    }
    // `--json` 永远显式给出：省略时 CLI 会输出人类文本，解析不出来就只能算畸形结果。
    // 它是无值开关（实测不认字段清单），所以这里只传 `true`，投影清单留在本地。
    argvParams.json = true;

    const outcome = await invoke(command, argvParams, PURPOSES[command]);
    if (kind === 'list') {
      const { value: items, meta } = unwrapOutput(parseJsonOutcome(outcome.stdout, outcome.label), 'array', outcome.label);
      const normalized = [];
      const missing = new Set();
      for (const entry of items) {
        const { object, missing: gaps } = pickFields(isPlainObject(entry) ? entry : {}, projection);
        for (const gap of gaps) missing.add(gap);
        normalized.push(object);
      }
      // CLI 的 `meta.total_count` 是附加事实：清单被 `--limit` 截住时，它说明"总共有多少条"。
      const totalCount = meta !== null && Number.isInteger(meta.total_count) ? meta.total_count : null;
      return Object.freeze({
        provider: GITEE_PLATFORM,
        action: actionKey,
        kind: 'list',
        target_ref: text(target),
        status: 'succeeded',
        // 清单是查询快照，不冻结事实版本：`source_revision` 恒为 `null`，观测时间看 observed_at。
        source_revision: null,
        observed_at: outcome.observedAt,
        result_refs: Object.freeze([]),
        command: outcome.label,
        missing_fields: Object.freeze([...missing]),
        error_code: null,
        items: Object.freeze(normalized),
        count: normalized.length,
        ...(totalCount === null ? {} : { total_count: totalCount }),
        truncated: outcome.truncated,
        raw: items,
      });
    }
    const { value: raw } = unwrapOutput(parseJsonOutcome(outcome.stdout, outcome.label), 'object', outcome.label);
    const { object, missing } = pickFields(raw, projection);
    const revisionField = GITEE_REVISION_FIELDS[command] ?? 'updated_at';
    const revision = text(raw[revisionField]) || null;
    // 链接只认 `web_url`（实测字段名）；取不到就空 result_refs，不拿别的键拼一个像链接的东西。
    const link = text(raw.web_url) || null;
    // 唯一的降级理由：缺事实版本（不许编版本号）。投影清单之外的键本来就不进 object。
    const errorCode = revision === null ? ADAPTER_REASONS.MISSING_SOURCE_REVISION : null;
    return Object.freeze({
      provider: GITEE_PLATFORM,
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
      object: Object.freeze(object),
      raw,
    });
  }

  /** 脱敏描述：provider/命令面/令牌**来源**；不含令牌，也不含绝对路径（AC-22）。 */
  function describe() {
    const absolute = bin.includes('/') || bin.includes('\\');
    const name = absolute ? (bin.split(/[\\/]/).pop() || bin) : bin;
    return Object.freeze({
      provider: GITEE_PLATFORM,
      logicalName: GITEE_LOGICAL_NAME,
      cliPathKind: absolute ? 'absolute' : 'name',
      cliPathName: name,
      authEnv: [...authNames],
      tokenSource: tokenValues().length === 0 ? 'none' : 'env',
      host: text(host) || null,
      listLimit: GITEE_LIST_LIMIT,
      commands: Object.freeze(Object.keys(GITEE_COMMANDS)),
      readActions: Object.freeze(Object.keys(READ_ACTION_SUBJECTS)),
      // 旧名 `jsonSubsets` 会让人以为这份清单进 argv：它只是本地投影，字段清单一个都不发。
      fieldProjections: Object.freeze(Object.keys(GITEE_FIELD_PROJECTIONS)),
    });
  }

  return Object.freeze({
    provider: GITEE_PLATFORM,
    logicalName: GITEE_LOGICAL_NAME,
    preflight,
    invoke,
    read,
    describe,
  });
}
