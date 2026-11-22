# 模块 3：集群级零信任代理（delegra-gateway-proxy）与逐请求撤权控制面落地详设

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024C |
| 文档名称 | 模块 3：集群级零信任代理（delegra-gateway-proxy）与逐请求撤权控制面落地详设 |
| 版本 | V1.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 阶段二 12 项负向安全与流式稳定性验收用例（T3-01 ～ T3-12）全过前不进入生产 |

> 所属主设计：[Delegra 专家智能体 Kubernetes 智能调度设计](../delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024 V2.0.0） · 对应阶段：阶段二（Delegra [#73](https://github.com/hrygo/Delegra/issues/73) / heluo-forge [#395](https://github.com/hrygo/heluo-forge/issues/395)）。

## 1. 架构升级依据与代码边界

同 Pod 容器共享 Linux Network Namespace 与 `127.0.0.1` 回环（[Kubernetes Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)），K8s `NetworkPolicy` 与 Cilium 均无法按容器 UID 实施隔离（[Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)、[Sysdig 多租户隔离分析](https://www.sysdig.com/blog/multi-tenant-isolation-boundaries-kubernetes)），且 Warm Pool Pod 不可变 `envFrom` 无法动态注入 Sidecar 密钥。因此彻底淘汰 Pod 内 Sidecar，升级为部署在 `paperclip` 命名空间的独立高可用集群级代理 `delegra-gateway-proxy:18080`：

1. **新增控制面模块**：`server/src/services/native-runtime/expert-gateway-authorization.ts`（阶段二全新模块）。
2. **封堵宿主机密钥继承**：修改 `adapter-defaults.ts` 的 `buildAdapterEnv`，专家模式下强制禁止继承宿主机模型凭据环境变量。
3. **双拓扑控制面兼容**：`PAPERCLIP_SERVER_URL` 兼容集群内部署（`http://paperclip-server.paperclip.svc:3100`，配 Cilium mTLS）与集群外部署（`https://control-plane.example`，强制 TLS 1.3 + mTLS 双向认证）。

## 2. `/v1/responses` 流式 SSE 代理内核与背压设计

- **防 5 分钟默认超时截断**：定制 Undici `Agent`（`connectTimeout: 10_000`、`headersTimeout: 0`、`bodyTimeout: 0`），避开 Node.js/Undici 默认 300s 截断（[Undici Client](https://undici.nodejs.org/api/Client)、[openai-node #2153](https://github.com/openai/openai-node/issues/2153)）。
- **请求体受限缓冲与前置模型校验**：先在 `MAX_REQ_BODY_BYTES = 16 * 1024 * 1024` 上限内读取请求体 `Buffer` 并解析校验 `model` 是否命中 `allowedModels`（超限返回 `413`，越权返回 `403 POLICY_OR_SCOPE_DENIED`），校验通过后再以 `Buffer` 传给 Undici，避免请求流被二次消费。
- **心跳、背压与零正文审计**：每 15 秒发送 `: keep-alive\n\n`；通过 [Node.js `stream.pipeline()`](https://nodejs.org/learn/modules/backpressuring-in-streams) 实现流式背压防 OOM；依据 [OpenAI Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses) 与 [Responses Streaming Events](https://developers.openai.com/api/reference/resources/responses/streaming-events)，严禁落盘正文，仅提取 `response.completed` 的 `usage`（HTTP 200 无终态事件记录 `STREAM_TRUNCATED_EOF`）并异步回调 `/internal/runner/v1/gateway-reconcile`。

```ts
import { Agent, request } from "undici";
import { pipeline } from "node:stream";
import { promisify } from "node:util";

const pipelineAsync = promisify(pipeline);
const MAX_REQ_BODY_BYTES = 16 * 1024 * 1024;

export const upstreamDispatcher = new Agent({
  connectTimeout: 10_000,
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
});

export async function proxyResponsesStream(ctx: ProxyRequestContext): Promise<void> {
  const abortController = new AbortController();
  const handle = registerActiveStream(ctx.runId, ctx.generation, abortController, ctx.clientReq.socket);

  ctx.clientRes.on("close", () => {
    if (!ctx.clientRes.writableEnded) abortController.abort("CLIENT_DISCONNECTED");
  });

  const heartbeat = setInterval(() => {
    if (!ctx.clientRes.writableEnded) ctx.clientRes.write(": keep-alive\n\n");
  }, 15_000);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of ctx.clientReq) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQ_BODY_BYTES) {
      ctx.clientRes.writeHead(413, { "content-type": "application/json" });
      ctx.clientRes.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }
    chunks.push(chunk);
  }
  const requestBodyBuf = Buffer.concat(chunks, totalBytes);
  const parsed = JSON.parse(requestBodyBuf.toString("utf8"));
  if (parsed.model && !ctx.allowedModels.includes(parsed.model)) {
    ctx.clientRes.writeHead(403, { "content-type": "application/json" });
    ctx.clientRes.end(JSON.stringify({ error: "POLICY_OR_SCOPE_DENIED" }));
    return;
  }

  let credBuf: Buffer | null = Buffer.from(ctx.upstreamApiKey, "utf8");
  try {
    const upstreamRes = await request(ctx.upstreamUrl, {
      method: "POST",
      dispatcher: upstreamDispatcher,
      signal: abortController.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credBuf.toString("utf8")}`,
        "x-delegra-run-id": ctx.runId,
      },
      body: requestBodyBuf,
    });
    credBuf.fill(0);
    credBuf = null;

    ctx.clientRes.writeHead(upstreamRes.statusCode, {
      "content-type": upstreamRes.headers["content-type"] ?? "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });

    const auditTap = createZeroBodySseAuditTransform(ctx);
    await pipelineAsync(upstreamRes.body, auditTap, ctx.clientRes);
    await emitGatewayReconcileAsync(auditTap.getSummary());
  } finally {
    clearInterval(heartbeat);
    if (credBuf) credBuf.fill(0);
    unregisterActiveStream(ctx.runId, handle);
  }
}
```

## 3. 控制面逐请求鉴权、服务间认证与 `< 100ms` 实时撤权

### 3.1 `expert-gateway-authorization.ts` 与服务间双向认证

- `expert_gateway_grants` 维护状态机 `ACTIVE | REVOKED | SUPERSEDED | EXPIRED | COMPLETED` 与单调递增 `current_gateway_generation` 围栏，零本地缓存逐请求调用 `POST /internal/runner/v1/gateway-authorize`。
- **服务间双向认证**：代理调用 `/internal/runner/v1/gateway-authorize` 与 `gateway-reconcile` 必须携带 Projected ServiceAccount JWT + Cilium mTLS（或独立挂载专用内部认证凭据校验 `X-Delegra-Internal-Auth`），控制面强制校验调用方身份仅限 `delegra-gateway-proxy`，防止同命名空间其他 Pod 越权换取租户上游凭据。

### 3.2 五大精准拒绝码契约

| 拒绝码 | HTTP 状态码 | 触发条件 | 代理与客户端处理语义 |
| --- | --- | --- | --- |
| `RUN_NOT_ACTIVE` | `403` | Run 已处于 `COMPLETED`、`REVOKED` 或 `FAILED` | 立即拒绝并终止沙箱重试 |
| `RUN_GENERATION_STALE` | `409` | 令牌 `generation < current_gateway_generation`（已 `SUPERSEDED`） | 防止脑裂或旧僵尸容器盗用配额并记安全事件 |
| `CREDENTIAL_REVOKED_OR_SWITCHED` | `401` | 上游密钥被撤销/轮换或 `token_hash` 不匹配 | 强制阻断并触发在途流斩断 |
| `GRANT_EXPIRED` | `401` | 超过租约 `expires_at` | 拒绝请求，等待外层租约回收 |
| `POLICY_OR_SCOPE_DENIED` | `403` | 模型不在 `allowed_models`、超出预算或路径越权 | 拒绝请求并写入审计日志 |

### 3.3 实时撤权广播与内存纵深缓解

- **Redis Pub/Sub `< 100ms` 斩断**：状态变更为 `REVOKED`/`SUPERSEDED` 事务提交后立即发布 `delegra:gateway:revoke`，所有代理副本遍历 `activeStreamsByRunId` 执行 `abortController.abort()` 与 `socket.destroy()`。
- **内存安全缓解**：依据 [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) 与 [Node.js CLI](https://nodejs.org/api/cli.html)，启用 `--zero-fill-buffers` 并调用 `credBuf.fill(0)`。因 V8 堆字符串不可变无法手动清零，该措施需配合禁用 Core Dump 与 Heap Snapshot 作为纵深缓解，长期通过 RFC 8693 短效 STS 令牌根治。

## 4. 高可用 PSS `restricted` 部署与双向 `NetworkPolicy`

遵循 [Pod Security Standards (`restricted`)](https://kubernetes.io/docs/concepts/security/pod-security-standards/)、[PDB](https://kubernetes.io/docs/tasks/run-application/configure-pdb/) 与 [Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: delegra-gateway-proxy
  namespace: paperclip
  labels:
    app: delegra-gateway-proxy
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: delegra-gateway-proxy
  template:
    metadata:
      labels:
        app: delegra-gateway-proxy
        paperclip.io/role: gateway-proxy
    spec:
      serviceAccountName: delegra-gateway-proxy-sa
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 180
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: delegra-gateway-proxy
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: proxy
          image: registry.example/delegra/gateway-proxy:v1.0.0@sha256:REPLACE_WITH_IMMUTABLE_DIGEST
          args: ["--zero-fill-buffers", "dist/main.js"]
          ports:
            - name: http
              containerPort: 18080
          env:
            - name: PORT
              value: "18080"
            - name: PAPERCLIP_SERVER_URL
              value: "http://paperclip-server.paperclip.svc:3100"
            - name: REDIS_REVOKE_CHANNEL
              value: "delegra:gateway:revoke"
          resources:
            requests: { cpu: "500m", memory: "512Mi" }
            limits: { cpu: "2000m", memory: "2Gi" }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: delegra-gateway-proxy-pdb
  namespace: paperclip
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: delegra-gateway-proxy
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: delegra-gateway-proxy-hpa
  namespace: paperclip
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: delegra-gateway-proxy
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: delegra-gateway-proxy-netpol
  namespace: paperclip
spec:
  podSelector:
    matchLabels:
      app: delegra-gateway-proxy
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              paperclip.io/managed-by: paperclip-k8s-plugin
          podSelector:
            matchLabels:
              paperclip.io/role: agent
      ports:
        - protocol: TCP
          port: 18080
  egress:
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
    - to:
        - podSelector:
            matchLabels:
              app: paperclip-server
      ports:
        - protocol: TCP
          port: 3100
    - ports:
        - protocol: TCP
          port: 443
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
```

## 5. AIGS 四阶段零侵入演进（RFC 8693）

通过 [RFC 8693 OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693) 从“控制面换取上游 Key”平滑演进至“AIGS mTLS 统一路由 → RFC 8693 `sub`/`act` 双主体委派 JWT → 细粒度 MCP/工具级授权”，专家沙箱侧全程零改造。

## 6. 负向安全与流式稳定性验收测试用例（12 项必过清单）

| 编号 | 测试场景 | 注入动作 / 触发条件 | 预期行为与验收通过标准 |
| --- | --- | --- | --- |
| T3-01 | 宿主机密钥零继承 | 控制面宿主机注入测试用模型凭据环境变量后起沙箱 | 沙箱 `env` 与 `/proc/*/environ` 完全不存在该凭据 |
| T3-02 | 在途长 SSE 实时撤权 | 60s 流式响应第 10s 控制面撤权并广播 Redis | 代理 `< 100ms` 断开下游并向上游 Abort，上游停产 Token |
| T3-03 | `RUN_GENERATION_STALE` | `generation=1` 旧令牌在 `current_gateway_generation=2` 后请求 | 返回 `409 Conflict` + `RUN_GENERATION_STALE` |
| T3-04 | `RUN_NOT_ACTIVE` | Run 进入 `COMPLETED` 后重放原令牌 | 返回 `403 Forbidden` + `RUN_NOT_ACTIVE` |
| T3-05 | `CREDENTIAL_REVOKED_OR_SWITCHED` | 租户轮换上游 API Key 后用原令牌发起请求 | 返回 `401 Unauthorized` + `CREDENTIAL_REVOKED_OR_SWITCHED` |
| T3-06 | `GRANT_EXPIRED` | 令牌超过 `expires_at` 1s 后请求 | 返回 `401 Unauthorized` + `GRANT_EXPIRED` |
| T3-07 | `POLICY_OR_SCOPE_DENIED` | 仅授权 `gpt-5-mini` 的 Run 请求 `o3-pro` 或 `/v1/files` | 返回 `403 Forbidden` + `POLICY_OR_SCOPE_DENIED` |
| T3-08 | 超 5 分钟长推理不截断 | Mock 上游延迟 360s 返回首字节并持续输出 60s SSE | 完整成功不被 300s 截断，期间每 15s 收到 `: keep-alive` |
| T3-09 | `STREAM_TRUNCATED_EOF` | Mock 上游 HTTP 200 发 3 个 chunk 后直接断 TCP | 记录 `STREAM_TRUNCATED_EOF` 并在对账回调上报异常终态 |
| T3-10 | 慢速消费者背压保护 | 沙箱限速 1KB/s 读取，上游 5MB/s 持续推送 | 代理 Pod RSS 涨幅 `< 50Mi`，无 OOMKilled |
| T3-11 | 零正文隐私审计 | 对话含唯一哨兵文本 `<SENTINEL_TEXT>`，检索日志与对账库 | 日志、指标与对账表均完全不存在该哨兵文本 |
| T3-12 | 滚动更新零中断排空 | 20 条并发长 SSE 进行中执行 `rollout restart` | `maxUnavailable: 0` + `preStop` + `180s` 保障 20 条流 100% 完成 |
