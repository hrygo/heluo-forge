# Delegra 专家智能体 Kubernetes 智能调度设计

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024 |
| 文档名称 | Delegra 专家智能体 Kubernetes 智能调度设计 |
| 版本 | V2.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 作者 | hrygo |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 三阶段按 §5 逐阶段验收；目标集群、Cilium、沙箱控制器与企业网关按 §7 取证前不开放生产 |
| 模块状态 | 规划 |

> 编制依据：项目负责人提交的《Forge 专家智能体结合 Kubernetes 智能调度方案》（V0.2.0 架构审查修订稿，2026-11-22）、五份分模块独立落地详设与交叉评审结论，以及对 Delegra `origin/deploy` 提交 `2c54db803edcb118c56660cd883c9306e218d1cc4` 中 `packages/plugins/sandbox-providers/kubernetes/` 的静态读码核验。读码只证明当前源码形态，不证明集群行为；本机没有目标集群、Cilium、沙箱控制器与企业网关的运行证据，冷启动与池命中数据均为设计目标值。
>
> 关联文档：[运行时镜像设计](delegra-runtime-images.md)（CORP-DSH-DESIGN-022）、[专家智能体 PRD](../requirements/delegra-experts-prd.md)、[专家接入方案](../plans/2026-11-18-forge-experts-integration-proposal.md)、[专家智能体管理插件详细设计](plugins/forge-experts.md)、[网关契约](../contracts/gateway-contract.md)、[需求基线](../requirements/requirements-baseline.md)。跨仓库跟踪见 [issue #420](https://github.com/hrygo/heluo-forge/issues/420)。

### 分模块独立落地详设索引

| 模块 | 文档编号 | 落地详设文档 | 对应阶段与 Issue | 核心交付范围 |
| --- | --- | --- | --- | --- |
| 模块 1 | CORP-DSH-DESIGN-024A | [专家画像路由与不可变 ARM64 异构调度](delegra-k8s-scheduling/01-profile-routing-arm64.md) | 阶段一 · Delegra [#72](https://github.com/hrygo/Delegra/issues/72) / [#394](https://github.com/hrygo/heluo-forge/issues/394) | 17 镜像五档画像、`@sha256:` 强校验、ARM64 亲和、`/dev/shm`、两级优先级与预拉取 DaemonSet |
| 模块 2 | CORP-DSH-DESIGN-024B | [零信任单向预热池与 SandboxClaim v1beta1](delegra-k8s-scheduling/02-warm-pool-sandbox-claim.md) | 阶段三 · Delegra [#75](https://github.com/hrygo/Delegra/issues/75) / [#397](https://github.com/hrygo/heluo-forge/issues/397) | `agent-sandbox v1beta1` 单向 Warm Pool、强制 TTL 防泄露、KEDA 潮汐扩缩与 `stdin` `tmpfs` 令牌投递 |
| 模块 3 | CORP-DSH-DESIGN-024C | [集群级零信任代理与逐请求撤权控制面](delegra-k8s-scheduling/03-cluster-gateway-proxy-authz.md) | 阶段二 · Delegra [#73](https://github.com/hrygo/Delegra/issues/73) / [#395](https://github.com/hrygo/heluo-forge/issues/395) | `paperclip` 命名空间集群级 `delegra-gateway-proxy:18080`、`expert-gateway-authorization.ts`、`< 100ms` 撤权与 RFC 8693 演进 |
| 模块 4 | CORP-DSH-DESIGN-024D | [多租户 Cilium 硬隔离与 Kata-FC 内核隔离](delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md) | 阶段二/三 · Delegra [#74](https://github.com/hrygo/Delegra/issues/74) / [#76](https://github.com/hrygo/Delegra/issues/76) | 去 `*` DNS 收敛、`egressDeny`、`ndots: 2` + `nameError` 与 ARM64 裸金属 `kata-fc` |
| 模块 5 | CORP-DSH-DESIGN-024E | [SSA 动态调谐、Quota 核算与弹性反压](delegra-k8s-scheduling/05-ssa-quota-backpressure.md) | 阶段二/三 · Delegra [#74](https://github.com/hrygo/Delegra/issues/74) / [#76](https://github.com/hrygo/Delegra/issues/76) | `@kubernetes/client-node ^1.1.1` SSA、存量兼容 `paperclip-quota`、队列反压与 Karpenter 双池 |

## 1. 结论

专家智能体的执行面落在 Delegra 的 Kubernetes 沙箱插件。当前插件能完成「领用、起 Pod、exec、销毁」，但镜像、配额与凭据都绑定在适配器默认值和单次环境变量注入上：镜像写死 `imageOverride: null`，Pod 没有架构亲和与场景配额，provider Key 经 `envFrom` 进入 `agent` 容器。

V2.0.0 相对 V1.0.0 完成四项关键架构收敛：

1. **集群级零信任代理取代 Pod 内 Sidecar**：同 Pod 容器共享 Linux Network Namespace，K8s `NetworkPolicy` 与 Cilium 均无法按容器 UID 隔离，且 Warm Pool Pod 创建后 `envFrom`/`volumes` 不可变。代理升级为部署在 `paperclip` 命名空间的独立高可用服务 `delegra-gateway-proxy:18080`，沙箱通过 `pod-exec` `stdin` 获发 `tmpfs 0600` 短效令牌，同时在专家模式下显式禁用 `adapter-defaults.ts` 继承宿主机模型凭据环境变量。
2. **声明式 `SandboxClaim v1beta1` 取代手工打标领养**：上游 `kubernetes-sigs/agent-sandbox` 自 `v1.0.0` 起已移除 `v1alpha1` 并全面切至 `v1beta1`。Warm Pool 采用 `extensions.agents.x-k8s.io/v1beta1` 声明式 `SandboxClaim` 原子领养，强制设置 `spec.lifecycle.shutdownTime` 与 `DeleteForeground` 防泄露。
3. **Cilium DNS 去通配符与 ARM64 `kata-fc` 硬前提显式化**：彻底移除 `matchPattern: "*"`，通过 `--tofqdns-dns-reject-response-code=nameError` 与 `ndots: 2` 修复 Alpine/musl 断连；明确 ARM64 `kata-fc` 必须运行在裸金属（`/dev/kvm`、GICv3、4K 页、Linux `>= 6.1`）且阶段一采用 containerd `devmapper` 快照器。
4. **SSA 依赖升级与存量配额兼容**：`@kubernetes/client-node` 必须由 `^1.0.0` 升级至 `^1.1.1` 修复 SSA HTTP 400 缺陷；沿用存量资源名 `paperclip-quota` / `paperclip-limits` 并新增 `kata-fc` 裸金属 Karpenter `NodePool`。

四项能力由 `hrygo/Delegra` 的阶段 issue 承接：路由与画像为 #72，集群级代理与租户 SSA 调谐为 #73 与 #74，单向预热池与容量反压/Kata 隔离为 #75 与 #76；本仓库继续承担设计准入、按摘要选用与真实 Runner 验收。

## 2. 现状与工程断层

2026-11-21 对 Delegra `origin/deploy`（`2c54db803e`）静态读码，确认以下六处与生产调度要求不匹配。源码位置以该提交为准，集群侧行为待目标环境核验。

| 编号 | 维度 | 源码现状 | 生产风险 |
| --- | --- | --- | --- |
| G1 | 镜像路由 | `src/plugin.ts` 的领用路径固定 `resolveImage({ imageOverride: null }, ...)`；`src/image-allowlist.ts` 只做 glob 白名单匹配，未解析校验 `@sha256:` 摘要，`rewriteRegistry()` 以最后一个 `:` 切 tag 会误切带端口仓库地址。 | 无法按专家透传 17 个 ARM64 制品的 `name@digest`；私有库重写与摘要格式无校验。 |
| G2 | 冷启动 | 每次领用新建 Sandbox CR 并轮询 Ready（`timeoutMs: 120_000`、`pollMs: 2000`）；`src/lease-lifecycle.ts` 说明 Pod 不可原地重启。 | 交互式首次可见结果时间由调度与镜像拉取决定；失效租约只能冷重建。 |
| G3 | 架构与资源画像 | `src/sandbox-cr-builder.ts` 不写 `nodeSelector`；所有场景共用 `250m/512Mi` 到 `2C/4Gi` 默认配额，无 `/dev/shm`。 | `codex-java-21` 编译、`codex-test-web` Chromium 沙箱、`codex-office-zh` 并发导出缺资源；`codex-min` 配额浪费。 |
| G4 | 凭据边界 | `src/secret-manager.ts` 把 `BOOTSTRAP_TOKEN` 与适配器 `envKeys` 写入 per-run Secret 经 `envFrom` 注入 `agent` 容器；`adapter-defaults.ts` 会捕获宿主机模型 API Key。 | 工具子进程可读用户模型凭据；撤权或取消后存活进程仍可直连网关，撤销无法按请求收敛。 |
| G5 | 租户调谐 | `src/tenant-orchestrator.ts` 全部走 `createIgnoringAlreadyExists`（首次创建后冻结）；`LimitRange` 写死 `max: 4C / 8Gi`；`egressMode` 切换残留旧策略。 | 配额、LimitRange 与网络策略无法在线调整；两种 egress 策略叠加后取交集。 |
| G6 | 容量准入 | 领用前不读 `ResourceQuota.status.used/hard`，无池水位概念。 | 突发并发直接把 Sandbox CR 打给集群，触发 Quota 拒绝或 Pending 堆积；交互式与批量任务同队竞争。 |

## 3. 架构

四层职责：

1. **终端层（DSH）**：`@` 选人、个人启停校验与 IAM 委派提交，见[专家管理插件设计](plugins/forge-experts.md)。
2. **控制面（Delegra）**：持久队列与容量准入、专家画像路由（镜像摘要、资源画像、`runGeneration` 代次围栏）、新增 `expert-gateway-authorization.ts` 逐请求授权判定与 Redis Pub/Sub 实时撤权广播。
3. **执行面（Kubernetes ARM64）**：Sandbox CR 与 `SandboxClaim v1beta1` 生命周期、SSA 租户调谐、干净态单向预热池领用、单容器隔离执行 Pod（`agent`、UID `1000`、零用户凭据），统一通过 `paperclip` 命名空间集群级 `delegra-gateway-proxy:18080` 访问大模型，任务结束彻底销毁、绝不回池。
4. **企业边界**：`delegra-gateway-proxy` 经 Cilium FQDN 白名单访问企业 AI 网关，网关按发起用户鉴权与计量；沙箱 Pod 由 Cilium `egressDeny` 彻底封堵 IMDS 与直连 AI 网关。

```mermaid
flowchart LR
    subgraph 终端层
      DSH[DSH 插件<br/>@ 选人与委派]
    end
    subgraph 控制面
      Q[持久队列<br/>容量准入与反压]
      R[画像路由<br/>name@digest 与资源画像]
      A[expert-gateway-authorization<br/>逐请求授权与 Redis 撤权]
    end
    subgraph 执行面
      WP[SandboxWarmPool v1beta1<br/>干净态单向预热池]
      SB[Sandbox Pod<br/>单容器 agent 零用户凭据]
      PX[delegra-gateway-proxy<br/>paperclip 命名空间 :18080]
      T[租户资源<br/>SSA 调谐与 Cilium 硬隔离]
    end
    GW[企业 AI 网关]
    DSH --> Q --> R --> SB
    R --> WP --> SB
    SB --> PX --> GW
    PX <--> A
    T -. 配额与出站边界 .-> SB
```

## 4. 分层方案概览

### 4.1 专家画像驱动的路由与异构调度

详见独立落地详设：[模块 1：专家画像路由与不可变 ARM64 异构调度](delegra-k8s-scheduling/01-profile-routing-arm64.md)（CORP-DSH-DESIGN-024A）。

- 解除 `imageOverride: null` 硬编码，`image-allowlist.ts` 强制校验 `@sha256:` 不可变摘要并修复 `rewriteRegistry()` 带端口仓库截断缺陷；
- `sandbox-cr-builder.ts` 注入 `kubernetes.io/arch: arm64` 与五档画像（`light`、`build`、`browser`、`office`、`load`），保留现有 `agent` 容器名、UID `1000`、`tini` 与可写非 root `$HOME` 及 `.cache` 挂载基线；
- 阶段一 `runc` 模式下 `codex-test-web` 严禁无条件启用 `--no-sandbox`（仅在模块 4 `kata-fc` 下受控开启）；
- 两级 `PriorityClass`（`paperclip-expert-interactive` / `paperclip-expert-batch`）+ 70% 封顶 `paperclip-interactive-cap` 防批处理饥饿，配合 `codex-min` 公共父层预拉取 DaemonSet。

### 4.2 零信任单向预热池与 SandboxClaim v1beta1

详见独立落地详设：[模块 2：零信任单向预热池与 SandboxClaim v1beta1](delegra-k8s-scheduling/02-warm-pool-sandbox-claim.md)（CORP-DSH-DESIGN-024B）。

- 升级至 `kubernetes-sigs/agent-sandbox` `v1beta1`（`v1.0.12`），使用 `SandboxTemplate` + `SandboxWarmPool` + 声明式 `SandboxClaim` 原子领养，从 `claim.status.sandbox.name` 读取真实 Pod 名称；
- 强制配置 `spec.lifecycle.shutdownTime` + `shutdownPolicy: DeleteForeground` 防控制面崩溃泄露；Watch 校验 `observedGeneration >= metadata.generation` 并执行二次 Pod `GET`（`phase=Running && restartCount===0`）防 CrashLoop 假就绪；
- 严禁回池复用；短效代理令牌经 `pod-exec` `stdin` 原子写入 `/run/delegra-auth/lease-token`（`tmpfs 0600`），不经过 `etcd` 与环境变量；
- 通过 KEDA `ScaledObject`（工作日 Cron + Prometheus 触发器 + 非高峰 `minReplicaCount: 0`）与 `priorityClassName: paperclip-warm-pool` 子配额实现弹性与成本平衡。

### 4.3 集群级零信任代理、Cilium 硬隔离与 Kata-FC 内核隔离

详见独立落地详设：[模块 3：集群级零信任代理与逐请求撤权控制面](delegra-k8s-scheduling/03-cluster-gateway-proxy-authz.md)（CORP-DSH-DESIGN-024C）与 [模块 4：多租户 Cilium 硬隔离与 Kata-FC 内核隔离](delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md)（CORP-DSH-DESIGN-024D）。

- `delegra-gateway-proxy` 以 PSS `restricted` 3–20 副本高可用部署在 `paperclip` 命名空间（端口 `18080`），定制 Undici `headersTimeout: 0 / bodyTimeout: 0`、`15s` SSE 心跳、`16MiB` 请求体上限前置校验 `allowed_models` 与零正文审计；
- 控制面新增 `server/src/services/native-runtime/expert-gateway-authorization.ts`，提供单调 `current_gateway_generation` 围栏、5 大拒绝码、服务间双向认证（Projected SA JWT + mTLS）及 Redis Pub/Sub `< 100ms` 在途流斩断；支持向 AIGS（RFC 8693 `sub`/`act`）四阶段零侵入演进；
- Cilium 移除 `matchPattern: "*"`，开启 `--tofqdns-dns-reject-response-code=nameError` + `ndots: 2`，`egressDeny` 封堵 IMDS 与跨租户沙箱 Pod，`paperclip-egress-allow` 放行代理 `:18080` 与回调 `:3100`，动态域名 DNS 与 `toFQDNs` 合并至 `paperclip-egress-fqdn` 原子下发；
- C3/C4 高敏任务与 `codex-test-web` 强制调度至 ARM64 裸金属 `kata-fc`（`/dev/kvm`、GICv3、4K 页、Linux `>= 6.1`、containerd `devmapper` `10GB`、`requests==limits` + `memory_offset >= 512Mi`）。

### 4.4 SSA 动态调谐、Quota 核算与弹性反压

详见独立落地详设：[模块 5：SSA 动态调谐、Quota 核算与弹性反压](delegra-k8s-scheduling/05-ssa-quota-backpressure.md)（CORP-DSH-DESIGN-024E）。

- 升级 `@kubernetes/client-node` 至 `^1.1.1`，在 `kube-client.ts` 扩展 `object: KubernetesObjectApi` 实现全量租户资源 SSA 调谐，沿用存量资源名 `paperclip-quota` / `paperclip-limits`（保留 `min` 约束）；`standard <-> cilium` 切换严格先增后删；
- 建立 Small（`48Gi/92Gi`, 24 pods）、Medium（`148Gi/280Gi`, 56 pods）、Large（`368Gi/680Gi`, 115 pods）三档租户配额及 Warm Pool 专用 `PriorityClass` 子配额（占比 `<= 25%`）；
- 派发前执行三级容量探测（Warm Pool 槽位 → Quota 净余量扣减 `inFlightReserved` → 集群 `Unschedulable` 水位），超限时进入带老化评分的队列反压并向 DSH 推送 `status: "queued"`；
- 部署 Karpenter v1 常规 ARM64 与 `expert-sandbox-kata-fc-arm64` 裸金属双 `NodePool`，叠加低优先级 Overprovisioning Pause Pod（`value: -10`）消除冷扩滞后。

## 5. 分阶段实施与验收

| 阶段 | 跨仓库 issue | 对应详设模块 | 阶段验收判据 |
| --- | --- | --- | --- |
| 阶段一 | Delegra [#72](https://github.com/hrygo/Delegra/issues/72) | [模块 1](delegra-k8s-scheduling/01-profile-routing-arm64.md) | 同一入口按 `name@digest` 分别调度 `codex-min` 与 `codex-java-21` 到原生 ARM64 节点；错误摘要、错误平台与非白名单镜像在创建 CR 前失败；[#394](https://github.com/hrygo/heluo-forge/issues/394) 验收通过 |
| 阶段二 | Delegra [#73](https://github.com/hrygo/Delegra/issues/73)、[#74](https://github.com/hrygo/Delegra/issues/74) | [模块 3](delegra-k8s-scheduling/03-cluster-gateway-proxy-authz.md)、[模块 4](delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md)、[模块 5](delegra-k8s-scheduling/05-ssa-quota-backpressure.md) | 集群级代理零用户凭据、两用户并发零串扰、撤权 `< 100ms` 斩断在途流且网关零入站；SSA 与 Cilium 零断流切换通过；[#395](https://github.com/hrygo/heluo-forge/issues/395) 验收通过 |
| 阶段三 | Delegra [#75](https://github.com/hrygo/Delegra/issues/75)、[#76](https://github.com/hrygo/Delegra/issues/76) | [模块 2](delegra-k8s-scheduling/02-warm-pool-sandbox-claim.md)、[模块 4](delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md)、[模块 5](delegra-k8s-scheduling/05-ssa-quota-backpressure.md) | `v1beta1` 热池命中耗时以实测记录（目标 `< 500ms`）；压测下无失控 Pending；脏 Pod 零复用、TTL 零泄露、`kata-fc` 渗透测试全过；[#397](https://github.com/hrygo/heluo-forge/issues/397) 验收通过 |

本仓库的实测证据登记在 `docs/design/verification/delegra-k8s-scheduling.md`（待阶段一开始取证后建立）；证据缺失的能力不得改写为「可用」。

## 6. 红线与治理

- **禁止脏 Pod 回池**：已领养执行或注入令牌的 Pod 必须随 `SandboxClaim` 彻底销毁，严禁清理后回放。
- **拒绝浮动镜像标签**：K8s 侧严禁 `:latest` 或无摘要 tag，所有调度锁定经过 `expert-images-release.json` 核验的 `name@sha256:`。
- **凭据不落盘且不进环境变量**：短效代理令牌仅经 `stdin` 写入 `/run/delegra-auth/lease-token`（`tmpfs 0600`），真实上游 API Key 永不离开 `paperclip` 命名空间。
- **`job` 模式仅作降级兜底**：`batch/v1` Job 不支持多命令 exec 与原生流式文件同步，主路线锁定 `sandbox-cr`。
- **门禁只能收紧**：`requireImmutableDigest`、`egressMode: "cilium"`、`kata-fc` 密级路由缺失时一律 fail closed。

## 7. 证据边界与待确认

已核验：

- Delegra `origin/deploy` 提交 `2c54db803edcb118c56660cd883c9306e218d1cc4` 中 §2 六项源码形态（静态读码，2026-11-21）。
- 17 个 ARM64 镜像已按 `expert-images-v1.0.0` 发布并登记摘要，见[运行时镜像实测记录](verification/delegra-runtime-images.md)。

未核验（均需按阶段实测取证后关闭）：

| 待确认事项 | 回答责任方 | 截止门禁 |
| --- | --- | --- |
| 目标集群版本、ARM64 常规与裸金属节点池形态（GICv3 / 4K 页）及 Karpenter v1 权限 | 平台运维 | 阶段一实施前 |
| `kubernetes-sigs/agent-sandbox` 升级至 `v1.0.12`（`v1beta1`）与 KEDA 集群安装窗口 | 平台运维 | 阶段三实施前 |
| Cilium 版本、DNS Proxy 调优参数及企业网关 FQDN 的实际放行结果 | 平台运维与网络 | 阶段二实施前 |
| `delegra-gateway-proxy` 镜像构建、签名及按摘要发布流水线 | Delegra | 阶段二实施前 |
| 企业网关对逐请求鉴权、代次围栏及后续 RFC 8693 令牌交换的认可方式 | 网关团队 | 阶段二验收前 |
| C3/C4 数据密级判定口径与 `kata-fc` 裸金属容量预算 | 安全与平台运维 | 阶段三验收前 |
