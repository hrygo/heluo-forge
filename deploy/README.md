# 部署资产

状态：规划

本目录存放私有市场、独立服务与双端分发的部署资产。当前只有职责说明，没有可执行部署配置、凭据或已构建制品。

市场采用轻量原生索引模式：[轻量市场设计](<../docs/design/plugins/forge-market.md>)、[索引契约](<../docs/design/services/market-index.md>)与 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。`packages/forge-market` 与旧 `market-index` HTTP 服务仅历史参考，不属目标；`market-index` 只保留只读校验器。[ADR-11/13](<../docs/architecture/plugin-registry-source-decision.md>)已确认企业私有 npm（公网同步包与内部定制包）与 AIHUB 托管索引；首版只收自包含、三目标通用稳定版。索引交付、终端认证与三目标安装尚待验证，不是已完成部署。

| 子目录 | 内容 | 状态 |
|---|---|---|
| [`registry/`](<registry/README.md>) | 企业私有 npm 的接入、公网同步、内部包发布与运维边界 | 来源已定；接入待核验 |
| [`clients/`](<clients/README.md>) | Windows 与银河麒麟客户端配置、安装与更新资产 | 待构建 |

## 边界

- 优先复用企业现有 registry 与分发通道，不默认自建基础设施。
- 仓库内不保存真实地址、凭据、证书私钥或生产配置；使用占位与外部注入。
- 部署资产进入仓库前须明确归属、审批人与回滚方式。
- 本目录的存在不代表任何环境已部署；实机与生产验证记录另存门禁证据。