# @corp/dsh-sdd

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | Skill pack + CLI |
| 职责 | 规范驱动开发的产物契约、freeze 与指纹、归档与 PR 描述 |
| 不负责 | 不接管对话流程，不替代代码评审，不自行执行路径门禁 |
| 衔接点 | `skill-filesystem`；路径规则由 [@corp/dsh-policy](../dsh-policy/README.md) 执行 |
| 详细设计 | `docs/design/plugins/dsh-sdd.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 只守三条不变量：规范与代码不漂移、一次交付原子、变更可追溯。
- 阶段写入元数据，不用阶段编号驱动对话顺序。
- 路径规则集中在策略插件，不在本包维护另一套钩子。
- CLI 保持小而可测，不引入第二套流程引擎。