# forge-policy 实现与验证记录

策略规则与验收判据见[策略与审计详细设计](../plugins/forge-policy.md)。本页记录已有离线与宿主探针证据，不代替生产准入。

**实现边界**：Host 侧受控写判定，24 个源文件。动作面是 6 条受控写的部署白名单（`gitee.issue.write`、`gitee.pr.write`、`gitee.review.publish`、`change.clarification.write`、`gitee.git.push`、`gitee.review.record`），读动作不入目录、不判定也不审计。判定在 `tools.pre-execute` 内按固定顺序执行：动作解析 → 身份（写动作必须解析出 IAM 主体，无开关、总是开启）→ `denyHumanRecord` → `denyUnknownAction` → `protectPaths` → `enforceProcessRules` → `contentGate` → 确认 → 审计 → 一次性收据与执行后复验。七个规则开关全部默认关闭，关闭的规则不进入代码路径、只留一条 `allow / rule: disabled` 记录；未知开关键或未接入的配置面在装载期拒绝并给出键路径。确认通道走宿主 `ctx.userQuestions`，不调用 `approval`，子代理发起的确认请求转交存活根会话代问；决策复用按 `toolName + callId + action + 参数摘要` 会话内 32 条 LRU。审计恒开，落点为内存环形缓冲或 `$DSH_HOME/logs/forge-policy-<date>.jsonl`（按天轮转、保留 7 天），并以 `/policy-audit [N]` 只读命令查询。

**验证结果与限制**：2026-11-23 在 `eba8a6b` 上 `node --test packages/forge-policy/test/*.test.mjs` 439 例通过、无跳过（720 ms）；同版本全量 `pnpm check` 4839 例、4836 通过、0 失败、3 跳过（88.7 s），仓库结构与文档检查一并通过。本机 dev profile 加 mock 模型与探针命令的端到端取证（2026-11-23，非企业环境）：干净正文的 `gitee.issue.write` 放行并执行；`.env` 路径命中 `PROTECTED_PATH`（规则标识 `name:.env`）；命中配置追加根时为 `root:1`，审计中不出现该根的绝对路径；人工留痕写动作按 `denyHumanRecord` 拒绝；未登记动作按 `denyUnknownAction` 拒绝；推送 `main` 与强制推送分别被 `push-protected-branch`、`push-force` 拒绝；建 PR 缺验收小节按软规则进入确认卡片，取消后返回 `POLICY_CONFIRM_DENIED` 且零执行。子代理路径以真实子代理调用同一受控工具取证：确认卡片出现在主会话并标注来源，允许后子代理拿到执行结果，取消返回取消文案，超过 120 秒返回超时文案。审计记录全文检索不含工作区绝对路径、夹具目录名与正文（正文参数记作 `[content]`）；`/policy-audit` 区分"有记录""已装配但为空""未装配审计"三种状态。`model-guard-probe.mjs` 已按 r19 口径改为验证"未登记动作按 out-of-scope 透传、登记动作缺 `target` 被拦、不按来源拒绝子代理"，尚未在本机重跑；`run-host-probe.mjs` 与 `sandbox-order-probe.mjs` 写在 r19 之前（仍按 `action-disabled`、批准台账等已删机制判据），对现行实现不再构成证据，未复跑。**未完成/未测**：企业桌面实机确认卡片、真实 Gitee/DevOps 写入、企业侧 `user-questions` API 一致性均未取证；`change-in-progress` 与 `plan-confirmed` 两条流程规则依赖 dop 变更与计划事实源，尚未接入；同权 JS 可绕过进程内门禁，本插件不是安全边界。

## 准入核对要点

**设计与接入边界**：判定顺序、七个开关的开启与关闭行为、内容规则三档语义、确认卡片的分步与错误码、子代理代问与无根会话拒绝、审计字段白名单与三种空态，均由 `packages/forge-policy/test/` 下的离线用例覆盖；端到端只在 mock 目标与本机 dev profile 上取证，不构成企业环境证据。

**准入关注点**：确认通道在目标宿主与桌面端的实际表现、企业 IAM 身份解析的真实返回、dop 与 Gitee CLI 的结构化输出、`$DSH_HOME/logs` 在受限文件系统上的可写性，以及审计保留与轮转在长期运行下的行为。
