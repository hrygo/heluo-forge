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
5. 运行 `pnpm check` 与 `git diff --check`，审阅最终 diff；前者已包含自动发现的市场包、参考服务和本地集成用例。变更需要企业接口或实机证据时另行验证，已有完整有效测试不重复运行。失败须修复或明确阻塞，不能以跳过宣称通过。
6. 在相应授权范围内提交或发起 PR，一次提交只做一件事。按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)填写关联依据、验证结果、未验项与风险；本地编辑完成不自动触发推送、合并或发布。

推送与发布分开：合并到 `main` 不自动发布任何包。

## 4. 提交信息

- 类型：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 摘要写“改了什么”，正文写“为什么”，不写“按用户要求”。
- 不把格式化、重命名与行为变更混在同一提交。

## 5. 文档规则

文档类型、元数据、状态、升版与历史保留统一按[文档治理规则](docs/README.md#6-编写约定)执行。正文元数据与[文档清单](docs/DOCUMENT-REGISTER.md)必须一致，出现差异时查明并修正，不让任一副本自动覆盖另一处。

修改范围或决策时沿关联关系同步下游设计、契约、计划和验收；入口保留摘要与链接。文档检查验证结构及一致性，语义正确性仍需评审。

## 6. 新增模块

1. 在[设计索引](docs/design/README.md)登记模块、形态与状态。
2. 用[模块设计模板](docs/templates/design-template.md)编写详细设计，核验目标 DSH 接口。
3. 设计通过后创建 `package.json`，声明 `engines.dsh`、`private` 与 `test` 脚本。现有市场参考服务由根工程发现测试，尚无独立服务清单；正式服务打包前先明确清单规则并同步检查器。
4. 完成实现与包内实际测试；兼容、契约或实机验证按设计准入要求取证。
5. 达到可用判据后再更新对应 README 状态，写清能力边界与未验项；发布还须单独满足发布门禁。

未建立清单前不要提前写 `src/`，避免出现无法运行的空壳。

## 7. 检查命令

常用命令与覆盖范围见 [README 的本地检查](README.md#3-本地检查)，可执行定义以 [package.json](package.json) 为准。包级、契约、集成与端到端测试按[测试分层约定](docs/engineering/development-conventions.md)分别执行。

检查器本身也要改：新增规则时补充失败样例，避免“看起来通过”。

### 7.1 GitHub Actions

[检查工作流](.github/workflows/check.yml)保留 `check / verify` 门禁：`main` 推送、PR、合并队列的 `checks_requested` 和手动运行均执行全量检查。不使用路径过滤，文档与图片变更也会接受跨文件链接、登记和仓库规则检查，避免必需检查因跳过触发而一直等待。

- 单个 `ubuntu-24.04` job，超时 5 分钟；相同工作流、事件与 PR/分支的新运行取消过期运行，手动运行与 PR/推送互不取消。
- Node 版本来自 `.node-version`；`node --run check` 直接执行根 `package.json` 的 `check`，与 `pnpm check` 共用定义，`node --test` 自动发现工程、包与集成测试。
- 当前检查无第三方依赖，不安装 pnpm 或依赖、不读写包缓存、不拆矩阵。引入第三方依赖时，须同步配置固定 pnpm、`pnpm install --frozen-lockfile` 和按锁文件索引的 pnpm store 缓存，再按实测耗时评估拆分；不缓存 `node_modules`。
- 工作流只授予 `contents: read`，检出不保留凭据、深度为 1；Actions 固定完整 SHA 并附版本注释。[Dependabot](.github/dependabot.yml)每周一北京时间 09:00 检查 Actions 更新，合并次版本与补丁更新为一组，主版本单独评审；不自动合并或发布。
- 仓库管理员可将 `verify` 设为必需检查；本地修改不代表已启用远端规则、合并队列或 Dependabot，也不代表远端 CI 已通过。

依据核验日期为 2026-10-21：[GitHub 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)、[事件与合并队列](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)、[并发控制](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)、[Dependabot 配置](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)，以及 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) 的发布说明与输入声明。官方 Actions 使用 Node 24 runtime；应用检查仍使用 `.node-version` 固定的版本。工作流依赖锁文件当前属于[公开预览](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)，本仓库继续采用已有的完整 SHA 固定策略。

## 8. 安全

不提交令牌、私钥、证书、真实用户数据或生产配置。发现疑似泄露时停止提交，按[安全策略](SECURITY.md)处理，不在 issue 或聊天中扩散。

## 9. 评审

- 评审关注：设计一致性、失败模式、权限边界、测试是否覆盖负向路径。
- 文档变更同时检查登记与链接，不把“格式正确”当作内容正确。
- 未经确认的接口、性能和恢复能力标注为未验，不写成既定事实。
