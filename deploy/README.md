# 部署资产

状态：规划

本目录存放私有市场、独立服务与双端分发的部署资产。当前只有职责说明，没有可执行部署配置、凭据或已构建制品。

市场已有[插件实现](../packages/forge-market/README.md)与[HTTP 参考服务](../services/market-index/README.md)，可做本地开发验证；不表示本目录已有生产部署。[ADR-11](<../docs/architecture/plugin-registry-source-decision.md>)已确认目标为企业私有 npm（公网同步包与内部定制包），固定 Gitee group 只维护内部定制源码。[ADR-12](<../docs/architecture/plugin-registry-source-decision.md>)进一步限定首版自包含、双端通用和单profile规范企业入口；当前授权/原子发布及两步恢复按正式设计验收。代码仍走 Gitee tag 归档，npm接入与运行能力尚待验证，不是已完成部署。

| 子目录 | 内容 | 状态 |
|---|---|---|
| [`registry/`](<registry/README.md>) | 企业私有 npm 的接入、公网同步、内部包发布与运维边界 | 来源已定；接入待核验 |
| [`clients/`](<clients/README.md>) | Windows 与银河麒麟客户端配置、安装与更新资产 | 待构建 |

## 边界

- 优先复用企业现有 registry 与分发通道，不默认自建基础设施。
- 仓库内不保存真实地址、凭据、证书私钥或生产配置；使用占位与外部注入。
- 部署资产进入仓库前须明确归属、审批人与回滚方式。
- 本目录的存在不代表任何环境已部署；实机与生产验证记录另存门禁证据。