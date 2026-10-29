# TECHNICAL — @heluo/forge-gitee 独立包技术方案

> 需求：`docs/teamflow/20261029-r4-forge-gitee/PRD.md`（req-4，25 条 AC）
> 基线依赖：`docs/teamflow/20261028-r1-devops-change-flow`（写动作四状态/幂等回读/白名单/凭据与证据纪律）、`docs/teamflow/20261029-r3-cli-path-autodiscovery`（CLI 入口口径：不硬编码、找不到即 fail closed）
> 不取代任何既有 AC；`@heluo/forge-devops` 的 GitHub 面、9 个工具与补丁层原样保留。
> 本轮无平台写授权：不提交、不推送、不切分支；写动作默认禁用并以负测证明。

## 1. 结论

新增**独立单安装单元** `packages/forge-gitee/`（`@heluo/forge-gitee`），复用 `@heluo/forge-policy` 的硬门禁与审计前置，**不导入** `forge-devops` 的任何源码，靠"同一套不变量 + 契约测试"而不是共享代码来保证两个 provider 语义一致。

四条决定性的架构判断：

| # | 判断 | 理由 |
|---|---|---|
| D-1 | **provider 靠本包常量声明，不靠调用点推断**：`GITEE_PROVIDER = 'gitee'` 出现在每个信封、每个工具返回、每份 `gitee.*` 动作名；非 `gitee.*` 动作在 `gitee-guard` 边界直接拒绝且零子进程 | AC-11/AC-12。沿用 devops 的"调用点即证据"做法会在双包共存时无法自证来源 |
| D-2 | **策略实例全 profile 只有一个**：本包补丁层自带 `heluo-policy` 行（3 条 `gitee.*` 只读 + 内存审计舱），**共存走"并层"而不是"叠加两层"**；README 与补丁注释写明推荐形态 | `packages/forge-policy/src/index.mjs:239-241` 在已有策略服务时抛 `POLICY_SERVICE_CONFLICT`；PRD R4 要求"补丁层不制造第二个同名 id 的隐式叠加"。叠加的后果见 §8.2 三形态表 |
| D-3 | **受控重复而非抽公共包**：`gitee-cli.mjs`（唯一 `execFile` 出口）、幂等台账、`review.md` 渲染、交付判定各自实现，不抽 `@heluo/forge-actioncore` | PRD 非目标"不改写 forge-devops"；抽包要动 devops 源码与 27+ 用例。用**静态门禁测试**（禁项 grep、枚举值一致性、出口唯一性）替代共享代码，漂移风险落成 `§12 R-2` |
| D-4 | **配置只有 4 个扁平键**（`cliPath`/`host`/`timeoutMs`/`authEnv`），不做 Web 配置页 | PRD T5 推荐项；CLI 名已确认，r3 配置页的收益（自动发现）在本轮不存在。PRD 里的 `gitee.cliPath` 是命名空间标注，不是嵌套对象——不放两份配置副本 |

## 2. 架构总览

```text
工具面（8）           gitee-tools.mjs ── readToolDefinitions / writeToolDefinitions
                          │
语义层                  gitee-read.mjs      gitee-actions.mjs     gitee-review.mjs  gitee-delivery.mjs
                       （信封/3 读）        （5 动作/四状态）      （review.md）      （提交信息+关闭判定）
                          │                    │
治理层                  gitee-guard.mjs  ── policy.executeAction（gitee.* 动作，唯一准入点）
                          │                    │
存取层                  gitee-adapter.mjs（argv 白名单 + GITEE_* 字段表）
                          │
出口层                  gitee-cli.mjs  ── 唯一 execFile(shell:false) + 超时 + 1 MiB
                          │
装配层                  index.mjs（name/inject/Config/apply）+ runtime-config.mjs
                          │
装载面                  package.json（dsh.bundle.patch）→ cordis.patch.yml（heluo-policy + heluo-gitee）
```

装配顺序（也是加载顺序）：`policy`（由补丁层先行插入）→ `forge-gitee`（`inject: ['tools','policy']`，服务就绪后才 `apply`）。

## 3. 文件清单与模块契约

装配序 = 依赖方向，不是开发顺序（开发顺序见 §11）。所有导出名即下游必须逐字使用的 API。

| 序 | 路径 | 职责 | 导出 API（签名） | 依赖 |
|---|---|---|---|---|
| 1 | `packages/forge-gitee/src/runtime-config.mjs` | 4 个配置键的解析/校验/脱敏描述；凭据只从 env 取 | `CONFIG_KEYS`、`DEFAULT_CLI_PATH='gh'`、`DEFAULT_TIMEOUT_MS=20000`、`MIN_TIMEOUT_MS=1000`、`MAX_TIMEOUT_MS=600000`、`DEFAULT_AUTH_ENV=['GH_TOKEN']`、`CONFIG_REASONS`、`validateGiteeConfig(input) -> {value} \| {issues}`、`resolveGiteeConfig({config,env}) -> {cliPath,host,timeoutMs,authEnv,tokenSource,missing}`、`describeGiteeConfig(config) -> string`、`ConfigStandard` | — |
| 2 | `packages/forge-gitee/src/gitee-cli.mjs` | 唯一子进程出口：`{bin,args,purpose}` 三键、`shell:false`、超时、1 MiB、env 白名单、token 脱敏 | `DEFAULT_MAX_OUTPUT_BYTES=1048576`、`INVOCATION_KEYS=['bin','args','purpose']`、`ENV_ALLOWLIST`、`class GiteeCliError`、`createGiteeRunner({execFile,env,timeoutMs,maxOutputBytes,now}) -> {run({bin,args,purpose})}`、`scrubSecrets(text,tokens) -> string` | — |
| 3 | `packages/forge-gitee/src/gitee-adapter.mjs` | `GITEE_*` 命令/字段/参数表；argv 构造与越界拒绝；只读/写调用归一 | `GITEE_PROVIDER='gitee'`、`GITEE_LOGICAL_NAME`、`GITEE_COMMANDS`、`GITEE_ARGV_FLAGS`、`GITEE_JSON_SUBSETS`、`GITEE_REPO_FIELDS`、`GITEE_REPO_LIST_FIELDS`、`GITEE_ISSUE_FIELDS`、`GITEE_PR_FIELDS`、`GITEE_ISSUE_LIST_FIELDS`、`GITEE_PR_LIST_FIELDS`、`GITEE_FORBIDDEN_FIELDS`、`GITEE_LIST_LIMIT=100`、`ADAPTER_REASONS`、`assertArgv(command,params)`、`argvFor(command,params)`、`createGiteeAdapter({runner,cliPath,host,authEnv,now,env}) -> {provider,logicalName,preflight(),invoke(command,params,purpose),read(action,target,params),describe()}` | gitee-cli、runtime-config |
| 4 | `packages/forge-gitee/src/gitee-read.mjs` | 3 个只读动作的请求校验 + 信封归一（`provider` 必填）+ 读工具定义 | `GITEE_READ_ACTIONS`、`GITEE_READ_STATUSES`、`READ_REASONS`、`class GiteeReadError`、`assertGiteeReadRequest(action,target)`、`normalizeGiteeReadResult({action,target,result})`、`normalizeGiteeReadError({action,target,error})`、`readToolDefinitions(service)` | gitee-adapter |
| 5 | `packages/forge-gitee/src/gitee-guard.mjs` | 写路径的门禁适配：动作前缀/catalog/确认/审计四关，一次装配只做一次 | `GUARD_STATUSES=['done','denied','failed']`、`GUARD_REASONS`、`createGiteeGuard({policy,provider}) -> {execute({action,target,payload,confirm})}` | forge-policy |
| 6 | `packages/forge-gitee/src/gitee-session.mjs` | 幂等台账（进程内）+ 动作证据构造 | `idempotencyKey({change,objectType,title}) -> string`、`createGiteeSession({now,ttlMs}) -> {lookup,record,forget,size}`、`buildEvidence({command,at,hostVersion,target,sourceType})` | — |
| 7 | `packages/forge-gitee/src/gitee-actions.mjs` | 平台写三动作：`issue_write`/`pr_write`/`review_publish`（四状态 + 幂等 + 回读 + 不重放） | `GITEE_ACTIONS`、`ACTION_STATUSES=['done','failed','denied','unknown']`、`GITEE_OBJECT_TYPES`、`ACTION_REASONS`、`createIssueWrite()`、`createPrWrite()`、`publishReview()`、`writeToolDefinitions(service)` | guard、session、adapter |
| 8 | `packages/forge-gitee/src/gitee-review.mjs` | `review.md`：四段 + AI/人工分栏 + 模型名 + sha + `stale` + 跨 provider 拒覆盖 | `REVIEW_SECTIONS=['问题','风险','意见','结论']`、`REVIEW_DECISIONS`、`REVIEW_STALENESS`、`class ReviewError`、`buildReviewRecord({changeId,commit,model,findings,risks,opinion,conclusion})`、`recordHumanConfirmation(review,{by,at,commit,decision,note})`、`reviewStaleness(review,currentCommit)`、`renderReview(review)`、`assertReviewSections(text)`、`writeReviewFile({repoRoot,changeId,review}) -> {path,sha256}` | — |
| 9 | `packages/forge-gitee/src/gitee-delivery.mjs` | 提交信息 `[变更号]` 校验 + 关闭条件四项判定（只判定不执行） | `expectedCommitFormat(changeId)`、`assertCommitMessage({changeId,change,message})`、`COMMIT_REASONS`、`CLOSE_ITEMS=['acceptance','merged','pendingDelivery','humanConfirmed']`、`CLOSE_REASONS`、`judgeCloseReadiness({criteria})` | — |
| 10 | `packages/forge-gitee/src/gitee-tools.mjs` | 8 个工具注册表（顺序：3 读 → 5 受控动作） | `GITEE_TOOLS`、`GITEE_WRITE_TOOLS`、`TOOL_REASONS`、`buildGiteeTools(service) -> ToolDefinition[]` | gitee-read、gitee-actions |
| 11 | `packages/forge-gitee/src/index.mjs` | 插件入口：`name`/`inject`/`Config`/`apply`；装配期 fail closed | `name='forge-gitee'`、`inject=['tools','policy']`、`Config`、`SERVICE_KEY='gitee'`、`ADAPTER_KEY='giteeAdapter'`、`GITEE_REASONS`、`class GiteeMountError`、`apply(ctx,rawConfig={})`、再导出 §3 的公共符号 | 全部 |
| — | `packages/forge-gitee/package.json` | 单安装单元清单 | — | — |
| — | `packages/forge-gitee/cordis.patch.yml` | 补丁层：`heluo-policy`（3 条 `gitee.*` 只读 + `audit: memory`）+ `heluo-gitee`（`config: {}`） | — | — |
| — | `packages/forge-gitee/README.md` | 状态（从"规划"改为实际）、安装/回滚、**共存 vs 二选一**推荐形态、证据表 + `NOT RUN` | — | — |

`apply` 的动作（顺序即失败顺序，全部 fail closed、可读错误、退出码 0 不算成功）：

1. `validateGiteeConfig(rawConfig)`：未知键/类型错 → `GiteeMountError('GITEE_CONFIG_INVALID')`，`issues` 带字段名不带值。
2. 宿主能力：`ctx.get/provide/effect`、`ctx.tools?.register` 缺一 → `GITEE_HOST_UNAVAILABLE`；`ctx.get('policy')` 缺失或 `policy.executeAction` 非函数 → `GITEE_POLICY_UNAVAILABLE`。
3. 目录自检：`GITEE_READ_ACTIONS` 中任一 `policy.catalog?.get?.(action)?.enabled !== true` → `GITEE_ACTION_UNREGISTERED`（`missing` 列全），**不静默降级**。
4. 解析配置 → 构造 runner/adapter（惰性，`preflight()` 在首次调用时执行，避免装配期连子进程）。
5. `ctx.provide(SERVICE_KEY, service)`；`buildGiteeTools(service).map(ctx.tools.register)`。
6. `ctx.effect(() => teardown)` 释放 provide 与工具。

## 4. 数据模型与存储

### 4.1 真源分布（无数据库、无缓存层）

| 数据 | 载体 | 生命周期 | 写入方 |
|---|---|---|---|
| 业务配置（4 键） | profile 补丁层 `config:` | 持久（重启生效） | 运维/主 agent；本插件只读 |
| 策略目录/审计舱 | 补丁层 `heluo-policy.config` | 持久 | 运维；`gitee.*` 3 条只读随包分发 |
| 幂等台账 | 进程内 `Map` | 进程生命周期 | `gitee-session`（**不落盘**，避免跨进程误判复用） |
| 审查结论 | `<repoRoot>/docs/teamflow/<changeId>/review.md` | 仓库内持久 | `review_record`（人工确认只能人工写） |
| 工具输出/报告 | 返回体（不落文件） | 单次调用 | — |
| **不写** | CLI 配置目录、token 文件、`~/.config/**`、仓库外的任何路径 | — | 永不 |

### 4.2 `GITEE_*` 字段表（AC-12：分表，缺字段即 `unknown`）

| 表 | 字段 |
|---|---|
| `GITEE_REPO_FIELDS` | `name`、`path`、`description`、`url`、`default_branch`、`private`、`updated_at` |
| `GITEE_REPO_LIST_FIELDS` | `name`、`path`、`url`、`private`、`updated_at` |
| `GITEE_ISSUE_FIELDS` | `number`、`title`、`state`、`url`、`updated_at`、`labels`、`comments` |
| `GITEE_ISSUE_LIST_FIELDS` | `number`、`title`、`url`、`state` |
| `GITEE_PR_FIELDS` | `number`、`title`、`state`、`url`、`updated_at`、`head`、`base`、`draft`、`mergeable`、`comments` |
| `GITEE_PR_LIST_FIELDS` | `number`、`title`、`url`、`head`、`state` |
| `GITEE_FORBIDDEN_FIELDS` | `mergedAt`、`merged_at`、`statusCheckRollup`、`checks`、`reviewDecision`、`autoMergeRequest`（**取用即测试失败**） |

- 字段名以 Gitee 语义（snake_case）为规范，不沿用 GitHub 驼峰；`--json` 子集必须与上表逐字一致（`GITEE_JSON_SUBSETS[action]`）。
- F1（字段集合未验）未定前的收缩策略：表中字段取不到 → 信封 `status` 仍按命令结果，但结果里缺的键为 `null`，并在 `result_refs` 之外记 `missing_fields: string[]`；`source_revision` 取不到则整条降级 `unknown`（`MISSING_SOURCE_REVISION`），**不猜**。

### 4.3 只读信封（AC-15，`provider` 为必填项）

```js
{ provider: 'gitee', action: 'gitee.pr.read', target_ref: 'group/repo#12',
  status: 'succeeded'|'failed'|'partial'|'unknown', source_revision: '<sha 或提交号>',
  result_refs: [], observed_at: '<ISO>', error_code: null, retry_policy: 'read_recheck',
  missing_fields: [] }
```

失败降级：无结构化状态 → `NO_STRUCTURED_STATUS`；缺 `source_revision` → `MISSING_SOURCE_REVISION`；两者都返回 `unknown` 而**不抛错**（错误路径再抛错会盖掉原因）。只读失败 `retry_policy: 'read_recheck'`，不自动重试、不触发任何写。

### 4.4 受控动作结果（AC-16，四状态）

```js
{ ok: true, provider: 'gitee', tool: 'forge_gitee_issue_write', action: 'gitee.issue.write',
  status: 'done'|'failed'|'denied'|'unknown', target: 'group/repo#31',
  object_ref: 'group/repo#31', idempotency_key: '<16 hex>', reused: false,
  readback: { matched: true, revision: '<sha>' },
  evidence: { command, at, hostVersion, target, sourceType },
  reason: null, rule: 'registered-action', next_action: null }
```

- `done` = 退出码 0 **且** 回读一致；只有退出码 0 一律 `unknown`。
- `unknown` 记账：进台账但不允许重放，再次调用返回 `unknown` + `replay_blocked: true`。
- 幂等键：`sha256(`${changeId}|${objectType}|${title}`)` 前 16 位（hex 小写，与 r1 同式）；命中 → `status:'done', reused:true, remote_calls:0`。
- `objectType` ∈ `GITEE_OBJECT_TYPES = { issue:'issue', pr:'pull-request', review:'review', delivery:'delivery' }`。

### 4.5 `review.md` 产物模型（AC-19/AC-20）

```markdown
---
kind: review
changeId: CHG-2026-0042
provider: gitee
sourceType: mock
commit: <40 hex>
model: <实际模型名>
updatedAt: <ISO>
---
## 问题
## 风险
## 意见
## 结论

### AI 意见
（模型产出，带模型名与该栏 sha）

### 人工确认
（只能由显式人工输入写入：`by`/`at`/`commit`/`decision`；模型自填一律拒绝）
```

- 四段缺一 → `REVIEW_INCOMPLETE`（列 `missing`）；AI 栏与人工栏**物理分节**，不混写。
- `reviewStaleness(review, currentCommit)`：sha 不等 → `stale`；`stale` 不得作为通过依据（`review_publish`/`delivery_gate` 读 `stale` 即拒）。
- 跨 provider 保护：目标路径已存在且 front matter `provider !== 'gitee'` → `PROVIDER_CONFLICT`，**不覆盖**。
- 写入前校验：`changeId` 匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$`；路径 `resolve` 后必须落在 `repoRoot` 之内（拒绝 `..`/绝对路径/符号链接逃逸）；原子写（临时文件 + rename）。
- 正文脱敏：写盘前对 token 正则、内网地址（`https?://` 非公网域名）、本机绝对路径三类做**阻断**（不是替换），命中即 `REVIEW_REDACTION_BLOCKED`。

### 4.6 补丁层与配置模型

```yaml
- insert:
    - id: heluo-policy
      name: '@heluo/forge-policy'
      config:
        catalog:
          - { action: 'gitee.repository.read', kind: 'read', target: 'repository', enabled: true }
          - { action: 'gitee.issue.read',      kind: 'read', target: 'issue',      enabled: true }
          - { action: 'gitee.pr.read',         kind: 'read', target: 'pull-request', enabled: true }
        audit: { sink: memory, allowNonDurable: true }
    - id: heluo-gitee
      name: '@heluo/forge-gitee'
      config: {}
```

- 0 条 write：五个写动作**不登记**，默认即 `denied`（`rule: 'unregistered-action'`）。
- 内存审计舱属联调级证据；生产须换持久 sink 并删 `allowNonDurable`（README §证据纪律）。

## 5. API 设计

### 5.1 工具面 8 个（`provider: 'gitee'` 固定写在返回体）

| # | 工具名 | 参数 | 返回 | 策略 action | 默认 |
|---|---|---|---|---|---|
| 1 | `forge_gitee_repository_read` | `{ target }` | 读信封 | `gitee.repository.read` | 放行（catalog 已登记） |
| 2 | `forge_gitee_issue_read` | `{ target, list?, state?, limit?, json? }` | 读信封 | `gitee.issue.read` | 放行 |
| 3 | `forge_gitee_pr_read` | `{ target, list?, state?, limit?, json? }` | 读信封 | `gitee.pr.read` | 放行 |
| 4 | `forge_gitee_issue_write` | `{ op:'create'\|'comment', target, changeId, title?, body, confirm:{repo,object} }` | 动作结果 | `gitee.issue.write` | `denied` |
| 5 | `forge_gitee_pr_write` | `{ op:'create'\|'comment', target, changeId, head?, base?, title?, body?, confirm }` | 动作结果 | `gitee.pr.write` | `denied` |
| 6 | `forge_gitee_review_publish` | `{ target, changeId, commit, body, confirm }` | 动作结果 | `gitee.review.publish` | `denied` |
| 7 | `forge_gitee_review_record` | `{ repoRoot, changeId, commit, model, findings, risks, opinion, conclusion, human? }` | 动作结果 + `path`/`sha256` | `gitee.review.record` | `denied` |
| 8 | `forge_gitee_delivery_gate` | `{ changeId, commit, message, criteria:{acceptance,merged,pendingDelivery,humanConfirmed} }` | 判定结果（只判定） | `gitee.delivery.judge` | `denied` |

- 只读参数白名单（AC-14）：`state ∈ {open,closed,all}`、`limit ∈ 1..100`、`json ⊆ GITEE_JSON_SUBSETS[action]`；其余键 → `ARG_NOT_WHITELISTED`，**零子进程**。
- 写工具确认前置：`confirm.repo === 目标仓库` 且 `confirm.object === 目标全串`，否则 `CONFIRMATION_REQUIRED`；只在工具边界做一次，不重复到门禁。
- 统一失败信封：`{ ok:false, provider:'gitee', action, status, reason, rule, next_action, detail }`；`status:'denied'` 必带 `rule`（AC-17）。
- 无泛化入口：不提供 `run`/`exec`/带 `action` 参数的万能工具。

### 5.2 策略动作命名空间（`gitee.*`，与工具名解耦）

`gitee.repository.read` / `gitee.issue.read` / `gitee.pr.read`（只读，随包登记）；`gitee.issue.write` / `gitee.pr.write` / `gitee.review.publish` / `gitee.review.record` / `gitee.delivery.judge`（**不随包登记**，需范围批准后由 profile 追加）。`gitee-guard` 在入口断言 `action.startsWith('gitee.')`，否则 `PROVIDER_MISMATCH` 且零子进程（AC-11）。

### 5.3 CLI 命令面（AC-14/AC-23）

| command | argv 前缀 | 允许参数 | `--json` 子集 |
|---|---|---|---|
| `repositoryView` | `repo view` | `--json`, `--host` | `GITEE_REPO_FIELDS` |
| `repositoryList` | `repo list` | `--json`, `--limit` | `GITEE_REPO_LIST_FIELDS` |
| `issueView` | `issue view` | `--json`, `--host` | `GITEE_ISSUE_FIELDS` |
| `issueList` | `issue list` | `--json`, `--state`, `--limit` | `GITEE_ISSUE_LIST_FIELDS` |
| `issueCreate` | `issue create` | `--title`, `--body` | — |
| `issueComment` | `issue comment` | `--body` | — |
| `prView` | `pr view` | `--json`, `--host` | `GITEE_PR_FIELDS` |
| `prList` | `pr list` | `--json`, `--state`, `--limit` | `GITEE_PR_LIST_FIELDS` |
| `prCreate` | `pr create` | `--title`, `--body`, `--head`, `--base`, `--draft` | — |
| `prComment` | `pr comment` | `--body` | — |

禁项（argv 任何位置出现即拒绝，且零子进程）：`pr merge`、`pr close`、`pr review --approve`、`issue close`、`issue delete`、`release`、`workflow`、`api`、`auth`、`config`、`gist`、`repo delete`、`repo create`。凭据永不出现在 argv（只经 env）。

## 6. 前端与页面

**本轮无前端**：无 `src/client.js`、无 `settings.section`、无 HTTP 路由、无 SSE。理由（PRD T5）：CLI 名已确认、无需 r3 那套"三层发现 + 配置页"编排；配置经补丁层 `config` 即可。

预留的扩展点（**本轮不建**，避免预建虚构入口）：将来若要可视化，新增 `src/client.js`（宿主 client 插件）+ `src/http.mjs`（同源 `/api/forge-gitee` GET/POST，`no-store` + CSRF 头），服务端契约（4 个配置键）不变——即配置面与页面解耦，加页面不改包内 API。

## 7. 状态管理

- **插件内状态**：`ctx.provide('gitee', service)`（服务键固定，供其他插件按名取用）、`ctx.provide('giteeAdapter', adapter)`（惰性）。所有状态挂在 service 上，不用模块级可变单例（否则重启不释放、测试互相污染）。
- **配置状态**：`config`（补丁层）> `env`（仅 `authEnv` 指向的令牌与 `GH_HOST` 兜底）；`cliPath` 缺省 `'gh'`（`PATH` 解析，不写绝对路径）。解析结果 `tokenSource ∈ {'env','none'}`，**不含令牌值**。
- **调用状态机**：`admission(policy) → confirm → preflight(auth+持久令牌) → adapter.invoke → readback → ledger.record`。任一步失败即定状态，后续步骤零执行。
- **幂等会话**：`createGiteeSession()` 构造在 `apply` 内；`lookup/record/forget` 只服务本进程；`unknown` 记录携带 `replayBlocked: true`。
- **审查状态**：`pending-human → confirmed | changes-requested | rejected`；`reviewStaleness` 由 `commit` 比对得出，`stale` 是**派生状态不落盘**（避免出现"确认后被改成通过"的窗口）。
- **交付判定状态**：`judgeCloseReadiness` 纯函数，四项各 `{met: true|false|'unknown', evidence, sourceType}`；`unknown` 不计入通过。

## 8. 关键实现点与边界情况

### 8.1 AC → 设计与门禁映射

| AC | 落点 | 门禁用例 |
|---|---|---|
| 1/6/7 | `package.json` + `cordis.patch.yml` + `index.mjs` | `test/entry.test.mjs`：`dsh.bundle.patch` 指向存在文件；插入行 `name` 精确等于包根名；动态 `import()` 子进程退出码 0；`compileCatalog` 后正好 3 条 `kind:'read'`、0 条 write |
| 2/3/5 | `scripts/check-bundle-tarballs.mjs`（自动发现新包）+ `tests/bundle-gitee.test.mjs` | tarball 无 `test/`、无 `*.tgz`；`dependencies` 真 semver；`bundledDependencies` 覆盖 `@heluo/forge-policy`；入口 sha256 与工作区逐字节一致 |
| 4 | `package.json.dependencies` 仅 1 项；`src/` 零 `@deepseek-ai/*`/`react` | `test/entry.test.mjs` 静态扫描 |
| 8/9/10 | 主 agent 安装（`$DSH_HOME/profiles/web`） | 本轮 **NOT RUN**（子代理无工作区外写权限）；步骤与回滚写在 README |
| 11/12 | `GITEE_PROVIDER` 常量、`gitee.*` 命名、`GITEE_*` 分表、`GITEE_FORBIDDEN_FIELDS` | `test/adapter.test.mjs`：src 零 `gh-adapter`/`GH_` 标识；用 `mergedAt`/`statusCheckRollup` 构造的结果断言 `unknown` |
| 13 | §8.2 三形态 + `test/coexistence.test.mjs` | 见 §8.2 |
| 14 | `assertArgv`/`GITEE_JSON_SUBSETS` | 越界参数与越界 `--json` 各 1 例，断言 `ARG_NOT_WHITELISTED`/`JSON_FIELD_NOT_DECLARED` 且桩 `run` 0 次 |
| 15 | `normalizeGiteeReadResult` | 五项齐全 + `provider` + 失败固定 `reason` 枚举 |
| 16 | `gitee-actions` + `gitee-session` | 四状态矩阵；幂等命中 `reused:true` 且 0 次远端；`unknown` 不重放 |
| 17 | 补丁层 0 write + `writeToolDefinitions` | 五工具逐个 `denied` + `rule`，适配器与 `execFile` 桩**均 0 次**，返回体无 `done` |
| 18 | `assertCommitMessage` | 无前缀/空前缀/空描述三例拒绝，含期望格式；不改写 message、不执行 git |
| 19/20 | `gitee-review` | 四段矩阵、模型名缺失拒绝、人工分栏、sha 变更前后 `stale`、模型自填拒绝 |
| 21 | `judgeCloseReadiness` | 四项矩阵含 `unknown` 分支；白名单断言无 close/merge |
| 22 | `gitee-cli` env 白名单 + `preflight` | 含凭据样例全链路扫描 0 命中；持久令牌夹具 → `GITEE_PERSISTENT_TOKEN`，0 子进程 |
| 23 | 唯一出口 + `assertArgv` | `src/` 零 `spawn`/`exec`/`execSync`/`shell: true`；`{bin,args,purpose}` 以外入参拒绝 |
| 24 | README 证据表 + 设计文档 | 命令/时间/宿主版本/目标对象/来源类型逐条；Windows、麒麟 aarch64、真实凭据、`--json` 稳定性标 `NOT RUN` |
| 25 | `docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、包 README | `node scripts/check-docs.mjs` + 链接/锚点/表格列数人工核对 |

### 8.2 AC-13 共存三形态（D-2 的正面回答）

| 形态 | 装配 | 结果 | 证据 |
|---|---|---|---|
| A 单装 gitee | 本包补丁层（`heluo-policy` 3 条 + `heluo-gitee`） | 3 读可用；5 受控动作 `denied` | `patch-mount.test.mjs` 用补丁层真实 `config` 装配 |
| B 叠加两层 | devops 层 + 本包层 → 两个 `heluo-policy` 行 | 第一个策略实例生效；第二个在 `apply` 抛 `POLICY_SERVICE_CONFLICT`（`code` 原样可见）；先挂载方工具**仍在**；后装包的工具按未登记 fail closed，**不静默消失** | `coexistence.test.mjs`：假宿主逐个 `apply` 并收集每条的失败，断言 8 个 gitee 工具仍可枚举、错误码可见 |
| C 并层（**推荐共存**） | 单一 `heluo-policy` 行（devops 4 条 + gitee 3 条 = 7 条）+ 两插件行 | 17 个工具全枚举，无冲突 | `coexistence.test.mjs`：7 条目录装配后断言 3+4 全 `enabled`、gitee 8 工具可枚举 |

- 假宿主 `test/helpers/fake-host.mjs` 提供 `ctx.get/provide/effect/inject/tools.register` 与 `policy.executeAction` 桩；**不跨包导入 devops 源码**，"另一插件"用等价假插件（9 个哑工具）代替——devops 真实装配由其自身 `patch-mount` 用例承担。
- README 与补丁注释必须写明："推荐二选一安装；必须在同一 profile 共存时，把 gitee 的 3 条目录并入既有 `heluo-policy` 行的 catalog（并层），**不要**叠加两个补丁层"。

### 8.3 失败矩阵（固定枚举，不新增自由文本）

| 场景 | 状态 | reason | 子进程 |
|---|---|---|---|
| 动作未登记（默认写） | `denied` | `POLICY_ACTION_UNREGISTERED` | 0 |
| 策略拒绝/确认缺失 | `denied` | `POLICY_DENIED` / `CONFIRMATION_REQUIRED` | 0 |
| 参数或 `--json` 越界 | `denied` | `ARG_NOT_WHITELISTED` / `JSON_FIELD_NOT_DECLARED` | 0 |
| 非 `gitee.*` 动作 | `denied` | `PROVIDER_MISMATCH` | 0 |
| 缺令牌/存在持久令牌 | `denied` | `AUTH_MISSING` / `GITEE_PERSISTENT_TOKEN` | 0 |
| 超时 | `unknown` | `TIMEOUT`（`mayHaveSideEffect: true`） | 1 |
| 非零退出 | `failed` | `NONZERO_EXIT` | 1 |
| spawn 失败（CLI 不存在） | `failed` | `SPAWN_FAILED` | 1（未起） |
| 退出码 0 但回读不一致 | `unknown` | `READBACK_MISMATCH` | 2 |
| 幂等命中 | `done` | `IDEMPOTENT_REPLAY` | 0 |

### 8.4 其他边界

- **Windows**：`execFile` 只认可执行文件；`.cmd`/`.bat` 包装脚本一律不接受（与 r3 同口径）。argv 交给 `execFile` 数组形式，不拼字符串——无引号问题，也无 shell 注入面。`%APPDATA%` 参与持久令牌探测路径。
- **麒麟 aarch64**：本包不做交叉编译、不带二进制；CLI 缺失即 `SPAWN_FAILED` 并提示，**不**回落 MCP（设计文档已定结论）。
- **F1 字段不稳**：`--json` 子集是白名单常量；CLI 报"未知字段"→ `UNSUPPORTED_FIELD` 可见失败，不静默空成功。
- **并发**：同一 `idempotencyKey` 并发两次 → 第二次在台账上 `reused`（`Map` 同步置位，不等待网络）；`review.md` 写入用临时文件 + `rename`，并发写不产生半截文件。
- **审计 provider 槽**：`@heluo/forge-policy` 的审计白名单（`packages/forge-policy/src/audit.mjs` 的 `ALLOWED_FIELDS`）不含 `provider`，越界字段被丢弃。因此本包的 provider 证据**不依赖推断**：`subject` 固定 `'gitee'`、`action` 以 `gitee.` 开头，并在门禁返回后由 `gitee-guard` 断言这两处（`GITEE_AUDIT_PROVIDER_MISMATCH`）。不改策略包（PRD §10.2 目录边界）。

## 9. 测试策略

全部离线：不联网、不装包、不触真实远端（`execFile` 一律注入桩）。

| 文件 | 覆盖 | 关键断言 |
|---|---|---|
| `test/entry.test.mjs` | AC-1/4/6/7 | 清单与补丁层形状；动态 import 退出码 0；顶层零子进程/零 `ctx` 访问；src 无 `@deepseek-ai/*`、`react` |
| `test/patch-mount.test.mjs` | AC-7/17 | 解析分发补丁层 → 真 `compileCatalog` + 真 `applyPolicy` → 挂本插件；空 catalog 反向用例必须 `denied` 而非放行；全仓扫描任何插入 `forge-gitee` 的补丁层都带目录与审计 |
| `test/coexistence.test.mjs` | AC-13 | §8.2 三形态 |
| `test/config.test.mjs` | AC-7/22 | 4 键校验；未知键拒绝；`describeGiteeConfig` 不含令牌与绝对路径 |
| `test/cli.test.mjs` | AC-22/23 | 三键入参；`shell:false`；超时；1 MiB 截断；token 脱敏；持久令牌阻断且 0 子进程 |
| `test/adapter.test.mjs` | AC-12/14/23 | 分表；禁用字段；argv/`--json` 白名单；禁项；src 零 `GH_` 标识 |
| `test/read.test.mjs` | AC-15 | 信封九项；四类降级；失败枚举固定 |
| `test/actions.test.mjs` | AC-16/17 | 四状态矩阵；回读一致才 `done`；默认禁用五工具 `denied` + 0 调用 |
| `test/session.test.mjs` | AC-16 | 幂等键前 16 位；命中 `reused`；`unknown` 不重放 |
| `test/review.test.mjs` | AC-19/20 | 四段；模型名；分栏；`stale`；模型自填拒绝；脱敏阻断；跨 provider 不覆盖 |
| `test/delivery.test.mjs` | AC-18/21 | `[变更号]` 格式矩阵；关闭四项含 `unknown`；白名单无 close/merge |
| `tests/bundle-gitee.test.mjs` | AC-2/3/5 | `buildBundle({entry:'@heluo/forge-gitee'})` 闭包、清单、入口 sha256 |

不做的部分：不跑真实 Gitee、不跑 Windows/麒麟、不跑真实 profile 二次装载（主 agent 承担，记 `NOT RUN`）；不复制 r3 的配置页用例。

## 10. 任务拆分（并行按文件边界）

| 任务 | 拥有文件（MODIFY） | 只读（READS） | 验收 |
|---|---|---|---|
| **TK1 骨架与装载面** | `packages/forge-gitee/package.json`、`packages/forge-gitee/cordis.patch.yml`、`packages/forge-gitee/src/index.mjs`、`packages/forge-gitee/src/gitee-tools.mjs`、`packages/forge-gitee/test/entry.test.mjs`、`packages/forge-gitee/test/patch-mount.test.mjs`、`packages/forge-gitee/test/coexistence.test.mjs`、`packages/forge-gitee/test/helpers/fake-host.mjs` | `packages/forge-devops/package.json`、`packages/forge-devops/cordis.patch.yml`、`packages/forge-devops/test/patch-mount.test.mjs`、`packages/forge-policy/src/index.mjs` | AC-1/6/7/13/17 的装配面用例通过；`node --test packages/forge-gitee/test/` 绿 |
| **TK2 配置、出口与凭据** | `src/runtime-config.mjs`、`src/gitee-cli.mjs`、`test/config.test.mjs`、`test/cli.test.mjs` | `packages/forge-devops/src/runtime-config.mjs`、`packages/forge-devops/src/cli-runner.mjs` | AC-22/23 用例；脱敏与持久令牌阻断 |
| **TK3 适配器与命令面** | `src/gitee-adapter.mjs`、`test/adapter.test.mjs` | `packages/forge-devops/src/gh-adapter.mjs`（**只看语义，不导入**） | AC-12/14 用例；字段分表与禁项 |
| **TK4 只读面** | `src/gitee-read.mjs`、`test/read.test.mjs` | `packages/forge-devops/src/read.mjs` | AC-15 用例；信封 `provider` 必填 |
| **TK5 受控动作与会话** | `src/gitee-actions.mjs`、`src/gitee-session.mjs`、`src/gitee-guard.mjs`、`test/actions.test.mjs`、`test/session.test.mjs` | `packages/forge-devops/src/actions.mjs`、`packages/forge-devops/src/policy-guard.mjs` | AC-16/17 用例；四状态 + 幂等 + 0 调用负测 |
| **TK6 审查与交付** | `src/gitee-review.mjs`、`src/gitee-delivery.mjs`、`test/review.test.mjs`、`test/delivery.test.mjs` | `packages/forge-devops/src/review.mjs`、`packages/forge-devops/src/commit-message.mjs`、`packages/forge-devops/src/report.mjs` | AC-18/19/20/21 用例 |
| **TK7 文档与登记** | `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、`tests/bundle-gitee.test.mjs` | `packages/forge-devops/README.md`、`docs/design/plugins/forge-devops.md` | AC-2/3/5/24/25；文档检查器通过；证据表与 `NOT RUN` 齐全 |
| **TK8 交付自检** | 仅修：TK1~TK7 产出的缺陷（就地修，不新建产物） | 全部 | `pnpm check` + `git diff --check` 退出码 0；结论写回本任务夹记录（**不写** `QA-REPORT.md`/`ACCEPTANCE.md`，不跑 QA 全矩阵） |

- 并行度：TK2~TK6 五路并行（文件互斥，契约以本文 §3/§4/§5 为准）；TK1 可与 TK2 并行但需先落 `index.mjs` 骨架；TK7 在 TK1~TK6 之后（文档要写实际状态）；TK8 最后。
- **工程约束（PRD §10.2，必须随任务执行）**：留在 `feat/devops-change-flow`，**不新建/不切换分支，不提交、不推送、不合并**；不得 `git reset --hard`/`git checkout --`；只写 `packages/forge-gitee/`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、本任务夹；不在项目根堆放日志、不写宿主 `docs/<role>/`；不写 `$DSH_HOME/profiles/**`。
- 安装与回滚（AC-8/9/10）由**主 agent** 按 PRD §10.3 执行，开发任务只准备产物与 README 步骤。

## 11. 验证命令

```sh
node --test packages/forge-gitee/test/
node --test "tests/*.test.mjs"
node scripts/check-docs.mjs
node scripts/check-repo.mjs
node scripts/check-bundle-tarballs.mjs
node scripts/dsh-version.mjs check
pnpm check
git diff --check
# AC-6 装载安全：动态 import 必须退出码 0
node -e "import('./packages/forge-gitee/src/index.mjs').then(m=>console.log(m.name))"
# AC-3/10 安装单元（主 agent）
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r4'}))"
dsh --profile web --patch packages/forge-gitee/cordis.patch.yml --dump-config
```

**NOT RUN（设计阶段如实记账）**：Windows 实机、麒麟 aarch64 产物、真实企业凭据、`--json` 字段稳定性、真实 profile 二次装载与重启（AC-8/9/10/13 真机部分）、宿主 `0.2.1-rc.3`（本机 `0.2.1-rc.2`）。

## 12. 设计取舍与未决

| # | 项 | 取舍 | 影响 |
|---|---|---|---|
| R-1 | F1 字段集合未验 | 字段表集中一处 + `--json` 子集白名单；取不到即 `missing_fields`/`unknown`，不猜 | 若实测不一致，只改 `gitee-adapter.mjs` 一张表，命令面按可用子集收窄 |
| R-2 | 与 devops 的重复实现（出口/幂等/审查渲染） | 受控重复 + 静态门禁（禁项 grep、枚举值一致性）替代共享包 | 漂移风险落成 `test/adapter.test.mjs` 与 `test/actions.test.mjs` 的不变量断言；下一轮若两边都要演进，再抽 `@heluo/forge-actioncore`（本轮不做） |
| R-3 | 共存需人工"并层" | 不提供第二份补丁文件、不自动改既有 `heluo-policy` 行 | 装配步骤写进 README；F4 若判定"必须共存"，升 P0 并在同一任务夹补一条自动化并层校验 |
| R-4 | `review_record` 与 `delivery_gate` 也默认 `denied` | 严格照 AC-17 的"五个受控动作"口径 | 默认条件下 `review.md` 需显式追加目录才能写；README 给出追加示例 |
| R-5 | `host` 只经 `GH_HOST` 注入、不进 argv | `--host` 是否被企业 CLI 支持未验（F1/F2） | 未验期 `host` 不参与 argv，避免"看着配了其实没生效" |
