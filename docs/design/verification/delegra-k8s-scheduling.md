# Delegra Kubernetes 智能调度实现与验证记录

设计规格与验收判据见 [Delegra Kubernetes 智能调度总体设计](../delegra-k8s-scheduling.md) 及其 5 份子文档：[镜像路由与 ARM64](../delegra-k8s-scheduling/01-profile-routing-arm64.md)、[暖池与 SandboxClaim](../delegra-k8s-scheduling/02-warm-pool-sandbox-claim.md)、[集群零信任代理与逐请求鉴权](../delegra-k8s-scheduling/03-cluster-gateway-proxy-authz.md)、[Cilium 隔离与 Kata-FC](../delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md)、[SSA 协调与容量反压](../delegra-k8s-scheduling/05-ssa-quota-backpressure.md)。本页汇总当前已落地的代码静态与单元测试证据，并对缺乏真实 Kubernetes 集群、Cilium CNI、v1beta1 控制器与 Kata-FC 节点池的验收项如实标记为 `BLOCKED`；在真集群实测闭环前，本页不替代生产准入（追踪见 [heluo-forge#420](https://github.com/hrygo/heluo-forge/issues/420)）。

## 固定代码基线

核验日期为 2026-11-24。

- **Delegra 控制面与 K8s 沙箱插件**：`hrygo/Delegra:deploy` 已合入 `#77`–`#85`（生产主链路接线 `bbe2aebaa906`）与 `#87`（真集群验收手册与一键巡检脚本，合并提交 `31630b0272a2`），各补丁登记于 `.delegra/patches.json`。
- **Heluo Forge 设计、契约与插件侧**：`hrygo/heluo-forge:main` 已合入 `#422`（`CORP-DSH-DESIGN-024` V2.0.0 总体与 5 份子设计）、`#423`（宿主预检探针）、`#424`（`CORP-DSH-EXPERT-001` 受限员工访问契约）与 `#425`（`@heluo/forge-experts` 独立管理包）；`#426`（`@heluo/forge-iam` RFC 8693 换票与不透明句柄）与 `#446`（`@heluo/forge-experts` Delegra 连接器与离线 Contract Harness）已完成代码实现与单测，待最终合入。

## 已落地静态与单元测试证据

| 模块与设计子文档 | Delegra 落地范围与登记补丁 | 已验证的离线与单测证据 | 当前状态 |
| --- | --- | --- | --- |
| 镜像 Digest 校验、5 档 Profile 与 ARM64 预热（`01-profile-routing-arm64.md`） | `delegra-k8s-digest-profile-sizing`（`f359a677`）、`delegra-k8s-routing-evidence`（`cf6f9558`）；`PriorityClass` 与 `arm64-image-prepuller-daemonset.yaml` 清单 | 不可变 `@sha256` 校验、`host:port` 镜像仓改写、5 档专家规格映射 17 个 ARM64 镜像、Pod 运行期 digest 取证及 `agentId` 标签清理均由 `plugin-sandbox-kubernetes` 单测覆盖 | 静态与单测 PASS |
| 租户 SSA 协调与 Standard/Cilium 零停机切换（`04`/`05`） | `delegra-k8s-ssa-cilium`（`95dad97c` 等 4 笔提交，关单 `Delegra#74`） | `KubernetesObjectApi` SSA 协调、每集群 5 分钟指纹缓存、`(cluster, namespace)` 串行锁、跨公司命名空间归属校验、apply-before-delete 策略切换与标准模式 403 容错均由单测覆盖 | 静态与单测 PASS |
| 控制面逐请求零信任鉴权与集群代理（`03-cluster-gateway-proxy-authz.md`） | `delegra-k8s-gateway-authz`（`d58005e9`）、`delegra-k8s-cluster-proxy`（`fd1b6c57`、`aa1fc85e`，关单 `Delegra#73`）、`delegra-k8s-production-wiring`（`0d993345`、`d9308139`，`Delegra#85`） | `server/src/app.ts` 在 `actorMiddleware` 前挂载 `expertGatewayAuthzRoutes`（缺 `DELEGRA_GATEWAY_INTERNAL_TOKEN` 时 `503` fail-closed）；5 类拒绝码（`RUN_GENERATION_STALE`、`TASK_CANCELLED`、`USER_AUTH_REVOKED`、`MODEL_NOT_ALLOWED`、`BUDGET_EXHAUSTED`）、`POST /v1/responses` 白名单、16 MiB 请求体上限、零凭证 Secret 拆分与 stdin tmpfs 令牌投递均由单测覆盖 | 静态与单测 PASS |
| `v1beta1` `SandboxClaim` / `SandboxWarmPool` 单向生命周期（`02-warm-pool-sandbox-claim.md`） | `delegra-k8s-v1beta1-warmpool`（`1858d1ba`、`7f988359`，关单 `Delegra#75`）与 `delegra-k8s-production-wiring`（`Delegra#85`） | `extensions.agents.x-k8s.io/v1beta1` 构建与编排、`spec.warmPoolRef`/`lifecycle.shutdownTime`/`DeleteForeground`、条件级 `observedGeneration`、显式 `agent` 容器 `restartCount === 0` 校验、严禁回池守卫、幂等 404 容错销毁与 KEDA 潮汐清单均由单测覆盖 | 静态与单测 PASS |
| 派发前 `ResourceQuota` 反压与 C3/C4 `kata-fc` 强隔离（`04`/`05`） | `delegra-k8s-backpressure-kata`（`099afadd` 等 3 笔提交，关单 `Delegra#76`）与 `delegra-k8s-production-wiring`（`Delegra#85`） | 租户配额水位准入、`CapacityAdmissionDeferredError` 排队重试分类、老化优先级队列、C3/C4 无 `kata-fc` 时 `KataIsolationRequiredError` fail-closed 阻断（`requests.memory === limits.memory`、`>= 512Mi` offset、`NoSchedule` toleration）与 Karpenter v1 双池清单均由单测覆盖 | 静态与单测 PASS |
| 生产主链路接线与真集群巡检脚本 | `delegra-k8s-production-wiring`（`Delegra#85`）、`delegra-k8s-e2e-acceptance`（`a782e7b0`，`Delegra#87`） | `plugin-production-wiring.test.ts` 验证 `v1beta1` 暖池认领 + stdin 令牌投递 + 单向销毁、配额反压排队、C3/C4 fail-closed 与冷启动零凭证拆分；已合入只读安全默认巡检脚本 `scripts/verify-k8s-scheduling-e2e.sh` 与验收清单 `E2E-CLUSTER-ACCEPTANCE.md` | 静态与单测 PASS |

## 真集群联调阻断项（BLOCKED）

以下验收项依赖真实 Kubernetes `>= 1.29` 集群与对应数据面组件，当前环境不具备真集群条件，全部如实标记为 `BLOCKED`，待目标集群就绪后使用 `Delegra` 仓库内 `scripts/verify-k8s-scheduling-e2e.sh` 与 `packages/plugins/sandbox-providers/kubernetes/E2E-CLUSTER-ACCEPTANCE.md` 实测回填：

| 验收项 | 依赖环境组件 | 当前状态 | 解除阻断判据 |
| --- | --- | --- | --- |
| `v1beta1` `SandboxClaim` / `SandboxWarmPool` 真实认领与单向销毁 | Kubernetes `>= 1.29` + `kubernetes-sigs/agent-sandbox >= v1.0.12` 控制器 | `BLOCKED` | 实测 `SandboxClaim` 认领 P50/P95 延迟，确认 `releaseLease`/`destroyLease` 后 `SandboxClaim`、`Sandbox` 与 Pod 彻底删除且零回池 |
| `CiliumNetworkPolicy` 精确 FQDN 放行与 Standard/Cilium 零停机切换 | Cilium CNI（含 `CiliumNetworkPolicy` CRD） | `BLOCKED` | 实测 `standard` ↔ `cilium` 切换期间在途 Pod 零断连，且未放行外网域名与集群内其他租户被阻断 |
| `delegra-gateway-proxy` 实网逐请求鉴权、撤销断流与零凭证 Secret 审计 | 真实集群控制面 + `delegra-gateway-proxy` Deployment + 租户 Pod | `BLOCKED` | 实测 5 类拒绝码零上游穿透、撤销后 SSE 断流 `< 100ms`、Secret 零模型 Key 落地且容器内 `/run/delegra-auth/lease-token` 权限为 `0600` |
| `ResourceQuota` 满额派发前反压与 Karpenter/KEDA 弹性扩缩容 | 真实租户 `ResourceQuota` + Karpenter v1 / KEDA 控制器 | `BLOCKED` | 配额填满后新任务进入 `queued` 且集群不产生新 Pending Pod；潮汐负载触发暖池与 ARM64 节点池扩缩容 |
| C3/C4 `kata-fc` 微虚拟机强隔离调度 | 已安装 Kata Containers（`kata-fc` RuntimeClass）的专用节点池 | `BLOCKED` | 无 `kata-fc` 时拒绝启动且不降级至 `runc`；具备 `kata-fc` 时 Pod 调度至隔离节点并验证微虚拟机运行时 |

## 解除阻断与关单条件

在具备上述组件的真集群中运行 `scripts/verify-k8s-scheduling-e2e.sh`（含 `--run-claim-smoke`）并完成 `E2E-CLUSTER-ACCEPTANCE.md` 模块 A–D 全部用例后，将实测日期、Git SHA、脚本输出与延迟/断流指标回填至本页并替换对应 `BLOCKED` 状态，方可解除 [heluo-forge#420](https://github.com/hrygo/heluo-forge/issues/420) 的 `status: blocked` 标签并推进关单。
