# 内网审批通道排查单（gitee.pr.write 范围确认）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-UAT-004 |
| 文档名称 | 内网审批通道排查单（gitee.pr.write 范围确认） |
| 版本 | V0.2 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-18 |
| 门禁 | 内网实机验证（待回填） |
| 交付门禁 | 内网实机验证（待回填）；回填前不作为运行手册 |

> 编制依据：2026-11-18 内网测试轨迹（第 2 轮创建 PR，写动作被 `GUARD_POLICY_DENIED` 拦截，`remote_calls: 0`，全程无确认弹窗）；本仓库 `c889610` 的判定链源码（[gate.mjs](../../packages/forge-policy/src/gate.mjs) 当时的 `requestApproval`/`scopeAdmission` 分支，该审批与范围票据通道已在 r19 P0 删除，见 [TECH-CHANGE](../teamflow/20261119-r19-policy-minimal-gates/TECH-CHANGE.md)）；[gitee-guard.mjs](../../packages/forge-gitee/src/gitee-guard.mjs) 的策略错误映射；本机装配探针逐字复现同一信封；已安装 DSH 的审批子系统文档 `docs/subsystems/approval.zh.md`（`ctx.approval` 分发服务与 `approval/request` waterfall）。

本单用于定位“为什么没有出现任务范围确认”，并把确认通道接好、重跑一次写动作验证。检查项与判据仍待内网实机回填，回填前不构成运行手册，也不代表该环境已通过验收。

## 1. 现象与判断

现象：`forge_gitee_pr_write` 返回 `status: denied`、`reason: GUARD_POLICY_DENIED`、`detail: no confirmed task scope covers gitee.pr.write on <owner>/<name>`、`next_action: report-to-admin`、`remote_calls: 0`，且轨迹里没有任何确认卡片。

判据：这条 `detail` 只在身份、会话、变更号三者齐备、而任务范围票据不匹配时出现；此后门禁必然向宿主审批服务发起过一次范围确认（文案 `confirm a task scope for gitee.pr.write on <owner>/<name>`）。拿不到 `allowed-once`，门禁按 fail-closed 拒绝，并把审批侧的真实原因替换成票据文案。

结论：拦截本身正确（零远端写入）；缺的是把确认送到人面前的那一段通道。**不是**“该仓库未登记写入范围”——动作已在四个分发补丁层登记，仓库只是票据的绑定维度之一，代码里没有按仓库登记写入范围的机制。

## 2. 四步定位（按顺序，命中即处置）

先做一个 30 秒嗅探：在内网 GUI 里触发任一**普通**需确认操作（例如一条会触发确认的命令）。若连这种确认也从不弹卡片，直接按第 2 步处理。

| # | 判据（日志或界面证据） | 含义 | 处置 |
|---|---|---|---|
| 1 | 会话日志最后一条 `approval/policy` 为 `never` | 策略在服务内部直接返回 `rejected`，不分发、不弹窗 | 改回 `ask`。`setPolicy` 是唯一写入路径，回放会话日志可重建覆盖值 |
| 2 | 有 `approval/asked`，随后 `approval/decided = unavailable` | 没有应答者，或应答者不负责该 agent（界面只应答自己拥有的 agent），或应答者抛错 | 在当前 profile 启用提供人工确认界面的前端应答者，并以同一会话重试 |
| 3 | 日志里完全没有 `approval/asked` | 发起调用的插件上下文拿不到审批服务（`ctx.get('approval')` 为空），请求根本没进入审批子系统 | 补齐该 profile 的用户审批服务与前端应答者装配，重启后重试 |
| 4 | 该会话没有运行中的轮次，且日志无 `approval/asked` | 审批服务要求发起请求的会话处于未结束的轮次；空闲时的询问在写日志前直接被拒 | 改为在活动会话里由工具调用发起，不用脚本/CI 直接调用工具服务 |

## 3. 接好通道（管理员）

1. **运行形态**：桌面或 Web 交互式界面。headless 与 SDK 形态不含人工应答者；ACP 桥接只为它自己拥有的 agent 提供一次性机器决策，不覆盖交互会话。
2. **装配**：profile 同时具备用户审批服务与提供人工确认界面的前端插件。服务缺失时任何审批事件都不会产生；只有服务而无界面时，询问会落到 `unavailable`。
3. **策略**：保持默认 `ask`。不得为让本次调用通过而改成 `never`、也不得改成长期自动放行。
4. **生效校验**：新开一个会话，触发 §2 嗅探里的普通确认操作，应看到确认卡片并能选“允许一次”。

## 4. 重跑验证（三个信号，缺一即未通过）

1. 写动作触发时出现确认卡片，文案为 `confirm a task scope for gitee.pr.write on <owner>/<name>`。
2. 选“允许一次”后，工具信封为 `status: done`、`remote_calls ≥ 1`，PR 在远端可见。
3. 同一会话、同一变更号、同一仓库的第二次写不再询问（票据复用）；换仓库、换变更号或重启进程后会重新询问一次。

日志侧同时确认出现成对事件：`approval/asked` → `approval/decided = allowed-once`。

## 5. 失败对照表

| 现象 | 判据 | 处置 |
|---|---|---|
| 仍无弹窗，`detail` 一字不变 | 日志无 `approval/asked` | 回到 §2-3 |
| 有询问，结果为 `rejected` | 策略 `never`，或应答者主动拒绝 | 回到 §2-1 |
| 结果为 `unavailable` | 无应答者 / 应答者异常 / 非其负责的 agent | 回到 §2-2 |
| 结果为 `cancelled` | 请求被撤销、超时或界面关闭 | 重试一次并保留日志 |
| 点了拒绝后，信封 `detail` 仍只有票据文案 | `approval/decided = rejected`，但 `detail` 未出现 `rejected` | 该环境制品未包含提示文案与失败原因修复（[gate.mjs](../../packages/forge-policy/src/gate.mjs) 当时的确认文案分支，已在 r19 P0 删除）：核对已装版本后回传信封 |

## 6. 交回平台组的材料

DSH 版本与 profile 名、会话 id 与大致时间、`approval/*` 日志片段、写动作的完整信封（脱敏后）。不要附凭据、内网地址或个人数据。

## 7. 禁止项

- 不为通过而把审批策略设为 `never` 或放宽门禁，不伪造 `allowed-once`，不绕过 guard。
- 不修改 gitee 门禁或策略代码来“修”这条报错；改门禁属于代码变更，走评审。
- 无人值守批处理不得借用个人会话的确认结果；本设计对无交互场景一律 fail-closed，需要放行时走范围变更。

## 8. 平台组侧的复核入口

仓库内可用 `node scripts/probe/run-host-probe.mjs` 对目标 DSH 复核审批签名与 `never` 行为（无 `dsh` 时跳过，不伪装通过）；信封字段的本地用例在 [packages/forge-gitee/test](../../packages/forge-gitee/test) 与 [packages/forge-policy/test](../../packages/forge-policy/test)。

相关设计：[策略判定模型 §8](../design/policy-model.md#8-身份批准与确认) 与 [策略与审计详细设计 §5.4](../design/plugins/forge-policy.md#53-受控写的确认卡片)。
