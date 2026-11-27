# 桌面端成套打包工作计划（Electron 分发矩阵）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-026 |
| 文档名称 | 桌面端成套打包工作计划（Electron 分发矩阵） |
| 版本 | V0.8.12 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-27 |
| 确认人 | 项目负责人 |
| 确认日期 | 2026-11-23 |
| 确认事项 | 确认本计划为实施依据；代码与脚本先于 P0 探针实施，验证后置 |
| 适用范围 | 实施顺序。G0 各项在验证前保持未测，不因实现先行视为通过；本计划的门禁规则与回退预案不变 |
| 门禁 | 计划文档；统一构建（§4.0 改造清单第 1–7 项）、壳工程逻辑与装配层、载荷暂存（去重/闭包校验，暂不设体积上限）、多架构安装包配置、内置运行时暂存/解锁补丁及品牌图标闭环已实现并通过离线用例，macOS 本机完成 Electron 44.7.0 自承载、载荷 pnpm（包操作与 agent 共用同一份）、`node:sqlite` 写入、内置运行时探针（P0 #6 mac 本机结论）与 `0.2.2-rc.5` 接缝离线核验，远端 `release-bundle` 已接入 mac-arm64 与 win-x64 草稿构建；仍未实测或未出书面结论项：第三方再分发许可书面结论、内置运行时 Windows / Linux 载荷与运行、Windows / Linux 自承载与 VM 安装验收、独占 profile `heluo-desktop` 与固定端口的真机冒烟、载荷 Node+pnpm 包操作的真机首启复测、真实企业 IAM 联调与麒麟 Electron 兼容性 |
| 交付门禁 | 统一构建链与壳工程只有离线用例、macOS 本机冒烟及 CI 草稿构建证据，不可正式分发；Electron / Chromium 及内置运行时的再分发许可书面结论、三平台目标机实测验收均未完成 |
| 文档层级 | L2 实施计划；范围由需求基线承担，安装路径选型收敛后回写需求基线 D3 与受控架构文档 |

> 编制依据：上游打包体系参考开源仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `apps/desktop`（electron-builder，仅作构建形态与工程纪律借鉴，不进入交付）。目标 DSH 版本以根 [.dsh-version](<../../.dsh-version>)（0.2.2-rc.5）为准（历史 2026-11-19 探针曾基于 `0.2.1-rc.3` 开展）。本计划构成桌面分发路线与品牌定制层级的立项依据；受控文档同步留待 G0 通过后按 §4.6 执行；计划批准待 P0 探针结果后另行记录，审核 / 批准维持待定。
>
> 关联文档：[需求与场景基线](<../requirements/requirements-baseline.md>)、[公版插件、企业私有包与官方 DSH 集成方案](<../architecture/public-enterprise-bundle.md>)、[总体架构](<../architecture/platform-architecture.md>)、[推广方案](<rollout-plan.md>)、[品牌与外观详细设计](<../design/plugins/forge-brand.md>)、[品牌资产规范](<../assets/branding/cyber-long/usage.txt>)、[双端客户端分发](<../../deploy/clients/README.md>)、[DSH 插件高阶规范](<../engineering/dsh-plugin-conventions.md>)、[桌面壳详细设计](<../design/services/desktop-shell.md>)（CORP-DSH-DESIGN-025）、[#222](https://github.com/hrygo/heluo-forge/issues/222)、[#123](https://github.com/hrygo/heluo-forge/issues/123)。

## 1. 目标与范围

将「自建 Electron 壳 + 内嵌官方锁定版 dsh 运行时，企业插件与企业配置经首启装载」落地为 Windows x64、macOS arm64 与银河麒麟双架构的全平台桌面安装包，全部以河洛苍螭品牌呈现企业交付体验，并保持现行安全边界。

| 分发目标 | 包形态 | 内容 | 状态 |
|---|---|---|---|
| Windows x64 | 自建壳 NSIS 安装包（§4.3） | 自有代码 Electron 壳（本体完整河洛品牌：名称「河洛 Forge 企业版」+ 苍螭主标识）内嵌锁定版 dsh 运行时、预编译原生依赖与内置运行时（Python 与 Office 库、Node、pnpm），加载本机 `dsh --profile heluo-desktop`（仅绑定 `127.0.0.1` 的固定端口 30810）；企业插件与配置由随包企业资产在首启时装载；GitHub Actions 构建 | CI 草稿已接入；VM 与实机未验收 |
| macOS arm64 | 自建壳 dmg / zip | Apple Silicon 安装包与首开引导（Gatekeeper 未签名首开路径按实测记录）；GitHub Actions 构建 | CI 草稿已接入，目标机验收待完成 |
| 银河麒麟 aarch64 / x86_64 | 自建壳 deb | 同一壳工程的麒麟双架构产物（deb 元数据、内部软件源双路径）；GitHub Actions 构建 | 脚本支持 `--arch`；CI 与实机未验收 |

品牌定制采用两个层级（壳本体在全平台均为自有产物）：

- **插件级外观**：实现 [forge-brand](<../design/plugins/forge-brand.md>)，经宿主品牌 seam 覆盖应用内标题栏 / 关于页显示名、Logo、主色调、默认主题与页脚；`productName` 为「河洛」；品牌缺失回退上游默认，不隐藏安全提示、审批与审计入口。
- **自有产物的完整品牌**：三平台桌面壳本体（应用名称与图标）、安装器 / dmg / deb 元数据与全部外层交付材料，统一以「河洛 Forge 企业版」呈现，使用河洛苍螭资产。

范围边界：

- 内嵌的官方 dsh 运行时制品字节原样并附摘要校验；自有壳不签名、不公证、不建自动更新 feed，升级沿用「异版本先卸载再安装」的版本收敛语义。
- 白标边界（[需求基线 N3](<../requirements/requirements-baseline.md>)）：交付物为自有壳 + 原样官方运行时；基线 N3 的约束对象为官方宿主名称 / 图标，其措辞随 G0 后同步澄清。
- 桌面客户端为单一自有壳工程覆盖全平台：不编译、不修改上游 `apps/desktop` 与 DSH 源码（不构成 fork）；壳独占 `heluo-desktop` profile，不读写终端的 `web` profile，与终端 CLI 共享 `$DSH_HOME` 下的会话与登录态（profile 级设置各自保存）；壳内加载本机服务仅绑定 `127.0.0.1` 的固定端口 30810，[需求基线 N5](<../requirements/requirements-baseline.md>) 不变；Electron 精确钉 44.7.0（指纹白名单，§3 #8）。预设预案：麒麟 Electron 探针失败时先降级版本线重试，仍 BLOCKED 则该平台恢复 web 形态 deb 兜底。
- 功能范围：系统托盘与后台驻留（关窗隐藏至托盘，运行中任务不中断；退出前确认）；内置运行时（Python 与 Office 库、Node、pnpm，首次使用时离线安装到 `$DSH_HOME`，接入方式以 §3 #9 探针结论为准）；首启企业配置初始化。企业登录在应用内完成，不设独立欢迎窗口。
- 统一构建与分发渠道：中性安装包字节不变；员工包（中性安装包 + 企业资产目录 + `INSTALL.md` + `SHA256SUMS`）由公开仓工作流从源码构建，壳首次启动时仅自动探测随包内嵌或同目录的 `enterprise-assets/` 并初始化 `heluo-desktop` profile（不设用户手动指定外部资产路径入口；初始化失败停在本地引导页并支持托盘重试，不进入工作区）。员工包经下载链接分发：有仓库写权限的人从草稿 Release 下载后上传企业内网下载站，地址不进入仓库。
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
| [历史锁定版打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/apps/desktop/packaging/README.md) | 安装器形态（NSIS 静默参数）与打包流程的历史参考来源（当前基线以 `.dsh-version` 为准） |
| electron-builder 配置入口（`apps/desktop/scripts/electron-builder-config.mjs`，见[推广方案事实 #5](<rollout-plan.md>)） | NSIS 参数、资产命名与摘要规则的 P0 盘点对象 |

## 3. 前置未决项

| # | 未决项 | 影响 | 消解阶段 |
|---|---|---|---|
| 1 | Electron / Chromium 等第三方组件的企业内再分发许可结论（盘点范围：壳链接的 Electron 二进制、内嵌 dsh npm 制品依赖与内置运行时分发包） | 自建壳分发的合法性前提；清单核对无异常即视为通过，异常项单独上报 | P0 |
| 2 | forge-brand 可覆盖 token 完整清单与 Logo 资源在桌面壳 / web 双端的解析路径（设计未决事项） | 决定品牌插件字段范围与资源分发方式；token 不可覆盖时相应外观项回退上游默认 | P0 |
| 3 | 壳 NSIS 打包链：GitHub Actions windows runner 的构建可行性、品牌图标资源嵌入与静默安装参数 | 决定 Windows 壳安装包构建脚本形态；构建主路径为 Release 流水线 CI（`desktop-windows` 已接入且已配置 `deleteAppDataOnUninstall: false`），VM 安装与静默参数待实测；兜底：CI 不可行时以本地 Mac 的 makensis 离线构建 | P2 |
| 4 | SmartScreen / Gatekeeper 对未签名产物（壳本体与外层材料）的实际表现 | 记录性风险，自有壳不签名；归 [#123](https://github.com/hrygo/heluo-forge/issues/123) 取证 | P2 / P3 |
| 5 | 自助安装引导与静默参数口径（企业无统一 MDM，仅自助 + 参数文档，不随包提供批量脚本） | 参数口径已写入 [deploy/clients/README.md](../../deploy/clients/README.md)；VM 实测与麒麟 deb 元数据待验收 | P2 / P4 |
| 6 | GitHub Actions 构建麒麟 arm64 / x86_64 产物（Electron 壳 deb、预构建原生依赖、内置运行时）的目标机兼容性：ubuntu runner 与麒麟 V10 SP1 的 glibc / ABI 差异需在目标机实测 | 决定壳与依赖能否由 CI 产出；不兼容时评估降级基础镜像或容器构建 | P4 |
| 7 | 外层品牌图标派生路径（SVG → `.ico` / `.icns`）：主路径为仓内预派生入库 + `manifest.json` SHA-256 逐字节校验 | **2026-11-24 已闭环**：8 档切图与 `.ico` / `.icns` 已入库并登记 `manifest.json`（V2.1.5）；`build-desktop-installer.mjs` 直接校验消费仓内图标，不再要求 CI 动态派生；`derive-brand-icons.mjs` 保留用于源资产更新时本地重建 | P1（已闭环） |
| 8 | 麒麟 V10 SP1 上 Electron 可行性：glibc 版本、chromium sandbox 在加固内核的行为、arm64 与 x86_64 双架构最小应用探针；**Electron 44.7.0 兼容性已在 `0.2.2-rc.5` 复核（2026-11-26）：`@deepseek-ai/dsh@0.2.2-rc.5` 依赖的 `node-addon-require-builtin-darwin-arm64@0.1.10` 白名单含 `{43.0.0, 44.0.0, 44.7.0, 44.11.5, 45.0.0-alpha.6}`（承接 2026-11-19 `0.2.1-rc.3` 探针），壳继续精确钉 `44.7.0`** | 自建桌面壳的可行性前提；macOS 开发构建已实测该机制，麒麟目标机表现仍待本探针；预设预案：降级旧线仍 BLOCKED 时恢复 web 形态 deb 兜底，届时重申 | P0 |
| 9 | 内置运行时在 `web` profile 下的接入方式：Office 技能资源与 Python 解释器路径的配置入口、agent 侧 `node` / `pnpm` 的提供机制 | 决定 Office 技能与工作区依赖能力能否在不改编上游的前提下提供；无配置入口时相应能力移出范围并上报。**已收敛（2026-11-26 mac 本机，DSH 0.2.2-rc.5）**：有配置入口——上游 `web` profile 的补丁层已有 `workspace-dependencies` 与 `skill-office` 两行，只对名为 `desktop` 的 profile 打开，企业底座按 id 覆盖后对 `web` profile 生效；agent 侧的 node 与 pnpm 由 `load_workspace_dependencies` 返回绝对路径，不改 PATH。证据见[验证记录](<../design/verification/desktop-primary-runtime.md>) | P0 |
| 10 | Electron 44.7.0 自承载 Node 下 `node:sqlite` 与凭据存储（值级加密、0600 密钥文件）的可用性 | **macOS 本机已实测（2026-11-25）：`credentials.sqlite` 可写且密钥入库成功**；Windows / Linux 实机仍待验证，不可用则方案重新设计 | P0 |
| 11 | 自承载运行随包内嵌的 dsh 在 Windows 与 Linux 的可行性；dsh 运行时原生依赖（`node-pty` 等）在四个目标（win x64、mac arm64、linux arm64 / x86_64）的预编译 | 某平台不可行则该平台回退路线 B | P0 |
| 12 | 终端 CLI 与壳并发使用同一 `web` profile 的安全性（会话持久化、插件写锁、凭据库） | 不安全则壳改用独立 profile。已裁定：壳改用独占 profile `heluo-desktop`（2026-11-26，§4.3 实施记录），探针不再需要 | P0 |
| 13 | 壳内认证闭环：dsh web 的 launch URL 获取方式、IAM 经系统浏览器登录后壳内会话的恢复 | **2026-11-26 离线包核验 `@deepseek-ai/dsh@0.2.2-rc.5` 与 `@deepseek-ai/dsh-web-app@0.2.2-rc.5` 确认**：`runCli({ packageManager })`、`--host`/`--port`/`--no-open` 与 stdout `dsh web: <带进程令牌的认证地址>` 均已保持；真实企业网络下 IAM 登录与会话恢复待联调 | P0 |

## 4. 阶段与门禁

各阶段出口判据齐全方可过门禁；关键项 BLOCKED 时按各阶段回退规则执行，不以部分通过宣称完成。工期为推断（按 1 名工程师与 Agent 协作），不含企业 IT 与目标环境排期等待；P2–P4 在 GB 通过后可部分并行。

| 阶段 | 内容 | 门禁 | 工期推断 |
|---|---|---|---|
| P0 | 前置验证与决策取证（许可、品牌 token、内置运行时接入、凭据存储、自承载与并发、壳内认证、麒麟 Electron） | G0 | 2 周 |
| P1 | 统一构建流水线 + 品牌定制 + 壳工程设计先行与准入 | GB | 3–4 周 |
| P2 | 壳工程核心实现（含首启企业配置、内置运行时、托盘与后台驻留）+ Windows x64 打包 | G2 | 6–8 周 |
| P3 | macOS arm64 打包 | G3 | 1 周 |
| P4 | 麒麟双架构适配与打包 | G4 | 3 周（deb、内置运行时与原生依赖的 linux 双架构产物、glibc / 沙箱实测） |
| P5 | 治理与文档闭环 | G5 | 1 周 |

### 4.0 统一构建与发布流水线（贯穿 P1–P4）

员工包由一条工作流从源码直接构建，作为资产挂在公开仓的**草稿 Release** 上并保持草稿：不上传 workflow artifact，不发布 Release，构建产物不公开。草稿 Release 仅仓库写权限协作者可见可下载；公开仓的 workflow artifact 与已发布 Release 对任何登录 GitHub 的人可见，不用于承载产物。

1. **触发**：推 `v*` tag 触发构建工作流，或在该 tag 上手动触发；tag 版本号对齐员工包版本（一个 tag = 一套制品基线），与 [.dsh-version](<../../.dsh-version>) 锁定版的对应关系、源提交与摘要清单位置写入草稿 Release 说明。
2. **CI 矩阵**：windows runner 构建 Windows x64 壳 NSIS 安装包与 win x64 内置运行时（消费仓内已校验的品牌 `.ico`）；macos runner 构建 macOS arm64 壳 dmg / zip 与 arm64 内置运行时（消费仓内已校验的品牌 `.icns`）；ubuntu arm64 / x86_64 runner 构建麒麟壳 deb、预编译原生依赖与 linux 双架构内置运行时。
3. **统一构建**：构建企业插件包 → 注入企业配置 → 组装员工包（中性安装包 + 企业资产目录 + `INSTALL.md` + `SHA256SUMS`），附员工包 SHA-256 摘要清单，作为资产挂到触发 tag 对应的草稿 Release（桌面安装包自身的独立 `.sha256` 校验文件及草稿说明摘要暂不调整，留待后续统一包校验体系补齐）；多 job 矩阵由一个前置 job 创建草稿、其余 job 只上传，不经 workflow artifact 在 job 间传递；内嵌的 dsh 运行时制品与随包 pnpm 经 `runtime-lock.json` 摘要比对后方可编排进安装包。P1 完成构建、注入与企业资产，P2–P4 依次接入各平台中性安装包。
4. **配置注入**：插件不读环境变量，`.env` 只是输入格式。工作流把 `release-bundle` 环境的 Environment Secrets 中的配置键以环境变量映射交给构建脚本，构建脚本按映射表（见配置清单）转成插件配置字段，写入 patch 层中对应插件条目的 `config:`，与插件包一起构成企业资产；配置值只存在于构建进程内存，不落临时文件。签发方由 Discovery 文档提供，不注入 issuer。客户端密钥不进 patch 层：它随企业资产交付，由安装器在首启时写入本机凭据库并删除明文副本，记录名为 `clientSecretRef` 的值。配置值不写入构建日志、错误体与清单。
5. **插件加载**：企业组合包 `@heluo/forge-enterprise` 为默认安装单元，研发扩展包 `@heluo/forge-engineering` 按需加入企业资产（其补丁层不含 IAM 行，以中性 tgz 原样随包）。壳首启时委托员工包内的安装器（`init-enterprise-plugin.mjs`）完成：校验员工包完整性、安装企业插件包（`dsh plugin --profile heluo-desktop add <tgz>`，经自承载 Node 运行）并核对制品证据、把客户端密钥写入本机凭据库后删除明文副本。企业配置随私版 tgz 内的 `dsh.bundle.patch` 由宿主随包装载；壳是否还需向 `heluo-desktop` profile 写入 `cordis.patch.yml` 与企业 npm 源 / 索引 preset，待 P0 第 6 项结论后确定，在此之前不写入。任一步失败不进入工作区；已完成的首启按员工包清单摘要记录，同一员工包不再重复初始化。
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

现状：`release-bundle` 已自 `v0.1.1` 起完成远端实测（含 `release-bundle` 环境进入、Secrets 读取、草稿创建与资产上传校验），后续 tag 已接入 `desktop-mac`（arm64 `.zip`）与 `desktop-windows`（x64 NSIS `.exe`）草稿构建；工作流窄例外条件由 `tests/check-repo.test.mjs` 断言。桌面安装包的独立 `.sha256` 校验产物与目标终端实测仍待后续完善。

### 4.1 P0 前置验证（G0）

1. **决策立项**：本计划获批即构成桌面分发路线与品牌定制层级的立项记录；G0 通过后按 §4.6 同步受控文档，未取证前不改终态文档。
2. **内嵌制品盘点**：按 [.dsh-version](<../../.dsh-version>) 锁定版盘点 dsh npm 制品（`0.2.2-rc.5` 版本、SHA-256 摘要、`runCli` 与 `dsh-web-app` 接缝已离线核验；原生依赖清单继续跟踪）与 Electron 44.7.0 二进制分发物、随包 pnpm（11.28.5 已核验入账）及其余内置运行时分发包（Python 解释器、Office 库 wheel、Node）的来源与摘要，作为壳内嵌输入；同时盘点上游 electron-builder 配置入口与内置运行时构建器作为构建参考。
3. **再分发许可结论**：DSH 为 MIT（[总体架构](<../architecture/platform-architecture.md>)已载）；范围为壳链接的 Electron / Chromium 第三方许可、内嵌 dsh npm 制品依赖与内置运行时分发包（Python 及 Office 库、Node、pnpm），清单核对无异常即视为通过，异常项单独上报，形成书面结论。
4. **品牌 token 探针**：本机实测桌面壳与 web 双端的可覆盖品牌 token 清单、Logo 资源解析路径与缺失回退行为，关闭[品牌设计](<../design/plugins/forge-brand.md>)的两项未决事项；安全提示、审批与审计入口的可覆盖性一并取证，不得因品牌化被隐藏；部分 token 不可覆盖时接受逐项回退上游默认。
5. **麒麟 Electron 可行性探针**：银河麒麟 V10 SP1（aarch64 与 x86_64，实机或虚拟机；双架构环境已具备、可调度）运行最小 Electron 应用（精确钉 44.7.0，指纹白名单见 §3 #8），核验 glibc、chromium sandbox 与加固内核行为；结论决定麒麟双架构适配（P4）能否立项实施。
6. **内置运行时接入探针**：在 `web` profile 下实测 Office 技能资源与 Python 解释器路径的配置入口、agent 侧 `node` / `pnpm` 的提供机制；无配置入口的能力移出范围并上报。2026-11-26 结论（mac 本机）：有配置入口，能力不移出范围；可复跑的探针是 `scripts/probe/run-primary-runtime-probe.mjs`，实施记录见 §4.2 同日条目。
7. **凭据存储探针**：在 Electron 自承载 Node 下实测 `node:sqlite` 与凭据的写入、读取和刷新（值级加密、0600 密钥文件）；macOS 本机已证实可写与入库，Windows / Linux 实机仍待验证，不可用则方案重新设计。
8. **Windows / Linux 自承载探针**：实测自承载运行随包内嵌的 dsh 与 `dsh --profile heluo-desktop`（固定端口 30810）在 Windows 10 与 Linux 的可行性，以及运行时原生依赖在四个目标的预编译（macOS 本机已实测自承载）；某平台不可行则该平台回退路线 B。
9. **`web` profile 并发探针**：终端 CLI 与壳同时使用同一 `web` profile（会话读写、插件安装、登录刷新），核验持久化、写锁与凭据库行为；不安全则壳改用独立 profile。2026-11-26：壳已按上游 profile 归属规则改用独占 profile `heluo-desktop` 与固定端口，本探针的前提不再成立，不再执行；同一会话被壳与终端 `dsh web` 同时打开的行为列为新的待验事项（§6）。
10. **壳内认证闭环探针**：实测 dsh web 启动时 launch URL 的获取方式（`0.2.2-rc.5` 输出格式与 `--no-open`/`--host` 参数已离线核验，macOS 本机已实测 launch URL 加载），以及真实企业网络下 IAM 经系统浏览器登录后壳内会话的恢复。

**G0 出口判据**：第 2–10 项均有书面结论；第 3 项（许可）BLOCKED 时全平台壳分发不启动、目标回退路线 B（现有 zip 交付）；第 4 项部分 token 不可覆盖时相应外观项回退上游默认，不构成整体阻塞；第 6 项无配置入口的能力移出范围并上报；第 7 项不可用时全平台分发不启动；第 8 项按平台回退路线 B；第 9 项随壳改用独占 profile 关闭；第 5 项经降级版本线重试仍 BLOCKED 时，麒麟按预设预案恢复 web 形态 deb 兜底并上报用户重申。

### 4.2 P1 统一构建与品牌定制（GB）

1. **forge-brand 包实现**：按[品牌与外观详细设计](<../design/plugins/forge-brand.md>)与仓库准入流程（设计已登记 → 准入核验 → 清单与测试 → 编码）实现 `@heluo/forge-brand`：配置 bundle + 本地品牌资源，`private: true`，声明 `engines.dsh`，配套正反向测试（配置校验、对比度回退、缺失回退、外链拒绝）；G0 取得的 token 清单回写设计第 5 节。
2. **品牌资源随包**：外层图标与壳图标用彩色主标 `app-icon`（`sizes/` 已有 16–1024px 标准切图），应用内 Logo 用图文组合 `wordmark-color`；内置副本与源文件保持逐字节一致并过 package-shape 测试；不使用外链资源；深浅色模式对比度按 forge-brand 设计校验。
3. **外层品牌资产维护**：外层 `.ico`、`.icns` 与 8 档 PNG 切图在仓内预派生并登记进品牌 `manifest.json`（SHA-256 校验闭环），构建阶段直接校验并消费仓内资产，不再要求在 CI 中动态派生；`scripts/derive-brand-icons.mjs` 保留用于品牌源图变更时在本地重建并更新 manifest。
4. **外层品牌规范**：外层安装器名称、快捷方式名称与图标、zip / `INSTALL.md`、deb 元数据统一以「河洛 Forge 企业版」呈现并沿用河洛苍螭资产规范。
5. **统一构建流水线**：按 §4.0 改造清单完成 `release-bundle` 的统一构建与草稿 Release 上传，作为后续各阶段的构建入口。

**实施记录（2026-11-23，代码先行、验证后置）**：

- 第 5 项对应 §4.0 改造清单第 1–5、7 项已实现：`.github/workflows/release-bundle.yml`、`scripts/build-employee-package.mjs`、`scripts/upload-draft-release.mjs`、`scripts/lib/release-config.mjs`（配置键清单，检查器与构建脚本共用）、`scripts/lib/repo-rules.mjs` 的窄例外，以及 `tests/check-repo.test.mjs`、`tests/build-employee-package.test.mjs`、`tests/upload-draft-release.test.mjs` 三份用例。离线证据：用例 45 项通过，18 个规则变异全部被对应用例杀死，全量离线检查通过；真实链路本机冒烟一次通过（合成配置、隔离目录）。2026-11-24：第 6 项完成——`release-bundle` 环境建立（部署分支限定 tag `v*`，经负责人裁决不设必需评审人）、两个仓库变量（`HELUO_PUBLIC_LICENSE=UNLICENSED`、`HELUO_WITH_ENGINEERING=true`）与企业配置 Environment Secrets（12 键；显式撤销端点经负责人裁决暂缺，退出撤销降级）录入完毕；首次推 tag `v0.1.0` 远端实测：环境进入、Secrets 读取、员工包构建与自检、草稿创建全部通过，资产上传因流式请求体不携带 Content-Length 被上传端点拒绝（HTTP 400 Bad Content-Length），同日修复为缓冲请求体并补回归用例（未修版本已验证失败），端到端资产交付经 `v0.1.1` 重跑核验通过（run 45377289045；员工包资产 988254 字节挂载草稿 Release，摘要独立复算一致，草稿保持待人工发布）。
- 壳工程的设计先行部分已完成：[桌面壳详细设计](<../design/services/desktop-shell.md>)（CORP-DSH-DESIGN-025）已登记设计索引；`services/forge-desktop/` 实现了不依赖 Electron 的判断模块（进程状态机、launch URL 解析与回环校验、导航与权限判定、登录 shell 环境合并、企业资产校验与首启、关窗与退出判定）和以注入接口装配的 `shell.mjs`。离线证据：47 项用例与 3 项构建—壳契约用例通过，24 个规则变异全部被对应用例杀死。壳已建 `package.json`（暂不声明依赖，锁文件只登记工作区成员）并标「状态：可用」，未接 Electron 运行，未打包。2026-11-24 按代码评审修正壳的七处问题（摘要来源不一致、符号链接逃逸、跨块解码、重复扫描、重定向处置、输出上限、错误码文案），并写明员工包的信任模型；新用例已在未修代码的隔离副本上确认会失败。
- 第 3 项（外层品牌资产派生）的脚本已具备：`scripts/derive-brand-icons.mjs` 从品牌源文件派生 Windows `.ico`、macOS `.icns` 与缺失的小尺寸切图，输入按品牌 `manifest.json` 的 SHA-256 闭环校验，派生产物另记 `derivation-manifest.json`，不改写源文件；栅格化依次尝试 `rsvg-convert` 与 `sips`，两者皆无且缺尺寸时以 `MISSING_RASTERIZER` 失败。离线证据：`tests/derive-brand-icons.test.mjs` 10 项通过；对仓库真实品牌资产的本机冒烟一次通过（`file` 识别出 6 条目的 ICO 与 ICNS，源文件零改动）。2026-11-24 资产闭环（issue #459）：`sizes/app-icon-{16,32,48,64}.png` 以 sips 派生入库，`icons/app-icon.{ico,icns}` 构建入库，六件产物全部登记 `manifest.json`（V2.1.5，261 条）；此后 8 档切图齐备，重建免栅格化器（`none-needed`），新增真实套件用例断言纯 Node 重建与入库 ico/icns 逐字节一致、任一档源图变动即偏离（判据会失败）。后续主路径已确定为直接校验并消费仓内已登记的 `.ico`/`.icns`（`build-desktop-installer.mjs`），不再要求接入 CI 动态派生。
- 第 1、2 项（forge-brand 包、品牌资源随包）2026-11-24 已实现（issue #459）：`packages/forge-brand` 按设计六字段交付令牌校验与安全回退（对比度双底 ≥3:1、超长截断、外链与路径逃逸拒绝、缺失回退品牌默认），`apply` 经 `ctx.provide('forge-brand')` 暴露；`icon.svg` 与 `assets/wordmark-color.svg` 和品牌源文件逐字节一致并经品牌 manifest SHA-256 交叉校验（package-shape 测试）；16 项单元用例通过。`@heluo/forge-enterprise` 依赖闭包与补丁层中性行（不带 config）携带本包，品牌身份为包内默认，公版保持配置中性。宿主 token 消费面与 Logo 双端解析路径经负责人裁决留 GB 双端实测（缺接缝按 `HOST_SEAM_UNAVAILABLE` 降级，不影响装载）。
- 第 4 项（外层品牌规范）2026-11-24 已实现（issue #459）：员工包新增 `branding/` 目录——ico/icns、8 档 PNG 与 `wordmark-color.svg` 经品牌 manifest 逐件校验后复制（与源逐字节一致），并写入 `app-identity.json` 应用标识五元组（appId `com.heluo.forge.enterprise`、升级 GUID、productName、可执行名、显示名「河洛 Forge 企业版」）；`INSTALL.md` 标题与启动器文案统一品牌呈现（Windows 启动器用 ASCII `Heluo Forge Enterprise` 规避代码页风险）。品牌套件整体缺失时降级省略 `branding/`（GB 判据：不阻塞插件级品牌化），存在但登记不符则拒绝构建。员工包清单记录品牌材料来源（manifest 版本、身份五元组与文件名）。快捷方式创建与 deb 元数据落地属 P2 壳打包（electron-builder 消费 `branding/` 与身份真源），本项交付其全部品牌材料。

**P2 一期实施记录（2026-11-24，issue #463）**：

- 第 1 项的工具链面：`services/forge-desktop` devDependencies 精确钉 `electron@44.7.0` 与 `electron-builder@26.0.12`（package-shape 断言拒绝 `^`/`~` 浮动与运行时依赖，含变异证明）；工作区 override 把 `@electron/node-gyp` 的 git 引用钉回 npm 发布版，`onlyBuiltDependencies` 只放行 electron 二进制下载。`src/layout.mjs` 抽出资源布局常量，main.mjs 与暂存工具共享（package-shape 断言 main.mjs 不得内联资源路径）。
- 第 2 项的暂存面：`scripts/stage-desktop-payload.mjs` 按 `runtime-lock.json` 台账（dsh 0.2.1-rc.3 SHA-256）核验制品后以 npm 前缀安装**依赖闭包**（dsh 非自包含单文件包，裸 tgz 缺 `@deepseek-ai/dsh-app-boot` 等同版本锁定依赖），托盘图标经品牌 manifest 校验复制，员工资产按 ASSETS_DIR 暂存；`tests/stage-desktop-payload.test.mjs` 以可注入安装器离线验证布局双向契约（4 项）。
- 第 7 项的配置面：`scripts/build-desktop-installer.mjs` 从员工包 `branding/app-identity.json` 生成 electron-builder 配置（appId/GUID/productName/可执行名/产物名逐字段来自身份真源，图标用品牌 ico/icns，NSIS x64 目标就绪）；`tests/build-desktop-installer.test.mjs` 4 项含身份篡改偏离判据。
- 集成冒烟（mac 本机，设计 §10 集成层首次执行）：`--dir` 构建出 `heluo-forge-enterprise.app`（未签名）；真实 Electron 启动后单实例锁生效，首启经包内安装器在沙箱 DSH_HOME 建 web profile 并装入 `@heluo/forge-enterprise` 0.1.2-corp.1（安装证据 `.heluo-enterprise-install.json` 含双摘要），止步 IAM Discovery（企业内网地址不可达，设计内降级且密钥保留）；预写首启标记直启后，内嵌 dsh 以 `--profile web --host 127.0.0.1 --no-open` 运行并监听 `127.0.0.1:3080`，渲染进程 `--enable-sandbox`。过程中修正两个实际缺陷：暂存前缀目录取值（闭包安装语义）与本机环境泄漏 `ELECTRON_RUN_AS_NODE` 导致的静默 node 态。
- 未做：NSIS windows-runner 流水线接线、离线 Win10 x64 VM 验收（第 7/8 项主体）、内置 pnpm/Node 工具链与 Python/Office 库（第 4 项，接 P0 #9 探针）、真实企业网络 IAM 登录与托盘/退出 GUI 交互取证、资产探测失败后的用户指定入口（第 3 项局部）。
- 首启装配缺陷修复（2026-11-25，干净环境首次真实首启暴露）：`shell.mjs` 把 `loadInstaller(...)`（main.mjs 经动态 import 返回 `Promise<runInit>`）未经 await 传入 `initializeProfile`，函数守卫按 `BAD_ARGUMENT` 拒绝并弹框，应用无法启动。此前冒烟因「预写首启标记 + 安装器终端单独驱动」恰好绕过该集成路径。修复为 `runInit: await loadInstaller(...)`；回归用例先行（以 main.mjs 同形的 Promise 型 loader 驱动装配层，未修版本必挂、修复后通过），装配层 58 项用例全绿。
- 窗口先行与页内配置提示（2026-11-25，负责人裁决「先开界面、页内提示、后续配置」）：需要首启或首启失败时窗口先开并加载壳自带本地品牌引导页（`resources/status.html` 暂存为 `brand/status.html`，无 preload 无外链，状态/错误码经查询串注入），应用驻留不弹框不退出，托盘菜单「重试企业配置」复用同一安装器幂等续跑（补放员工包、回企业网均可续），成功后窗口改载 launch URL 并移除重试项；运行时段失败仍走对话框+退出，禁止以未打补丁默认 profile 提前出界面（O3 官方登录旁路）。装配层 59 项用例含状态页驻留、重试续跑、运行时失败路径与布局契约。
- 桌面构建接入 Release 流水线（2026-11-25，负责人要求）：`release-bundle` 工作流新增 `desktop-mac`（macos-15，`--dir` 产物以 ditto 压为 `heluo-forge-enterprise-<tag>-mac-arm64.zip`）与 `desktop-windows`（windows-2025，electron-builder NSIS x64 产物 `heluo-forge-enterprise-<tag>-setup-x64.exe`）两任务，均 `needs: employee` 后各自重建员工包做内嵌资产（公共仓库的工作流 artifact 任何读者皆可下载，企业载荷不跨任务传递；needs 同时固定草稿与正文由 ubuntu 任务先建），进入同一 `release-bundle` 环境（tag `v*` 策略）。锁定版 dsh 制品在 runner 上经 `npm pack` 取得并由 `runtime-lock.json` SHA-256 台账核验；工具链 `pnpm install --frozen-lockfile`（electron/builder 二进制默认源）。检查器不变量全部保持（同触发器、顶层唯一 `contents: write`、checkout 全部 `persist-credentials: false`、secrets 仅 env 整行映射）。桌面产物均未签名：NSIS 首开会遇 SmartScreen、mac zip 需右键打开，签名属后续里程碑。
- 安装包瘦身与闭包确定性（2026-11-25 issue #485，2026-11-26 补齐去重、预算门禁与终态压缩）：`scripts/build-desktop-installer.mjs` 的打包配置开启顶层 `compression: 'maximum'`：NSIS 关闭差分包（`nsis.differentialPackage: false`）按 maximum solid 压缩，同时显式配置 `deleteAppDataOnUninstall: false` 与 `uninstallDisplayName`，支持 `--arch`（macOS x64 与麒麟 linux arm64/x64），清理 `ELECTRON_LANGUAGES` 重复项为 6 项（`en`、`en-US`、`zh-CN`、`zh-TW`、`zh_CN`、`zh_TW`）；macOS `--target mac` 只产出压缩 `dmg`（`writeUpdateInfo: false`，`release-bundle` 流水线同步从 `ditto zip` 改为产 `dmg`），并通过 `scripts/lib/desktop-after-pack.mjs`（`afterPack` 钩子）在打包后清理 `Electron Framework.framework` 内除 `Base.lproj`、`en.lproj`、`zh_CN.lproj`、`zh_TW.lproj` 外的 `.lproj` 目录。`extraResources.filter` 在打包时排除 TypeScript 源码与类型声明、source map 与调试符号，并对 `dsh/node_modules` 下非 `@deepseek-ai/` 第三方包排除 `test`/`tests`/`__tests__`/`docs`/`example`/`examples`、`CHANGELOG*`/`HISTORY*` 与非许可 `.md`/`.markdown`（保留 `LICENSE*`/`LICENCE*`/`NOTICE*`/`COPYING*` 与 `@deepseek-ai/*` 文档/技能文本），`runtime-lock.json` 钉定的 `@deepseek-ai/dsh` 目录及 `primary-runtime/` 原样随包。构建摘要新增 `resources`（暂存资源的文件数与字节数、其中被排除的部分）。暂存工具 `scripts/stage-desktop-payload.mjs` 补齐按 `--target` 裁剪第三方 `prebuilds/`（`pruneForeignPrebuilds`）、同版本嵌套传递依赖去重（`dedupeDshClosure`）、Top 20 大包统计（`topPackages`）、确定性闭包清单与可选锁校验（`dshClosure`、`STAGE_CLOSURE_MISMATCH`）以及按 `--max-dsh-bytes`/`--max-dsh-files` 或台账上限触发的体积/文件数预算门禁（`STAGE_BUDGET_EXCEEDED`），并通过原子临时目录切换保证拒绝运行不破坏已有输出；台账内的默认阈值待 `release-bundle` 跑出 `0.2.2-rc.5` 真实 Top 20 基线后回填。历史证据（2026-11-25 本机 mac，载荷取当时 `0.2.1-rc.3` 暂存树）：以 electron-builder 交给 7z 的同一组参数压同一份产物，现行参数 252.8 MiB、solid 168.8 MiB（降 33%），单线程解码由 8.5 秒降到 5.9 秒；`--dir` 构建逐文件核对，进包集合与规则一致（资源 63,137 → 24,356 个文件、681.1 → 434.9 MB，钉定目录的 8 个 `.d.ts` 保留）。未验：Windows 安装包的 `maximum` 压缩体积、安装耗时、静默参数与 nsis7z 解包表现，`macOS` 压缩 `dmg` 与 `afterPack` 实机打包体积、`0.2.2-rc.5` 真实暂存下的闭包去重与 Top 20 数据均待 `release-bundle` 流水线或实机构建取证。
- 随包 pnpm（2026-11-25，负责人确认照上游做法接入；第 4 项的 pnpm 部分）：`runtime-lock.json` 把 `pnpm: null` 换成 pnpm 11.28.5 的台账行（版本与根 `packageManager` 一致，字节数与 SHA-256 由暂存用例核对）；`scripts/stage-desktop-payload.mjs` 新增必填 `--pnpm-tgz`，按台账核验后用仓库自有的归档读取器解包到 `<resources>/pnpm/`，并核对包内身份（`pnpm@<锁定版>` 与 `bin/pnpm.mjs`）。接入方式取自上游同标签（`dsh-v0.2.1-rc.3`）源码的公开接缝：壳新增 `src/embedded-cli.mjs` 作为 dsh 的唯一入口，经 `@deepseek-ai/dsh` 公开导出的 `runCli({ packageManager })` 把「应用二进制 + 随包 `bin/pnpm.mjs`」交给 dsh，每次包操作都以 Electron 的 Node 模式运行随包 pnpm，不改 DSH、不改 PATH；安装器新增 `--pnpm-from-host`，壳调用时既不在 PATH 查找 pnpm，也不补装。`release-bundle` 两个桌面任务在同一步骤经 `npm pack` 取得 pnpm 制品并交给暂存工具。验证：暂存、入口、安装器与壳契约用例含反向与变异证明；本机 mac `--dir` 构建，在 PATH 上没有 node、npm、pnpm 的条件下首启装入企业插件并进入工作区，同一条件下不带随包 pnpm 的构建停在 `FIRST_RUN_FAILED`。未验证：随包 pnpm 在 Windows 与 Linux 上的包操作，以及包脚本需要 PATH 上 `node` 的插件；第 4 项其余部分（独立 Node、Python 与 Office 库）与 P0 内置运行时接入探针不变。
- 首启排障明细（2026-11-25，负责人确认开发阶段显示）：内网机器上的员工包（0.1.6-corp.1）首启必然失败，而状态页对所有失败显示同一段文案，无法判断原因。壳新增 `src/diagnostic.mjs`：`initializeProfile` 把安装器的完整结论（错误码、原因、处理、回显与警告）带进 `FIRST_RUN_FAILED`；状态页显示安装器错误码、原因、处理办法与日志位置；应用数据目录下的 `logs/first-run.log`（0600）记录每次首启尝试与每个导致退出的失败。安装器的失败结论新增 `progress`（走到失败为止的回显，终端输出不变），`reasonTail` 保留真正的报错行而略去调用栈。实测（本机 mac，PATH 上无 node、npm、pnpm）：IAM 不可达时为 `IAM_DISCOVERY_FAILED` 并显示 Discovery 地址；IAM 可达且插件完整时为 `IAM_CLIENT_SECRET_PROVISION_FAILED`，页面与日志显示 `dsh: invalid profile name "<…>/@heluo/forge-iam/bin/heluo-forge.mjs"`。由此确认一项未修缺陷：壳的执行器对每条命令前置 dsh 入口，而安装器预置密钥时用 `process.execPath` 直接运行插件的 forge-iam CLI，三处调用（set、replace、空目录诊断）在壳内必然失败；只带上随包 pnpm 重新打包，内网机器会从 `PNPM_REQUIRED` 变为 `IAM_CLIENT_SECRET_PROVISION_FAILED`。壳与员工包须出自同一次构建（壳传 `--pnpm-from-host`，旧员工包的安装器报 `BAD_ARGUMENT`）。未验证：Windows 与 Linux 上的显示。
- 密钥入库调用形态修复（2026-11-25，负责人裁决启动）：上一条记录确认的未修缺陷当日修复。安装器 `runInit`/`provisionClientSecret` 新增 `scriptExec` 选项：密钥预置的三条命令（set、replace、空目录诊断）改经它运行插件自带的 `@heluo/forge-iam/bin/heluo-forge.mjs`（`args[0]` 即脚本路径）；缺省等于原先的 `exec(process.execPath, args)`，终端行为不变。壳的 `src/process.mjs` 新增 `embeddedScriptExec`：以应用二进制为 Node 运行该脚本，前面不加 dsh 入口，只放行 profile 目录内路径归一的普通文件；`main.mjs` 按安装器同源的 `$DSH_HOME` 规则推导 profile 目录并传入。验证：安装器与壳的用例含正反向（放行、越界、链接、非函数拒绝、缺省不变）与契约级用例（真实安装器经壳执行器实际运行替身 CLI，断言收到的命令行首项就是脚本路径、密钥按字节到 stdin）；本机 mac 端到端（PATH 上无 node、npm、pnpm，IAM 以本地服务代替内网）：首启完成插件安装、核验、密钥入库（隔离凭据库出现 `credentials.sqlite`，明文删除）并进入工作区，顺带证实 Electron 44.7.0 内嵌 Node 下 `node:sqlite` 可写（P0 #7 的一侧证据）。未验证：Windows 与 Linux。
- 无边框窗口（2026-11-25，负责人裁决：按钮由壳自绘，macOS 以壳自有标题栏实现）：macOS 与 Windows 隐藏系统标题栏（`titleBarStyle: 'hidden'`，macOS 同时隐藏系统红绿灯），窗口自身的页面是壳的标题栏（`resources/titlebar.html` 暂存为 `brand/titlebar.html`，28 / 32 像素，按钮在左为红绿灯样式、在右为最小化 / 最大化 / 关闭，颜色随系统深浅色），引导页与工作区改载于内容视图 `WebContentsView`。不取 DSH 页面自带的无边框钩子：macOS 的 `data-platform=darwin` 同时被其快捷键模块当作官方桌面运行时，缺少官方 preload 桥接时启动报错、界面挂不出来（静态阅读结论，未实机验证）。桥接只交给标题栏页面（`src/window-chrome.preload.cjs`：最小化、缩放、关闭三个无参动作与状态订阅），主进程校验调用方是该页面的主框架且动作在白名单内；工作区页面仍无 preload、无壳能力，且不打任何宿主标记。判定收在 `src/window-chrome.mjs`。验证：纯模块、桥接（替身运行）与页面约束用例含变异证明，装配层用例覆盖调用方校验、状态推送、全屏与焦点归属，23 个规则变异全部被杀死；本机 mac `--dir` 构建（深色外观）实测标题栏与内容各就其位、三个按钮经桥接生效、最大化 / 失焦状态推送、全屏收起与恢复、第二份实例调回隐藏或最小化的窗口，标题栏偏移、间距与颜色和系统原生逐像素一致；实测修正两处缺陷（启动与回到前台时键盘落在标题栏，最小化被焦点归还撤销）。PR 评审后修正两处：启动在标题栏页面上确认桥接已注入（页面能加载而桥接未生效时按钮不起作用），全屏布局改为向窗口询问实际状态并去掉标题栏不消费的全屏状态；2026-11-26 以主进程报出的窗口事实复验全屏往返、最大化与焦点状态，标题栏与内容页逐项一致。同日补验装载企业插件后的窗口：此前实测预写首启标记，内容是未装载企业插件的 web 界面；补验按台账重新暂存（dsh 0.2.2-rc.5——企业插件要求宿主不低于此版，旧暂存载荷上的 dsh 装不上它），隔离 profile 装入从 HEAD 构建的企业插件并接仓库测试用的模拟 IdP（同 `scripts/probe/run-iam-local-uat.sh` 的做法），壳以沙箱 `HOME` 承载：工作区显示企业服务初始化向导，经系统浏览器完成模拟登录后显示企业账号已认证，标题栏与内容各就其位，壳无报错，本机真实凭据库、DSH 目录与应用数据未被触碰。同日再验经壳首启的完整路径：用制包工具从 HEAD 造一份配置指向仓库模拟 IAM 与网关（`scripts/probe/mock-iam-gateway.mjs`）的合成员工包，壳在沙箱 `HOME` 与全新的用户数据目录里首启——状态页显示初始化中，安装器经内嵌入口与随包 pnpm 执行 `dsh plugin --profile web add` 并核验通过，客户端密钥写入沙箱内的凭据库、明文密钥被删除，15 秒内进入工作区并显示企业服务初始化向导，向导三步走完（登录模拟企业账号、保存合成网关凭证并取得企业模型、完成）；缩放、全屏与焦点状态以主进程报出的窗口事实核对一致，壳全程无报错。未验证：真实企业 IAM 与网关；带品牌配置的员工包（合成包不含品牌配置，应用内回退上游默认品牌）；拖动（自动化没有系统鼠标事件权限）、浅色外观与原生对照、Windows 上的全部表现。
- 内置运行时（2026-11-26，负责人确认：解锁补丁放通用底座、载荷自带的 pnpm 本次与随包 pnpm 并存、壳的接线与并行中的无边框窗口改动错开）：`services/forge-desktop/primary-runtime-lock.json` 逐字节钉住上游为同一 dsh 版本发布的锁（Node.js 24.21.0、CPython 3.12.14、13 个 wheel、5 个目标）；`scripts/stage-primary-runtime.mjs` 按它组载荷——每个归档按 SHA-256 核对，布局取自暂存好的 dsh 闭包里上游导出的函数，为本机构建时先在副本上运行解释器再报告；`--verify-lock` 把钉住的锁与上游比对，`release-bundle` 的两个桌面任务在构建前执行它，并在 dsh 闭包之后、打包之前暂存载荷。`@heluo/forge-enterprise` 的补丁层新增两行条件启用（带 `name` 守卫，只在 `DSH_PRIMARY_RUNTIME` 有值时生效；sdk profile 里被命中的同名行只多出 `root`）。壳经 `src/primary-runtime.mjs` 交出载荷位置，并从继承环境里剥离同名变量。实测（mac 本机，DSH 0.2.2-rc.5）：`mac-arm64` 载荷 31 秒构建、294.5 MiB、检查全过；`--dir` 打包后包内载荷与暂存逐文件一致（仅 electron-builder 默认规则丢一个空 `.gitkeep`）；探针 `--app` 模式（打出来的应用包配本分支构建的企业底座包）28/28；对暂存目录 `--patch` 配 Electron 运行器 23/23、企业底座包配 Node 运行器 27/27。2026-11-26 `v0.1.15` 远端 `release-bundle` 首测暴露 `win-x64` 布局缺陷：`node-v24.21.0-win-x64.zip` 将 `node.exe` 置于归档根目录而非 `bin/node.exe`，已修正 `stageNode` 按平台从 `<root>/node.exe` 读取并落到 `dependencies/node/bin/node.exe`（`tarMembers` 同步兼容 `\r?\n`），补充离线 `win-x64` 回归用例。2026-11-26 `v0.1.16` 远端再暴露 `win-x64` 暂存缺陷：Windows 上 GNU `tar` 把绝对路径里的 `C:` 盘符当远程主机（解包 CPython 归档时报 `Cannot connect to C: resolve failed`），`tarMembers`/`tarExtract` 现按平台在 Windows 为 `tar` 传 `--force-local`（macOS/Linux 的 BSD tar 无此选项、不传），补选项构造的离线回归用例（变异可拒）。未验证：Windows / Linux 载荷，首启安装器界面流程，压缩后体积增量，签名构建。包操作改用载荷里的 Node.js 与 pnpm 已于同日「载荷 pnpm 统一」条目完成（`resources/pnpm` 已删）；CPython 许可文本的补入待裁决。记录见 [验证记录](<../design/verification/desktop-primary-runtime.md>)。

- 独占 profile 与系统分配端口（2026-11-26，负责人裁决）：壳不再与终端 CLI 共用 `web` profile，改为独占 `heluo-desktop`，并以 `--port 0` 启动。依据：上游 `apps/desktop`（`dsh-v0.2.2-rc.5`）让 Electron 应用独占 `$DSH_HOME/profiles/desktop`，与 CLI 只共享 `$DSH_HOME` 下的会话、凭据与存储，其 README「状态归属」写明不共享可执行包、插件激活、锁文件与 `node_modules`；本机观测到共用 `web` profile 的后果：员工 `web` profile 的清单记录了指向应用包内 tgz 的 `file:` 依赖，其中一条指向已删除的构建目录；另由代码推断（未实跑）壳与终端 `dsh web` 争用同一默认端口。实现：`src/main.mjs` 的 `PROFILE` 改为 `heluo-desktop`（自定义名，安装器接受并从 web 模板创建；不用 `desktop`：CLI 拒绝启动，且与官方 Desktop 的 profile 撞目录），启动参数加 `--port 0`；首启记录按 profile 比对，旧记录自动触发重新首启。口径：终端 `dsh web` 是否带企业插件由员工包内的启动器决定，员工包 `INSTALL.md` 写明桌面应用使用独立 profile、两者各自安装与升级。验证：`package-shape` 新增 profile 契约（独占 profile、`--port 0`，四个变异各自被拒，未修版本报两项问题）；仓库契约用例改为以壳实际声明的 profile 名驱动真实安装器（首条命令为经壳入口的 `--profile heluo-desktop --from-default-profile web --dump-config`，名字改回 `web` 时失败）。未验证：独占 profile 与 `--port 0` 的真机冒烟（此前各次冒烟均在 `--profile web` 与默认端口下取得）、同一会话被壳与终端 `dsh web` 同时打开的行为。实施后由静态阅读发现一项副作用（未实跑，处置方式待负责人裁决，设计 §6、§12）：Web 客户端把会话草稿（`dsh.conversation.<会话>`）、快捷键覆盖（`dsh.keybindings.v1`）等存在窗口 `localStorage`，按源隔离而源含端口，`--port 0` 使其每次启动都变、这些状态不跨启动保留；上游 Desktop 以固定源 `dsh-app://app/` 加载界面，不受端口影响。已接受的边界：不带企业插件的终端 `dsh web` 能列出壳产生的会话并用自己的模型续写；合规另有要求时壳改用独立的 `DSH_HOME`，代价是不再与终端企业版共用会话。
- store 不一致的诊断与自愈（2026-11-26，负责人裁决两项都做）：一台 Windows 机器用共用 `web` profile 的旧构建首启，停在 `FIRST_RUN_FAILED（安装器 INSTALL_FAILED）`，原因是 pnpm 的 `ERR_PNPM_UNEXPECTED_STORE`——该 profile 的 `node_modules` 由终端一侧的另一个 pnpm 用别的 store 目录链接，壳随包的 pnpm 拒绝在上面继续安装。本机隔离目录复现（pnpm 11.28.5 与 12.21.0）：换 store 再装即同样报错；全新 profile、删掉 `node_modules` 后再装都正常；只换 pnpm 大版本而 store 相同不报错。实现：安装器识别该错误码——未获授权时以 `PROFILE_STORE_MISMATCH` 停止，结论带出 profile 名、`node_modules/.modules.yaml` 记录的 store 与处理办法，不重试、不动 profile；调用方以 `--reinstall-on-store-mismatch` 声明拥有该 profile 时，清空 `profiles/<名>/node_modules` 后重试该步一次（卸载与安装两步都适用），整次初始化只修复一次。清空只删这一个目录并逐项进行，目录内的链接只删链接本身；`node_modules` 本身是链接或不是目录时不动它（`PROFILE_RESET_FAILED`）。包操作失败的结论一律带出 pnpm 的错误码。壳的首启传入该开关，终端启动器不传、行为不变；壳与员工包须出自同一次构建的约束不变。验证：安装器新增 9 条用例（参数、诊断、授权修复、卸载步、重试仍失败、链接、演练、记录格式、错误码），三个变异（未授权也修复、跟进链接、修复成空操作）均被杀死；壳用例随参数更新；仓库契约用例改为以壳实际交给安装器的参数驱动真实安装器，并新增壳授权后安装器清空并重试一条，去掉开关时两条契约用例失败。未验证：真实 pnpm 触发修复的实机表现、Windows 上文件被占用时清空失败的表现与目录联接的处理。
- 固定端口（2026-11-26，负责人裁决）：「独占 profile 与系统分配端口」记录的副作用当日裁决为改用固定端口。壳不再以 `--port 0` 启动，改为监听 `127.0.0.1:30810`：窗口的源跨启动不变，会话草稿、快捷键覆盖等按源保存的状态得以保留。30810 在 IANA 未分配，低于 Linux 临时端口范围起点 32768，也不是终端 `dsh web` 的默认端口 3080（`dsh-web-app/cordis.patch.yml` 的 `ctx.webStartup.port ?? 3080`），两者仍可同时运行。代价是该端口被占用时壳以 `PORT_CONFLICT` 启动失败，包括上一次壳异常退出后遗留的 dsh 子进程占着端口；提示目前不带端口号。实现：`src/main.mjs` 声明 `PORT` 并交给启动参数；`package-shape` 的端口规则拒绝系统分配、终端默认端口、特权与临时端口范围（七个变异各自被拒，已提交的 `--port 0` 版本报两项问题）。未验证：真机表现，见 §6。
- 载荷 pnpm 统一、安装器能力探测与 store 预检（2026-11-26，负责人裁决实施三项）：①统一双份 pnpm——`resources/pnpm` 从 `stage-desktop-payload.mjs` 的暂存面与 `release-bundle` 两个桌面任务的交接中移除（`--pnpm-tgz` 只交给 `stage-primary-runtime.mjs`，`runtime-lock.json` 的 pnpm 行仍钉同一制品、由载荷暂存器消费，与根 `packageManager` 同版的断言保留），`src/embedded-cli.mjs` 的 `packageManagerFor({ nodeEntry, pnpmEntry })` 改为以载荷 Node（`primary-runtime/dependencies/node/bin/node(.exe)`）运行载荷的 `bin/pnpm.mjs`，`main.mjs` 预检改查载荷两入口；安装包少约 23 MiB（解包），agent 工具行与包操作共用同一份制品与解释器，消除将来两份解包的版本漂移可能。②安装器能力探测——安装器新增 `CAPABILITIES` 导出（`pnpm-from-host`、`reinstall-on-store-mismatch`、`pnpm-store`），壳动态加载安装器模块后先读清单再传参（旧版安装器以 `PNPM_FROM_HOST_LINE`/`REINSTALL_LINE` 回显行常量作回退判据）：`--pnpm-from-host` 为硬前提，缺失时壳报 `INSTALLER_CAPABILITY_MISSING` 并指引换用同批次员工包——此前这种组合以安装器的 `BAD_ARGUMENT：未知参数` 失败，最难排查；认识随包 pnpm 但不认识修复授权的中间版本安装器（两个参数分两次引入期间发布的形态）照常运行，只失去对应自愈。③store 预检——壳新增 `src/pnpm-store.mjs`：首启前以载荷 Node 在 profile 目录里运行 `pnpm store path`（与包操作同一工作目录与环境），把解析出的 store 以 `--pnpm-store` 交给安装器；安装器在任何包操作之前先与 profile 的 `node_modules` 记录的 store 按归一化路径比对（`storePreflight` 纯函数，演练把计划写进回显）：不一致且已获修复授权时先清空再卸载/安装——「先删后装」两侧都是确认过健康的操作，把反应式自愈留给漏报；不一致且未获授权时以 `PROFILE_STORE_MISMATCH` 在改动 profile 之前停下（终端形态不传该参数，行为不变；探测失败含全新 profile，静默回落反应式）。验证：壳 121 例（新增能力探测三形态、`INSTALLER_CAPABILITY_MISSING` 页面呈现、store 探测成功/回落/末行解析、pnpmStore 交接与不交接）、暂存 9 例（pnpm 暂存与交接面收敛为载荷独占，流水线契约改为「只有载荷暂存器拿 pnpm 制品」并保留双向变异）、契约 7 例（新增「能力清单都是安装器 parseArgs 真实接受的参数」与「预检先清空、宿主替身一次被拒都遇不到」两条；反应式自愈用例保留作漏报回落的对照）、安装器 67 例（新增参数解析与能力清单一致性、storePreflight/normalizedStoreDirectory 纯函数、授权先行清空、未授权提前停、一致不清空回落反应式、演练计划共 6 组）。未验证：统一后以载荷 Node+pnpm 的真机首启复测（此前各次冒烟的包操作走应用二进制+`resources/pnpm`）、Windows 上 `node.exe` 启动与 `pnpm store path` 输出形态、真实 pnpm 触发预检比对的实机表现。
**口径确认（2026-11-24，项目负责人逐条确认）**：企业配置存为 `release-bundle` 环境的 Environment Secrets；配置值只存在于构建进程内存；研发扩展包以中性 tgz 按需随包；包内私版插件版本为 `<tag 版本>-corp.1`；「其余工作流一律只读」执行为禁止 `contents: write`，不扩展到现有工作流的其他写权限；品牌图标派生沿用既有实现；壳先建清单并标「可用」，清单暂不声明依赖，验证后置；首启的 `cordis.patch.yml` 写入留待 P0 第 6 项。

**GB 出口判据**：`release-bundle` 统一构建通过 `pnpm check` 并完成首次推 tag 远端实测（含环境审批与 Secrets 读取） + forge-brand 双端外观覆盖实测通过（含缺失回退）+ 外层派生资产经 manifest 校验 + 安全提示 / 审批 / 审计入口未被品牌化隐藏。外层图标派生失败时仅外层材料回退中性命名，不阻塞插件级品牌化。

### 4.3 P2 壳工程核心实现与 Windows x64 打包（G2）

1. **壳工程立项与实现**：按「设计先行 → 准入核验 → 清单与测试 → 编码」在 `services/` 建立全平台壳工程：Electron 精确钉 44.7.0（package-shape 断言拒绝 `^` / `~` 浮动）；`ELECTRON_RUN_AS_NODE` 自承载内嵌 dsh（macOS 开发构建已实测，见 §4.5）；`--no-open` 防双开、仅绑定 `127.0.0.1`（配置层白名单拒绝其他值）、单实例锁、launch URL 认证、子进程退出清理与端口冲突处理（状态机显式：spawning → ready → stopped，不确定保持 pending）；GUI 进程补 PATH；登录 shell 环境读取（GUI 进程环境与用户启动文件合并，参考上游 `<shell> -ilc` 机制）；完整河洛品牌（`app-icon` 切图）；配套正反向测试。
2. **内嵌载荷**：锁定版 dsh 运行时（npm 制品原样 + SHA-256 校验）+ 预编译原生依赖（避免终端 `node-gyp rebuild`）；企业插件、企业 npm 源 / 索引 preset 与配好的 `cordis.patch.yml` 属于企业资产，由首启企业配置装载。
3. **首启企业配置初始化**：首次启动时仅自动探测随包内嵌或同目录的 `enterprise-assets/`（不支持用户手动指定外部资产包），校验员工包完整性后委托员工包内的安装器依次完成密钥入库（`client-secret set`）、安装企业插件（`dsh plugin --profile heluo-desktop add`，经内嵌 pnpm，由自承载 Node 运行）与制品证据核对；企业配置随私版 tgz 的 `dsh.bundle.patch` 装载；`cordis.patch.yml` 与企业 npm 源 / 索引 preset 的写入待 P0 第 6 项结论后接入。每步幂等，任一步失败时停在本地引导页并支持托盘重试（不进入工作区），密钥入库后删除明文副本。
4. **内置运行时**：随包携带 Python 与 Office 库、Node、pnpm 的分发包，带版本清单与哈希；首次使用时离线安装到 `$DSH_HOME`，接入方式按 §3 #9 探针结论实现。（已实现，实施记录见 §4.2 的 2026-11-26 条目；Windows / Linux 载荷与离线 VM 验收未做。）
5. **托盘与后台驻留**：系统托盘常驻；关窗隐藏至托盘，运行中任务不中断；退出前确认（任务状态可查询时按状态提示，否则一律提示）；macOS 沿用 Dock 生命周期。
6. **安全基线**：渲染进程启用 `contextIsolation` 与 sandbox，关闭 `nodeIntegration`；`will-navigate` 与 `window.open` 只放行回环地址，其余链接交给系统浏览器；麦克风、摄像头、通知等权限请求默认拒绝；preload 仅暴露最小接口。
7. **Windows 打包**：electron-builder 产出 NSIS 安装包（Release 流水线 windows runner，§4.0 中性制品）；应用标识按 §1.1；品牌图标嵌入；配置 `deleteAppDataOnUninstall: false` 保留用户数据；静默安装参数口径已写入 [deploy/clients/README.md](../../deploy/clients/README.md)（仅自助安装口径，不随包提供批量脚本），VM 实测待 P2 验收。
8. **验收**：离线 Windows 10 x64 虚拟机执行安装、首启企业配置、客户端密钥入库与明文删除、企业登录（IAM 联调另计）、Office 技能与工作区依赖、托盘与后台驻留、退出确认、与终端 CLI 并发、企业插件挂载、品牌外观（壳本体与应用内）、升级（异版本先卸载再装）、回退与数据保留（[#123](https://github.com/hrygo/heluo-forge/issues/123) 范围）；SmartScreen 未签名首开表现记录与绕过图文。

**G2 出口判据**：离线 VM 端到端通过（含首启企业配置、内置运行时、托盘与后台驻留、品牌核验）+ NSIS 构建链结论 + 参数表；企业真实终端另按 #123 验收。

### 4.4 P3 macOS arm64 打包（G3）

1. **Apple Silicon 产物**：同一壳工程经 Release 流水线 macos runner 产出 arm64 dmg 与 zip（中性制品）；`INSTALL.md` 首开引导附 Gatekeeper 未签名警告绕过图文。
2. **目标机取证**：在 Apple Silicon 本机安装取证；首启企业配置、插件挂载、品牌外观与升级收敛同 G2 判据；核验 Dock 启动下的登录 shell 环境读取。
3. **未签名功能边界核验**：自有壳不签名不公证，核验 TCC 依赖能力（麦克风等）的实际可用性，结论写入交付边界；凭据边界不变——不使用系统钥匙串，保持 SQLite 值级 AES-256-GCM 与 0600 密钥文件（S9 / N2）。

**G3 出口判据**：Apple Silicon 安装、插件挂载与品牌外观证据齐备；Gatekeeper 首开表现与未签名功能边界已记录（不公证）。

### 4.5 P4 麒麟双架构适配与打包（G4）

1. **形态与落位**：全平台壳工程（P2 建立）的麒麟双架构平台层；不编译官方 `apps/desktop` 的 Linux 目标、不修改 DSH 源码，不构成 fork。平台层职责：deb 元数据与内部软件源（apt）双路径、`systemd --user` 自启动。
2. **壳职责**：BrowserWindow 加载本机 `dsh --profile heluo-desktop`（仅绑定 `127.0.0.1`，固定端口 30810）；管理 dsh 子进程生命周期（启动、launch URL 与进程凭据读取、退出清理、端口冲突、单实例）；应用本体完整河洛品牌——名称「河洛 Forge 企业版」、图标用彩色主标 `app-icon` 的 `sizes/` 标准 PNG 切图；内嵌锁定版 dsh 运行时（原生依赖预编译，避免终端 `node-gyp rebuild`）。**2026-11-19 macOS 开发构建实测**（探针性质，麒麟目标机另证）：以 `ELECTRON_RUN_AS_NODE` 自承载运行随包内嵌的 dsh 可行；Electron 须精确钉 44.7.0（指纹白名单）；`dsh plugin` 经 pnpm 转发安装，GUI 进程须补 PATH；dsh web 默认自动拉起系统浏览器，壳内须传 `--no-open` 防双开；企业组合包 `plugin add` 后 `plugin list` 可见、web 服务仅回环监听、窗口正常渲染。
3. **构建与分发**：麒麟 deb 经 Release 流水线（§4.0）由 GitHub Actions 构建 arm64 与 x86_64 产物；CI 产出中性制品（壳、预构建依赖、内置运行时、deb 骨架），麒麟员工包由同一流水线的统一构建产出（§4.0）；CI 遵循固定 Action SHA 与最小权限；ubuntu runner 产出的壳、内置运行时（Python 与 Office 库 wheel）与原生依赖和麒麟 V10 SP1 的 glibc / ABI 兼容性在目标机实测，不兼容时换老版本基础镜像 / 容器重试，仍败触发 web 兜底预案。企业内部软件源（apt）与文件交付双路径：apt 路径通过配套安装把 `enterprise-assets/` 落位到应用探测目录（不支持用户手动选包），并附静默安装参数文档。
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
| macOS arm64 | dmg / zip 构建可重复 + 摘要校验 | Apple Silicon 安装取证 + Gatekeeper 首开记录 | 首启企业配置 + 插件挂载 + 壳与应用内品牌生效 + 内置运行时可用 + S9 凭据边界不变 + 未签名功能边界记录 |
| 麒麟双架构 | 壳工程含正反向测试 + GitHub Actions 构建可重复 + Electron 兼容探针通过 | 实机 deb 安装 + 自启动 | 首启企业配置 + 仅回环 + 插件挂载 + 壳与应用内品牌生效 + 内置运行时可用 + 沙箱链准入 + 凭据隔离 |

## 6. 待核验事项

| 事项 | 责任与处理 |
|---|---|
| 第三方组件再分发许可 | 仅盘点壳链接的 Electron / Chromium 第三方许可与内嵌 dsh npm 制品依赖；清单核对无异常即通过，异常项单独上报 |
| 品牌 token 清单与 Logo 双端解析路径 | P0 本机探针并回写品牌设计；接受逐项回退上游默认 |
| 外层图标派生（SVG → `.ico` / `.icns`）工具链 | P1 已闭环：仓内预派生入库并纳入 `manifest.json` 校验，构建脚本直接验证并消费（`derive-brand-icons.mjs` 仅用于源图更新时本地重建，不再要求 CI 动态派生） |
| Release 流水线可行性与产物完整性（tag 触发、草稿 Release 挂载、资产核对、环境审批、Secrets 读取） | P1 已实测（`v0.1.1` 起已跑通员工包与 mac/win 草稿构建）；桌面安装包的独立 `.sha256` 校验文件及草稿说明摘要留待后续统一包校验体系补齐 |
| NSIS 构建链（CI windows runner 可行性、品牌图标嵌入、静默参数） | CI `desktop-windows` 已接入，NSIS 已配置 `deleteAppDataOnUninstall: false`，静默参数口径写入 `deploy/clients/README.md`；离线 Win10 x64 VM 实测仍待 P2 验收 |
| 自助安装引导与批量部署口径 | 无 MDM；仅自助 + 静默参数文档，不随包提供批量脚本；参数口径已落入 `deploy/clients/README.md`，VM 实测后复核 |
| SmartScreen / Gatekeeper 表现 | P2 / P3 记录，归 #123 取证，自有壳不签名；首开引导附警告绕过图文 |
| 麒麟 Electron 兼容性（glibc / chromium sandbox / 双架构） | P0 最小应用探针（精确钉 44.7.0；`0.2.2-rc.5` 依赖的白名单已离线确认包含 `44.7.0`）；仍 BLOCKED 则恢复 web 形态 deb 兜底并上报重申 |
| GitHub Actions 麒麟构建与目标机兼容性（glibc / ABI、沙箱链准入） | P4 实测；不兼容时降级基础镜像 / 容器重试，仍败触发 web 兜底 |
| 企业真实终端验收 | 全部归 #123 按目标环境独立验收 |
| 内置运行时在 `web` profile 下的接入方式 | 已有 mac 本机结论（2026-11-26，见 §3 #9）；复跑用 `scripts/probe/run-primary-runtime-probe.mjs` |
| 内置运行时的 Windows / Linux 载荷、体积与随包许可 | P2 / P4：两平台载荷由 CI 原生运行器暂存并检查，未在目标机运行；压缩后的体积增量未测；CPython 的许可文本不在载荷内，分发前由项目负责人裁决（见[验证记录](<../design/verification/desktop-primary-runtime.md>)） |
| 自承载 Node 下的凭据存储（`node:sqlite`） | macOS 本机已证实可写与入库；Windows / Linux 实机仍待 P0/P2 验证，不可用则方案重新设计 |
| Windows / Linux 自承载与五目标原生依赖预编译 | P0 探针（macOS 已实测自承载）；按平台回退路线 B |
| `web` profile 并发（终端 CLI 与壳） | 已关闭：壳改用独占 profile `heluo-desktop`（2026-11-26） |
| 独占 profile `heluo-desktop` 与固定端口的真机表现（含自定义 profile 经内嵌运行时从 web 模板创建、窗口的本地状态跨启动保留） | 目前只有离线用例；mac `--dir` 构建与 Windows 首启在壳上重跑 |
| 同一会话被壳与终端 `dsh web` 同时打开时的行为 | 实机验证；决定是否需要提示或保护 |
| 固定端口 30810 被占用时的表现（别的程序，或上一次壳异常退出后遗留的 dsh 子进程） | 实机验证；决定是否识别并清理遗留子进程 |
| 壳内认证闭环（launch URL、IAM 登录后的会话恢复） | `0.2.2-rc.5` 启动参数与 stdout `dsh web:` 行已于 2026-11-26 离线核验；真实企业网络下 IAM 登录与会话恢复待联调 |
| 统一构建在 Linux runner 上的运行 | P1 首次推 tag 实测：构建企业插件包、注入配置、组装员工包、环境审批全链路通过 |
| Discovery 预检 | runner 访问不到企业 IAM，构建时不做，也不设固定补做环节；交付回执记为未核验，首次企业登录实测时一并验证 |
| 撤销端点兼容性 | P1 实测：`revocationEndpoint` 指向的端点可用，退出后访问令牌失效 |
| 客户端密钥的首启入库 | P2 实测：首启后密钥可用于企业登录，明文副本已删除 |
