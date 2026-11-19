# EGM 第 6 阶段 · 理解测试

## What this proposes

方案把专家运行环境做成共享的 Codex 基础镜像和按场景派生的 ARM64 镜像，先交付 `codex-min` 与 `codex-java-21`，再扩展到 18 个锁定目标。任务受理时固定镜像、skills、工具集合和本次授权。首版方向是把 DSH IAM 的用户网关凭据交给对应运行的 Codex Harness。Agent 令牌和调用者计费是可重新比较的路线，接入 AIGS 后则要求按用户与 Agent 权限交集判断。

## How the existing system works, per this document

本机探针已运行 ARM64 镜像、Codex `0.167.1`、非 root 工作区和 Java 样例，并通过模拟网关验证 `/responses`。缺少 IAM access token 时模拟网关返回 `401`。Delegra 固定标签 `deploy/v2026.1106.0-r2` 能识别 Linux ARM64 Runner 可执行文件。Daytona fleet 配方使用 AMD64 基镜像，远端 Native Codex 兼容范围是 `>=0.149.0 <0.161.0`，目标 Runner 能否运行 ARM64 镜像仍待核验。DSH Host 当前通过不同入口读取网关 Key、`baseURL` 和 IAM access token，凭据与任务的绑定及运行时的隔离仍待接入和实测。

## 发现

### C6-01 · Major · 权限交集的适用阶段

文档信息与 §4、§7.2（L19–20、53–55、157–162、184）给出两种表述。L19 和 L55 将双身份权限交集放在 AIGS 阶段，L157 将其写为通用规则。首版由 Delegra 约束专家配置与任务授权，网关核验用户权限。读者无法据此确认首版 Agent 权限由谁按何规则执行，以及独立 Agent 身份介入后改变了哪些判定。

### C6-02 · Major · 凭据注入与运行边界

§6.4（L126–127、130）要求 Runner 向 Codex Provider 注入凭据，以 `shell_environment_policy` 约束命令继承环境。正文未确定所用策略、获准读取进程、出站网络与日志边界。读者能理解缺乏隔离证据时关闭企业凭据入口的条件，仍无法据此确定要实现的隔离契约与具体验收判据。

代拟 · 2026-11-20 · EGM 第 6 阶段。独立评审仅读取 [CORP-DSH-DESIGN-022 V1.0.0](../../../design/delegra-runtime-images.md) 第 1–185 行及第 186–403 行，未打开链接目标。以上转述保留评审者从被评文档得到的理解。
