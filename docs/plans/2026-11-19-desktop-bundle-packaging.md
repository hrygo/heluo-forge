# 桌面端成套打包工作计划（Electron 分发矩阵）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-026 |
| 文档名称 | 桌面端成套打包工作计划（Electron 分发矩阵） |
| 版本 | V0.8.6 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-24 |
| 确认人 | 项目负责人 |
| 确认日期 | 2026-11-23 |
| 确认事项 | 确认本计划为实施依据；代码与脚本先于 P0 探针实施，验证后置 |
| 适用范围 | 实施顺序。G0 各项在验证前保持未测，不因实现先行视为通过；本计划的门禁规则与回退预案不变 |
| 门禁 | 计划文档；统一构建（§4.0 改造清单第 1–5、7 项）、壳工程判断逻辑与品牌图标派生脚本已实现并通过离线用例，实施记录见 §4.2；P0 十项探针均未执行，远端构建链未实测，任何安装包未构建；内置运行时接入、凭据存储、Windows / Linux 自承载、`web` profile 并发、壳内认证闭环与麒麟 Electron 兼容性均以 P0 探针结论为准 |
| 交付门禁 | 统一构建链与壳工程只有离线用例及本机冒烟证据，不可分发；Electron / Chromium 及内置运行时的再分发许可、三平台壳打包链、公开仓 Secrets 统一构建链、全部 P0 探针与目标机安装均未实测 |
| 文档层级 | L2 实施计划；范围由需求基线承担，安装路径选型收敛后回写需求基线 D3 与受控架构文档 |

> 编制依据：上游打包体系参考开源仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `apps/desktop`（electron-builder，仅作构建形态与工程纪律借鉴，不进入交付）。目标 DSH 版本以根 [.dsh-version](<../../.dsh-version>)（0.2.1-rc.3）为准。本计划构成桌面分发路线与品牌定制层级的立项依据；受控文档同步留待 G0 通过后按 §4.6 执行；计划批准待 P0 探针结果后另行记录，审核 / 批准维持待定。
>
> 关联文档：[需求与场景基线](<../requirements/requirements-baseline.md>)、[公版插件、企业私有包与官方 DSH 集成方案](<../architecture/public-enterprise-bundle.md>)、[总体架构](<../architecture/platform-architecture.md>)、[推广方案](<rollout-plan.md>)、[品牌与外观详细设计](<../design/plugins/forge-brand.md>)、[品牌资产规范](<../assets/branding/cyber-long/usage.txt>)、[双端客户端分发](<../../deploy/clients/README.md>)、[DSH 插件高阶规范](<../engineering/dsh-plugin-conventions.md>)、[桌面壳详细设计](<../design/services/desktop-shell.md>)（CORP-DSH-DESIGN-025）、[#222](https://github.com/hrygo/heluo-forge/issues/222)、[#123](https://github.com/hrygo/heluo-forge/issues/123)。

## 1. 目标与范围

将「自建 Electron 壳 + 内嵌官方锁定版 dsh 运行时，企业插件与企业配置经首启装载」落地为 Windows x64、macOS 双架构与银河麒麟双架构的全平台桌面安装包，全部以河洛苍螭品牌呈现企业交付体验，并保持现行安全边界。

| 分发目标 | 包形态 | 内容 | 状态 |
|---|---|---|---|
| Windows x64 | 自建壳 NSIS 安装包（§4.3） | 自有代码 Electron 壳（本体完整河洛品牌：名称「河洛 Forge 企业版」+ 苍螭主标识）内嵌锁定版 dsh 运行时、预编译原生依赖与内置运行时（Python 与 Office 库、Node、pnpm），加载本机 `dsh --profile web`（仅绑定 `127.0.0.1`）；企业插件与配置由随包企业资产在首启时装载；GitHub Actions 构建 | 未构建 |
| macOS arm64 / x64 | 自建壳 dmg / zip | 同一壳工程的 macOS 双架构产物与首开引导（Gatekeeper 未签名首开路径按实测记录）；GitHub Actions 构建 | 未构建 |
| 银河麒麟 aarch64 / x86_64 | 自建壳 deb | 同一壳工程的麒麟双架构产物（deb 元数据、内部软件源双路径）；GitHub Actions 构建 | 未构建 |

品牌定制采用两个层级（壳本体在全平台均为自有产物）：

- **插件级外观**：实现 [forge-brand](<../design/plugins/forge-brand.md>)，经宿主品牌 seam 覆盖应用内标题栏 / 关于页显示名、Logo、主色调、默认主题与页脚；`productName` 为「河洛」；品牌缺失回退上游默认，不隐藏安全提示、审批与审计入口。
- **自有产物的完整品牌**：三平台桌面壳本体（应用名称与图标）、安装器 / dmg / deb 元数据与全部外层交付材料，统一以「河洛 Forge 企业版」呈现，使用河洛苍螭资产。

范围边界：

- 内嵌的官方 dsh 运行时制品字节原样并附摘要校验；自有壳不签名、不公证、不建自动更新 feed，升级沿用「异版本先卸载再安装」的版本收敛语义。
- 白标边界（[需求基线 N3](<../requirements/requirements-baseline.md>)）：交付物为自有壳 + 原样官方运行时；基线 N3 的约束对象为官方宿主名称 / 图标，其措辞随 G0 后同步澄清。
- 桌面客户端为单一自有壳工程覆盖全平台：不编译、不修改上游 `apps/desktop` 与 DSH 源码（不构成 fork）；壳复用 `web` profile，与终端 CLI 共享会话、配置与登录态；壳内加载本机 web profile 仅绑定 `127.0.0.1`，[需求基线 N5](<../requirements/requirements-baseline.md>) 不变；Electron 精确钉 44.7.0（指纹白名单，§3 #8）。预设预案：麒麟 Electron 探针失败时先降级版本线重试，仍 BLOCKED 则该平台恢复 web 形态 deb 兜底。
- 功能范围：系统托盘与后台驻留（关窗隐藏至托盘，运行中任务不中断；退出前确认）；内置运行时（Python 与 Office 库、Node、pnpm，首次使用时离线安装到 `$DSH_HOME`，接入方式以 §3 #9 探针结论为准）；首启企业配置初始化。企业登录在应用内完成，不设独立欢迎窗口。
- 统一构建与分发渠道：中性安装包字节不变；员工包（中性安装包 + 企业资产目录 + `INSTALL.md` + `SHA256SUMS`）由公开仓工作流从源码构建，壳首次启动时读取企业资产并初始化 `web` profile（优先自动探测安装来源目录，未探测到时由用户指定企业资产包；初始化失败不进入工作区）。员工包经下载链接分发：有仓库写权限的人从草稿 Release 下载后上传企业内网下载站，地址不进入仓库。
- Windows ARM64 不在本矩阵：基线允许其 Web 形态，过渡期继续走现有 zip 交付（路线 B）；路线 B 退役后其交付方式另行决定。
- Windows 7 不在本矩阵：Node 维护线（18 起）均不支持 Win7、Electron 23 起放弃 Win7/8/8.1、web 前端要求 Chrome 116+（`AbortSignal.any()`）而 Win7 止步 109，桌面 / CLI / 浏览器三种形态均无法运行；存量 Win7 终端升级 Win10 后纳入 S1。
- 构建入口全部为 GitHub Actions Release 流水线（见 §4.0），员工包由同一条工作流从源码构建；仓库只保存工作流与可审查的构建配置输入，产物挂草稿 Release，不入库、不公开。
- 企业配置边界：配置键存于公开仓 Actions Secrets，只提供给配置注入步骤；配置值不写入仓库、构建日志、错误体与清单。非秘密配置随员工包分发给全员，性质为交付对象可见；写入 Secrets 多出的暴露面是 GitHub 云端存储与仓库写权限协作者。客户端密钥在构建时随企业资产交付，壳首启时写入本机凭据库并删除明文副本，免除终端管理员逐台预置；员工包因此含明文密钥，能取得员工包的人都能读到，轮换密钥需重新构建并分发员工包。

### 1.1 应用标识

以下标识写入中性制品，首个安装包发布后不可更改：

| 项 | 值 | 用途 |
|---|---|---|
| appId / bundle id | `com.heluo.forge.enterprise` | 应用唯一标识与 macOS `CFBundleIdentifier` |
| Windows 升级 GUID | `3fa730a8-e95c-45dc-9724-c525f3654136` | NSIS 升级识别 |
| `productName` | `Heluo Forge Enterprise` | 可执行文件、安装目录与 app bundle 名；使用 ASCII，避免原生模块与 Python 的非 ASCII 路径问题 |
| 可执行文件名 / deb 包名 | `heluo-forge-enterprise` | Linux 可执行文件、包名与 `StartupWMClass` |
| 安装包文件名 | `heluo-forge-enterprise-<version>-<arch>.<ext>` | Release 与员工包内的安装包命名 |
| 显示名 | 河洛 Forge 企业版 | 快捷方式、开始菜单、desktop entry 与关于页 |

## 2. 现状与上游参考依据

### 2.1 本仓库现状

| # | 事实 | 证据 |
|---|---|---|
| 1 | 路线 B（zip + 启动器：npm 装锁定版 dsh、创建 web profile、插件版本收敛）已实现并有本地实测 | [集成方案 §4.2](<../architecture/public-enterprise-bundle.md>) |
| 2 | 官方桌面端只构建 macOS 与 Windows；麒麟无官方 Electron 客户端 | [推广方案事实 #5](<rollout-plan.md>) |
| 3 | Linux 沙箱链 `bwrap → Landlock → fail closed`，加固内核可能直接不可用，是麒麟准入首要验证项 | [推广方案事实 #6](<rollout-plan.md>) |
| 4 | `node-pty` 无预编译、安装时回退 `node-gyp rebuild`；麒麟需在构建机预构建 profile，避免终端编译 | [推广方案事实 #12](<rollout-plan.md>) |
| 5 | 第三方组件（Electron / Chromium 等）及内嵌 dsh npm 制品依赖的企业内再分发许可结论未出 | [集成方案 §4.2](<../architecture/public-enterprise-bundle.md>) |
| 6 | 品牌资产体系已生效（2026-10-23）：`primary/` 主标识 SVG + PNG、`sizes/` 16–1024px 标准切图、`manifest.json` SHA-256 校验清单；缺 Windows `.ico` 与 macOS `.icns` 格式，需从源文件派生 | [品牌资产规范](<../assets/branding/cyber-long/usage.txt>)、[manifest](<../assets/branding/cyber-long/manifest.json>) |
| 7 | forge-brand 仅有详细设计（模块状态：规划，无 `package.json`）；品牌信息可由插件覆盖已核验包存在性，可覆盖 token 清单与 Logo 双端解析路径未实测 | [品牌与外观详细设计](<../design/plugins/forge-brand.md>) |

### 2.2 上游打包体系参考

上游 `apps/desktop` 使用 electron-builder 打包。以下锚点作为**自建壳的构建借鉴参考**（构建配置形态、安装器参数与发布身份纪律）；上游配置文件名与参数以锁定版盘点为准，不引用浮动 main。

| 来源 | 对本计划的作用 |
|---|---|
| [锁定版打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/apps/desktop/packaging/README.md) | 安装器形态（NSIS 静默参数）与打包流程的借鉴来源 |
| electron-builder 配置入口（`apps/desktop/scripts/electron-builder-config.mjs`，见[推广方案事实 #5](<rollout-plan.md>)） | NSIS 参数、资产命名与摘要规则的 P0 盘点对象 |

## 3. 前置未决项

| # | 未决项 | 影响 | 消解阶段 |
|---|---|---|---|
| 1 | Electron / Chromium 等第三方组件的企业内再分发许可结论（盘点范围：壳链接的 Electron 二进制、内嵌 dsh npm 制品依赖与内置运行时分发包） | 自建壳分发的合法性前提；清单核对无异常即视为通过，异常项单独上报 | P0 |
| 2 | forge-brand 可覆盖 token 完整清单与 Logo 资源在桌面壳 / web 双端的解析路径（设计未决事项） | 决定品牌插件字段范围与资源分发方式；token 不可覆盖时相应外观项回退上游默认 | P0 |
| 3 | 壳 NSIS 打包链：GitHub Actions windows runner 的构建可行性、品牌图标资源嵌入与静默安装参数 | 决定 Windows 壳安装包构建脚本形态；构建主路径为 Release 流水线 CI；兜底：CI 不可行时以本地 Mac 的 makensis 离线构建 | P2 |
| 4 | SmartScreen / Gatekeeper 对未签名产物（壳本体与外层材料）的实际表现 | 记录性风险，自有壳不签名；归 [#123](https://github.com/hrygo/heluo-forge/issues/123) 取证 | P2 / P3 |
| 5 | 自助安装引导与静默参数口径（企业无统一 MDM，仅自助 + 参数文档，不随包提供批量脚本） | 决定 Windows 静默参数文档与麒麟 deb 元数据 | P2 / P4 |
| 6 | GitHub Actions 构建麒麟 arm64 / x86_64 产物（Electron 壳 deb、预构建原生依赖、内置运行时）的目标机兼容性：ubuntu runner 与麒麟 V10 SP1 的 glibc / ABI 差异需在目标机实测 | 决定壳与依赖能否由 CI 产出；不兼容时评估降级基础镜像或容器构建 | P4 |
| 7 | 外层品牌图标派生路径（SVG → `.ico` / `.icns`）：主路径为 Release 流水线 CI（windows / macos runner 跨平台工具） | 决定外层安装器与快捷方式能否使用品牌图标；兜底顺序：CI 派生失败以本地 Mac 工具重试，仍败外层回退中性命名；兜底链已于 2026-11-19 本机（macOS）实测可行——`sips` 直读 SVG（512px）、`iconutil` 产 `.icns`、node 包装器产 `.ico`，源资产 SHA-256 与 manifest 一致、目检合格；`sizes/` 缺 `app-icon` 16/32/64 切图，小尺寸由派生补齐 | P1 |
| 8 | 麒麟 V10 SP1 上 Electron 可行性：glibc 版本、chromium sandbox 在加固内核的行为、arm64 与 x86_64 双架构最小应用探针；**版本线已由本机探针收敛（2026-11-19）：dsh 0.2.1-rc.3 原生加载器带 Electron 指纹白名单 `{43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6}`，壳必须精确钉 44.7.0，`^44` 浮动解析（如 44.11.5）会被拒绝启动** | 自建桌面壳的可行性前提；macOS 开发构建已实测该机制（见 §4.5），麒麟目标机表现仍待本探针；预设预案：降级旧线仍 BLOCKED 时恢复 web 形态 deb 兜底，届时重申 | P0 |
| 9 | 内置运行时在 `web` profile 下的接入方式：Office 技能资源与 Python 解释器路径的配置入口、agent 侧 `node` / `pnpm` 的提供机制 | 决定 Office 技能与工作区依赖能力能否在不改编上游的前提下提供；无配置入口时相应能力移出范围并上报 | P0 |
| 10 | Electron 44.7.0 自承载 Node 下 `node:sqlite` 与凭据存储（值级加密、0600 密钥文件）的可用性 | 企业登录与凭据存储的前提；不可用则方案重新设计 | P0 |
| 11 | 自承载运行随包内嵌的 dsh 在 Windows 与 Linux 的可行性；dsh 运行时原生依赖（`node-pty` 等）在五个目标（win x64、mac arm64 / x64、linux arm64 / x86_64）的预编译 | 某平台不可行则该平台回退路线 B | P0 |
| 12 | 终端 CLI 与壳并发使用同一 `web` profile 的安全性（会话持久化、插件写锁、凭据库） | 不安全则壳改用独立 profile | P0 |
| 13 | 壳内认证闭环：dsh web 的 launch URL 获取方式、IAM 经系统浏览器登录后壳内会话的恢复 | 首启与登录流程的设计输入。线索（2026-11-23 静态阅读 `@deepseek-ai/dsh` 0.2.2-rc.5，非探针结论）：web 应用就绪后向 stdout 打印一行 `dsh web: <带进程令牌的认证地址>`，命令行选项含 `--host`、`--port`、`--no-open`；锁定版以探针确认 | P0 |

## 4. 阶段与门禁

各阶段出口判据齐全方可过门禁；关键项 BLOCKED 时按各阶段回退规则执行，不以部分通过宣称完成。工期为推断（按 1 名工程师与 Agent 协作），不含企业 IT 与目标环境排期等待；P2–P4 在 GB 通过后可部分并行。

| 阶段 | 内容 | 门禁 | 工期推断 |
|---|---|---|---|
| P0 | 前置验证与决策取证（许可、品牌 token、内置运行时接入、凭据存储、自承载与并发、壳内认证、麒麟 Electron） | G0 | 2 周 |
| P1 | 统一构建流水线 + 品牌定制 + 壳工程设计先行与准入 | GB | 3–4 周 |
| P2 | 壳工程核心实现（含首启企业配置、内置运行时、托盘与后台驻留）+ Windows x64 打包 | G2 | 6–8 周 |
| P3 | macOS 双架构打包 | G3 | 1 周 |
| P4 | 麒麟双架构适配与打包 | G4 | 3 周（deb、内置运行时与原生依赖的 linux 双架构产物、glibc / 沙箱实测） |
| P5 | 治理与文档闭环 | G5 | 1 周 |

### 4.0 统一构建与发布流水线（贯穿 P1–P4）

员工包由一条工作流从源码直接构建，作为资产挂在公开仓的**草稿 Release** 上并保持草稿：不上传 workflow artifact，不发布 Release，构建产物不公开。草稿 Release 仅仓库写权限协作者可见可下载；公开仓的 workflow artifact 与已发布 Release 对任何登录 GitHub 的人可见，不用于承载产物。

1. **触发**：推 `v*` tag 触发构建工作流，或在该 tag 上手动触发；tag 版本号对齐员工包版本（一个 tag = 一套制品基线），与 [.dsh-version](<../../.dsh-version>) 锁定版的对应关系、源提交与摘要清单位置写入草稿 Release 说明。
2. **CI 矩阵**：windows runner 构建 Windows x64 壳 NSIS 安装包、`.ico` 派生与 win x64 内置运行时；macos runner 构建 macOS arm64 / x64 壳 dmg / zip、`.icns` 派生与 mac 双架构内置运行时；ubuntu arm64 / x86_64 runner 构建麒麟壳 deb、预编译原生依赖与 linux 双架构内置运行时。
3. **统一构建**：构建企业插件包 → 注入企业配置 → 组装员工包（中性安装包 + 企业资产目录 + `INSTALL.md` + `SHA256SUMS`），附 SHA-256 摘要清单，作为资产挂到触发 tag 对应的草稿 Release；多 job 矩阵由一个前置 job 创建草稿、其余 job 只上传，不经 workflow artifact 在 job 间传递；内嵌的 dsh 运行时制品、内置运行时分发包与 Electron 二进制经摘要比对后方可编排进安装包。P1 完成构建、注入与企业资产，P2–P4 依次接入各平台中性安装包。
4. **配置注入**：插件不读环境变量，`.env` 只是输入格式。工作流把 `release-bundle` 环境的 Environment Secrets 中的配置键以环境变量映射交给构建脚本，构建脚本按映射表（见配置清单）转成插件配置字段，写入 patch 层中对应插件条目的 `config:`，与插件包一起构成企业资产；配置值只存在于构建进程内存，不落临时文件。签发方由 Discovery 文档提供，不注入 issuer。客户端密钥不进 patch 层：它随企业资产交付，由安装器在首启时写入本机凭据库并删除明文副本，记录名为 `clientSecretRef` 的值。配置值不写入构建日志、错误体与清单。
5. **插件加载**：企业组合包 `@heluo/forge-enterprise` 为默认安装单元，研发扩展包 `@heluo/forge-engineering` 按需加入企业资产（其补丁层不含 IAM 行，以中性 tgz 原样随包）。壳首启时委托员工包内的安装器（`init-enterprise-plugin.mjs`）完成：校验员工包完整性、安装企业插件包（`dsh plugin --profile web add <tgz>`，经自承载 Node 运行）并核对制品证据、把客户端密钥写入本机凭据库后删除明文副本。企业配置随私版 tgz 内的 `dsh.bundle.patch` 由宿主随包装载；壳是否还需向 `web` profile 写入 `cordis.patch.yml` 与企业 npm 源 / 索引 preset，待 P0 第 6 项结论后确定，在此之前不写入。任一步失败不进入工作区；已完成的首启按员工包清单摘要记录，同一员工包不再重复初始化。
6. **人工确认**：统一构建放在受保护的 GitHub 环境中，审批人批准后构建才运行；无人批准不产出员工包。
7. **交付**：有仓库写权限的人从草稿 Release 下载员工包后上传企业内网下载站，不指定固定机器，也不设内网侧预检环节；员工包附 SHA-256 摘要清单，可独立核对。工作流不发布 Release：上传时遇同名 Release 已发布即拒绝，上传后回读 Release 核对资产名与大小，不一致即报告失败。是否公开发布是另行的人工决定，没有防止误发布的技术开关。
8. **CI 纪律**：固定 Action SHA、最小权限、构建日志不含敏感值；工作流变更配套正反向用例，遵循仓库 CI 约定。
9. **公开仓写权限边界**：仅 `release-bundle` 工作流声明 `contents: write`，用于创建草稿 Release 与上传资产，其余工作流一律只读。例外按构造收窄：顶层权限仅 `contents: write` 一项，触发仅推 `v*` tag 与手动触发，检出步骤不持久化凭据；`secrets` 只以环境变量映射的形式出现在配置注入步骤，键名限定为配置清单；令牌只经环境变量提供给需要写权限的步骤。
10. **可追溯性**：员工包清单记录源提交、插件包摘要与配置键名，不记录配置值。

**统一构建改造清单**（P1 实施，先于壳构建接入）：

| # | 改造项 | 内容 |
|---|---|---|
| 1 | 工作流 | `.github/workflows/release-bundle.yml` 权限由 `contents: read` 改为 `contents: write`；内容由公版发布改为统一构建：构建企业插件包、注入配置、组装员工包、挂草稿 Release（见第 3–6 条）；检出保持 `persist-credentials: false` |
| 2 | 统一构建脚本 | 新增 `scripts/build-employee-package.mjs`：从源码构建企业插件包，按映射表注入配置，组装员工包；输出清单只含源提交、插件包摘要与配置键名。迁入映射表时厘清内网 HTTP 开关对应的插件字段（映射表写 `allowInsecureHttp`，IAM 插件配置校验定义的是 `allowInsecureClientAuthHttp`） |
| 3 | 草稿上传脚本 | 新增 `scripts/upload-draft-release.mjs`：Release 不存在则创建草稿并带 `--verify-tag`（不新建 tag），已是草稿则覆盖同名资产，已发布则拒绝且不上传；上传后回读并核对资产名与大小；令牌只读 `GH_TOKEN`，不经参数，不进错误体与回执 |
| 4 | 检查器例外 | `check:repo` 现行规则要求每个工作流声明 `contents: read`，需为 `release-bundle.yml` 增加窄例外（条件见第 9 条），其余工作流出现 `contents: write` 即失败；`secrets` 引用只允许环境变量映射形式且键名在配置清单内 |
| 5 | 用例 | `tests/check-repo.test.mjs`：例外工作流通过；其他工作流声明 `contents: write`、例外工作流多一项权限、带 PR 或分支触发、缺 `persist-credentials: false` 各自被拒；`secrets` 内联进脚本、引用配置清单之外的键各自被拒。新增 `tests/upload-draft-release.test.mjs`：新建草稿并上传、复用已有草稿、已发布时拒绝且不上传、上传后资产缺失 / 改名 / 大小不符报告失败、缺令牌、空目录与嵌套目录、创建失败、令牌不出现在参数 / 错误 / 回执。新增 `tests/build-employee-package.test.mjs`：映射表每个键的正反例、密钥不进 patch 层、清单不含配置值、员工包结构完整、issuer 与 Discovery 并存被拒 |
| 6 | Secrets 配置 | 按下方配置清单逐键配置公开仓 Actions Secrets |
| 7 | 约定文档 | [开发约定](<../engineering/development-conventions.md>)补充 `contents: write` 窄例外与 `secrets` 引用形式说明 |
| 8 | 旧流程处置 | 公版发布与私版制作的两段式流程（`build-public-release`、`make-private-bundle`、`release-delivery`）不再参与统一构建；它们是路线 B 的实现，过渡期保留作回退路径，三平台桌面端在企业真实终端验收通过后（#123）连同用例与文档一并退役，见 §4.6 |
| 9 | 验证 | 单测、变异验证（去掉写权限禁令、清单外键禁令、已发布拒绝或资产核对之一，对应用例必须失败）与 `pnpm check` 全量；远端实测在首次推 tag 时取证 |

**公开仓 Environment Secrets 配置清单**：值不写入本计划，由打包人员逐键存为 `release-bundle` 环境的 Environment Secrets，不存仓库级 Secrets——只有进入该环境的作业能读取，进入须审批。下表预留键位、注入位置与约束。

| 键 | 注入位置 | 约束 |
|---|---|---|
| `HELUO_IAM_AUTH_MODE` | `authMode` | 认证模式 |
| `HELUO_IAM_ISSUER` | 不注入 | 不配置该键：签发方由 Discovery 文档提供；与 `discoveryUrl` 并存时 IAM 插件拒绝 |
| `HELUO_IAM_DISCOVERY_URL` | `discoveryUrl` | Discovery 文档提供 issuer |
| `HELUO_IAM_REVOCATION_ENDPOINT` | `revocationEndpoint` | 完整端点地址，不带查询参数；由 IAM 方提供 |
| `HELUO_IAM_CLIENT_ID` | `clientId` | IAM 登记的客户端标识 |
| `HELUO_IAM_SCOPES` | `scopes` | 须包含 `openid` |
| `HELUO_IAM_CALLBACK_PORT` | `callbackPort` | 整数；系统分配或固定端口 |
| `HELUO_IAM_CALLBACK_ADDRESS` | `callbackAddress` | 回环回调地址 |
| `HELUO_IAM_MANAGED_MODELS_BASE_URL` | `managedModels.baseURL` | 企业网关地址 |
| `HELUO_IAM_DEFAULT_PROVIDER` | `defaultProvider` | 网关的模型路由标识 |
| `HELUO_IAM_ALLOW_INSECURE_HTTP` | 制作器校验开关（不入 patch 层） | 布尔；内网 HTTP 时启用，表示接受明文传输风险。机密模式下由制作器写入插件的 `allowInsecureClientAuthHttp: true` |
| `HELUO_IAM_CLIENT_AUTH_METHOD` | `clientAuthMethod` | 须与 IAM 登记的认证方法一致 |
| `HELUO_IAM_CLIENT_SECRET_REF` | `clientSecretRef` | 非秘密引用，标识凭据库中的客户端密钥记录 |
| `HELUO_IAM_CLIENT_SECRET` | 本机凭据库（不进 patch 层） | 随企业资产交付，壳首启时以 `client-secret set` 写入并删除明文副本 |

仓库变量：`HELUO_PUBLIC_LICENSE`（构建声明的许可，未设置时构建拒绝）、`HELUO_WITH_ENGINEERING`（`true` 时把研发扩展包加入企业资产）。

现状：`release-bundle` 尚未运行过（仓库无 `v*` tag 与 Release）；工作流的窄例外条件由 `tests/check-repo.test.mjs` 断言，远端行为（环境审批、Secrets 读取、草稿可见性）待首次推 tag 实测。

### 4.1 P0 前置验证（G0）

1. **决策立项**：本计划获批即构成桌面分发路线与品牌定制层级的立项记录；G0 通过后按 §4.6 同步受控文档，未取证前不改终态文档。
2. **内嵌制品盘点**：按 [.dsh-version](<../../.dsh-version>) 锁定版盘点 dsh npm 制品（版本、SHA-256 摘要、原生依赖清单）与 Electron 44.7.0 二进制分发物、内置运行时分发包（Python 解释器、Office 库 wheel、Node、pnpm）的来源与摘要，作为壳内嵌输入；同时盘点上游 electron-builder 配置入口与内置运行时构建器作为构建参考。
3. **再分发许可结论**：DSH 为 MIT（[总体架构](<../architecture/platform-architecture.md>)已载）；范围为壳链接的 Electron / Chromium 第三方许可、内嵌 dsh npm 制品依赖与内置运行时分发包（Python 及 Office 库、Node、pnpm），清单核对无异常即视为通过，异常项单独上报，形成书面结论。
4. **品牌 token 探针**：本机实测桌面壳与 web 双端的可覆盖品牌 token 清单、Logo 资源解析路径与缺失回退行为，关闭[品牌设计](<../design/plugins/forge-brand.md>)的两项未决事项；安全提示、审批与审计入口的可覆盖性一并取证，不得因品牌化被隐藏；部分 token 不可覆盖时接受逐项回退上游默认。
5. **麒麟 Electron 可行性探针**：银河麒麟 V10 SP1（aarch64 与 x86_64，实机或虚拟机；双架构环境已具备、可调度）运行最小 Electron 应用（精确钉 44.7.0，指纹白名单见 §3 #8），核验 glibc、chromium sandbox 与加固内核行为；结论决定麒麟双架构适配（P4）能否立项实施。
6. **内置运行时接入探针**：在 `web` profile 下实测 Office 技能资源与 Python 解释器路径的配置入口、agent 侧 `node` / `pnpm` 的提供机制；无配置入口的能力移出范围并上报。
7. **凭据存储探针**：在 Electron 自承载 Node 下实测 `node:sqlite` 与凭据的写入、读取和刷新（值级加密、0600 密钥文件）；不可用则方案重新设计。
8. **Windows / Linux 自承载探针**：实测自承载运行随包内嵌的 dsh 与 `dsh --profile web` 在 Windows 10 与 Linux 的可行性，以及运行时原生依赖在五个目标的预编译；某平台不可行则该平台回退路线 B。
9. **`web` profile 并发探针**：终端 CLI 与壳同时使用同一 `web` profile（会话读写、插件安装、登录刷新），核验持久化、写锁与凭据库行为；不安全则壳改用独立 profile。
10. **壳内认证闭环探针**：实测 dsh web 启动时 launch URL 的获取方式，以及 IAM 经系统浏览器登录后壳内会话的恢复。

**G0 出口判据**：第 2–10 项均有书面结论；第 3 项（许可）BLOCKED 时全平台壳分发不启动、目标回退路线 B（现有 zip 交付）；第 4 项部分 token 不可覆盖时相应外观项回退上游默认，不构成整体阻塞；第 6 项无配置入口的能力移出范围并上报；第 7 项不可用时全平台分发不启动；第 8 项按平台回退路线 B；第 9 项不安全时壳改用独立 profile；第 5 项经降级版本线重试仍 BLOCKED 时，麒麟按预设预案恢复 web 形态 deb 兜底并上报用户重申。

### 4.2 P1 统一构建与品牌定制（GB）

1. **forge-brand 包实现**：按[品牌与外观详细设计](<../design/plugins/forge-brand.md>)与仓库准入流程（设计已登记 → 准入核验 → 清单与测试 → 编码）实现 `@heluo/forge-brand`：配置 bundle + 本地品牌资源，`private: true`，声明 `engines.dsh`，配套正反向测试（配置校验、对比度回退、缺失回退、外链拒绝）；G0 取得的 token 清单回写设计第 5 节。
2. **品牌资源随包**：外层图标与壳图标用彩色主标 `app-icon`（`sizes/` 已有 16–1024px 标准切图），应用内 Logo 用图文组合 `wordmark-color`；内置副本与源文件保持逐字节一致并过 package-shape 测试；不使用外链资源；深浅色模式对比度按 forge-brand 设计校验。
3. **外层品牌资产派生**：在 Release 流水线 CI 内从品牌源文件（SVG）派生 Windows `.ico`（windows runner）与 macOS `.icns`（macos runner）及快捷方式所需尺寸；派生资产登记入 manifest 校验体系，源文件保持不动；CI 派生失败时以本地 Mac 工具重试，仍败外层回退中性命名（主路径 CI）。
4. **外层品牌规范**：外层安装器名称、快捷方式名称与图标、zip / `INSTALL.md`、deb 元数据统一以「河洛 Forge 企业版」呈现并沿用河洛苍螭资产规范。
5. **统一构建流水线**：按 §4.0 改造清单完成 `release-bundle` 的统一构建与草稿 Release 上传，作为后续各阶段的构建入口。

**实施记录（2026-11-23，代码先行、验证后置）**：

- 第 5 项对应 §4.0 改造清单第 1–5、7 项已实现：`.github/workflows/release-bundle.yml`、`scripts/build-employee-package.mjs`、`scripts/upload-draft-release.mjs`、`scripts/lib/release-config.mjs`（配置键清单，检查器与构建脚本共用）、`scripts/lib/repo-rules.mjs` 的窄例外，以及 `tests/check-repo.test.mjs`、`tests/build-employee-package.test.mjs`、`tests/upload-draft-release.test.mjs` 三份用例。离线证据：用例 45 项通过，18 个规则变异全部被对应用例杀死，全量离线检查通过；真实链路本机冒烟一次通过（合成配置、隔离目录）。2026-11-24：第 6 项完成——`release-bundle` 环境建立（部署分支限定 tag `v*`，经负责人裁决不设必需评审人）、两个仓库变量（`HELUO_PUBLIC_LICENSE=UNLICENSED`、`HELUO_WITH_ENGINEERING=true`）与企业配置 Environment Secrets（12 键；显式撤销端点经负责人裁决暂缺，退出撤销降级）录入完毕；首次推 tag `v0.1.0` 远端实测：环境进入、Secrets 读取、员工包构建与自检、草稿创建全部通过，资产上传因流式请求体不携带 Content-Length 被上传端点拒绝（HTTP 400 Bad Content-Length），同日修复为缓冲请求体并补回归用例（未修版本已验证失败），端到端资产交付经 `v0.1.1` 重跑核验通过（run 45377289045；员工包资产 988254 字节挂载草稿 Release，摘要独立复算一致，草稿保持待人工发布）。
- 壳工程的设计先行部分已完成：[桌面壳详细设计](<../design/services/desktop-shell.md>)（CORP-DSH-DESIGN-025）已登记设计索引；`services/forge-desktop/` 实现了不依赖 Electron 的判断模块（进程状态机、launch URL 解析与回环校验、导航与权限判定、登录 shell 环境合并、企业资产校验与首启、关窗与退出判定）和以注入接口装配的 `shell.mjs`。离线证据：47 项用例与 3 项构建—壳契约用例通过，24 个规则变异全部被对应用例杀死。壳已建 `package.json`（暂不声明依赖，锁文件只登记工作区成员）并标「状态：可用」，未接 Electron 运行，未打包。2026-11-24 按代码评审修正壳的七处问题（摘要来源不一致、符号链接逃逸、跨块解码、重复扫描、重定向处置、输出上限、错误码文案），并写明员工包的信任模型；新用例已在未修代码的隔离副本上确认会失败。
- 第 3 项（外层品牌资产派生）的脚本已具备：`scripts/derive-brand-icons.mjs` 从品牌源文件派生 Windows `.ico`、macOS `.icns` 与缺失的小尺寸切图，输入按品牌 `manifest.json` 的 SHA-256 闭环校验，派生产物另记 `derivation-manifest.json`，不改写源文件；栅格化依次尝试 `rsvg-convert` 与 `sips`，两者皆无且缺尺寸时以 `MISSING_RASTERIZER` 失败。离线证据：`tests/derive-brand-icons.test.mjs` 10 项通过；对仓库真实品牌资产的本机冒烟一次通过（`file` 识别出 6 条目的 ICO 与 ICNS，源文件零改动）。2026-11-24 资产闭环（issue #459）：`sizes/app-icon-{16,32,48,64}.png` 以 sips 派生入库，`icons/app-icon.{ico,icns}` 构建入库，六件产物全部登记 `manifest.json`（V2.1.5，261 条）；此后 8 档切图齐备，重建免栅格化器（`none-needed`），新增真实套件用例断言纯 Node 重建与入库 ico/icns 逐字节一致、任一档源图变动即偏离（判据会失败）。未做：接入 Release 流水线 CI（随第 4 项外层品牌一并接线）。
- 第 1、2 项（forge-brand 包、品牌资源随包）2026-11-24 已实现（issue #459）：`packages/forge-brand` 按设计六字段交付令牌校验与安全回退（对比度双底 ≥3:1、超长截断、外链与路径逃逸拒绝、缺失回退品牌默认），`apply` 经 `ctx.provide('forge-brand')` 暴露；`icon.svg` 与 `assets/wordmark-color.svg` 和品牌源文件逐字节一致并经品牌 manifest SHA-256 交叉校验（package-shape 测试）；16 项单元用例通过。`@heluo/forge-enterprise` 依赖闭包与补丁层中性行（不带 config）携带本包，品牌身份为包内默认，公版保持配置中性。宿主 token 消费面与 Logo 双端解析路径经负责人裁决留 GB 双端实测（缺接缝按 `HOST_SEAM_UNAVAILABLE` 降级，不影响装载）。
- 第 4 项（外层品牌规范）2026-11-24 已实现（issue #459）：员工包新增 `branding/` 目录——ico/icns、8 档 PNG 与 `wordmark-color.svg` 经品牌 manifest 逐件校验后复制（与源逐字节一致），并写入 `app-identity.json` 应用标识五元组（appId `com.heluo.forge.enterprise`、升级 GUID、productName、可执行名、显示名「河洛 Forge 企业版」）；`INSTALL.md` 标题与启动器文案统一品牌呈现（Windows 启动器用 ASCII `Heluo Forge Enterprise` 规避代码页风险）。品牌套件整体缺失时降级省略 `branding/`（GB 判据：不阻塞插件级品牌化），存在但登记不符则拒绝构建。员工包清单记录品牌材料来源（manifest 版本、身份五元组与文件名）。快捷方式创建与 deb 元数据落地属 P2 壳打包（electron-builder 消费 `branding/` 与身份真源），本项交付其全部品牌材料。

**P2 一期实施记录（2026-11-24，issue #463）**：

- 第 1 项的工具链面：`services/forge-desktop` devDependencies 精确钉 `electron@44.7.0` 与 `electron-builder@26.0.12`（package-shape 断言拒绝 `^`/`~` 浮动与运行时依赖，含变异证明）；工作区 override 把 `@electron/node-gyp` 的 git 引用钉回 npm 发布版，`onlyBuiltDependencies` 只放行 electron 二进制下载。`src/layout.mjs` 抽出资源布局常量，main.mjs 与暂存工具共享（package-shape 断言 main.mjs 不得内联资源路径）。
- 第 2 项的暂存面：`scripts/stage-desktop-payload.mjs` 按 `runtime-lock.json` 台账（dsh 0.2.1-rc.3 SHA-256）核验制品后以 npm 前缀安装**依赖闭包**（dsh 非自包含单文件包，裸 tgz 缺 `@deepseek-ai/dsh-app-boot` 等同版本锁定依赖），托盘图标经品牌 manifest 校验复制，员工资产按 ASSETS_DIR 暂存；`tests/stage-desktop-payload.test.mjs` 以可注入安装器离线验证布局双向契约（4 项）。
- 第 7 项的配置面：`scripts/build-desktop-installer.mjs` 从员工包 `branding/app-identity.json` 生成 electron-builder 配置（appId/GUID/productName/可执行名/产物名逐字段来自身份真源，图标用品牌 ico/icns，NSIS x64 目标就绪）；`tests/build-desktop-installer.test.mjs` 4 项含身份篡改偏离判据。
- 集成冒烟（mac 本机，设计 §10 集成层首次执行）：`--dir` 构建出 `heluo-forge-enterprise.app`（未签名）；真实 Electron 启动后单实例锁生效，首启经包内安装器在沙箱 DSH_HOME 建 web profile 并装入 `@heluo/forge-enterprise` 0.1.2-corp.1（安装证据 `.heluo-enterprise-install.json` 含双摘要），止步 IAM Discovery（企业内网地址不可达，设计内降级且密钥保留）；预写首启标记直启后，内嵌 dsh 以 `--profile web --host 127.0.0.1 --no-open` 运行并监听 `127.0.0.1:3080`，渲染进程 `--enable-sandbox`。过程中修正两个实际缺陷：暂存前缀目录取值（闭包安装语义）与本机环境泄漏 `ELECTRON_RUN_AS_NODE` 导致的静默 node 态。
- 未做：NSIS windows-runner 流水线接线、离线 Win10 x64 VM 验收（第 7/8 项主体）、内置 pnpm/Node 工具链与 Python/Office 库（第 4 项，接 P0 #9 探针）、真实企业网络 IAM 登录与托盘/退出 GUI 交互取证、资产探测失败后的用户指定入口（第 3 项局部）。
- 首启装配缺陷修复（2026-11-25，干净环境首次真实首启暴露）：`shell.mjs` 把 `loadInstaller(...)`（main.mjs 经动态 import 返回 `Promise<runInit>`）未经 await 传入 `initializeProfile`，函数守卫按 `BAD_ARGUMENT` 拒绝并弹框，应用无法启动。此前冒烟因「预写首启标记 + 安装器终端单独驱动」恰好绕过该集成路径。修复为 `runInit: await loadInstaller(...)`；回归用例先行（以 main.mjs 同形的 Promise 型 loader 驱动装配层，未修版本必挂、修复后通过），装配层 58 项用例全绿。

**口径确认（2026-11-24，项目负责人逐条确认）**：企业配置存为 `release-bundle` 环境的 Environment Secrets；配置值只存在于构建进程内存；研发扩展包以中性 tgz 按需随包；包内私版插件版本为 `<tag 版本>-corp.1`；「其余工作流一律只读」执行为禁止 `contents: write`，不扩展到现有工作流的其他写权限；品牌图标派生沿用既有实现；壳先建清单并标「可用」，清单暂不声明依赖，验证后置；首启的 `cordis.patch.yml` 写入留待 P0 第 6 项。

**GB 出口判据**：`release-bundle` 统一构建通过 `pnpm check` 并完成首次推 tag 远端实测（含环境审批与 Secrets 读取） + forge-brand 双端外观覆盖实测通过（含缺失回退）+ 外层派生资产经 manifest 校验 + 安全提示 / 审批 / 审计入口未被品牌化隐藏。外层图标派生失败时仅外层材料回退中性命名，不阻塞插件级品牌化。

### 4.3 P2 壳工程核心实现与 Windows x64 打包（G2）

1. **壳工程立项与实现**：按「设计先行 → 准入核验 → 清单与测试 → 编码」在 `services/` 建立全平台壳工程：Electron 精确钉 44.7.0（package-shape 断言拒绝 `^` / `~` 浮动）；`ELECTRON_RUN_AS_NODE` 自承载内嵌 dsh（macOS 开发构建已实测，见 §4.5）；`--no-open` 防双开、仅绑定 `127.0.0.1`（配置层白名单拒绝其他值）、单实例锁、launch URL 认证、子进程退出清理与端口冲突处理（状态机显式：spawning → ready → stopped，不确定保持 pending）；GUI 进程补 PATH；登录 shell 环境读取（GUI 进程环境与用户启动文件合并，参考上游 `<shell> -ilc` 机制）；完整河洛品牌（`app-icon` 切图）；配套正反向测试。
2. **内嵌载荷**：锁定版 dsh 运行时（npm 制品原样 + SHA-256 校验）+ 预编译原生依赖（避免终端 `node-gyp rebuild`）；企业插件、企业 npm 源 / 索引 preset 与配好的 `cordis.patch.yml` 属于企业资产，由首启企业配置装载。
3. **首启企业配置初始化**：首次启动时读取企业资产（优先自动探测安装来源目录，未探测到时由用户指定企业资产包），校验员工包完整性后委托员工包内的安装器依次完成密钥入库（`client-secret set`）、安装企业插件（`dsh plugin --profile web add`，经内嵌 pnpm，由自承载 Node 运行）与制品证据核对；企业配置随私版 tgz 的 `dsh.bundle.patch` 装载；`cordis.patch.yml` 与企业 npm 源 / 索引 preset 的写入待 P0 第 6 项结论后接入。每步幂等，任一步失败时不进入工作区，密钥入库后删除明文副本。
4. **内置运行时**：随包携带 Python 与 Office 库、Node、pnpm 的分发包，带版本清单与哈希；首次使用时离线安装到 `$DSH_HOME`，接入方式按 §3 #9 探针结论实现。
5. **托盘与后台驻留**：系统托盘常驻；关窗隐藏至托盘，运行中任务不中断；退出前确认（任务状态可查询时按状态提示，否则一律提示）；macOS 沿用 Dock 生命周期。
6. **安全基线**：渲染进程启用 `contextIsolation` 与 sandbox，关闭 `nodeIntegration`；`will-navigate` 与 `window.open` 只放行回环地址，其余链接交给系统浏览器；麦克风、摄像头、通知等权限请求默认拒绝；preload 仅暴露最小接口。
7. **Windows 打包**：electron-builder 产出 NSIS 安装包（Release 流水线 windows runner，§4.0 中性制品）；应用标识按 §1.1；品牌图标嵌入；静默安装参数实测并产出文档（仅自助安装口径，不随包提供批量脚本）。
8. **验收**：离线 Windows 10 x64 虚拟机执行安装、首启企业配置、客户端密钥入库与明文删除、企业登录（IAM 联调另计）、Office 技能与工作区依赖、托盘与后台驻留、退出确认、与终端 CLI 并发、企业插件挂载、品牌外观（壳本体与应用内）、升级（异版本先卸载再装）、回退与数据保留（[#123](https://github.com/hrygo/heluo-forge/issues/123) 范围）；SmartScreen 未签名首开表现记录与绕过图文。

**G2 出口判据**：离线 VM 端到端通过（含首启企业配置、内置运行时、托盘与后台驻留、品牌核验）+ NSIS 构建链结论 + 参数表；企业真实终端另按 #123 验收。

### 4.4 P3 macOS 双架构打包（G3）

1. **双架构产物**：同一壳工程经 Release 流水线 macos runner 产出 arm64 / x64 dmg 与 zip（中性制品）；`INSTALL.md` 首开引导附 Gatekeeper 未签名警告绕过图文。
2. **双架构取证**：Apple Silicon 本机与 Intel（远程或虚拟机）分别安装取证；首启企业配置、插件挂载、品牌外观与升级收敛同 G2 判据；核验 Dock 启动下的登录 shell 环境读取。
3. **未签名功能边界核验**：自有壳不签名不公证，核验 TCC 依赖能力（麦克风等）的实际可用性，结论写入交付边界；凭据边界不变——不使用系统钥匙串，保持 SQLite 值级 AES-256-GCM 与 0600 密钥文件（S9 / N2）。

**G3 出口判据**：双架构安装、插件挂载与品牌外观证据齐备；Gatekeeper 首开表现与未签名功能边界已记录（不公证）。

### 4.5 P4 麒麟双架构适配与打包（G4）

1. **形态与落位**：全平台壳工程（P2 建立）的麒麟双架构平台层；不编译官方 `apps/desktop` 的 Linux 目标、不修改 DSH 源码，不构成 fork。平台层职责：deb 元数据与内部软件源（apt）双路径、`systemd --user` 自启动。
2. **壳职责**：BrowserWindow 加载本机 `dsh --profile web`（仅绑定 `127.0.0.1`）；管理 dsh 子进程生命周期（启动、launch URL 与进程凭据读取、退出清理、端口冲突、单实例）；应用本体完整河洛品牌——名称「河洛 Forge 企业版」、图标用彩色主标 `app-icon` 的 `sizes/` 标准 PNG 切图；内嵌锁定版 dsh 运行时（原生依赖预编译，避免终端 `node-gyp rebuild`）。**2026-11-19 macOS 开发构建实测**（探针性质，麒麟目标机另证）：以 `ELECTRON_RUN_AS_NODE` 自承载运行随包内嵌的 dsh 可行；Electron 须精确钉 44.7.0（指纹白名单）；`dsh plugin` 经 pnpm 转发安装，GUI 进程须补 PATH；dsh web 默认自动拉起系统浏览器，壳内须传 `--no-open` 防双开；企业组合包 `plugin add` 后 `plugin list` 可见、web 服务仅回环监听、窗口正常渲染。
3. **构建与分发**：麒麟 deb 经 Release 流水线（§4.0）由 GitHub Actions 构建 arm64 与 x86_64 产物；CI 产出中性制品（壳、预构建依赖、内置运行时、deb 骨架），麒麟员工包由同一流水线的统一构建产出（§4.0）；CI 遵循固定 Action SHA 与最小权限；ubuntu runner 产出的壳、内置运行时（Python 与 Office 库 wheel）与原生依赖和麒麟 V10 SP1 的 glibc / ABI 兼容性在目标机实测，不兼容时换老版本基础镜像 / 容器重试，仍败触发 web 兜底预案。企业内部软件源（apt）与文件交付双路径：apt 安装的壳在首次启动时由用户指定企业资产包；静默安装参数文档。
4. **验收**：银河麒麟 V10 SP1 aarch64 与 x86_64 实机：安装、自启动、首启企业配置、企业插件挂载、品牌外观（壳本体与应用内）、内置运行时、沙箱链 `bwrap → Landlock` 准入、凭据隔离、升级与回退（[#123](https://github.com/hrygo/heluo-forge/issues/123) 范围）。

**G4 出口判据**：双架构实机端到端通过，且 P0 Electron 兼容性结论在成品上复验；沙箱链准入结论明确（不可用即按 fail closed 记录目标缺口，不降级放行）。

### 4.6 P5 治理与文档闭环（G5）

1. **受控文档同步**（以实测为准）：[集成方案](<../architecture/public-enterprise-bundle.md>)落档桌面分发路线、许可结论与「公开构建不接收企业配置」约束的改写（配置键经公开仓 Actions Secrets 提供给配置注入步骤），以及路线 B（现有 zip 交付）与两段式制作流程在三平台桌面端通过企业真实终端验收后退役的落档；[需求基线](<../requirements/requirements-baseline.md>) D3 记录安装路径选择；[品牌与外观详细设计](<../design/plugins/forge-brand.md>)回写实测 token 清单与模块状态；[双端客户端分发](<../../deploy/clients/README.md>)更新资产状态；[设计索引 §2.2](<../design/README.md#22-实现与验证入口>)登记各模块实测记录。
2. **版本与更新责任矩阵**：宿主版本以 [.dsh-version](<../../.dsh-version>) 为真源，发布 tag（`v*`）版本号对齐员工包版本，并与宿主版本对应关系成表；插件升级 / 回退沿用交付版本收敛语义；内嵌 dsh 运行时版本与壳包版本的对应关系成表。
3. **台账对接**：各目标环境验收状态接入 [#123](https://github.com/hrygo/heluo-forge/issues/123)，未实测标 NOT RUN、受阻标 BLOCKED。

## 5. 工程约束与验收判据

- 构建入口为 GitHub Actions Release 流水线：产物与 SHA-256 摘要作为资产挂 draft Release 并保持草稿；产物不入库、不公开，不上传 workflow artifact。企业配置只以 `release-bundle` 环境的 Environment Secrets 经环境变量映射提供给配置注入步骤，只存在于构建进程内存，不落临时文件，不进仓库、构建日志、错误体与回执。
- 配置注入的键以检查器白名单约束：仅允许 §4.0 配置清单中的键，引用清单之外的键即 `check:repo` 失败。
- 公开仓不承载公开产物：构建产物只存在于草稿 Release 与企业内网下载站；仅 `release-bundle` 声明 `contents: write`，其余工作流一律只读。
- 内嵌官方 dsh 运行时制品字节原样，交付物内提供可独立核对的摘要；自有壳不签名，完整性以摘要校验为准。
- 品牌约束：插件与外层资产从品牌源文件派生并纳入 manifest SHA-256 校验，内置图标与源文件逐字节一致（package-shape 测试）；品牌化不隐藏、不弱化安全提示、审批与审计入口；品牌缺失一律回退上游默认，不出现空 Logo 或空名称。
- 新增脚本与 forge-brand 包必须配套正反向测试，`pnpm check:docs`、`pnpm check:repo`、`pnpm check:version` 全绿。
- 事实纪律：已构建不等于已验收；各包状态如实标注（未构建 / 已构建未验证 / 目标环境已验收），不虚构企业环境结论。

| 分发目标 | 构建判据 | 安装判据 | 运行判据 |
|---|---|---|---|
| 品牌定制（跨包） | forge-brand 含正反向测试 + 外层资产过 manifest 校验 | 外层材料品牌呈现一致 | 应用内品牌外观生效且缺失可回退，三平台壳本体完整品牌；安全入口未被隐藏 |
| Windows x64 | 壳工程正反向测试 + NSIS 构建链结论 + 内嵌制品摘要校验 | 离线 VM 静默安装与卸载 / 升级 / 回退通过 + 静默参数文档 | 首启企业配置 + 企业插件实际挂载 + 壳与应用内品牌生效 + 托盘与后台驻留 + 内置运行时可用 + 企业登录可用（IAM 联调另计） |
| macOS 双架构 | dmg / zip 构建可重复 + 摘要校验 | 双架构安装取证 + Gatekeeper 首开记录 | 首启企业配置 + 插件挂载 + 壳与应用内品牌生效 + 内置运行时可用 + S9 凭据边界不变 + 未签名功能边界记录 |
| 麒麟双架构 | 壳工程含正反向测试 + GitHub Actions 构建可重复 + Electron 兼容探针通过 | 实机 deb 安装 + 自启动 | 首启企业配置 + 仅回环 + 插件挂载 + 壳与应用内品牌生效 + 内置运行时可用 + 沙箱链准入 + 凭据隔离 |

## 6. 待核验事项

| 事项 | 责任与处理 |
|---|---|
| 第三方组件再分发许可 | 仅盘点壳链接的 Electron / Chromium 第三方许可与内嵌 dsh npm 制品依赖；清单核对无异常即通过，异常项单独上报 |
| 品牌 token 清单与 Logo 双端解析路径 | P0 本机探针并回写品牌设计；接受逐项回退上游默认 |
| 外层图标派生（SVG → `.ico` / `.icns`）工具链 | P1 于 Release 流水线 CI 内派生；失败以本地 Mac 工具重试，仍败回退中性命名；本地兜底链已实测可行（sips / iconutil / node 包装器，详见 §3 #7） |
| Release 流水线可行性与产物完整性（tag 触发、草稿 Release 挂载、资产核对、环境审批、Secrets 读取） | P1 首次推 tag 实测并作为后续各阶段统一构建入口：草稿对无写权限账号不可见、有仓库写权限的账号可下载、重跑覆盖同名资产、无审批不产出员工包、Secrets 仅配置注入步骤可读；固定 Action SHA 与最小权限按仓库 CI 约定 |
| NSIS 构建链（CI windows runner 可行性、品牌图标嵌入、静默参数） | P2 实测；构建主路径为 Release 流水线 CI，兜底本地 Mac 的 makensis 离线构建；本机盘点 makensis 未安装，本地兜底需先安装（如 brew） |
| 自助安装引导与批量部署口径 | 无 MDM；仅自助 + 静默参数文档，不随包提供批量脚本；P2 产出参数文档 |
| SmartScreen / Gatekeeper 表现 | P2 / P3 记录，归 #123 取证，自有壳不签名；首开引导附警告绕过图文 |
| 麒麟 Electron 兼容性（glibc / chromium sandbox / 双架构） | P0 最小应用探针（精确钉 44.7.0）；仍 BLOCKED 则恢复 web 形态 deb 兜底并上报重申 |
| GitHub Actions 麒麟构建与目标机兼容性（glibc / ABI、沙箱链准入） | P4 实测；不兼容时降级基础镜像 / 容器重试，仍败触发 web 兜底 |
| 企业真实终端验收 | 全部归 #123 按目标环境独立验收 |
| 内置运行时在 `web` profile 下的接入方式 | P0 探针；无配置入口的能力移出范围并上报 |
| 自承载 Node 下的凭据存储（`node:sqlite`） | P0 探针；不可用则方案重新设计 |
| Windows / Linux 自承载与五目标原生依赖预编译 | P0 探针；按平台回退路线 B |
| `web` profile 并发（终端 CLI 与壳） | P0 探针；不安全则壳改用独立 profile |
| 壳内认证闭环（launch URL、IAM 登录后的会话恢复） | P0 探针；结论作为首启与登录流程的设计输入 |
| 统一构建在 Linux runner 上的运行 | P1 首次推 tag 实测：构建企业插件包、注入配置、组装员工包、环境审批全链路通过 |
| Discovery 预检 | runner 访问不到企业 IAM，构建时不做，也不设固定补做环节；交付回执记为未核验，首次企业登录实测时一并验证 |
| 撤销端点兼容性 | P1 实测：`revocationEndpoint` 指向的端点可用，退出后访问令牌失效 |
| 客户端密钥的首启入库 | P2 实测：首启后密钥可用于企业登录，明文副本已删除 |
