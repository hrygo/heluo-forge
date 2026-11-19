# Delegra 运行时镜像 · EGM 评审处置

Status: resolved

代拟 · 2026-11-20 · 14 项综合发现纳入 [V1.1.0 评审稿](../../../design/delegra-runtime-images.md)。公开 V1.0.0 快照与原审稿行号一致，行业措辞按仓库扫描规则收敛。原审稿 SHA-256 为 `43542e7951ce544baad43d7e86b7254042e445cbea2c4a4927b8d4b7e1eca4d8`，公开快照 SHA-256 为 `2cd4b6ed28984f5c4bfdf7288497582cc02760564627e2edec8477949904da6d`。 [公开评审快照](https://github.com/hrygo/heluo-forge/blob/5d6fef75c8ce5d58ac0f5fc0080001f59cb0fb1c/docs/design/delegra-runtime-images.md) · [综合评审及原始发现追溯](consolidated_review_report.md)

| 发现 | 级别 | 处置 | 修订位置与依据 |
| --- | --- | --- | --- |
| B1 | Blocker | PROPOSE FIX · 已纳入 | §6.3、§8.1、§9.2.2。公共层保留固定 `r2` 的 Node，原生包和 npm 比较保留真实启动、身份、取消及回收判据。 |
| B2 | Blocker | PROPOSE FIX · 已纳入 | §6.3、§8.2。先确认 ARM64 提供方、模式和制品源，随后对两个镜像或快照走同一调度入口，核对镜像内 Runner、Codex 的实际摘要、版本和替代来源反例。 |
| B3 | Blocker | PROPOSE FIX · 已纳入 | §3、§4、§5、§8.3。依赖 #245、#244 已有范围及企业入口工作。把客户端和来源、`/responses`、IAM 受众与同属主证据列为企业准入条件。 |
| B4 | Blocker | PROPOSE FIX · 已纳入 | §6.4、§8.3。确定选定提供方的私有通道，逐段固定 Host、派发与 transport 消费，增加同一任务的工具、文件、进程、网络和诊断的合成验证。 |
| B5 | Blocker | PROPOSE FIX · 已纳入 | §6.4–6.5、§8.3。定义逐请求可信授权和失联处理，覆盖存活的 Harness、提前到期、取消、退出、在途流和回收。 |
| M1 | Major | PROPOSE FIX · 已纳入 | §4、§7.2–7.4、§8.4。首版个人凭据与候选双主体条件各自明确。候选取证覆盖用户预算、结算与撤销，AIGS 工具链有切换与拒绝判据。 |
| M2 | Major | PROPOSE FIX · 已纳入 | §6.4、§8.3。同一持久授权记录提供 token 和到期时间，列出 Host 接线及刷新、切号、换 Key 的交错验证。 |
| M3 | Major | PROPOSE FIX · 已纳入 | §4、§8.3。把现行机构内模型路径、客户资料、日志与留存要求纳入合成核验和目标企业准入。 |
| M4 | Major | PROPOSE FIX · 已纳入 | §6.3、§8.2。定义排队、运行及可恢复期的制品保留，以及升级、默认回退、正常清理和紧急撤出的证据。 |
| M5 | Major | PROPOSE FIX · 已纳入 | §8.1、§8.5、§9.2.2、§9.3.6。补公共包集、签名快照、候选目标、OCI 压缩计量、统一 UID/GID 和按场景锁定输入及样例。 |
| M6 | Major | PROPOSE FIX · 已纳入 | §8.4–8.5、§9.1。镜像目录区分两项试点、发布目标和按需启用。按任务实际用量评估扩展和候选令牌的成本。 |
| N1 | Nit | PROPOSE FIX · 已纳入 | §1、§5、§6、§8。澄清凭据、快照和回退术语，保留真实接口字段命名。 |
| N2 | Nit | PROPOSE FIX · 已纳入 | §9.2.1、§9.3.3。两个测试镜像共用 Node 工具阶段，各自安装并复制测试工具闭包。 |
| N3 | Nit | PROPOSE FIX · 已纳入 | §8.3、§9.4。以 `--test codex_provider` 命中集成套件，复用 Bake 元数据及摘要签名的现有做法。 |

设计结论以 V1.1.0 评审稿为准。目标环境版本、私有投递、原生 Runner、实际数据边界、计费和实施接线继续按方案验收。评审处置记录只追溯文档修改。
