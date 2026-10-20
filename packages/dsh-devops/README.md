# @corp/dsh-devops

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | MCP 接入 bundle（目标为 HTTP，P1 可先用本地 stdio 验证工具面） |
| 职责 | 接入 DevOps MCP 工具面、按请求取得目标资源令牌、声明工具可见性 |
| 不负责 | 不内置平台凭据，不实现服务端审批流，不替代平台权限 |
| 衔接点 | `mcp-client` |
| 服务实现 | [services/devops-mcp](../../services/devops-mcp/README.md) |
| 详细设计 | `docs/design/plugins/dsh-devops.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 工具面控制在 12 个以内，默认只读；写操作单独开关并标注风险。
- HTTP server 按 MCP 规范暴露受保护资源元数据，并校验令牌受众。
- 生产写操作在客户端确认后由平台完成多人审批，立即返回待审批状态，不长时间挂起。
- 请求已受理、超时或断流时先查单或使用服务端幂等，不在传输层盲目重放。