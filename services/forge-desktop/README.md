# 桌面壳（河洛 Forge 企业版）

状态：可用（开发骨架）。判断逻辑与装配层离线测试齐备；Electron 44.7.0 与 electron-builder 26.0.12 已精确钉版入 devDependencies（package-shape 断言拒绝浮动）；载荷暂存（`scripts/stage-desktop-payload.mjs` + `runtime-lock.json` 台账）与安装包配置（`scripts/build-desktop-installer.mjs`，身份真源消费员工包 `branding/app-identity.json`）具备。2026-11-24 本机 mac `--dir` 构建冒烟：真实 Electron 启动、单实例、首启经安装器建 profile 并装入 `@heluo/forge-enterprise` 0.1.2-corp.1（沙箱 DSH_HOME）、IAM Discovery 止步企业内网边界（设计内降级）、预写标记直启后内嵌 dsh 以 `--profile web --host 127.0.0.1 --no-open` 运行并监听回环 3080、渲染进程启用 sandbox。2026-11-25 随包 pnpm：`runtime-lock.json` 登记 pnpm 11.28.5（与根 `packageManager` 同版），暂存脚本按字节与 SHA-256 核验 npm 制品后解包到 `resources/pnpm/`；壳经自有入口 `src/embedded-cli.mjs` 调用 dsh 公开导出的 `runCli({ packageManager })`，dsh 的每次包操作都以应用二进制为 Node 运行随包 pnpm，不改 DSH。本机 mac `--dir` 构建冒烟：PATH 上没有 node、npm、pnpm 时，首启装入企业插件并进入工作区；同一条件下不带随包 pnpm 的构建停在引导页 `FIRST_RUN_FAILED`。2026-11-25 首启排障明细（负责人确认开发阶段显示）：首启失败时状态页显示安装器的错误码、原因与处理办法以及日志位置；应用数据目录下的 `logs/first-run.log`（0600）记录每次首启尝试的安装器结论、回显与警告，以及每个导致应用退出的失败。安装器在失败结论里带上走到失败为止的回显（`progress`），原因摘要保留真正的报错行而不是调用栈尾部。本机 mac 实测（PATH 上无 node、npm、pnpm）：IAM 不可达时显示 `IAM_DISCOVERY_FAILED` 与 Discovery 地址；IAM 可达且插件完整时停在 `IAM_CLIENT_SECRET_PROVISION_FAILED`，页面与日志直接显示原因 `dsh: invalid profile name`。密钥入库通道同日修复：壳向安装器提供脚本执行器（`src/process.mjs` 的 `embeddedScriptExec`），三条密钥命令以应用二进制为 Node 直接运行插件自带的 forge-iam CLI；本机 mac 实测（PATH 上无 node、npm、pnpm，IAM 以本地服务代替）：首启装插件、核验、密钥入库全部完成并进入工作区，密钥写入隔离凭据库的 `credentials.sqlite`，明文随后删除。2026-11-25 窗口先行改造（负责人裁决：先开界面、页内提示、后续配置）：需要首启或首启失败时，窗口先于运行时打开并加载壳自带本地品牌引导页 `brand/status.html`（无 preload、无外链，状态与错误码经查询串注入，不承载企业配置值），应用驻留，托盘菜单「重试企业配置」幂等续跑，成功后窗口改载 launch URL；不以未打补丁的默认 profile 提前提供界面（O3 官方登录旁路在企业补丁装载前保持敞开），运行时段失败仍走对话框+退出。2026-11-26 独占 profile：壳不再与终端 CLI 共用 `web` profile，改用独占的 `heluo-desktop`（自定义名，缺失时由安装器经内嵌运行时从 web 模板创建）并监听固定端口 30810，与终端 `dsh web` 可同时运行、窗口的源跨启动不变；同日安装器识别 pnpm 的 store 不一致，并在壳声明拥有该 profile 时清空 `node_modules` 后重试。此前各次冒烟均在 `--profile web` 与默认端口下取得，新形态目前只有离线用例。2026-11-25 无边框窗口（负责人选择自绘按钮）：macOS 与 Windows 隐藏系统标题栏，窗口自身的页面是壳自绘的标题栏 `brand/titlebar.html`（28 / 32 像素，颜色随系统深浅色），引导页与工作区在它的内容视图里，工作区页面不打宿主标记、不注入样式；只有标题栏页面带 preload（`src/window-chrome.preload.cjs`），桥接只有最小化、缩放、关闭三个无参动作，主进程校验调用方，并在该页面上确认桥接已注入才继续启动。本机 mac 实测（深色外观）：标题栏与内容各就其位，三个按钮、最大化与失焦状态推送、全屏收起与恢复、第二份实例把隐藏或最小化的窗口调回均成立，标题栏的偏移、间距与颜色和系统原生逐像素一致；实测修正两处缺陷——启动与回到前台时键盘落在标题栏、最小化被焦点归还撤销。2026-11-26 PR 评审后修正两处（桥接以页面上实际生效为准，全屏布局向窗口询问实际状态），并以主进程报出的窗口事实复验全屏往返、最大化与焦点状态，标题栏与内容页逐项一致。同日补验装载企业插件后的窗口（此前实测预写首启标记，内容是未装载企业插件的 web 界面）：载荷按台账重新暂存（dsh 0.2.2-rc.5），隔离 profile 装入从 HEAD 构建的企业插件并接仓库测试用的模拟 IdP（同 `scripts/probe/run-iam-local-uat.sh` 的做法），壳以沙箱 `HOME` 承载——企业插件要求宿主不低于 0.2.2-rc.5，旧暂存载荷上的 dsh 装不上它；工作区显示企业服务初始化向导，经系统浏览器完成模拟登录后显示企业账号已认证，标题栏与内容各就其位，壳无报错，本机真实凭据库、DSH 目录与应用数据未被触碰。同日再验经壳首启的完整路径：用制包工具从 HEAD 造一份配置指向仓库模拟 IAM 与网关（`scripts/probe/mock-iam-gateway.mjs`）的合成员工包，壳在沙箱 `HOME` 与全新的用户数据目录里首启——状态页显示初始化中，安装器经内嵌入口与随包 pnpm 执行 `dsh plugin --profile web add` 并核验通过，客户端密钥写入沙箱内的凭据库、明文密钥被删除，15 秒内进入工作区并显示企业服务初始化向导，向导三步走完（登录模拟企业账号、保存合成网关凭证并取得企业模型、完成）；缩放、全屏与焦点状态以主进程报出的窗口事实核对一致，壳全程无报错。2026-11-26 内置运行时：`scripts/stage-primary-runtime.mjs` 按钉住的上游锁（`primary-runtime-lock.json`）暂存由 Node.js、pnpm、CPython 与 Office 库组成的载荷，壳经 `src/primary-runtime.mjs` 以 `DSH_PRIMARY_RUNTIME` 交出它的位置。本机 mac：`mac-arm64` 载荷构建并通过检查（294.5 MiB）；带载荷的 `--dir` 构建里，包内载荷经企业底座包到达 standard preset 的 agent（探针 `--app` 模式 28/28）。未做：独占 profile `heluo-desktop`、固定端口与 store 自愈的真机表现（目前只有离线用例）；真实企业 IAM 与网关；带品牌配置的员工包（合成包不含品牌配置，应用内回退上游默认品牌）；拖动（自动化没有系统鼠标事件权限）、浅色外观与原生对照、Windows 上的全部表现；Win10 x64 VM 安装验收（含随包 pnpm 在 Windows 上的首启）、内置运行时在 Windows 与 Linux 上的载荷与运行、真实企业网络下的 IAM 登录联调、产物签名（NSIS SmartScreen / mac Gatekeeper 右键打开）。桌面构建已于 2026-11-25 接入 `release-bundle` 流水线（mac-arm64 zip + windows-x64 NSIS exe 挂同一 tag 草稿）。核对日期：2026-11-26。

本目录是自有的 Electron 应用工程：一个窗口，顶部是壳自绘的标题栏，下方加载本机 `dsh --profile heluo-desktop`；一个托盘图标驻留。壳不修改 DSH，不编译上游 `apps/desktop`。设计见[桌面壳详细设计](../../docs/design/services/desktop-shell.md)（CORP-DSH-DESIGN-025），实施与验证归[桌面端成套打包工作计划](../../docs/plans/2026-11-19-desktop-bundle-packaging.md)（CORP-DSH-PLAN-026）。

## 清单

`package.json` 的 `devDependencies` 精确钉 `electron@44.7.0`（dsh 的原生加载器带 Electron 指纹白名单，浮动解析会被拒绝启动）与 `electron-builder@26.0.12`；二者是构建期工具，壳的 npm 形态（`files: ["src","README.md"]`）不夹带工具链，产物是打包后的安装包。`runtime-lock.json` 同时锁定随包 pnpm，版本须与根 `packageManager` 一致（暂存用例断言）。`primary-runtime-lock.json` 逐字节钉住上游为同一 dsh 版本发布的内置运行时锁（Node.js、CPython 与各 wheel），其中的 Node.js 与根 `.node-version` 同版（用例断言）。工作区为 `@electron/node-gyp` 的 git 引用钉回 npm 发布版（pnpm 11 拒绝 git 型子依赖），`onlyBuiltDependencies` 只放行 electron 的二进制下载 postinstall。Electron 二进制与 builder 自身依赖默认源可达性依环境而异，可用 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向镜像（环境配置，不入库）。清单里的 `engines.dsh` 是仓库检查器对服务清单的要求，取值与内嵌运行时的锁定版一致；壳本身不是 DSH 插件。仓库的离线检查不安装依赖，全部用例不需要 `electron`。

安装包只携带运行时会读取的文件，规则写在 `scripts/build-desktop-installer.mjs` 的打包配置里。`extraResources.filter` 排除 TypeScript 源码与类型声明、source map 和调试符号：内嵌 Node 拒绝为 `node_modules` 内的 `.ts` 剥离类型，壳又从子进程环境里剥离 `NODE_OPTIONS`，source map 不会被加载；`runtime-lock.json` 钉定的 `@deepseek-ai/dsh` 目录原样随包。内置运行时所在的 `primary-runtime/` 目录同样原样随包：它是暂存后检查过、并按文件数与字节数记入构建记录的那棵树（electron-builder 自己的默认规则仍会丢弃其中的空 `.gitkeep` 占位文件）。暂存脚本 `scripts/stage-desktop-payload.mjs` 在安装后执行同版本嵌套依赖去重、闭包清单校验及字节/文件数预算门禁。NSIS 归档关闭差分包、按 solid 压缩，并配置 `deleteAppDataOnUninstall: false` 以在异版本重装与回退时保留用户数据；安装脚本支持 `--arch` 指定 `macOS x64` 与 `linux arm64/x64` 目标。Electron 语言包只保留英文与简繁中文（去重后 6 项：`en`、`en-US`、`zh-CN`、`zh-TW`、`zh_CN`、`zh_TW`）；electron-builder 26 在 macOS 上不裁语言包，因为 Electron 44 把它们放在 Framework 内。构建摘要的 `resources` 记录暂存资源的文件数与字节数，以及其中被规则排除的部分。

## 模块

| 文件 | 职责 |
|---|---|
| `src/runtime.mjs` | dsh 子进程的生命周期状态机：`idle → starting → ready → stopping → stopped`，失败态 `failed` |
| `src/launch-url.mjs` | 从子进程输出取 launch URL（`dsh web: <地址>` 行），识别端口占用 |
| `src/loopback.mjs` | 回环地址的唯一判定：只有 `http://127.0.0.1:<端口>` |
| `src/navigation.mjs` | 窗口对目标地址的处置与权限请求判定（一律拒绝） |
| `src/shell-env.mjs` | 登录 shell 环境解析、与 GUI 环境合并、子进程环境净化（剥离 Node 与 Electron 开关、内置运行时的位置变量） |
| `src/process.mjs` | 一次性子命令的执行与超时；交给安装器的两个执行器（dsh 入口、插件脚本） |
| `src/embedded-cli.mjs` | dsh 的唯一入口：以 Node 运行，把随包 pnpm 作为包管理器交给 dsh 的命令行（`runCli({ packageManager })`） |
| `src/primary-runtime.mjs` | 校验随包的内置运行时，给出交给子进程的环境变量 `DSH_PRIMARY_RUNTIME` |
| `src/diagnostic.mjs` | 失败时告诉人什么：安装器结论的提取、日志条目、交给状态页的参数 |
| `src/first-run.mjs` | 企业资产的发现与完整性校验、首启标记、委托安装器初始化 profile |
| `src/lifecycle.mjs` | 关窗、退出与托盘的判定 |
| `src/window-chrome.mjs` | 窗口外观的判定：哪些平台由壳自绘标题栏、标题栏与内容如何分占窗口、标题栏可请求的窗口动作与调用方校验、桥接是否在页面上生效 |
| `src/window-chrome.preload.cjs` | 标题栏页面的桥接：三个无参窗口动作与窗口状态订阅，只交给这一页 |
| `resources/titlebar.html` | 壳自绘的标题栏页面：拖动区与最小化 / 最大化 / 关闭按钮，macOS 与 Windows 两种外观；暂存为 `brand/titlebar.html` |
| `src/shell.mjs` | 装配：把以上模块接到注入的 Electron 接口 |
| `src/main.mjs` | 程序入口：真实 `electron` 与安装后的路径 |

模块之间不互相持有状态；跨模块只经参数与回调传递。`shell.mjs` 接收 Electron 接口对象而不是直接 import `electron`，因此接线可以用替身离线测试；只有 `main.mjs` 依赖真实的 `electron`。

## 边界

- web 服务只绑定 `127.0.0.1` 的固定端口 30810（不是终端 `dsh web` 的默认端口 3080，两者可同时运行）；launch URL 不是回环地址时拒绝加载。端口固定，窗口的源跨启动不变，Web 客户端存在窗口 `localStorage` 里的会话草稿、快捷键覆盖、布局状态得以保留。
- 壳独占 `heluo-desktop` profile：不读写终端的 `web` profile，也不使用官方 Desktop 的 `desktop`（CLI 拒绝启动它，且会与官方应用撞目录）。终端 `dsh web` 是否带企业插件由员工包内的启动器决定。
- 与终端共享的是 `$DSH_HOME` 顶层的会话与官方凭据；设置与默认模型写入各 profile 自己的 `cordis.patch.yml`，不共享。企业凭据库按操作系统用户存放（macOS `~/Library/Application Support/HeluoForge`、Windows `%LOCALAPPDATA%\HeluoForge`、Linux `$XDG_DATA_HOME/HeluoForge`），与 `DSH_HOME`、profile 无关。
- 企业插件的管控范围是装载它的 profile：不带企业插件的终端 `dsh web` 能列出壳产生的会话，并用自己的模型续写。这一边界已接受；合规另有要求时壳改用独立的 `DSH_HOME`。
- launch URL 只从子进程完整的输出行里取，被管道截断的半行不算数；它带进程令牌，只交给窗口加载，事件、快照与错误信息里只有 origin。
- 窗口只加载本机服务。页面导航与新窗口请求里的其他 http(s) 地址交系统浏览器，其余拦截；服务端重定向只拦截，不代用户打开浏览器。
- 不确定的状态保持原状：不重复启动、不返回旧地址、不把未完成的停止报告为已停止。
- 候选目录中第一个带清单文件的即为当前员工包，它不完整时启动失败，不改用别的候选。列出的每个路径都必须是包内的普通文件，任一级是符号链接即拒绝；只容忍安装器会删除的密钥文件缺失。
- 员工包的摘要不带签名：校验证明的是「与写出时一致」，不是来源。能改写包的人同样能改写壳，完整性由分发渠道与安装位置守护，详见设计 §6。
- dsh 只经壳的入口启动。每次包操作（首启安装与应用内安装插件）都以应用二进制为 Node 运行随包的 pnpm：不查找 PATH 上的 pnpm，不改 PATH 或包管理器配置，pnpm 自己的全局目录与 store 沿用用户设置。包脚本若需要 PATH 上的 `node`（例如原生插件构建），不在覆盖范围内。壳向员工包内的安装器传 `--pnpm-from-host` 与 `--reinstall-on-store-mismatch`，所以壳与员工包须出自同一次构建：旧员工包里的安装器不认识这些参数，首启显示 `BAD_ARGUMENT：未知参数`。
- pnpm 报 store 不一致（`ERR_PNPM_UNEXPECTED_STORE`：该 profile 的 `node_modules` 由另一个 pnpm 的 store 链接）时，安装器以壳声明的 profile 所有权（`--reinstall-on-store-mismatch`）清空 `profiles/heluo-desktop/node_modules` 并重试该步一次，回显与警告写明清空过。清空只删这一个目录并逐项进行，目录内的链接只删链接本身；`node_modules` 本身是链接、不是目录或有文件删不掉时报 `PROFILE_RESET_FAILED`，清空后仍不一致报 `PROFILE_STORE_MISMATCH`。
- 首启失败时，状态页显示安装器的错误码、原因与处理办法；应用数据目录下的 `logs/first-run.log` 记录每次首启尝试的完整结论（回显与警告），以及导致应用退出的失败。日志只含安装器的结论与回显，不记环境变量、客户端密钥、令牌与 launch URL；写不进时应用照常运行。安装器的原文可能含本机路径与 Discovery 地址，当前按开发阶段的决定直接显示，正式分发前需决定是否收起。
- 密钥预置不经 dsh：安装器用脚本执行器（`embeddedScriptExec`）以应用二进制为 Node 直接运行插件自带的 `@heluo/forge-iam/bin/heluo-forge.mjs`（set、replace、空目录诊断三处）。该执行器只放行 profile 目录内路径归一的普通文件——dsh 的入口会把这个脚本的路径读成 profile 名，所以它前面什么都不加；终端单独运行安装器时不传该执行器，行为与原先一致。
- 插件安装、客户端密钥入库与明文删除由员工包内的安装器完成（`scripts/init-enterprise-plugin.mjs` 的 `runInit`）；壳不自己写 profile。向 `heluo-desktop` profile 写入 `cordis.patch.yml` 与企业 npm 源 / 索引 preset 是否需要，待计划 P0 相应探针的结论后确定，在此之前不写入；内置运行时的接入不需要 profile 级补丁层，由企业底座的补丁层交付。
- 子进程的环境是用户登录 shell 的环境，与在终端运行一致，不构成安全边界。壳只剥离会改变内嵌运行时工作方式的 Node 与 Electron 开关，以及内置运行时的位置变量；库注入类变量保留，企业的终端管控常经它们注入。
- 壳随包携带上游的内置运行时，但只交出它的位置：不读载荷内部，也不运行其中的解释器。读取、安装与运行都由上游的 `load_workspace_dependencies` 工具完成，首次调用时载荷被复制到 `$DSH_HOME/dsh-runtimes/` 下。`DSH_PRIMARY_RUNTIME` 由壳在合并完继承环境后设置，用户 shell 配置里的同名值到不了 `heluo-desktop` profile；载荷缺失、清单不可读或不是为本机构建时拒绝启动（`EMBEDDED_RUNTIME_MISSING`）。载荷自带的 pnpm 只供 agent 使用，壳的包操作仍走 `resources/pnpm`，两份是同一制品，统一是后续事项。
- 加载引导页与工作区的内容视图不获得任何壳能力：`contextIsolation`、`sandbox`、无 `nodeIntegration`、无 preload；全部权限请求默认拒绝。只有壳自有的标题栏页面带 preload，桥接只有最小化、缩放、关闭三个无参动作，主进程校验调用方是该页面的主框架且动作在白名单内；标题栏页面不可导航、不可打开新窗口。
- macOS 与 Windows 上窗口没有系统标题栏：标题栏是壳自己的页面，工作区页面不打宿主标记、不注入样式，DSH 页面结构变化不会让它错位。红灯关闭与黄灯最小化沿用关窗语义（运行中任务不中断）；绿灯在 macOS 上执行缩放（最大化），全屏经系统快捷键或菜单进入，全屏时标题栏收起，布局直接向窗口询问全屏状态。标题栏页面或它的桥接缺失、或桥接没有在页面上生效时，启动即报 `TITLE_BAR_MISSING`，不显示没有控件的窗口。

## 未验证项

`release-bundle` 已随 tag 构建 macOS arm64 与 Windows x64 桌面安装包供内部构建验证；在以下项全部收口前，产物不进入正式对外分发：

- `@deepseek-ai/dsh` 0.2.2-rc.5 的 `runCli({ packageManager })`、`dsh-web-app`（`--host`/`--port`/`--no-open` 与 `dsh web: <url>`）及 `node-addon-require-builtin` 白名单（含 `44.7.0`）已于 2026-11-26 离线核验；但其在 Windows 与 Linux 上的真实自承载启动仍未实测。
- Electron 44.7.0 内嵌 Node 下 `node:sqlite` 与凭据存储在 Windows 与 Linux 上的可用性（macOS 本机已证实可写）。
- Windows x64 VM 端到端安装、NSIS 静默参数实测与升级数据保留、麒麟双架构打包链与托盘可用性。
- 随包 pnpm 在 Windows 与 Linux 上的包操作（本机只在 mac-arm64 实测）。
- 首启失败明细、日志与密钥入库通道在 Windows 与 Linux 上的表现（本机只在 mac-arm64 实测）。
- 无边框窗口在 Windows 上的全部表现：拖动、贴靠、最大化边距、Alt+Space 系统菜单、Win10 与 Win11 样式差异（本机只在 mac-arm64 深色外观实测，Windows 外观只做了离线渲染）。macOS 上的拖动（自动化没有系统鼠标事件权限）与浅色外观和原生对照未验。
- 真实企业 IAM 与网关，以及带品牌配置的员工包：本机的窗口实测用的是仓库测试用的模拟 IAM 与网关、从 HEAD 造的不含品牌配置的合成员工包（应用内回退上游默认品牌）。在本机做首启验证时，凭据库默认落在用户主目录下而不是 `DSH_HOME`，必须把 `HOME` 或 `HELUO_FORGE_STORE_DIRECTORY` 指到沙箱。
- 内置运行时在 Windows 与 Linux 上的构建与运行；压缩后的安装包体积增量；签名构建下载荷里的 Mach-O 文件如何处理。
- 独占 profile `heluo-desktop` 与固定端口的真机表现：自定义 profile 经内嵌运行时从 web 模板创建、随包 pnpm 装入企业插件、窗口加载固定端口 30810、窗口的本地状态跨启动保留。现有冒烟证据均取得于 `--profile web` 与默认端口。
- 同一会话被壳与终端 `dsh web` 同时打开时的行为（两者端口不同，可以并行）。
- pnpm store 不一致时的自动修复：真实 pnpm 触发修复、Windows 上文件被占用时清空失败的表现、目录联接只删联接本身，均只有替身宿主的离线用例。
- 固定端口 30810 被占用时的表现，尤其是上一次壳异常退出后遗留的 dsh 子进程占着端口：壳以 `PORT_CONFLICT` 启动失败，提示不带端口号。

## 检查

```sh
node scripts/link-workspace.mjs
node --test services/forge-desktop/test/*.test.mjs
```

内置运行时的暂存用例在仓库根：`tests/stage-primary-runtime.test.mjs`、`tests/zip-archive.test.mjs`；到达 agent 的运行层核对用 `node scripts/probe/run-primary-runtime-probe.mjs --resources <暂存目录>`（见 `scripts/probe/README.md`）。

构建—壳契约（统一构建产出的员工包能被壳接受、安装器经壳的执行器启动内嵌运行时）在仓库根用例里：`tests/desktop-shell-contract.test.mjs`。
