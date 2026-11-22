# 模块 2：零信任单向预热池与 SandboxClaim v1beta1 租约生命周期落地详设

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024B |
| 文档名称 | 模块 2：零信任单向预热池与 SandboxClaim v1beta1 租约生命周期落地详设 |
| 版本 | V1.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 阶段三 10 项负向安全与稳定性验收用例（T2-01 ～ T2-10）全过前不进入生产 |

> 所属主设计：[Delegra 专家智能体 Kubernetes 智能调度设计](../delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024 V2.0.0） · 对应阶段：阶段三（Delegra [#75](https://github.com/hrygo/Delegra/issues/75) / heluo-forge [#397](https://github.com/hrygo/heluo-forge/issues/397)）。

## 1. 模块定位与四大零信任铁律

本模块将高频专家智能体的冷启动耗时从 8–20 秒压缩至亚秒级（设计目标 `< 500ms` 领养就绪，以实测为准），同时严格执行四条零信任铁律：

1. **单向消费，绝不归还**：`SandboxWarmPool` 中的 Pod 被 `SandboxClaim` 领养并完成单次 Run 后必须强制销毁，严禁清理 `/workspace` 回池复用。
2. **声明式领养，严禁手工打标**：通过上游 [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox/releases) 的 `SandboxClaim` 控制器实现原子领养，严禁手工 `kubectl label`/`patch` 抢占。
3. **强制 TTL 租约防泄露**：每次创建 `SandboxClaim` 必须设置 `spec.lifecycle.shutdownTime` 与 `shutdownPolicy: DeleteForeground`，防御控制面崩溃导致的僵尸 Sandbox 永久泄露（[Issue #2051](https://github.com/kubernetes-sigs/agent-sandbox/issues/2051)、[Issue #463](https://github.com/kubernetes-sigs/agent-sandbox/issues/463)）。
4. **不可变 Pod 与 `tmpfs` 短效凭据投递**：Pod 创建后 `envFrom`/`volumes` 不可变（[Kubernetes Pods](https://kubernetes.io/docs/concepts/workloads/pods/)），短效代理令牌通过 `pod-exec` `stdin` 原子写入 `/run/delegra-auth/lease-token`（`tmpfs 0600`），避免出现在 `/proc/<pid>/environ`（[proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)）或 `etcd`（[Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)）。

## 2. 上游 agent-sandbox v1beta1 协议规范与关键变更

依据 [agent-sandbox Releases（v1.0.12）](https://github.com/kubernetes-sigs/agent-sandbox/releases)、[AGENTS.md](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/AGENTS.md)、[Roadmap](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/roadmap.md) 及 [GKE 官方安装指南](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox)：

- **全面切换至 `v1beta1`**：自 `v1.0.0` 起 `v1alpha1` 已移除，核心资源为 `agents.x-k8s.io/v1beta1`，扩展资源（`SandboxTemplate`、`SandboxWarmPool`、`SandboxClaim`）为 `extensions.agents.x-k8s.io/v1beta1`。
- **Pod 真实名称映射**：被领养 Pod 保留池生成时的 `Sandbox` 名称，**绝不等于** `claim.metadata.name`（[Quickstart](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/examples/quickstart/README.md)）。插件必须从 `claim.status.sandbox.name` 读取目标 Pod 名；若启用 `spec.service: true`，`SandboxWarmPool` 名称应控制在 32 字符以内防突破 63 字符 DNS 上限（v1.0.6 `#1475`）。
- **关键版本修复**：`v1.0.11`（`#2205`）要求 Watch 校验 `observedGeneration >= metadata.generation`；`v1.0.12`（`#2136`）新增 `spec.readinessGracePeriodSeconds`（最小 30s）；`/scale` 子资源（[Issue #290](https://github.com/kubernetes-sigs/agent-sandbox/issues/290)）支持 KEDA 扩缩；控制器 `--sandbox-warm-pool-max-batch-size`（[Configuration Docs](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/configuration.md)）防止扩容雪崩。

## 3. 生产级 CRD 与 YAML 清单（对齐 Delegra 现有源码基线）

### 3.1 `SandboxTemplate`

> 注：容器可写 `$HOME` 与 `.cache` 挂载路径严格沿用 `sandbox-cr-builder.ts` 中的非 root 主目录常量（以下 YAML 以 `/var/lib/paperclip` 示意）。

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: expert-light-codex-min-arm64
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
    paperclip.io/profile: light
spec:
  podTemplate:
    metadata:
      labels:
        paperclip.io/managed-by: paperclip-k8s-plugin
        paperclip.io/role: agent
        paperclip.io/profile: light
        paperclip.io/warm-pool-origin: "true"
      annotations:
        karpenter.sh/do-not-disrupt: "true"
    spec:
      priorityClassName: paperclip-warm-pool
      serviceAccountName: paperclip-tenant-sa
      automountServiceAccountToken: false
      restartPolicy: Always
      nodeSelector:
        kubernetes.io/arch: arm64
        paperclip.io/pool: expert-sandbox
      dnsConfig:
        options:
          - name: ndots
            value: "2"
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: registry.example/delegra/codex-min:v2026.10-arm64@sha256:REPLACE_WITH_IMMUTABLE_DIGEST
          imagePullPolicy: IfNotPresent
          command: ["/usr/bin/tini", "--", "/bin/sh", "-c", "sleep infinity"]
          env:
            - name: HOME
              value: "/var/lib/paperclip"
            - name: DELEGRA_GATEWAY_URL
              value: "http://delegra-gateway-proxy.paperclip.svc:18080"
            - name: DELEGRA_TOKEN_FILE
              value: "/run/delegra-auth/lease-token"
          resources:
            requests:
              cpu: "250m"
              memory: "512Mi"
              ephemeral-storage: "2Gi"
            limits:
              cpu: "1000m"
              memory: "2Gi"
              ephemeral-storage: "4Gi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: agent-home
              mountPath: /var/lib/paperclip
            - name: cache
              mountPath: /var/lib/paperclip/.cache
            - name: tmp
              mountPath: /tmp
            - name: delegra-auth
              mountPath: /run/delegra-auth
      volumes:
        - name: workspace
          emptyDir:
            sizeLimit: 8Gi
        - name: agent-home
          emptyDir:
            sizeLimit: 1Gi
        - name: cache
          emptyDir:
            sizeLimit: 1Gi
        - name: tmp
          emptyDir:
            sizeLimit: 2Gi
        - name: delegra-auth
          emptyDir:
            medium: Memory
            sizeLimit: 4Mi
```

### 3.2 `SandboxWarmPool` 与 `SandboxClaim`

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: wp-light-codex-min
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
    paperclip.io/profile: light
spec:
  replicas: 0
  readinessGracePeriodSeconds: 45
  sandboxTemplateRef:
    name: expert-light-codex-min-arm64
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: run-01j9x7k2m4p8q3w5
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
    paperclip.io/run-id: "01j9x7k2m4p8q3w5"
    paperclip.io/profile: light
spec:
  sandboxTemplateRef:
    name: expert-light-codex-min-arm64
  lifecycle:
    shutdownTime: "2026-11-22T20:15:00Z"
    shutdownPolicy: DeleteForeground
```

## 4. KEDA 潮汐扩缩容与防雪崩策略

基于 `SandboxWarmPool` 原生 `/scale` 子资源（[HPA SWP 扩缩容示例](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/examples/hpa-swp-scaling/README.md)）与 [KEDA ScaledObject](https://keda.sh/docs/2.21/reference/scaledobject-spec/) + [KEDA Cron Scaler](https://keda.sh/docs/2.21/scalers/cron/)：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: keda-wp-light-codex-min
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  scaleTargetRef:
    apiVersion: extensions.agents.x-k8s.io/v1beta1
    kind: SandboxWarmPool
    name: wp-light-codex-min
  pollingInterval: 15
  cooldownPeriod: 300
  minReplicaCount: 0
  maxReplicaCount: 12
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Pods
              value: 4
              periodSeconds: 30
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60
  triggers:
    - type: cron
      metadata:
        timezone: Asia/Shanghai
        start: "30 8 * * 1-5"
        end: "30 20 * * 1-5"
        desiredReplicas: "3"
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc:9090
        query: |
          ceil(sum(rate(agent_sandbox_claim_creation_total{namespace="paperclip-acme",template="expert-light-codex-min-arm64"}[5m])) * 120)
        threshold: "1"
        activationThreshold: "1"
```

控制器侧配置 `--sandbox-warm-pool-max-batch-size=4`，配合[模块 5](05-ssa-quota-backpressure.md)的 `paperclip-warm-pool-quota` 将预热池配额封顶在 `<= 25%`。

## 5. `pod-exec` `stdin` 原子令牌投递方案

参考 [Execution-Scoped Token 示例](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/containarium-execution-scoped-token/) 与 [Hermes Agents-as-a-Service](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/hermes-agents-as-a-service/)：

```ts
export async function injectLeaseTokenViaStdin(params: {
  execClient: KubeExecClient;
  namespace: string;
  podName: string;
  containerName: string;
  leaseToken: string;
  timeoutMs?: number;
}): Promise<void> {
  const { execClient, namespace, podName, containerName, leaseToken, timeoutMs = 5000 } = params;
  const command = [
    "/bin/sh",
    "-c",
    "umask 077 && cat > /run/delegra-auth/.token.tmp && chmod 0600 /run/delegra-auth/.token.tmp && mv -f /run/delegra-auth/.token.tmp /run/delegra-auth/lease-token",
  ];
  const result = await execClient.execWithStdin({
    namespace,
    podName,
    containerName,
    command,
    stdinPayload: Buffer.from(leaseToken, "utf8"),
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`LEASE_TOKEN_INJECT_FAILED: exitCode=${result.exitCode}`);
  }
}
```

非敏感元数据（`DELEGRA_TOKEN_FILE`、`DELEGRA_LEASE_ID`、`OPENAI_BASE_URL`）通过 `wrapCommandWithEnv` 传入，并显式禁用 `adapter-defaults.ts` 继承宿主机模型凭据环境变量。

## 6. 状态机、Watch 防误判与二次 Pod 校验

### 6.1 租约状态机

```text
[INIT]
  └─► [CLAIM_PENDING] ──(超时 > 15s)──► [FALLBACK_COLD_START]
        └─► [POD_HEALTH_VERIFY] ──(phase!=Running || restartCount>0)──► [FAIL_FAST_CLEANUP]
              └─► [TOKEN_INJECTING] ──(stdin 失败/超时)──► [FAIL_FAST_CLEANUP (删除 Claim + 同步调用模块 3 撤权作废已签发令牌)]
                    └─► [EXECUTING] ──(完成/取消/超时/撤权)──► [TEARDOWN] ─► [DELETED]
```

### 6.2 Watch 与二次 `GET Pod` 防护（[Issue #2008](https://github.com/kubernetes-sigs/agent-sandbox/issues/2008)、[Issue #2247](https://github.com/kubernetes-sigs/agent-sandbox/issues/2247)）

```ts
const FAIL_FAST_REASONS = new Set([
  "PodFailed",
  "PodSucceeded",
  "InvalidConfiguration",
  "EnvVarsInjectionRejected",
  "TemplateNotFound",
]);

export function evaluateClaimWatchEvent(claim: SandboxClaimV1Beta1):
  | { state: "READY"; sandboxName: string }
  | { state: "FAIL_FAST"; reason: string; message: string }
  | { state: "PENDING" } {
  const gen = claim.metadata?.generation ?? 0;
  const readyCond = claim.status?.conditions?.find((c) => c.type === "Ready");
  if (!readyCond) return { state: "PENDING" };
  if (typeof readyCond.observedGeneration === "number" && readyCond.observedGeneration < gen) {
    return { state: "PENDING" };
  }
  if (readyCond.status === "True") {
    const sandboxName = claim.status?.sandbox?.name;
    return sandboxName ? { state: "READY", sandboxName } : { state: "PENDING" };
  }
  if (readyCond.status === "False" && readyCond.reason && FAIL_FAST_REASONS.has(readyCond.reason)) {
    return { state: "FAIL_FAST", reason: readyCond.reason, message: readyCond.message ?? "Terminal failure" };
  }
  return { state: "PENDING" };
}

export async function verifyAdoptedPodHealthy(
  coreV1Api: CoreV1Api,
  namespace: string,
  sandboxName: string,
): Promise<string> {
  const pod = await coreV1Api.readNamespacedPod({ namespace, name: sandboxName });
  const phase = pod.status?.phase;
  const containerStatus = pod.status?.containerStatuses?.find((c) => c.name === "agent");
  if (phase !== "Running" || containerStatus?.ready !== true || (containerStatus?.restartCount ?? 0) > 0) {
    throw new Error(`ADOPTED_POD_UNHEALTHY: pod=${sandboxName}`);
  }
  return sandboxName;
}
```

## 7. 负向安全与稳定性验收测试用例（10 项必过清单）

| 编号 | 测试场景 | 注入动作 / 触发条件 | 预期行为与验收通过标准 |
| --- | --- | --- | --- |
| T2-01 | 强制 TTL 防泄露 | 创建 `SandboxClaim` 后立即 `kill -9` 终止 `paperclip-server` | 到达 `shutdownTime` 后 30 秒内控制器自动回收 Claim 及底层 Pod，无残留 Quota |
| T2-02 | 单向消费防复用 | 连续发起 2 次同租户同画像 Run，第 1 次在 `/workspace` 写哨兵文件 | 第 2 次领养的新 Pod UID 不同且无哨兵文件；第 1 次 Pod 已彻底删除 |
| T2-03 | `podName != claimName` 映射 | Claim 名 `run-aaa`，池生成 Sandbox 名 `wp-light-codex-min-xyz99` | 严格通过 `claim.status.sandbox.name` 执行 `pod-exec`，无 `not found` 错误 |
| T2-04 | 令牌进程隐匿性检查 | 容器内执行 `ps aux`、`cat /proc/1/environ`、`env` | 输出中完全不可见 `leaseToken` 或真实密钥；仅见 `DELEGRA_TOKEN_FILE` 路径 |
| T2-05 | 令牌文件权限与内存卷 | 执行 `stat -c "%a" /run/delegra-auth/lease-token` 与 `df -T` | 权限严格 `600`，文件系统类型为 `tmpfs`，大小上限 `4Mi` |
| T2-06 | `observedGeneration` 防御 | Watch 收到 `observedGeneration < metadata.generation` 的 `Ready=False` | 编排层忽略该事件继续等待，不误报错或回滚 |
| T2-07 | CrashLoop 假就绪防御 | 构造启动秒退重启（`restartCount=1`）的损坏模板 | `verifyAdoptedPodHealthy` 拦截抛 `ADOPTED_POD_UNHEALTHY`，删除 Claim 且不注入令牌 |
| T2-08 | 池耗尽自动冷启降级 | 将 `wp-light-codex-min` 耗尽至 0 后瞬间并发 5 个 Run | 超出池容量请求无缝冷启或进入模块 5 队列反压，成功率 100% |
| T2-09 | KEDA 潮汐零副本休眠 | 非工作日 21:00 且无新 Claim 持续 10 分钟 | `SandboxWarmPool.spec.replicas` 自动缩容至 `0`，闲置预热内存归零 |
| T2-10 | 63 字符命名边界 | 25 字符 `companySlug` + 长模板名启用 `service: true` | 命名截断与短哈希生效，生成的 Sandbox 与 Service 名称 `<= 63` 字符 |
