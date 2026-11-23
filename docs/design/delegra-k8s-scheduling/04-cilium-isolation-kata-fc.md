# 模块 4：多租户 Cilium 网络硬隔离与 Kata-FC 内核级隔离落地详设

## 文档信息

| 项 | 内容 |
| --- | --- |
| 文档编号 | CORP-DSH-DESIGN-024D |
| 文档名称 | 模块 4：多租户 Cilium 网络硬隔离与 Kata-FC 内核级隔离落地详设 |
| 版本 | V1.0.0 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-22 |
| 门禁 | 7 项红队渗透与安全隔离验收用例（T4-01 ～ T4-07）全过前不进入生产 |

> 所属主设计：[Delegra 专家智能体 Kubernetes 智能调度设计](../delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024 V2.0.0） · 对应阶段：阶段二 / 阶段三（Delegra [#74](https://github.com/hrygo/Delegra/issues/74) / [#76](https://github.com/hrygo/Delegra/issues/76)）。

## 1. Cilium L3/L7 网络硬隔离与 DNS 策略收敛

### 1.1 三大核心收敛原则

1. **`egressDeny` 绝对优先**（[Cilium L3 Policies](https://docs.cilium.io/en/stable/security/policy/layer3/)）：硬阻断 IMDS（`169.254.169.254/32`、`fd00:ec2::254/128`）与跨租户 `paperclip-k8s-plugin` 沙箱 Pod，避免过宽 `NotIn` 误伤独立制品库或监控命名空间。
2. **彻底移除 `matchPattern: "*"`**（[Cilium L7 Policies](https://docs.cilium.io/en/stable/security/policy/layer7/)、[Cilium DNS-Based Policies](https://docs.cilium.io/en/stable/security/dns/)）：阻断 DNS 隧道渗出；`paperclip-egress-allow` 仅保留静态基线域（`*.svc.<cluster-domain>`、`*.example.invalid`），动态任务域名的 53 端口 `rules.dns` 与 443 端口 `toFQDNs` 统一合并在 `paperclip-egress-fqdn` 原子下发防漂移。
3. **修复 `ndots: 5` 与 Alpine/musl `REFUSED` 中断**：Cilium 全局开启 `--tofqdns-dns-reject-response-code=nameError`，Pod 模板设置 `dnsConfig.options: [{ name: "ndots", value: "2" }]`。

### 1.2 Cilium DNS Proxy 生产级调优参数

依据 [Cilium Debugging](https://docs.cilium.io/en/stable/contributing/development/debugging/) 与 [cilium-agent 参数参考](https://docs.cilium.io/en/stable/cmdref/cilium-agent/)：

| Cilium 参数 | 推荐生产值 | 工程作用 |
| --- | --- | --- |
| `--tofqdns-dns-reject-response-code` | `nameError` | 修复 Alpine/musl 遇到 `REFUSED` 直接中断解析链 |
| `--tofqdns-min-ttl` | `300`（5 分钟） | 防止短 TTL 域名在任务执行中被过早驱逐 |
| `--tofqdns-idle-connection-grace-period` | `60s` | DNS 缓存过期后保留活跃连接 60s 宽限期 |
| `--tofqdns-endpoint-max-ip-per-hostname` | `200` | 兼容多 IP 轮询的制品库与对象存储域名 |
| `--tofqdns-max-deferred-connection-deletes` | `20000` | 高并发多租户防延迟清理队列溢出 |
| `--dnsproxy-concurrency-limit` | `100` | 防止异常沙箱 DNS 洪水打垮节点 DNS Proxy |

### 1.3 生产级 `CiliumNetworkPolicy` 清单

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: paperclip-deny-all
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  endpointSelector:
    matchLabels:
      paperclip.io/role: agent
  ingress: []
  ingressDeny:
    - fromEntities:
        - all
  egressDeny:
    - toCIDR:
        - 169.254.169.254/32
        - fd00:ec2::254/128
    - toEndpoints:
        - matchLabels:
            paperclip.io/managed-by: paperclip-k8s-plugin
          matchExpressions:
            - key: k8s:io.kubernetes.pod.namespace
              operator: NotIn
              values:
                - paperclip-acme
                - paperclip
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: paperclip-egress-allow
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  endpointSelector:
    matchLabels:
      paperclip.io/role: agent
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: paperclip
            app: delegra-gateway-proxy
      toPorts:
        - ports:
            - port: "18080"
              protocol: TCP
    # 保留 paperclip-server:3100 业务回调（集群外部署时通过受控 FQDN/CIDR 放行 HTTPS 443）
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: paperclip
            app: paperclip-server
      toPorts:
        - ports:
            - port: "3100"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
          rules:
            dns:
              - matchPattern: "*.svc.<cluster-domain>"
              - matchPattern: "*.example.invalid"
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: paperclip-egress-fqdn
  namespace: paperclip-acme
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
spec:
  endpointSelector:
    matchLabels:
      paperclip.io/role: agent
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
          rules:
            dns:
              - matchName: "registry.npmjs.org"
              - matchName: "pypi.org"
              - matchName: "files.pythonhosted.org"
    - toFQDNs:
        - matchName: "registry.npmjs.org"
        - matchName: "pypi.org"
        - matchName: "files.pythonhosted.org"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

## 2. ARM64 架构 `kata-fc` 内核级隔离规范

### 2.1 ARM64（`aarch64`）硬件与宿主机硬前提

依据 [Kata Virtualization Design](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md)、[Firecracker Getting Started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)、[Firecracker Kernel Policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md) 与 [Kata Firecracker How-To](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-containers-with-firecracker.md)：

| 前置项 | 硬性要求 | 规避风险 |
| --- | --- | --- |
| KVM 虚拟化 | ARM64 裸金属节点（如 `c7g.metal` / `m7g.metal`），存在 `/dev/kvm` | 常规虚拟化节点不支持 ARM64 嵌套虚拟化 |
| 中断控制器 | 必须为 **GICv3** | vGICv2 上限仅 8 vCPU |
| 内核页大小 | **4K 页**（`getconf PAGESIZE == 4096`） | 64K 页 ARM64 内核与 Firecracker 不兼容 |
| 宿主机内核 | Linux `>= 6.1` | 满足 Firecracker 与 Cilium eBPF 基线 |

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -m)" = "aarch64" ] || { echo "FAIL: not arm64"; exit 1; }
[ -c /dev/kvm ] || { echo "FAIL: /dev/kvm missing (bare-metal required)"; exit 1; }
[ "$(getconf PAGESIZE)" = "4096" ] || { echo "FAIL: host kernel is not 4K page size"; exit 1; }
grep -qi "gicv3" /proc/interrupts /sys/firmware/devicetree/base/interrupt-controller*/compatible 2>/dev/null || echo "WARN: verify GICv3 via dmesg"
echo "PASS: ARM64 kata-fc host prerequisites verified"
```

### 2.2 存储快照器与 OOM/记账绕过防护

- **阶段一必须使用 containerd `devmapper`（LVM thin-pool）**：Firecracker 不支持 `virtio-fs` / `overlayfs`（[Agent Sandbox Firecracker](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/firecracker-sandbox/)），`nydus` 暂不兼容（远期可评估 `kata-dragonball`）。
- **防静默 Guest OOM 误杀 `kata-agent`**（[Kata in Production](https://perun.au/insights/kata-containers-production/)）：强制 `requests.memory == limits.memory` 且 `memory_offset >= 512Mi`。
- **防 MicroVM 记账绕过**（[USENIX Security 2026](https://www.usenix.org/system/files/usenixsecurity26-wang-shiwen.pdf)）：硬限 `devmapper` `base_image_size = "10GB"` 与宿主机 cgroup v2 内存硬限。

```toml
[plugins."io.containerd.snapshotter.v1.devmapper"]
  pool_name = "delegra-thinpool"
  root_path = "/var/lib/containerd/devmapper"
  base_image_size = "10GB"
  discard_blocks = true
  fs_type = "ext4"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc]
  runtime_type = "io.containerd.kata-fc.v2"
  snapshotter = "devmapper"
  privileged_without_host_devices = true
  pod_annotations = ["io.katacontainers.*"]
```

### 2.3 `RuntimeClass` 与分层路由（对接模块 5 裸金属 `NodePool`）

参考 [Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/) 与 [Pod Overhead](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-overhead/)，`nodeSelector` 与 `tolerations` 直接对接[模块 5](05-ssa-quota-backpressure.md)的 `expert-sandbox-kata-fc-arm64` 裸金属 Karpenter `NodePool`：

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-fc
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
handler: kata-fc
overhead:
  podFixed:
    cpu: "250m"
    memory: "256Mi"
scheduling:
  nodeSelector:
    kubernetes.io/arch: arm64
    paperclip.io/runtime: kata-fc
  tolerations:
    - key: "paperclip.io/isolation"
      operator: "Equal"
      value: "kata-fc"
      effect: "NoSchedule"
```

路由基线：C1/C2 常规任务走 `runc` + PSS `restricted`；C3/C4 高敏任务与 `codex-test-web`（Playwright）强制 `kata-fc`。

## 3. 红队渗透与安全隔离验收测试用例（7 项必过清单）

| 编号 | 测试场景 | 渗透攻击模拟命令 / 动作 | 预期行为与验收通过标准 |
| --- | --- | --- | --- |
| T4-01 | IMDS 云元数据封堵 | 沙箱内 `curl -m 3 http://169.254.169.254/latest/meta-data/` | 被 `paperclip-deny-all` `egressDeny` 立即阻断 |
| T4-02 | 大模型直连绕过封堵 | 沙箱内 `curl -m 3 https://api.openai.com/v1/models` | DNS 返回 `NXDOMAIN` 且直连阻断；仅访问 `:18080` 代理成功 |
| T4-03 | DNS 隧道渗出阻断 | 沙箱内 `nslookup payload.untrusted-example.test` | Cilium 拦截返回 `NXDOMAIN`（非 `REFUSED`），外部 DNS 无记录 |
| T4-04 | Alpine/musl 白名单解析 | Alpine 沙箱内 `wget -qO- https://registry.npmjs.org/-/ping` | 正常解析与建连，不因搜索域被拒中止解析 |
| T4-05 | 跨租户东西向阻断 | `paperclip-acme` 沙箱探测 `paperclip-beta` Pod IP / Service | 100% 丢包阻断 |
| T4-06 | `kata-fc` 独立内核验证 | C3/C4 或 `codex-test-web` 沙箱执行 `uname -r` 与 `dmesg` | 可见独立 Kata Guest Kernel 与 `virtio` 设备，宿主机不可见 |
| T4-07 | Guest OOM 与块设备上限 | 触发超限内存分配与 `dd` 写 12GB 文件 | 工作负载优雅 OOMKilled 且 `kata-agent` 存活；10GB 处触发 `ENOSPC` |
