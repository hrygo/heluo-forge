# 插件市场决策：企业 Artifactory + AIHUB 原生索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-ARCH-004 |
| 文档名称 | 插件市场决策：企业 Artifactory + AIHUB 原生索引 |
| 版本 | V2.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-21 |
| 门禁 | G1 接入；G2 三目标安装 |

> 编制依据：2026-10-21 用户决定采用 DSH 原生「插件市场 → 索引源」轻量模式：AI 开发者平台（AIHUB）维护并托管 format-1 索引，企业 Artifactory 存包体，原生市场 + 官方 manager 安装；不再建设生成器、`current/policy/evidence`、CI 单写发布与租约。
>
> 关联文档：[DESIGN-007](<../design/plugins/forge-market.md>)、[DESIGN-012](<../design/services/market-index.md>)、[P0 取证单](<../plans/market-p0-verification.md>)、[AIHUB issue #12](https://github.com/hrygo/heluo-forge/issues/12>)。
>
> 核验边界：format-1 解析行为于 2026-10-21 对 DSH `0.2.1-rc.2` 只读核对；未做企业 Artifactory、AIHUB 索引或三目标实机验收。

## 0. 三分钟读懂

| 问题 | 决定 |
|---|---|
| 包体从哪来 | 企业 Artifactory（唯一 npm 制品源） |
| 目录从哪来 | AIHUB 维护并托管的 format-1 JSON |
| 用户怎么用 | 原生「索引源」添加 URL → 浏览 → 安装精确版本 |
| 谁做检查 | AIHUB 在发布前策展；本项目只校验索引契约与验收 |
| 本项目建什么 | 校验工具、契约、验收与文档 |
| 本项目不建什么 | 生成器、市场服务、数据库、代理、CI 发布链路、写前授权 |
| 主要代价 | 没有 `installEnabled`/租约/逐版本证据/全通道强制 |

## 1. ADR-11：企业 Artifactory 是唯一制品源（保持）

**决定**：企业私有 JFrog Artifactory 统一承载公网同步包与内部定制包；终端不直连公网 registry、Git 或 tarball；内部 scope 禁止回源公网。

**边界**：

- 入口只保存在本地配置并在打包时内置，不入 Git 库；允许内网 HTTP（已批准例外）。
- 同名同版本不可变；删除需管理员权限。
- 公网镜像包不需要迁入内部 Gitee group；内部定制源码仍限固定 group。

## 2. ADR-12：首版只收自包含、三目标通用稳定包（保留策展规则）

**决定**：首版索引只放自包含（无外部运行依赖）、Windows 10 amd64 / 统信 UOS 20 amd64 / 银河麒麟 aarch64 三目标通用、稳定 SemVer 的根版本。

**说明**：这是 AIHUB 上架前的策展规则，不再由本项目生成器逐版本检查。普通带依赖或单平台包不是 DSH 非法，只是不进首版索引。

**撤回**：旧 ADR-12 中“写前在线授权、15 分钟租约、`current/policy/evidence`、CI 单写发布”的部分不再采用，由 ADR-13 取代。

## 3. ADR-13：原生 format-1 索引轻量模式（新）

**背景**：原生市场已支持用户添加索引 URL，直接浏览并调用官方 manager 安装。企业已确认 AIHUB 负责插件生命周期、白名单与静态托管，继续自建生成器与发布控制会重复建设且无法覆盖全通道。

**决定**：

1. AIHUB 产出并托管一份合法 format-1 索引 JSON，提供稳定只读 URL。
2. 用户在原生「索引源」添加该 URL；市场展示索引中的精确版本。
3. 安装由官方 `pluginManager` + pnpm 从 Artifactory 执行，本项目不介入。
4. 不再生成 `policy/evidence/current`，不设写前授权、租约、单写 owner 或原子 current。
5. 更新与撤回由 AIHUB 负责；时限写入索引契约与 issue。
6. 本项目保留只读索引校验器与验收清单。

**理由**：

- 与已确认的 AIHUB 职责一致，避免两套目录与两套发布流程。
- 原生入口已经存在，不需要自定义插件、Host 适配或新服务。
- 轻量模式的代价（无写前授权/证据）小于重复建设的成本。

**不采用**：

- 自建生成器 + `current/policy/evidence` + CI 单写：与 AIHUB 托管/白名单职责冲突，且原生源一旦开放，写前门禁无法证明全通道覆盖。
- 插件运行时现场生成索引：每台终端重复拉包/检查，无集中证据，偏离原生目录模式。
- 把纯包名白名单直接当索引：原生不识别，且没有版本/source，无法安装。

## 4. 后果

**正面**

- 无需新服务、数据库、CI 发布链路或企业 DSH 定制插件。
- 用户路径最短：加 URL → 浏览 → 安装。
- 与 AIHUB 现有插件生命周期天然衔接。

**负面与残余风险**

- 没有写前授权、租约与逐版本证据；索引可读即可安装。
- format-1 无 integrity/OS-CPU/matrix；只能依赖 AIHUB 策展、Artifactory 不可变与网络边界。
- 不能阻止用户添加其它索引、用 CLI 或任意 spec 安装；不能宣称 REQ-14/G2 全通道通过。
- 索引更新/撤回依赖 AIHUB 的 SLA；本项目只能验收，不能强制。
- HTTP registry 无传输加密；token 与包体元数据暴露风险由最小 Scope、受控网络与私服不可变补偿。

## 5. 验收与未决

- 索引契约与验收：见 [DESIGN-012](<../design/services/market-index.md>)、[P0 取证单](<../plans/market-p0-verification.md>)。
- AIHUB 交付：见 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。
- 未决：索引 URL 协议、匿名读取方式、`source.registry` 具体虚拟仓、更新触发机制、历史版本保留策略。

## 6. 状态

评审稿，审核/批准待定；企业接入与三目标安装未验。本文不代表 AIHUB 已承诺 SLA，也不代表安装已开放。
