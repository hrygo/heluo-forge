# 河洛 Forge 企业版桌面壳详细设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-025 |
| 文档名称 | 河洛 Forge 企业版桌面壳详细设计 |
| 版本 | V0.2.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-25 |
| 门禁 | G2 |
| 模块状态 | 可用（设计阶段；实现与验证见设计索引 §2.2） |

> 编制依据：实施计划 [CORP-DSH-PLAN-026 §4.3](../../plans/2026-11-19-desktop-bundle-packaging.md#43-p2-壳工程核心实现与-windows-x64-打包g2)。已核验方式为 2026-11-23 的静态阅读：本机 `@deepseek-ai/dsh` 0.2.2-rc.5 的命令行形态（`dsh --profile web`，web 应用的 `--host`、`--port`、`--no-open` 选项，以及 stdout 输出的 `dsh web: <认证地址>` 行）、仓库安装器 `scripts/init-enterprise-plugin.mjs` 的写入面与可编程入口、私版 tgz 经 `dsh.bundle.patch` 随包携带配置的装载方式。未核验：锁定版 0.2.1-rc.3 的同一命令行形态；Electron 44.7.0 内嵌 Node 下 `node:sqlite` 与凭据存储的可用性；Windows 与 Linux 自承载；三平台打包链。按项目负责人 2026-11-23 的决定，本模块的实现先于计划 P0 探针进行，上述未核验项以计划 P0 探针结论为准。按项目负责人 2026-11-24 的决定，本目录先建立 `package.json` 并标「状态：可用」，Electron 运行与打包链的验证后置；「可用」指模块、用例与清单已具备，不表示可分发。
>
> 关联文档：[总体架构](../../architecture/platform-architecture.md)、[需求基线](../../requirements/requirements-baseline.md)、[设计索引](../README.md)、[公版插件、企业私有包与官方 DSH 集成方案](../../architecture/public-enterprise-bundle.md)、[工程开发与发布约定](../../engineering/development-conventions.md)、[DSH 插件高阶规范](../../engineering/dsh-plugin-conventions.md)。

## 1. 结论

桌面壳是自有的 Electron 应用：一个窗口，顶部是壳自绘的标题栏，下方加载本机 `dsh --profile web`；一个托盘图标驻留。壳不修改 DSH，不编译上游 `apps/desktop`。壳只做五件事：管理 dsh 子进程，守住窗口的导航与权限边界，首启装载企业资产，处理托盘与退出，绘制窗口自身的标题栏。判断逻辑全部在不依赖 Electron 的模块里并可离线测试；Electron 只出现在装配层，装配层本身也以注入的接口对象接受测试。

进入可分发状态还缺三项，均属计划 P0 与 P2 的验证：锁定版的启动输出形态、Electron 内嵌 Node 下的凭据存储、三平台打包链。在这些结论出来之前不产出安装包。

## 2. 目标与非目标

**目标**

- 自有壳在全平台以「河洛 Forge 企业版」呈现，内嵌锁定版 dsh 运行时。
- 壳与终端 CLI 共用 `web` profile，共用会话、配置与登录态。
- web 服务只绑定 `127.0.0.1`；窗口只加载本机服务，其余链接交给系统浏览器。
- 首启时装载企业资产；任一步失败时不进入工作区。
- 关窗隐藏至托盘，运行中任务不中断；退出前确认。
- macOS 与 Windows 上以无边框窗口呈现：标题栏与最小化、最大化、关闭按钮由壳自绘，样式随平台与系统外观。

**非目标**

- 不修改 DSH 源码或官方 `apps/desktop`，不重打包官方客户端。
- 不签名、不公证、不建自动更新 feed。
- 不实现自己的插件安装与凭据写入：这些由仓库安装器完成，壳只调用。
- 不向 `web` profile 写入 `cordis.patch.yml` 或企业 npm 源 / 索引 preset。是否需要，待计划 P0 第 6 项结论后确定（见 §12）。
- 不在壳内完成企业登录：登录在应用内的 web 界面完成，不设独立欢迎窗口。

## 3. 需求与依赖

| 需求/验收 | 关系 | 说明 |
|---|---|---|
| 需求基线 N5（仅回环监听） | 支撑 | 绑定地址与导航策略都只放行 `127.0.0.1` |
| 需求基线 S9 / N2（凭据边界） | 支撑 | 沿用 forge-credentials-keychain，壳不新增凭据存储 |
| 计划 G2（首启企业配置、托盘与退出） | 支撑 | §7 |

| 依赖 | 类型 | 版本约束 | 缺失时的行为 |
|---|---|---|---|
| Electron | 运行时 | 精确 `44.7.0`：dsh 原生加载器带 Electron 指纹白名单，浮动解析会被拒绝启动 | 壳不启动；版本断言是包体检查的一部分 |
| `@deepseek-ai/dsh` | 内嵌运行时 | [.dsh-version](../../../.dsh-version) 锁定版，npm 制品字节原样并校验 SHA-256 | 缺失或摘要不符时拒绝启动 |
| pnpm | 随包工具 | 与根 `package.json` 的 `packageManager` 同版（现 `11.28.5`）；npm 制品按 `runtime-lock.json` 核验字节与 SHA-256 后解包到 `resources/pnpm/` | 暂存拒绝；运行时缺失则壳拒绝启动 |
| 员工包企业资产 | 随包目录 | `enterprise-plugin/`（私版 tgz、`private-release.json`、可选的客户端密钥文件）与 `installer/` | 首启失败，不进入工作区 |
| 安装器 `scripts/init-enterprise-plugin.mjs` | 随包脚本 | 员工包 `installer/` 内的那一份，经摘要清单校验 | 首启失败 |
| 企业 npm 源 / 索引 preset、profile 级补丁层 | 企业资产 | 尚未定义 | 不写入；见 §12 |

## 4. 扩展形态与边界

| 项 | 内容 |
|---|---|
| 形态 | 独立 Electron 应用，代码位置 `services/forge-desktop/` |
| 运行位置 | 用户本机；子进程为本机 `dsh --profile web` |
| 目标运行时 | Electron 44.7.0（自承载 Node）+ 锁定版 dsh + 随包 pnpm |
| 使用的 seam | dsh 命令行与 stdout 的 launch URL 行；dsh 公开导出的 `runCli({ packageManager })`，用来指定包操作所用的 pnpm；安装器的 `runInit`（带 `--pnpm-from-host`）与 `scriptExec`（壳以应用二进制为 Node 运行插件自带的 CLI） |
| 不修改的核心 | DSH 运行时、`web` profile 的内容（除安装器写入的插件与制品证据）、上游 `apps/desktop` |

每个模块是一份状态的唯一可写所有者，模块之间不互相 import；装配层只装配，跨模块只经参数与回调传递。

| 模块 | 职责 | 不负责 |
|---|---|---|
| `src/runtime.mjs` | dsh 子进程的生命周期状态机 | 解析输出、创建窗口 |
| `src/launch-url.mjs` | 从子进程输出取 launch URL 并校验回环 | 启动进程 |
| `src/loopback.mjs` | 回环地址的唯一判定 | 其他 URL 策略 |
| `src/navigation.mjs` | 窗口对目标地址的处置判定与权限请求判定 | 窗口操作 |
| `src/shell-env.mjs` | 登录 shell 环境解析、合并与子进程环境净化 | 启动 shell（由调用方注入） |
| `src/process.mjs` | 一次性子命令的执行与超时；交给安装器的两个执行器 | 命令内容 |
| `src/embedded-cli.mjs` | dsh 的唯一入口：以 Node 运行，把随包 pnpm 作为包管理器交给 dsh 的命令行 | 窗口、托盘与首启判断 |
| `src/diagnostic.mjs` | 失败时告诉人什么：安装器结论的提取、日志条目、交给状态页的参数 | 窗口、日志文件的位置（由装配层给） |
| `src/first-run.mjs` | 企业资产的发现、校验与首启初始化 | 安装细节（委托安装器） |
| `src/lifecycle.mjs` | 关窗、退出与托盘的判定 | 界面 |
| `src/window-chrome.mjs` | 窗口外观的判定：哪些平台由壳自绘标题栏、标题栏与内容如何分占窗口、标题栏可请求的窗口动作与调用方校验 | 窗口操作本身（由装配层执行） |
| `src/shell.mjs` | 装配：把以上模块接到注入的 Electron 接口 | 业务判断 |
| `src/main.mjs` | 程序入口：引入真实的 `electron` 并调用装配 | 一切判断 |

**窗口组成**：窗口自身的页面是壳的标题栏（`brand/titlebar.html`，随包资源，无外链）；引导页与工作区加载在它的内容视图（`WebContentsView`）里，位于标题栏下方。macOS 与 Windows 隐藏系统标题栏（`titleBarStyle: 'hidden'`，macOS 同时隐藏系统红绿灯），标题栏分别为 28 与 32 像素，按钮在左侧以红绿灯样式、在右侧以最小化 / 最大化 / 关闭排列，颜色随系统深浅色。全屏时标题栏收起，内容占满窗口。其他平台保留系统标题栏：内容占满窗口，不存在标题栏页面。工作区页面不打任何宿主标记、不注入样式，保持普通浏览器页面的布局，因此不随 DSH 页面结构变化而错位。

## 5. 接口与配置

| 配置项 | 类型 | 默认值 | 必填 | 说明 |
|---|---|---|---|---|
| `bindHost` | string | `127.0.0.1` | 否 | 白名单只有这一个值；其他取值在装配前拒绝 |
| `profile` | string | `web` | 否 | 固定为 `web`，与终端 CLI 共用 |
| `startTimeoutMs` | 整数 | `60000` | 否 | 等待 launch URL 的上限 |
| `stopGraceMs` | 整数 | `5000` | 否 | 请求退出到强制终止的间隔 |

```js title="runtime：dsh 子进程的生命周期"
createRuntime({ spawn, findLaunchUrl, startTimeoutMs, stopGraceMs, onEvent })
// start() → Promise<{ href, origin }>   ready 时返回当前地址；starting 时返回同一个进行中的 Promise
// stop()  → Promise<void>               幂等；子进程确认退出后才完成
// snapshot() → { phase, origin, failure }
```

```js title="first-run：企业资产与首启"
locateEnterpriseAssets({ candidates })            // 第一个通过校验的员工包目录，否则抛 ASSETS_NOT_FOUND
firstRunNeeded({ markerPath, manifestDigest })    // 已完成且员工包未变时为 false
initializeProfile({ assets, runInit, env, exec }) // 委托安装器（带 --pnpm-from-host）；非零结论抛 FIRST_RUN_FAILED

**首启未完成时的窗口语义（2026-11-25）**：需要首启或首启失败时，窗口先于运行时打开并加载壳自带的本地品牌引导页（`brand/status.html`，无 preload、无外链，页面文件不承载企业配置值；状态、错误码与安装器结论经查询串注入，页面只以文本显示）。首启失败不退出应用：托盘菜单提供「重试企业配置」，重试复用同一安装器幂等续跑；成功后写入首启标记并转入正常启动（窗口改载 launch URL）。禁止以未打补丁的默认 profile 提前提供界面：官方登录旁路（O3）只有在企业补丁装载后才算关闭。

**首启失败时显示的明细**：状态页给出安装器的错误码、原因与处理办法，以及日志文件的位置；安装器没有给出处理办法时，显示壳对该错误码的指引。每段文字是一行且有长度上限（原因 600 字、处理 400 字），完整内容在日志里。这是开发阶段的决定：安装器的原文可能含本机路径与 Discovery 地址，正式分发前决定是否收起。
```

```js title="embedded-cli：dsh 的唯一入口"
packageManagerFor({ command, pnpmEntry })     // { command: 应用二进制, args: [随包 pnpm 的 bin/pnpm.mjs], env: { ELECTRON_RUN_AS_NODE: '1' } }
runEmbeddedCli({ command, dshEntry, pnpmEntry }) // 调用 dsh 导出的 runCli({ packageManager })；命令行参数原样，不改 dsh
```

壳需要 dsh 的每个场合（启动 `web` profile、安装器走 dsh 的命令）都启动这一个入口。dsh 的每次包操作因此都以应用二进制为 Node 运行随包的 pnpm，员工机器上有没有 Node 或 pnpm 都不影响插件安装。

插件自带的 CLI 不经这个入口：安装器预置密钥（set、replace、空目录诊断三处）直接运行已安装插件的 `@heluo/forge-iam/bin/heluo-forge.mjs`。壳为此另给安装器一个脚本执行器（`embeddedScriptExec`）：以同一应用二进制为 Node 运行该脚本，前面什么都不加——dsh 的入口会把这个脚本的路径读成 profile 名。执行器只放行 profile 目录内路径归一的普通文件，profile 之外、目录与链接一律拒绝；终端单独运行安装器时不传它，行为与原先一致。

```js title="navigation：窗口边界"
classifyTarget(url, { origin })  // 'load'（本机服务同源）| 'external'（http/https，交系统浏览器）| 'block'
permissionAllowed(permission)    // 恒为 false
```

页面的导航请求与新窗口请求经上表判定：同源加载，http(s) 的其他地址交系统浏览器，其余拦截。服务端重定向（`will-redirect`）只拦截，不代用户打开系统浏览器：它不是用户在页面上的操作触发的。

```js title="window-chrome：窗口外观与标题栏的桥接"
windowChrome({ platform })                            // { frameless, barHeight, controls, hideSystemButtons, window }
contentBounds({ width, height, barHeight, fullscreen })  // 内容视图在窗口中的位置：标题栏下方，全屏时占满
isWindowAction(action)                                // 只有 minimize、toggle-maximize、close
isTitleBarRequest(sender, frame, window)              // 请求是否来自标题栏页面的主框架
hasTitleBarBridge(type)                               // 标题栏页面加载后，typeof window.forgeWindow 是否为 object
```

标题栏页面经它的 preload（`src/window-chrome.preload.cjs`）得到 `window.forgeWindow`：`minimize()`、`toggleMaximize()`、`close()` 三个无参动作，和 `onState()` 状态订阅。动作经 `forge:window-action` 送达主进程，主进程只在调用方是标题栏页面的主框架、且动作在白名单内时执行，并回传空值；窗口是否最大化、是否在前台经 `forge:window-state` 推给标题栏。全屏不在此列：那时标题栏被内容盖住，布局直接向窗口询问全屏状态。启动等标题栏页面加载完成，并在页面上确认桥接已注入才继续——页面能加载而桥接没有生效，那时按钮不起作用。标题栏页面不可导航、不可打开新窗口。关闭沿用关窗语义（§8），macOS 上的缩放按钮执行最大化，全屏经系统快捷键或菜单进入。

## 6. 权限、凭据与数据

| 项 | 处理方式 | 生命周期 | 失败时 |
|---|---|---|---|
| launch URL | 带进程令牌，只交给内容视图加载，标题栏页面从不接触它；事件、日志与错误体里只有 origin | 随子进程 | 视为启动失败 |
| 客户端密钥 | 壳不读取其内容；安装器把它写入本机凭据库后删除明文文件 | 写入后明文即消失 | 首启失败，保留文件供重跑 |
| 凭据存储 | forge-credentials-keychain 的 SQLite 值级加密与 0600 密钥文件，不使用系统钥匙串 | 随 `DSH_HOME` | 见该包失败模式 |
| 首启标记 | 应用用户数据目录下的 `first-run.json`，记录员工包清单摘要与 profile | 直到员工包变化 | 缺失即重做首启 |
| 日志 | 应用数据目录下的 `logs/first-run.log`（0600）：每次首启尝试的安装器结论（错误码、原因、处理、回显与警告），以及每个导致应用退出的失败的错误码与说明。不记环境变量、客户端密钥、令牌与 launch URL | 随应用数据 | 写不进时照常运行，不构成启动失败 |
| 渲染进程权限 | 全部权限请求默认拒绝。加载引导页与工作区的内容视图不配置 preload、不获得任何壳能力；只有壳自有的标题栏页面配置 preload，经桥接得到三个无参窗口动作，主进程校验调用方是该页面的主框架且动作在白名单内，桥接不回传数据 | 随窗口 | 非标题栏页面或白名单外的请求不执行 |
| 员工包的信任模型 | 摘要校验证明包与其写出时一致，不证明来源：清单文件与摘要清单不带签名，能改写包的人同样能改写它们。壳自身的代码与包在同一安装目录、受同一保护，所以完整性由分发渠道与安装位置守护。不做签名验签：验签公钥若随包或随壳交付，不构成外部信任锚；安装包签名与公证是本计划的非目标 | — | 见 §8 |
| 企业资产的路径 | 摘要清单列出的每个路径都必须是包内的普通文件；任一级是符号链接即拒绝，否则校验会落到包外的文件上，该文件随后还会以包内身份被使用 | — | `ASSETS_INVALID` |
| 客户端密钥文件 | 安装器把密钥写入本机凭据库后删除明文文件；完整性校验只容忍这一个文件的缺失，其余列出的文件缺失即拒绝 | 写入后明文即消失 | 首启失败，保留文件供重跑 |
| 随包 pnpm | dsh 的每次包操作（首启安装、应用内安装插件）都运行随包的 `bin/pnpm.mjs`，不查找 PATH 上的 pnpm；不改 PATH、环境变量或包管理器配置，pnpm 自己的全局目录与 store 沿用用户设置。包脚本若需要 PATH 上的 `node`（例如原生插件构建），不在随包 pnpm 的覆盖范围内 | 随应用 | 缺失即拒绝启动（`EMBEDDED_RUNTIME_MISSING`） |
| 登录 shell 环境 | 合并进子进程的环境是用户自己的环境，与在终端运行 dsh 相同，不构成安全边界。壳只剥离会改变内嵌运行时工作方式的 Node 与 Electron 开关。库注入类变量（`LD_PRELOAD`、`DYLD_*` 等）保留：企业的终端管控常经它们注入，剥离会让内嵌运行时脱离企业自身的管控，而用户 profile 本身就是可执行代码 | 随用户环境 | — |

## 7. 流程

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> starting: start()
  stopped --> starting: start()
  failed --> starting: start()
  starting --> ready: 取得 launch URL
  starting --> failed: 超时或提前退出
  ready --> failed: 意外退出
  ready --> stopping: stop()
  starting --> stopping: stop()
  stopping --> stopped: 子进程确认退出
```

**启动**：`start()` 串行。`starting` 期间再次调用返回同一个进行中的 Promise，不产生第二个进程；`ready` 期间返回当前地址。`stopping` 期间调用被拒绝，不在停止过程中重启。

**就绪**：子进程 stdout 出现 `dsh web: <地址>` 行即为就绪，地址经回环校验。子进程在就绪前退出、或超过 `startTimeoutMs` 仍未输出地址，状态进入 `failed` 并带错误码；超时时先终止子进程。输出疑似端口占用时错误码为 `PORT_CONFLICT`。

**停止**：`stop()` 幂等。先请求子进程退出，超过 `stopGraceMs` 仍未退出则强制终止。只有观察到子进程退出才进入 `stopped`；观察不到时保持 `stopping`，Promise 不完成。

**不确定时**：任何无法确认的情形都停留在当前状态，不重发命令、不返回旧地址、不报告成功。

**首启**（装配层）：候选目录中第一个带清单文件的即为当前员工包，首启记录与首跑判断用的是同一份清单摘要。记录缺失或对不上时，校验该包完整并调用安装器完成插件安装与密钥入库，然后写入首启记录；记录对得上时不再触碰员工包，因为安装器已消耗其中一部分。当前员工包不完整时启动失败，不改用其他候选。安装器带 `--pnpm-from-host` 运行：pnpm 由壳经 dsh 交给每次包操作，安装器既不在 PATH 查找，也不补装。记录在安装器之后、写入之前丢失时，下次启动重跑一次安装器；安装器对同版本与已入库的密钥都是幂等的。全部成功后才创建窗口并启动子进程。

**退出**（装配层）：征求确认后先 `stop()`，子进程确认退出后应用才退出；`stop()` 未完成时应用不退出。

## 8. 失败模式

| 场景 | 行为 | 用户可见结果 | 是否可重试 |
|---|---|---|---|
| 未找到可用的企业资产 | 抛 `ASSETS_NOT_FOUND`，提示指定员工包 | 错误提示，无工作区 | 是 |
| 当前员工包不完整：清单或摘要清单缺失、摘要不符、列出的路径是符号链接 | 抛 `ASSETS_INVALID`，不改用其他候选 | 错误提示，无工作区 | 是 |
| 内嵌运行时或随包 pnpm 缺失 | 启动前拒绝，`EMBEDDED_RUNTIME_MISSING` | 错误提示，无工作区 | 重新安装应用 |
| 标题栏页面或它的桥接缺失，或页面加载后桥接没有生效 | 启动前拒绝或停在显示任何界面之前，`TITLE_BAR_MISSING`：没有标题栏的窗口没有控件，不显示 | 错误提示，无工作区 | 重新安装应用 |
| 安装器返回非零结论 | 抛 `FIRST_RUN_FAILED`，带安装器错误码；窗口加载本地品牌引导页（状态、错误码、安装器错误码、原因、处理办法与企业网络指引），日志记录安装器的完整结论，应用驻留，托盘菜单「重试企业配置」幂等续跑（2026-11-25 负责人裁决：先开界面、页内提示、后续配置） | 引导页提示，无工作区 | 回企业网后重试 |
| 启动超时 | 终止子进程，`START_TIMEOUT` | 错误提示 | 是 |
| 端口被占用 | `PORT_CONFLICT` | 提示关闭占用进程或换端口 | 是 |
| 就绪后意外退出 | `failed`，保留退出码 | 错误提示 | 是 |
| launch URL 不是 `127.0.0.1` | 拒绝加载 | 错误提示 | 修配置后重试 |
| 页面请求非本机地址 | 同源放行；http/https 交系统浏览器；其余拦截。服务端重定向只拦截 | 本机内容不变 | — |
| 权限请求 | 一律拒绝 | 对应能力不可用 | — |
| 无托盘时关窗 | Windows 与 Linux 退出应用，macOS 沿用 Dock | 见左 | — |

## 9. 可观测性

| 事件 | 字段 | 去向 | 保留 |
|---|---|---|---|
| 状态迁移 | 阶段、错误码、退出码 | 应用日志 | 随应用 |
| 首启结论 | 是否执行、安装器错误码 | 应用日志 | 随应用 |
| 首启日志 | 安装器的结论、回显与警告；导致应用退出的失败的错误码与说明 | 应用数据目录下的 `logs/first-run.log` | 随应用数据 |
| 登录 shell 环境不可用 | `SHELL_ENV_UNAVAILABLE` | 应用日志 | 随应用 |

launch URL 的查询串与片段、客户端密钥、环境变量取值不进入任何事件，也不进入日志。

## 10. 测试矩阵

| 层级 | 覆盖 | 命令 |
|---|---|---|
| 单元 | 状态机的全部迁移、重复启动与重复停止、超时、端口占用；launch URL 解析；导航与权限判定；环境合并与净化；子命令执行；入口把随包 pnpm 交给 dsh；失败结论的提取、日志条目与状态页参数；状态页只以文本显示明细；企业资产校验；关窗与退出判定；窗口外观判定、桥接是否生效的判定、标题栏桥接与页面约束（全工程只向标题栏发出一个 preload） | `node --test services/forge-desktop/test` |
| 装配 | 以接口对象替代 Electron：单实例、首启失败不进入工作区、导航与权限处理器的接线、关窗隐藏、退出前先停子进程；标题栏与内容视图的分工、标题栏就位以桥接生效为准、窗口动作的调用方校验、窗口状态推送、全屏与尺寸跟随、键盘焦点归属 | 同上 |
| 集成 | Electron 44.7.0 自承载内嵌 dsh，窗口渲染 | 部分执行（2026-11-24 mac 本机：`--dir` 构建、单实例、首启装入企业插件、内嵌 dsh 回环 `127.0.0.1` 监听、sandbox 渲染进程；IAM 登录止步企业网络边界。2026-11-25 mac 本机：PATH 上没有 node、npm、pnpm 时，首启经随包 pnpm 装入企业插件并进入工作区；同一条件下不带随包 pnpm 的构建停在 `FIRST_RUN_FAILED`。2026-11-25 mac 本机深色外观，无边框窗口：标题栏与内容视图各就其位，工作区页面无桥接、无宿主标记；关闭、最小化、缩放三个按钮经桥接生效，最大化与失焦状态推送到标题栏，全屏收起并恢复标题栏，第二份实例把隐藏或最小化的窗口调回；标题栏的偏移、间距与颜色与系统原生逐像素核对一致。2026-11-26 mac 本机同一构建：以主进程报出的窗口事实为准，全屏往返、最大化与焦点状态变化时标题栏与内容页的表现逐项一致，启动在页面上确认桥接已注入。未验：拖动（自动化没有系统鼠标事件权限）、浅色外观与原生对照、Windows 全部） |
| 端到端 | 三平台安装、首启、托盘与退出 | 未执行（计划 G2、G3、G4） |

## 11. 打包、升级与回退

| 项 | 值 | 用途 |
|---|---|---|
| appId / bundle id | `com.heluo.forge.enterprise` | 应用唯一标识与 macOS `CFBundleIdentifier` |
| Windows 升级 GUID | `3fa730a8-e95c-45dc-9724-c525f3654136` | NSIS 升级识别 |
| productName | `Heluo Forge Enterprise` | 可执行文件、安装目录与 app bundle 名 |
| 可执行文件名 | `heluo-forge-enterprise` | 可执行文件、deb 包名与 `StartupWMClass` |
| 显示名 | 河洛 Forge 企业版 | 快捷方式、开始菜单、desktop entry 与关于页 |

本模块不是 DSH 插件。清单里的 `engines.dsh` 是仓库检查器对服务清单的要求，取值与内嵌运行时的锁定版一致；对宿主版本的约束由内嵌的锁定版运行时本身承担。清单只在 devDependencies 精确钉 `electron`（`44.7.0`）与 `electron-builder` 两个构建期工具，不声明运行时依赖；仓库的离线检查不安装依赖，用例也不需要它们。构建入口是计划 §4.0 的统一构建：`scripts/stage-desktop-payload.mjs` 按 `runtime-lock.json` 核验并暂存 dsh、pnpm 与员工包，`scripts/build-desktop-installer.mjs` 从员工包的身份文件生成打包配置。安装包形态与升级语义（异版本先卸载再安装）由计划 §1 与 §4.3 规定。

## 12. 未决事项

| 问题 | 需要谁回答 | 影响 |
|---|---|---|
| 锁定版 0.2.1-rc.3 的 launch URL 输出形态与命令行选项是否与 0.2.2-rc.5 一致 | 平台组（计划 P0 #10） | `launch-url` 的解析规则 |
| Electron 44.7.0 内嵌 Node 下 `node:sqlite` 与凭据存储是否可用 | 平台组（计划 P0 #7） | 方案是否成立 |
| 企业 npm 源 / 索引 preset 的内容与写入位置 | 平台组（计划 P0 #6） | 首启是否增加 preset 与 profile 级补丁层写入 |
| 终端 CLI 与壳并发使用同一 `web` profile 是否安全 | 平台组（计划 P0 #9） | 壳是否改用独立 profile |
| 退出前是否能查询运行中任务的状态 | 平台组 | 退出提示文案；此前一律提示 |
| 托盘在麒麟桌面环境下的可用性 | 平台组（计划 P4） | 关窗行为 |
| 自绘标题栏在 Windows 上的实机表现：拖动、贴靠、最大化边距、Alt+Space 系统菜单、Win10 与 Win11 样式差异 | 项目负责人（Win10 x64 VM，计划 G2） | Windows 的栏高、悬停色与按钮尺寸是否需要微调 |

计划 §4.3 把首启第三步写为「向 `web` profile 写入 `cordis.patch.yml`」。现行私版制品把企业配置放在 tgz 内的 `dsh.bundle.patch`，由宿主随包装载，安装器不写 profile 级补丁层。壳当前不写 profile 级补丁层：同一行出现在两层时归属不明。是否还需要它（企业 npm 源 / 索引 preset 等 profile 级组合），由计划 P0 第 6 项的结论决定；项目负责人 2026-11-24 确认在此之前留空。
