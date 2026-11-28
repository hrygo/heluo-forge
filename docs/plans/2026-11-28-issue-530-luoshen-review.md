# 洛神 PR 增量评审与评论收敛实施方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-030 |
| 文档名称 | 洛神 PR 增量评审与评论收敛实施方案 |
| 版本 | V1.0.1 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-28 |
| 门禁 | Goldfish 意见已处置，正反向回归和 #484 固定镜像离线回放完成。GitHub 上新版默认分支运行待合入后验收 |

> 编制依据：[issue #530](https://github.com/hrygo/heluo-forge/issues/530)、[PR #484](https://github.com/hrygo/heluo-forge/pull/484) 与 `origin/main` 基线 `92971d77`。
>
> 关联文档：[贡献说明 §9.2](../../CONTRIBUTING.md#92-洛神-pr-自动评审)、[EGM 评审与处置](../engineering/reviews/2026-11-28-issue-530-egm.md)。

## 1. 目标与现状

[Issue #530](https://github.com/hrygo/heluo-forge/issues/530)要求首轮集中报告有证据的阻断问题，后续推送聚焦新改动和前轮问题的修复，已回复并解决的旧位置不重复开帖。当前工作流每轮将完整 PR 差异交给模型，最多返回 4 条发现，逐行按本次提交和文案哈希去重。

2026-11-28 只读核验 [PR #484](https://github.com/hrygo/heluo-forge/pull/484)。三条 P2 讨论 `4725011058`、`4725035838`、`4725149579` 分属 `472bc589`、`f29abe97`、`a71c3ab8`，均为 `tests/forge-experts-enterprise-e2e.test.mjs` 的 `RIGHT 519`，已有作者回复且标记已解决。`f29abe97...a71c3ab8` 的比较只变更 4 个文件，未涉及该路径。`a71c3ab8` 的 check runs 返回 18 项成功、2 项跳过。

## 2. 评审范围与发布语义

| 入口或状态 | 交给模型的差异 | 持续状态 |
|---|---|---|
| 首次、手动无参数 `/review`、找不到可信基线 | 当前 GitHub PR 完整差异 | 沿用持久摘要和全量覆盖证明 |
| 自动评审已有同目标分支和基线的已核验旧 head，旧 head 是当前 head 的祖先 | 旧 head 到当前 head 的文本差异及按状态读取的历史线程 | 复查未决 P0/P1，增量结果只作为普通评审 |
| 后续原生评审失败、改投、目标基线推进、历史缺失、比较不完整或无法核验 | 当前 GitHub PR 完整差异 | 以这轮成功且完整的结果建立新基线 |
| 参数化手动命令 | 固定版 PR-Agent 自身处理 | 沿用上游行为 |

自动评审使用固定 10 条上限。上限是输出预算。模型按 P0 至 P3 排序，证据充分的问题为零时输出空列表。P0/P1 在 GitHub 确认可定位且符合本轮范围时发布逐行 `COMMENT`。P2/P3 汇总进同一持久摘要的可折叠「可选改进建议」。无法定位的 P0/P1 和需要核实的风险保留在持久摘要中。增量旧侧行号指向前轮 head，摘要保留该坐标，GitHub 逐行位置使用当前 PR 差异右侧的真实变更行。

只使用洛神自建且可识别的代码行讨论作为自动去重依据。已解决、有 PR 作者回复、仍有当前坐标的同侧重叠位置，在本次最新 head 与根评论原 head 相同时省去新代码行讨论。左侧位置还须核对根评论标记中的目标提交。增量只发布落入本轮范围且能锚定到当前 PR 差异的右侧变更行。无法证实左右侧坐标和代码连续性的发现保留在摘要。现有同版本文案哈希继续保护发布失败后的补发。

未决 P0/P1 交给模型结合增量核实，持久摘要按捕获时的 GitHub 状态列出待复核的线程位置和链接。模型说明是否在本轮找到修复证据，GitHub 线程由维护者确认解决。提及跨包契约须依据可见实现或契约，无法证实的高影响风险使用 `needs_review`。有本次 head 的 check runs 时展示按状态聚合的快照。没有数据或 API 失败时表达核验范围。应用自动批准仍需要同次尝试完整的 PR 全量覆盖证据，P2 仍阻止自动批准。增量正面结论保留已有同版本批准，明确不合格结论继续进入既有撤销流程。需重新取得全量批准依据时使用无参数 `/review`。

## 3. 实施步骤

| 操作 | 路径 |
|---|---|
| 新增 | `scripts/pr-agent-review-context.mjs` |
| 修改 | `.github/workflows/pr-agent.yml`、`.pr_agent.toml`、`scripts/pr-agent-workflow.mjs`、`scripts/pr-agent-review-comments.mjs`、`scripts/pr-agent-coverage.mjs`、`scripts/pr-agent-coverage.py` |
| 修改测试 | `tests/pr-agent-review.test.mjs`、`tests/pr-agent-review-comments.test.mjs`、`tests/pr-agent-coverage.test.mjs`、`tests/pr-agent-coverage.test.py` |
| 更新说明和验收 | `CONTRIBUTING.md`、本方案与 EGM 处置记录 |

### 3.1 在正常入口固化回归

- [x] 扩展 [工作流测试](../../tests/pr-agent-review.test.mjs) 的 GitHub HTTP 替身，支持 SHA 比较、check runs、分页 GraphQL 线程和尝试作业基线。回放固定使用 `f1673d32...c2cffa56` 的 16 文件首轮及 `f29abe97...a71c3ab8` 的 4 文件增量形状，结合 §1 的真实讨论与 CI 快照。合成 7 个有锚点的 P1 及 P2/P3 建议，验证逐行仅发布 7 个 P1。增量验证旧 `RIGHT 519` 的改写无新增线程，仍可发布增量右侧合法发现，无新发现时 GitHub 逐行评论写入为零。另用同 head 全量重跑的合成 P1 直接验证换词抑制，使该用例独立于分级和增量范围过滤。
- [x] 以 [逐行测试](../../tests/pr-agent-review-comments.test.mjs) 为入口覆盖同路径、侧别、相邻独立位置、同一行真正发生修改、过期线程、缺作者回复、人工线程、增量 LEFT 与坐标冲突。按未修版实际失败保存原缺陷证据。
- [x] 扩展 [Python 观察器用例](../../tests/pr-agent-coverage.test.py) 和 [覆盖证明用例](../../tests/pr-agent-coverage.test.mjs)。断言模型实际收到的文件差异、当前未决与已解决线程数据、分级摘要和原始结果保持一致。全量证据拒绝带增量起点的证明。截断、缺失、过期范围及无法对账的输出不能推进增量基线。

### 3.2 采集并绑定可信上下文

- [x] 在 [工作流入口](../../scripts/pr-agent-workflow.mjs) 保留当前版本的成功短路。新增 `scripts/pr-agent-review-context.mjs` 的 `captureReviewContext(github, revision, { automatic })` 仅查看最新的洛神持久评审摘要。摘要末尾包含同 PR、`head/base/baseRef`、`runId/runAttempt/invocation` 绑定的执行标记。按此 `runId` 和 `runAttempt` 查询专用作业列表，只有评审作业和对应 `Confirm incremental baseline` 步骤成功，才能采用该 head。步骤名包含 head、目标 SHA、目标分支和 initial/retry。最新摘要缺标记、目标不符或其尝试未确认时回全量，避免跳过新一轮尚未处理的结论。历史摘要自然迁移。
- [x] 用 `<previousHead>...<head>` 比较的 `base_commit`、`merge_base_commit` 和 `ahead` 状态证实祖先关系。需要完整的文件清单、文本 hunk、变更行计数和原始 diff 模式对账。300 文件上限、空差异、整文件删除、重命名、二进制、模式变动、API 失败或范围不明回到全量。已核验的差异对象只在同一运行尝试中使用。
- [x] 通过现有 GitHub 客户端添加 GraphQL 读请求。读取同 PR、同 `headRefOid` 的 `reviewThreads`，包括 `isResolved`、`isOutdated`、当前坐标、洛神根评论标记、`originalCommit.oid` 和最近作者回复。根作者为 `Bot` 类型 `github-actions`，检查洛神 v1 标记。单行使用 `line/diffSide`，多行要求有效起点和同侧。最多 5 个线程页，每页 50 条，检查响应 `errors`、页游标和每页 head。每条读取根评论与最后 20 条回复。超出窗口且未找到作者时缺少去重依据。模型最多读取 20 条未决 P0/P1 和有限的已解决位置，超过未决上限或读取失败时选择全量并提示核验范围。发布前重读已捕获的线程，状态无法复核时不依赖其抑制评论或确认基线。
- [x] check runs 只读当前 head，使用 `filter=latest` 并核对返回项的 `head_sha`，聚合成功、跳过、未完成和其他结果。页面不全时以样本数和 `total_count` 标明核验范围。工作流增加 `checks: read`，信号和批准作业权限保持现有约束。
- [x] 在 [.github/workflows/pr-agent.yml](../../.github/workflows/pr-agent.yml) 按 run、attempt、initial/retry 分别传递上下文和覆盖证明文件路径，普通评审也采集覆盖证据。上下文用 `version`、`repository`、`prNumber`、`head`、`base`、`baseRef`、`mode`、可选 `previousHead` 和 `files` 绑定捕获版本。文件来自可信 checkout 的脚本。所有自动受信任输入仍从 GitHub 读取，信号工作流仅唤醒，PR 代码和制品不参与执行。需要重试时以显式状态条件保证第一轮模型或摘要步骤失败后仍可刷新版本。

### 3.3 将差异与历史送入固定版运行器

- [x] 更新 [.pr_agent.toml](../../.pr_agent.toml) 的预算和事实核验要求，将历史及 CI 快照标为评审数据。无新增 P0/P1 时按实际已审范围输出结论，明确区分尚待复核的旧问题。
- [x] 在 [Python 运行入口](../../scripts/pr-agent-coverage.py) 给自动和无参数 `/review` 安装一次性 `PRReviewer` 包装。构造后先核对 provider 版本，再在 `run()` 复制 `vars` 前将历史、范围、CI JSON 加入用户提示的 `description`。增量用 REST `filename/patch/additions/deletions/status` 构造 `FilePatchInfo`，`base_file/head_file` 为空、`head_file_is_complete=False`，将实例 `get_diff_files()` 指向这批 patch。保留 `incremental.is_incremental=False` 和固定版的单摘要路径。Python 以 `finally` 恢复类挂点和 provider 方法。固定镜像中检验实际传给模型的内容。
- [x] 在固定版 Markdown 渲染调用处用副本将 P2/P3 移至折叠块，保留核心发现、模型预算、覆盖警告与原始结构化输出。附带确定性的范围、CI、历史线程状态和同次尝试标记。严格持久发布要求已有评审摘要由洛神发出。更新前重读 PR 和目标 ref，读取或更新失败时禁止自动另开评审摘要。Node 以本次捕获的机器标记核对已发评审摘要，并在写入逐行评论、确认基线前重新核对当前版本。GitHub 的评论写入和分支版本校验分两次调用，竞争时拒绝确认旧结果，后续合格任务刷新显示。PR 描述摘要沿用独立 `/describe`，继续按本轮刷新条件核验。
- [x] 复用 Python 原有发送前观察器及 [Node 覆盖核验](../../scripts/pr-agent-coverage.mjs)。全量沿用 `version=1` 并拒绝带增量字段的证明。`version=2` 的 `mode=incremental` 与 `previousHead` 只与捕获的增量对账，永远不进入批准分支。需在同一次完整模型请求中观察当前差异和增量上下文；分块、达到 10 条上限、模式或路径不支持、部分输出继续可见，但不确认增量基线。

### 3.4 发布并确认下一轮的基线

- [x] 在 [逐行发布器](../../scripts/pr-agent-review-comments.mjs) 复用变更行解析，增加增量右侧变更行约束。位置抑制以已回复、已解决且仍处于当前坐标的同侧重叠范围为依据。优先核对可信增量中该范围是否改变。同版本根评论使用当前版本的位置。缺失、冲突或无法判定时保留可验证的当前发现。
- [x] 在工作流入口保留原始 `review` 作为撤销和批准依据。只有持久摘要验证成功、逐行发布确认、历史与差异完整匹配才确认增量基线。未形成代码行讨论的 P0/P1、未定位安全风险、`needs_review` 或线程快照失效时，这轮结论仍可见，下轮全量。任何全量标记之后出现未获确认的摘要时只评估后者。撤销门禁优先传递当前明确的不合格结论。
- [x] 更新 [贡献说明 §9.2](../../CONTRIBUTING.md#92-洛神-pr-自动评审) 的评审入口、分级、基线降级和批准语义。记录 Goldfish 处置及 #484 回放范围。

## 4. 验收与回退

| 场景 | 可核对结果 |
|---|---|
| 首轮大量核心问题 | 使用 #484 文件与评审历史形状回放，多于 4 条的合成 P0/P1 均可在同一轮发布，建议只在持久摘要 |
| 越轮换词、无变更 | 已回复已解决的 #484 `RIGHT 519` 无新代码行讨论，同位置出现实质改动时允许新发现 |
| 正常增量 | 模型只接收可信增量文本和已标记的历史资料，老问题保留当前状态，零新增阻断问题时无新代码行讨论 |
| 失败与竞争 | 目标变动、对象缺失、比较截断、引用错误、历史 403/分页不全、发布失败等进入既有安全路径，过期输出无法重新发布为当前版本 |
| 批准与撤销 | 全量同次证明门禁仍生效，增量正面结论无法创建批准，负面结论可撤销符合现行约束的旧批准 |

`node --test tests/pr-agent-review.test.mjs tests/pr-agent-review-comments.test.mjs tests/pr-agent-coverage.test.mjs` 复跑阶段回归。`python3 -B tests/pr-agent-coverage.test.py` 验证观察器和适配器。用工作流固定的 `linux/amd64` 镜像离线验证运行入口。交付使用 `pnpm check`、`git diff --check` 与 `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`。PR 使用同仓短分支并关联 issue #530。回放中 GitHub 数据取自公开 PR，模型输出使用离线合成响应。当前 PR 的洛神由默认分支运行，真实模型对新版规则的收敛和远端权限通过合入后的受控推送复核。

回退以 revert 本变更恢复上一版工作流。GitHub 已有评论和批准按其自身的状态规则继续核验。

## 5. 实施验证证据

| 验证 | 2026-11-28 结果 |
|---|---|
| 未修版本的针对性回归 | 同版本 P1 换词新增线程，首轮 9 条发现均发布为逐行评论，全量核验接受附有增量字段的证明。实施复查还复现摘要写入失败后沿用旧基线，以及同目标提交的 `LEFT` 换词重报 |
| Node.js 阶段回归 | 144 条通过。#484 首轮模型结果含 7 条 P1、1 条 P2、1 条 P3，单次发出 7 条逐行评论。增量可发新变更行，干净增量无逐行评论写入或自动批准。覆盖摘要写入失败、基线不明和左右侧坐标边界 |
| Python 观察器 | 12 条通过，覆盖发送前证据、分级渲染及上下文注入 |
| #484 固定镜像回放 | 两轮各 1 次离线合成响应、各 1 条持久评审摘要。实际模型输入按轮次为 16 个文件和 4 个文件，两轮覆盖证明校验通过。干净增量返回 `no_concerns_found`，校验拒绝发布已过期的版本 |
| 仓库全量离线检查 | 按无目标 DSH 的 CI 条件执行 `pnpm check`，5,823 条通过、7 条跳过，耗时约 74 秒。带本机 DSH 时两条实机宿主探针在变更前后同样失败，`origin/main` 的隔离副本复跑为 18/30 项通过、1 项阻塞 |

合入后的受控验证使用同仓测试 PR，观察首轮有依据的 P0/P1、作者回复并解决后只改其他行的一轮推送，以及没有新阻断项的增量。检查实际 Actions 令牌能读取线程和当前 SHA 的 check runs，并检查无新增重复逐行评论。工作流验签及本地运行统计以关联 PR 为准。
