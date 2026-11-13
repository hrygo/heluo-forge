# 企业模型设置手动添加模型实施方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-021 |
| 文档名称 | 企业模型设置手动添加模型实施方案 |
| 版本 | V0.3.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-13 |
| 门禁 | 设计评审：`docs/design/plugins/forge-iam.md` §13/§13.1 的「目录唯一来源」边界须由负责人批准后实施；本方案以 `main` `f8f7a29` 为基线，仓库内只做本地模拟验证，不授予生产能力 |
| 文档层级 | L2 实施计划；字段、错误码与安全边界以设计文档和契约为准 |

> 编制依据：2026-11-13 读取的 `main` `f8f7a29` 工作区源码与测试；GitHub issue [#273](https://github.com/hrygo/heluo-forge/issues/273)（本方案目标）、[#202](https://github.com/hrygo/heluo-forge/issues/202)（模型目录解析，PR #252 未合并）、[#174](https://github.com/hrygo/heluo-forge/issues/174)（模型执行入口门禁）；`gh` 只读查询 PR #252 状态为 `MERGEABLE`（2026-11-13）。全部结论来自静态阅读与既有离线用例，**未经真实企业网关、目标宿主或双端实机验证**。
>
> 修订记录：V0.2.0 修掉服务层透传缺失、写后重拉目录、`remove` 被 backend 锁死、上限矛盾；V0.3.0 依据第二轮独立复核修掉适配器重建仍被 `backend` 前置、`stale` 被手动条目污染、`manualTruncated` 链路断点、`manualModels` 重置点缺失、删除时默认值顺序、add 与在途 refresh 的竞态窗口、`source`/错误码口径不一致。

> 关联文档：[IAM 接入详细设计](<../design/plugins/forge-iam.md>)、[逐模块设计索引](<../design/README.md>)、[网关接入契约](<../contracts/gateway-contract.md>)、[IAM 调用失败自愈方案](<2026-11-12-iam-call-failure-recovery.md>)、[forge-iam 开发指南](<../../packages/forge-iam/docs/developer-guide.md>)、[forge-iam 使用手册](<../../packages/forge-iam/docs/user-guide.md>)。

---

## 1. 问题结论

现行实现把「可调用模型」定义为 **启用集 ∩ 网关目录**：目录只来自 `GET {baseURL}/models`，用户无法声明目录之外的模型。企业网关可能不列出全部所需模型（管理员只开放了子集，或网关的 `/models` 不完整），用户即使持有该模型的调用权限也无法在宿主中选用。

目标是在**不新增任何旁路**的前提下，让用户可在企业模型设置页声明模型 ID；声明后进入模型列表，可配置/启用/停用/删除，并在满足既有身份与凭据条件时进入真实调用链路；是否真正可调用由企业网关裁决。

现行设计明确禁止这一能力（`docs/design/plugins/forge-iam.md:1051`：「严禁手工填写模型 ID 绕过网关目录」；§13.1 第 1 条 `:1059`：「目录源唯一定律」）。因此本议题的性质是**准入边界修订**，不是新增功能点：先获批修订设计，再实施。

推荐方向：把「目录唯一来源」改为**两级权威**——目录唯一提供元数据与可用性证据，用户可追加**本机声明**的条目；两类条目在合流后共用同一准入校验与同一错误归因，声明本身不产生任何授权。

## 2. 当前实现与根因

### 2.1 准入判定把「已知条目」写成了硬条件

- `packages/forge-iam/src/managed-models.mjs:190`：`allowed = route === provider && enabled(model) && enabledInCatalog(model)`。
- `enabledInCatalog` 定义在 `:189`，实参是内存中的 `models`（`:483` 由 `applyModelOptions(rawModels, modelOptions)` 派生）；`rawModels` 只来自 `discover()`（`:462`），即网关目录。
- `managed-models.mjs:285`（流守卫 `refusal`）、`:595`（`prepareCall`）、`:612`（`resolveModel`）在判定失败时统一抛 `ENTERPRISE_MODEL_NOT_ALLOWED`（文案见 `:47`）。
- 目录外的模型因此既不会出现在 `listModels`（只返回启用项，`:578-589`），也无法发起调用。

### 2.2 启用集写入会静默丢弃目录外的 ID

`managed-models.mjs:643-648`：`applyOptions` 把提交的映射当作启用集，先 `normalizeSelection`（`:100-108`，只按 `isModelId` 过滤），随后 `if (!rawModels.some(item => item.id === id)) delete nextMap[id]`（`:647`），接口仍返回 `ok: true`（`:675-680`）。客户端即使提交了目录外 ID 也必然被吞掉。

### 2.3 持久化没有「来源」概念，且服务层只透传三字段

- 键 `heluo-iam/model-selection`（`store.mjs:497`），记录 `{version:1, type, subject, models, defaultModelId, updatedAt}`（`:604-617`）；解析同时校验 `version` 与 `type`（`:552-570`）。
- `sanitizeModelOption` 白名单只保留 `name`、`contextWindow`、`maxTokens`、`inputModalities`、`reasoningEfforts`（`:504-526`）。
- `MAX_SELECTED_MODELS = 200`（`:500`），`defaultModelId` 必须落在 `models` 内（`:544`）；「A selection is valid only as a whole; a malformed one is ignored, never migrated」（`:529-547`）。
- 服务层 `service-model-selection.mjs` 的 `readSelection` 有**四个返回点**（`:121`、`:124`、`:130`、`:132`），只有 `:132` 真正返回记录，其余三点硬编码 `{subject, saved, models, defaultModelId}`；`saveSelection` 解构并只透传 `{ models, defaultModelId }`（`:136`、`:153`）。`service.mjs:294`、`:297` 直接挂这两个函数。
- 运行期身份变化会重置内存态（`managed-models.mjs:254-259`：`clearCatalog()` + 清空 `modelOptions/defaultModelId/selectionSaved`），`clearCatalog()` 在 `:226-229`。

### 2.4 元数据只有默认值

`discover()` 只取 `id`，容量与模态硬编码为 200000 / 64000 / `['text']`（`managed-models.mjs:139-140`，常量在 `model-options.mjs:15-16`）；`capabilities` / `compliance` 尚未解析（issue #202，PR #252）。用户覆盖经 `applyModelOptions` 生效（`model-options.mjs:175-213`，以 `...item` 展开，新增 `source` 可自然保留）。

### 2.5 目录条目上限、截断与失败语义

- 防御上限 `CATALOG_ENTRY_LIMIT = 500`（`managed-models.mjs:110`），先按 id 稳定排序再裁剪并计数（`:145-147`），`truncated` 进入视图（`:698`）。
- 目录失败分支（`:491-513`）：不可重试的码会 `backend = undefined`（`:503`），保留列表供展示。
- 视图 `stale` 当前定义为 `catalogState === 'error' && models.length > 0`（`:702`）。一旦 `models` 合入手动条目，这个判定就会在「目录从未成功」时也为真，界面会显示「已缓存 N 个模型」并写「（已加载本地缓存模型，可继续使用）」（`client.js:2612-2620`）——**本方案必须同时修正该判定**，否则等于虚报可用。

### 2.6 界面与视图装配

- 模型卡 `renderModelsCard`（`client.js:2533`）；工具条（`:2648-2730`，刷新按钮 `:2694-2727`）；底部 `fiam-actions`（`:2792-2817`，含重复的「刷新模型列表」）；列表 `modelList`（`:3105-3110`）、`visibleModels`（`:3112-3119`）；行渲染 `renderModelItem`（`:2093`）；「全部默认启用」`enableAllModelsWithDefaults`（`:3071-3081`，遍历 `modelAccess.models`）。
- 视图派生 `deriveModelUi`（`:1511-1524`）是**字段白名单**（state/configured/ready/loading/failed/stale/models/error）；`useModelCatalogue.data`（`:3133-3139`）同样白名单。新增字段不在这两处出现就到不了界面。
- 宿主侧装配 `service-state.mjs:83-91`：`modelAccess` 由 runtime `getView()` 展开后叠加 `configured/baseURL`，并在「不可恢复 / 凭据未就绪」时用 7 键覆盖对象强制 `models: []` 等。覆盖对象不含新字段，展开残留会穿透。
- `state.mjs:125` 的 `createView` 只透传 `details.modelAccess`，因此**新字段必须落在 `modelAccess` 内**，放到 IamView 顶层会被静默丢弃。
- 浏览器缓存按 `principal + 网关地址` 分键（`forge-iam.cached-models.v2`，`:2833-2843`），`view.modelAccess.models` 原样回写（`:2887-2892`），`source` 不会丢。
- 错误提示单表 `ERROR_NOTICE`（`:1755`，`errorNotice()` 在 `:1828`），由 `client-structure.test.mjs:104-111` 保证「不写成 if 链」。

### 2.7 会被本方案改写的既有断言

- `test/managed-models.test.mjs:617-630`（目录内但未启用 → 三入口全拒）、`:647-656`、`:658-666`、`:436-465`；`:21-25` 的 IAM stub 直接重建 `{ models, defaultModelId }`，绕过服务层——不改它「重启恢复」用例会假绿；`:772-782` 的 stale 断言在「目录存在后失败」场景下仍成立，可用于回归新的 stale 口径。
- `test/model-selection-store.test.mjs:73-97`。
- `test/client-managed-models.test.mjs:43-59`、`:61-99`、`:624-646`、`:647-661`（宿主 `MESSAGES` 与面板文案双向比对）、`:679-717`。

## 3. 目标行为

1. **声明**：已登录且网关凭据可用时，用户可在企业模型设置页输入模型 ID 完成添加；ID 只做非空与长度 ≤ 200 校验，**不限制字符集**（复用 `model-options.mjs:20-21`）。
2. **列表**：添加成功后条目出现在列表并带来源标记；可展开配置（名称/上下文/最大输出/输入模态/推理区间）、启用/停用、删除。目录条目**不可删除**。
3. **协同**：刷新目录不删除手动条目；同 ID 以网关元数据为准且只出现一次；网关后来返回该 ID 时条目保留、不自动启用、不重复。
4. **调用**：已启用的手动条目可进入宿主模型选择器，并经既有企业网关发起调用；未登录、缺凭据、未启用、网关拒绝仍按现有码拒绝，不显示为成功。
5. **隔离**：按 `subject` 持久化；换账号不继承（内存与存储两侧都要清）；退出/身份变化按现有重置路径清空；不写入任何密钥。
6. **不变量**：`permit()`（登录/凭据/过期）、代际与绑定校验（`IAM_MODEL_CONTEXT_CHANGED`、`IAM_GATEWAY_BINDING_CHANGED`）、`ENTERPRISE_MODEL_NOT_ALLOWED` 的入口语义、`capabilities/compliance` 不参与授权判定，均不改变。
7. **「不自动启用」的边界**：添加动作本身不启用条目；「全部默认启用」是显式批量动作，覆盖一切可用条目（含手动条目），需在界面文案中写明。

## 4. 推荐解决方案

### 4.1 方案 A（推荐）：手动声明作为可用集合的第二来源

区分三个集合，其余管线不动：

| 集合 | 来源 | 用途 |
|---|---|---|
| `catalogModels` | 仅 `discover()` 成功结果 | 元数据、首跑默认、`catalogTruncated`、`stale` 判定 |
| `manualModels` | 本机声明（持久化） | 追加条目，不自动启用 |
| `rawModels` = 合并结果 | `mergeAvailableModels(catalogModels, manualModels)` | 既有 `applyOptions` / `allowed` / `listModels` / 适配器构造的输入 |

- 合并规则：按 id 去重，目录优先（同 ID 保留目录元数据并记 `source: 'gateway'`）；手动条目记 `source: 'manual'`；手动条目不参与 500 条裁剪。
- `mergeAvailableModels` 为**新增纯函数**，放在 `model-options.mjs`（与 `applyModelOptions` 同处，便于单测），两个入参均不修改，对 `undefined` 入参按空数组处理。
- `allowed` 由「启用 ∧ 在目录」变为「启用 ∧ 在可用集合」；`applyOptions:647` 的删除条件随之自动对齐。
- 新增运行时方法**一个**：`updateManualModel({ action: 'add' | 'remove', id })`；界面层的 `addManualModel` / `removeManualModel` 只是客户端动作名，不与运行时同名。
- 增删**不重新拉取目录**：写库 → 重算 `rawModels`/`models` → 重建适配器 → `publish()` → `syncHostDefault()`。重建取自 `applyOptions:655-671` 的尾部，但**必须去掉其中的 `backend &&` 前置**（只要求 `rawModels.length > 0` 且 `resolveGatewayConnection()` 成功），否则目录失败时添加会「落库成功但永远不可调用」。
- 优势：唯一需要的语义增量是「条目来源」，而不是新增准入通路；`permit()`、错误码、代际校验、适配器构造全部不动。

### 4.2 备选与取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| B 独立存储键 | 新增 `heluo-iam/manual-models`，运行期读取后合流 | 优点是保留 `parseModelSelection` 的「整份合法否则忽略」强不变量；代价是重复一套 subject 校验、版本化、读写竞态与一次 IO。本方案选择记录内加法并**只对该字段局部放宽**（见 §6.2），风险面用测试锁死；若评审认为局部放宽不可接受，改选 B 只需换存储层，运行期合流点不变 |
| C 放行任意 ID | `allowed` 改为「已启用 且（在目录 或 在手动集）」，并特判 `:647`、`:658-666` | 与 A 的实际差异只在「合流点在集合构造还是判定层」；A 让下游（排序、覆盖、适配器、默认模型）拿到同一份真实集合。选 A |
| D 配置项预置 | `managedModels.manualModels` 由管理员在部署配置里声明 | 不满足 issue：需求是终端用户在自己账号下自助添加，且要按账号隔离、可删除。可作为未来“管理员统一预置”的补充能力，不在本议题范围 |
| E 独立 provider | 把手动条目做成第二个 provider | 违反「不引入任意提供方、地址或 Key」边界，且绕开既有门禁形态。明确不采用 |
| F 仅界面展示 | 客户端伪条目 | 不满足 issue 验收第 2 条（真实调用链路）。明确不采用 |

### 4.3 设计边界修订（前置裁决）

建议把 `docs/design/plugins/forge-iam.md:1051` 与 §13.1 第 1 条（`:1059`）改为：

> 模型目录仍由 `GET ${baseUrl}/models` 唯一提供元数据与可用性证据；用户可追加声明目录外的模型 ID，该声明只表示本人希望在本机配置并使用该模型，**不构成任何企业授权**。声明条目与目录条目共用同一登录、凭据、启用校验与同一错误归因；是否真正可调用由企业网关裁决。目录为该 ID 提供元数据时以目录为准，否则使用默认容量与用户覆盖。

同时保留原段中「不引入任意提供方、地址或 Key」「关闭原生通用模型提供商与自由配置界面」等边界表述。另需同步三处既有文字：§13.1 第 3 条（`:1061`）的「提示区分」与代码不符（代码折叠为 `ENTERPRISE_MODEL_NOT_ALLOWED`），本方案**只修文档、不改错误码**；§13.1 第 4 条（`:1062`）记录格式须加 `manual`；`:1055` 的 `stale` 语义须补「仅当存在最近一次成功目录时成立」。已知第二处既存偏差：`forge-iam.md:871` 把 `ENTERPRISE_MODEL_NOT_ALLOWED` 标为 403，而 `ERROR_STATUS` 无该键（缺省 500），本方案不修改，列入 §9.1。

## 5. 详细实施步骤

> 每个单元可独立提交；U1 必须先获批准。提交信息遵守仓库约定，不以 `#` 起头，引用 issue 时用内联 `issue #273`。

### U1 设计修订（评审闸口）

- 文件与位置：`docs/design/plugins/forge-iam.md`（`:1051`、`:1055`、`:1059`、`:1061`、`:1062`，以及 §5.3 的 `IamView` 接口片段 `:405-416`）、`docs/design/README.md:28` 与 `:87`。
- 内容：§13.2「手动模型条目」——两级权威口径（§4.3 原文）、协同规则（§6.1）、存储字段（§6.2）、安全声明（§6.3）、`IamView` 增量字段（`modelAccess.models[].source` 与 `modelAccess.manualTruncated`，并写明二者位于 `modelAccess` 内）；明确「未实机验证」。
- 完成判据：`pnpm check:docs` 通过；§9.1 第 1 项取得负责人批准结论并记入本文件。
- 不做：不改 `ERROR_STATUS`、不改 §871 的错误码表。

### U2 存储与解析（`model-options.mjs`、`store.mjs`、`service-model-selection.mjs`）

- `model-options.mjs`：新增常量 `MAX_MANUAL_MODELS = 100` 与纯函数 `mergeAvailableModels(catalog, manual)`（导出，供运行期与单测使用）；不修改既有导出语义。
- `store.mjs`：
  - 记录增加可选顶层 `manual: [{ id, addedAt }]`；`save({ subject, models, defaultModelId, manual })` 写入。
  - `parseModelSelection` 解析 `manual`：缺失/非数组 → `[]`；逐条要求对象且 `isModelId(id)`，`addedAt` 非 ISO 字符串时置 `null`（不判非法）；按 id 去重保留首条；超过 `MAX_MANUAL_MODELS` 时保留前 100 并把超出条数作为 `manualTruncated` 返回。
  - **对「整份合法否则忽略」的局部放宽**：`manual` 是启用集之外的补充字段，畸形只降级该字段，**不得**因手动段让整份选择作废（否则会静默回退首跑默认、丢失启用集）。此例外必须写进注释，并由测试固定。
  - `version` 保持 1：`manual` 是可选加法字段，旧读端忽略未知字段而不丢启用集。
  - 已知边界：启用集 200 条上限（`:500`）对手动 id 同样计数；超限时写入按既有 `IAM_MODEL_SELECTION_INVALID` 失败，需在用例中固定，不新增错误码。
- `service-model-selection.mjs`：
  - `readSelection` **四个返回点**（`:121`、`:124`、`:130`、`:132`）全部给出 `manual: []` 与 `manualTruncated: 0`（真实记录分支返回解析值）。
  - `saveSelection({ models, defaultModelId, manual })` 透传到 `target.save`。
- 测试：`test/model-selection-store.test.mjs`（往返、旧记录无 `manual`、畸形手动段只丢该段、重复去重、101 条截断并回报、换 subject 不继承、`addedAt` 畸形置 null）；`test/model-selection-service.test.mjs`（四个返回点的默认值、透传、过期/换账号拒绝）。

### U3 运行期合流、重置与增删（`managed-models.mjs`、`service-state.mjs`）

- 状态：`catalogModels = []`、`manualModels = []`、`manualTruncated = 0`；`rawModels` 改为派生值。
- `loadSelection()`（`:387-402`）：读取并保存三个状态；读取失败分支（`:396-401`）必须把 `manualModels` 置 `[]`、`manualTruncated` 置 `0`，不得留下上一次的值。
- `persistSelection()`（`:405-416`）：写 `{ models: modelOptions, defaultModelId, manual: manualModels }`；`saveSelection` 不存在时保持 best-effort 语义。
- 重置点（**新增，必须显式**）：`clearCatalog()`（`:226-229`）与身份变化分支（`:256-257`）追加清空 `manualModels`/`manualTruncated`；`dispose()`（`:724-728`）一并清空。
- `refresh()`：`catalogModels = found`；`rawModels = mergeAvailableModels(catalogModels, manualModels)` 在 `loadSelection()`（`:461`）之后赋值（仍约 `:462`）；在 `:483` 的 `models = applyModelOptions(...)` **之前再合流一次**（`rawModels = mergeAvailableModels(catalogModels, manualModels)`），以缩小与并发增删的窗口；`:467-482` 首跑默认只从 `catalogModels` 挑，`defaultModelId` 对齐在 `rawModels` 中查找。
- 判定：`enabledInCatalog` 改名 `isAvailable`（`:188-190`），`allowed` 改用之；`:647` 删除条件表达不变。
- 视图：`getView()`（`:693-723`）每项增加 `source: 'gateway' | 'manual'`；顶层增加 `manualTruncated`（有值时）；**`stale` 改为 `catalogState === 'error' && catalogModels.length > 0`**（只有真正存在最近一次成功目录才算「已缓存」）。
- 内部函数 `rebuildAdapter()`：从 `:655-671` 抽出，条件为 `rawModels.length > 0`（**不要求既有 `backend`**）；失败时保留旧 `backend`（若有）并把错误码返回给调用方，不打断已保存的声明。
- 新增运行时方法（与 `updateModelOptions` 共用 `optionsChain`，`:686-691`）：
  ```js
  updateManualModel({ action, id }) // action: 'add' | 'remove'
  ```
  - 公共前置：`permit(sample())` 不通过直接抛对应码。
  - `add`：`isModelId` 失败 → `IAM_MODEL_ID_INVALID`；已存在 → `IAM_MODEL_DUPLICATE`（`details.source` 取 `'gateway'` / `'manual'`，与视图同一套词汇）；超 `MAX_MANUAL_MODELS` → `IAM_MODEL_LIMIT_REACHED`（`details.limit`）。
  - `remove`：不在 `manualModels` 中即幂等返回成功（不写库、不重建）。
  - **内存先改、再写库**：先在内存更新 `manualModels`（`add` 追加 / `remove` 删除）、从 `modelOptions` 删除对应键、并按 `:649` 口径重指 `defaultModelId`（指向下一个已启用项或 `null`）；随后**单次** `persistSelection()`（同一条记录写入，天然原子）。写入失败则回滚上述内存改动并抛 `IAM_MODEL_SELECTION_UNWRITTEN`，不虚报成功。
  - 写库成功后：`await (flight?.promise ?? Promise.resolve()).catch(() => {})`（闭合与在途刷新的窗口）→ `rawModels = mergeAvailableModels(...)` → `models = applyModelOptions(...)` → `rebuildAdapter()` → `publish()` → `syncHostDefault()`（`:554`）。
  - **不调用 `refresh()`**；`rebuildAdapter()` 失败不撤销已保存的声明，返回 `{ ok: true, persisted: true, rebuildError: <code> }`，由界面提示「已保存，暂不可用」并保留条目。
  - 返回 `{ ok: true, persisted, defaultModelId, enabled, models, manual: manualModels, manualTruncated, rebuildError? }`。
- `MESSAGES`（`:42`）：新增三条文案（宿主文案是客户端双向比对的基准）。
- `service-state.mjs:83-91`：不可恢复/凭据未就绪的覆盖对象显式加入 `manualTruncated: 0`，避免「列表已清空但仍显示截断提示」；同时把该文件加入本单元改动清单。
- 测试：见 §7。

### U4 服务与路由（`service.mjs`、`routes.mjs`、`error-contract.mjs`）

- `service.mjs:283-287` 附近新增 `updateManualModel(payload)`，与 `updateModelOptions` 同构（runtime 缺失抛 `ENTERPRISE_MODELS_UNAVAILABLE`）。
- `routes.mjs:428-447` 同段新增 `PUT /api/forge-iam/models/manual`：要求 `hasMutationHeader(req)`（`:211`）；body `{ action, id }`；**非法 action 或缺少 id 用既有 `IAM_REQUEST_INVALID`（400）**，不新增错误码；成功返回 `{ ...result, view: service.getView() }`；其余错误走 `ERROR_STATUS[code] ?? 500` 与 `errorBody`。
- `error-contract.mjs` 的 `ERROR_STATUS` 增加 `IAM_MODEL_ID_INVALID: 400`、`IAM_MODEL_DUPLICATE: 409`、`IAM_MODEL_LIMIT_REACHED: 409`。
- 测试：`test/routes.test.mjs`（缺 mutation header 403、非法 action 400 且码为 `IAM_REQUEST_INVALID`、成功返回 view、三个新码的状态映射、错误体不回显其他敏感信息）。

### U5 客户端（`client.js`）

- 视图派生：`deriveModelUi`（`:1511-1524`）增加 `manualTruncated`；`useModelCatalogue.data`（`:3133-3139`）透出该值；渲染一行提示「已截断 N 条手动模型」（与 `fiam-notice-warn` 同风格）。
- 状态（`useModelCatalogue`，`:2849-3149`）：新增 `manualForm`（`{ open, id, error, saving }`）；`actions`（`:3140-3148`）增加 `openManualForm`、`closeManualForm`、`submitManualForm`、`removeManualModel`。
- 入口：底部 `fiam-actions`（`:2792-2817`）在「刷新模型列表」旁加「手动添加」；禁用条件与相邻按钮同口径，含 `credential.saving`（参考 `:2796`、`:2707`、`:2803`）、`modelSaving`、`viewBarrier.current.pending`、`!ui.ready`、`!gatewayUi.configured`。
- 表单：渲染在列表与底部动作之间（`:2780-2792` 之间），`aria-label="模型 ID"` 输入框、内联提示（长度 ≤ 200、不限字符集、能否调用由网关决定）、取消/添加按钮；回车提交。
- 校验（即时提示，服务端权威）：trim 非空、长度 ≤ 200、与 `modelList` 中 id 重复时提示「该模型已在列表中」。
- 提交：`PUT /api/forge-iam/models/manual`，复用现有 fetch 封装与 mutation header；成功 → 关闭表单、`setModelNotice('已添加 {id}，可在列表中配置并启用。')`、采用响应 `view`；返回 `rebuildError` 时改提示「已保存，暂不可用」；失败 → 保留输入、按 `ERROR_NOTICE` 显示（三条新文案与宿主 `MESSAGES` 一字不差，由 `client-managed-models.test.mjs:647-661` 强制）。
- 条目内（`renderModelItem`，`:2093`）：`model.source === 'manual'` 时显示「手动」徽章与「不随目录刷新移除」副行；条目右侧增加删除按钮（仅手动条目，`aria-label="删除手动模型 {id}"`）。
- 批量动作：`enableAllModelsWithDefaults`（`:3071-3081`）保持覆盖全部可用条目，并在按钮提示/说明中写明「含手动条目」。
- 文案：卡片副标题与底部说明补「手动条目不随目录刷新移除；未启用的模型不会出现在对话模型选择器」；`stale` 文案不再出现在「无目录、仅手动」场景（由 U3 的判定修正自动保证）。
- 缓存：`view.modelAccess.models` 原样写入（`:2887-2892`），`source` 随缓存保留；缓存键不变。

### U6 文档同步与探针

- `packages/forge-iam/docs/developer-guide.md`「可配置网关与动态模型目录」（`:347` 起）：补手动条目、存储字段、错误码与边界。
- `packages/forge-iam/docs/user-guide.md`：补操作步骤与「手动录入不等于企业授权」。
- `packages/forge-iam/README.md`（`:22` 附近）能力列表补一行。
- 契约 `docs/contracts/gateway-contract.md` **不改**：调用协议、请求头与鉴权不变。
- 探针（可选取证）：`scripts/probe/run-iam-managed-models-probe.mjs` 增一条「目录不含、手动声明后调用」的合成路径，结果写入 §8。

## 6. 关键实现说明

### 6.1 合并与协同规则

| 场景 | 行为 |
|---|---|
| 添加已在目录中的 ID | 拒绝 `IAM_MODEL_DUPLICATE`（`details.source='gateway'`），不改存储 |
| 添加已存在的手动 ID | 相同码（`details.source='manual'`），不改存储 |
| 目录失败时添加 | 允许并落库；重建适配器**不依赖既有 `backend`**，成功则可调用；重建失败保留声明并返回 `rebuildError`，界面提示「已保存，暂不可用」 |
| 刷新目录 | 手动条目保留、不参与 500 条裁剪；同 ID 以目录元数据为准，`source` 记为 `gateway`，手动记录保留 |
| 网关后来返回该 ID | 同上；不重复、不自动启用 |
| 删除手动条目 | 内存先删（`manual` + 启用集 + 默认值重指）后单次写；目录提供该 ID 时降级为普通目录条目（未启用）；重复删除幂等 |
| 网关拒绝调用 | 403 → `ENTERPRISE_GATEWAY_FORBIDDEN`、其它 4xx → `ENTERPRISE_GATEWAY_REQUEST_REJECTED`，如实失败 |
| 身份/凭据变化 | 内存清空 `manualModels`/`manualTruncated` 并按 `subject` 重新读取；他人记录不继承、不删除 |
| 记录被篡改或超限 | 读侧保留前 100 并回报 `manualTruncated`；写侧超限直接拒绝，不静默截断 |

### 6.2 存储形态（`version` 保持 1）

```jsonc
{
  "version": 1, "type": "heluo-iam-model-selection", "subject": "<sub>",
  "models": { "<catalog-id>": { "maxTokens": "8K" }, "<manual-id>": {} },
  "defaultModelId": "<id|null>",
  "manual": [{ "id": "<manual-id>", "addedAt": "2026-11-13T02:32:13.000Z" }],
  "updatedAt": "<iso>"
}
```

- `manual` 只记来源，不记密钥、不记网关地址；`addedAt` 仅用于排障与展示。
- 降级读取：旧读端忽略 `manual`；`models` 中残留的手动 id 会在旧代码 `applyOptions` 中被丢弃（不报错），升级后由 `manual` 恢复来源。
- 被读侧截断的手动 id 从可用集合消失后，其覆盖会在下一次 `applyOptions` 持久化时按 `:647` 删除——与网关撤下模型时的既有行为一致；`manualTruncated` 必须让界面可见，避免静默。

### 6.3 安全声明（写入设计文档）

- **能保证**：手动声明不改变登录/凭据/过期判定；不在未登录、缺凭据、未启用时放行；不引入新提供方、地址或 Key；请求仍只发往当前企业网关；网关拒绝如实归因；不把声明持久化为授权凭据。
- **不能保证**：同权进程内 JS 仍可绕过进程内门禁；手动 ID 不证明企业授权，也不改变网关配额与权限判断；本方案无法阻止「用户声明了网关侧确有权限但目录未列出的模型」被成功调用——这正是需求目的，须在设计里写明。

### 6.4 并发与状态机

- `updateManualModel` 与 `updateModelOptions` 共用 `optionsChain`（`:686-691`）：两个添加、添加与启用写、添加与参数保存按提交顺序串行。
- **与在途 `refresh()` 的竞态窗口**：`refresh()` 依次 `discover`（`:459`）→ `loadSelection`（`:461`）→ 合流（`:462`）→ `models`（`:483`）。若添加落在 `:462` 与 `:483` 之间，该次刷新会用旧快照覆盖 `models`，条目从视图消失。两道防护同时实施：① `refresh()` 在 `:483` 前重新合流；② `updateManualModel` 在重算前 `await flight?.promise`，再重算、重建、发布。并发用例按此顺序固定行为。
- 不引入新 `catalogState`（`unconfigured|loading|ready|error`，`:179,447,487`）：增删不改目录状态。
- 重建失败沿用旧 `backend`（若有）并保持条目在列表中；下一次成功刷新或保存后生效；与 `applyOptions:667-670` 的既有处理一致。
- 首跑边界：若添加发生在 `selectionSaved === false` 时，`persistSelection()` 会把记录标记为已保存，从而跳过「自动启用目录首个模型」。正常路径下界面在首个 `refresh()` 完成后才可交互；实现时按现状接受，并在测试里固定，不额外补写。

## 7. 测试方案

| 文件 | 场景 |
|---|---|
| `test/managed-models.test.mjs` | 手动条目出现在 `getView().models` 且 `source==='manual'`；目录为空（0 条）时手动条目可启用并调用；**目录失败时添加：条目可见、rebuild 成功后 `listModels`/`prepareCall` 放行**；**仅手动条目时 `stale === false`**（`catalogState==='error'` 且 `catalogModels` 为空）；刷新后保留、不重复；同 ID 不重复；未启用的手动条目三入口拒绝（沿用 `:617-630` 口径）；删除后不可调用；删除幂等；删除指向默认值的条目后 `defaultModelId` 重指；重启恢复（**须同时改 `:21-25` 的 stub 以透传 `manual`**）；换账号后内存与存储都不继承；超限拒绝；`IAM_MODEL_DUPLICATE` 的两套 `details.source`；`applyOptions` 不删除手动 id 的覆盖；`:772-782` 的既有 stale 断言保持绿 |
| `test/model-selection-store.test.mjs` | 往返、旧记录无 `manual`、畸形手动段只丢该段、重复去重、101 条截断并回报、换 subject 不继承、`addedAt` 畸形置 null、启用集 200 条超限的既有失败行为 |
| `test/model-selection-service.test.mjs` | 四个返回点的 `manual`/`manualTruncated` 默认值；透传；过期/换账号拒绝 |
| `test/model-options.test.mjs` | `mergeAvailableModels`：目录优先、去重、顺序稳定、不改入参、空集/`undefined` 入参 |
| `test/routes.test.mjs` | 缺 mutation header 403、非法 action 400 且码为 `IAM_REQUEST_INVALID`、成功返回 view、三个新码状态映射 |
| `test/client-managed-models.test.mjs` | 入口开合；空/超长/重复提示；提交载荷 `{action:'add',id}`；成功后 notice 与列表更新；`rebuildError` 文案；服务端拒绝保留输入；删除流程；来源徽章；`manualTruncated` 提示；`credential.saving` 时按钮禁用；「全部默认启用」含手动条目 |
| 并发用例（新增文件） | 两次 add 串行且都落库；add 与 enable 写交错不丢手动 id；**add 落在在途 refresh 的 `:462`–`:483` 窗口内，最终视图仍含该条目** |
| `test/service-state-*.test.mjs` | 不可恢复/凭据未就绪时 `modelAccess.manualTruncated === 0`、`models === []` |

- 文本双向比对沿用 `test/client-managed-models.test.mjs:647-661`；hook 顺序由 `test/support/client-panel.mjs:79` 自动断言。
- 变异证明：注释掉 `mergeAvailableModels` 调用、删掉 `:483` 前的重新合流、删掉服务端重复校验、把 `manual` 从 `readSelection` 移除，对应用例都必须变红。

## 8. 验收标准

在仓库根目录执行；以下离线与合成检查已在 `feat/epic-273-integration` 上验证通过，外部企业网关与双端实机仍未联调：

| 检查 | 命令 | 预期 |
|---|---|---|
| 文档与链接 | `pnpm check:docs` | 零错误，受控文档已登记 |
| 结构与元数据 | `pnpm check:repo` | 通过 |
| 单元与契约 | `pnpm test:unit` | 全绿，含新增用例 |
| 差异卫生 | `git diff --check` | 无输出 |
| 推送前签名 | `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD` | 全部 verified |

行为判据（对应 issue #273 验收项；分支 `feat/epic-273-integration` 已完成离线代码/单测/合成探针，真实企业网关与双端实机仍未验证）：

- [x] 合法 ID 添加后出现在列表并可配置、启用；非法/重复/超限有明确文案。（离线单测 + 合成探针已验证）
- [x] 已启用的手动模型在登录且凭据可用时可被选择，并经既有网关调用；网关拒绝时展示真实失败码。（合成探针 `run-iam-managed-models-probe.mjs` 已覆盖；真实企业网关 403/404/400 待 #285 实机）
- [x] 刷新成功/失败、同 ID 合并、删除、重启恢复均不丢失其他模型配置；账号切换与退出符合隔离规则。（离线并发与变异测试已验证）
- [x] 未登录、缺凭据、未启用仍被拒绝；无法借此添加其他提供方或绕过企业授权。（离线与探针验证 `callsAfterLogout: 0`）
- [x] 本地模拟验证与真实企业网关/目标客户端验收分开记录，后者仍为未验证。

> 实施补充记账（2026-11-13，分支 `feat/epic-273-integration`）：按用户全量推进 Epic #273 指令，服务端手动模型路由最终收敛为 `POST /api/forge-iam/models/manual`（原草案曾写 `PUT`），错误码命名为 `IAM_MANUAL_MODEL_{INVALID,LIMIT,CONFLICT,NOT_FOUND}`；相关离线单测、UI 契约与合成探针均已闭环，文档元数据仍保持 `批准: 待定` 与外部真机未联调口径。

## 9. 风险与待决事项

### 9.1 待决事项（须负责人决定）

> 进展注（2026-11-13）：用户已在当前会话指令在 `feat/epic-273-integration` 完成 Epic #273 全量工作，第 1–4 项已在代码与设计 §13/§13.1/§13.2 中落地并通过离线单测及合成宿主探针；第 5–6 项单列留置、本轮不改；受控文档“审核/批准”栏仍按规范保持“待定”。

1. **设计边界**（阻塞 U2–U5 的行为改动）：§4.3 的两级权威口径是否批准。
2. **`stale` 语义调整**：本方案把「已缓存」限定为存在最近成功目录，属行为修正，是否接受。
3. **上限**：`MAX_MANUAL_MODELS = 100` 与目录 500 条是否合适。
4. **添加后是否自动启用**：不自动启用；批量按钮是显式动作。
5. **§871 错误码表**：`ENTERPRISE_MODEL_NOT_ALLOWED` 标 403 而 `ERROR_STATUS` 缺键，是否单独立项修正。
6. **管理员预置能力**（§4.2 方案 D）是否作为后续议题。

### 9.2 风险与回滚

1. **与 PR #252 的顺序**：`discover()` 条目构造会被 #252 重写。本方案把合流写成独立纯函数并单测，**顺序无关**；判据是「合流函数只依赖 discover 输出形状（`{id, name, contextWindow, maxTokens, input, inputModalities}`），不读内部字段」。#252 未合并也可开工；若并行，先跑 `test/managed-models.test.mjs:179-219` 的 ID/截断断言。
2. **与 issue #174 的关系**：真实执行入口门禁的实机取证不因本方案完成；本方案只保证不新增绕过路径。
3. **降级读取**：旧版本读新记录会忽略 `manual`，手动条目降级为不可用（不报错、不丢启用集）；升回新版后恢复。
4. **目录失败时的手动能力**：仅在 `resolveGatewayConnection()` 可用且重建成功时真正可调用；重建失败时条目可见但不可调用，界面与视图必须如实说明（这是本方案与「目录即可用性证据」的张力点，须写进 §13.2）。
5. **回滚**：单次 revert 功能单元即可；已落库的 `manual` 字段被旧代码忽略，不影响启用集。紧急关闭入口只需恢复 U5 的界面提交路径（服务端方法保留不调用），已添加条目退化为不可用，不需要数据迁移。
6. **未验证项**：真实网关对手动 ID 的裁决（403/404/400 实际归因）、双端 GUI、目标平台存储、Windows/麒麟实机，全部未验证，不得写成已具备生产能力。
7. **非目标**：不处理客户端两个「刷新」入口的冗余；不改网关契约；不新增提供方/地址/Key 输入；不做跨进程原子存储；不改 §871 错误码表。

## 10. Luna 执行清单

1. 核对基线：`git status --short` 只含本计划文档与 `docs/DOCUMENT-REGISTER.md` 的改动（不含他人未提交改动）；确认 `main` 记录为 `f8f7a29`；用 `gh pr view 252` 确认 #252 是否已合并并记下基线。
2. 取得 §9.1 第 1 项批准结论并记入本文件。**批准前唯一允许先行的是 U2 中的 `mergeAvailableModels` 纯函数与单测**（无运行时行为变更）；其余改动停止。
3. U1：修订设计文档 `:1051/:1055/:1059/:1061/:1062`、`IamView` 接口片段与设计索引，`pnpm check:docs` 通过后单独提交。
4. U2：`model-options.mjs` 常量与纯函数 + `store.mjs` 解析 + `service-model-selection.mjs` 四个返回点，配三份测试，提交。
5. U3：合流、重置点、`updateManualModel`、`rebuildAdapter`、`stale` 判定、`getView` 字段、`service-state` 覆盖分支、`MESSAGES`，配 `managed-models`/`model-options`/并发用例与变异证明，提交。
6. U4：服务方法、路由、`ERROR_STATUS`，配 `routes` 用例，提交。
7. U5：视图派生、入口、表单、来源标记、删除、批量动作文案与禁用条件，配 `client-managed-models` 用例，提交。
8. U6：开发指南、使用手册、README 同步；`pnpm check` 全量通过后提交。
9. 交付汇总：逐条列出实际执行的命令与结果、未验证项、与 issue #273 验收项的对应关系、commit 列表；不得把未执行项写成已通过。