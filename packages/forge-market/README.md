# @heluo/forge-market

状态：可用

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle |
| 职责 | 接入企业精选市场：目录地址、内部源与上架/安装策略 |
| 不负责 | 不实现目录服务，不自研 registry，不提供额外市场 UI |
| 衔接点 | `plugin-market`、`plugin-manager` |
| 服务实现 | 企业插件目录，见 [DESIGN-012](../../docs/design/services/market-index.md) |
| 详细设计 | [DESIGN-007](../../docs/design/plugins/forge-market.md) |
| 实现状态 | 安装策略逻辑与单元测试已建立；bundle 接线待上游配置项核验 |

## 边界

- 企业市场与官方市场并存：内部渠道管精选与分发，官方入口默认保留。
- 上架与安装前校验包名范围、固定版本、安装脚本与 `engines.dsh` 兼容性。
- 只读与受限角色禁用插件管理工具；开发者可从内部已审批源安装。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。