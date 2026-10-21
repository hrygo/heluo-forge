# 插件市场服务详细设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-012 |
| 文档名称 | 插件市场服务详细设计 |
| 版本 | V1.1.1 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-21 |
| 门禁 | G2 |
| 模块状态 | 独立服务尚未实现；现有 `server.mjs` 为旧协议参考实现 |

> 定位：本文冻结首版“哪些包能被自动收录、产物长什么样、什么时候允许安装”的企业契约。插件侧交互与安装链路见 [DESIGN-007](<../plugins/forge-market.md>)；来源决策见 [ADR-11／12](<../../architecture/plugin-registry-source-decision.md>)；整体图见[功能架构图](<../../assets/plugin-market-architecture.html>)。
>
> 边界：目标路径不依赖本文的旧 HTTP 服务、`serviceUrl`、`adminToken`、数据库或 IAM。企业 registry、CI 原子能力、双端矩阵均未验。

## 1. 一页速览

**一句话**：CI 把“管理员批过的包”变成原生目录、策略证据和一个短时有效的安装开关；Host 每次写入前都回来问一次“现在还能装吗”。

| 先看这张表 | 结论 |
|---|---|
| 谁生成 | 既有 CI/定时任务，按环境与矩阵单写；不是常驻审批服务 |
| 产物 | 原生 format-1 index + policy/evidence sidecar + `current` 指针 |
| 授权 | `current` 带 15 分钟租约，CI 每 5 分钟续期；单次决定 ≤ 60 秒 |
| 不做什么 | 不建 PG/IAM、下载代理、自造 installer/journal、逐版审批 |
| 现在做到哪 | 仅旧 HTTP 参考实现；npm 契约未实现，企业接入未验 |

**主链路**：

```mermaid
flowchart LR
  A[受控清单 + 基线] --> B[只读企业源]
  B --> C[自包含 双端 真实包检查]
  C --> D[不可变快照]
  D -->|原子切换| E[current]
  E --> F[Host 写前在线授权]
```

**关键数字**：租约 ≤ 15 分钟；续期 5 分钟；decision ≤ 60 秒；`schemaVersion: 1`；每 profile 1 个 registry。

**怎么读**：

| 你是 | 建议顺序 |
|---|---|
| 评审 / 管理员 | §2 → §3 → §4 → §8 |
| 生成器 / CI 开发 | §3 → §4.1 → §7 → 附录 A |
| 运维 | §4.2 → §7 → §9 |
| 发布者 | §4.1 生成流程 + [插件设计 §1.3 发布旅程](<../plugins/forge-market.md#13-发布者旅程把一个插件送进市场>) |

## 2. 目标与非目标

**目标**

- 管理员只维护 registry 与精确包名，CI 自动收录合规稳定版。
- 双端同包同字节：Windows 与麒麟所有目标组合都通过才进目录。
- 产物可审计：每个 allow/deny 都能追到输入 revision、检查证据与摘要。
- 授权短时有效：过期、不可达或已撤回时自动退到只读浏览。

**非目标**

- 不新增常驻市场服务、容器、数据库、IAM 或下载代理。
- 不在市场内构建包，不托管包体。
- 不做逐版本人工审批或人工推荐位。
- 不把旧 Gitee 提交/评审协议当作 npm 收录流程。

**形态**：交付物是清单、CI/定时任务和内网静态产物；具体托管产品、认证注入与原子发布能力属于企业接入核验项，不重新选择安全行为。

### 2.1 需求与依赖

| 需求/验收 | 关系 | 说明 |
|---|---|---|
| REQ 可治理分发 | 直接实现 | 已同步不等于已批准；精确版本及来源可追溯 |
| REQ 推荐能力落地 | 支撑 | 有出处的目录、指标与场景支撑采用 |
| 验收 A10 分发 | 支撑 | 自包含根包仅由企业 npm 获取，双端交集、当前授权与安装阶段可复核 |

| 依赖 | 类型 | 版本约束 | 缺失时的目标行为 |
|---|---|---|---|
| 企业私有 npm | 企业既有服务 | 产品/URL/认证/ACL、同步及内网 tarball 行为待核验 | 无法校验候选则不新增收录；终端取包失败不回退公网/Gitee |
| 受控清单与 CI/定时任务 | 现有工程能力的目标适配 | 清单变更经管理员授权；生成物记录清单版本及检查证据 | 清单无效/冲突时不发布新索引，报告失败 |
| 内部定制源码/构建证据 | Gitee 与企业流水线 | 仅内部定制须关联固定 group/repo/commit | 证据不足不收录对应版本；公网镜像不补内部 repo |
| 目标 DSH 与双端环境 | 官方格式与运行时 | 按实际版本矩阵验证 Windows、麒麟 aarch64 | 无兼容证据的版本不作为该目标默认可安装版 |
| 身份/出口强制能力 | registry/既有网关/终端治理 | 认证、角色、撤回与日志按现有企业能力核验 | 不冒充已全通道治理；强阻断要求未满足不得按其口径开放 |

最小路径不依赖本文旧 HTTP 服务、`serviceUrl`、`adminToken`、新增数据库或 IAM。清单与检查证据优先复用受控版本库和 CI 产物；需额外持久化/鉴权时另行评审。

## 3. 目标契约

> `schemaVersion: 1` 是企业新产物，与原生 format-1 的 `format` 无关；以下字段**不是**已有插件 Config、Host Service 或 HTTP API。

### 3.1 管理员受控清单

| 字段 | 类型与校验 |
|---|---|
| `schemaVersion` | 必填整数，首版仅接受 `1`；未知版本拒绝，不静默降级 |
| `registries` | 必填数组；元素仅 `{ id, url }`，`id` 为非空稳定标识且唯一，`url` 为规范 HTTPS 企业 registry 聚合入口 |
| `packages` | 必填数组；元素仅 `{ name, registryId, origin }`；空数组表示无获准顶层包 |
| `packages[].name` | 精确合法 npm 包名，区分 scoped/unscoped 的实际包名；禁止 `*`、scope 通配、别名、版本/tag/range、URL、Git、tarball 与本地 path spec |
| `packages[].registryId` | 必须引用唯一存在的 registry；同一精确 `name` 只能有一条映射，重复或跨源冲突一律拒绝，不能后写覆盖 |
| `packages[].origin` | 只接受 `public-mirror` 或 `internal`；是制品来源分类，不改旧 `source: service/local/cache` 的读取渠道含义 |

各对象只接受表内字段；类型不符、未知字段、重复 registry ID/规范 URL、悬空引用及重复包名均使整份输入无效，不部分发布。URL 禁止凭据、query、fragment、空白与重定向；以标准 URL 解析规范化主机/默认端口/path，registry 路径保留且以单一 `/` 结尾，存储与比较均使用同一 canonical 值。拒绝编码/路径歧义及规范化后冲突，不靠字符串前缀判同源。

```json
{
  "schemaVersion": 1,
  "registries": [{ "id": "corp-prod", "url": "https://npm.corp.example/" }],
  "packages": [
    { "name": "@heluo/forge-example", "registryId": "corp-prod", "origin": "internal" }
  ]
}
```

例子只是无凭据占位清单，不证明该包已发布。管理员只维护 registry 地址与精确顶层包映射/来源分类，不填版本摘要、矩阵、逐版检查结果或 token。多个 registry 可列在总清单，但**环境/profile 发行基线只绑定唯一 `registryId`**；同 profile 的所有根包、锁文件与实际解析必须一致指向该入口，不通过 scope 配置或每包 override 混源。内部/公网聚合由企业私服完成，不由终端跨源拼装。

### 3.2 发行基线与目标矩阵

平台发行基线固定环境/profile 的唯一 `registryId`、目标 `matrixId`、生成器规则版本和受控输入 revision。`matrixId` 对应精确 DSH、Node、pnpm、OS-CPU、SDK 与 Client 版本集合；任何一项变化生成新矩阵，不把 `>=` 范围或当前机器版本当作矩阵。

目标包括 Windows 桌面与银河麒麟 aarch64；**Windows CPU 尚未核定，本文不补造架构值**。未核定/未通过的组合不得开放安装。`0.2.1-rc.2` 仅为接口核验版本；企业发行版本由平台基线核定，不由市场管理员逐版填表。

### 3.3 首版自包含与双端交集

| 首版实际发布包条件 | 可判定规则 |
|---|---|
| 自包含运行依赖 | 发布包的 `dependencies`、`optionalDependencies`、`bundleDependencies`、`bundledDependencies` 必须为空或不存在；有浮动或精确外部依赖都排除，不能以锁文件、私服有包或 bundle 依赖已下载代替 |
| devDependencies | 只用于源码 CI/build 阶段；运行时不得解析/另取 devDependency。允许包内已构建产物与 Node 内置，不要求终端重建 |
| peer 与基线 | peer 只能引用目标 DSH 已提供且在每个 matrix 组合核验的基线；不得自动补 peer。pnpm 有效 `autoInstallPeers` 必须为 `false`，不存在把它当 DSH Config 的新字段 |
| Host/Client 入口 | 包内运行入口、patch、导出及资源完整；禁止新增不在目标 DSH/SDK/Client 基线的 UI external、运行时 npm fetch/import 与 CDN；静态检查及双端 smoke 均须有证据 |
| 安装/构建脚本 | 拒绝安装时会触发的生命周期脚本和终端编译，包括 `preinstall/install/postinstall`、相关 root lifecycle script、隐式 `node-gyp`/`binding.gyp` 路径；不自动填 `approvedBuilds` 或发版本豁免。仅源码 CI 使用、终端不触发的普通 `scripts.build/test` 不据此拒收 |
| 双端统一目录 | 同一 name/version/integrity 的不可变包须在 matrix 全目标通过；不是 Windows/麒麟各自并集。只支持单平台或依靠 optional native deps 选平台的包不入首版；包内已经包含的双端资源仍须逐组合核验 |

这是首版范围收敛，不把依赖普通 npm 的 DSH 包说成非法；支持普通/传递/平台依赖属于后续扩展。自包含消除“另取运行依赖”的漂移，不证明业务无缺陷，也不免除来源、许可、扫描与代码安全检查。结构/入口 smoke 由 CI 自动执行，不要求管理员每版签字。

开启写入前还须核验 profile 基线：manager 显式配置规范企业 `registry` 与 `fallbackRegistries: []`，pnpm 实际 registry/scope 路由同源，无自动补 peer/安装脚本、未受控 `pnpmfile`/override、manifest-lock 不一致或遗留浮动依赖。否则保持 `browse-only`；存量不自动清理。空 fallback 不约束 Git/path/tarball 或浏览器图片，不能单独作为全通道证明。

### 3.4 原生 format-1 边界

#### 原生 format-1 边界与 display 发布门禁

2026-10-21 Host Inspect 核验：`MarketVersion` 为 `version/publishTimestamp/source/engines`；npm source 仅 `type: 'npm'` 与可选 `registry`，安装目标为 `spec/registry`。原生还支持其声明的 title/description/icon 等展示字段，但**没有 `integrity`、OS/CPU、matrix、policyRevision 或企业授权字段**。本方案只输出 npm source、精确稳定版本与实际支持的 engines/展示字段；双端交集在生成时完成，不向索引塞自定义 OS/policy 字段冒充 manager 门禁。完整性保存在 sidecar 与企业 registry 同版不可变性治理；仍须实测 pnpm 获取与最终实装 name/version 的一致性。

候选门禁以企业私服留存的**真实 npm pack 发布包**为准，核验 `dsh.bundle.patch`、runtime/patch/Host/Client 入口、exports、files 实际内容以及资源路径，不只看仓库源文件。内部定制须提供有意义的 en/zh `meta.title/meta.description`、授权可再分发 icon，确保 locale/icon 导出与打包字节存在且格式可读；第三方缺 display 可以明确记录回退到 name/description/通用图，不因此拒绝所有第三方包。展示回退不是结构、入口或安全失败的豁免。

索引 `icon` 只用内网同源绝对 HTTPS 或相对静态地址，也可省略；不得放公网 icon/CDN。registry/pnpm 配置不控制浏览器图片请求，须单独核验静态资源与浏览器出口。生产索引、registry、icons 使用 HTTPS 与企业 CA，不能关闭证书校验；历史 loopback HTTP 仿服务不改称生产例外。

### 3.5 policy / evidence / current

以下字段由任务自动生成，不由管理员手录；policy/evidence 是企业 sidecar，`current` 是受控静态 HTTPS 发布指针与当前安装开关，均不是原生字段。

| 产物/字段 | 必填类型与关联规则 |
|---|---|
| 三者公共头 | `schemaVersion: 1`、`policyRevision: string`、`generation: integer >= 1`、`matrixId: string`、`generatedAt: RFC3339 UTC string`、`registryId: string`；字符串不得为空 |
| `policyRevision` | 当前受控授权输入 revision，绑定清单、平台基线/准入规则与独立维护的当前风险撤销集合；这些输入变化必须变更。只重扫/续期/发布新索引不等于改变授权 revision，不由浏览 `fetchedAt` 推导 |
| `generation` | 按环境/matrix 单调递增的发布序号；恢复、续期、拒绝快照和重发均不得倒退。不是包版本或时间戳 |
| policy | `nativeIndexDigest: string`、`entries: array`、`revocations: array`；每项 entry 为精确 `{ name, version, integrity, decision, reasons }`，`decision` 只取 `allow/deny`，reasons 为字符串数组。允许项必须有实际核对的 SRI 完整性；deny 必有非空原因 |
| policy 撤销 | 每项 revocation 为 `{ name, version?, reason }`；不带 version 表示整包拒绝，带 version 为精确版本。以**当前 policyRevision 的撤销**为准，不从旧索引恢复许可；下载阻断和已装处置另行验收 |
| evidence | `nativeIndexDigest: string`、`inputs: object`、`candidates: array`；inputs 必有 `allowlistRevision/baselineRevision/riskRevision/generatorRevision`，记录本次真正读取的受控 revision |
| evidence 候选 | 每项含 `name/version/registryId/origin`、可得时的 `integrity`、`checks`、`provenance`；allow 候选缺真实完整性即拒绝。checks 每项 `{ id, result, reason, checkedAt, evidenceRefs }`，result 只取 `pass/fail/unknown`，checkedAt 为原检查完成的 RFC3339 UTC 时间；失败/未知必有原因，不把 unknown 视为 pass |
| evidence 来源 | provenance 按 origin 分类：internal 必有 `group/repo/commit/buildRef`（完整不可变 commit）；public-mirror 必有 `upstream/scanRef/licenseRef`，不伪造内部 repo。evidenceRefs/各 Ref 指向无凭据受控证据地址与其 digest；upstream 是来源记录，不授权 CI/终端连公网 |
| current | `installEnabled: boolean`、`expiresAt: RFC3339 UTC string`、`snapshot: object`；snapshot 必有 `indexUrl/policyUrl/evidenceUrl/nativeIndexDigest/policyDigest/evidenceDigest`，URL 为不可变同源企业 HTTPS 静态地址，不含凭据/query/fragment，不接受 HTTP redirect |
| current 控制租约 | 必须 `generatedAt <= 当前可信时间 < expiresAt` 且 `0 < expiresAt - generatedAt <= 15 分钟`；过期、未来时间或本机时钟不可信均拒绝新写。每次 no-store 重取同一过期 JSON 不能续授权 |

校验规则：schema/type/必填项及内部引用必须通过；同一快照的 policy/evidence/current 公共头、index digest、精确 name-version-integrity、来源分类和输入 revision 必须互相一致，原生索引中只能有当前 policy/evidence 全部通过的 allow 版本。公共头不写进原生 index，原生字节只由 `nativeIndexDigest` 关联。SRI 校验按 registry 声明与实际包字节比对；各 `*Digest` 统一为 `sha256:<64位小写十六进制>`，对完整产物原始字节计算，不对自行重排的 JSON 求摘要。schemaVersion 不支持、摘要/公共头不符、同版本换字节、未知检查或来源证据缺失均拒绝发布/写入；检查原因是新产物诊断，不重用或删除旧 HTTP 错误码。

字段 validation 还要求：版本为精确稳定 SemVer、origin 与 admin 清单一致、registryId 与环境绑定一致，revision/原因等声明为 string 的值及所有 Ref 不得为空；集合内重复 name-version 或 check id 拒绝。`checks[].id` 首版固定为 `package-shape/self-contained/peer-baseline/matrix-smoke/provenance/integrity/display` 七类，allow 必须七类齐全且全部 pass；第三方 display 合法回退以 pass 加明确 reason 记录。Ref 统一为 `{ url: string, digest: string }`，生产证据 URL 为无凭据/query/fragment/redirect 的受控 HTTPS，digest 同上述字节摘要；sources/revision 字符串只作证据，不授权任意联网。schemaVersion 1 对象不接受表外字段；增加不兼容字段或检查语义需升 schemaVersion/生成器规则，不靠忽略未知字段放行。

`current` 来源由平台基线固定在可信 HTTPS/企业 CA 内，不从 listing 元数据任意指定；发布权限与凭据受控注入。安全撤销独立于索引历史，恢复旧目录时也只能使用当前授权输入重新验证并生成更高 generation。`generatedAt` 仅表示产物时间，不能代替在线确认当前 policyRevision；保留历史仅供追溯，不是许可。原生 reader 只消费真正的原生 `indexUrl`，不能把 current/sidecar URL 当原生 `indexes` 配置；拟建企业适配读取并核对 current/sidecar、同步合法索引来源和执行写前授权，**不宣称官方市场会自动读取 sidecar 或因此产生全局 hook**，接入不能等价实现时 browse-only。

### 3.6 原生索引消费与唯一同步 owner

#### 原生索引消费与企业来源的唯一同步 owner

平台发行基线须明确授权薄 Host 适配管理一个固定企业索引槽位及其 HTTPS 来源命名空间；它是该槽位自动轮换的唯一 owner，不是新增 DSH Service/hook。首次建立或撤销槽位由发行管理授权，受管 UI/工具仅传包/版本意图，不接受任意索引 URL，也不向 agent 暴露改源授权。不能把 current/sidecar URL 配给原生 reader。

Host 存活时以不超过5分钟的轻量检查、受管目录进入/刷新及重连触发同步：先验证固定 current 及整组快照，再用公开 `pluginMarket.listIndexes()` 读取配置，仅将发行授权的企业槽位替换为实际 `snapshot.indexUrl`，通过公开 `pluginMarket.setIndexes(urls)` 保存。企业槽位按发行保留的规范 origin/path 命名空间识别；保留其他既有来源及其顺序，不擅自取得其所有权。索引 URL/字节未变的许可续期不重复改源。来源变更事件后重读来源，并对已配置新 URL 执行 `search`/刷新，不能继续把旧 URL 当当前目录；原生 `search/entry` 只接受已配置 URL。计时器/监听由 Host owner 生命周期回收。

超出命名空间的 URL、未授权槽位新增/删除、非受管来源变更意图均在企业适配拒绝；这是适配输入边界，不宣称原生 `setIndexes` 自带企业角色控制。原生来源管理 UI/直接调用等仍纳入全通道准入证明。Settings 不可用、来源同步/事件接线失败或授权覆盖不等价时，保留标过期旧目录且 browse-only；新写不因旧目录或旧许可放行。切换后仍按 §4.3 重新验证当前授权，不把源同步当安装授权。

## 4. 发布、授权与撤回

### 4.1 单写生成与原子发布

1. **输入/单写**：复用受控 Git 与既有 CI；同环境/matrix 从取输入到发布由同一可调度 owner 单写串行，不只给最终文件加锁。owner 不是不可抢占的长命令：矩阵扫描由无发布权限的隔离 CI 子任务执行，owner 等待时仍须在不超过5分钟的检查点处理最新输入、负向关闭和到期续期；子任务只提交候选证据，不得自行切 current。记录清单/基线/风险/生成器 revision 与当前 `baseGeneration`；读取唯一 registryId 对应企业私服，不让 metadata 扩展源或转向公网。实际发布前必须重新读最新受控输入和 current，任一 revision 或 base generation 已变则不提交，丢弃/按最新输入重跑，不能以后完成覆盖先完成的新政策。
2. **真实候选**：metadata 与实际包的 name/version 一致，稳定 SemVer、有效 `engines.dsh`，不跟随可变 dist-tag；验证 §3.3 自包含、来源、许可/扫描、完整性、真实 runtime/patch/exports/files/display 与同版不可变性。缺证或 unknown 排除；完整性变化隔离且保留旧证据，不覆盖成“同版更新”。
3. **交集检查**：对 matrix 的所有 Windows/麒麟组合执行结构/入口 smoke；同一包字节全部通过才进入统一索引。只看 engines、单端通过或发布目录里有目标文件均不充分；可自动 CI，不逐版人工签字，不保证功能无 bug。
4. **完整候选快照**：先产出 schema 有效的原生 index 与 policy/evidence；policy/evidence 与拟切换 current 的公共头一致，原生 index 只按 nativeIndexDigest 关联，不添加企业头字段。写入不可变路径并验证全部可读且字节匹配，不覆盖 current 指向的文件，不发布半份索引/sidecar。候选未全部就绪不切换。
5. **提交/读取**：最后一次最新输入/current generation 复检与 current 原子替换须在同一受控单写提交边界；成功分配更高 generation。读取按 current 的不可变 URL 和摘要取得整组产物；分步读取若跨 current 切换，revision/generation/hash 不符则拒绝本次写入、重新读取，不能拼接两代。索引/control/sidecar URL 禁 HTTP redirect，必须直达最终 HTTPS 地址。具体 CI 锁、HTTPS 托管和原子 replace 能力待接入验证，不改为安全降级。
6. **源失败/负向优先**：私服源故障不收新候选，旧目录标来源/过期/原因供浏览，不以扫描失败恢复许可。包移除/风险隔离以及清单/基线/风险等授权输入变更，均先发布完整一致的拒绝快照（`installEnabled: false`，可用空可安装索引与明确拒绝证据），关闭安装再慢速扫描/重验证；新输入无效/未知也不能继续续旧许可。串行设施必须能取消被新 revision 替代的慢任务、限时释放并优先运行拒绝短任务，不能被长扫描无限拖延。旧 r1 即使晚完成也须因最新 r2 输入或 current generation 改变拒绝发布。企业 CI 不具备所需单写/取消/原子能力时保持 browse-only，不声称目前已有这些能力。
7. **轻量续期与静态许可失效**：既有 CI 每5分钟运行轻量授权续期任务，由当前 owner 的检查点执行；空闲时由同环境/matrix 的短任务取得单写权，复核最新受控授权输入 revision 与 current。输入未变时可复用既有已验证候选证据与原生 index 字节，不重跑双端长扫描；保留原 checks.checkedAt/来源检查证据，生成同一 policyRevision、更高 generation、一致新 generatedAt 的 policy/evidence/current，并按步骤4–5原子发布，current.expiresAt 不得晚于 generatedAt 后15分钟。输入变化则走步骤6拒绝路径，不能借续期延续旧许可。复检、签发或发布失败不续期；即使旧 current 文件仍可访问，最多到其原 expiresAt 自动拒绝新写。该任务不是新增常驻审批/授权服务；发布器/CI 停摆不能使旧授权被反复 no-store 读取而无限续用。

**长扫描与续期的有界让步**：同一 owner 必须在矩阵任务运行超过15分钟时仍能按不超过5分钟的检查点完成轻量复核/续期，不能让排队代替续期，也不能延长15分钟租约。仅当授权输入完全未变、current 变化仅为该 owner 自己成功提交的续期时，才可把正在生成候选的预期 baseGeneration 更新到自己的最新代次；候选保留原输入和 checkedAt，最终公共头在提交时绑定新代次。其他 writer/未知变化或任何输入变化一律按步骤1/6丢弃、关闭写入或重跑，不把重新读取 generation 当无条件覆盖许可。若 CI 只有不可抢占的整 job 锁、无法保证检查点，长扫描前即保持只读并报告设施不满足。候选代码/入口 smoke 在隔离执行器运行，不提供清单/索引发布凭据或生产身份；单写 owner 不在持发布凭据的进程中导入候选。

**长扫描与续期的有界让步**：同一 owner 必须在矩阵任务运行超过15分钟时仍能按不超过5分钟的检查点完成轻量复核/续期，不能让排队代替续期，也不能延长15分钟租约。仅当授权输入完全未变、current 变化仅为该 owner 自己成功提交的续期时，才可把正在生成候选的预期 baseGeneration 更新到自己的最新代次；候选保留原输入和 checkedAt，最终公共头在提交时绑定新代次。其他 writer/未知变化或任何输入变化一律按步骤1/6丢弃、关闭写入或重跑，不把重新读取 generation 当无条件覆盖许可。若 CI 只有不可抢占的整 job 锁、无法保证检查点，长扫描前即保持只读并报告设施不满足。候选代码/入口 smoke 在隔离执行器运行，不提供清单/索引发布凭据或生产身份；单写 owner 不在持发布凭据的进程中导入候选。

### 4.2 续期、到期与时钟

- 既有 CI 每 5 分钟跑轻量续期：复核输入 revision 与 current，复用已验证证据与索引字节，不重跑双端扫描。
- 续期生成更高 generation、同一 `policyRevision`、一致新 `generatedAt`；`expiresAt` 不晚于 `generatedAt` 后 15 分钟。
- 输入变化走拒绝路径，不能借续期延续旧许可；复检/签发/发布失败即不续期。
- 到期后即使旧文件仍可访问，也拒绝新写；反复 `no-store` 读同一过期 JSON 不会延长租约。
- 时钟不可信、`expiresAt` 在未来或已过期，一律拒绝新写。

### 4.3 每次写入前的在线授权

**浏览与授权分离**：官方市场可缓存目录供浏览，`cacheTtlMs`、浏览 `fetchedAt`、产物 `generatedAt` 本身都不是授权。每次受管写操作（安装、升级各写阶段、恢复及启用等）必须从平台固定的可信 HTTPS 控制地址以 `no-store` 取当前控制元数据，控制响应不得作为可缓存许可；核对 TLS/企业 CA、schema、installEnabled、当前 policyRevision/generation、matrix、registryId、完整快照 digest、精确根版本许可及当前撤销集合，且确认可信时钟满足 `generatedAt <= now < expiresAt`、控制租约不超过15分钟。不可达、证书错误、摘要不符、过期/未来时钟异常、profile 基线不符、检查未知均拒写；只可用标过期 listing 浏览，即使 pnpm store 中已有包也不例外。反复成功读取同一旧 JSON 不延长其中 expiresAt。

准入 decision 仅为本次操作的短时内存结果，绑定 `policyRevision/generation/matrixId/registryId/name/version/integrity` 与判定/到期时间；到期严格取 **`min(本次在线判定时间 + 60秒, current.expiresAt)`**，不能越过控制许可。执行前再次在线核对当前 revision 与租约有效性，未变且未过期才写；变化、跨 generation 或过期重取/重判，不沿用旧 decision。60秒/15分钟是本方案约束，不是 DSH 原生字段或缓存 TTL，也不承诺撤销能中止已执行代码；每5分钟轻量续期及失败自然只读按 §4.1、§4.2。调用受管路径不等于全局 hook 已存在；任何实际写通道不能等价实现该约束则不开市场安装。

通过后交官方 `pluginManager` 精确 `name@version` 与唯一企业 registry；公开 Host API 可显式 `saveExact: true` 作防御。不能误报“不传 saveExact 必存范围”：当前 pnpm 11.28.5 精确 spec 的保存 exact 实测依据见 [DESIGN-007 安装链路](<../plugins/forge-market.md#7-安装更版与恢复目标>)，仍须复核目标 matrix 的最终 manifest-lock 与实际安装版本。pnpm 缓存不是下载计数器，也不是授权账本；旧 download API 不在此路径中。

升级 remove→install、移除失败、安装失败后未安装、恢复/启用选择与 unknown 的具体协议统一见 [DESIGN-007 安装链路](<../plugins/forge-market.md#7-安装更版与恢复目标>)，此处不另造 installer/journal。升级目标根版本与恢复旧根版本都必须当前获准，移除完成后还须重新判定再 install；若其间被撤销，不继续旧目标。首版自包含不发生另取运行依赖的动态闭包漂移；不据此承诺原子升级或自动恢复。

撤销分三层验收：目录不再可安装、registry/既有出口实际取包阻断、已装代码的独立处置。删索引、npm deprecate、缓存到期均不等于后两者完成；已装代码不承诺远程自动卸载。风险撤销始终读取当前 policyRevision，不能因旧索引回退复活。**Git 已合并不等于撤回已经生效**：只有新 current 原子发布且受管入口复核可见/拒写后才确认相应生效回执，并记录实际覆盖与在途边界；紧急隔离优先复用 registry/终端现有撤权能力，不把文档目标、输入已改或单处回执当全终端即时生效。

恢复发布不是把 current 指针倒回历史：以**当前**清单/风险/矩阵重验证旧合规 index/证据/包体，生成当前 policyRevision 和更高 generation 的完整新快照，再按 §4.1 发布；不回退安全策略。制品留存、registry 同版不可变与控制能力仍须核验，只有目录、counts 文件或 pnpm 缓存不保证合规可恢复。

安装结果按取得制品、包安装、启用保存、Host 激活、Client 可用分层，失联为 unknown。可选回报接口以后再定：相同事件以稳定幂等键和相同 payload 补投结果，不重放安装，不新增复杂 journal、发布申请或数据库前置。

### 4.4 撤回与恢复

撤销按三层验收：**目录不可安装、取包实际阻断、已装代码独立处置**。删索引、npm deprecate、缓存到期都不等于后两者完成。

- **Git 已合并不等于撤回生效**：只有新 `current` 原子发布且受管入口复核可见/拒写后，才确认对应覆盖并记录在途边界；紧急隔离优先复用 registry/终端撤权能力。
- **恢复不是把指针倒回历史**：以当前清单/风险/矩阵重验旧合规快照，生成当前 `policyRevision` 与更高 generation 的完整新快照；不回退安全策略。
- 只有目录、counts 文件或 pnpm 缓存，不保证仍可合规重装。

### 4.5 升级与结果回报

升级 `remove → install`、移除失败、恢复与 unknown 的具体协议统一见 [DESIGN-007 §7](<../plugins/forge-market.md#7-安装更版与恢复目标>)，此处不另造 installer/journal。目标根版本与恢复旧根版本都必须当前获准，移除后重新判定再 install。

通过后交官方 `pluginManager` 精确 `name@version` 与唯一企业 registry；公开 Host API 可显式 `saveExact: true`。不能误报“不传 saveExact 必存范围”：pnpm 11.28.5 精确 spec 的保存实测见 DESIGN-007 §7.2，仍须复核目标矩阵的 manifest-lock 与实装版本。pnpm 缓存不是下载计数器，也不是授权账本。

安装结果按取得制品、包安装、启用保存、Host 激活、Client 可用分层；失联为 unknown。可选回报接口以后再定：同事件用稳定幂等键补投，不重放安装，不新增 journal。

## 5. 指标口径

### 5.1 目标口径（待契约修订）

企业 npm 终端 tarball 请求须以 registry 或获准内网出口的实际请求事实采集，标注认证、去重、失败/完成、覆盖渠道与缓存影响；不能沿用旧 download 地址发放数冒充。

| 目标事实 | 采集与边界 |
|---|---|
| 终端 tarball 请求 | 企业 registry/获准内网出口；重试、鉴权失败、开始/中断/完成须区分，不等于安装成功 |
| upstream 同步 | 企业 registry 向上游镜像/拉取行为；一次同步可供多终端，不计企业终端下载 |
| 元数据 GET | npm 元数据与市场索引读取；不计 tarball 下载 |
| pnpm 缓存 | 没有新 tarball 请求便不增加对应请求数；缓存命中不是共享下载账本，也不能证明当前获准 |
| 安装与可用结果 | 取得制品、包安装、启用选择保存、Host 激活、Client 可用分别记录；pending/unknown 不强制归成成功或失败 |

此处不批准账户去重或新的统计纪元。若改去重主体、日界或口径，须独立冻结契约并隔离历史数据；registry、客户端与 upstream 指标不能简单相加。角色、撤回、审计及采集覆盖未等价前，只报告已验证渠道。

### 5.2 当前参考口径

| 指标 | 实际含义 | 参考实现的持久化 | 展示要求 |
|---|---|---|---|
| `downloads` | 发放归档地址的次数；**不是安装成功数**（客户端取到地址后可能失败） | 只有启动时给了 `--counts` 才写文件；去重集合在内存，重启后同机器同日可重复计数 | 必须写成「下载请求数」 |
| `stars` | 目录文件里记录的值 | **不写入、不同步**；上架时写 0 | 必须标注来源与时间，不得称为「热度」 |

因此 `/api/metrics` 除数值外返回三个口径字段：

| 字段 | 含义 |
|---|---|
| `countsPersisted` | 当前仅表示配置了保存回调；`true` 不证明写盘成功，`false` 表示没有累计保存能力（目录初值另计） |
| `starsSource` | `catalog` 表示来自目录文件，不是 Gitee 实时值 |
| `starsSyncedAt` | star 最近同步时间；参考实现恒为 `null` |

消费方规则：

- `starsSyncedAt` 为 `null` 时，排序只能称“按目录记录值排序”，不得称热门排序。
- `countsPersisted` 为 `false` 时，不得展示累计下载量，只能展示本次进程内次数。
- 面板与工具输出同一口径；不得一处“下载量”另一处“安装量”。

这些字段不能弥补真实采集/持久化缺口，旧实现不得标成 npm 全市场统计。

## 6. 权限、凭据与边界

| 项 | 目标处理 | 失败与证据边界 |
|---|---|---|
| 管理员清单 | 仅有权管理员改 registry 地址/精确顶层包映射，Git 受控变更并留 revision | 清单冲突、未知 registry、同 profile 混源均拒绝，不逐版审批 |
| CI 与凭据 | 元数据/包体只读企业私服，内部源码证据只读固定 Gitee group；凭据受控注入，不进清单/索引/URL/日志/模型 | 不访问公网 npm；认证失败不匿名回退，不转发凭据到其他主机 |
| 终端及资源出口 | 唯一规范 registry、空 fallback；只允包内产物/目标已提供基线，索引及 icon 同源内网 HTTPS/企业 CA | 不动态取 npm/peer/CDN，不关证书验证，内部缺包不代理公网 |
| 受管写入授权 | 每次按 §4.3 在线 `no-store` 取当前可信控制元数据；decision 最长 60 秒且执行前 revision 未变 | 缓存/TTL/`fetchedAt` 不授权，不可达、过期或版本变化拒写/重判；此约束不是 DSH 字段 |
| 原生/工具/角色边界 | 实测 UI、工具、Host、CLI、其他市场及任意 spec/local path/Git/tarball、缓存与并发角色控制 | 不杜撰全局 SDK hook；控制不等价则市场 browse-only，不开放安装；不以 UI 隐藏替代 |
| 全通道取包阻断 | 验证企业 registry 逻辑视图/ACL 或既有出口/终端能力对下载、角色、撤销及日志的覆盖 | 本地缓存取包与已有代码可能不经 registry；未证明等价不开放安装，不新建 proxy，不承诺防本机管理员 |
| 来源与风险 | 内部定制固定 group/repo/commit/build，公网镜像 upstream/扫描/许可；当前 risk revocation 独立于索引历史 | 来源未知/风险撤销拒绝，旧目录/恢复不能撤销当前风险结论；已安装处置独立记录 |
| 发布与恢复 | 不可变完整快照后原子切 current；单写串行且提交前复核最新受控 revision/当前 generation | 陈旧任务不发布，恢复只能按当前策略重验证并升 generation，不能恢复旧许可 |
| 指标/可选结果投递 | 口径见 §5.2；如建设回报，稳定幂等键与 payload 核对，失败只补投结果 | 不把结果未送达当成安装失败或重装理由；pending/unknown 保留 |

## 7. 失败与恢复

| 场景 | 目标行为 | 重试与边界 |
|---|---|---|
| 清单无效、映射冲突、未知 registry 或 profile 混源 | 拒绝输入/写入，报告具体位置与有效基线差异 | 不后写覆盖、不换源；存量不自动清理 |
| 企业私服源不可达、鉴权失败或缺包 | 不新增该候选，保留有原因/新鲜度的旧目录；终端取包失败 | 不回退公网/Gitee，旧 listing 不等于当前许可 |
| 当前控制元数据不可达/证书错误/不一致/租约过期或未来时钟异常 | 只可浏览标过期目录，拒绝新的受管写操作 | pnpm 已有缓存仍不能新装；不关闭证书验证 |
| 发布器停摆但旧 current HTTPS 仍可读 | 不因成功 no-store 读取续许可，原 expiresAt 后只读 | 5分钟轻量续期失败不能越过15分钟租约；不新建常驻服务 |
| decision 超过60秒、current先到期或执行前revision/generation已变 | 按 min(判定+60秒, current.expiresAt) 使旧 decision 作废，重取/重判后才可能写入 | 升级 remove 后也重新判定，不能继续已撤销目标 |
| 外部普通/optional/bundled 依赖、自动 peer、新 UI/CDN external、终端脚本/编译 | 排除首版候选，不自动批准 builds/版本豁免 | 精确外部依赖也排除；不是宣称所有依赖型 DSH 包非法 |
| 插件预发布、name/version/bundle/engines/matrix 不合格或单端通过 | 不收录并保存具体原因 | Windows/麒麟取全目标交集；宿主 rc 不绕过矩阵 |
| 完整性不符、同版换包或来源不明 | 隔离并保留原证据，不覆盖旧 digest | 来源/扫描/许可未知不自动放行 |
| tarball/redirect 出内网、内部 scope 代理公网、索引/icon 用公网 | 拒绝对应生成/安装或展示引用，报告来源/资源违规 | 修复私服/静态托管，不放宽终端出口 |
| 内部定制缺 group/repo/commit/build 或 pack/display 资源 | 不收录对应候选 | 公网镜像不补内部 repo，第三方 display 缺失允许记录 fallback |
| 包移除/风险撤销 | 优先生成完整拒绝状态并关闭安装，再扫描/排除目录 | 取包阻断与已装处置独立验收，旧缓存不恢复许可 |
| r1 慢任务晚于 r2 删除/隔离完成 | 发布前发现输入或 current generation 已变，丢弃 r1/按最新输入重跑 | 不让旧任务复活包；串行取消/优先负向能力不足则 browse-only |
| 检查/发布失败或跨切换读取不一致 | 不发半份快照；拒写并重取，保留可解释旧目录 | current 只能原子切完整候选；恢复不倒退安全策略 |
| 原生/工具/CLI/local path/Git/tarball/角色覆盖不能等价 | 市场 browse-only，不开放安装 | 不靠隐藏 UI，不杜撰全局 SDK hook或全通道阻断 |
| 升级/恢复失败或安装结果未知 | 按 [DESIGN-007](<../plugins/forge-market.md#7-安装更版与恢复目标>) 核对官方结果/inventory，保留实际阶段或 unknown | 不假设原子升级，不自动重装；可选回报只幂等补投结果 |

## 8. 验收

**当前证据**：服务测试与本地 HTTP 用例已存在，覆盖旧列表/详情、共享令牌拒绝、提交/评审/撤回、计数恢复与归档安装；**不验证** npm、生成器、双端、当前授权或生产部署。参考回归入口为 `node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs`。

以下全部为待实现/待验收断言，不是旧测试已通过的事项：

| 验收输入/故障注入 | 必须观察到的结果 | 判定证据 |
|---|---|---|
| 获准源内真实自包含稳定 bundle，matrix 全目标通过 | 无运行依赖补取，自动入精确 npm 索引，sidecar/current 公共头与 digest 一致，默认最新合规版 | 实际 pack 清单/字节、CI 每候选结构/入口 smoke、两端结果及输出 schema |
| 发布包带浮动 `^`/`~`/tag 普通依赖，或带精确外部 `x.y.z` 依赖 | 两者均首版排除，不因有锁文件/私服缓存放行，不称 DSH 包非法 | packed manifest、拒绝原因与无安装副作用 |
| optional/bundleDependencies/bundledDependencies 非空、optional native deps 或单平台包 | 首版排除；不得用平台并集或自动安装 optional 包补齐 | 真实包字段、同版完整性与双端矩阵输出 |
| `autoInstallPeers: true`、缺目标已提供 peer、动态 npm fetch、新 UI external 或 CDN | 拒绝候选或保持 profile browse-only，不自动补 peer，不访问 CDN | 有效 pnpm/基线记录、静态检查、双端运行/网络证据 |
| root 安装生命周期脚本、隐式 node-gyp/终端编译 | 拒绝且不自动 approvedBuilds/版本豁免；纯源码 CI build/test 不因此拒收 | packed scripts/构建路径、负向结果与零终端脚本执行 |
| Windows 成功而麒麟失败、matrix 缺 Windows CPU/任一精确基线 | 不进入统一可安装目录；不能以当前 macOS/宿主 rc 代替目标矩阵 | 各目标检查结果；矩阵未核定则安装关闭 |
| 两获准 registry 包映射试图在同 profile 混装；registry URL/包名冲突 | 配置/安装拒绝，空 fallback，不能用每包 override/scope 偷混；存量不清理 | profile/pnpm manifest-lock 和实际 registry 计划/失败样例 |
| r1 慢扫描持旧输入；r2 删除包/隔离版本并发布拒绝状态后 r1 晚完成 | r1 不切 current、不复活包；r2 负向短任务不等全量扫描 | 最新输入 revision、base/current generation、取消与提交/丢弃日志 |
| index/policy/evidence 上传中断，或读三份时 current 切换 | current 不指半份产物；hash/revision/generation 不符拒写并重取 | 不可变对象摘要、原子切换记录、故障注入读结果 |
| 网络断开但有旧 listing 与 pnpm 缓存；或 decision 超过60秒/当前租约先到期/执行前撤销 | 可浏览标过期目录，但不新安装；decision 不超过 min(判定+60秒, current.expiresAt)，过期/变更重判失败即拒写 | no-store 当前控制请求、拒绝原因、无 manager 写操作 |
| 发布器停止但旧 current 持续可读，或注入过期/未来 generatedAt | no-store 读取不能无限续许可；最长15分钟原租约到期后新写拒绝，时钟异常拒绝 | expiresAt/可信时间核对、无续期发布与拒写样例 |
| 输入未变且健康 CI 的矩阵扫描超过15分钟 | owner 每不超过5分钟检查点完成续期，current 不因长扫描必然过期；只有自己的续期可推进候选预期代次，外部 writer/输入变化拒绝 | 长任务与续期时序、原检查时间、base/current generation 与提交/丢弃记录 |
| 每5分钟轻量续期，输入未变/已变或最新输入不可读 | 未变可复用已验证证据与 index，但新 generation/公共头一致、保留原 checkedAt；已变先关安装，不可读不续期，不重跑双端长扫描 | inputs/current复检、原子发布日志与证据时间；不新增常驻服务 |
| 撤销输入 Git 已合并但 current 未发布/入口仍见旧状态 | 不出具撤回生效回执；新 current 原子发布且受管入口复核拒写才确认对应覆盖 | 发布与受管复核回执，紧急 registry/终端撤权另记，不承诺全终端瞬时生效 |
| 私服源失败、内部缺包/公网代理、索引 HTTP redirect、公网 icon 或不可信企业 CA | 旧目录可解释，不新收候选；不回退公网/Gitee，不跟随索引 redirect，不关 TLS 校验 | 私服/静态托管/浏览器网络负向证据与缓存提示 |
| 当前风险撤销后恢复旧合规目录/候选 | 当前撤销不回退；只重验仍合规项并生成更高 generation | 当前 policyRevision/riskRevision、重验记录和新发布快照 |
| 升级 remove 失败、remove 后 install 失败/中途撤销、恢复旧版、结果 unknown | 严格按 [DESIGN-007 安装链路](<../plugins/forge-market.md#7-安装更版与恢复目标>)；目标/恢复根版本仍当前许可，不重装 unknown，不假设自动回滚 | 官方 manager/inventory 分阶段状态、当前授权复判及双端结果 |
| 内部定制 pack 丢 runtime/patch/exports/files/locale/icon；第三方仅缺 display | 前者拒收；第三方明确 title/description/通用图 fallback，不泛拒。索引 icon 只同源/相对或省略 | 真实 registry tarball/pack 文件清单、导出解析、en/zh 资源与授权依据；渲染未验不冒充通过 |
| 任意 spec/旧 spec/原生/工具/CLI/path/Git/tarball/缓存/role 绕行 | 每条受声明覆盖路径均等价拒绝未许可写；无法证明则市场 browse-only | 企业环境全通道负向样例；不能以 UI 隐藏或 registry 下载 ACL 单独证明 |
| current 从 g1 不可变 indexUrl 切到 g2；或仅续期且 indexUrl 未变 | 唯一授权 Host owner 用公开 setIndexes 只轮换企业槽位、保留其他来源，原生重新读取并发现 g2；仅续期不重复改源 | listIndexes/setIndexes 调用、changed 与配置/查询结果；不把 current 当索引 |
| UI/agent 传任意源、越权槽位新增/删除、Settings 不可用或同步失败 | 受管适配拒绝越权输入，失败保持过期浏览且禁止新写；原生直调控制另给实际覆盖证据 | 发行授权与命名空间、失败/拒绝样例、无未经授权来源写入 |
| 旧自有 JSON/Gitee 协议与计数回归 | 原字段/提交与评审体/完整错误码不变，countsPersisted 局限仍可见，不伪称 npm 统计 | 参考回归随根工程检查并审阅契约 diff；不证明新 npm 目标 |

旧测试只证明旧服务与旧契约，不证明新 npm 目标。

## 9. 企业接入与未验边界

来源、双层白名单、单 profile 单入口、自包含首版、双端交集与发布/授权行为均已确定，不再待选；以下是待取证事实，**不是企业已具备的能力声明**。

| 核验事项 | 责任方 | 截止与关闭证据 | 未验时边界 |
|---|---|---|---|
| 企业私服产品/规范 URL、企业 CA/认证注入、scope 权威路由、同步/同版不可变/保留与内网 tarball | 仓库维护方、IT、安全 | G1 接入记录；G2 缺包/重定向/同版换包/出口负向与恢复证据 | 不回退公网/Gitee，不自建 registry/proxy |
| 清单维护位置/权限与 CI/静态 HTTPS 的整任务单写、取消、优先拒绝、原子 current、5分钟轻量续期/最长15分钟租约 | 平台组、仓库与 CI/分发维护方 | 实现遵循 §3；G2 注入 r1/r2、跨切换、中断/发布器停摆与过期拒写，核验撤回回执 | 无法满足时 browse-only；具体产品实现待核验，不重新选择安全行为 |
| 企业发行 matrixId 的精确 DSH/Node/pnpm/OS-CPU/SDK/Client、profile 基线及可信时钟 | 平台组、IT | G2 全目标 smoke、manifest-lock/registry/peer/脚本/存量差异与时钟异常拒写核验 | Windows CPU 不补造，rc.2 只接口证据；未核定/时钟不可信不开放安装 |
| 内部定制 group/repo/commit/build 与公网镜像 upstream/扫描/许可、真实 pack/display | Gitee/流水线/仓库维护方、安全、平台组 | 对应包自动准入前分来源取证，真实发布包内容及资源校验 | 缺证拒收；公网不迁 Gitee，第三方 display 可标 fallback |
| 受管 no-store/60 秒复判、原生/工具/CLI/path/Git/tarball/缓存/role、下载阻断及已装处置 | 平台组、仓库维护方、IT、安全 | G2 每通道负向证据、撤销时延/在途与独立已装处置记录 | 不等价即市场 browse-only；不承诺防本机管理员/远程自动卸载 |
| 指标覆盖、保留/脱敏、可选结果回报和制品/目录恢复 | 仓库维护方、平台组、安全 | 相关展示/回报启用前冻结口径，G2 恢复证据 | 旧计数保留，不新批准 PG/IAM/账户去重；unknown 不改写 |

**非最小前置**：PostgreSQL/IAM/逐版评审后台、自建下载鉴权代理、Gitee 归档或本地 tarball 主源、在线构建与包体托管、评论/星级/多租户部门市场，均不在本次范围。

## 10. 打包与实施

交付形态是 §3 冻结契约的清单、CI/定时任务和内网静态 index+policy/evidence/current；不新增常驻审批服务、容器、PG/IAM、下载 proxy 或自造 installer/journal。现有 [server.mjs](<../../../services/market-index/server.mjs>) 不能当生产发布资产。

实施顺序：输入校验 → 自包含/矩阵/来源检查 → 原生输出 → 防陈旧单写与原子发布 → 当前授权与 `browse-only`。企业产品/认证/原子能力需核验，但不把已定安全行为重新列为待定。旧提交/评审/计数 API 独立保留，不接作 npm 来源。

本文所述“正式发布”仅指技术方案，不包含 npm 制品发布、部署、Git 提交或运行 profile 改写。

## 附录 A 当前参考实现（自有 JSON 服务）

> **可跳过。** 记录旧协议、字段与计数局限，供维护与迁移使用；不证明 npm 目标。

### A.1 旧配置草案

以下配置表是**尚未实现的历史生产草案**，不是 `server.mjs` 的配置 schema、部署承诺或目标前置；当前启动参数以[服务说明](<../../../services/market-index/README.md>)为准。

| 配置项 | 类型 | 默认值 | 必填 | 旧草案含义（未实现，非目标必填） |
|---|---|---|---|---|
| `service.listen` | string | `:8080` | 是 | 旧监听地址草案；当前 CLI 默认 loopback |
| `service.db` | string | 空 | 是 | 历史数据库连接草案；当前服务及目标最小路径都不要求它 |
| `gitee.host` | string | 空 | 是 | 旧 Gitee 主机字段；目标仅内部定制证据相关 |
| `gitee.group` | string | 空 | 是 | 旧 group 字段；不适用于公网镜像 |
| `review.required` | boolean | `true` | 否 | 历史人工评审开关，目标不采用逐版本审批 |
| `metrics.syncHours` | number | `6` | 否 | star 同步间隔草案，当前无同步任务 |

### A.2 端点

以下端点状态只描述当前参考实现，不表示 npm 或上游 format-1 兼容；规划端点返回 404。

```text title="端点"
GET  /api/plugins                  已实现；条目列表与筛选；`mine=1&submitter=` 只返回该提交方的条目与待审记录，缺 submitter 返回 400 `missing-submitter`
GET  /api/plugins/{name}           已实现；详情与版本；响应为 `{ entry }`，不提供评价聚合分
POST /api/plugins                  已实现；必填字段与 tag 校验后加入内存待审队列
GET  /api/metrics?plugin=          已实现；旧下载请求数与 star，返回计数保存能力标记、star 来源与同步时间
GET  /api/plugins/{name}/versions/{v}/download  已实现；发放 Gitee 归档地址和可空 digest，撤回版本返回 409；不代理包体
POST /api/admin/review             已实现；上架、退回、撤回
GET  /api/discover/gitee           规划；扫描专门 group 的仓库尚未实现
```

`/api/admin/*` 一律要求 `authorization: Bearer <令牌>`；服务端未配置 `adminToken`（`HELUO_MARKET_TOKEN`）时全部 401，不回退成开放。

```text title="端点（其余）"
GET  /api/admin/unindexed          已实现（返回空列表）；未收录条目与原因，供诊断视图
```

### A.3 数据模型与字段

| 实体 | 关键字段 |
|---|---|
| plugin | `name`、`title`、`summary`、`scenarios`、`maintainer`、`repo`、`status`；旧草案拟按 group 成员解析维护人，当前并未连接该接口；新发布条目填空字符串，已载入目录可带值，空值表示「未知」而非「无维护人」 |
| version | `version`、`tag`、`archiveUrl`、`engines`、`submittedAt` |
| review_task | 条目、状态、评审人、理由、时间 |
| metric | 条目、`downloads`、`stars`、`syncedAt`；参考实现返回 `countsPersisted`、`starsSource`、`starsSyncedAt` 作为口径说明 |

当前参考协议字段级约定（现有客户端与 JSON 目录按此命名；不覆盖目标 npm/upstream 字段）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 包名，条目唯一键 |
| `title` | string | 展示名；缺省与 `name` 相同 |
| `status` | string | `pending`、`listed`、`rejected`、`revoked` 之一 |
| `tag` | string | 发布标签；缺失时按 `v<version>` 推导，不得由客户端伪造 |
| `archiveUrl` | string | 归档地址，由服务端填写 |
| `engines` | string | 目标 `engines.dsh`，形如 `>=0.2.1` |
| `submittedAt` | string | ISO 8601 提交时间 |
| `revoked` | boolean | 版本已撤回；为真时不再发放归档地址，下载端点返回 409 |

### A.4 提交与评审

**提交请求体**（`POST /api/plugins`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 包名，须在受信范围 |
| `repo` | string | 是 | 仓库地址，须属于专门 group |
| `tag` | string | 是 | 形如 `v0.1.0`，与清单版本一致 |
| `summary` | string | 否 | 一句话说明，展示时按纯文本 |
| `scenarios` | string[] | 否 | 适用场景 |
| `submitter` | string | 否 | 提交方标识；仅用于「我的提交」过滤，**不是身份认证** |

`submitter` 是唯一归属线索：服务端没有账号体系，该值由调用方自报，**只能用于过滤展示**；缺 `submitter` 时返回 400，而不是退回全量。

**评审请求体**（`POST /api/admin/review`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 条目包名 |
| `action` | string | `approve`、`reject`、`revoke` |
| `version` | string | 可选；`revoke` 时给出则只撤回该版本，条目本身仍上架并可从其他版本安装 |
| `reason` | string | 可选；退回与撤回的原因，写入审计 |

`revoke` 不带 `version` 时整条下架；带 `version` 时只标记该版本（下载端点返回 409），其余版本仍可安装。响应返回 `{ name, version?, state }`。

旧 Gitee 方案原设想按仓库成员判定维护人、读取归档与 `engines.dsh`；不是 npm 目标要求。当前参考实现未连接 Gitee，新建条目维护人为空，提交只检查必填字段与 tag；`approve` 不代表包格式、摘要、来源或兼容性已核验。

**并发**：旧草案的条目发布锁尚未实现；计数按（条目, 机器哈希, 日）在内存去重，缺机器哈希时按（条目, 日），重启不保留。不能据此声称发布事务或 npm 全局计数已完成。

**超时**：旧 Gitee 扫描/调用没有接线；目标 CI 取包超时不新增候选，保留可解释失败。客户端结果未知先核对，不自动重放安装。

### A.5 格式校验码

下表保留现有 `validate.mjs` 校验码及旧内部包规范；插件自检已调用它，但当前 HTTP 服务提交/审批**并未执行完整校验**，不能把“不进索引”误认成已强制。

| 错误码 | 触发条件 | 处理 |
|---|---|---|
| `patch-unresolved-name` | insert 行名像文件（`ui/panel.js`）却缺 `./` 前缀，挂载时会被当包名解析 | 不进索引 |
| `patch-missing-target` | insert 行用 `./x` 指向 patch 旁的文件，但归档里没有该文件 | 不进索引 |
| `patch-name-mismatch` | `cordis.patch.yml` 的 insert 行名不是 `package.json` 的 `name` | 不进索引 |
| `missing-file` | 缺 `cordis.patch.yml`、`package.json` 或 `README.md`；三者必须在仓库根目录，`hint` 指出同名文件的实际位置 | 不进索引 |
| `scope-not-allowed` | 包名不在受信范围（默认 `@heluo`） | 不进索引 |
| `bad-version` \| `bad-tag` \| `tag-mismatch` | 版本非 `x.y.z`、标签非 `vX.Y.Z`、两者不一致 | 不进索引 |
| `missing-engines` \| `bad-engines` | 未声明，或写法不在 `>=`、`^`、`~`、`=`、裸版本之内 | 不进索引 |
| `install-script` | 声明了 `preinstall`、`install` 或 `postinstall` | 不进索引 |
| `missing-section` | README 缺 `## 用途` 或 `## 维护人` | 不进索引 |
| `missing-name` | `package.json` 缺 `name` | 不进索引 |
| `patch-not-array` | `cordis.patch.yml` 顶层不是数组（映射写法能过 YAML 解析，但挂载报「must be a top-level YAML array」） | 不进索引 |
| `patch-js-expr` | `cordis.patch.yml` 含 `!!js` 表达式 | 不进索引 |
| `patch-disables-row` | 补丁里出现 `disabled: true` | 不进索引 |
| `patch-overrides-protected` | 覆盖 IAM、策略、凭据、沙箱或权限预设的行 id | 不进索引 |
| `patch-include` | 使用 `cordis:include` 加载包外文件 | 不进索引 |
| `patch-unsafe-path` | 引用包外相对路径或绝对路径 | 不进索引 |

`engines.dsh` 只接受 `>=0.2.1`、`^0.2.1`、`~0.2.1`、`=0.2.1` 与裸 `0.2.1` 五种写法；`*`、`latest` 与复合区间（如 `>=0.2.0 <0.3.0`）判 `bad-engines`。`^` 与 `~` 对 `0.x` 按次版本收敛；超出范围失败为 `outside-range`，低于下限为 `requires-newer-dsh`——对用户含义不同。

`cordis.patch.yml` 会被 loader 执行，按代码对待而非配置：格式校验通过后仍要过内容规则，两者同属索引前置条件。

判定逻辑由 `packages/forge-market/src/validate.mjs` 承担；规则变更需同步该文件、本表与 `test/error-codes.test.mjs`。

### A.6 计数与持久化局限

`downloads` 是“发放归档地址次数”，**不是安装成功数**；只有启动时给了 `--counts` 才写文件，去重集合在内存，重启后同机器同日可重复计数。`stars` 来自目录文件，不写入、不同步，上架时写 0。

旧草案的访问 90 天、审计 180 天、任务 30 天仅为未批准目标，不作为保留承诺。若建设结果上报，须另定幂等、脱敏、权限与留存契约。

### A.7 参考测试

`node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs` 覆盖旧列表/详情、鉴权、提交/评审/撤回、计数恢复与本地归档安装；不覆盖 npm、生成器、双端或授权。
