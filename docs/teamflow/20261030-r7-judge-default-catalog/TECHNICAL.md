<!-- meta: summary="r7 技术方案：补丁层加 1 条只读判定（kind read、target 逐字 change、egress allow）、判定信封透传 executed=false、写/判定工具常量拆分；门禁与四状态零改动；5 任务两波，真实安装与重启 NOT RUN" -->

# TECHNICAL · 判定动作默认登记（`gitee.delivery.judge`）

- 需求来源：[PRD](./PRD.md)（req-7，20 条 AC）。
- 基线依赖：`docs/teamflow/20261029-r4-forge-gitee/`（r4 四份按 AC-17 就地修订，取代 r4#AC-7、r4#AC-17 的目录口径；用户已授权覆盖 ADR-0008 的"历史夹不修改"）。
- 行号基准：当前工作区 HEAD `65ca732`，本文件落笔时 `packages/forge-gitee/src` 与补丁层**尚未修改**（本文件描述目标态）。
- 证据边界：本轮只做离线实现与离线验证；真实 profile 装入/重启/回滚由主 agent 执行（AC-13/14/15，标 **NOT RUN**）。

## 1. 结论与不变量

一句话：**权限事实只改一处**——随包分发的策略目录从「3 条只读」变成「3 读 + 1 只读判定」，判定条目显式 `egress: "allow"`、`kind: "read"`、`target` 逐字 `change`；为了让 AC-2 要求的 `executed: false` 出现在工具返回体里，判定信封新增一个可选字段；其余（门禁、四状态、8 个工具的名字/参数、四个写动作默认 `denied`、清单与构建）零改动。

改动面（生产码，共 4 个文件）：

| 文件 | 改动 | 对应 AC |
|---|---|---|
| `packages/forge-gitee/cordis.patch.yml` | `config.catalog` 增第 4 条；文件头注释与"并层"说明改口径；门禁说明指向的测试不变 | AC-1 / AC-9 / AC-10 |
| `packages/forge-gitee/src/gitee-actions.mjs` | 判定 readback 增 `executed`；`actionResult` 增可选 `executed` 入参并透传；`:18`/`:39`/`:1175` 注释口径；判定工具描述补"随包默认登记、只判定"一句 | AC-2 / AC-7 |
| `packages/forge-gitee/src/gitee-tools.mjs` | `GITEE_WRITE_TOOLS` 收敛为 4 个写工具；新增 `GITEE_JUDGE_TOOLS`；`GITEE_TOOLS` 仍 8 个且顺序不变（判定最后） | AC-3 |
| `packages/forge-gitee/src/index.mjs` | `service.writeTools()` 返回 4 个写工具（判定不再混进"写工具"集合） | AC-3 |

**明确不在改动面**（回归时必须证明没被顺手改）：`src/gitee-guard.mjs`（唯一准入点，逻辑 0 行变化）、`src/gitee-delivery.mjs`（判定判决体）、`src/gitee-adapter.mjs` / `src/gitee-cli.mjs` / `src/gitee-read.mjs` / `src/gitee-review.mjs` / `src/gitee-session.mjs`、`packages/forge-policy/**`（既有 `compileCatalog` / `decide` / `needsApproval` 语义已足够）、`packages/forge-devops/**`、8 个工具的 `name`/参数 schema/四状态、`package.json` 与 `files` 白名单（AC-9/10 只需证明未变）。

不变量：

| 编号 | 不变量 |
|---|---|
| I1 | 准入唯一出口 `src/gitee-guard.mjs`；判定与写动作一样先过 `policy.decide` 再 `policy.executeAction` |
| I2 | 判定 `kind: read` ⇒ `needsApproval(entry) === false`（`packages/forge-policy/src/approvals.mjs:102`），不建审批台账、不要求 `approvals` 条目 |
| I3 | 四个写动作（`gitee.issue.write` / `gitee.pr.write` / `gitee.review.publish` / `gitee.review.record`）默认不登记 ⇒ `denied` / `rule: 'unregistered-action'` / 门禁 operation 0 / 子进程 0 |
| I4 | `apply()` fail-closed 仍**只**要求 3 个只读动作；目录缺判定时挂载成功、判定降级 `denied`（AC-8） |
| I5 | 判定 `executed` 恒 `false`、`remote_calls: 0`；无 close/merge/release 通道，判定不在 `CONFIRM_REQUIRED_ACTIONS` |
| I6 | 工具面 8 个、名字与顺序不变（`GITEE_TOOLS` 最后一仍是 `forge_gitee_delivery_gate`） |

## 2. 数据模型与存储

### 2.1 策略目录（权限唯一真源，进程内）

补丁层目标态（`packages/forge-gitee/cordis.patch.yml`，保持一个 `- insert:` 块、两行、策略行在前）：

```yaml
        catalog:
          - { action: 'gitee.repository.read', kind: 'read', target: 'repository', enabled: true }
          - { action: 'gitee.issue.read', kind: 'read', target: 'issue', enabled: true }
          - { action: 'gitee.pr.read', kind: 'read', target: 'pull-request', enabled: true }
          - { action: 'gitee.delivery.judge', kind: 'read', target: 'change', enabled: true, egress: 'allow' }
```

编译后条目形状（`packages/forge-policy/src/catalog.mjs` 的 `compileCatalog`）：

```json
{ "action": "gitee.delivery.judge", "kind": "read", "target": "change",
  "egress": "allow", "retry": "read_recheck", "enabled": true,
  "path": "config.catalog[3].action" }
```

三处必须解释清楚的取值（不是风格问题，是行为问题）：

1. **`egress: "allow"` 必需**。门禁统一以 `EGRESS_PLATFORM_WRITE = 'platform-write'` 发起裁决（`src/gitee-guard.mjs:69`、`:199`），而 `compileCatalog` 对缺席的 `egress` 取默认 `'confirm'`（`packages/forge-policy/src/catalog.mjs:66`）。条目漏写 `egress: allow` 时裁决落到 `{ action: 'confirm', rule: 'egress-confirm' }`，`executeAction` 在无 `approvals` 台账时会拒绝——永远拿不到 AC-2 要求的 `rule: 'registered-action'`。写条目保持默认 `confirm` 是对的，这里只对"只读判定"这一条显式放开。
2. **`kind: "read"` 而非 `write`**。`needsApproval = entry.kind !== 'read' && entry.enabled === true`（`packages/forge-policy/src/approvals.mjs:102`）：登记成 `write` 会让每次判定都要求审批台账（与"只读判定默认可用"直接冲突）；判定本身没有远端写、没有回放风险（`executed: false`、`remote_calls: 0`），登记成 `write` 还会把"只判定"误标成写能力。
3. **`target` 逐字 `"change"`**。AC-1 明令非等价串；补丁层、README 工具表、设计文档 §6 三处**同一字面**，禁止 `delivery` / `gitee-change` 等替代写法。

存储语义：**无新增存储**。目录在 `apply()` 期间从补丁层读入并编译进 `policy.catalog`（内存 `Map`，条目由 `compileCatalog` 产出），不落盘、不版本化；审计仍 `sink: memory` + `allowNonDurable: true`（联调舱，进程退出即丢，AC-19 只作离线证据）。

### 2.2 判定响应（数据面）

判定复用既有信封（`src/gitee-actions.mjs:155` `actionResult`），本次只新增一个可选键：

| 字段 | 判定时的值（AC-2 目标） | 说明 |
|---|---|---|
| `ok` / `status` | `true` / `"done"` | 四项条件全 `passed` 且提交信息合规 |
| `rule` | `"ready"` | 由策略裁决给出，判定只透传 |
| `action` / `target` / `tool` | `gitee.delivery.judge` / `"change"` / `forge_gitee_delivery_gate` | `target` 与目录条目同字面 |
| `readback` | `{ via: 'gitee-delivery', ok: true, ready: true, commit: '<sha>', unknown_items: [] }` | `ok === (status === 'done')` |
| `executed` | `false` | **本次新增**；来源 `src/gitee-delivery.mjs:516`，仅判定信封输出 |
| `remote_calls` | `0` | 判定不发任何远端调用 |
| `idempotency_key` | `null` | 只读动作不进幂等台账 |
| `evidence` / `reused` / `replay_blocked` | 与既有写动作同构（无则省略） | 信封形状不变 |

`executed` 的出现方式：`actionResult` 增可选入参，**仅在 `produced.executed !== undefined` 时输出该键**——四个写动作的 `produced` 没有这个字段，所以它们的信封一个键都不多（避免把"新增字段"扩散成写动作契约变更）。

### 2.3 持久化 / 状态

无表、无文件、无 `review.md` 写入、无幂等台账。判定的判决函数 `judgeCloseReadiness`（`src/gitee-delivery.mjs:446`）是纯函数：同输入同输出，重复调用不累积状态，也不改变"下次重装后的默认行为"。

## 3. API 设计

### 3.1 模型可见工具（8 个，未变）

| 工具 | 目录登记 | 默认状态 | 变化 |
|---|---|---|---|
| `forge_gitee_repository_read` / `forge_gitee_issue_read` / `forge_gitee_pr_read` | 3 条 `gitee.*.read` | 放行 | 无 |
| `forge_gitee_issue_write` / `forge_gitee_pr_write` / `forge_gitee_review_publish` / `forge_gitee_review_record` | 不登记 | `denied`（`unregistered-action`） | 无 |
| `forge_gitee_delivery_gate` | 本次新增登记（`kind: read`） | **放行（只读判定）** | 从 `denied` → 可用；参数与四状态不变 |

### 3.2 `forge_gitee_delivery_gate`

参数（不变）：

| 参数 | 类型 | 约束 |
|---|---|---|
| `changeId` | string | 变更号，`^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$`；缺失/非法 → `denied` + `MISSING_ARGUMENT`/`INVALID_ARGUMENT`，不进门禁 |
| `message` | string | 提交信息首行，必须 `[<本变更号>] 描述`；空 → `denied` + `MISSING_ARGUMENT` |
| `criteria` | object | 四项关闭条件；非对象 → `denied` + `INVALID_ARGUMENT`；可缺省（缺省项按 `unknown`） |
| `commit` | string | 7–40 位十六进制；不回显原文，`readback.commit` 是 lower-case 副本 |

出参状态矩阵（与写动作同一套四值语义，判定不新增状态）：

| 情况 | `status` | `rule` | `reason` |
|---|---|---|---|
| 四项全 `passed` 且提交信息合规 | `done` | `ready` | —（`readback.ok: true`、`executed: false`） |
| 任一项 `unknown`（CI/UAT 取不到） | `unknown` | `not-ready` | `DELIVERY_UNAVAILABLE`（固定枚举，不计通过） |
| 任一项 `failed` 或提交信息不合规 | `failed` | `not-ready` / `commit-message-invalid` | `DELIVERY_UNAVAILABLE` / `COMMIT_MESSAGE_INVALID` |
| 目录未登记 / 未启用 / target 不符 | `denied` | `unregistered-action` 等 | `GUARD_ACTION_UNREGISTERED` 等 |

AC-2 的合法入参（测试与 QA 共用这一份，注意 `statusOf` 只认 `passed`/`failed`/`unknown`，**`'pass'` 会落 `unknown`**）：

```js
{ changeId: 'CHG-2026-001',
  message: '[CHG-2026-001] 判定默认登记',
  commit: 'a'.repeat(40),
  criteria: {
    acceptance: { status: 'passed', evidence: '离线 CI 全绿', sourceType: 'ci' },
    merged: { status: 'passed', evidence: 'PR 已合入', sourceType: 'platform' },
    pendingDelivery: { count: 0 },
    humanConfirmed: { decision: 'confirmed' },
  } }
```

### 3.3 内部契约（下游任务逐字使用，名字不得自创）

```js
// packages/forge-gitee/src/gitee-tools.mjs
export const GITEE_WRITE_TOOLS;   // 4 个写工具名，顺序：issue_write, pr_write, review_publish, review_record
export const GITEE_JUDGE_TOOLS;   // ['forge_gitee_delivery_gate']
export const GITEE_TOOLS;         // 8 个，顺序 = 3 读 + 4 写 + 1 判定
export function buildGiteeTools(service); // -> Record<name, ToolDefinition>

// packages/forge-gitee/src/gitee-actions.mjs
export const GITEE_ACTIONS;                       // 5 个受控动作（名字即策略目录 action）
export function actionResult(input);              // -> Envelope；input.executed 可选，仅非 undefined 时输出
export function createDeliveryGate();             // -> { tool, action, run(args, service) }
export function writeToolDefinitions(service);    // -> ToolDefinition[]（5 个定义：4 写 + 1 判定；名字沿用，勿改名）
function settleVerdict(spec, verdict, { target, key }); // 内部：把 produced.executed 原样带入信封

// packages/forge-gitee/src/index.mjs
export function apply(ctx, rawConfig);            // -> teardown
export function createService({ ctx, policy, adapter, guard, session, config }); // -> service
// service.writeTools() -> string[]（本次起为 4 个写工具）

// packages/forge-gitee/src/gitee-delivery.mjs（不改）
export function judgeCloseReadiness({ changeId, commit, criteria });
// -> { kind, provider, changeId, commit, status, ready, items, blocking, unknown, executed:false, note, judgedAt }
```

`executed` 透传骨架（`gitee-actions.mjs`，最小改法）：

```js
// 1) 判定 payload.run 的返回体加一行（来源已是 false，这里只做显式声明）
const judged = await delivery.judgeCloseReadiness({ criteria: input.criteria });
return { ..., executed: judged?.executed === true, readback: { ..., } };

// 2) actionResult 形参加 executed，键按"未声明就不出现"输出
function actionResult({ ..., executed, ...rest }) {
  return json({ ..., ...(executed === undefined ? {} : { executed }), ... });
}

// 3) settleVerdict 把 produced.executed 交给 actionResult（写动作 produced 无此键 ⇒ undefined）
```

### 3.4 无 HTTP 面 / 无新增配置

不新增路由、HTTP 端点、配置键（`runtime-config` 仍 `cliPath`/`host`/`timeoutMs`/`authEnv` 四键）、不新增宿主 service 方法；`dsh.bundle.patch`、`files` 白名单、`engines.dsh` 均不动。

## 4. 前端与页面

**无前端改动**。本包没有 HTTP 面与配置页（`docs/design/plugins/forge-gitee.md` §1 原则 4 已写明"本轮无前端、无 HTTP 面、无配置页"），判定是模型可见工具，不产生页面差异；`packages/forge-devops/client.js` 的"企业 DevOps"配置页属另一个包、不在本需求范围，**不得顺手改**。用户/验收人可观察到的变化只有两处：工具返回体（判定从 `denied` 变为 `done`/`unknown`/`failed`）与补丁层目录内容。

## 5. 状态管理

| 层 | 状态 | 本需求的影响 |
|---|---|---|
| 装配态（`apply()`） | 补丁层 → `compileCatalog` → `policy.catalog`；`assertReadCatalog` 只校验 3 个只读动作 | 目录多 1 条不影响装配；缺判定**不**阻塞挂载（AC-8），缺读动作仍 `GITEE_ACTION_UNREGISTERED` + `detail.missing` 列全 |
| 每调用态 | `guard.execute` → `policy.decide`（只读裁决）→ `policy.executeAction`（审计 1 条）→ 判定纯函数 | 判定多了一条"登记即放行"的路径，没有新增缓存或台账 |
| 失败态 | `done` / `unknown` / `failed` / `denied` | 语义不变；`unknown` 不重放、不计通过 |

不新增全局单例、不新增 store；目录的生命周期仍等于插件挂载周期（`teardown` 卸载后 `policy` 实例随服务域销毁）。

## 6. 关键实现点与边界

**K1 目录条目**：按 §2.1 原样写入；`egress` 用双引号或单引号均可，但必须是字符串 `'allow'`（`fake-host` 的 flow-map 解析支持该键）。

**K2 门禁零改动**：`gitee-guard.mjs` 已用 `platform-write` 发起裁决、已把非 deny 裁决交给策略侧统一处理，且 `CONFIRM_REQUIRED_ACTIONS` 只含三个写动作（`:61-65`）——判定不在其中，`needsApproval` 又因 `kind: read` 为 `false`。因此**不改门禁**；若有人为了"让判定通过"去改 `gitee-guard.mjs`，属越界（AC-7 会以"门禁/适配器 0 次调用"与 diff 范围发现）。

**K3 `executed` 只进判定信封**：按 §3.3 骨架；不要把它加进 `GITEE_ACTION_RESULT_FIELDS` 之类的共享字段表（不存在该表，保持"produced 声明才输出"）。

**K4 常量拆分**：`GITEE_WRITE_TOOLS` 只留 4 个写工具；新增 `GITEE_JUDGE_TOOLS = ['forge_gitee_delivery_gate']`；`GITEE_TOOLS = [...GITEE_READ_TOOLS, ...GITEE_WRITE_TOOLS, ...GITEE_JUDGE_TOOLS]`（顺序与今天完全相同）。连带消费点：`src/index.mjs` 的 `service.writeTools()`（5→4）、`test/patch-mount.test.mjs`（`WRITE_CALLS` 仍 5 个键，但断言集合拆成"4 写 denied"+"判定 done"）、`test/coexistence.test.mjs`（`catalog.size` 3→4、并层 7→8）、`test/actions.test.mjs` 的注释与 `WRITE_TOOL_NAMES` 说明（硬编码 5 个名字保留，用于空目录下"5 个受控工具全 denied"的既有语义）。

**K5 fail-closed 不放松**：`assertReadCatalog` 的必需集合仍是 `GITEE_READ_ACTIONS`（3 条）；不改错误码、不改 `detail.missing` 形状。缺判定时的表现是"挂载成功 + 判定 `denied`"，不是挂载失败。

**K6 文档口径同步**：`packages/forge-gitee/README.md`（:7 形态、工具表 judge 行、:70 策略门禁段、共存表"7 条目录"、回滚段第 1 条、测试覆盖段）、`docs/design/plugins/forge-gitee.md`（:36 边界、:134 策略目录段、:201/:209 §11 打包、:214 §12 未决行）、`docs/design/README.md`（:34 状态、:63 表格）。r4 四份按 AC-17 就地修订：**原文不动**，在每处命中后另起一行加 `> r7 修订：原文结论为「3 条只读 / 5 个受控动作全部 denied」；现为「3 读 + 1 只读判定 + 4 受控写」，判定随包登记为只读（target 逐字 change），四个写仍默认 denied。` 并保留原证据编号。

**K7 安装 / 重装 / 回滚**（主 agent，AC-13/14）：`node --input-type=module -e "...buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r7'})"` → `dsh plugin --profile web remove @heluo/forge-gitee` → `dsh plugin --profile web add dist/r7/heluo-forge-gitee-0.1.0.tgz` → 四项复核（`--dump-config` 目录 4 条 / 工具 8 个 / `grep -c` 补丁层 / sha256）。同版本重装必须先 `remove` 再 `add`；回滚点是对旧 tarball 的 `a0a506f3ee300030b7bc94f4e04e1c1d4e173e30749299f6a01b58843d92092c` 校验后装回。

**K8 边界用例**：

| 场景 | 期望 | 由谁守 |
|---|---|---|
| 目录缺 judge（其余 3 条在） | 挂载成功；判定 `denied` + `unregistered-action` | AC-8 新用例 |
| judge 条目 `enabled: false` | 判定 `denied` + `action-disabled` | actions 既有负测（映射） |
| judge 条目漏 `egress: allow` | 判定 `denied`（策略侧拒绝），测试必须显式断言 `egress === 'allow'` 防止回退 | entry 形状断言 |
| 目录缺读动作 | 拒绝挂载 + `GITEE_ACTION_UNREGISTERED` + `missing` 列全 3 条 | 既有用例（不改） |
| criteria 含 `unknown` | `unknown` + `DELIVERY_UNAVAILABLE` + 不含 `done` | AC-5 |
| 缺 `changeId`/`message`/`criteria` 非法 | `denied`，零子进程、零门禁 operation | AC-6 |
| 旧 tarball 未重装 | 判定仍 `denied`（目录没有第 4 条） | AC-13 复核项/排查指引 |
| 并层只并入 3 条旧 `gitee.*` | 判定 `denied`（不是挂载失败） | README/AC-8 口径 |

## 7. 测试策略

### 7.1 分层

| 层 | 文件 | 目的 |
|---|---|---|
| 判定判决体单测 | `packages/forge-gitee/test/delivery.test.mjs`（不改） | 四项条件语义、`executed:false` |
| 动作/门禁单测 | `packages/forge-gitee/test/actions.test.mjs` | AC-5/AC-6 断言补齐（状态、固定 reason、零子进程） |
| **真实装配**（真补丁层 + 真策略服务） | `packages/forge-gitee/test/patch-mount.test.mjs` | AC-1/2/3/4/8 主战场 |
| 补丁层形状 | `packages/forge-gitee/test/entry.test.mjs` | 4 条目录、`kind`/`target`/`egress`/`enabled`、`compileCatalog` 通过 |
| 共存 | `packages/forge-gitee/test/coexistence.test.mjs` | 形态 A/C 的目录条数 3→4、并层 7→8 |
| 打包产物 | `tests/bundle-gitee.test.mjs` | 产物 `package/cordis.patch.yml` 含 judge 条目 |

### 7.2 用例清单（名字按 AC 编号，QA 按名字取证）

| 文件 | 用例 | 断言要点 |
|---|---|---|
| patch-mount | `AC-1: 用分发补丁层挂载后，3 读 + 1 只读判定可用、4 个写动作未登记` | `mounted.ok`；`host.toolNames()` deepEqual `GITEE_TOOLS`；3 读 `allow`/`registered-action`；**judge 的 `decide` 返回 `allow` + `rule: 'registered-action'`**；4 写动作 `catalog.has === false` 且 `deny`/`unregistered-action` |
| patch-mount | `AC-2: 默认目录下判定默认可用：done + ready + executed false + remote_calls 0` | `invokeTool(...,'forge_gitee_delivery_gate', DELIVERY_CALL)`：`status==='done'`、`rule==='ready'`、`readback.ok===true`、`executed===false`、`remote_calls===0`、`ok===true`；并断言 `JSON.stringify(body)` 不含 `"status":"denied"` |
| patch-mount | `AC-3: 默认目录下 4 个写工具逐个 denied、规则固定、门禁 operation 0 次`（改造现 `AC-17` 用例） | `Object.keys(WRITE_CALLS)` 仍 5 个键（含 judge），写集合 = `GITEE_WRITE_TOOLS`（4）；逐个 `status==='denied'`、`rule` 非空、`reason` 非空、不含 `"status":"done"`、`evidence===undefined`、**`executed===undefined`**（写信封不新增键）；`counter.operations===0`、`counter.actions` 为空 |
| patch-mount | `AC-4: 默认登记判定、不默认登记写`（新增；名字必须含这八字） | `real.catalog.size===4`；judge 条目 `kind==='read'`、`target==='change'`、`egress==='allow'`、`enabled===true`；4 个写动作 `catalog.has===false`；对 `GITEE_READ_ACTIONS`+judge 逐个 `decide.rule==='registered-action'` |
| patch-mount | `AC-8: 目录缺 judge 时仍可挂载，判定降级 denied`（新增） | 用补丁层文本删 judge 条目挂载：`mounted.ok===true`、工具 8 个仍在；judge 调用 `denied`/`unregistered-action`/operation 0；3 读仍 `allow` |
| patch-mount | `AC-7 反向` 空/缺读目录用例（既有，改名保留） | 不改断言：空目录抛 `GITEE_ACTION_UNREGISTERED`、`missing` deepEqual `GITEE_READ_ACTIONS` |
| entry | `AC-7: 补丁层自带目录与审计，0 条写；插件行不重复 heluo-policy`（改） | `catalog.length===4`；前 3 条 deepEqual `GITEE_READ_ACTIONS`；第 4 条 `{action:'gitee.delivery.judge', kind:'read', target:'change', egress:'allow', enabled:true}`；每条 `kind==='read'`、`enabled===true`；`filter(kind==='write').length===0`；`mountPolicy` 后 judge 在目录且 enabled |
| coexistence | 形态 A/C（改断言） | A：`catalog.size === GITEE_READ_ACTIONS.length + GITEE_JUDGE_TOOLS.length`（4）；C：并层 `size===8`、`filter(kind==='write').length===0`、17 工具 |
| actions | `AC-5: criteria 含 unknown → status unknown、固定 reason、不计通过` | 放行桩下判定 `status==='unknown'`、`reason==='DELIVERY_UNAVAILABLE'`、`readback.ok===false`、`readback.ready===false`、JSON 不含 `"status":"done"` |
| actions | `AC-6: 缺参/非法入参 fail closed` | 缺 `changeId`/`message`/`criteria` 非对象 → `status==='denied'`、`rule` 有值、`counter.invocations===0`、`execFile` 0 |
| bundle | `AC-11: 产物补丁层含默认登记的只读判定` | 解包产物里 `cordis.patch.yml` 文本含 `gitee.delivery.judge`、`egress: 'allow'`、`target: 'change'`；入口 sha256 与 `src` 逐字节一致（既有断言） |

### 7.3 AC-4 变异实验（交付自检的一部分，脚本随 run 归档）

脚本 `logs/teamflow/tf-mvutl9xh-fjab7l/scripts/mutation-judge-default.mjs`（**扩展既有共享脚本，不重建**；若不存在则新建这一个）：

1. 读 `packages/forge-gitee/cordis.patch.yml` 文本，`sha256` 记录（变异前）；
2. 写备份 `*.bak`，删除 judge 那一行（仅那一行）写回；
3. `node --test packages/forge-gitee/test/patch-mount.test.mjs` → **必须非 0 退出**，输出断言片段（期望 AC-4 用例失败，因为 `catalog.size` 3 或 judge 未登记）；
4. 用备份恢复（**不用 `git checkout --`**），再次 `sha256` 与变异前比对必须一致；
5. 再跑同一文件 → 必须全绿；把两次输出片段与两个 hash 写入 `logs/teamflow/tf-mvutl9xh-fjab7l/state/`（证据，不写入文档）。

### 7.4 只增不减

现有包内用例数 **171**（README 证据表，2026-10-29）；本次只新增/改写，不删用例、不加 `skip`。改写的 3 个既有用例（patch-mount AC-7→AC-1、patch-mount AC-17→AC-3、entry 目录形状）在改名时保留原断言语义（写动作仍 denied），并在文件头注释写明 r7 编号映射。

### 7.5 验证命令（dev 与 QA 共用）

```sh
cd packages/forge-gitee && node --test "test/*.test.mjs"      # 包内全量
cd packages/forge-gitee && node --test test/patch-mount.test.mjs test/entry.test.mjs test/coexistence.test.mjs
node --test tests/bundle-gitee.test.mjs
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r7'}))"
node logs/teamflow/tf-mvutl9xh-fjab7l/scripts/mutation-judge-default.mjs
pnpm check
git diff --check
git status --short
grep -rn '3 条只读\|五个受控动作\|5 个写工具\|5 个受控写\|3 读 + 5 受控写' README.md packages docs/design docs/teamflow/20261029-r4-forge-gitee || true
```

## 8. 任务拆分

| 波次 | 任务 | 文件（own） | reads | 依赖 |
|---|---|---|---|---|
| W1 | T1 生产码（目录 + 信封 + 常量） | `packages/forge-gitee/cordis.patch.yml`、`src/gitee-actions.mjs`、`src/gitee-tools.mjs`、`src/index.mjs` | `src/gitee-guard.mjs`、`packages/forge-policy/src/{catalog,approvals}.mjs` | — |
| W1 | T2 文档口径（README/设计/索引） | `packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md` | 补丁层、T1 目标契约 | — |
| W1 | T3 r4 四份就地修订（AC-17） | `docs/teamflow/20261029-r4-forge-gitee/{PRD,QA-REPORT,ACCEPTANCE,TECHNICAL}.md` | 本 PRD、T2 口径表 | — |
| W2 | T4 包内测试 | `packages/forge-gitee/test/patch-mount.test.mjs`、`entry.test.mjs`、`coexistence.test.mjs`、`actions.test.mjs` | T1 四个源文件、`src/gitee-delivery.mjs`、`test/helpers/fake-host.mjs` | T1 |
| W3 | T5 仓库根测试 + 交付自检 | `tests/bundle-gitee.test.mjs`、`logs/teamflow/tf-mvutl9xh-fjab7l/scripts/mutation-judge-default.mjs` | 全部测试、`scripts/build-enterprise-bundle.mjs` | T4 |

- **T1 spec**：按 §2.1 写第 4 条目录（含 `egress: 'allow'`、`target: 'change'`）并改文件头/并层注释；`gitee-actions.mjs` 按 §3.3 透传 `executed`、judge 工具描述补"随包默认登记、只判定"、`:18`/`:39`/`:1175` 注释改口径；`gitee-tools.mjs` 拆分常量（8 个工具顺序不变）；`index.mjs` `writeTools()` 返回 4。自检：`node -e "import('./src/gitee-tools.mjs').then(m=>console.log(m.GITEE_TOOLS.length, m.GITEE_WRITE_TOOLS.length, m.GITEE_JUDGE_TOOLS.length))"` → `8 4 1`；`node --test test/actions.test.mjs`（应全绿，既有负测不因目录变化受影响）。
- **T2 spec**：口径统一为「3 读 + 1 只读判定 + 4 受控写」；工具表 judge 行默认列改"放行（随包登记，只读判定）"；共存表"7 条目录"改"8 条目录（3 读 + 1 只读判定 + devops 4）"，回滚段第 1 条改为"目录含 4 条：3 读 + judge"；设计文档 §12 未决行删除"五个受控写"表述（改为"四个受控写的范围与 C3 分类；判定已按只读登记"）。
- **T3 spec**：只在命中处追加 `> r7 修订：…` 引用行，原文与证据编号一字节不改；四份都改，不允许只改 TECHNICAL；每份开头不新增"修订历史"章节（那是 changelog，按 AGENTS.md 边界不进 AGENTS.md，也不改文档结构）。
- **T4 spec**：按 §7.2 表新增/改写用例；`WRITE_CALLS` 拆成 4 写 + 1 判定调用（`DELIVERY_CALL` 用 §3.2 的合法入参）；断言 `executed` 只出现在判定信封；补 AC-8 缺 judge 用例（用补丁层文本删行挂载，不改仓库文件）；跑 `node --test "test/*.test.mjs"` 全绿、用例数 ≥ 171+新增。
- **T5 spec**：在既有产物解包处加一条补丁层内容断言；写 §7.3 变异脚本并实跑一次（含 restore 后 sha256 比对）；跑 §7.5 全部命令（`pnpm check` 全绿、`git diff --check` 干净、grep 旧口径零命中）；发现缺陷当场修（自检范围仅限本次改动），**不写** `QA-REPORT.md`/`ACCEPTANCE.md`，不做跨环境/实机矩阵。
- **git 约束（每个任务都适用，不得丢失）**：当前分支 `feat/devops-change-flow` 上就地修改，**不新建/不切换分支、不 commit、不 push、不 merge**；不得用 `git reset --hard` / `git checkout --` 清理（变异实验用文件备份还原）；不删除他人未提交改动（`?? TEAM-FULL-INSTALL.md` 保持原样）；构建产物只落 `dist/r7`（被既有 `.gitignore` 覆盖），不提交 `.tgz`/日志/`dist`；文档只写 `docs/teamflow/20261030-r7-judge-default-catalog/` 与 AC-17 明确授权的 r4 四份；不写宿主绝对路径。
- **安装不归子代理**：真实 `dsh plugin remove/add` 与重启加载由主 agent 在验收阶段执行（AC-13/14/15）。

## 9. 验收映射与证据

| AC | 证据（命令/文件） | 来源类型 |
|---|---|---|
| AC-1 | `entry.test.mjs` 目录形状用例 + 补丁层文本 | 离线测试 |
| AC-2 | patch-mount `AC-2` 用例（真实策略服务装配） | 离线测试 |
| AC-3 | patch-mount `AC-3` 用例（4 写 denied、operation 0） | 离线测试 |
| AC-4 | patch-mount `AC-4` 用例 + §7.3 变异脚本输出（两次 hash、两次退出码） | 离线测试 |
| AC-5 / AC-6 | actions.test 断言补齐（unknown 固定 reason / 缺参零子进程） | 离线测试 |
| AC-7 | patch-mount AC-1/AC-3 + actions `CONFIRM_REQUIRED_ACTIONS` 断言 | 离线测试 |
| AC-8 | patch-mount `AC-8` 用例（缺 judge 仍挂载） | 离线测试 |
| AC-9 / AC-10 | `node --test tests/bundle-gitee.test.mjs`（清单/白名单/闭包） | 离线构建 |
| AC-11 | `buildBundle({destination:'dist/r7'})` + 产物 sha256/补丁层断言；`shasum -a 256 packages/forge-gitee/src/gitee-actions.mjs` | 离线构建 |
| AC-12 | 产物入口 `node --input-type=module -e "import('dist/r7/package/src/index.mjs')"` | 离线构建 |
| AC-13 / AC-14 | 主 agent 手动 remove/add 四项复核；回滚装回 `a0a506f3…` 旧包 | **NOT RUN**（本阶段） |
| AC-15 | 重启后 8 工具出现、判定不再 `unregistered` | **NOT RUN**（宿主重启） |
| AC-16 | §7.5 grep 零命中 + 三份文档 diff | 静态检查 |
| AC-17 | r4 四份 `grep -n "r7 修订"` 每份 ≥1，且原文保留 | 文档审查 |
| AC-18 | `pnpm check`（全绿、0 skip、用例数只增）、`git diff --check` | 离线测试 |
| AC-19 | 本文件 §7.5/§9 的命令、时间、宿主 `0.2.1-rc.2`；真机与安装 NOT RUN | 记录 |
| AC-20 | `git status --short` 仅 `docs/teamflow/`、`TEAM-FULL-INSTALL.md`、改动的源码/测试/文档；无 tgz/dist 入库 | 记录 |

## 10. 风险与回滚

| 风险 | 表现 | 处置 |
|---|---|---|
| 漏写 `egress: 'allow'` | 判定 `denied`、`rule: egress-confirm`；AC-2 红 | entry 用例显式断言 `egress==='allow'`；变异实验可再验证 |
| 常量拆分漏改消费点 | `index.mjs` 工具数不变但 `writeTools()` 变 4，若测试仍按 5 断言会红 | T1 自检命令 + T4 全量包内测试 |
| `executed` 扩散到写信封 | 四个写工具返回体多键，违反"四状态/契约不变" | AC-3 断言 `executed===undefined` |
| r4 标注写成"覆盖"而不是"追加" | 原文或证据编号丢失，违反 AC-17 | T3 只追加引用块；`grep -c` 命中数与基线对比 |
| 同版本重装未 remove | 宿主仍加载旧 tarball，判定继续 `denied`（假失败） | AC-13 命令明确 remove→add；排查指引写 README 回滚段 |
| 回滚包 sha 不匹配 | 回滚后行为不可预期 | 装前 `shasum -a 256` 校验 `a0a506f3ee300030b7bc94f4e04e1c1d4e173e30749299f6a01b58843d92092c` |
| 并层用户只并入 3 条旧目录 | 判定 `denied`，被误报为缺陷 | README 共存表写明"并层需并入 4 条，含 judge" |

回滚：代码层 `git diff` 反向补丁即可（不 commit、不推），装层层按 AC-14 装回旧 tarball；判定条目的移除等价于把 `catalog` 第 4 行删掉——因为门禁与 fail-closed 语义不依赖它。

## 11. 未决事项

无阻塞项。r4 四份的具体命中行以 `grep -n` 实测为准（PRD.md:98/108、TECHNICAL.md:79/356、ACCEPTANCE.md:4/18、QA-REPORT.md:3/47 为落笔时位置，行号漂移不改变"逐处追加标注"的验收口径）。
