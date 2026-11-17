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

[检查工作流 `repository checks`](.github/workflows/check.yml)在 `main` 推送、PR、合并队列的 `checks_requested` 和手动运行时触发，不在工作流入口使用路径过滤。分类按检出的 PR 合并提交相对 base 顶点的差异判定：仅修改、删除或新增 `docs/` 下普通 Markdown 文件或根目录的 `README.md`、`CONTRIBUTING.md`、`SECURITY.md` 时跳过跨平台作业；文档链接、登记、仓库规则和全部离线测试仍由 `verify` 执行。新增路径须为普通文件且不与其他路径在大小写或 Unicode 归一化下折叠重名。混合或未知路径、非便携路径、折叠重名、文件类型和模式异常，或检出身份与差异无法确证时全跑；`main` 推送、合并队列和手动运行也全跑。

- `verify (ubuntu-x64)` 在 `ubuntu-24.04` 上运行完整离线检查，超时 5 分钟；分类作业失败或结果无效时，该必需检查失败。同一 PR 的新运行取消过期运行。平台作业在 GitHub 托管的 Linux、Windows 和 macOS runner 上执行 SQLite 凭据、IAM 合成测试与离线安装冒烟；`sensitive scan and IAM callback (win32-x64)` 是合并运行 Windows 敏感扫描和回调端口测试的非必需作业。
- `verify` 在检出前拒绝 head 仓库不是本仓库的 fork PR 并失败：仓库把审查、重签与强制重放收敛到仓库内分支，fork 分支不受分支保护和提交钩子约束，也不便由维护者强制更新；`main` 推送、合并队列与手动运行不带 PR head，不触发该判定。fork PR 因此不进入离线检查：已获批准的首次贡献者运行以该理由失败，未获批准的 fork 运行停在等待状态，两种情况都不能合并。该判定与分类同属 `pull_request` 工作流，工作流定义取自 PR 的合并提交，因此不构成防止恶意 PR 修改工作流的安全边界；不可绕过的是基线加载的 `sensitive-attestation` 与 CODEOWNERS 评审。
- [`macOS compatibility checks`](.github/workflows/check-macos.yml)独立运行，使用相同的触发与分类规则。ARM64 和 Intel x64 的执行超时分别为 2 分钟和 4 分钟。两项均为可选检查，排队取消或执行超时的结果由该工作流记录，不影响 `repository checks` 或 PR 合并。
- Node 版本来自 `.node-version`；`node --run check` 直接执行根 `package.json` 的 `check`，与 `pnpm check` 共用定义，`node --test --test-timeout=120000` 自动发现工程、包与集成测试，单个用例超时以用例名报告失败，不拖满作业超时。
- `verify` 使用根 `packageManager` 固定的 pnpm 执行 `install --frozen-lockfile --ignore-scripts`，取得技能管理器的构建与测试依赖；平台作业不配置 npm 包或 `node_modules` 缓存。Linux 和 macOS 作业构建并离线安装企业组合包，Windows 作业打包并离线安装凭据独立包；安装使用 runner 工作区内的独立前缀，冒烟测试在系统临时目录使用合成数据。六个平台检查使用 `SQLite and IAM` 名称，具体名称见[开发约定](docs/engineering/development-conventions.md#6-检查与-ci)；分支保护中的必需检查名称须与工作流显示名称一致，远端配置状态以实测为准。
- 托管 runner 的结果不代替 Windows 10、UOS、银河麒麟、目标 DSH/Electron 宿主、Windows ACL 或企业 IAM 的目标环境取证。8.3 真实短名用例在卷不提供不同的短别名时跳过；需以实际运行记录区分通过与跳过。
- `repository checks` 只授予 `contents: read`、用于核验 Issue 的 `issues: read` 和用于读取 PR 正文的 `pull-requests: read`，检出不保留凭据；分类作业检出完整历史以比较 PR 的基线与 head，其余作业检出深度为 1。外部 GitHub Action 固定完整提交 SHA 并附版本注释。通过 `docker://` 直接引用的镜像固定完整 `sha256` digest。[Dependabot](.github/dependabot.yml)每周一北京时间 09:00 检查 Actions 更新，合并次版本与补丁更新为一组，主版本单独评审；不自动合并或发布。
- 合并队列的 `verify` 在 `merge_group` 上执行代码检查，不重新读取各 PR 正文；关联检查依赖入队前的 PR 必需检查。入队后修改正文可能导致检查结果与队列快照不同，合并前须确认最新正文及检查结果。独立的 `sensitive-attestation-verify` 尚未支持 `merge_group`：若分支保护仍要求该检查，队列会等待缺失的检查。启用队列前须补齐并验证可信验签路径，不能仅依靠 `verify` 的队列触发器。
- PR 另由 [sensitive-attestation](.github/workflows/sensitive-attestation.yml) 以 `pull_request_target` 从基线运行 Issue 校验与团队公钥验签，不 checkout 也不执行 PR 代码；使用 `contents: read`、`issues: read` 和 `pull-requests: read`。正文编辑后重新读取最新正文，缺失 Issue、引用 PR 或 API 不可用时失败；普通 `repository checks` 中的相同校验只提供提前反馈。工作流从目标基线加载，新规则合入目标分支后才成为可信门禁。它的 required 配置与部署状态不在本文件断言，实测与上线步骤见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。
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
