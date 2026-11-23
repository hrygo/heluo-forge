# 技术设计：P3 收尾（protectPaths / denyHumanRecord / denyUnknownAction + /policy-audit）

> 状态：已就绪，待实施（代拟，待评审确认）
> 版本：V1.0
> 日期：2026-11-23
> 关联：[PRD](PRD.md)（18 条 AC）、issue #364、#417（process-rules，不在本 PR）、[实施计划](../../plans/2026-11-19-policy-minimal-gates.md)（CORP-DSH-PLAN-024）
>
> 本文只描述本分支（`feat/policy-p3-gates`，base `main`）要落地的设计与文件级任务边界；P3 总体验收待 #417 合入，本 PR 不宣称 P3 完成、不宣称七开关全部可用。

## 1. 范围

### 1.1 本 PR 交付四项

| # | 交付物 | 形态 | 主要代码面 |
|---|---|---|---|
| 1 | `protectPaths` 开关 | 判定阶段 `protected-paths` | `src/paths.mjs`、`src/path-sources.mjs`（新）、`src/gate.mjs` |
| 2 | `denyHumanRecord` 开关 | 判定阶段 `human-record` | `src/gate.mjs`、`src/catalog.mjs` |
| 3 | `denyUnknownAction` 开关 | 判定阶段 `unknown-action` | `src/gate.mjs`、`src/catalog.mjs` |
| 4 | `/policy-audit [N]` 只读命令 | 命令面（不写审计、不改状态） | `src/audit.mjs`、`src/audit-query.mjs`（新）、`src/audit-command.mjs`（新）、`src/installer.mjs` |

配套：配置面放开 `protectedPaths` 与 `paths.append`（只追加、不缩减），四份文档同源同步，既有用例按新契约更新并补齐三态与顺序断言。

### 1.2 明确不做

- 不实现 `enforceProcessRules`，`rules.enforceProcessRules` 开启仍在装载期拒绝；不改 `src/process-rules.mjs`（#417 交付）。
- 不改 DSH 本体/私有 API，不新增运行时依赖，不写 bundle 补丁层（四处 `cordis.patch.yml` 保持逐字一致、不含 `rules`）。
- 不新增 UI、不新增客户端 bundle、不改 `client.js`。
- 不改 `audit.mjs` 的允许字段白名单（拒绝记录不新增字段）。
- 不做热切换：规则只在上次装载时生效，改配置需重挂载。

### 1.3 事实基线（本分支 HEAD）

| 事实 | 证据 |
|---|---|
| 7 个规则开关中仅 `contentGate`/`confirmPush`/`confirmDopWrite` 已实现 | `packages/forge-policy/src/config.mjs:43-47` |
| 三个新开关置 `true` 在装载期被拒 | `config.mjs:108-128`；`test/gate-path.test.mjs:48-50`、`test/write-register.test.mjs:194-199` |
| 流水线阶段表已含十段，但只装配已实现开关 | `src/pipeline.mjs`（`STAGE_RULES`/`buildPipeline`，本任务不改） |
| `protectedPaths`、`paths.append`、`categories` 三面在装载期一律拒绝 | `config.mjs:203-213` |
| 受保护根只有展示用的 `$DSH_HOME/**`，不参与判定；无九类名称模式、无工作区根概念 | `installer.mjs:37`、`installer.mjs:180-186`、`paths.mjs` |
| 门禁按命令式顺序执行，不按 `stages` 迭代；身份之前就 `decideAction` | `gate.mjs:359-598` |
| `denyUnknownAction` 当前把"未登记的读动作"也拒了，与 AC-6 冲突 | `catalog.mjs`（`decideAction` 未登记分支） |
| 审计写支持 memory/file，但两种 sink 都读不回来：file sink `records()` 恒 `[]` | `audit.mjs`（`createFileSink`） |
| 命令面用法可参照 devops 入口 | `packages/forge-devops/src/entry.mjs:67-123` |

## 2. 现状与改动锚点

| 文件 | 现状 | 本任务改动 |
|---|---|---|
| `packages/forge-policy/src/paths.mjs` | `resolveProtectedRoots`/`canonicalize`/`matchProtected`；无名称模式、无作用域 | 新增九类名称模式、`matchProtectedName`、`judgeProtectedPath`、`isPathTemplate` |
| `packages/forge-policy/src/path-sources.mjs` | 不存在 | 新增：参数路径字段提取、`target` 路径确认、逐候选判定编排 |
| `packages/forge-policy/src/config.mjs` | `IMPLEMENTED_RULES` 三键；两键装载期拒绝 | `IMPLEMENTED_RULES` 加三键；放开两键并做形状/语法校验；导出 `collectPathTemplates` |
| `packages/forge-policy/src/catalog.mjs` | 未登记动作一律按开关拒 | `decideAction` 未登记分支按分类区分读/写（读放行） |
| `packages/forge-policy/src/gate.mjs` | 身份→内容→确认；拒绝不写证据 | 顺序化阶段、三开关拒绝 + 单条证据、工作区根、文案常量 |
| `packages/forge-policy/src/installer.mjs` | 默认根 `['$DSH_HOME/**']` 只展示 | 模板并集解析与错误聚合、`createGate` 新选项、注册 `/policy-audit`、服务面语义修正 |
| `packages/forge-policy/src/audit.mjs` | file sink 读不回 | 两种 sink 增加 `read()`；barrier 增加 `read()` |
| `packages/forge-policy/src/audit-query.mjs` | 不存在 | 新增：`N` 解析、记录格式化（纯函数） |
| `packages/forge-policy/src/audit-command.mjs` | 不存在 | 新增：命令注册与只读读取编排 |
| `packages/forge-policy/src/pipeline.mjs` | 阶段表完整 | **不改**（新开关随 `IMPLEMENTED_RULES` 自动装配） |
| `packages/forge-policy/src/index.mjs` | 导出面固定 | **不改**（新模块为包内模块，不经索引面导出） |
| `packages/forge-policy/package.json` | `exports` 已覆盖既有模块 | **不改**（新模块按包内相对路径导入；`./paths` 已导出，新增函数随之可用） |

## 3. 数据模型与存储

### 3.1 配置模型（新增/放开的键）

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `policy.protectedPaths` | `string[]` | `[]` | 追加受保护根模板，与 `paths.append` 取并集（去重、稳定序：先 `protectedPaths` 后 `paths.append`） |
| `policy.paths.append` | `string[]` | `[]` | 同义追加面（历史键），与上者并集；不再"未接入"拒绝 |

条目文法：绝对路径（`path.isAbsolute`）或 `$VAR` / `$VAR/子路径` 模板（`^\$([A-Z][A-Z0-9_]*)(?:\/(.*))?$`）。展开基线与既有实现一致：`{DSH_HOME: ~/.dsh} ∪ process.env ∪ config.env`。

不缩减约束（AC-2）：

- 九类名称模式固定在代码（`PROTECTED_NAME_PATTERNS`），配置不能删改；
- 默认作用域根是**会话工作区根**（运行时取值），配置不能移除；
- 两个追加面为空、缺省、只一项时，九类与工作区根照常生效。

### 3.2 校验与错误模型（两层，一次列全）

| 层 | 触发点 | 负责内容 | 错误形状 |
|---|---|---|---|
| L1 schema/语法 | `validateConfig`（`resolveConfig`） | 是否数组、元素是否非空字符串、是否绝对路径或模板、未知键 | `PolicyConfigError`，`code='POLICY_CONFIG_INVALID'`，`issues[]` 含键路径（`protectedPaths[0]`、`paths.append[2]`） |
| L2 展开 | `installPolicy`（`resolveConfig` 之后） | `$VAR` 是否可解析、展开后是否绝对路径；跨两个面聚合 | 复用 `PolicyConfigError`，`issues[]` 逐条给键路径与原因，一次抛全 |

L1 与 L2 都失败时先报 L1（形状错无法进入展开）。两层的 `issues` 都保持"一次列出全部问题"，不静默忽略、不首个即抛。

`categories` 仍为装载期拒绝（不变），不因本任务放开。

### 3.3 审计记录模型（沿用既有白名单）

拒绝记录复用既有允许字段，不新增字段：

```json
{
  "action": "gitee.issue.write",
  "tool": "forge_issue_write",
  "target": "acme/demo!1",
  "decision": "deny",
  "rule": "protectPaths",
  "ruleIds": ["name:*.pem"],
  "code": "POLICY_PROTECTED_PATH",
  "agent": { "kind": "agent" },
  "observedAt": 1793000000000
}
```

| 规则 | `rule` | 附加标识 | 说明 |
|---|---|---|---|
| `protectPaths` | `protectPaths` | `ruleIds: ["name:<模式>"]` 或 `["root:<未展开模板>"]` | 只记类别/模板标识，**不记命中绝对路径** |
| `denyHumanRecord` | `denyHumanRecord` | — | 不含评审正文 |
| `denyUnknownAction` | `denyUnknownAction` | — | 含 `action`，`code` 为 `POLICY_UNREGISTERED_ACTION` |
| catalog 不可用 | `denyUnknownAction`（开关开启）否则 `out-of-scope` | — | `code` 为 `POLICY_CATALOG_UNAVAILABLE`，fail closed |

拒记录不带 `phase`（对齐 `audit.mjs` 注释"来源拒绝只写一条不带 phase 的结论"）；`durationMs` 缺省，命令面显示 `-`。同一调用最多一条该规则拒记录（AC-8）。

### 3.4 存储与读取

| sink | 存储 | 追加 | 读取（新增） |
|---|---|---|---|
| `memory`（默认） | 进程内环形缓冲 `audit.buffer`（默认 1000） | 覆盖最旧 | `read({limit})` → 新→旧，最多 `limit` 条 |
| `file` | `<DSH_HOME>/logs/forge-policy-YYYY-MM-DD.jsonl`，保留 `keepDays`（默认 7） | 逐行 JSON 追加 | `read({limit})` → 目录内匹配文件按日期倒序合并，按 `observedAt` 倒序取前 `limit` 条 |

读取契约（两种 sink 同构）：

```js
sink.read({ limit }) → {
  records: object[],   // 新→旧，never undefined
  corrupt: number,     // 无法解析的行数（file sink；memory 恒 0）
  missing: boolean,    // 目录/存储不存在（file sink ENOENT）
  unreadable: boolean  // 存在但读不动（EACCES/EPERM/EISDIR）
}
```

- 读取只读：不 `mkdir`、不 `prune`、不改文件、不写审计、不开进程（AC-12）。
- `setAuditSink` 后命令读当前 sink（`barrier.read` 内部取当下 sink，不缓存）。
- 无数据库、无迁移、无新增持久化文件、无 schema 版本。

## 4. API 设计

本任务无 HTTP 路由；对外契约是宿主插件面（配置键、服务成员、命令注册、门禁返回值）。

### 4.1 配置装载

```js
// 合法：只追加，默认九类与工作区根不受影响
{
  "rules": { "protectPaths": true },
  "protectedPaths": ["$DSH_HOME/vault/**"],
  "paths": { "append": ["/tmp/extra-only-for-fixtures"] }
}
```

```js
// 非法：一次报全（键路径 + 原因）
{
  "protectedPaths": "x",                     // protectedPaths: must be an array of path templates
  "paths": { "append": ["", "relative/dir"] } // paths.append[0]: must be a non-empty string
                                             // paths.append[1]: must be an absolute path or a $VAR template
}
```

- 展开失败（`$VAR` 未设置）在 L2 报 `protectedPaths[0]` / `paths.append[0]`，文案不打印 `env` 全量、不打印主机绝对路径。
- 装载成功后 `config.protectedPaths` 为冻结数组（并集，去重）；`config.paths.append` 保留原值（并集另算）。

### 4.2 策略服务导出面（`ctx.get('policy')`）

成员集合不变（不增不减），两处语义收敛：

```ts
// 配置面查询：返回装载时解析出的追加根模板（未配置时为空数组；不再含展示用的 $DSH_HOME/**）
protectedPaths(): string[];

// 判定探针：可选工作区根；不传根时只判配置追加根（不判九类）
checkPath(candidate: string, workspaceRoot?: string):
  { judged: boolean; protected: boolean; category?: string };
```

`checkPath` 契约由"返回 boolean"收敛为对象，并在 `docs/design/plugins/forge-policy.md` 的导出面代码块同源更正（现有文档与实现既已不一致，本任务一并校正）。

### 4.3 命令面 `/policy-audit [N]`

```js
ctx.get('commands').register({
  name: 'policy-audit',
  description: '查看最近 N 条策略审计摘要（只读；默认 20，上限 200）。',
  input: { hint: '条数 N，可选，1–200，默认 20' },
  handler, // (invocation) => Promise<{ kind: 'success' | 'error', text: string }>
});
```

参数解析（`parseAuditCount(rawInput)`）：

| 输入 | 结果 | 提示 |
|---|---|---|
| 空 / 纯空白 | `limit=20` | — |
| `1`–`200` 的整数 | `limit=N` | — |
| `>200` | `limit=200` | `超过上限，只显示最近 200 条。` |
| `0` 或负数 | `limit=20` | `条数需为 1–200 的整数，已回退为 20。` |
| 非数字（含 `abc`、`5x`） | `limit=20` | 同上 |

输出（一行一条，固定八列，`|` 分隔）：

```text
最近 3 条审计记录（新 → 旧）
时间 | 阶段 | 动作 | 目标 | 决策 | 规则 | 耗时 | agent.kind
2026-11-23 07:47:02Z | begin | gitee.git.push | corp.example/repo | allow | confirm-allowed | 12ms | agent
2026-11-23 07:46:55Z | - | gitee.issue.write | corp.example/repo#12 | deny | protectPaths | - | agent
2026-11-23 07:46:44Z | settle | gitee.issue.write | corp.example/repo#12 | error | registered-write | 210ms | unknown
```

| 字段 | 取值 | 缺失 |
|---|---|---|
| 时间 | `observedAt`（ms）→ `YYYY-MM-DD HH:mm:ssZ`（UTC） | `-` |
| 阶段 | `phase` | `-` |
| 动作 | `action`，≤48 字符截断加 `…` | `-` |
| 目标 | 可读标识：路径形态只留末段，其余 ≤48 字符 | `-` |
| 决策 | `decision` | `-` |
| 规则 | `rule`，≤32 字符 | `-` |
| 耗时 | `<n>ms` | `-` |
| agent.kind | `agent.kind` | **`unknown`（不省列）** |

不输出参数正文、评审正文、令牌、绝对路径；`params` 字段整体不进表格。

返回与提示：

| 场景 | `kind` | 文本 |
|---|---|---|
| 有记录 | `success` | 标题行 + 表头 + 记录行（+ 截断提示 + `另有 N 行无法解析，已跳过。`） |
| 无记录（含目录不存在） | `error` | `暂无审计记录：先执行一次受控写，或开启任一规则后重试。` |
| 存在但不可读 | `error` | `审计源不可读：请检查 audit.sink 配置与日志目录权限后重试。`（不含路径与 `errno`） |

命令不写审计、不读/改策略状态、不触发重扫（AC-9/AC-12）；`commands` 服务缺失时注册为空操作，不阻断挂载。

### 4.4 审计读取（内部 API）

```js
createAuditBarrier(...).read({ limit }) → Promise<{records, corrupt, missing, unreadable}>
```

`sink.read` 缺失时 barrier 回退 `sink.records()`（只读快照），永不抛错：读取错误被折叠成 `unreadable`/`missing` 标志，命令层统一转文案。

### 4.5 门禁返回值

`check`/`preExecute` 的 `{kind:'allow'|'deny'|'confirm'|'cancel'|'error'}` 结构不变；`deny` 结果新增/沿用的 `code`：

| `code` | 触发 |
|---|---|
| `POLICY_UNREGISTERED_ACTION` | `denyUnknownAction` 拒未登记写动作 |
| `POLICY_HUMAN_RECORD` | `denyHumanRecord` 拒人工记录 |
| `POLICY_PROTECTED_PATH` | `protectPaths` 命中受保护路径 |
| `POLICY_PATH_SCOPE_UNAVAILABLE` | 工作区根不可获得 |
| `POLICY_PATH_UNRESOLVABLE` | 路径归一化失败（ELOOP/权限等），fail closed |
| `POLICY_CATALOG_UNAVAILABLE` | catalog 不可用/无法判定登记 |

拒文案要求（AC-1/AC-5/AC-7）：含可读 `reason` 与下一步；不含底层 Node 错误、绝对路径、盘符、UNC、`errno`；`denyHumanRecord` 文案含"人工评审结论必须由人做出"；`denyUnknownAction` 文案含"默认放行，开启后未登记即拒"，关闭态不出现拒绝措辞。

## 5. 前端组件与页面划分

**本任务不涉及前端**，不新增/修改任何页面、组件、store 或样式，不重建 `client.js` 产物。

| 面 | 是否变化 | 说明 |
|---|---|---|
| 设置页（账号/企业研发/政策） | 无 | 三开关仍由补丁层配置开启，没有开关 UI；本任务不新增 |
| 确认卡片（`userQuestions`） | 无 | 复用既有卡片；`denyHumanRecord`/`protectPaths` 命中时在弹卡前拒绝，卡片不出现 |
| 命令输出 | 有（文本） | `/policy-audit` 的纯文本表格即全部用户可见面 |
| 审计落盘 | 无 | 记录字段不变；读取为新增只读路径 |

理由：三项能力都是门禁与只读查询，PRD 无 UI 需求；引入 UI 会扩大 bundle 与 profile 配置面，违反"不新增依赖/不写补丁层"的边界。

## 6. 状态管理

无可变全局状态、无前端 store；全部状态在 `installPolicy` 生命周期内：

| 状态 | 所有者 | 生命周期 | 并发/一致性 |
|---|---|---|---|
| `rules`（冻结对象） | `resolveConfig` | 装载期确定，运行期只读 | 不可热切换；改配置需重挂载 |
| `stages`（冻结数组） | `buildPipeline` | 装载期一次 | 关闭的开关不生成阶段 |
| `protectedRoots`（解析后的追加根） | `installer` | 装载期一次 | 解析失败即拒绝挂载 |
| 工作区根 | 每次 `exec.agent.session.header.cwd` | 单次调用 | 取不到即 fail closed，不缓存跨调用 |
| 准入台账（`approved`/`admitted`/`pendingSettlements`） | `createGate` | 单次调用 | 已放行未结清挡住同 `callId` |
| 决策缓存（LRU 32） | `createDecisionCache` | 装载期至卸载 | 仅确认复用，不影响三开关 |
| 审计屏障（`degraded`/`gaps`/当前 sink） | `createAuditBarrier` | 装载期至卸载 | `setAuditSink` 可换 sink；命令读当下 sink |
| 命令解析状态 | 无 | 单次命令 | 纯函数，不落盘 |

## 7. 关键实现点与边界

### 7.1 判定顺序与阶段装配

`pipeline.mjs` 不动：`STAGE_RULES` 已把 `unknown-action`/`human-record`/`protected-paths` 映射到三个开关，`buildPipeline` 只对 `IMPLEMENTED_RULES` 内的开关装配阶段。因此把三键加入 `IMPLEMENTED_RULES` 后，顺序自动为：

```
resolve → identity → unknown-action → human-record → protected-paths → [process-rules 不装配] → content-gate → confirmation → audit → receipt
```

`gate.admitOnce` 从"命令式暗序"改为显式顺序（代码里按阶段注释分段，不再按 `stages` 迭代，避免与 #417 抢结构）：

```js
// 1 resolve
const action = actionFor(exec.name);
if (action === undefined) return allowOutOfScope();            // 映射表外：不读身份、不写审计
if (!(catalog instanceof Map)) return denyCatalogUnavailable(); // fail closed（AC-7）
const category = classifyAction(action)?.category;
const registered = isControlled(action);

// 2 identity（只在会产生判定或本来就受控时读身份）
const needsIdentity = registered
  || (rules.denyUnknownAction === true && category !== 'read')
  || (category === 'human-record' && rules.denyHumanRecord === true);
if (!needsIdentity) return allowOutOfScope();                   // 关闭态：不读身份、不写审计
const actor = normalizeActor(await getActor(ctx));
if (actor === undefined) return deny(IDENTITY_COPY(action));

// 3 unknown-action（先于 human-record：三开关同开时按序归因）
if (!registered && rules.denyUnknownAction === true && category !== 'read') {
  return denyWithEvidence({ rule: 'denyUnknownAction', code: 'POLICY_UNREGISTERED_ACTION' }, UNREGISTERED_COPY);
}
// 4 human-record
if (category === 'human-record' && rules.denyHumanRecord === true) {
  return denyWithEvidence({ rule: 'denyHumanRecord', code: 'POLICY_HUMAN_RECORD' }, HUMAN_RECORD_COPY);
}
// 5 未登记且不归三开关：out-of-scope（读动作、开关关闭）
if (!registered) return allowOutOfScope();
// 6 已登记：语义判定（人工记录关闭态 here 返回 out-of-scope，随后照常记收据）
const decision = decideAction({ catalog, rules, action, target });
if (decision.action === 'deny') return deny(decision.reason);
// 7 protected-paths（在内容闸与确认之前）
if (staged('protected-paths')) { ...命中即 denyWithEvidence(rule:'protectPaths')... }
// 8 content-gate / 9 confirmation / 10 audit.begin / 11 receipt —— 沿用现值
```

固定性质（AC-8，逐条配测试）：

1. 关闭的开关不生成阶段（`gate.stages` 断言）；
2. 同一调用至多一条该规则拒记录（`audit.record` 调用计数）；
3. 三开关同开时按 3→4→7 的顺序单独归因；
4. `denyHumanRecord` 命中后不进入内容闸、不弹卡；
5. `protectPaths` 命中早于 `confirmations.ask`，卡片无法翻转。

### 7.2 `protectPaths`

判定顺序（每个候选路径）：

```
提取候选 → canonicalize（逐段 realpath 后应用 ..）→ 作用域过滤 → 名称/根匹配 → 命中即拒
```

- **工作区根**：`exec.agent.session.header.cwd`（宿主权威的会话工作目录；进程 cwd 不可用）。缺失/非绝对/不可归一 → `deny`（`POLICY_PATH_SCOPE_UNAVAILABLE`）。
- **作用域**：`[工作区根, ...配置追加根]`。候选归一旦不在任一作用域内 → **不判、不拒、不计命中**（AC-3：系统目录、`$DSH_HOME` 默认不由本规则判定，交给沙箱）。
- **追加根的作用**：显式配置的根（如 `$DSH_HOME/vault/**`）把判定作用域扩到该子树；这是 AC-2"追加项覆盖的路径在判定中被拒"与 AC-3"工作区外默认不判"的唯一衔接方式。
- **九类名称模式**（`PROTECTED_NAME_PATTERNS`，固定在代码，按 basename 匹配；`darwin`/`win32` 大小写折叠与 `canonicalize` 一致）：

  `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.netrc`、`credentials*`、`*.p12`

  工作区内命中任一 → 拒（`category='name:<模式>'`）。
- **路径来源提取**（`path-sources.mjs`）：

  | 来源 | 判定 |
  |---|---|
  | `path`、`file`（键名不区分大小写，任意深度、数组内、嵌套对象内） | 必查 |
  | `target` | 仅在可确认为路径时查：绝对路径、`./`/`../` 前缀、工作区内已存在的相对路径（`stat` 容错）；分支名/仓库名/issue 号不判 |
  | 其他字段 | 不判 |

  上限：深度 ≤4、候选 ≤32、单值长度 ≤4096，超出即截断（不做隐式猜测）。
- **fail closed 矩阵**（AC-3）：`ELOOP`/`EACCES`/`EPERM`/归一化抛错 → 拒（`POLICY_PATH_UNRESOLVABLE`）；工作区根不可得 → 拒；追加根展开失败 → 装载期拒（`POLICY_CONFIG_INVALID`）。
- **文案**（不含路径）：`受保护路径规则拒绝了这次写入：「<业务目标或“未提供”>」命中了受保护文件类别 <类别>。下一步：如确需改动该文件，请由人手动完成，或先确认该路径的归属后再重试。`
- **审计**：`rule:'protectPaths'`、`ruleIds:['name:<模式>']` 或 `['root:<未展开模板>']`，不记绝对路径。
- 关闭态：不装配阶段、不构造作用域、不读身份、不写该规则记录。

### 7.3 语义开关

`denyUnknownAction`（`catalog.mjs` + `gate.mjs`）：

- 未登记 + 分类为**写**（`dev-write`/`review-write`/`remote-write`/`human-record`）→ 拒（`reason` 沿用 `unregistered-action`，文案 `UNREGISTERED_COPY`，审计 `denyUnknownAction`）；
- 未登记 + 分类为**读** → `out-of-scope` 放行，不写审计（AC-6）；
- 工具名不在映射表 → `out-of-scope` 放行，不写审计（AC-6，且不读身份）；
- 映射命中但**无法分类** → 按未登记写处理（拒）；
- 已登记写动作行为不变；
- catalog 不可用/无法判定登记 → 拒（`POLICY_CATALOG_UNAVAILABLE`），不按 `out-of-scope` 放行（AC-7）；
- 关闭态 → `out-of-scope` 放行、不读身份、不写审计、文案不出现"已阻止"；`decideAction` 的未登记分支同步改为"读放行、写/无法分类拒绝"，保证服务面 `policy.decide` 与门禁同口径。

`denyHumanRecord`（`gate.mjs`）：

- 分类为 `human-record`（`gitee.review.record`，含工具 `forge_gitee_review_record`）且开关开启 → 拒（`POLICY_HUMAN_RECORD`），不执行、不弹卡，审计一条 `denyHumanRecord`（不含评审正文）；
- 关闭 → 保持现状：`decideAction` 返回 `out-of-scope` 放行，门禁照常写一条 `begin/settle` 收据（"留一条审计"由既有恒开审计提供，不新增记账代码、不双重记账）；
- 命令面 `registerCommand` 注册 `human-record` 动作仍由既有保留规则拒绝（`POLICY_COMMAND_ACTION_RESERVED`，不变）。

### 7.4 `/policy-audit` 实现

- `installer.mjs` 装载末尾调用 `registerAuditCommand(ctx, { audit, now })`，disposer 入 `disposers`（卸载即注销）；`commands` 服务缺失时返回空操作。
- 读取：`audit.read({ limit })`，不经过 `executeAction`（无动作、无审计、无准入）。
- file sink 跨天：文件名日期倒序读取 → 行解析 → 按 `observedAt` 倒序 → 取前 `limit`；坏行计入 `corrupt` 并在提示里说明跳过条数。
- 数值边界只由解析函数处理，命令层不抛栈；错误文案不含路径/`errno`。
- `now` 可注入，格式化对固定输入确定（便于断言）。

### 7.5 与 #417 的接线边界

| 面 | 本任务 | #417 将改 | 冲突规避 |
|---|---|---|---|
| `config.mjs` `IMPLEMENTED_RULES` | 追加三键（保持 `enforceProcessRules` 不在列） | 追加 `enforceProcessRules` | 只动一行数组，同处追加式合并 |
| `pipeline.mjs` `STAGE_RULES` | 不动 | 不动（已含 `process-rules`） | 无重叠 |
| `gate.mjs` 阶段顺序 | 在 `protected-paths` 与 `content-gate` 之间留显式插入点注释 | 在该点插入 `process-rules` | 结构位置明确，避免相互重排 |
| `process-rules.mjs` | 不动 | 主体实现 | 零接触 |
| 文档四份 | 写"`process-rules` 由 #417 交付、本分支不装配" | 改同一段 | 以 base `main` 为准，后合者 rebase 解决文本冲突 |

### 7.6 平台差异

- `canonicalize` 既有实现按平台折叠大小写（`darwin`/`win32`）；九类名称匹配使用同一集合，保持判定与归一同源。
- 符号链接：`realpath` 逐段解析；`ELOOP` 抛 `POLICY_PATH_UNRESOLVABLE` → 拒。
- `win32`：盘符/UNC 不进入文案；测试以 `{ skip: process.platform === 'win32' }` 跳过 POSIX 专有断言（沿用 `test/paths.test.mjs` 既有写法）。
- 测试夹具一律 `mkdtempSync(join(tmpdir(), 'forge-policy-…'))` + `path.join`，不写主机绝对路径、不写真实邮箱/内网地址；`t.after`/`finally` 清理。

### 7.7 安全与不泄漏

- 拒文案与命令输出统一不含：参数正文、评审正文、令牌、绝对路径、盘符、UNC、`errno`、底层异常文本。
- 审计仍走 `buildAuditRecord` 白名单；路径类别只以模式字符串/未展开模板标识。
- 失败关闭优先于可用性：catalog 不可用、作用域不可得、归一化失败一律拒绝，不回退放行。

### 7.8 待澄清项落地决策（PRD §假设）

| 项 | 决策 | 理由 | 风险 |
|---|---|---|---|
| (a) `protectedPaths` 与 `paths.append` 的关系 | 同一套"路径模板追加列表"，两面取并集去重；九类名称模式固定在代码 | 两面语义相同，合并可避免"哪个面更严格"的二义；名称模式不开放给配置可防止保护被改弱 | 若未来需要"根 + 名称模式"分工，需新增键而非复用 |
| (b1) `protectPaths` 对 `target` 的严格度 | 保守：只认绝对路径、`./`/`../` 前缀、工作区内已存在的相对路径 | 分支名/仓库名/issue 号形态与相对路径高度重叠，激进判定会误伤正常写 | `target` 指向尚不存在的相对路径时漏判（需 `path`/`file` 覆盖） |
| (b2) `/policy-audit` 布局 | 一行一条 + 固定表头，字段以竖线分隔 | 无 UI、窄终端可读，八字段固定不省列 | 列宽不齐，不做对齐渲染 |

## 8. 测试策略

层次：模块单测（纯函数）→ 门禁集成（夹具 catalog/tools/exec）→ 命令面（伪 host 注册表）→ 文档断言。全部离线、零 skip（平台断言除外），不依赖真实 IAM/Gitee/DevOps。

用例文件清单：

| 测试文件 | 状态 | 覆盖 |
|---|---|---|
| `test/protected-paths.test.mjs` | 新增 | 九类逐类命中、非命中、追加根、并集、作用域外不判、`../` 穿越、symlink、父目录存在、ELOOP/权限 fail closed |
| `test/path-sources.test.mjs` | 新增 | `path`/`file` 嵌套与数组、`target` 确认规则、候选上限、非路径不误判 |
| `test/gate-protected-paths.test.mjs` | 新增 | AC-1/AC-3/AC-4/AC-8：执行前拒绝、文案不泄漏、关闭态放行且无记录、早于确认 |
| `test/gate-semantic-switches.test.mjs` | 新增 | AC-5/6/7/8：三态、读放行、未映射放行、无法分类拒绝、catalog 不可用、顺序归因、单条记录 |
| `test/audit-query.test.mjs` | 新增 | AC-10：N 解析表、格式化八字段、`-`/`unknown`、截断、路径目标只留标识 |
| `test/audit-command.test.mjs` | 新增 | AC-9~12：有记录/无记录/不可读/跨天合并/坏行/命令不写审计不改状态 |
| `test/paths.test.mjs` | 更新 | 保留既有归一条例，补九类与作用域原语 |
| `test/catalog.test.mjs` | 更新 | 未登记读放行/写拒绝分支（替换现有"开启即拒"断言，记录依据） |
| `test/config.test.mjs` | 更新 | 三键可开启、两键合法追加、非法项一次列全、`categories` 仍拒、`IMPLEMENTED_RULES` 列表 |
| `test/pipeline.test.mjs` | 更新 | 未实现开关只剩 `enforceProcessRules`；三键开启装配阶段与顺序 |
| `test/write-register.test.mjs` | 更新 | 挂载期拒绝循环只留 `enforceProcessRules` |
| `test/gate-path.test.mjs` | 更新 | 关闭态断言保留；"开启即装载失败"改为"开启即生效" |
| `test/apply.test.mjs` | 更新 | 服务成员表、`protectedPaths()` 语义、三键可挂载、非法项报错 |
| `test/audit-file.test.mjs` | 更新 | 新增 file sink `read()` 跨天、缺失、不可读、坏行 |
| `test/package-shape.test.mjs` | 更新 | README 状态句/目标能力标题随 AC-15 改版同步 |

夹具规则：exec 形状复用现有 `{name, arguments, callId, agent, signal}`；agent 至少覆盖 `{kind}` 与 `{kind:'child', session:{header:{origin:'subagent'}}}`；工作区根用 `header.cwd` 指向 `mkdtempSync` 目录。断言"夹具已判定"而非"真实工具被拦"。

命令证据：`/policy-audit` 三场景（有记录、无记录、file sink）各留一段文本证据；关闭态留"不多拒/不多审计/工作区外不判"的负面证据。

## 9. 任务拆分（按文件边界）

单个文件只有一个执行者；下列任务的文件集互不重叠，可并行执行。

| 任务 | 文件（所有权） | 依赖 | 内容 | 完成判据 |
|---|---|---|---|---|
| T1 路径原语 | `src/paths.mjs`、`test/protected-paths.test.mjs`、`test/paths.test.mjs` | 无 | 九类模式、`matchProtectedName`、`judgeProtectedPath`、`isPathTemplate` | 新用例通过；既有归一条例不回退 |
| T2 路径来源 | `src/path-sources.mjs`、`test/path-sources.test.mjs` | T1 | 字段提取、`target` 确认、`evaluateProtectedPaths` 编排 | 提取/排除用例通过；不含 fs 全局副作用 |
| T3 配置面 | `src/config.mjs`、`test/config.test.mjs`、`test/pipeline.test.mjs`、`test/write-register.test.mjs` | T1（模板判定） | `IMPLEMENTED_RULES` +3、放开两键、L1 校验、导出 `collectPathTemplates` | 非法项一次列全；三键可装载；`categories` 仍拒 |
| T4 未登记语义 | `src/catalog.mjs`、`test/catalog.test.mjs` | 无 | `decideAction` 未登记分支读写分流 | 读放行、写/无法分类拒绝 |
| T5 门禁 | `src/gate.mjs`、`test/gate-semantic-switches.test.mjs`、`test/gate-protected-paths.test.mjs`、`test/gate-path.test.mjs` | T1、T2、T3、T4 | 顺序化阶段、三开关拒 + 单条证据、工作区根、文案常量 | AC-8 顺序断言全绿；关闭态零记录 |
| T6 审计读取 | `src/audit.mjs`、`test/audit-file.test.mjs` | 无 | memory/file `read()`、barrier `read()` | 跨天合并、缺失、不可读、坏行 |
| T7a 查询纯函数 | `src/audit-query.mjs`、`test/audit-query.test.mjs` | 无 | `parseAuditCount`、`formatAuditRecords` | 参数表全绿、八字段固定 |
| T7b 命令 | `src/audit-command.mjs`、`test/audit-command.test.mjs` | T6、T7a | 注册、读取编排、三场景文案 | AC-9~12 |
| T8 装配 | `src/installer.mjs`、`test/apply.test.mjs` | T3、T5、T7b | L2 展开与错误聚合、`createGate` 新选项、注册命令、服务面修正 | 挂载全绿、服务成员表更新 |
| T9 文档 | `docs/design/plugins/forge-policy.md`、`docs/design/policy-model.md`、`packages/forge-policy/README.md`、`docs/plans/2026-11-19-policy-minimal-gates.md`、`test/package-shape.test.mjs` | T8（契约冻结） | 四份文档同步 + README 断言同步 | `pnpm check:docs` 零断链；关键词断言通过 |

并行波次：

| 波次 | 并行任务 | 说明 |
|---|---|---|
| A | T1、T4、T6、T7a | 四个纯模块/纯函数，无相互依赖 |
| B | T2、T3 | 依赖 T1 导出的模板/判定原语 |
| C | T5、T7b | T5 依赖 T1/T2/T3/T4；T7b 依赖 T6/T7a |
| D | T8 | 依赖 T3/T5/T7b（唯一装配点） |
| E | T9 | 契约冻结后统一改文档，避免文档与代码双写漂移 |

## 10. 工程约束清单（来自 PRD AC-16~18）

1. 分支：独立 PR，base `main`，head `feat/policy-p3-gates`；不夹带其他任务改动。
2. 提交说明不以 `#` 开头；引用 issue 用正文 `issue #364`。
3. 不新增运行时依赖；不改 `pnpm-lock.yaml`（除既有工作区链接）。
4. 补丁层（`packages/forge-*/cordis.patch.yml`）不写 `rules`、保持四份逐字一致的 6 条目录与审计配置。
5. 不放宽 `check:repo` 与包体闭包断言；不新增根目录文件。
6. 用例只增不减、0 skip（POSIX/平台断言沿用既有 `skip` 写法除外）；新增三开关三态各至少一条、AC-8 顺序断言、`/policy-audit` 三场景。
7. `git status` 干净：无 `*.tgz`、`logs/`、`dist/`、临时产物；`.gitignore` 必要时先补规则不放宽。
8. 证据口径：本地 `pnpm check` 输出 + `/policy-audit` 文本 + 负面证据；真实企业 IAM、真实 Gitee/DevOps、Windows/麒麟实机、真实 profile 装载一律标 NOT RUN。

验证命令（`verifyScripts`）：

```sh
node --test packages/forge-policy/test/*.test.mjs        # 单包闭环
node --test --test-timeout=120000                        # 全仓单测
pnpm check:docs && pnpm check:repo && pnpm check:version # 快检
pnpm check                                               # 全量离线闭环（Node 24.21.0）
git diff --check && git status --short                   # 交付前审阅
```

## 11. AC 对照

| AC | 实现点 | 用例 |
|---|---|---|
| AC-1 九类逐类命中 | `paths.mjs` 模式 + `gate` 第 7 段 | `gate-protected-paths`、`protected-paths` |
| AC-2 只追加 | `config.mjs` L1 + `installer.mjs` L2 并集 | `config`、`apply` |
| AC-3 归一化与 fail closed | `canonicalize`/`judgeProtectedPath`、工作区根获取 | `protected-paths`、`gate-protected-paths` |
| AC-4 路径来源与审计 | `path-sources.mjs`、拒记录 `ruleIds` | `path-sources`、`gate-protected-paths` |
| AC-5 `denyHumanRecord` 三态 | `gate` 第 4 段 + 既有收据 | `gate-semantic-switches` |
| AC-6/7 `denyUnknownAction` | `catalog.decideAction` + `gate` 第 3 段 | `catalog`、`gate-semantic-switches` |
| AC-8 顺序与组合 | `gate` 显式分段 + `pipeline` 装配 | `gate-semantic-switches`、`pipeline` |
| AC-9~12 `/policy-audit` | `audit.read` + `audit-query` + `audit-command` | `audit-query`、`audit-command`、`audit-file` |
| AC-13~15 文档 | 四份文档 + `package-shape` 断言 | `pnpm check:docs`、`package-shape` |
| AC-16~18 工程 | 本文 §10 清单 | `pnpm check`、`git diff --check` |

---

附：不在本 PR 范围但需如实披露——`enforceProcessRules` 仍装载期拒绝（#417），P3 总体验收待 #417 合入；真实企业 IAM/Gitee/DevOps 联调、Windows/麒麟实机与真实 profile 装载未执行。
