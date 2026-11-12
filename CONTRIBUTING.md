# 贡献指南

本指南负责环境准备、变更流程和评审提交。项目现状与目录见 [README](README.md)，agent 执行规则见 [AGENTS.md](AGENTS.md)，文档治理见[文档总览](docs/README.md#6-编写约定)，工程细则见[开发约定](docs/engineering/development-conventions.md)。

本仓库用于企业方案与扩展工程，公开可见不代表授予开源许可；根工程与现有市场包均为 `private: true`。参与贡献不代表获得推送、发布或对外分发授权。

## 1. 环境

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | 见 [.node-version](.node-version) | 用现有版本管理工具切换，并核对 `node --version` |
| pnpm | 见 [package.json](package.json) 的 `packageManager` | 核对 `pnpm --version`，同时满足 `engines` |
| 依赖 | 离线检查与宿主/服务代码使用 Node 标准库 | 市场客户端的 React 由 DSH 提供，不作为独立 Web 应用运行 |

当前可直接执行 `pnpm check`，无需安装依赖；需要安装工作区依赖时使用 `pnpm install --frozen-lockfile`。先核对版本，环境不符时记录验证限制，不修改项目约束来消除告警。

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
4. 修改文件并同步受影响的登记与引用；移动文件使用 `git mv`，同一变更更新全部引用。
5. 运行 `pnpm check` 与 `git diff --check`，审阅最终 diff；前者已包含自动发现的历史市场包契约、索引校验与归档安装用例。推送前再运行 `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`，结果必须全部 verified；不跑就推，PR 上的 `sensitive-attestation-verify` 会直接变红，即使代码本身没有问题。签名绑定钩子扫描时的基线 tree。安装完整包后，`post-rewrite` 钩子会在 amend、rebase 后自动重扫重签，无需手工逐条重签；`reset` 和 `cherry-pick` 不触发重签，需人工确认。不要在其他会话改写这条分支的父提交：父提交被换掉且未经重签时会出现 `parent-tree does not match`，步骤见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。变更需要企业接口或实机证据时另行验证，已有完整有效测试不重复运行。失败须修复或明确阻塞，不能以跳过宣称通过。
6. 在相应授权范围内提交或发起 PR，一次提交只做一件事。按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)填写关联依据、验证结果、未验项与风险；正文单独一行填写 `Closes #编号`（完整解决）或 `Part of #编号`（部分解决），关联至少一个本仓库已有 Issue。关闭关键字仅在 PR 目标为默认分支且仓库启用自动关闭时生效；部分解决请说明本次范围。CI 会核验 Issue 存在，正文修改后重新检查；Dependabot PR 同样需要维护者补填关联；`@dependabot recreate` 会覆盖正文修改，须重新补填；本地编辑完成不自动触发推送、合并或发布。

推送与发布分开：合并到 `main` 不自动发布任何包。

## 4. 提交信息

- 类型：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 摘要写“改了什么”，正文写“为什么”，不写“按用户要求”。
- 不把格式化、重命名与行为变更混在同一提交。
- 消息不要以 `#` 开头：钩子用 `git stripspace --strip-comments` 规整消息，整段以 `#` 起头的正文会被静默删除；引用 issue 写成 `issue #125` 这种内联形式。

## 5. 文档规则

文档类型、元数据、状态、升版与历史保留统一按[文档治理规则](docs/README.md#6-编写约定)执行。正文元数据与[文档清单](docs/DOCUMENT-REGISTER.md)必须一致，出现差异时查明并修正，不让任一副本自动覆盖另一处。

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
| `pnpm check:docs` | 文档元数据、登记一致性、本地链接与锚点、表格及询问问题序列 |
| `pnpm check:repo` | 工程结构、工作区、模块状态、工作流权限、敏感信息与包体闭包（清单/入口/依赖/补丁层/locale） |
| `pnpm check:tarballs` | 每个包的 `npm pack --dry-run` 实际内容与模式位对照声明（#37 AC4） |
| `pnpm check:version` | 正文基线版本与 [.dsh-version](.dsh-version) 一致，代码中无硬编码 DSH 版本 |
| `pnpm test:unit` | 实际执行 `node --test` 自动发现的全部用例：检查器、各扩展包、凭据支撑包、索引校验与归档安装 |
| `node --test packages/forge-iam/test/*.test.mjs packages/forge-credentials-keychain/test/*.test.mjs` | 单独验证 IAM 与凭据存储包 |
| `node --test packages/forge-market/test/*.test.mjs` | 单独验证市场插件的逻辑、契约及本地安装链路 |
| `node --test services/market-index/test/*.test.mjs` | 单独验证索引校验器 |
| `node scripts/sensitive-scan/verify.mjs --base <rev> --head <rev>` | 用基线团队公钥验证敏感扫描 attestation；Git 仓库内容仍正常推送，私钥、真实规则和扫描结果不上远端 |

`pnpm check` 还包含 `node scripts/dsh-version.mjs check`（单独入口为 `pnpm check:version`）：它要求正文声明的 DSH 版本位置与 [.dsh-version](.dsh-version) 一致，并禁止代码与脚本硬编码版本；改动文档里的 DSH 版本表述或包清单的 `engines.dsh` 后，`pnpm check` 会因这一项失败，需要按[版本规则](docs/README.md#6-编写约定)同步。

检查器本身也要改：新增规则时补充失败样例，避免“看起来通过”。

### 7.1 GitHub Actions

[检查工作流 `repository checks`](.github/workflows/check.yml)在 `main` 推送、PR、合并队列的 `checks_requested` 和手动运行时触发，不在工作流入口使用路径过滤。PR 的事件基线为 head 祖先，且仅修改或删除 `docs/` 下普通 Markdown 文件或根目录的 `README.md`、`CONTRIBUTING.md`、`SECURITY.md` 时跳过跨平台作业；文档链接、登记、仓库规则和全部离线测试仍由 `verify` 执行。新增或重命名文件、混合或未知路径、非便携路径、文件类型和模式异常、事件基线前移或无法完整比较时全跑；`main` 推送、合并队列和手动运行也全跑。

- `verify (ubuntu-x64)` 在 `ubuntu-24.04` 上运行完整离线检查，超时 5 分钟；分类作业失败或结果无效时，该必需检查失败。同一 PR 的新运行取消过期运行。平台作业在 GitHub 托管的 Linux、Windows 和 macOS runner 上执行 SQLite 凭据、IAM 合成测试与离线安装冒烟；`sensitive scan and IAM callback (win32-x64)` 是合并运行 Windows 敏感扫描和回调端口测试的非必需作业。
- Node 版本来自 `.node-version`；`node --run check` 直接执行根 `package.json` 的 `check`，与 `pnpm check` 共用定义，`node --test` 自动发现工程、包与集成测试。
- `verify` 不安装 pnpm 或项目依赖，也不读取包缓存；平台作业不配置 npm 包或 `node_modules` 缓存。Linux 和 macOS 作业构建并离线安装企业组合包，Windows 作业打包并离线安装凭据独立包；安装使用 runner 工作区内的独立前缀，冒烟测试在系统临时目录使用合成数据。六个平台检查使用 `SQLite and IAM` 名称，具体名称见[开发约定](docs/engineering/development-conventions.md#6-检查与-ci)；分支保护中的必需检查名称须与工作流显示名称一致，远端配置状态以实测为准。
- 托管 runner 的结果不代替 Windows 10、UOS、银河麒麟、目标 DSH/Electron 宿主、Windows ACL 或企业 IAM 的目标环境取证。8.3 真实短名用例在卷不提供不同的短别名时跳过；需以实际运行记录区分通过与跳过。
- 工作流只授予 `contents: read`、用于核验 Issue 的 `issues: read` 和用于读取 PR 正文的 `pull-requests: read`，检出不保留凭据；分类作业检出完整历史以比较 PR 的基线与 head，其余作业检出深度为 1。Actions 固定完整 SHA 并附版本注释。[Dependabot](.github/dependabot.yml)每周一北京时间 09:00 检查 Actions 更新，合并次版本与补丁更新为一组，主版本单独评审；不自动合并或发布。
- 合并队列的 `verify` 在 `merge_group` 上执行代码检查，不重新读取各 PR 正文；关联检查依赖入队前的 PR 必需检查。入队后修改正文可能导致检查结果与队列快照不同，合并前须确认最新正文及检查结果。
- PR 另由 [sensitive-attestation](.github/workflows/sensitive-attestation.yml) 以 `pull_request_target` 从基线读取团队公钥验签，不 checkout 也不执行 PR 代码，权限同为 `contents: read`。它的 required 配置与部署状态不在本文件断言，实测与上线步骤见[敏感扫描说明](<scripts/sensitive-scan/README.md>)。
- 本地修改不代表远端必需检查、合并队列或 Dependabot 已启用，也不代表远端 CI 已通过。

依据核验日期为 2026-10-21：[GitHub 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)、[事件与合并队列](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)、[并发控制](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)、[Dependabot 配置](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)，以及 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) 的发布说明与输入声明。官方 Actions 使用 Node 24 runtime；应用检查仍使用 `.node-version` 固定的版本。工作流依赖锁文件当前属于[公开预览](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)，本仓库继续采用已有的完整 SHA 固定策略。

条件作业和必需检查的依据核验日期为 2026-11-10：[GitHub 必需检查排障](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)与 [YAML 锚点和别名](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#yaml-anchors-and-aliases)。

## 8. 安全

不提交令牌、私钥、证书、真实用户数据或生产配置。发现疑似泄露时停止提交，按[安全策略](SECURITY.md)处理，不在 issue 或聊天中扩散。

## 9. 评审

- 评审关注：设计一致性、失败模式、权限边界、测试是否覆盖负向路径。
- 文档变更同时检查登记与链接，不把“格式正确”当作内容正确。
- 未经确认的接口、性能和恢复能力标注为未验，不写成既定事实。
