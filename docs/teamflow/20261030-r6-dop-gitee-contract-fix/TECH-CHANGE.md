# TECH-CHANGE：企业 dop / Gitee gh 契约兼容修复（r6）

基线依赖：`docs/teamflow/20261030-r5-devops-config-slimming/`
取代：无（r1 AC-11 的字段集、逐条编号展示与来源标注规则不变；本单只补"原生命名 / 三段引用 / 包封输出"的兼容层，行为差异在 §4 逐条明示，历史任务夹不改）

## 1. 背景与目标

企业内网 Windows 实机 UAT（T1–T9）暴露三个产品缺陷：T3「配置后只读就绪」部分通过——dop 归一只认 snake_case 契约字段，企业原生 `code`/`state`/`summary`/`userStory` 使变更内容、验收条件、故事排期不可读；T6b「写开启后幂等」不可达——仓库引用只认两段 `owner/name`，Gitee `org/group/repo` 进不了写路径与幂等复用；`gh repo list --json` 的包封（`data.list` + `path_with_namespace`）与适配器不匹配——可见仓库恒空。

**目标一句话**：在不放松任何写门禁与 fail-closed 语义的前提下，让企业原生的记录命名、三段仓库引用与包封输出都能被现有归一 / 判定 / 门禁链路读懂。

下半三处根因均为读码结论（§2 给出文件与行）；UAT 报告与 `evidence/` 在用户 Windows 机器，本机不可读，本单不引用其内部数据。

## 2. 影响范围

| 模块 | 位置 | 改动性质 |
|---|---|---|
| dop 归一 | `packages/forge-devops/src/change-context.mjs:56`、`:83-93`、`:118-205` | 入口加别名层；必填集收敛、缺失字段降级 |
| 仓库引用解析 | 新增 `packages/forge-devops/src/repo-ref.mjs`（纯函数，零依赖） | 单点解析 2..3 段 |
| 引用调用面 | `src/gh-adapter.mjs:71-75`、`src/actions.mjs:61-64`、`src/tools.mjs:94-97`、`src/flow.mjs:371-373`、`src/repository-resolver.mjs:170-175` | 改为引用单点解析；裸名兜底收紧 |
| gh 包封 | `src/gh-adapter.mjs:163-169`（`parseList`）、`:151-157`（`parseObject`）、`:178-199`（`normalizeRepo`） | 解包 `data.list` / `data`；原生仓库名别名 |
| 测试与夹具 | `packages/forge-devops/test/` 的 `context`/`gh-adapter`/`repository`/`actions`/`tools`/`flow` 六个文件 + `test/fixtures/` | 新增夹具与用例；改写 3 条既有期望 |
| 零改动 | `src/http.mjs`、`src/index.mjs`、`src/runtime-config.mjs`、`client.js`、`packages/forge-gitee/**`、策略门禁、幂等键算法、配置页三键 | 不动（AC-9 快照与 HTTP 契约照旧） |

## 3. 技术方案

### 3.1 缺陷 1：原生字段别名（单点表，不猜名字）

- 在 `change-context.mjs` 顶部加**唯一**别名表 `NATIVE_ALIASES`，只收录 UAT 点名的原生命名：`code → id`、`state → status`、`summary → description`（同时兜 `title`）、`userStory → user_stories`。`normalizeChangeRecord` 入口先 `aliasRecord(raw)` 再走既有校验，映射后仍是 AC-11 的 snake_case 契约，内部 `Change` 形状不变。
- `userStory` 既可为数组也可为单对象（按单元素），故事项同样过别名；`release_info` 保留既有 snake_case/camelCase 双读，不吸收 wrapper 改名（`:80-93` 的注释仍是纪律）。
- 必填集收敛为 `id` / `title` / `status`（缺或空即 `RECORD_INVALID`，否则无法判定"读到的是哪条"）；`description`、`acceptance_criteria` 缺失改为进 `missingFields`，卡上用既有文案「平台未提供 `acceptance_criteria`」明示（`change-context.mjs:541-543` 已实现该渲染分支，是这处降级不是新机制的理由）。
- 不放松：`id` 空、`title` 非字符串、`acceptance_criteria` **存在但**非字符串数组、`expectedId` 不等（`ID_MISMATCH`）、`sourceType` 非词表，全部照旧拒绝。

### 3.2 缺陷 2：仓库引用从"两段"到"2..3 段"（单点解析）

- `repo-ref.mjs` 导出段正则 `[A-Za-z0-9][A-Za-z0-9._-]*`、`isRepoRef`（**2 或 3 段**）、`parseRepoRef`（`{path, segments}`）、`repoOfTarget`（剥 `#n` / `!n`）、`sameRepo`（全串优先，裸名兜底）。五处调用面改为引用它，消除五份已开始漂移的正则（`actions.mjs:62` 不锚定首字符、`gh-adapter.mjs:71` 锚定，同一输入判词不一致）。
- 链接形态同步：`gh-adapter.mjs:75` 的目标链接允许 2 或 3 段命名空间。
- **门禁含义（T6b 第二条根因）**：`flow.mjs:452` 的 `repoMismatch` 与 `tools.mjs` 的 `checkConfirm` 依赖 `repoOf`；若只改适配器不改这两处，三段引用会让"目标仓库 = 承建仓库"的核对**静默跳过**（`repoOf` 返回 `null`）——那比拒绝更糟，属门禁弱化，必须一并改。
- 裸名兜底收紧：`sameRepo` 仅在全串不匹配且候选内**唯一**同名时接受，跨组同名走 `MULTIPLE_CANDIDATES` 阻断，避免幂等复用串仓。
- 不放松：1 段、4 段、空段、以连字符开头、含空格 / NUL / `--` 前缀一律 `MISSING_TARGET` 且零子进程调用。

### 3.3 缺陷 3：清单包封与原生仓库名

- `parseList` 解包顺序：数组 → `data.list[]` → `data[]` → `items[]` → 单对象兜底。`data.list` 存在但非数组即 `MALFORMED_RESULT`；`data.list: []` 必须得空清单，**不得**回落成"单元素"（否则恒空变"一条脏对象"）。既有"清单只回单个对象按单元素处理"语义保留在解包之后。
- `parseObject` 解包 `{data: {...}}` 单键包装（覆盖 `repo view` 同类根因），其余形态照旧。
- `normalizeRepo` 别名：`path_with_namespace` / `full_name` / `name_with_owner` → `nameWithOwner`；`repo` 保留**完整路径**（三段不折叠），`owner` = 去掉最后一段的完整前缀，`name` = 最后一段。
- 请求侧 `GH_REPO_LIST_FIELDS` / `GH_REPO_FIELDS` 不动：实机观测证明 CLI 未因未知字段报错（否则会走 `COMMAND_FAILED`，而不是"恒空"）；若后续实测字段被过滤，只改这一处表。

### 3.4 不变量（本次不得放松）

- 写动作门禁、`confirm` 通道、幂等键 `sha256(变更号|对象类型|归一化标题)` 前 16 位与 `reused` 语义（`actions.mjs:100-107`）不动。
- 适配器仍是唯一 `execFile` 出口；新增模块零 `spawn`/`exec`/`shell:true`。
- 读信封五项、固定 reason 枚举、`unknown` 不重试不重放；多候选仍 `blocked`、不猜仓库。

## 4. 行为兼容性影响（用户可见）

| # | 场景 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | `org/group/repo` 三段引用 | `denied` / `MISSING_TARGET` | 进入后续核对，可执行；两段行为不变 |
| 2 | 企业原生 dop 记录 | 整卡失败（缺契约字段） | 变更内容、故事与排期可读，`sourceRevision` 照旧派生 |
| 3 | 平台未给验收条件的记录 | 抛错，连只读展示一起失败 | 卡片明示「平台未提供」+ 进 `missingFields`，不伪造 |
| 4 | `gh repo list` 原生包封 | 可见仓库恒空（`NO_VISIBLE_REPOS`） | 如实列出；候选判定与写门禁逻辑不变（多候选仍 `blocked`） |

无新增页面、配置项或工具；配置页仍只问三项。

## 5. 回归与验证计划

### 5.1 命令与期望

| 命令 | 期望 |
|---|---|
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | 428 基线（本次实测 432 用例、0 失败、0 跳过）只增不减、零 skip |
| `node --test "packages/forge-devops/test/*.test.mjs"`（仓库根） | 同上，验证根执行路径同一结果 |
| `cd packages/forge-devops && node --test test/context.test.mjs test/gh-adapter.test.mjs test/repository.test.mjs test/actions.test.mjs test/tools.test.mjs test/flow.test.mjs` | 定向：三个缺陷的用例全绿 |
| `pnpm check` | docs / 仓库 / tarball / 版本 / 全部单测全绿 |
| `git diff --check` | 无输出 |

### 5.2 离线可复现证据（每缺陷一组正/反例 + 一条"真实环境字段/封装"夹具）

- 夹具 1 `test/fixtures/dop-change-native.json`：按报告描述的**原生字段形状**构造（`code`/`state`/`summary`/`userStory`），非企业环境导出——使用处必须标来源类型 `mock`。
- 夹具 2 `test/fixtures/gh-repo-list-gitee.json`：`{"data":{"list":[{"path_with_namespace":"acme/group/demo",…}]}}`，同样标注为"报告描述形状"而非企业实测。
- 缺陷 1 用例（`context.test.mjs`）：原生夹具归一后 `changeId`/`title`/`description`/`userStories`/`releaseInfo` 可读；缺验收条件 → `missingFields` 且渲染含「平台未提供」；原生命名下 `code` 缺失仍 `RECORD_INVALID`。
- 缺陷 2 用例（`gh-adapter`/`actions`/`tools`/`flow`/`repository` 五处）：`acme/group/demo` 被接受且命令面一字不改；`acme/demo/x/y`、`acme`、`-bad/x`、`acme /demo` 仍拒且零调用；`flow` 的承建仓库核对在三段下仍生效；`explicit` 裸名在跨组同名时 `blocked`。
- 缺陷 3 用例（`gh-adapter.test.mjs`）：原生包封 → `count` 与 `repo` 正确、`source_revision` 无 `updatedAt` 时为 `null`；`data.list: []` → 空清单不回落单元素；`data.list` 非数组 → `MALFORMED_RESULT`。

### 5.3 需改写的既有用例（改写不删）

- `test/context.test.mjs:174`：`description: undefined` 的期望从"抛错"改为"进 `missingFields`"，其余断言（`null`、`title` 非字符串、`acceptance_criteria` 类型错）保留。
- `test/gh-adapter.test.mjs:279`：把 `acme/demo/extra` 从拒收名单移出并单列正向断言，拒收位由四段 `acme/demo/x/y` 顶上。
- `test/actions.test.mjs:170`：`owner/name` 措辞扩为 `owner/name` 或 `org/group/repo`，断言逻辑不变。

### 5.4 本轮 NOT RUN

Windows / 麒麟 aarch64 实机、真实企业 dop 与 Gitee `gh` 的字段与包封实测、真实写动作在 Gitee 上的幂等复用一次取证（仍需人工确认一次）——均为 `NOT RUN`，不得据本单写成企业已验。

## 6. 风险与回滚

| 风险 | 应对 |
|---|---|
| 原生别名猜错语义（`summary` 是标题还是正文） | 别名表是单点、改一行即生效；卡上与文档同源，不散落多处判断 |
| 三段放宽被当作越权入口 | 段数上限 3 + 段内字符白名单 + 零子进程前置拦截；`--`、空格、NUL 仍拒 |
| 裸名兜底串仓 | 兜底仅在候选内唯一时生效，否则 `MULTIPLE_CANDIDATES` 阻断 |
| 解包把脏对象读成一条仓库 | `data.list` 非数组即 `MALFORMED_RESULT`；空数组保持空清单 |
| 字段降级掩盖契约漂移 | 「平台没给」与「我们没读」分开记：`missingFields` + 卡上明示 + 未知项不重放 |

回滚：单次提交 revert 即回到现值；本单无数据迁移、无配置迁移、无依赖变更，幂等靠平台回查（无本地台账），回滚无残留。

## 7. 假设与待澄清

| # | 事项 | 当前取值 | 若改判则变什么 |
|---|---|---|---|
| 1 | 原生故事项内层命名（排期/编号字段名） | 报告只点名顶层四个键；故事内层仍只读契约名，取不到即进 `missingFields` | 补别名表一行，用例加一条 |
| 2 | `summary` 是标题还是变更内容 | 同一串同时喂 `title` 与 `description` | 若企业另有标题字段，别名表加一条并调整卡上展示 |
| 3 | 验收条件的承载位置 | 只从顶层取；缺失即降级 | 若原生放在故事项内，需加抽取规则（先实测再定，不预埋猜测） |
| 4 | 是否新建 `src/repo-ref.mjs`（模块边界） | 推荐新建：五份正则已漂移 | 若要求不加文件，改为 `gh-adapter` 导出、其余 import，会形成 adapter↔actions 反向依赖，不推荐 |
| 5 | `forge-gitee` 是否同步 | 本次不动（其 `gitee-adapter.mjs:238`/`gitee-actions.mjs:95` 同样只认两段，`gitee-adapter.mjs:544-545` 不解 `data.list`） | 一并修则回归面扩大到该包全部用例与 `--json` 字段面，建议另开一单保证据链 |
| 6 | `ghOwner` 扫描范围是否需 `org/group` 斜杠形式 | 保持单段 token（`gh-adapter.mjs:366`） | 若三段仓库的扫描范围必须带斜杠，放宽该正则为 1..2 段，argv 位置参数形状不变 |
