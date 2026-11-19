# DSH 专家智能体管理插件工作假设

> 2026-11-20 · Agent 代拟 · 待 Goldfish 评审

## 工作假设

用户从 DSH 的「专家智能体」入口浏览与搜索 Delegra 授予当前账号调用权的全部专家。首次使用和新增授权的专家默认未启用。未启用的专家显示「启用」按钮，已启用的专家显示「停用」按钮。操作保存成功后更新该账号的 `@` 候选。停用的专家继续显示在管理页，可在仍有调用权时重新启用。

Delegra 管理专家与任务，DSH Host 保存个人偏好。首轮按 Delegra 实例、组织、当前账号和稳定专家 ID 保存本机偏好。管理页用名称和职责区分同名专家，选择和保存按 ID 对齐。启用状态参与新委派的候选过滤和发送校验，已提交任务按 Delegra 的任务生命周期执行。

## 候选与权限

管理页按当前员工的调用资格取数，并分别呈现个人启用状态与专家接单状态。专家只有在当前员工有调用权、可接受新任务且用户已手动启用时才进入 `@` 候选。目录加载失败与成功加载后的空目录分别呈现。

账号、组织或授权变化时，Host 作废旧候选。选择后停用、权限撤销或专家停止接单时，新的委派须重新校验，失效的选择提示重选并保留任务草稿。最终调用资格由 Delegra 按当次任务判定。

## 核验依据

| 依据 | 2026-11-20 核验结果 |
| --- | --- |
| DSH `dsh-v0.2.1-rc.3`，`packages/client/ui-input-trigger/src/client/contract.ts` 与 `packages/client/ui-reference/src/client/index.ts` | `inputTriggers.registerSource` 可注册原生 `@` 候选源。可信的提交绑定按现有取证判据跟踪。 |
| Delegra `deploy/v2026.1106.0-r2`，`server/src/services/public-mcp/capabilities.ts`、`server/src/routes/agents.ts` 与 `server/src/routes/issues.ts` | `paperclip_list_agents` 返回按当前调用者读取权限过滤的专家与状态。实际指派另行以目标专家、项目等上下文判定 `tasks:assign`。管理页需核验目标环境中可供 DSH 使用的员工调用资格契约。 |
| [专家 PRD §3](../../requirements/delegra-experts-prd.md#3-场景与协作方式)与[专家接入方案 §3](../../plans/2026-11-18-forge-experts-integration-proposal.md#3-dsh-选择与委派绑定) | 目录和选择沿用 `forge-experts` 的职责，实施在 [#246](https://github.com/hrygo/heluo-forge/issues/246) 跟踪。员工授权目录和宿主接缝分别由 [#244](https://github.com/hrygo/heluo-forge/issues/244) 与 [#245](https://github.com/hrygo/heluo-forge/issues/245) 取证。 |

## 产品确认记录

| 确认人 | 日期 | 事项及范围 |
| --- | --- | --- |
| 项目负责人 | 2026-11-20 | DSH 管理页通过按钮手动启用专家，适用于首次使用和新增授权。 |
