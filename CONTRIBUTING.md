# 贡献指南

本指南负责环境准备、变更流程和评审提交。项目现状与目录见 [README](README.md)，agent 执行规则见 [AGENTS.md](AGENTS.md)，文档治理见[文档总览](docs/README.md#6-编写约定)，工程细则见[开发约定](docs/engineering/development-conventions.md)。

仓库为企业内部私有工程；参与贡献不代表获得推送、发布或对外分发授权。

## 1. 环境

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | 见 [.node-version](.node-version) | 用现有版本管理工具切换，并核对 `node --version` |
| pnpm | 见 [package.json](package.json) 的 `packageManager` | 核对 `pnpm --version`，同时满足 `engines` |
| 依赖 | 无第三方运行时依赖 | 工程检查使用 Node 标准库 |

首次检出后执行 `pnpm install --frozen-lockfile` 校验锁文件；日常检查不需要安装依赖。

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
5. 运行 `pnpm check` 与 `git diff --check`，审阅最终 diff；模块已有实现时另跑相应测试。失败须修复或明确阻塞，不能以跳过宣称通过。
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
3. 设计通过后创建 `package.json`，声明 `engines.dsh`、`private` 与 `test` 脚本。
4. 完成实现与包内实际测试；兼容、契约或实机验证按设计准入要求取证。
5. 达到可用判据后再更新对应 README 状态，写清能力边界与未验项；发布还须单独满足发布门禁。

未建立清单前不要提前写 `src/`，避免出现无法运行的空壳。

## 7. 检查命令

常用命令与覆盖范围见 [README 的本地检查](README.md#3-本地检查)，可执行定义以 [package.json](package.json) 为准。包级、契约、集成与端到端测试按[测试分层约定](docs/engineering/development-conventions.md)分别执行。

检查器本身也要改：新增规则时补充失败样例，避免“看起来通过”。

## 8. 安全

不提交令牌、私钥、证书、真实用户数据或生产配置。发现疑似泄露时停止提交，按[安全策略](SECURITY.md)处理，不在 issue 或聊天中扩散。

## 9. 评审

- 评审关注：设计一致性、失败模式、权限边界、测试是否覆盖负向路径。
- 文档变更同时检查登记与链接，不把“格式正确”当作内容正确。
- 未经确认的接口、性能和恢复能力标注为未验，不写成既定事实。
