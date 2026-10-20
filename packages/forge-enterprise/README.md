# @heluo/forge-enterprise

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | umbrella bundle（`cordis.patch.yml`） |
| 职责 | 按行组装企业能力、角色 preset 与默认依赖检查 |
| 不负责 | 不重复实现成员包逻辑，不承载业务接口 |
| 详细设计 | `docs/design/plugins/forge-enterprise.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 每个能力一行 `insert`，可单独 `disabled` 或覆盖配置。
- 组合顺序遵循[设计顺序](../../docs/design/README.md)：身份与策略先定，组合包最后收敛。
- IAM、policy 与必要审计缺失时，拒绝相应企业调用；可关闭不等于关闭后仍保留权限。
- 角色 preset 只调整工具可见性与提示，不替代服务端授权。