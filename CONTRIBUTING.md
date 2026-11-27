# 贡献指南

本指南负责环境准备、变更流程和评审提交。项目现状与目录见 [README](README.md)，agent 执行规则见 [AGENTS.md](AGENTS.md)，文档治理见[文档总览](docs/README.md#6-编写约定)，工程细则见[开发约定](docs/engineering/development-conventions.md)。

本仓库用于企业方案与扩展工程，公开可见不代表授予开源许可；根工程与现有市场包均为 `private: true`。参与贡献不代表获得推送、发布或对外分发授权。本仓库不接受来自 fork 的 PR：审查、重签与强制重放都在仓库内分支上完成，分支保护与提交钩子也只约束这些分支；贡献者需具备本仓库 write 权限，在仓库内建立分支后提交（见[变更流程](#3-变更流程)）。

## 1. 环境

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | 见 [.node-version](.node-version) | 用现有版本管理工具切换，并核对 `node --version` |
| pnpm | 见 [package.json](package.json) 的 `packageManager` | 核对 `pnpm --version`，同时满足 `engines` |
| 依赖 | 使用固定锁文件管理工作区依赖 | 技能管理器的构建与类型检查使用开发依赖，运行制品自包含；市场客户端的 React 由 DSH 提供 |

先按固定工具链执行 `pnpm install --frozen-lockfile --ignore-scripts`，再运行 `pnpm check`。先核对版本，环境不符时记录验证限制，不修改项目约束来消除告警。

新克隆的仓库默认没有敏感扫描钩子，而 PR 会校验提交签名，所以准备环境时要先安装。完整包从授权保管人处按受控渠道取得，再按[团队完整分发包安装说明](<scripts/sensitive-scan/TEAM-FULL-INSTALL.md>)安装团队完整分发：安装器先校验包内 Ed25519 私钥与团队公钥匹配、正式规则有效，再把脚本、私钥与规则放进 Git common dir，并在 Git 选定的路径安装 `commit-msg` 钩子。解压目录按密钥材料级别保管，不要自行生成个人密钥，也不要改用 legacy 的 `sensitive:scan` / `sensitive:install`（规则格式与路径不同，不能满足远端 v2 验签）。独立 clone 各需安装，默认共享 hook 配置下 linked worktree 共用同一套安装。安装后的自检、权限要求与生效限制见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。

## 2. 选择变更入口

| 任务 | 先确认 |
|---|---|
| 插件或独立服务 | 查[设计索引](docs/design/README.md)与对应模块 README，确认设计准入 |
| 工程脚本、测试或 CI | 查[开发约定](docs/engineering/development-conventions.md)，定位实际检查规则和用例 |
| 部署与运行手册 | 查[部署说明](deploy/README.md)及[运维索引](docs/operations/README.md)，确认授权与实测条件 |

## 3. 变更流程

1. 用 `git status --short` 和目标差异确认工作区；保留已有改动，发现同一处并行编辑时先协调。
2. 确认范围及内容归属。新模块先设计，契约字段先改对应契约；重大未决选择保留待确认，不代替团队批准。
3. 需要创建分支时从适当基线建立短分支，常规命名见[开发约定](docs/engineering/development-conventions.md)；agent 宿主明确规定前缀时遵循宿主要求，不擅自切换已有工作分支。
4. 修改事实所属的文件；移动文件使用 `git mv`，同一变更更新全部受影响的引用。
5. 运行 `pnpm check` 与 `git diff --check`，审阅最终 diff；前者已包含自动发现的历史市场包契约、索引校验与归档安装用例。推送前再运行 `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`，结果必须全部 verified；不跑就推，PR 上的 `sensitive-attestation-verify` 会直接变红，即使代码本身没有问题。签名绑定钩子扫描时的基线 tree。安装完整包后，`post-rewrite` 钩子会在 amend、rebase 后自动重扫重签，无需手工逐条重签；`reset` 和 `cherry-pick` 不触发重签，需人工确认。不要在其他会话改写这条分支的父提交：父提交被换掉且未经重签时会出现 `parent-tree does not match`，步骤见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。更新 PR 分支只用本地 `git fetch origin` 与 `git rebase --force-rebase origin/main`（分支已基于基线时普通 rebase 是空操作，不会重签）：网页的 Update branch 和 Update with rebase 都在服务端重写提交，本地钩子无法重签，前者留下无法签名的合并提交、后者让父树绑定失效，两种做法都会让该检查变红；rebase 后仍需重跑 `pnpm check`，重签不解决内容冲突，操作序列见[更新 PR 分支](<scripts/sensitive-scan/README.md#updating-a-pull-request-branch>)。变更需要企业接口或实机证据时另行验证，已有完整有效测试不重复运行。失败须修复或明确阻塞，不能以跳过宣称通过。
6. 在相应授权范围内提交或发起 PR，一次提交只做一件事。按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)填写关联依据、验证结果、未验项与风险；正文单独一行填写 `Closes #编号`（完整解决）或 `Part of #编号`（部分解决），关联至少一个本仓库已有 Issue。关闭关键字仅在 PR 目标为默认分支且仓库启用自动关闭时生效；部分解决请说明本次范围。CI 会核验 Issue 存在，正文修改后重新检查；Dependabot PR 同样需要维护者补填关联；`@dependabot recreate` 会覆盖正文修改，须重新补填；本地编辑完成不自动触发推送、合并或发布。

本仓库不接受来自其他仓库的 PR，受理面是仓库内分支。`verify (ubuntu-x64)` 在检出 PR 代码前即拒绝 head 仓库不是本仓库的 PR 并说明改法（该判定在 PR 工作流内执行，边界见[检查工作流说明](#71-github-actions)）。理由不是签名缺失（协作者装好团队密钥后可以在 fork 里签出合规提交），而是审查与修复流程依赖仓库内分支：rebase、强制重放和 `post-rewrite` 重签都发生在受分支保护与提交钩子约束的分支上，也需要维护者对同一分支做 `force-with-lease` 更新；fork 分支在作者控制下，不在这套流程内。外部贡献者先取得本仓库 write 权限，再在仓库内建立短分支提交；维护者不在 fork 分支上代为重放，也不外发团队私钥或跳过验签。

Dependabot 默认生成的提交即使关联了 Issue，也不能通过独立的 `sensitive-attestation-verify`。维护者应在本地基线上重新生成并签署该更新（保留原作者与原 PR 的追溯信息）后推送同仓分支；签名和重放约定见[敏感扫描说明](scripts/sensitive-scan/README.md#verification-and-rotation)。

推送与发布分开：合并到 `main` 不自动发布任何包。

## 4. 提交信息

- 类型：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 摘要写“改了什么”，正文写“为什么”，不写“按用户要求”。
- 不把格式化、重命名与行为变更混在同一提交。
- 消息不要以 `#` 开头：钩子用 `git stripspace --strip-comments` 规整消息，整段以 `#` 起头的正文会被静默删除；引用 issue 写成 `issue #125` 这种内联形式。

## 5. 文档规则

文档类型、元数据、状态、升版与历史保留统一按[文档治理规则](docs/README.md#6-编写约定)执行。正文是元数据来源，[文档清单](docs/DOCUMENT-REGISTER.md)只保留导航与无正文的编号记录；普通新增或升版不更新公共清单。

修改范围或决策时沿关联关系同步下游设计、契约、计划和验收；入口保留摘要与链接。文档检查验证结构及一致性，语义正确性仍需评审。

## 6. 新增模块

1. 在[设计索引](docs/design/README.md)登记模块、形态与状态。
2. 用[模块设计模板](docs/templates/design-template.md)编写详细设计，核验目标 DSH 接口。
3. 设计通过后创建 `package.json`，声明 `engines.dsh`、`private` 与 `test` 脚本。`services/market-index` 只保留只读校验器，不建服务或独立清单；市场目标见轻量设计与 issue #12。
4. 完成实现与包内实际测试；兼容、契约或实机验证按设计准入要求取证。
5. 达到可用判据后再更新对应 README 状态，写清能力边界与未验项；发布还须单独满足发布门禁。

未建立清单前不要提前写 `src/`，避免出现无法运行的空壳。

## 7. 检查命令

本地常用检查命令与验证范围如下表所示，可执行定义以 [package.json](package.json) 为准。包级、契约、集成与端到端测试按[测试分层约定](docs/engineering/development-conventions.md)分别执行。

| 命令 | 验证范围 |
|---|---|
| `pnpm check` | 依次执行文档检查、仓库检查与 Node 自动发现的全部测试 |
| `pnpm check:docs` | 文档元数据、编号唯一性、保留记录、本地链接与锚点、表格及询问问题序列 |
| `pnpm docs:catalog` | 只读输出按编号排序的文档清单，不写仓库文件 |
| `pnpm check:skills-manager` | 比对技能管理器生成物与源码并执行类型检查；首次运行前按固定工具链安装开发依赖 |
| `pnpm check:repo` | 工程结构、根目录入口面、工作区、模块状态、工作流权限、敏感信息与包体闭包（清单/入口/依赖/补丁层/locale） |
| `pnpm check:tarballs` | 每个包的 `npm pack --dry-run` 实际内容与模式位对照声明（#37 AC4） |
| `pnpm check:version` | 正文基线版本与 [.dsh-version](.dsh-version) 一致，代码中无硬编码 DSH 版本 |
| `pnpm test:unit` | 实际执行 `node --test --test-timeout=120000` 自动发现的全部用例：检查器、各扩展包、凭据支撑包、索引校验与归档安装；单个用例超过 120 秒即具名失败 |
| `node --test packages/forge-iam/test/*.test.mjs packages/forge-credentials-keychain/test/*.test.mjs` | 单独验证 IAM 与凭据存储包 |
| `node --test packages/forge-market/test/*.test.mjs` | 单独验证市场插件的逻辑、契约及本地安装链路 |
| `node --test services/market-index/test/*.test.mjs` | 单独验证索引校验器 |
| `node scripts/sensitive-scan/verify.mjs --base <rev> --head <rev>` | 用基线团队公钥验证敏感扫描 attestation；Git 仓库内容仍正常推送，私钥、真实规则和扫描结果不上远端 |

`pnpm check` 还包含 `node scripts/dsh-version.mjs check`（单独入口为 `pnpm check:version`）：它要求正文声明的 DSH 版本位置与 [.dsh-version](.dsh-version) 一致，并禁止代码与脚本硬编码版本；改动文档里的 DSH 版本表述或包清单的 `engines.dsh` 后，`pnpm check` 会因这一项失败，需要按[版本规则](docs/README.md#6-编写约定)同步。

检查器本身也要改：新增规则时补充失败样例，避免“看起来通过”。

### 7.1 GitHub Actions

[检查工作流 `repository checks`](.github/workflows/check.yml)在 `main` 推送、PR、合并队列的 `checks_requested` 和手动运行时触发，不在工作流入口使用路径过滤。分类按检出的 PR 合并提交相对 base 顶点的差异判定：只改动[开发约定列明的隔离路径](docs/engineering/development-conventions.md#6-检查与-ci)时跳过必需平台作业；文档链接、登记、仓库规则和全部离线测试由两个 Ubuntu 分片覆盖并汇总到 `verify`。新增路径须为普通文件且不与其他路径在大小写或 Unicode 归一化下折叠重名。混合或未知路径、非便携路径、折叠重名、文件类型和模式异常，或检出身份与差异无法确证时全跑。`main` 推送、合并队列和手动运行执行全部基线检查。

- 两个 Ubuntu 24.04 测试分片与变更分类并行。分类或任一分片失败，`verify (ubuntu-x64)` 失败。Windows x64 使用 Windows Server 2025 并行执行凭据和 IAM 测试，共同决定其必需检查结果。Windows ARM64 在 `main` 推送和手动触发时验证。同一 PR 的新运行取消过期运行。
- Ubuntu 测试分片在检出前拒绝 head 仓库不是本仓库的 fork PR，并将失败汇总到 `verify`。判定只作用于 `pull_request`。工作流定义来自 PR 合并提交，可信基线门禁由 `sensitive-attestation` 和 CODEOWNERS 评审提供。
- [`macOS compatibility checks`](.github/workflows/check-macos.yml) 验证 Apple Silicon。PR 复用仓库检查的完整 Git 差异分类，便携的纯文档、技能及部署资料变更可跳过。基线推送、合并队列和手动运行时独立执行。执行超时为 2 分钟，结果作为可选检查记录。
- Node 版本来自 `.node-version`。本地 `pnpm check` 执行 `check:static` 与 `test:unit`，CI 使用相同入口。分片 2 执行静态检查，两个分片覆盖 Node 自动发现的全部测试，单个测试超时为 120 秒。
- Ubuntu 测试分片使用根 `packageManager` 固定的 pnpm 执行 `install --frozen-lockfile --ignore-scripts`。Linux 和 macOS 作业构建并离线安装企业组合包，Windows 作业打包并离线安装凭据独立包。平台作业在临时存储中使用合成数据。检查的显示名称及分支保护约定见[开发约定](docs/engineering/development-conventions.md#6-检查与-ci)。
- 托管 runner 的结果不代替 Windows 10、UOS、银河麒麟、目标 DSH/Electron 宿主、Windows ACL 或企业 IAM 的目标环境取证。8.3 真实短名用例在卷不提供不同的短别名时跳过；需以实际运行记录区分通过与跳过。
- `repository checks` 只授予 `contents: read`，检出不保留凭据；分类作业检出完整历史以比较 PR 的基线与 head，其余作业检出深度为 1。外部 GitHub Action 固定完整提交 SHA 并附版本注释。通过 `docker://` 直接引用的镜像固定完整 `sha256` digest。[Dependabot](.github/dependabot.yml)每周一北京时间 09:00 检查 Actions 更新，合并次版本与补丁更新为一组，主版本单独评审；不自动合并或发布。
- 合并队列的 `verify` 在 `merge_group` 上执行代码检查，不重新读取各 PR 正文；关联检查依赖入队前的 PR 必需检查。入队后修改正文可能导致检查结果与队列快照不同，合并前须确认最新正文及检查结果。独立的 `sensitive-attestation-verify` 尚未支持 `merge_group`：若分支保护仍要求该检查，队列会等待缺失的检查。启用队列前须补齐并验证可信验签路径，不能仅依靠 `verify` 的队列触发器。
- PR 另由 [sensitive-attestation](.github/workflows/sensitive-attestation.yml) 以 `pull_request_target` 从基线运行 Issue 校验与团队公钥验签，不 checkout 也不执行 PR 代码；使用 `contents: read`、`issues: read` 和 `pull-requests: read`。正文编辑后重新读取最新正文，缺失 Issue、引用 PR 或 API 不可用时失败。工作流从目标基线加载，新规则合入目标分支后才成为可信门禁。它的 required 配置与部署状态不在本文件断言，实测与上线步骤见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。
- [PR 审查标签同步](.github/workflows/pr-review-labels.yml)在 `main` 每 10 分钟调度一次，也可在 Actions 中从 `main` 手动运行；GitHub 的调度可能延迟。它读取开放 PR 的原生 `reviewDecision`：`CHANGES_REQUESTED` 对应 `review: changes requested`，`APPROVED` 对应 `review: approved`，`REVIEW_REQUIRED` 或空结论对应 `review: awaiting review`；草稿移除受管审查标签。同步只维护四个审查标签，不修改其他标签；`review: awaiting re-review` 无法从聚合结论推断。标签仅用于展示，以 GitHub 原生审查和分支保护为准。工作流使用默认分支代码和 `pull-requests: write`，不执行 PR 代码；失败时查看 Actions 日志并手动重跑。
- 本地修改不代表远端必需检查、合并队列或 Dependabot 已启用，也不代表远端 CI 已通过。

依据核验日期为 2026-10-21：[GitHub 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)、[事件与合并队列](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)、[并发控制](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)、[Dependabot 配置](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)，以及 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) 的发布说明与输入声明。官方 Actions 使用 Node 24 runtime；应用检查仍使用 `.node-version` 固定的版本。工作流依赖锁文件当前属于[公开预览](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)。

条件作业和必需检查的依据核验日期为 2026-11-10：[GitHub 必需检查排障](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)与 [YAML 锚点和别名](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#yaml-anchors-and-aliases)。

## 8. 安全

不提交令牌、私钥、证书、真实用户数据或生产配置。发现疑似泄露时停止提交，按[安全策略](SECURITY.md)处理，不在 issue 或聊天中扩散。

## 9. 评审

- 评审关注：设计一致性、失败模式、权限边界、测试是否覆盖负向路径。
- 文档变更同时检查编号与链接，不把“格式正确”当作内容正确。
- 未经确认的接口、性能和恢复能力标注为未验，不写成既定事实。

### 9.1 OCR PR 自动评审

[OCR 工作流](.github/workflows/ocr-pr-review.yml)在同仓 PR 打开、推送新提交或重新打开时，使用 `ocr review` 评审该 PR 的差异。评审辅助脚本取自事件的目标基线，合入目标分支后可用。模型端点接收差异和评审所需的代码上下文。Actions 摘要显示预览范围，运行制品 `ocr-report-pr-<编号>-<尝试次数>` 包含脱敏后的完整 `result.json`，同一 PR 的机器人评论原位更新。评论回写作业单独持有 `pull-requests: write` 权限。

在仓库 Settings → Secrets and variables → Actions → Secrets 中配置 `OCR_LLM_URL`（模型 API 地址）、`OCR_LLM_TOKEN`（API Key）和 `OCR_LLM_MODEL`（模型名）。任何一项缺失时，作业在检出前结束。使用 Anthropic 兼容端点时，将可选 Secret `OCR_LLM_USE_ANTHROPIC` 设为 `true`。[GitHub Actions Secrets 配置说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

| Actions Variable | 默认值 | 作用 |
| --- | --- | --- |
| `OCR_ENABLED` | `true` | 设为 `false` 跳过同仓 PR 的 OCR 评审 |
| `OCR_CONCURRENCY` | `4` | 评审并发数 |
| `OCR_NO_PLAN` | `1` | `1` 使用低努力档位 |
| `OCR_MAX_TOKENS_BUDGET` | `2000000` | 评审 token 预算 |
| `OCR_EXCLUDES` | `__DEFAULT__` | 自定义逗号分隔的排除 glob，`__NONE__` 关闭工作流附加的排除集 |
| `OCR_OUTPUT_LANGUAGE` | `中文` | 模型输出语言 |
| `OCR_RUN_PREVIEW` | `1` | `1` 在正式评审前生成免模型调用的预览 |

OCR 和洛神由 `OCR_ENABLED`、`PR_AGENT_ENABLED` 分别控制。同时开启时，同一 PR 可收到两份评审。

### 9.2 洛神 PR 自动评审

[洛神工作流](.github/workflows/pr-agent.yml)通过 OpenAI Chat Completions 调用 `gpt-6.2-sol`。启用前在仓库 Actions Secrets 配置有该模型及 Chat Completions 调用权限的 OpenAI 项目密钥 `OPENAI_API_KEY`，再设置仓库变量 `PR_AGENT_ENABLED=true`。[OpenAI API 模型与价格](https://developers.openai.com/api/docs/models/gpt-6.2-sol)

同仓非草稿 PR 的有效事件启动只读信号，默认分支上的发布工作流刷新持久摘要和审查评论。工作流从 GitHub API 核对 PR 版本，只检出默认分支发布代码。审查使用 `medium`，每次请求的上下文预算为 64,000 token（含输出预留）、生成上限为 12,000 token，超长审查最多处理五个分块并显示覆盖缺口。手动摘要接受无参数的 `/describe` 或 `/describe_pr`。自动和手动摘要均使用 `low`，上下文预算为 32,000 token、生成上限为 6,000 token，最多两次模型调用。遇到可重试的提供方错误时，每次请求最多重试一次，超时直接失败。

[仓库审查配置](.pr_agent.toml)从默认分支加载，合并后对后续运行生效。审查给出按风险排序的可操作发现和人工审查优先文件，合入建议供维护者参考。评论折叠区展示实际返回的 token 数与调用次数，账单以 OpenAI 项目用量为准。以 2026-11-26 的标准价估算，累计消耗 20,000 个未缓存输入 token 和 2,000 个输出 token（含推理）约为 US$0.06。[OpenAI API 定价](https://developers.openai.com/api/docs/pricing)

维护者可在开放的 PR 直接留言 `/review`。洛神对自动审查和无参数命令发布 GitHub `COMMENT`，覆盖 P0 至 P3。工作流依据 GitHub 差异校验 `LEFT` 或 `RIGHT` 的完整范围，评论锚定在同侧变更行。位置无法定位或内联评论发布失败时，发现保留在审查摘要，已有批准仍按本次结论核对。文件或审查接口暂时不可用时，工作流显示发布失败。同版本重跑或再次发起 `/review` 可补发缺失的内联评论，已发布项按标记去重。已有批准需要撤销时，自动摘要的读取或核验故障不影响传递该版本明确的不合格结论。带参数的手动命令由固定版本 PR-Agent 处理。

自动批准适用于以 `main` 为目标的同仓非草稿 PR。自动审查或无参数 `/review` 明确给出无重要问题、无另列安全风险、仅有 P3 或无发现的结论后，洛神专用 GitHub App 提交 GitHub `APPROVE`。每个文件的变更行按原文和行号与实际模型请求对账，并用 GitHub 原始差异核验文件模式。批准仅使用同一次运行尝试生成的审查结论。覆盖证据缺失、分块、截断、达到发现上限、重命名、模式变化或对账不可用时不新增批准。覆盖验证故障时，普通审查仍可发布。同版本的正面审查若仅缺少覆盖证据，保留已有批准。明确的不合格结论交由批准作业撤销旧记录。仅重跑批准作业并复用旧撤销结论时，作业明确失败并提示 `Re-run all jobs`，由新审查重新核对。批准复用审查结果，无额外模型调用。[GitHub 审查接口](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) · [GitHub 重跑规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

`main` 的合入仍需要 `CODEOWNERS` 中的个人账号批准。洛神核验经典分支保护强制适用于管理员、批准数恰为 1、要求代码所有者批准、撤回过期批准且没有绕过名单或自定义审查撤销限制。经典保护和叠加在 `main` 的生效 ruleset 均不得要求由最后推送者以外的人批准。叠加规则不得增加必需批准数、指定额外审查者或限制撤销。自动批准要求目标版本的 `.github/CODEOWNERS` 只有一条生效的全路径 `*` 规则，该规则的所有个人账号都在可信人工名单，并持有仓库写权限。无法确认人审门禁时只发布普通审查。发布前后均核对经典保护、生效 ruleset 和代码所有者的实时写权限。`hrygo` 保留人工批准和请求修改权限。专用 App 使用独立身份，其批准仅供维护者参考，人工修改请求持续生效。合入门禁由 GitHub 按当时生效的规则持续执行。保护规则变更可能先于异步清理生效，实际计票由 GitHub 决定。[GitHub 分支保护规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging) · [生效分支规则接口](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)

GitHub 正式审查绑定 PR 头提交。洛神批准记录包含所核对的目标版本和发出批准的工作流运行尝试。`main` 推进或经典分支保护变更会触发清理。每小时也计划运行一次，由 GitHub 调度执行，覆盖仅变更 ruleset 的情况。清理作业核对开放 PR 的版本、人审门禁和有效修改请求，包括改投其他分支的 PR。作业每批并发检查至多四个 PR，每个 PR 有独立的 10 秒预算，个别失败后继续处理。如果 GitHub 接受批准后响应丢失，批准作业在同次尝试内重读审查历史。若仍无法完成复核，后续自动清理或新审查根据原尝试的步骤结果撤销未复核的批准。原尝试返回 HTTP 404 时按无法证明复核处理，只撤销对应 App 批准。HTTP 5xx 等暂时性读取故障等待后续核对。审查结论要求撤销已有批准时，审查作业先以 GitHub Actions 原生 `COMMENT` 保存绑定 PR 版本和工作流尝试的决定。专用 App 身份或安装范围暂时无法核验时，定时清理在恢复后读取该决定，撤销更早的同版本 App 批准。批准作业会有限重试首次 PR 读取和版本核对的短暂故障。审查结论要求撤销或批准后复核出错时，已查回的批准会记录待撤销标记。因读取故障无法在原批准记录待办时，专用 App 通过绑定当前 PR 版本的 `COMMENT` 保存撤销决定，后续清理据此撤销更早的同版本 App 批准。不合格结论按所审查的版本记录撤销决定。改投引起的旧批准由版本核对处理。写入待撤销标记或提交撤销前，重新核对版本、分支保护或修改请求等对应条件。仅切换草稿状态时保留同版本批准。撤销和清理复用审查结论。同版本通过新审查后，按 GitHub 时间线核对原撤销人，确认是专用 App 的补偿撤销才恢复批准。[工作流尝试作业](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt) · [审查记录顺序](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) · [分支保护事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#branch_protection_rule) · [GitHub 定时触发](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

拥有 `write`、`maintain` 或 `admin` 权限的维护者确认 P0/P1 后，可在非草稿 PR 单独留言 `/request-changes P1 <head SHA> <base SHA> <target branch>`，填写 PR 头提交、目标分支最新提交的完整 SHA 和目标分支名。洛神重新核对留言、发起人权限和版本，然后代发 GitHub `Request changes`。该命令无需模型调用。洛神已发布且仍有效的 GitHub 修改请求会阻止 App 批准，旧版发布记录也按此规则处理。

正式请求发布时带待确认标记，版本核对通过后移除。响应丢失时按发布标识查回请求；复查失败时由后续自动审查或无参数 `/review` 继续核对。发现版本变化时，仅撤销对应的待确认请求。GitHub 拒绝撤销时，洛神标记过期并由维护者解除。[PR-Agent 审查配置](https://github.com/The-PR-Agent/pr-agent/blob/v0.50.0/docs/docs/tools/review.md)

#### 自动批准配置与验收

1. 注册洛神专用的私有 GitHub App，关闭 webhook。仓库权限授予 `Pull requests: Read and write` 和 `Administration: Read-only`。安装时选择 `Only select repositories` 并仅添加本仓库。[注册 GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) · [安装 GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
2. 创建 `luoshen-approval` Actions 环境。在 `Selected branches and tags` 下只添加名称为 `main`、类型为 `Branch` 的规则。将 App 私钥存入该环境的 Secret `PR_AGENT_APPROVAL_APP_PRIVATE_KEY`。[环境保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags)
3. 在仓库 Actions Variables 中将 App 的 Client ID 写入 `PR_AGENT_APPROVAL_APP_CLIENT_ID`，将 slug 写入 `PR_AGENT_APPROVAL_EXPECTED_APP_SLUG`，省略 `[bot]` 后缀。`PR_AGENT_HUMAN_CODEOWNERS` 填写维护者确认用于人工审查的全部代码所有者登录名，各名称不带 `@`，以逗号分隔。工作流签发短期安装令牌，核对实际 App slug 后执行批准或清理，作业结束时撤销令牌。[GitHub App 安装认证](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
4. 核对 `main` 满足上述人审门禁。在隔离分支设置相同的人工审批要求，用 App 安装令牌为以该分支为目标的测试 PR 提交唯一一票正式批准。记录创建审查接口返回的 `node_id` 及该 PR 的目标分支、基准提交和头提交，确认 GitHub 的 `reviewDecision` 为 `REVIEW_REQUIRED`。

   - 暂时关闭隔离分支的代码所有者审批。查询该分支实际生效的经典保护和规则集（含继承规则），确认审批门禁只剩一票普通必需审批。经典保护的必需批准数为一，代码所有者与最后推送者相关审批要求均关闭，生效规则集无额外审批要求。[经典分支保护](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging) · [生效分支规则](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
   - 隔离分支规则变更生效后，使用下方查询保存同一份 GitHub 响应。测试 PR 须仍为开放的非草稿，目标分支及两个提交与记录一致，且 `reviews.pageInfo.hasNextPage` 为 `false`。
   - 在该响应中，必须恰有一条 `APPROVED` 审查。它的 `id` 匹配记录的 `node_id`，`author.__typename` 为 `Bot`，`author.login` 等于专用 App 的 slug，`commit.oid` 匹配 `headRefOid`。此时 `reviewDecision` 须为 `REVIEW_REQUIRED`，`mergeStateStatus` 须为 `BLOCKED`。
   - 保持 PR 版本和隔离规则一致，由另一名具备仓库写权限的真人协作者批准，再用同一查询取证。响应须保留原 App 批准，且只新增该协作者对同一头提交的 `APPROVED`，同时 `reviewDecision` 转为 `APPROVED`。遇到 App 批准撤回、版本或规则变化、响应不完整时，本轮作废并重测。[GitHub 必需审批](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
   - 测试结束后撤回测试批准并恢复隔离分支规则。两种计票结果均符合预期后设置 `PR_AGENT_AUTO_APPROVE=true`。

   将 `OWNER`、`REPO` 和 `123` 替换为测试仓库及 PR 编号。

   ```sh
   gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           state isDraft baseRefName baseRefOid headRefOid
           reviewDecision mergeStateStatus
           reviews(first: 100) {
             pageInfo { hasNextPage }
             nodes { id state author { login __typename } commit { oid } }
           }
         }
       }
     }' -f owner=OWNER -f repo=REPO -F pr=123 --jq '.data.repository.pullRequest'
   ```

5. 仅用于验收的同仓非草稿测试 PR 使用一条小型、无风险的改动，头提交说明带 `[skip ci]`，避免改投时额外触发自动审查。将 PR 改投 `main` 并留言 `/review`，检查 App 对当前头提交的审查为 `APPROVED`，且 GitHub 仍要求真人审批。将 PR 改回隔离分支，以隔离分支的保护规则事件触发清理，检查该条批准为 `DISMISSED`，然后关闭测试 PR。[GitHub 跳过工作流说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)

验收还需检查维护者有效的修改请求会阻止洛神批准。核验代码所有者写权限变化时，记录权限变更生效至清理完成期间的 GitHub 合入判定。本仓库 2026-11-27 实测覆盖 App 批准、仅有 App 批准时的隔离分支计票和改投后撤回。隔离计票以分次查询取得合入状态并复核唯一的 App 批准。单次查询下的完整计票验收与真人批准对照待实测。[验收记录](https://github.com/hrygo/heluo-forge/pull/514) · [规则变更计票](https://github.com/hrygo/heluo-forge/pull/510#discussion_r4716637543)

删除 `PR_AGENT_AUTO_APPROVE` 后，后续运行停止新增批准。保留 App 配置可让推送、经典分支保护变更和定时任务继续清理已有批准。
