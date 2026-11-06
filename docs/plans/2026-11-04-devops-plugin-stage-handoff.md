# DevOps 插件阶段总结与交接

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-015 |
| 文档名称 | DevOps 插件阶段总结与交接 |
| 版本 | V0.1.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-05 |
| 门禁 | 只读面已对真实 `dop` 平台跑通；写回只有一次同值 no-op；Gitee 侧仍未与企业 CLI 联调 |
| 文档层级 | L2 阶段总结与交接；供新会话接手，不构成验收证据 |

> 编制依据：2026-11-04 在本机 macOS 上，对真实企业 `dop` 平台（`dop` CLI v1.0.4）与已装插件（`@heluo/forge-devops`、`@heluo/forge-gitee` 均 0.1.0；宿主 DSH `0.2.1-rc.5`；profile `web`）做的一次端到端实测，以及合并提交 `edc1a4f` 上的 `pnpm check`（2571 通过 / 1 跳过 / 0 失败）。**文中标注 NOT RUN 的项目都没有执行过**；本文不重复设计稿，只记录现状、证据与缺口。
>
> 关联文档：[forge-devops 设计](../design/plugins/forge-devops.md)、[dop CLI 规格](../contracts/dop-cli-spec.md)、[gh CLI 规格](../contracts/gh-cli-spec.md)、[设计索引 §2.2](../design/README.md#22-实现与验证入口)、[需求基线 §2](../requirements/requirements-baseline.md#2-范围边界唯一真源)。

## 1 现状一句话

插件的**读面已经在真实企业平台上跑通**（列变更、读单条、出上下文卡、按机检落产物），**写回链路也已打通一次**（同值 no-op，回读一致）；**Gitee 侧十个工具从未与企业 CLI 联调**，本机只有 GitHub 的 `gh`，因此仓库/Issue/PR 相关能力全部 NOT RUN。距离「开发者报一个变更号，DSH 驱动研发」还差**验收条件缺失时的正向推进**与**Gitee 侧实机**两块。

## 2 已交付能力

| 能力 | 证据 | 边界 |
|---|---|---|
| 变更清单读 | `forge_devops_query`（`change.list`，`target` 只接受 `@me`）返回 12 条、`source_revision` 形如 `dop:<12 位>`、`truncated=false` | 只证明本账号可见范围；分页与状态过滤未用真实 flag 核验 |
| 单变更读 + 归一 | `change.read` 返回平台原始记录与归一投影，二者同时给出；`missingFields` 只列平台确实没给的字段 | 归一别名表只收录取证过的键，未取证的字段一律进 `missingFields`，不猜 |
| 上下文卡 | `forge_devops_change_context` 产出可直接落盘的 `context.md`；承建仓库段固定降级为 `REPO_FACTS_EXTERNAL`，只给指引不给猜测 | 仓库事实归 `@heluo/forge-gitee`，devops 不产出第二个答案 |
| 产物落盘 | `artifact_write` 五类产物（context / clarify / plan / review / report），六字段 front matter，路径逃逸拒绝 | 落在 `<repo>/.dsh-devops/<change>/`，该目录已被 `.gitignore` 忽略，不入库 |
| 机检门禁 | clarify 检 `kind` / `basis` / 每项选项的 `pros` 与 `cons` / 推荐项必须在选项内；plan 检验收条件映射、验证方式与固定阶段模板 | 失败**零落盘**，信封平级返回逐条 `problems` / `gaps`，`detail` 仍是字符串 |
| 写回 | `change update` 固定 argv，写后 `change view` 回读；`retry_policy: none`，未知不重放 | 默认不登记即拒绝；目标必须是本会话已读到的变更（先读后写） |
| Gitee 十工具 | 包内 216 例离线通过；宿主可见 10 个 `forge_gitee_*` | **企业 CLI 未联调**，见 §4.3 |

## 3 实机证据（全部 2026-11-04，真实平台）

| 环节 | 动作 | 结果 |
|---|---|---|
| 清单 | `change list` | `status=succeeded`、12 条、`source_revision` 与 `observed_at` 齐备 |
| 单条读 | `change view <变更 A>` | `succeeded`；修掉别名缺口前 `missingFields` 有 5 项，修完只剩 `acceptance_criteria` |
| 上下文卡 | `change_context <变更 A>` | `status=ready`；承建仓库段为 `unknown` + `REPO_FACTS_EXTERNAL` |
| 落盘 | `artifact_write(kind=context)` / `(kind=clarify)` | 分别写出 `context.md`（1153 B）与 `clarify.md`（1332 B），front matter 六字段齐全 |
| 门禁一 | 未读变更先落盘 | `MISSING_CHANGE_ID`，零落盘 |
| 门禁二 | clarify 带 `body` | `ARTIFACT_ARGUMENT_MISMATCH` |
| 门禁三 | plan 缺验收映射 | `ARTIFACT_PLAN_INVALID` + 逐条 `gaps` |
| 门禁四 | 故意不合格的 clarify | `ARTIFACT_CLARIFY_INVALID` + 四条 `problems`（`options-min`、`option-effect-missing`、`option-pros-empty`、`option-cons-empty`），每项带 `itemId` / `optionIndex` |
| 写回 | `change update <变更 A> --summary <同值>` | `status=done`；回读 `summary=match`，`description` / `aiAc` 为 `skipped`（未提交的字段不读回） |

> 变更编号、责任人、团队名与需求正文属真实企业数据，**不写入本仓库**；本节用「变更 A」指代，复现时用自己账号下任一带验收条件的变更。

## 4 未完成与未验

### 4.1 没做（能力缺口，非验证缺口）

- **验收条件缺失时的正向推进**：实测变更 A 没有 `acceptance_criteria`，按规则 plan 无法逐条绑定，因此计划链路被**规则性**阻断。是否需要「由人补 AC / 由 AI 起草 AC 并标注待确认」的入口，属产品取舍，尚未实现。
- **交付闭环**：变更号 → 计划 → 开发 → 交付判定（`forge_gitee_delivery_gate`）→ PR 的完整链路未串起来；目前只验证到「读 + 出卡 + 落产物 + 写回」。
- **Gitee 侧能力**：仓库、Issue、PR 的读写与交付判定全部只到离线测试，没有任何一次企业实机调用。

### 4.2 没验（做了，但没有实机证据）

- `change update` 的 `--ai-ac` 落点：设计里仍按「回读假设」处理，本次 no-op 未写该字段，**真实写入行为未知**。
- `change.list` 的状态过滤：传了也可能被 CLI 忽略，未用真实返回值核验。
- 产物的 `review` / `report` 两类：只有离线用例，没有真实调用过。
- macOS 以外平台：全部 NOT RUN。

### 4.3 环境缺失（阻塞验证，不是代码缺陷）

- **企业 Gitee CLI 不在本机**。本机 `/opt/homebrew/bin/gh` 是 GitHub CLI 2.97.0，`forge_gitee_repository_read` 实测返回 `status=failed`、`error_code=NONZERO_EXIT`，底层报错来自 GitHub CLI 的 `--json` 字段校验。拿到企业 CLI 之前，Gitee 十个工具的实机结论一律不得写成已验证。
- **子代理插件版本失配**：`@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2` 与宿主 `0.2.1-rc.5` 不兼容，重启后 profile 拒绝加载它（`Exact-version exemption: not active`）。与本次插件改动无关，但会影响依赖该插件的会话能力。

## 5 下一步（按优先级）

| 优先级 | 事项 | 完成判据 |
|---|---|---|
| P0 | 拿企业 Gitee CLI 做一次真实只读调用 | `forge_gitee_repository_read` 返回 `succeeded` 且 `source_revision` 非空；把 argv 与字段名与 [gh CLI 规格](../contracts/gh-cli-spec.md) 对齐 |
| P0 | 收紧写回审批台账 | 当前 profile 里 `change.clarification.write` 的审批条目是「资源 `*`、批准人 `任何人`、有效期到 9999 年」，等于常开；应改成具体人 + 短期有效期，并保留拒绝路径的负测 |
| P1 | 解决「变更无验收条件」的推进方式 | 二选一并写进设计：由人补 AC 后再推进，或允许 AI 起草 AC 且卡上标「待确认」；plan 机检仍须逐条绑定 |
| P1 | 验证 `--ai-ac` 落点 | 在一个**测试用**变更上写入 AC 后回读，确认落在哪个字段（`aiAc` 还是故事 AC），再改掉设计里的「回读假设」 |
| P2 | 串起交付闭环 | 变更号 → 计划 → 实现 → `forge_gitee_delivery_gate` 判定 → PR，跑通一次完整链路 |
| P2 | 补 `review` / `report` 实机 | 各写一次真实产物并确认机检与 front matter |

## 6 新会话接手清单

**先读**（按顺序，各取所需，不预读全库）：

1. 本文 §1—§4，确认哪些是已验证、哪些是 NOT RUN；
2. [forge-devops 设计](../design/plugins/forge-devops.md) 的工具表与门禁章节；
3. [dop CLI 规格](../contracts/dop-cli-spec.md) —— 命令面与字段名的唯一依据；
4. 需要动 Gitee 时再读 [gh CLI 规格](../contracts/gh-cli-spec.md)。

**先跑**：

```sh
git status -sb            # 确认工作区干净、本地与 origin 同步
dop auth status           # 确认凭据可用（不要打印 token）
dop change list --json | head -40   # 确认平台可达
pnpm check                # 基线：应全绿
```

**别做**：

- 不要把真实变更号、责任人、团队名、需求正文写进仓库文档或用例——实测一律用「变更 A」这样的占位，产物落在已被忽略的 `.dsh-devops/`。
- 不要在没有当次授权时推分支、开 PR 或调用平台写动作；`change update` 会真的改企业数据。
- 不要用 `git reset --hard` / `git checkout --` 清理工作区：同一工作区可能有其他会话的未提交改动，先核实来源。
- 不要 amend / rebase 已签名的提交；提交签名绑定消息、树与父提交树，改历史要按父链逐条重签。

**提交与推送**：本仓库 `main` 受保护，只能走分支 + PR；推送前必须 `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD` 全部 verified，否则 PR 的 `sensitive-attestation-verify` 会直接变红。

## 7 待用户决定

1. **审批台账通配**（见 §5 P0）：改成具体人 + 短期有效期，还是维持现状？
2. **无验收条件的变更**（见 §5 P1）：由人补，还是允许 AI 起草并标注待确认？
3. **子代理插件**：授予精确版本豁免（官方提示可能崩溃/丢数据），还是升级插件版本？
4. **阶段总结是否入库**：本文当前是草案，若只作会话交接用，也可改存到仓库外，避免长期占用文档编号。

## 8 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V0.1.0 | 2026-11-04 | 首版：汇总 DevOps 插件读写面实机进展、未验项与接手清单（代拟） |
