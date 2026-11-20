# 受控写 P1 技术设计（身份常开 / 子代理拒绝 / 确认卡片 / 决策复用）

- 需求来源：同目录 [PRD.md](PRD.md)（21 条 AC）
- 工程：`packages/forge-policy`（唯一放行点），联动 `packages/forge-devops`、`packages/forge-gitee`
- 技术栈不变：Node 24.x / pnpm workspace / ESM `.mjs` / `node --test` / Cordis 补丁层
- 分支：`feat/policy-p1-baseline`（基于 `feat/policy-p0-skeleton`，HEAD `8c68d41`）
- 宿主锚定版本：**0.2.2-rc.3**（本机桌面端实测）。仓库 `.dsh-version` 与 PRD §11 按 `0.2.1-rc.3` 表述；实测版本更高且相关契约一致，实现以实测为准，`.dsh-version` 不在本需求内改动。
- 状态：代拟（待用户裁决 AC-21 实机项）

---

## 1. 结论摘要

P0 已有唯一放行点 `createGate()`：解析 → 身份 → 审计 begin → 执行一次 → 复验 → settle。P1 在**同一个放行点**上补四件事，不新增第二处判定：

1. **身份常开**：维持 P0 行为并把"每次调用独立解析、准入前 + 执行后各解析"锁进用例；配置层没有任何关闭键（`identity`/`requireIdentity` 之类键会命中 `unknown config key`）。
2. **子代理拒绝**：新增 `src/delegation.mjs`，用宿主真实字段 `agent.session.header.origin === 'subagent'` 判来源；`denyDelegatedWrites` 开则 6 条写动作一律拒绝（先于身份与卡片），关则"需卡片写"仍拒绝且不弹卡。
3. **确认卡片**：新增 `src/confirm.mjs`（载荷构造 + 应答判定 + `ctx.userQuestions` 网关），gate 在 `confirm-required` 决策与执行之间插入"至多一次 ask"，六错误码 fail-closed。
4. **决策复用**：新增 `src/reuse.mjs`（LRU 32、键=tool+callId+action+digest），只缓存允许，命中不弹卡、只留一条 `rule=reused-decision`。

配套：`IMPLEMENTED_RULES` 由空集改为三个开关；审计屏障新增单条写入 `record()` 与 `code` 字段（asked/answered 记录）；两个业务插件把宿主 `exec.callId` 透传进策略 exec，否则四元键在生产路径永不重复、复用等于空转。

四件事共用一次判定、一条审计链、一份一次性收据；失败一律拒绝，不降级、不事后通知。

---

## 2. 事实基线与既有约束

| 事实 | 出处 |
| --- | --- |
| 唯一放行点 `createGate()`，`admit` / `admitOnce` / `preExecute` / `guard` / `executeAction` 共用 `approved`+`admitting`+`admitted` 三件套 | `packages/forge-policy/src/gate.mjs` |
| 身份校验已在 `admitOnce`（空 actor 即拒）；`preExecute` 与 `executeAction` 执行后再解析一次 actor | `gate.mjs`（P0） |
| 审计字段白名单无 `code`；屏障只有 `begin`/`settle`，**没有单条写入** | `packages/forge-policy/src/audit.mjs`（`ALLOWED_FIELDS`、`createAuditBarrier`） |
| `IMPLEMENTED_RULES = []`，任何开关置 `true` 都在装载期报 `rules.<key>: … not implemented in this phase` | `packages/forge-policy/src/config.mjs` |
| `confirmation` 段只校验 `timeoutMs` 为正整数，**未拒绝未知键** | `config.mjs:189-192` |
| `confirmation.timeoutMs` 默认 `120_000`，`TOP_LEVEL_KEYS` 已含 `confirmation`，未知顶级键报 `<key>: unknown config key` | `config.mjs:42,51-54,181-183` |
| 6 条写动作：`gitee.issue.write`、`gitee.pr.write`、`change.clarification.write`、`gitee.review.publish`、`gitee.git.push`、`gitee.review.record`。其中 push 默认决策 `confirm`（`confirmation:'each'`），其余为研发/评审写（`confirmation:'scope'`） | `packages/forge-policy/src/classify.mjs`（`BUILTIN_ACTIONS`） |
| 卡片通道：`ctx.get('userQuestions')`，`ask({questions, agent, signal})`；**必须传恰好存活的 `exec.agent`**，否则 `assertLiveRoot` 抛 `DELEGATED_CALLER`/`CALLER_NOT_LIVE`；无应答端抛 `NO_PROVIDER` | 宿主 `dsh-user-questions/lib/index.js:492,539-543,675-718` |
| 子代理官方判据：`agent.session.header.origin !== 'subagent'` 才是普通会话；`session.header.parentSession` **不可**作为子代理判据（历史 fork 也带它） | 宿主 `docs/upgrade-guide/v0.2.1-rc.3/subagent-runtime-ownership/guide.zh.md:19` |
| `ToolExecution.callId: ToolCallId` 存在；`tools/pre-execute` 为 `(exec, next) => Promise<PreToolDecision>` | 宿主 `docs/subsystems/tools.zh.md:270,844` |
| 卡片文案原料已就绪：`prompts.mjs` 的 `LABELS`（6 动作中英文可读名）、`text()` 截断、`subject()` 目标定位 | `packages/forge-policy/src/prompts.mjs` |
| `README.md` 的"状态"行与"不提供 fail-open"是 `package-shape` 用例断言的字面模式 | `packages/forge-policy/test/package-shape.test.mjs:46-47` |

不复用 `intent.kind:'approval'`：宿主对 approval 意图要求**恰好 1 题、禁 multiSelect、禁 wait、标签必须与 options 一一对应**，而 P1 的题数随合并原因数变化（AC-6）。因此卡片只提供 `options`（两个固定标签），不声明 `intent`。

---

## 3. 判定模型（P1 版）

```
resolve（未登记 out-of-scope → 直接放行，不读身份、不弹卡、不写审计）
  └─ decideAction → deny?            → 拒绝（沿用 P0，不写审计）
  └─ delegation  personaOf(exec)
        ├─ denyDelegatedWrites=true 且 child → 拒绝 + 1 条 deny 审计（code=POLICY_CONFIRM_DELEGATED）
        └─ 否则继续
  └─ identity（常开）actor 为空        → 拒绝 IDENTITY_COPY（沿用 P0）
  └─ decision==='confirm'（confirmPush/confirmDopWrite 命中）
        ├─ child                        → 拒绝 + 1 条 deny 审计（code=POLICY_CONFIRM_DELEGATED）
        ├─ 复用命中（键+摘要一致）       → 跳过 ask（begin.rule = 'reused-decision'）
        └─ 未命中                        → 写 1 条 asked → ask（≤timeoutMs，至多一次）→ 写 1 条 answered
              ├─ allow → 入缓存（仅 allow）→ begin(rule='confirm-allowed')
              └─ deny  → 拒绝 + 结构化结果 code（DENIED/TIMEOUT/UNAVAILABLE/INVALID/DELEGATED/ERROR）
  └─ audit.begin（收据）→ 执行**恰好一次** → 执行后复验 actor → audit.settle
```

与 P0 的差异只有三处插入点（delegation、confirm、reuse），其余顺序、收据、复验、settle 全部沿用。

---

## 4. 数据模型与存储

### 4.1 配置模型（`src/config.mjs`）

```js
export const IMPLEMENTED_RULES = Object.freeze([
  'denyDelegatedWrites',
  'confirmPush',
  'confirmDopWrite',
]);
export const CONFIRMATION_KEYS = Object.freeze(['timeoutMs']);
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;
```

| 键 | 类型 | 默认 | P1 校验 |
| --- | --- | --- | --- |
| `rules.denyDelegatedWrites` | boolean | `false` | 可置 `true`（已实现） |
| `rules.confirmPush` | boolean | `false` | 可置 `true`（已实现） |
| `rules.confirmDopWrite` | boolean | `false` | 可置 `true`（已实现） |
| `rules.<其余五个>` | boolean | `false` | 置 `true` → `rules.<key>: this rule is not implemented in this phase and cannot be enabled` |
| `confirmation.timeoutMs` | 正整数 | `120000` | 沿用 `checkPositiveInteger`；`≤0`、小数、字符串均报错 |
| `confirmation.<其他>` | — | — | **新增**：`confirmation.<key>: unknown config key` |

- 身份没有配置面：`identity` / `requireIdentity` / `requireActor` 等键不在 `TOP_LEVEL_KEYS`，写入即 `unknown config key`（除非另有该键被显式登记）；用例逐键验证 AC-1。
- `timeoutMs` 覆盖**整次询问**（从 ask 发出到结论落定），不是每题单独计时。
- 三开关都关闭时不生成 `delegation` / `confirmation` 阶段（`buildPipeline` 只纳入 `IMPLEMENTED_RULES` 里的阶段规则），行为与 P0 完全一致——`src/pipeline.mjs` 无需改动，`STAGE_RULES` 与 `STAGE` 顺序（resolve→delegation→identity→…→confirmation）已就绪。

### 4.2 审计记录模型（`src/audit.mjs`）

字段白名单新增 `code`（`POLICY_CONFIRM_*` 落进结构化结果与审计，满足 AC-10），其余不变；`FORBIDDEN_FIELDS` 不动（`content`/`arguments`/`token` 等写进去仍抛 `POLICY_AUDIT_FIELD_FORBIDDEN`）。

P1 新增两种记录（单条写入，非 begin/settle 对）：

```jsonc
// asked：弹卡前
{ "phase": "asked", "decision": "pending", "action": "gitee.git.push", "target": "corp/repo",
  "tool": "forge_gitee_write", "rule": "confirm-required", "operationId": "<callId>",
  "agent": { "kind": "root" }, "summary": "受控写 gitee.git.push 需要人工确认（动作确认）",
  "observedAt": "2026-11-20T09:00:00.000Z" }

// answered：结论
{ "phase": "answered", "decision": "allow", "rule": "confirm-required",
  "operationId": "<callId>", "agent": { "kind": "root" }, "durationMs": 4213,
  "summary": "受控写 gitee.git.push 的确认结论：允许本次写入" }
```

- `answered.decision` ∈ `allow|deny`；`answered.code` 取六个 `POLICY_CONFIRM_*` 之一（允许路径不写 `code`，只有拒绝/异常写），文案与记录都从同一个 verdict 取值，不二次推断。
- `phase` 取值域扩为 `begin|settle|asked|answered`；`decision` 新增 `pending`（自由字符串，仍 ≤512）。
- asked/answered 的 `summary` 只含动作可读名与原因类别，**不含正文、路径、令牌**（AC-17）。
- 次数契约：允许路径 = 1 条 asked + 1 条 answered + 1 对 begin/settle；拒绝路径 = 1 条 asked + 1 条 answered（+ 不 begin）；复用命中 = 0 条 asked/answered，begin 的 `rule='reused-decision'`；delegation 拒绝 = 恰 1 条 `decision:'deny'`（`phase` 缺省，不写 asked/answered）。

### 4.3 决策缓存模型（`src/reuse.mjs`）

```js
// 单条目（不落盘、不进日志、不跨会话）
{ key, tool, callId, action, digest, decidedAt, hits }
```

| 项 | 规则 |
| --- | --- |
| 键 4 分量 | `tool`（`exec.name`）+ `callId`（字符串）+ `action` + `digest`（审计 `contentDigest` 同一归一化摘要） |
| 容量 | 32，`Map` 插入序做 LRU：命中即 `delete`+`set` 刷新为最新，不增条目 |
| 淘汰 | 第 33 个不同键淘汰最久未用（`Map.keys().next().value`） |
| 只存 | `decision === 'allow'` 且键四分量齐备 |
| 清空 | 插件卸载/重载（`ctx.effect` teardown）即 `clear()`；宿主重启自然为空 |
| 存储 | 进程内内存，无文件、无 SQLite、无 DSH profile 持久化 |

### 4.4 来源模型（`src/delegation.mjs`）

```js
export const PERSONA = Object.freeze({ HOST: 'host', ROOT: 'root', CHILD: 'child' });
```

| 判据（按序短路） | 结果 |
| --- | --- |
| `agent == null` | `host` |
| `agent.session?.header?.origin === 'subagent'` | `child`（宿主真值，唯一权威） |
| `agent.kind` / `agent.origin` 为字符串且 ∈ `{child, subagent, sub-agent, worker, teammate}` | `child`（测试桩与历史字段兼容） |
| 其余（含 `{kind:'agent'}` 桩、`{id}` 桩、真实普通 agent） | `root` |

- **不使用** `session.header.parentSession`：宿主明确说明历史普通 fork 也带该字段。
- **不使用** `ctx.subagents.rootOf()`：非托管实例抛 `UNAUTHORIZED`，且 delegation 判定必须能在纯桩用例中跑。
- 审计 `agent.kind` 由 `agentKindOf(exec)` 给出：`host`（无 agent）/`child`/`root`，若 `agent.kind` 是字符串则原样（保持 P0 已有用例 `{kind:'agent'}` ⇒ `'agent'` 的兼容）。

### 4.5 存储落点

不新增存储。审计仍写既有 sink（`memory` 环形 1000 / `file` 的 `$DSH_HOME/logs/forge-policy-<YYYY-MM-DD>.jsonl`，按天轮转保留 7 天）；缓存只在内存；卡片载荷只在一次调用内存在。

---

## 5. API 设计

本仓库的"API"= 包导出（模块签名）+ 宿主服务注册 + 配置 schema。P1 不新增 HTTP 路由、不新增工具、不新增命令。

### 5.1 `src/delegation.mjs`（新增）

```js
export const PERSONA;                                              // { HOST, ROOT, CHILD }
export function personaOf(agent);                                  // agent → 'host'|'root'|'child'
export function agentKindOf(exec);                                 // → 'host'|'root'|'child'|string
export function delegationCopy(action);                            // → 拒绝文案（含「子代理」「主会话」）
export function confirmDelegatedCopy(action);                      // → 需卡片但来源为子代理的拒绝文案
export function delegationSummary(action);                         // → 审计 summary（含「子代理」）
```

文案常量（唯一真源，gate 与用例都从这里取）：

```
delegationCopy(action) =
  「受控写「${action}」已拒绝：本次调用来自子代理，受控写必须在主会话发起。请在主会话重新发起该动作。」
confirmDelegatedCopy(action) =
  「受控写「${action}」需要人工确认，但本次调用来自子代理；受控写必须在主会话发起，未执行。」
```

不出现"换工具""拆参数""改动作"之类可规避提示（AC-3），也不出现路径/令牌。

### 5.2 `src/confirm.mjs`（新增）

```js
export const CONFIRM_CODES;   // { DENIED, TIMEOUT, UNAVAILABLE, INVALID_ANSWER, DELEGATED, ERROR }
export const CONFIRM_LABELS;  // { allow: '允许本次写入', deny: '取消本次写入' }
export const CONFIRM_REASONS; // { action: '动作确认', content: '内容风险' }

/** 纯函数：按合并后的原因构造卡片载荷（动作确认在前、内容风险在后） */
export function buildConfirmationCard({ action, target, args = {}, reasons = ['action'] } = {});
// → { questions: AskUserQuestionItem[], allowLabel, denyLabel }

/** 纯函数：把宿主应答判定成 verdict（形状/标签全部精确匹配） */
export function readConfirmationAnswer(answer, { questions, allowLabel, denyLabel } = {});
// → { decision: 'allow'|'deny', code?: string }

/** 通道：解析 ctx.get('userQuestions')，自定义超时，永不抛错，永不挂死 */
export function createConfirmationGateway({
  resolveService = (ctx) => ctx?.get?.('userQuestions'),
  timeoutMs = 120_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {});
// → { ask({ ctx, agent, action, questions, timeoutMs }): Promise<verdict>, dispose(), pending: () => number }
```

`ask` 的返回（**总是 resolve**，不 reject）：

| 情形 | 返回 |
| --- | --- |
| `resolveService(ctx)` 非对象或无 `ask` 方法 | `{ decision:'deny', code:'POLICY_CONFIRM_UNAVAILABLE' }`，**不发起调用** |
| `agent == null`（无会话主体，桌面端无法呈现） | `{ decision:'deny', code:'POLICY_CONFIRM_UNAVAILABLE' }` |
| `agent.session?.header?.origin === 'subagent'`（gate 已挡，网关二次保险） | `{ decision:'deny', code:'POLICY_CONFIRM_DELEGATED' }` |
| 超过 `timeoutMs` 未得结论 | abort 挂起询问 → `{ decision:'deny', code:'POLICY_CONFIRM_TIMEOUT' }` |
| 宿主抛 `NO_PROVIDER` | `{ decision:'deny', code:'POLICY_CONFIRM_UNAVAILABLE' }` |
| 宿主抛 `DELEGATED_CALLER` / `CALLER_NOT_LIVE` | `{ decision:'deny', code:'POLICY_CONFIRM_DELEGATED' }` |
| 宿主抛 `ASK_ABORTED`（自己超时触发） | `{ decision:'deny', code:'POLICY_CONFIRM_TIMEOUT' }` |
| 宿主抛其他（含 `BAD_INTENT`/`EMPTY_QUESTIONS`） | `{ decision:'deny', code:'POLICY_CONFIRM_ERROR' }` |
| 应答形状/标签不合法 | `{ decision:'deny', code:'POLICY_CONFIRM_INVALID_ANSWER' }` |
| 含拒绝标签 | `{ decision:'deny', code:'POLICY_CONFIRM_DENIED' }` |
| 全部题目恰为允许标签 | `{ decision:'allow' }` |

实现要点：

- `Promise.race([service.ask(...), deadline])`；`deadline` 用注入的 `setTimer` 到点 resolve。**不用 `askTimed`**：它需要 `ToolCallId`、且 `pending` 语义是"稍后仍可回答"，与"超时即拒绝、永不执行"冲突。
- race 的败者必须 `p.catch(() => {})`，否则超时用例会留下未处理拒绝。
- 结论落定即 `clearTimer` 并 `controller.abort()`，释放宿主侧挂起询问（卸载/重载时同一路径收尾）。
- `dispose()` 后 `ask` 立即返回 `{ decision:'deny', code:'POLICY_CONFIRM_ERROR' }` 并 abort 全部挂起。

`readConfirmationAnswer` 的判定顺序（fail-closed，AC-7）：

1. `answer` 不是普通对象或 `answers` 不是数组 → `INVALID_ANSWER`；
2. 任一题缺项、id 不匹配、`selected` 不是字符串数组、长度 ≠ 1（单选）→ `INVALID_ANSWER`；
3. 任一题 `custom` 是非空字符串（用户输入了非标签文本）→ `INVALID_ANSWER`；
4. 任一 `selected[0]` 等于 `denyLabel` → `DENIED`（拒绝优先，即使另一题为允许）；
5. 任一 `selected[0]` 既非 `allowLabel` 也非 `denyLabel` → `INVALID_ANSWER`；
6. 全部等于 `allowLabel` 且题数、id 集合完全一致 → `allow`。

标签比较用 `===`，不做包含、大小写折叠、前缀匹配（AC-7 变异用例会改一个字符）。

### 5.3 `src/reuse.mjs`（新增）

```js
export const DECISION_CACHE_LIMIT = 32;
export function reuseKeyOf({ tool, callId, action, digest } = {});   // → string | undefined（任一分量缺失即 undefined）
export function createDecisionCache({ limit = DECISION_CACHE_LIMIT } = {});
// → { has(key), peek(key), set(entry), touch(key), delete(key), clear(), size(), limit }
```

`set` 接收 `{ key, tool, callId, action, digest, decidedAt }`；`peek` 返回冻结副本。键是分量拼接后再 hash 还是直接拼字符串：直接拼 `tool + '\u0000' + callId + '\u0000' + action + '\u0000' + digest`，避免 JSON 序列化开销与键序歧义。

### 5.4 `src/gate.mjs`（改）

```js
export function createGate({
  catalog, rules = {}, pipeline = [], audit, tools = {}, getActor, onDecision, now,
  confirmations,        // createConfirmationGateway() 的实例；缺省表示通道不可用
  decisionCache,        // createDecisionCache() 的实例；缺省表示禁用复用
  timeoutMs = 120_000,  // 与 config.confirmation.timeoutMs 同源
} = {});
// 返回对象在 P0 基础上新增：
//   confirmationCount: () => number     诊断：本实例发起过的 ask 次数（用例断言"允许前 0 次"）
```

`admitOnce` 的新顺序（每一步失败即返回 deny，不再往下走）：

```js
const decision = decideAction({ catalog, rules, action, target });
onDecision?.(decision, exec);
if (decision.action === 'deny') return deny(decision.reason);

const persona = personaOf(exec);
if (rules.denyDelegatedWrites === true && persona === PERSONA.CHILD) {
  await writeDenial({ code: CONFIRM_CODES.DELEGATED, rule: 'deny-delegated-writes' }); // 1 条 deny
  return deny(delegationCopy(action));
}

const actor = normalizeActor(await getActor?.(ctx));
if (actor === undefined) return deny(IDENTITY_COPY(action));

const digest = digestOf(exec);
let rule = decision.rule;                       // 'registered-write' 等
if (decision.action === 'confirm') {
  const key = reuseKeyOf({ tool: exec?.name, callId: text(exec?.callId), action, digest });
  const hit = key === undefined ? undefined : decisionCache?.peek(key);
  if (hit !== undefined && hit.digest === digest && hit.action === action) {
    decisionCache.touch(key);                   // 刷新 LRU，不增条目
    rule = 'reused-decision';                   // 不写 asked/answered、不 ask
  } else if (persona === PERSONA.CHILD) {
    await writeDenial({ code: CONFIRM_CODES.DELEGATED, rule: 'confirm-delegated-refused' });
    return deny(confirmDelegatedCopy(action));
  } else {
    const card = buildConfirmationCard({ action, target, args: exec?.arguments ?? {} });
    await writeConfirm({ phase: 'asked', decision: 'pending', rule: 'confirm-required', summary: askSummary(action) });
    const startedAt = now();
    confirmationCount += 1;
    const verdict = await confirmations?.ask({ ctx, agent: exec?.agent, action, questions: card.questions, timeoutMs })
      ?? { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE };
    const answered = await writeConfirm({
      phase: 'answered', decision: verdict.decision, ...(verdict.code === undefined ? {} : { code: verdict.code }),
      rule: 'confirm-required', durationMs: now() - startedAt, summary: answerSummary(action, verdict),
    });
    if (verdict.decision !== 'allow') return deny(denyCopyOf(verdict, action));   // 拒绝 + code
    if (answered === 'failed') return deny(recordFailureCopy(action));            // 未记下结论就不执行
    if (key !== undefined) decisionCache.set({ key, tool: exec?.name, callId: text(exec?.callId), action, digest, decidedAt: now() });
    rule = 'confirm-allowed';
  }
}

// 之后完全沿用 P0：audit.begin({ rule, … }) → approved/admitted
```

- `writeConfirm` / `writeDenial` = `audit.record(...)` 的薄包装：**写失败不抛到宿主**，`asked` 失败 → `deny(recordFailureCopy(action))`（文案不含「审计」二字，AC-11）；`answered` 失败但 verdict 已允许 → 同样拒绝（收据链不能有洞）。
- `deny()` 返回值新增结构化 `code`：`{ kind:'deny', reason, code? }`，让 devops/gitee 的 `{kind:'error', text}` 与日志里能读到同一个码（AC-10）。`reason` 仍是可读中文，不拼码。
- `guard()` / `preExecute()` 的复验不变：`preExecute` 里已有 digest 与 actor 复验，因此 AC-14 的"命中后执行前重新校验"由既有链路 + 命中时显式 `hit.digest === digest` 双重覆盖。
- `executeAction()` 不变（它调同一个 `admit`），因此 `preExecute`、`executeAction`、命令包装三条入口自动共享 P1 行为。

### 5.5 `src/audit.mjs`（改）

```js
// ALLOWED_FIELDS 增加 'code'
export function buildAuditRecord(fields, { now } = {});        // 签名不变
export function createAuditBarrier({ sink, timeoutMs = 2_000, now, onGap } = {}); // 返回对象新增：
//   record(fields): Promise<AuditEntry>   // 单条写入：强制 observedAt，不自造 phase，不参与 degraded 判定；
//                                          // 失败抛 POLICY_AUDIT_WRITE_FAILED / POLICY_AUDIT_TIMEOUT（与 begin 同码）
```

`record` 复用 `buildAuditRecord` + 同一 sink 与 2s 超时；**失败不置 `degraded`**（它不是执行收据，不构成"缺口"），由 gate 自行降级为拒绝。

### 5.6 `src/installer.mjs`（改）

```js
const confirmations = overrides.confirmations ?? createConfirmationGateway({
  resolveService: (c) => c?.get?.('userQuestions'),
  timeoutMs: config.confirmation.timeoutMs,
});
const decisionCache = overrides.decisionCache ?? createDecisionCache({ limit: DECISION_CACHE_LIMIT });

createGate({ …P0 依赖, confirmations, decisionCache, timeoutMs: config.confirmation.timeoutMs });
```

- 装载期若 `rules.confirmPush || rules.confirmDopWrite` 且 `ctx.get('userQuestions')` 不可用：`ctx.logger?.warn?.(CONFIRMATION_UNAVAILABLE_NOTICE)`——**告警但不拒绝装载**（无 UI 的 CLI 环境仍应能起插件），随后每次需卡片的写按 `POLICY_CONFIRM_UNAVAILABLE` 拒绝。这与 P0 "全关时 warn `OBSERVE_ONLY_NOTICE`" 同风格。
- teardown：`confirmations.dispose()` → 挂起询问按拒绝收尾；`decisionCache.clear()`（AC-13 卸载即空）。
- `policy` 服务只增两个只读诊断：`confirmationAvailable: () => boolean`、`decisionCacheSize: () => number`（供 QA 与实机核对，不改变调用面）。

### 5.7 `src/index.mjs` 与 `package.json`

- `src/index.mjs` 追加再导出：`PERSONA`、`personaOf`、`CONFIRM_CODES`、`CONFIRM_LABELS`、`buildConfirmationCard`、`readConfirmationAnswer`、`createConfirmationGateway`、`DECISION_CACHE_LIMIT`、`createDecisionCache`、`reuseKeyOf`、`DEFAULT_CONFIRMATION_TIMEOUT_MS`；`IMPLEMENTED_RULES` 内容变化。
- `package.json` `exports` 增加 `"./confirm"`、`"./delegation"`、`"./reuse"`（与既有明细导出同格式：`{ "import": "./src/x.mjs" }` 或该文件既有写法）。`files` 不变（已含 `src`）。

### 5.8 两插件透传宿主 callId

- `packages/forge-devops/src/tools.mjs`：`forge_devops_change_update` 转发 `if (exec?.callId !== undefined) forwarded.callId = exec.callId;`
- `packages/forge-devops/src/index.mjs:733`：`callId: text(callId) || devops-write-<seq>`（`text(callId)` 为空时回落到合成 id），`changeUpdate` 形参增 `callId`。
- `packages/forge-gitee/src/gitee-git.mjs:715-725`：push 的 `service.execute({…})` 增加 `...(exec?.callId === undefined ? {} : { callId: exec.callId })`。
- `packages/forge-gitee/src/gitee-guard.mjs:282`：`callId: text(source.callId) || nextCallId(action.split('.')[1] || 'action')`。

理由：两个插件现在按尝试自增生成合成 id，四元键在生产路径永不重复，复用等于空转。透传后"同一次宿主工具调用的重试"才可能命中；`callId` 缺失时键为 `undefined`，既不查询也不写缓存（fail-closed，不上探）。现有测试没有对合成 id 字面量的断言，改造不破坏既有用例。

---

## 6. 前端（宿主 UI）与载荷契约

`packages/forge-policy` 没有客户端代码（`package.json` 无 `client.js`、无 `./client` 导出），P1 不引入前端依赖、不自建卡片组件。卡片由宿主 `dsh-client-ui-user-questions` 渲染，本包交付的是 **questions 载荷 + 文案 + 判定**。

页面/组件映射：

| 宿主位置 | 由谁渲染 | 我们用到的能力 |
| --- | --- | --- |
| 会话内确认卡片（问题列表 + 选项按钮） | `dsh-client-ui-user-questions` | `options[{label,description}]` |
| 卡片标题行 | 同上（`header`） | `header` = 原因类别（`动作确认` / `内容风险`） |
| 卡片正文 | 同上（`question` + `detail`） | 动作可读名 + 目标定位 + "只放行本次调用" |
| 客户端 ↔ 宿主应答 | 同上 | `AskUserQuestionAnswer.answers[].selected` |

载荷（每原因一题）：

```jsonc
{
  "id": "forge-policy-action-confirm",
  "header": "动作确认",
  "question": "允许在 corp.example/repo 上推送分支 feat/x？",
  "detail": "本次调用需要人工确认：动作确认。这条确认只放行本次调用。",
  "options": [
    { "label": "允许本次写入", "description": "只放行这一次调用" },
    { "label": "取消本次写入", "description": "拒绝本次调用，不执行" }
  ]
}
```

展示规则（AC-6/AC-17，逐条配用例）：

- 题数 = 合并后原因数；生产路径 P1 只有 `action` 一个原因，合并函数支持 `['action','content']`，顺序固定动作确认在前。
- 只展示：动作可读名（`prompts.mjs` 的 `LABELS.zh`）、目标定位（仓库/分支或 changeId）、原因类别、"只放行本次调用"。
- 不展示：正文、参数原文、令牌、绝对路径/盘符/UNC/`~`/URI、文件名字段、堆栈、命令。`sanitizeLocator(value)`（`prompts.mjs`）负责把疑似路径/URI 的目标替换为「目标（已隐藏）」。
- 标签是常量，UI 里不做本地化切换，避免应答值与判定常量不一致。

---

## 7. 状态管理与并发

### 7.1 单次判定状态机

```
idle → deciding → (deny | confirm-check) 
confirm-check → reuse-hit ──────────────┐
confirm-check → delegated-refused → deny│
confirm-check → asked → answered ───────┤→ admitted → executed → settled
                                        └→ denied（含 timeout/unavailable/invalid/denied）
asked → asked-failed → denied（不弹卡）
```

迁移全部在 `admitOnce` 内同步表达，每次迁移有一个终态；`asked` 只有一条出边（answered 或 asked-failed），因此"至多一次 ask"由结构保证，不靠计数防御。

### 7.2 并发与一次性收据

- `admitting`（WeakSet）+ `approved`（WeakMap）沿用 P0：同一 `exec` 并发进入只准入一次，因此"并发准入不重复发卡"（AC-15）由既有结构保证；P1 用例用 `Promise.all` 打同一 `exec` 断言 `ask` 恰好 1 次、`confirmationCount === 1`。
- 不同 `exec` 各自独立判定、各自弹卡（预期行为，不是缺陷）。

### 7.3 卸载与挂起询问

`ctx.effect` teardown 顺序：`dispose()` 网关（abort 全部挂起 → 挂起 `ask` 归入 `POLICY_CONFIRM_ERROR`/超时分支）→ `decisionCache.clear()` → 清 sink。挂起询问不跨会话恢复；若 gate 已 `disposed`，`preExecute`/`executeAction` 仍走 P0 的 `disposed` 拒绝分支。

### 7.4 单一真源

决策缓存是**加速器**不是真源：命中只跳过"问人"这一步，身份、摘要、收据、执行后复验一律照跑；缓存条目不会被任何视图反向写入。

---

## 8. 关键实现点与边界

1. **唯一放行点**：所有 P1 行为只写在 `gate.mjs` 的 `admitOnce` 内；`preExecute`/`guard`/`executeAction`/命令包装三条入口自动共享，不允许任何入口旁路。
2. **顺序不可换**：delegation 先于 identity、identity 先于 confirm、confirm 先于 begin。用例为每种换序后果各留一条反例（如"先问身份再判子代理"会让子代理拿到 `IDENTITY_COPY` 而不是"主会话"文案）。
3. **失败即拒绝**：卡片通道缺失、超时、应答非法、ask 抛错、asked/answered 写失败，一律 `deny`；不存在"记录失败但仍执行"或"卡片只是事后通知"的分支。
4. **一次调用一次执行**：`entry.used` 与 `approved/admitted` 结构不变；复用命中也走 `approved`，不能凭缓存直接执行。
5. **摘要即身份**：`digestContent({name, arguments})` 是复用键的一部分，执行前 `preExecute` 再算一次比对；target/正文/分支任一变化即 miss（重新弹卡）或 cancel。
6. **文案不掺假**：超时不写成"你拒绝了"、通道缺失不写成"超时"、子代理不写成"没有权限"；`code` 只进结构化结果与审计，不进用户文案。
7. **不含路径/令牌**：审计 summary、卡片正文、拒绝文案三处共用 `sanitizeLocator` + `text()` 截断；用例用正则扫绝对路径、盘符、UNC、`~`、URI、`spawn`、`errno`、退出码、堆栈、`Bearer`/`token=`。
8. **子代理识别只用宿主真值**：`session.header.origin`；`parentSession` 明确不用；`agentKindOf` 保留字符串 `agent.kind` 兼容既有桩。
9. **`callId` 缺失即不复用**：键任一分量缺失 → `undefined` → 既不 peeking 也不 set。
10. **AC-16 的"依赖缺失"态**：装载期 warn + 每次拒绝，不把缺 UI 变成装载失败，也不在没有 UI 时放行。
11. **不新增运行时依赖**：超时用 `setTimeout`/`AbortController` 原生原语；LRU 用 `Map`；无 uuid/无 lru 包。
12. **`content` 私有通道不碰**：`exec.content` 仍只给内容闸，卡片与审计都不读它。

---

## 9. 测试策略

全部 `node --test`（根 `pnpm test:unit` / `pnpm check` 的最后一步），无网络、无真实 UI、无真实时钟等待（超时用例注入 `timeoutMs` 与假 `setTimer`）。

新增用例文件（只增不减）：

| 文件 | 覆盖 AC | 关键做法 |
| --- | --- | --- |
| `test/delegation.test.mjs` | AC-3、AC-4、AC-16 | 6 条写动作 × `denyDelegatedWrites` 开/关；`origin:'subagent'` 桩与 `{kind:'child'}` 桩；断言 `ask` 0 次、执行体 0 次、审计恰 1 条 deny、`agent.kind==='child'`、文案含「主会话」 |
| `test/confirmation-card.test.mjs` | AC-6、AC-17 | 载荷逐字段快照；1 vs 2 原因的顺序；6 类文案正则黑名单；`sanitizeLocator` 对 `/a/b`、`C:\\`、`\\\\host\\share`、`~/x`、`https://…` 的替换 |
| `test/confirmation-channel.test.mjs` | AC-7、AC-8、AC-9、AC-15 | 假 `userQuestions`：正常允许/拒绝/超时不返回/抛 `NO_PROVIDER`/抛 `DELEGATED_CALLER`/非法形状/未知标签/多选/custom 文本；`timeoutMs: 20` 断言 ≤100ms 出拒绝结论；`confirmationCount` 断言允许前 0、允许后 1；`Promise.all` 同 exec 并发只 1 次 |
| `test/confirmation-audit.test.mjs` | AC-10、AC-11 | 记录序列断言（asked→answered→begin→settle）；asked 写失败 → 不弹卡、拒绝、文案不含「审计」；六错误码唯一且在 `code` 字段 |
| `test/decision-reuse.test.mjs` | AC-12、AC-13、AC-14 | 键 4 分量逐一变异；拒绝/超时/无应答/非法应答/执行失败不入缓存；同键刷新不增条目；第 33 键淘汰最久；`clear()` 后重弹；命中后改 target → 重新弹卡；仅 `callId` 相同不得放行 |
| `test/identity-recheck.test.mjs` | AC-1、AC-2 | 计数型 `getActor`：准入前 1 次 + 执行后 1 次；两次调用不复用；`actor` 变化 → 执行 0 次或结果按失败处理 |
| `test/config.test.mjs`（扩） | AC-1、AC-16 | 三开关三态；其余五开关置 true 报 `rules.<key>`；`identity:false`、`confirmation.unknown: 1` 报 unknown config key |
| `test/audit.test.mjs`（扩） | AC-10 | `code` 进白名单、`phase:'asked'/'answered'` 落盘、`content` 仍被禁 |
| `test/package-shape.test.mjs`（扩） | AC-18 | 新增三导出可用；README 口径（保留既有两处字面断言） |
| `packages/forge-devops/test/*`、`packages/forge-gitee/test/*`（扩） | AC-12 生产链路 | `exec.callId` 透传后策略 exec 的 `callId` 等于宿主 id；缺失时仍为合成兜底 |

判据必须会失败：每条结构要求配一条"改坏就红"的变异（例如把标签比较改成 `includes`、把 asked 写入移到 ask 之后、把 delegation 判定挪到 identity 之后），变异过程记录在 PR 描述里，不写进代码。

NOT RUN（如实披露，不计入 CI）：AC-21 的隔离 profile 实机（`never` 会话 + `confirmPush`）由用户执行；本地只保证离线用例与装载期校验。

---

## 10. 任务拆分（可并行）

依赖：`T1/T2/T3/T4/T5` 可并行（互不共享文件）；`T6` 等 `T2–T5`；`T7` 等 `T6`；`T8`、`T9` 独立；`T10` 最后。

| # | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| T1 | 开关与配置口径 | `src/config.mjs`、`test/config.test.mjs` | `IMPLEMENTED_RULES` 三键、`CONFIRMATION_KEYS`、`DEFAULT_CONFIRMATION_TIMEOUT_MS`；只改校验不改默认值 |
| T2 | 审计单条写入 | `src/audit.mjs`、`test/audit.test.mjs` | `ALLOWED_FIELDS` 加 `code`、`createAuditBarrier().record()`、phase 域扩展；不置 degraded |
| T3 | 来源判定 | `src/delegation.mjs`（新）、`src/gate.mjs`（仅替换 `agentKindOf` 引用）、`test/delegation.test.mjs` | `personaOf` 按宿主 `origin`；两条文案 + 一条 summary |
| T4 | 卡片与通道 | `src/confirm.mjs`（新）、`src/prompts.mjs`、`test/confirmation-card.test.mjs`、`test/confirmation-channel.test.mjs` | 载荷构造、应答判定、网关（race + abort + 码映射）、`sanitizeLocator`/`confirmationCardCopy` |
| T5 | 决策复用 | `src/reuse.mjs`（新）、`test/decision-reuse.test.mjs` | LRU 32、四元键、只存允许 |
| T6 | gate 集成 | `src/gate.mjs`、`src/installer.mjs`、`test/confirmation-audit.test.mjs`、`test/identity-recheck.test.mjs` | `admitOnce` 插入三处；`deny()` 带 `code`；`confirmationCount`；teardown |
| T7 | 导出面与服务诊断 | `src/index.mjs`、`package.json`、`test/apply.test.mjs`、`test/package-shape.test.mjs` | 三个新 exports、`confirmationAvailable`/`decisionCacheSize` |
| T8 | 两插件 callId 透传 | `packages/forge-devops/src/tools.mjs`、`packages/forge-devops/src/index.mjs`、`packages/forge-gitee/src/gitee-git.mjs`、`packages/forge-gitee/src/gitee-guard.mjs` + 两包测试 | 有则透传、无则合成兜底；不改判定 |
| T9 | 文档口径 | `packages/forge-policy/README.md`、`packages/forge-policy/docs/DETAIL.zh.md`、`docs/DETAIL.md`、`docs/design/plugins/forge-policy.md` | 三开关已实现、其余五个未实现、只有 push 与 DOP 流转弹卡、默认 120s、复用范围；保留 `状态：可用（动作分类与内置词表`、`不提供 fail-open` 两处字面 |
| T10 | 分支/提交/PR | — | 本分支已建；提交说明不以 `#` 开头；PR base=`feat/policy-p0-skeleton`，标题 `feat(policy): P1 安全基线（身份/子代理/确认卡片/决策复用）`，描述列四项能力证据 + NOT RUN |

---

## 11. 风险与未验证项

1. **宿主任确认通道的实际呈现**（0.2.2-rc.3 桌面端）未做真机弹卡验证：本设计依赖 `ctx.get('userQuestions').ask({questions, agent, signal})` 的公开契约；AC-21 实机由用户执行。
2. **无 UI 环境（CLI/headless）**：`confirmPush`/`confirmDopWrite` 打开时受控写会全部 `POLICY_CONFIRM_UNAVAILABLE` 拒绝——这是预期的 fail-closed，但需在 README/DETAIL 明确写清，避免被读成"插件坏了"。
3. **复用命中率**依赖调用方透传 `callId`；插件之外的自定义调用方若继续用合成 id，复用不会命中（安全方向）。
4. **`agent.session.header.origin`** 是宿主升级面：若未来改动字段，delegation 判定会退化为 `root`（放行），因此配一条"字段缺失时按 root"的显式用例并在此记录该残余风险。
5. **`session.header.parentSession` 不可用**已按宿主升级指南处理；历史 fork 场景的实测未做（NOT RUN）。
6. **`confirmation.timeoutMs` 无上限**：设为极大值时行为等同"等用户"，仍不会挂死（超时仍是兜底）；不额外加限制以免误伤实机调试。
