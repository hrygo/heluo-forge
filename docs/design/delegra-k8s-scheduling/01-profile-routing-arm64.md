# 模块 1：专家画像路由与不可变 ARM64 异构调度落地详设

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024A |
| 文档名称 | 模块 1：专家画像路由与不可变 ARM64 异构调度落地详设 |
| 版本 | V1.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 阶段一单测与集群集成验收（I-01 ～ I-05）全过前不进入生产 |

> 所属主设计：[Delegra 专家智能体 Kubernetes 智能调度设计](../delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024 V2.0.0） · 对应阶段：阶段一（Delegra [#72](https://github.com/hrygo/Delegra/issues/72) / heluo-forge [#394](https://github.com/hrygo/heluo-forge/issues/394)） · 核心改造范围：`packages/plugins/sandbox-providers/kubernetes/src/`（`image-allowlist.ts`、`sandbox-cr-builder.ts`、`plugin.ts`、`types.ts`、`utils.ts`）与 `packages/plugins/sdk/src/protocol.ts`。

## 1. 模块定位与边界

本模块直接修复现状源码中的 **G1（镜像路由硬编码）** 与 **G3（架构亲和与资源画像缺失）**：

- **G1 修复**：解除 `src/plugin.ts` 中 `onEnvironmentAcquireLease` 写死 `resolveImage({ imageOverride: null }, ...)` 的限制，在 `src/image-allowlist.ts` 引入不可变 `@sha256:` 摘要强校验与 `rewriteRegistry` 摘要保留修复，并记录 `expectedPlatformDigest` 与 Ready 后真实 `imageID`。
- **G3 修复**：在 `src/sandbox-cr-builder.ts` 强制注入原生 ARM64 节点选择器（`kubernetes.io/arch: arm64`），建立五档场景资源画像（CPU/Memory、`emptyDir` 容量、`/dev/shm` 内存盘）与两级 `PriorityClass` 透传。
- **CRD 版本衔接与边界**：本模块锁定 `sandbox-cr` 为主路线（`batch/v1` Job 仅作降级兜底）。现有 `sandbox-cr-builder.ts` 仍使用 `agents.x-k8s.io/v1alpha1`，阶段一 `#394` 通过配置项 `sandboxApiVersion`（默认兼容集群现有版本）平滑承接，待阶段三集群升级至 `agent-sandbox >= v1.0.12` 后统一无痛切换至[模块 2](02-warm-pool-sandbox-claim.md)的 `v1beta1`。

### 1.1 17 个 ARM64 运行时镜像与五档资源画像映射基线

| 画像枚举 | 覆盖镜像 | Requests CPU/Mem | Limits CPU/Mem | `/workspace` | `/tmp` | `/dev/shm` | 专项调优 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `light` | `codex-min`、`codex-ops-diag`、`codex-ops-k8s`、`codex-ops-iac`、`codex-sql`、`codex-test-api`（6 个） | `250m / 512Mi` | `1 / 2Gi` | `8Gi` | `2Gi` | 无 | 高密度混部；`codex-min` 作为 DaemonSet 公共父层预拉取锚点 |
| `build` | `codex-java-8/11/17/21/25`、`codex-node`、`codex-go`、`codex-dotnet-10`（8 个） | `1 / 2Gi` | `4 / 6Gi` | `16Gi` | `4Gi` | 无 | 大体积构建缓存空间，防止编译撑爆 `/workspace` |
| `browser` | `codex-test-web`（1 个） | `1 / 2Gi` | `4 / 8Gi` | `8Gi` | `2Gi` | `1Gi`（`medium: Memory`） | 挂载内存盘至 `/dev/shm`；计入 `8Gi` 内存限额内，预留 `7Gi` 给 Chromium 渲染进程 |
| `office` | `codex-office-zh`（1 个） | `500m / 1Gi` | `2 / 4Gi` | `8Gi` | `4Gi` | 无 | 独立 `/tmp`（`4Gi`）+ 运行级 `$HOME` 隔离 LibreOffice 并发导出 PDF 锁 |
| `load` | `codex-test-load`（1 个） | `500m / 1Gi` | `2 / 4Gi` | `8Gi` | `2Gi` | 无 | 配合任务级 `networkEgress` 收敛压测目标白名单 |

**通用基础挂载与运行时基线（对齐现有 `sandbox-cr-builder.ts`）**：所有五档画像均强制保留：容器名 `agent`、UID/GID/fsGroup `1000`、`fsGroupChangePolicy: OnRootMismatch`、`/usr/bin/tini --` 作为 PID 1、可写非 root `$HOME` 环境变量及对应的 `emptyDir` 挂载（`1Gi` 主目录卷 + `1Gi` `.cache` 子目录卷，具体路径沿用 `sandbox-cr-builder.ts` 常量定义），防止只读根文件系统下 Agent 静默退出；其中 `office` 画像的运行级 `$HOME` 隔离在该主目录卷下按 `runId` 隔离。

## 2. 端到端数据流与 SDK/插件接口契约

调度链路：`DSH（@ 专家委派）` → `Delegra 控制面（查 expert-images-release.json 透传 imageOverride、platformDigest、resourceProfile、priorityClassName、agentId、runId）` → `K8s 插件 onEnvironmentAcquireLease` → `ARM64 Kubelet（命中 DaemonSet 预拉取公共父层）` → `onEnvironmentExecute 首次 Ready 后反查 readNamespacedPod 记录 nodeName 与 containerImageId 至 metadata.runtimeEvidence`。

```ts
export type ExpertResourceProfileName = "light" | "build" | "browser" | "office" | "load";

export interface ExpertRuntimeAcquireHints {
  imageOverride?: string | null;
  platformDigest?: string | null;
  resourceProfile?: ExpertResourceProfileName | null;
  priorityClassName?: string | null;
  runGeneration?: number | null;
}

export interface NormalizedExpertRuntimeHints {
  imageOverride: string | null;
  platformDigest: string | null;
  resourceProfile: ExpertResourceProfileName | null;
  priorityClassName: string | null;
  runGeneration: number | null;
}
```

## 3. 逐文件代码改造设计

### 3.1 `src/image-allowlist.ts`：强摘要校验与 `rewriteRegistry` 修复

参考 [Kubernetes Images 官方文档](https://kubernetes.io/docs/concepts/containers/images/) 与 [GKE 容器镜像摘要概念](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/about-container-images)：

- 新增 `parseDigestImageRef(image)`：正则校验 `^([^@\s]+)@(sha256:[a-f0-9]{64})$`，仅在最后一个 `/` 之后检查 `:`，避免把带端口私有仓库（如 `registry.example:8443/delegra`）的 `:8443` 误判为 tag。
- 修复 `rewriteRegistry(image, imageRegistry)`：优先按 `@` 分割完整保留 `@sha256:...` 不可变摘要，再按最后 `/` 后的 `:` 分离可选 tag，重写目标仓库前缀。
- 新增 `resolveImageDetailed(target, defaults, config)`（保留旧 `resolveImage` 兼容）：当 `requireDigest: true` 时拒绝任何浮动 tag 并抛出 `ImageDigestRequiredError`；校验 `platformDigest` 格式非法抛出 `InvalidPlatformDigestError`。

```ts
export interface ResolvedImageRef {
  image: string;
  digest: string | null;
  expectedPlatformDigest: string | null;
  source: "override" | "default";
}

export function parseDigestImageRef(image: string): {
  repository: string;
  tag: string | null;
  digest: string;
} | null;

export function rewriteRegistry(image: string, imageRegistry?: string): string;
export function resolveImageDetailed(
  target: { imageOverride?: string | null; platformDigest?: string | null },
  defaults: { runtimeImage: string },
  config: { imageAllowList: string[]; imageRegistry?: string; requireDigest?: boolean },
): ResolvedImageRef;
```

### 3.2 `src/sandbox-cr-builder.ts`：五档画像、ARM64 亲和与 `/dev/shm`

- Kubelet 自动为节点打上标准标签 `kubernetes.io/arch`（[Well-Known Labels](https://kubernetes.io/docs/reference/labels-annotations-taints/)、[Node Labels](https://kubernetes.io/docs/reference/node/node-labels/)），在 `podTemplate.spec` 注入 `nodeSelector: { "kubernetes.io/arch": "arm64" }`（[Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)）。
- 容器默认 `/dev/shm` 仅 64MiB，Playwright Chromium 极易崩溃（[Playwright Docker 文档](https://playwright.dev/docs/docker)）。严禁 `--ipc=host`，标准解法为挂载 `emptyDir: { medium: Memory, sizeLimit: "1Gi" }` 至 `/dev/shm`（[Kubernetes Volume Types](https://kubernetes.io/docs/reference/storage/volume-types/)、[Resource Management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)），并避免无条件加 `--disable-dev-shm-usage` 导致 `/tmp` 文件映射内存增长（[chromedp #1627](https://github.com/chromedp/chromedp/issues/1627)）。

```ts
export interface ResolvedPodSizing {
  profile: ExpertResourceProfileName;
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
  workspaceSizeLimit: string;
  tmpSizeLimit: string;
  shmSizeLimit?: string;
}

export function inferResourceProfileFromImage(image: string): ExpertResourceProfileName;
export function resolvePodSizing(
  explicitProfile: ExpertResourceProfileName | null | undefined,
  image: string,
): ResolvedPodSizing;
```

### 3.3 `src/types.ts` 与 `src/plugin.ts`：透传、标签修复与 Ready 后取证

- `src/types.ts`：扩展 `kubernetesProviderConfigSchema`，新增 `requireImmutableDigest`（默认 `false`）、`nodeArch`（`"arm64" | "amd64" | "any"`）、`priorityClassName`、`sandboxApiVersion`；在 `KubernetesLeaseMetadata` 新增 `resolvedImage`、`resolvedImageDigest`、`expectedPlatformDigest`、`resourceProfile`、`nodeArch`、`priorityClassName`、`runtimeEvidence`。
- `src/plugin.ts`：`onEnvironmentAcquireLease` 在创建任何 Secret/CR 前完成 `resolveImageDetailed` 强校验；修复 `paperclipLabels` 中 `agentId: params.agentId ?? params.runId` 并追加 `paperclip.io/profile`。
- **CRI `imageID` 差异处理**（[Kubernetes Issue #115199](https://github.com/kubernetes/kubernetes/issues/115199)、[Issue #95968](https://github.com/kubernetes/kubernetes/issues/95968)）：将 `digestVerification` 分为 `exact_index_match`、`exact_platform_match`、`cri_config_id_only`（仅非生产放行记告警）与 `mismatch`（`requireImmutableDigest: true` 时拒绝执行并触发回收）。

## 4. 生产级 Kubernetes YAML 清单

### 4.1 两级 `PriorityClass` 与反饥饿 `ResourceQuota`

依据 [Kubernetes Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/) 与 [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)：Small / Medium / Large 三档租户的 `paperclip-interactive-cap` 均按[模块 5](05-ssa-quota-backpressure.md)核定的对应档位总配额 × 70% 自动派生计算（以下以 Medium 档 `paperclip-acme` 为例）：

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: paperclip-expert-interactive
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "High-priority class for interactive DSH @expert delegations and warm-pool claims."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: paperclip-expert-batch
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
value: 10000
globalDefault: false
preemptionPolicy: Never
description: "Lower-priority class for asynchronous/batch expert runs; never preempts interactive runs."
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: paperclip-interactive-cap
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  hard:
    pods: "39"
    requests.cpu: "45"
    requests.memory: "104Gi"
    limits.cpu: "123"
    limits.memory: "196Gi"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - paperclip-expert-interactive
```

### 4.2 ARM64 公共父层预拉取 DaemonSet（含滚动策略）

依据 [Kubernetes DaemonSet 文档](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/) 与 [DaemonSet Rolling Update](https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/)：

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: paperclip-expert-image-prepuller
  namespace: paperclip
  labels:
    app: paperclip-expert-image-prepuller
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  revisionHistoryLimit: 5
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: "25%"
      maxSurge: 0
  selector:
    matchLabels:
      app: paperclip-expert-image-prepuller
  template:
    metadata:
      labels:
        app: paperclip-expert-image-prepuller
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      priorityClassName: paperclip-expert-batch
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 5
      imagePullSecrets:
        - name: corp-registry-pull-secret
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        - name: prepull-codex-min
          image: ghcr.io/hrygo/delegra/codex-min@sha256:REPLACE_WITH_VERIFIED_DIGEST
          imagePullPolicy: IfNotPresent
          command: ["/bin/true"]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { cpu: 50m, memory: 64Mi }
        - name: prepull-codex-java-21
          image: ghcr.io/hrygo/delegra/codex-java-21@sha256:REPLACE_WITH_VERIFIED_DIGEST
          imagePullPolicy: IfNotPresent
          command: ["/bin/true"]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { cpu: 50m, memory: 64Mi }
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests: { cpu: 5m, memory: 16Mi }
            limits: { cpu: 10m, memory: 32Mi }
```

### 4.3 节点磁盘 GC 与并行拉取配合（`KubeletConfiguration`）

依据 [Kubernetes Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/) 与 [Kubelet Configuration (v1beta1)](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)：ARM64 节点独立 imagefs 建议 `>= 200GiB`，配置 `imageGCHighThresholdPercent: 80`、`imageGCLowThresholdPercent: 65`、`imageMinimumGCAge: "15m"`、`imageMaximumGCAge: "0s"`、`serializeImagePulls: false`、`maxParallelImagePulls: 3`、`localStorageCapacityIsolation: true`、`nodeStatusMaxImages: 64`。

## 5. 故障模式、回退方案与边界异常矩阵

| 故障模式 | 触发根因 | 自动处置与兜底 | 人工介入 / 回退 |
| --- | --- | --- | --- |
| 浮动 Tag 或非法摘要注入 | `requireImmutableDigest: true` 时传入 `:latest` 或截断 sha256 | 创建 Secret/CR 前直接抛错拒绝，集群零残留 | 核查 `expert-images-release.json` 重新发布 |
| 运行时 `imageID` 摘要错配 | Registry 篡改或本地 Kind 返回裸 config ID | `mismatch` 时拒绝执行并销毁租约；`cri_config_id_only` 仅非生产放行 | 生产 containerd 出现 `mismatch` 冻结版本并排查 |
| ARM64 节点容量不足 | 集群无 arm64 节点或池资源耗尽 | 超时后清理未就绪 CR 返回可重试错误；严禁静默漂移至 amd64 | 扩容 ARM64 节点池 |
| `codex-test-web` `/dev/shm` 或内存 OOM | Chromium 耗尽 `1Gi /dev/shm` 或 `8Gi limits.memory` | 上报 OOM 诊断码并销毁租约 | 上调 `browser` 画像至 `10Gi / shmSizeLimit: 2Gi` |
| 非 root Chromium Seccomp 阻断 | UID `1000` + `RuntimeDefault` 阻断 userns `clone/unshare` | 阶段一 `runc` 模式下**严禁**无条件启用 `--no-sandbox`；通过节点分发最小增补 seccomp profile 放行 | 仅在阶段二/三启用[模块 4](04-cilium-isolation-kata-fc.md) `kata-fc` 硬隔离后，才允许受控开启 `--no-sandbox` |
| 高优抢占风暴导致 Batch 饥饿 | 交互突发反复驱逐 batch Pod | `paperclip-interactive-cap` 封顶 70%，超额 403 退回控制面排队 | 调大租户配额或触发 ARM64 扩容 |
| DaemonSet 预拉取与节点 GC 抖动 | 节点磁盘超 80% 或误设短 `imageMaximumGCAge` | 保持 `imageMaximumGCAge: "0s"` + `>= 200GiB` 数据盘 + `maxUnavailable: 25%` | 缩减预拉取列表至仅保留 `codex-min` 公共父层 |

## 6. 单元测试与集群集成验收清单

- **单元测试（`pnpm test && pnpm typecheck`）**：
  - `test/unit/image-allowlist.test.ts`：不可变 `@sha256:` 白名单放行、`requireDigest: true` 拒绝浮动 tag、`rewriteRegistry` 带端口与保摘要、`platformDigest` 格式校验。
  - `test/unit/sandbox-cr-builder.test.ts`：`arm64` `nodeSelector` 注入、`browser` 自动挂载 `1Gi medium: Memory /dev/shm`、`build /workspace` 扩容至 `16Gi`、17 个镜像自动画像推断 100% 精确映射。
  - `test/unit/plugin.test.ts`：同入口连续切换 `codex-min` 与 `codex-java-21`、顶层字段与 `executionWorkspaceSettings.expertRuntime` 优先级、非法摘要快速失败零残留、`agentId` 标签修复、首次 Ready 后 `runtimeEvidence` 取证与 `mismatch` 阻断。
- **集群集成验收**：
  - **I-01 双镜像原生 ARM64 调度**：分别下发 `codex-min@sha256:...` 与 `codex-java-21@sha256:...`，校验 `uname -m == aarch64`、`java -version` 为 JDK 21、`runtimeEvidence` 命中 `exact_index_match` 或 `exact_platform_match`。
  - **I-02 合成 `/responses` + 工具执行 + 取消回收**：取消后 15s 内 Sandbox CR、Pod 与 Secret 彻底清除无孤儿。
  - **I-03 `codex-test-web` `/dev/shm` 冒烟**：`df -h /dev/shm` 为 `1.0G`、`id -u == 1000`，无头 Chromium 渲染截图成功无崩溃。
  - **I-04 负向拦截**：浮动 tag 在创建 CR 前拒绝；篡改摘要拉取失败自动回收；纯 amd64 镜像明确拒绝不漂移。
  - **I-05 预拉取 DaemonSet 与抢占反饥饿**：所有 ARM64 节点 `DESIRED == READY`；打满时 `interactive` 成功抢占 `batch` 且超出 70% 配额被 403 拦截。
