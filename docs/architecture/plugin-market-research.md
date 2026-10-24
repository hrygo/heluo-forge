# 企业插件市场调研与落地建议

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-ARCH-003 |
| 文档名称 | 企业插件市场调研与落地建议 |
| 版本 | V0.3.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-25 |
| 门禁 | G1 技术准入与契约评审；G2 市场开放前验证 |

> **阅读提示**：本文是 2026-10-21 的调研取证与当时建议，保留证据价值；来源与控制面决策已由 [ADR-11／13](<plugin-registry-source-decision.md>) 取代，**不要**再按本文的逐版本审批、PG 控制面或 Gitee 统一制品源实施。只想了解当前方案，读 [DESIGN-007](<../design/plugins/forge-market.md>) 与 [DESIGN-012](<../design/services/market-index.md>)。

> 编制依据：2026-10-21 对四个社区市场、一个实际目录生产仓库及 DSH 官方接口的研究。Heluo Forge 源码取证基线为 `5b69ace6a96ae305a233103a300c636312a4f0e8`；本机官方市场、索引库与安装管理器核验版本为 `0.2.1-rc.2`，使用 Host Inspect、随包 README 与实现互证。社区源码提交及证据见 §16。两项内存仿真使用 Node 26.11.1，不等同于项目指定 Node 24.21.0 工具链或企业 E2E。
>
> 取证阶段未修改业务代码、远端 issue 或 profile，未连接企业 Gitee/IAM/数据库，未进行目标双端安装。本文按文档归档授权纳入仓库；建议仍待评审，不把归档视为架构、统计口径、制品出口或实施排期获批。
>
> 关联文档：[需求与场景基线](<../requirements/requirements-baseline.md>)、[总体架构](<platform-architecture.md>)、[市场插件设计](<../design/plugins/forge-market.md>)、[索引契约](<../design/services/market-index.md>)、[私有化 Gitee 问询函](<../collaboration/gitee-market-clarification.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)。

> 适用范围：原社区/官方取证保留，来源与最小市场方向已由用户确认的[ADR-11](<plugin-registry-source-decision.md>)替代。下文§6—§14保留原Gitee制品/复杂控制面假设下的分析，不作为当前新增实现或发函依据；PG、逐版本审批、授权下载代理和本地tarball源不是本期最小市场前置。

## 1. 当前决策与研究适用范围

**历史结论（截至 2026-10-20）：企业私有 npm 统一制品源、用户 DSH 不连接公网、内部定制源码在固定 Gitee group 维护。2026-10-21 已改走轻量模式：AIHUB 维护并托管 format-1 索引，DSH 原生「索引源」浏览、官方 manager 安装；不再建设自动索引生成器、写前授权或当前租约（见 ADR-13）。本调研的生成器/控制面建议仅作历史取证。**

原生format-1 npm索引是目标分发目录，安装生命周期委托官方manager。索引没有通用integrity或强制包白名单字段；包体校验记录与registry不可变性、服务端/出口控制分别验收，不能仅靠索引声称全通道拒绝。

历史建议（已不采用）：管理员不逐版录摘要或批准版本，由自动生成器负责稳定 SemVer、真实 bundle 声明、目标 DSH 兼容、完整性与既有安全规则。优先复用企业npm、CI和内网静态托管，不为该名单新建数据库审批后台或自有下载代理。统计如需要优先取registry真实终端下载日志，不混上游同步或安装成功。

### 1.1 范围与非目标

本文归档社区源码调研、现有实现缺口、技术选型、分阶段实施建议与上线验收依据，供架构及模块设计评审使用。它不是已经批准的架构决策、字段级契约或实施排期，不改变现行需求、安装来源与角色边界。

来源、双层名单和自动兼容稳定版已确认，实施契约与真实接入尚须验证。Gitee未验问题见[内部定制源码问询函](<../collaboration/gitee-market-clarification.md>)，不再向其询问统一npm制品分发。新的统计口径或额外治理服务有独立业务需要时再评审。

## 2. 必须纠正的前提

1. **“DSH 市场全不用数据库”不成立。** Open Plugin Market 有 Cloudflare Worker + D1 的共享计数实现与公开聚合输出；它统计目录读取，不是插件安装。
2. **“社区市场基本没有下载量”也不准确。** dsh-market 的实际 catalog 和 Open Plugin Market 都采集 npm 下载聚合；这是上游 npm 的近 30 日下载量，不是本市场/本企业的安装量。
3. **“静态索引不能评审”不成立。** Git PR + CI 可以构成发布评审和留痕；但不会自动产生企业身份下的下载事实、即时撤回门禁与安装状态。
4. **“服务端本地数据库不能服务多人”不成立。** 中心服务用 SQLite 可以为所有客户端提供同一份状态。限制在单写者、部署拓扑和恢复责任，不在文件后缀。不能把中心 SQLite 与每人一个本地 JSON 混为一谈。
5. **“有 format-1 索引便完成企业市场”不成立。** 原生安装直达 npm / Git，不调用现有下载授权端点；目录兼容不等于治理兼容。
6. **“官方没有安装信号”不准确。** 官方有变化、状态、日志事件，Desktop 还有产品结果埋点；但这些不构成通用、可靠、自含最终结果的企业成功账本。
7. 来源字段不能替代身份、真实采集、事务、持久化与正确展示。

## 3. 社区市场如何实现

### 3.1 核验范围

所有结论限于所查版本与源码范围，不代表行业普查。

| 项目 | 固定提交 | 调查重点 |
|---|---|---|
| dsh-market/dsh-market | `eee2281c0837e75b3bc2271bc2766b1ad110e480` | UI、目录消费、本机状态、安装 |
| awesome-dsh-plugin/awesome-dsh-plugin | `89257f135874cf0fd21b97faa71e444dd3cf9031` | dsh-market 的真正目录生产者；CI、star、npm 下载、索引 |
| bradeGithub/DSH-Plugins-Marketplace | `af4935a70859964d2579cfe1324c9e83fce13b3f` | topic 扫描、目录构建、本机状态 |
| polang233/dsh-plugin-index | `c88be5e2a1b60228aca389b13dd4c1755cdca6d6` | format-1、外部指标快照、Worker + D1 |
| Winnie-0721/dsh-plugin-market | `c7864f374a7831148a6f67e71530ba08b90ed6f7` | catalog 消费、缓存、宿主与客户端分层 |

### 3.2 真实数据链路

| 市场 | star 真源 | 下载数据 | 本机/共享存储 |
|---|---|---|---|
| dsh-market + awesome catalog | GitHub stargazers_count；monorepo 子项继承父仓 | npm API 滚动 30 日；仅覆盖有 npm 映射的子集 | CI/cache/构建目录共享分发；本机 state 只存收藏、分组、备注等 |
| bradeGithub | GitHub 仓库/search 数据；Git 历史可推导 star 增量 | 所查实现未发现共享下载采集器 | CI 生成 registry JSON/gzip 并提交；本机安装记录/缓存另存 |
| Open Plugin Market | GitHub API，带 ok/stale/unavailable | npm range/last-month，每日求和得 30 日/7 日快照 | 生成快照 + 静态索引；D1 独立保存目录访问统计 |
| Winnie 市场 | 继承 awesome catalog | 继承 catalog 的 npm 聚合与窗口 | 目录缓存主要在内存；安装状态由宿主管理 |

**dsh-market：应用与目录生产者是两个仓库。** 真正 catalog 的定时任务每日 `02:23 UTC` 计划执行，探测 star 与 npm 数据，更新 Actions cache 和发布生成物。最近六次定时任务整体成功，但单仓失败可保留旧值，不能把 CI 绿灯等同于每个条目都是今天的。

npm 下载窗口截止昨天 UTC，回溯 30 日。它既不是累计安装量，也不等于独立用户或企业采用率；GitHub-only 条目可能没有该数据。

其 legacy 目录与 format-1 不是同一 schema。当前原生导出主要纳入有 npm 映射、精确版本、发布时间的条目；GitHub-only 缺 commit 时跳过；旧目录 star/download 也不会自动完整进入原生索引。

**bradeGithub：不是单纯每个客户端实时扫 GitHub。** CI 每 2 小时增量、每日一次全量构建 registry；目录提交回仓库并经 raw/CDN 消费。客户端有缓存/降级。所查源码、CI、清单未发现共享下载数据库，不能扩大成“行业都没有数据库”。

**Open Plugin Market：三套指标明确分开。** Worker 的 COUNTED 只有 `/index.json`；成功 GET 才异步记 D1。reads 是目录 fetch 次数；readers 是 IP+UA 加盐哈希的日内去重；30 日 readers 是日 UV 相加，不是跨月独立用户。插件下载量另取 npm API，不来自 D1。

本次只读访问 `/stats.json` 得 HTTP 200，输出自述为 index.json reads；没有访问会增加计数的目录路由。结合源码可确认共享计数实现及线上聚合输出，未登录云控制台独立验证数据库实例。

可借鉴的是“外部事实中心采集、目录为派生物、个人状态不混全局指标”，不是照抄公网云服务。机构内数据要求排除了直接把企业使用记录发到公共 Worker 的做法。

## 4. DSH 原生市场的能力与边界

### 4.1 能复用

format-1 校验目录、版本、分类、标签与数值 sortKeys；安装源支持 npm 精确版本（registry 可选）、HTTPS Git + 完整 commit；原生界面可搜索、筛选、选版本并转交管理器。

### 4.2 不能自动提供

- **无 tarball source。** 通用 pluginManager 支持 tarball，不等于 format-1 支持。
- **无企业 group 授权。** 能描述 Gitee 仓库，不等于验证它属于获准 group。
- **不会回调自有 download API。** Discover 将 npm / Git spec 交给 manager，再由 pnpm 直接获取。
- **不是即时撤回门禁。** 普通缓存默认 10 分钟，分页及打开的确认框还可能持旧 spec；manager 不重查索引撤回。
- **sortKeys 不自动成为数字角标。** 已核验原生卡片/详情没有把任意 sortKey 数值直接显示成 star/下载量。
- **索引配置没有现成 Authorization header 项。** 内网 ACL/网关可另评估，不应把 token 放 URL。Host 索引源仅 HTTP(S)，不支持 file://。
- **没有 readOnly/noInstall。** 未定义字段被丢弃，不能添加标记便发布“只看不能装”的有效索引。

### 4.3 官方安装信号也要分层

`plugin-manager/changed` 在失败、取消后也可能发；install-state 只有 installing/cancelling/applying；pnpm exit 0 早于 bundle 验证和激活。Desktop 产品 analytics 有成功信号，但不覆盖普通 Web、可禁、best effort，不能作为企业审计账本。

`installBundle` 返回结果更完整，但包已安装后，启用/发布仍可能失败且不回滚包。`application: failed` 不一定代表“未安装”。Discover 普通安装默认 enabled:false，安装与启用是两步。

因此至少分开：**取得制品 → 包安装 → 启用选择保存 → Host 激活 → Client 可用**。需重启、部分失败、崩溃或失联可以是 pending/unknown，不强行归成成功或失败。

## 5. 本仓库的生产缺口

当前参考服务不能只接个数据库就上线。

| 优先级 | 问题 | 实际影响 |
|---|---|---|
| P0 | 下载信息请求失败时，除 version-revoked 外可退回 Gitee 直连 | 401/403/网络错误都可能绕过未来授权出口 |
| P0 | 常规客户端未发送 x-machine-hash | 服务按插件+机器+日去重，但所有匿名请求被合并 |
| P0 | 目录变更、待审、审计、seen 仍在内存 | 计数文件没有保存完整业务事实 |
| P0 | saveCounts 失败被吞；countsPersisted 只看回调存在 | 成功响应/标记不能证明已持久化 |
| P0 | 身份、group、摘要门禁不全 | submitter 自报；共享管理token非IAM；域名非group；缺摘要仍可继续 |
| P1 | 指标出处没有贯穿列表 | normalizer 丢时间/来源，UI仍显示“★ / 下载” |
| P1 | targetDir 落盘不是完整profile安装 | 还需登记；激活、更新、恢复未闭环 |

两项本次实际验证（零外网、零磁盘写入，内存 doubles）：

1. 两个独立客户端同日调用同一内存服务，counted=[true,false]、downloads=1；请求没有机器标识。
2. downloadInfo 抛 403，工具仍调用模拟直连下载，返回 ok/verify-only；证明 fallback，**不是证明真实安装成功**。

使用本机 Node 26.11.1；项目声明 24.21.0。本次未重新运行 pnpm check，不把该仿真当作指定工具链全量通过或企业 E2E。

## 6. 原存储选型比较（非最小市场前置）

| 路线 | 优点 | 主要不足 | 建议 |
|---|---|---|---|
| 每人本地保存全局状态 | 演示简单 | 没有共同真相 | 排除 |
| Git + PR + CI 索引 | 版本化、评审可留痕 | 下载授权、计数、即时撤回仍缺系统 | 借鉴目录导出，不作为唯一后端 |
| 中心服务 + SQLite | 可事务、可给多人共享、运维轻 | 单写者/单实例约束、恢复和HA需定；不可用NFS共享WAL冒充集群 | 合法备选，不污名化 |
| 中心服务 + PostgreSQL | 事务、唯一约束、并发、企业备份与多副本 | 需数据库资源与责任人 | **推荐，直接落地** |
| 公网 Worker + D1 | 社区已有、低运维 | 不符合本项目内网边界 | 只借鉴模式 |
| 重写安装器/自建registry | 可控面大 | 重复企业及DSH能力，维护面大 | 不采用 |

选 PG **不是因为 800 人把 SQLite 压垮**。SQLite 官方明确可用于中低流量网站。选择依据是当前草案已列 PG、发布/审计/去重需要事务、企业恢复与后续多副本责任更清晰。

直接采用 PG，不强制走 JSON → SQLite → PG 三次实现和迁移。若企业无数据库资源且明确接受中心单实例与恢复目标，应由 IT 裁定中心 SQLite 是否作为完整小规模生产形态，而不是先贬为无意义临时方案。生产资源是否可复用尚未确认。

## 7. 原架构推演与边界（已由ADR-11收敛）

```text
企业IAM ──身份/角色──┐
                    v
DSH薄UI/工具 → Host适配器 → 中心 Market API
                           ├─ PostgreSQL：目录/版本/评审/撤回/审计/计数事实
                           ├─ 只读任务：Gitee group/仓库/star/维护人
                           ├─ 授权下载：只获取获批的Gitee制品
                           └─ 派生目录：format-1（一期不开放绕过治理的直装源）

Host认证取包 → 必需摘要/内容校验 → profile隔离的持久digest缓存
                                      ↓
                              官方pluginManager
                                      ↓
                       分阶段结果 + inventory复核 → 中心回报
```

- API 与任务同一代码库/镜像；用数据库租约防重复扫描，不引入消息中间件。
- PG 是领域状态真源；JSON 是派生读模型，不能反向覆盖数据库。
- UI 和工具调用同一 Host 应用操作，由服务器判权；不在浏览器保存服务管理令牌。
- 不 fork DSH，不手写 profile/Loader，不复制社区所有评论/备份/重启功能。
- 查询先用数据库必要索引，不引入搜索集群。

**本地存储仍有正确用途。** 目录缓存、已安装包、profile、结果待投递队列和受管制品源都有价值，只是它们不拥有共享指标/评审的权威性。

官方 manager 可保留 file:/link: 源供后续管理；目录可能链接，重装可能需要原文件。因此本地源要稳定、按摘要寻址且profile隔离，不能“临时目录装完即删”。缓存清理需确认没有引用和活跃安装，并通过重装恢复测试。

**本地副作用前需要持久 operation journal，而不只是事后outbox。** 先记录attemptId、profile、包/版本/制品digest、manager requestId和阶段，再调用manager。同一attempt复入先查本地终态或等待活动请求；官方waitForInstall不保留已完成结果，返回null不能证明成功/取消。崩溃后用inventory及已记录来源复核，无法判断留unknown并提示处理，不因中心返回同一attempt就再次执行安装。中心幂等不能单独保证本地副作用不重放。

### 7.1 最小技术栈

服务继续使用项目的 Node 24 LTS / ESM，不为持久化改写为另一语言或引入整套新前端框架。复用经过审计的 PostgreSQL 驱动、连接池与标准 OIDC/JWT 校验库，数据库迁移保持一套 SQL；不手写密码学或 JWT 校验。正式服务需独立包清单、运行时约束、配置校验、启动/优雅退出及健康检查，纳入现有仓库门禁。

目标 DSH 版本以实际验证的版本矩阵固定，接口支持证据当时只有 0.2.1-rc.2（2026-10-21 核验），不能把宽松 engines 范围当作所有版本兼容。升级时运行适配契约测试，不复制宿主管理器内部私有函数。

## 8. 原Gitee制品方案（来源已替代）

发布记录至少绑定 `repoId + group/namespaceId + packageName + version + commit + engines + reviewer`。制品另绑定 `releaseId + platform + arch + runtimeABI + digest`；纯JavaScript优先使用跨平台通用制品。

1. 以服务端确认的 repo/group ID 判归属，不用域名或URL字符串前缀替代。
2. tag解析成完整commit；同包同版本禁止改指另一commit；同一已批准平台变体禁止替换摘要，变更必须新版本。Windows与麒麟可在同一release下有分别审核的不同制品，不能强行要求跨平台共用一个digest。
3. 服务端独立重做包/patch校验，客户端自检不是授权证据。
4. 撤回保留历史；新授权和真正取包均复核撤回。
5. 维护人显式指定并核验仓库权限，group成员不自动等于维护人。

**固定commit不等于固定压缩字节。** 动态归档可能重打包。首选企业Gitee内获批release中可稳定保留的构建产物，记录完整摘要，须实测私有部署能力。

若Gitee不能稳定保留发布字节，须由IT/安全批准“Gitee为唯一源码/审批来源，制品库只镜像获批字节”的来源解释，再复用既有制品库；不能擅自换成任意npm来源。摘要能检测变化，但不能凭空恢复历史字节，保留与恢复需验收。

一期优先预构建、自包含插件，企业CI构建，终端免编译。审查runtime、传递、optional、平台和peer解析的完整依赖闭包；除已核验DSH共享依赖外，不允许任意公网runtime依赖。不能只拒顶层安装脚本便宣称安全；pnpm既有按包名批准可影响后续安装，副作用不一定回滚。不自动放行脚本、不用版本豁免掩盖不兼容。

## 9. 原指标方案与一致性（需按npm路径重定覆盖）

### 9.1 star：继续使用Gitee仓库star的共享快照

保存 repoId、value、lastSuccessAt、lastAttemptAt、syncStatus、source。

- 成功才更新value，允许下降；不能取max(old,new)使取消star永远无效。
- 失败保留旧值并标过期；从未成功为null/未知，不是0。
- 建议每6小时同步并加抖动，不由800台客户端各自轮询。
- 一个仓库含多个插件时共享的是仓库星数，不是各插件独立评价。
- 本机收藏不是Gitee star。若以后需要市场内点星，另设计用户级Gitee写授权，不能用服务账号代全员点赞。

### 9.2 下载、传输、安装不混为一谈

| 事实 | 采集位置 | 可宣称的含义 |
|---|---|---|
| 安装请求 | 创建attempt的中心API | 用户要求安装某版本；不代表下载发生 |
| 下载请求 | 中心受控包体端点 | 认证且获准的取包请求，按契约去重；不是查询详情/拿URL |
| 传输结果 | 下载服务/批准制品出口 | 服务端观察的开始、中断、完成；不证明客户端校验/落盘 |
| 包安装结果 | Host wrapper + manager完整结果 + inventory | 经企业入口的安装阶段；注明为客户端回报及渠道覆盖 |
| 激活/可用 | Host/Client分别核验 | 已运行、待重启、加载失败等；不是pnpm exit 0 |

**建议正式 v2 口径改为“已认证自然人主体 + 插件 + 业务日”去重**，提交契约评审后冻结，而不是为迁就尚未上线的机器哈希草案再建一套设备登记系统。主体取稳定的 IAM `(iss, sub)`，多租户时再加 tenant；不取 token 字符串或显示名。服务账号与自然人分开统计，匿名/无效身份不进入可信指标。

profile 随机 ID 仅用于诊断与安装状态关联，不作为认证或物理设备证据；重建 profile 不应能刷高下载量。同一主体在多个终端/profile、同日取同一插件不同版本，在该新口径均只计一次；每个实际请求的 version/attemptId 仍保留。日界由服务端按 Asia/Shanghai 计算，事件时间以 UTC 保存。

新界面显示“Gitee ★ N · 上次同步”“下载请求 N · 按账户/插件/日去重 · 自YYYY-MM-DD起”。这与旧机器/日草案不同，必须使用新指标/统计纪元，不静默重解释旧 downloads。近30日独立用户数须跨日去重，不能把日UV相加。缓存命中没有新取包请求时不增加下载量，安装结果仍单独记录。

### 9.3 原子提交与幂等

- 请求幂等约束：`(authenticatedActor, idempotencyKey)`，保存payload hash；同键不同参数409。
- 展示去重约束：`(pluginId, authenticatedPrincipalKey, businessDay)`；与请求幂等是两回事。
- 使用数据库INSERT/ON CONFLICT判断首次计数，不先查再加。
- 审批状态、审计、派生目录变更任务同事务；提交失败不回成功。
- Gitee请求、下载和本地安装不放在长数据库事务；阶段式记录，不承诺跨网络端到端exactly-once。
- 数据库/必要安全审计不可写时拒绝新授权；日志外送可用同事务的待投递记录重试。
- 已安装后回报失败，不谎称安装失败或自动再安装；有限本地outbox重报，显示结果待同步。

## 10. 原控制面数据模型与API（非默认建设要求）

以下是建议模型，不是已冻结契约或已执行migration。

| 实体 | 关键职责/约束 |
|---|---|
| plugins | 包名唯一，Gitee仓库身份、经核验的维护人 |
| releases | unique(pluginId,version)，完整commit、engines、发布/撤回 |
| artifacts | release下按platform/arch/runtimeABI选择已批准变体；各自不可变digest和来源 |
| review_tasks/events | 评审状态机，条件更新防并发覆盖 |
| audit_events | 与关键状态同事务的actor/action/target/result；按180天目标治理 |
| install_attempts | 认证主体、诊断用profile标识、目标版本、幂等键/hash、阶段结果 |
| download_facts/aggregates | 请求事实、展示去重；聚合可重建，不引入第二真源 |
| repository_stats | star、来源、逐仓同步质量 |
| scan/projection_jobs | 扫描诊断、租约、目录生成与重试 |

原始使用事件、去重标识和日志应有保留期，经安全评审；长期保留不含主体标识的聚合。历史桶归档/清理须原子且有测试，不能删去重事实后把旧重试再计一遍。初期普通表+必要索引足够。

目录GET只查询；显式POST创建安装attempt并判身份、角色、版本、幂等；包体GET再次检查授权和撤回；结果回报只能走允许的状态迁移。服务不接收任意URL代抓取。现有API迁移应有兼容期和字段契约，不悄悄重解释旧downloads。

## 11. 原授权和撤回方案（不作为自建代理依据）

1. Host取对market资源有效的IAM token；服务器校验iss/aud/exp/角色，不假设网关token通用。
2. 提交、评审、下载分别授权；不信请求体submitter/reviewer。
3. 401/403、撤回、代理不可达、来源未知均不自动直连；目录缓存只供浏览，不授予离线新安装。
4. 限制group、源URL、重定向、DNS/IP和出口，防SSRF；凭据不转发到非批准主机。
5. UI只走已验证同源Host入口，写入有origin/CSRF等保护；token不进模型、浏览器配置、URL或日志。
6. 新attempt和包体读取都复核撤回；已开始传输/已下载/已安装代码不能承诺瞬时全球收回。风险提示与受控升级，不擅自远程卸载。

一期可做format-1导出器和兼容测试，但**不下发能绕过受控出口的安装索引**。隐藏入口不是安全控制。只有registry/Git/制品出口本身具备同等身份、撤回、统计和依赖策略时，才开放native直装；统计以共同出口为准，不用索引PV代替。

官方registry配置加空fallback可避免自动公共回退，但不覆盖任意Git/tarball、CLI、终端。用户有本机管理员权限，可以改配置甚至绕过插件。应用门禁治理正常产品路径；强制边界需企业终端、网络出口和仓库ACL等措施，不能声称一个插件能对抗恶意管理员。

## 12. 原实施顺序与投入（不能沿用为当前工期）

| 阶段 | 工作 | 放行门槛 |
|---|---|---|
| A 技术准入 | 真实Gitee版本、group/repo身份、star、commit及稳定制品；IAM market资源；本地制品委托manager与生命周期 | 真实接口记录；确认严格来源下的制品出口，而非只测试假服务 |
| B 中心可信状态 | 正式服务清单/部署约定、PG migrations、目录/评审/审计/撤回、幂等并发；封闭拒绝后直连 | 重启不丢、写失败不回成功、两副本并发正确 |
| C 发现与指标 | Gitee分页/限流/退避/诊断、维护人、star质量、认证主体去重与下载事实；来源时间贯通API/UI | 仅获批版本可用，重试不刷数，未知不归零 |
| D 安装闭环 | IAM取包、强制摘要、稳定本地源、官方manager、分阶段结果、更新/恢复 | 安装不冒充激活，失败/取消/崩溃可解释，无公网依赖回落 |
| E 体验与准入 | 薄列表/详情/安装、提交/诊断；角色负向、恢复演练、Windows与麒麟实机；再评估native | 企业E2E、双端证据及运维签署 |

多个只读核验可并行，B与身份适配可分工。不要把更多UI当作中心真实性的前置。

A阶段不只验首次安装：还要比较持久目录/link与本地归档file来源，验证同版重装、新版替换、保留启用态、旧版恢复、无HMR或自启bundle。官方管理器可能拒绝对已安装名称直接覆盖，更新需移除再安装时也不能假定失败后旧版仍可用。先以实测冻结更新/回退流程，再实施适配，不在研究稿编造原子升级算法。

**前提成立时，核心研发可暂按20–30人日量级估算，尚非完整上线工期。** 该估算不含企业IAM改造、终端强治理、平台原生依赖适配，以及运维审批/恢复演练/双端验证发现问题后的返工与等待。完成A后按工作包重估，并分别排出核心研发、集成、验收及外部依赖；当前不承诺固定日历上线日期。

## 13. 历史issue映射（不自动更新远端事项）

本次不修改远端issue。

| issue | 建议 |
|---|---|
| #2 Gitee联调 | 提前到A，补完整commit、稳定产物、摘要、重定向、凭据边界 |
| #3 IAM | 可信写入和计数前置；主体替代自报submitter，定market资源及撤销时效 |
| #4 扫描 | 用repo/group ID，发现≠自动上架；诊断/分页/失败/退避持久记录 |
| #5 star | Gitee快照可下降；未知非0；逐仓成功时间与失败保留旧值 |
| #6 policy | 从接一个函数提升为全部入口的来源、授权、摘要、版本、脚本和依赖治理；P0修fallback |
| #7 maintainer | 指定仓库维护人并核权限，group成员不等于维护人 |
| #8 面板 | 薄UI与工具共用Host操作；先列表/详情/安装，不复制整个社区市场 |
| #9 存储 | 删除强制三段迁移，直接中心PG事务/幂等/审计/恢复；纠正单机库不能共享的表述 |

#9旧文“批准后重启回到初始目录”的实测措辞过强：本次证据是内存变更无保存路径的源码推导，不是重新做过该流程重启实验，正式回写应纠正。

另明确跨模块工作包：受控安装编排、DSH阶段结果、统计渠道覆盖，防止端到端无人负责。

### 历史状态迁移

旧目录/计数文件先保留只读快照。旧downloads既可能漏计又可能重复，不能直接并入新的可信账户去重总数；保留为legacy指标并标起算/截止时间，新指标从明确统计纪元开始。旧star无同步证据时为未知/历史记录。导入目录不自动获得新批准：重新验证group、commit、平台制品及摘要，必要时重新评审；内存中从未保存的数据不能承诺恢复。迁移应可回退并保留原数据，不删除历史掩盖差异。

## 14. 原验收建议（来源项以ADR-11为准）

### 数据与并发

- 两个不同认证自然人同日同插件计2；同一主体多profile/终端重试100次仍1；同日取两版本按新口径仍1，内部版本事实保留。
- 重启、两副本并发和跨Asia/Shanghai日界后正确；数据库提交失败不声称已计数。
- 同幂等键同参数回原attempt，不同参数409；不重复本地安装副作用。
- 评审/上架/撤回与审计同事务；并发评审无覆盖、无重复版本。

### 来源与故障

- group外、同版本换commit、缺/错摘要、外域重定向、未批准依赖/脚本均拒绝。
- 401/403、中心不可达、撤回后确认无后续Gitee直连，不能只断言返回码。
- star真0与未知null区分，失败保留旧值，取消star允许下降。
- 缓存可浏览不授新安装，撤回的在途边界清楚。

### 安装与终端

- 包已安装、未启用、待重启、Host运行、Client可用分别呈现。
- 部分失败/丢响应经完整结果与inventory复核，不自动重装刷数。
- 本地源重启、清理、重装后可恢复，多profile隔离。
- Windows官方App、麒麟aarch64真实验收；当前Mac源码核验不替代两端实机。

### 运维

- 恢复同时还原目录、评审、撤回、去重/聚合与审计，不只恢复counts文件。
- 建议RPO≤15分钟、RTO≤1小时，由IT/业务批准并演练；单纯每日pg_dump不能声称满足，优先复用WAL归档/PITR。
- 必要审计/DB不可写拒新授权；日志外送失败从持久记录恢复。
- 监控同步延迟、授权拒绝、安装阶段失败、任务积压、DB与备份；责任人明确。

## 15. 待确认

| 待确认事项 | 回答/牵头责任方 | 截止与关闭依据 |
|---|---|---|
| 内部定制源码的实际Gitee版本、group/repo/commit、权限/维护人及可选star | Gitee团队、内部构建发布方 | 定制包准入前取得证据，见[源码问询](<../collaboration/gitee-market-clarification.md>)；npm制品问题由企业仓库方回答 |
| 企业npm下载/发布身份、角色及撤权；双层名单强制范围、内网出口和依赖闭包 | 仓库维护方、IT/安全、平台组 | 接入契约冻结及开放前验证，不能假设市场IAM token通用或索引等于强门禁 |
| 受控白名单、CI/定时生成器、目标兼容矩阵、企业npm及内网静态索引托管 | 平台组、既有CI/分发与仓库维护方 | 实现前冻结最小契约；开放前自动版本和恢复验证；不默认建设PG后台 |
| 原生npm索引与官方manager集成、稳定版选择、依赖/脚本、升级/回退和旧参考协议迁移 | 平台组，IT配合 | 自动收录及双端真实验收，不用旧Gitee归档测试代替 |
| 如需展示下载/热度，确认registry终端请求及上游仓库来源、去重与历史纪元 | 仓库维护方、平台组、业务指标责任人及安全 | 采用前另行冻结；指标不作为双层名单最小市场前置，不复用旧/download计数冒充npm覆盖 |
| 正常路径治理与对抗本机管理员的边界，强终端管控责任与成本 | 安全、IT、平台组 | 安全方案批准前明确，试点开放前验证已批准控制 |

## 16. 资料与证据链接

### 社区源码（固定提交）

- [dsh-market源码及数据源说明](https://github.com/dsh-market/dsh-market/tree/eee2281c0837e75b3bc2271bc2766b1ad110e480)
- [真实catalog的star探测](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/89257f135874cf0fd21b97faa71e444dd3cf9031/scripts/probe-stars.mjs#L31-L84)
- [真实catalog的npm下载采集](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/89257f135874cf0fd21b97faa71e444dd3cf9031/scripts/probe-downloads.mjs#L119-L175)
- [catalog每日CI](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/89257f135874cf0fd21b97faa71e444dd3cf9031/.github/workflows/build-site.yml#L95-L198)
- [catalog原生索引生成](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/89257f135874cf0fd21b97faa71e444dd3cf9031/scripts/lib/market-index.mjs#L99-L155)
- [最近已核验定时任务](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/39360045714)
- [brade目录构建](https://github.com/bradeGithub/DSH-Plugins-Marketplace/blob/af4935a70859964d2579cfe1324c9e83fce13b3f/scripts/build-registry.mjs#L945-L986)
- [brade目录CI](https://github.com/bradeGithub/DSH-Plugins-Marketplace/blob/af4935a70859964d2579cfe1324c9e83fce13b3f/.github/workflows/registry.yml#L3-L85)
- [Open Plugin Market npm下载快照](https://github.com/polang233/dsh-plugin-index/blob/c88be5e2a1b60228aca389b13dd4c1755cdca6d6/scripts/downloads.mjs#L56-L97)
- [Open Plugin Market Worker目录计数](https://github.com/polang233/dsh-plugin-index/blob/c88be5e2a1b60228aca389b13dd4c1755cdca6d6/cloudflare/worker.js#L1-L49)
- [D1 schema](https://github.com/polang233/dsh-plugin-index/blob/c88be5e2a1b60228aca389b13dd4c1755cdca6d6/cloudflare/schema.sql)
- [在线只读聚合接口](https://dshopen.org/stats.json)
- [Winnie目录消费实现](https://github.com/Winnie-0721/dsh-plugin-market/blob/c7864f374a7831148a6f67e71530ba08b90ed6f7/plugin-market/lib/catalog.js#L297-L328)

### 官方与标准

- 本机官方市场、索引库、管理器、Client UI、product-analytics，版本0.2.1-rc.2；Host Inspect与随包文档/实现互证。未调用业务服务做安装。
- [SQLite适用范围、中心网站与单写者限制](https://www.sqlite.org/whentouse.html)
- [PostgreSQL INSERT / ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL WAL归档与恢复](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Gitee公有OpenAPI](https://gitee.com/api/v5/swagger)
- [Gitee企业/社区能力差异](https://help.gitee.com/enterprise/introduce/feature)

### 本仓库固定基线

- [计数、匿名去重、写盘失败处理](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/services/market-index/server.mjs#L21-L41)
- [download与metrics端点](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/services/market-index/server.mjs#L176-L198)
- [客户端headers与downloadInfo](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/packages/forge-market/src/client.mjs#L14-L64)
- [授权失败fallback](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/packages/forge-market/src/market-tools.mjs#L323-L369)
- [归一化字段](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/packages/forge-market/src/catalog.mjs#L3-L44)
- [当前列表展示](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/packages/forge-market/client.js#L40-L45)
- [既有生产设计与PG依赖](https://github.com/hrygo/heluo-forge/blob/5b69ace6a96ae305a233103a300c636312a4f0e8/docs/design/services/market-index.md#L43-L80)

**现行原则：名单由管理员维护；兼容稳定版与索引自动生成；制品归企业npm；定制源码归固定Gitee group；生命周期归DSH。原研究证据保留，旧来源与复杂控制面建议不再默认实施。**
