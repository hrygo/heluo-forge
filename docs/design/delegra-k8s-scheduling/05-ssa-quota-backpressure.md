# 模块 5：SSA 租户动态调谐、精细化 Quota 核算与集群水位弹性反压落地详设

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024E |
| 文档名称 | 模块 5：SSA 租户动态调谐、精细化 Quota 核算与集群水位弹性反压落地详设 |
| 版本 | V1.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 8 项 SSA、Quota 反压与 Karpenter 弹性验收用例（T5-01 ～ T5-08）全过前不进入生产 |

> 所属主设计：[Delegra 专家智能体 Kubernetes 智能调度设计](../delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024 V2.0.0） · 对应阶段：阶段二 / 阶段三（Delegra [#74](https://github.com/hrygo/Delegra/issues/74) / [#76](https://github.com/hrygo/Delegra/issues/76)）。

## 1. `@kubernetes/client-node` v1.x SSA 工程改造

- **强制依赖升级**：将 `packages/plugins/sandbox-providers/kubernetes/package.json` 的 `@kubernetes/client-node` 从 `^1.0.0` 升级至 `^1.1.1`，修复 1.0.0 自定义 Patch 中间件 SSA HTTP 400 缺陷（[kubernetes-client/javascript #2160](https://github.com/kubernetes-client/javascript/issues/2160)）。
- **SSA 调用契约**（[Kubernetes SSA](https://kubernetes.io/docs/reference/using-api/server-side-apply/)、[K8s JS 文档](https://context7.com/websites/deepwiki_kubernetes-client_javascript)）：在 `kube-client.ts` 新增 `object: KubernetesObjectApi`，剥离 `managedFields`/`resourceVersion`/`status`，统一使用 `fieldManager = "paperclip-k8s-plugin"` 与 `force: true`（仅接管声明字段，无损保留第三方运维注解）；RBAC 需同时具备 `create` 与 `patch`。

```ts
import { KubeConfig, KubernetesObject, KubernetesObjectApi, PatchStrategy } from "@kubernetes/client-node";

export interface KubeClients {
  // ... existing clients
  object: KubernetesObjectApi;
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  return {
    // ... existing initializations
    object: KubernetesObjectApi.makeApiClient(kc),
  };
}

const FIELD_MANAGER = "paperclip-k8s-plugin";

export function sanitizeForSSA<T extends KubernetesObject>(obj: T): T {
  const clone = structuredClone(obj);
  if (clone.metadata) {
    delete clone.metadata.managedFields;
    delete clone.metadata.resourceVersion;
    delete clone.metadata.uid;
    delete clone.metadata.creationTimestamp;
    delete clone.metadata.generation;
  }
  delete (clone as Record<string, unknown>).status;
  return clone;
}

export async function applyResourceSSA<T extends KubernetesObject>(
  objectApi: KubernetesObjectApi,
  resource: T,
  options?: { dryRun?: "All" },
): Promise<T> {
  const sanitized = sanitizeForSSA(resource);
  const res = await objectApi.patch(
    sanitized,
    undefined,
    options?.dryRun,
    FIELD_MANAGER,
    true,
    PatchStrategy.ServerSideApply,
  );
  return res as T;
}
```

- **`tenant-orchestrator.ts` 并发合并与无损切换**：5 分钟规范化 SHA-256 指纹缓存 + 命名空间级 in-flight 并发合并锁；`standard <-> cilium` 切换严格遵循**先增后删**（切至 `cilium` 时先 SSA 下发全套 Cilium 策略，确认生效后再 `deleteIfExists` 清理原生 `paperclip-egress-allow` 与原生 `paperclip-deny-all`，404 幂等）。

## 2. 精细化多租户 Quota 与 LimitRange 核算模型

参考 [Kubernetes Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/) 与 [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)，综合 5 类画像 + Warm Pool 副本 + `kata-fc` Pod Overhead + 20% 余量，核定三档标准配额（资源名严格沿用现有 `paperclip-quota` 与 `paperclip-limits`，防止存量租户产生双配额交集死锁）：

| 租户档位 | `requests.memory` | `limits.memory` | `requests.cpu` | `limits.cpu` | `pods` 上限 | Warm Pool 子配额（`<= 25%`） |
| --- | --- | --- | --- | --- | --- | --- |
| **Small** | `48Gi` | `92Gi` | `20` | `56` | `24` | `6 pods / 10Gi req / 20Gi lim` |
| **Medium** | `148Gi` | `280Gi` | `64` | `176` | `56` | `14 pods / 32Gi req / 64Gi lim` |
| **Large** | `368Gi` | `680Gi` | `160` | `420` | `115` | `28 pods / 80Gi req / 160Gi lim` |

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: paperclip-quota
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  hard:
    requests.cpu: "64"
    limits.cpu: "176"
    requests.memory: 148Gi
    limits.memory: 280Gi
    requests.ephemeral-storage: 200Gi
    limits.ephemeral-storage: 400Gi
    pods: "56"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: paperclip-warm-pool-quota
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - paperclip-warm-pool
  hard:
    pods: "14"
    requests.memory: 32Gi
    limits.memory: 64Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: paperclip-limits
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: "250m"
        memory: "512Mi"
      default:
        cpu: "1000m"
        memory: "2Gi"
      min:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "4"
        memory: "8Gi"
        ephemeral-storage: "20Gi"
```

## 3. 派发前三级容量探测与队列弹性反压

- **三级探测（`capacity-admission.ts`）**：① Warm Pool `readyReplicas > 0` 直接放行；② 计算 `paperclip-quota` 净余量 `quantityToScalar(hard) - quantityToScalar(used) - inFlightReserved(namespace)`（预扣 TTL 15s 防超发）；③ 检查 ARM64 节点池是否存在 `>= 5` 个持续超过 30s 的 `Unschedulable` Pod。
- **队列反压（`native-provider-capacity-retry.ts`）**：采用优先级 + 老化评分 `Dispatch_Score = Base_Priority_Weight + (Wait_Seconds * 0.5)` 与带抖动指数退避，向 DSH 实时推送 `status: "queued"`。

## 4. ARM64 弹性扩容：Karpenter v1 双节点池与 Overprovisioning

参考 [Karpenter NodePools](https://karpenter.sh/docs/concepts/nodepools/)、[NodeClasses](https://karpenter.sh/docs/concepts/nodeclasses/)、[Disruption](https://karpenter.sh/docs/concepts/disruption/) 与 [AWS EKS Over-Provisioning](https://aws.amazon.com/blogs/containers/eliminate-kubernetes-node-scaling-lag-with-pod-priority-and-over-provisioning/)，同时部署常规 Graviton 3/4 池与 `kata-fc` 裸金属池（对接[模块 4](04-cilium-isolation-kata-fc.md)），并常驻低优先级 Pause Pod 消除新节点 45–60 秒拉起延迟：

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: expert-sandbox-arm64
spec:
  template:
    metadata:
      labels:
        paperclip.io/pool: expert-sandbox
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: expert-sandbox-al2023-arm64
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["6"]
      expireAfter: 72h
  limits:
    cpu: "1000"
    memory: 2000Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: expert-sandbox-kata-fc-arm64
spec:
  template:
    metadata:
      labels:
        paperclip.io/pool: expert-sandbox-kata-fc
        paperclip.io/runtime: kata-fc
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: expert-sandbox-kata-fc-al2023-arm64
      taints:
        - key: paperclip.io/isolation
          value: kata-fc
          effect: NoSchedule
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["6"]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["metal"] # 裸金属暴露 /dev/kvm 与 GICv3
      expireAfter: 72h
  limits:
    cpu: "500"
    memory: 1000Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
---
apiVersion: karpenter.sh/v1
kind: EC2NodeClass
metadata:
  name: expert-sandbox-al2023-arm64
spec:
  amiSelectorTerms:
    - alias: ${VERIFIED_AL2023_AMI_ALIAS} # 由 GitOps/Helm 注入经运维验收的 4K 页 ARM64 AMI 别名
  role: KarpenterNodeRole-delegra-prod
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: delegra-prod
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: delegra-prod
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: paperclip-overprovisioning
value: -10
globalDefault: false
preemptionPolicy: Never
description: "低优先级算力占位 Pod，仅用于触发 Karpenter 提前扩容"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: arm64-capacity-buffer
  namespace: paperclip
spec:
  replicas: 2
  selector:
    matchLabels:
      app: arm64-capacity-buffer
  template:
    metadata:
      labels:
        app: arm64-capacity-buffer
    spec:
      priorityClassName: paperclip-overprovisioning
      terminationGracePeriodSeconds: 0
      nodeSelector:
        kubernetes.io/arch: arm64
        paperclip.io/pool: expert-sandbox
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          resources:
            requests: { cpu: "4", memory: "8Gi" }
```

## 5. 必过验收测试清单（8 项）

| 编号 | 测试项 | 验证方法 | 通过标准 |
| --- | --- | --- | --- |
| T5-01 | SSA 第三方注解无损保留 | 为 `paperclip-quota` 添加 `ops.example/owner: finops` 后触发 SSA 调谐 | Quota 收敛且第三方注解完整保留 |
| T5-02 | 5 分钟指纹缓存与并发合并 | 1s 内并发触发 30 次同租户调谐 | API Server 仅收到 1 次 SSA PATCH，5 分钟内命中缓存 0 写入 |
| T5-03 | `standard <-> cilium` 零断流 | 持续发送合法出口与 IMDS 探测同时切换 `egressMode` | 合法流量 0 丢包，IMDS 全程 100% 阻断，旧策略无残留 |
| T5-04 | Warm Pool 子配额防挤占 | 将 Small 租户 Warm Pool 副本调大至 20 | 仅创建 6 个 Warm Pool Pod，其余被子配额拦截；正式任务正常启动 |
| T5-05 | 准入反压与 DSH `queued` | 占满 Small 租户 `48Gi` 后继续提交 5 个 Run | 零 `Forbidden` 风暴，DSH 收到 `queued` 并按老化评分依次出队 |
| T5-06 | Overprovisioning 毫秒级抢占 | 仅剩 Pause Pod 占位时提交 `build` 任务 | `< 1s` 抢占 Pause Pod 绑定调度，Karpenter 后台异步补齐节点 |
| T5-07 | `do-not-disrupt` 防误杀 | 节点利用率 `< 30%` 时观察 Consolidation | 带注解的运行中沙箱节点不被回收，销毁后 5m 内自动缩容 |
| T5-08 | `al2023` IMDSv2 单跳验证 | 临时撤除 Cilium 后在容器内访问 `169.254.169.254` | `httpPutResponseHopLimit: 1` 在宿主机底层仍硬阻断 |
