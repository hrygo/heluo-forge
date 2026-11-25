# 桌面壳（河洛 Forge 企业版）

状态：可用（开发骨架）。判断逻辑与装配层离线测试齐备；Electron 44.7.0 与 electron-builder 26.0.12 已精确钉版入 devDependencies（package-shape 断言拒绝浮动）；载荷暂存（`scripts/stage-desktop-payload.mjs` + `runtime-lock.json` 台账）与安装包配置（`scripts/build-desktop-installer.mjs`，身份真源消费员工包 `branding/app-identity.json`）具备。2026-11-24 本机 mac `--dir` 构建冒烟：真实 Electron 启动、单实例、首启经安装器建 profile 并装入 `@heluo/forge-enterprise` 0.1.2-corp.1（沙箱 DSH_HOME）、IAM Discovery 止步企业内网边界（设计内降级）、预写标记直启后内嵌 dsh 以 `--profile web --host 127.0.0.1 --no-open` 运行并监听回环 3080、渲染进程启用 sandbox。2026-11-25 随包 pnpm：`runtime-lock.json` 登记 pnpm 11.28.5（与根 `packageManager` 同版），暂存脚本按字节与 SHA-256 核验 npm 制品后解包到 `resources/pnpm/`；壳经自有入口 `src/embedded-cli.mjs` 调用 dsh 公开导出的 `runCli({ packageManager })`，dsh 的每次包操作都以应用二进制为 Node 运行随包 pnpm，不改 DSH。本机 mac `--dir` 构建冒烟：PATH 上没有 node、npm、pnpm 时，首启装入企业插件并进入工作区；同一条件下不带随包 pnpm 的构建停在引导页 `FIRST_RUN_FAILED`。2026-11-25 首启排障明细（负责人确认开发阶段显示）：首启失败时状态页显示安装器的错误码、原因与处理办法以及日志位置；应用数据目录下的 `logs/first-run.log`（0600）记录每次首启尝试的安装器结论、回显与警告，以及每个导致应用退出的失败。安装器在失败结论里带上走到失败为止的回显（`progress`），原因摘要保留真正的报错行而不是调用栈尾部。本机 mac 实测（PATH 上无 node、npm、pnpm）：IAM 不可达时显示 `IAM_DISCOVERY_FAILED` 与 Discovery 地址；IAM 可达且插件完整时停在 `IAM_CLIENT_SECRET_PROVISION_FAILED`，页面与日志直接显示原因 `dsh: invalid profile name`。密钥入库通道同日修复：壳向安装器提供脚本执行器（`src/process.mjs` 的 `embeddedScriptExec`），三条密钥命令以应用二进制为 Node 直接运行插件自带的 forge-iam CLI；本机 mac 实测（PATH 上无 node、npm、pnpm，IAM 以本地服务代替）：首启装插件、核验、密钥入库全部完成并进入工作区，密钥写入隔离凭据库的 `credentials.sqlite`，明文随后删除。2026-11-25 窗口先行改造（负责人裁决：先开界面、页内提示、后续配置）：需要首启或首启失败时，窗口先于运行时打开并加载壳自带本地品牌引导页 `brand/status.html`（无 preload、无外链，状态与错误码经查询串注入，不承载企业配置值），应用驻留，托盘菜单「重试企业配置」幂等续跑，成功后窗口改载 launch URL；不以未打补丁的默认 profile 提前提供界面（O3 官方登录旁路在企业补丁装载前保持敞开），运行时段失败仍走对话框+退出。未做：Win10 x64 VM 安装验收（含随包 pnpm 在 Windows 上的首启）、内置 Node 工具链与 Python/Office 库（P2-4 其余部分）、真实企业网络下的 IAM 登录联调、产物签名（NSIS SmartScreen / mac Gatekeeper 右键打开）。桌面构建已于 2026-11-25 接入 `release-bundle` 流水线（mac-arm64 zip + windows-x64 NSIS exe 挂同一 tag 草稿）。核对日期：2026-11-25。

本目录是自有的 Electron 应用工程：一个窗口加载本机 `dsh --profile web`，一个托盘图标驻留。壳不修改 DSH，不编译上游 `apps/desktop`。设计见[桌面壳详细设计](../../docs/design/services/desktop-shell.md)（CORP-DSH-DESIGN-025），实施与验证归[桌面端成套打包工作计划](../../docs/plans/2026-11-19-desktop-bundle-packaging.md)（CORP-DSH-PLAN-026）。

## 清单

`package.json` 的 `devDependencies` 精确钉 `electron@44.7.0`（dsh 的原生加载器带 Electron 指纹白名单，浮动解析会被拒绝启动）与 `electron-builder@26.0.12`；二者是构建期工具，壳的 npm 形态（`files: ["src","README.md"]`）不夹带工具链，产物是打包后的安装包。`runtime-lock.json` 同时锁定随包 pnpm，版本须与根 `packageManager` 一致（暂存用例断言）。工作区为 `@electron/node-gyp` 的 git 引用钉回 npm 发布版（pnpm 11 拒绝 git 型子依赖），`onlyBuiltDependencies` 只放行 electron 的二进制下载 postinstall。Electron 二进制与 builder 自身依赖默认源可达性依环境而异，可用 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向镜像（环境配置，不入库）。清单里的 `engines.dsh` 是仓库检查器对服务清单的要求，取值与内嵌运行时的锁定版一致；壳本身不是 DSH 插件。仓库的离线检查不安装依赖，全部用例不需要 `electron`。

安装包只携带运行时会读取的文件，规则写在 `scripts/build-desktop-installer.mjs` 的打包配置里。`extraResources.filter` 排除 TypeScript 源码与类型声明、source map 和调试符号：内嵌 Node 拒绝为 `node_modules` 内的 `.ts` 剥离类型，壳又从子进程环境里剥离 `NODE_OPTIONS`，source map 不会被加载；`runtime-lock.json` 钉定的 `@deepseek-ai/dsh` 目录原样随包。NSIS 归档关闭差分包、按 solid 压缩：差分形式只服务 electron-updater，本应用不建更新 feed。Electron 语言包只保留英文与简繁中文；electron-builder 26 在 macOS 上不裁语言包，因为 Electron 44 把它们放在 Framework 内。构建摘要的 `resources` 记录暂存资源的文件数与字节数，以及其中被规则排除的部分。

## 模块

| 文件 | 职责 |
|---|---|
| `src/runtime.mjs` | dsh 子进程的生命周期状态机：`idle → starting → ready → stopping → stopped`，失败态 `failed` |
| `src/launch-url.mjs` | 从子进程输出取 launch URL（`dsh web: <地址>` 行），识别端口占用 |
| `src/loopback.mjs` | 回环地址的唯一判定：只有 `http://127.0.0.1:<端口>` |
| `src/navigation.mjs` | 窗口对目标地址的处置与权限请求判定（一律拒绝） |
| `src/shell-env.mjs` | 登录 shell 环境解析、与 GUI 环境合并、子进程环境净化 |
| `src/process.mjs` | 一次性子命令的执行与超时；交给安装器的两个执行器（dsh 入口、插件脚本） |
| `src/embedded-cli.mjs` | dsh 的唯一入口：以 Node 运行，把随包 pnpm 作为包管理器交给 dsh 的命令行（`runCli({ packageManager })`） |
| `src/diagnostic.mjs` | 失败时告诉人什么：安装器结论的提取、日志条目、交给状态页的参数 |
| `src/first-run.mjs` | 企业资产的发现与完整性校验、首启标记、委托安装器初始化 profile |
| `src/lifecycle.mjs` | 关窗、退出与托盘的判定 |
| `src/shell.mjs` | 装配：把以上模块接到注入的 Electron 接口 |
| `src/main.mjs` | 程序入口：真实 `electron` 与安装后的路径 |

模块之间不互相持有状态；跨模块只经参数与回调传递。`shell.mjs` 接收 Electron 接口对象而不是直接 import `electron`，因此接线可以用替身离线测试；只有 `main.mjs` 依赖真实的 `electron`。

## 边界

- web 服务只绑定 `127.0.0.1`；launch URL 不是回环地址时拒绝加载。
- launch URL 只从子进程完整的输出行里取，被管道截断的半行不算数；它带进程令牌，只交给窗口加载，事件、快照与错误信息里只有 origin。
- 窗口只加载本机服务。页面导航与新窗口请求里的其他 http(s) 地址交系统浏览器，其余拦截；服务端重定向只拦截，不代用户打开浏览器。
- 不确定的状态保持原状：不重复启动、不返回旧地址、不把未完成的停止报告为已停止。
- 候选目录中第一个带清单文件的即为当前员工包，它不完整时启动失败，不改用别的候选。列出的每个路径都必须是包内的普通文件，任一级是符号链接即拒绝；只容忍安装器会删除的密钥文件缺失。
- 员工包的摘要不带签名：校验证明的是「与写出时一致」，不是来源。能改写包的人同样能改写壳，完整性由分发渠道与安装位置守护，详见设计 §6。
- dsh 只经壳的入口启动。每次包操作（首启安装与应用内安装插件）都以应用二进制为 Node 运行随包的 pnpm：不查找 PATH 上的 pnpm，不改 PATH 或包管理器配置，pnpm 自己的全局目录与 store 沿用用户设置。包脚本若需要 PATH 上的 `node`（例如原生插件构建），不在覆盖范围内。壳向员工包内的安装器传 `--pnpm-from-host`，所以壳与员工包须出自同一次构建：旧员工包里的安装器不认识该参数，首启显示 `BAD_ARGUMENT：未知参数`。
- 首启失败时，状态页显示安装器的错误码、原因与处理办法；应用数据目录下的 `logs/first-run.log` 记录每次首启尝试的完整结论（回显与警告），以及导致应用退出的失败。日志只含安装器的结论与回显，不记环境变量、客户端密钥、令牌与 launch URL；写不进时应用照常运行。安装器的原文可能含本机路径与 Discovery 地址，当前按开发阶段的决定直接显示，正式分发前需决定是否收起。
- 密钥预置不经 dsh：安装器用脚本执行器（`embeddedScriptExec`）以应用二进制为 Node 直接运行插件自带的 `@heluo/forge-iam/bin/heluo-forge.mjs`（set、replace、空目录诊断三处）。该执行器只放行 profile 目录内路径归一的普通文件——dsh 的入口会把这个脚本的路径读成 profile 名，所以它前面什么都不加；终端单独运行安装器时不传该执行器，行为与原先一致。
- 插件安装、客户端密钥入库与明文删除由员工包内的安装器完成（`scripts/init-enterprise-plugin.mjs` 的 `runInit`）；壳不自己写 profile。向 `web` profile 写入 `cordis.patch.yml` 与企业 npm 源 / 索引 preset 是否需要，待计划 P0 第 6 项结论后确定，在此之前不写入。
- 子进程的环境是用户登录 shell 的环境，与在终端运行一致，不构成安全边界。壳只剥离会改变内嵌运行时工作方式的 Node 与 Electron 开关；库注入类变量保留，企业的终端管控常经它们注入。
- 渲染进程不获得任何壳能力：`contextIsolation`、`sandbox`、无 `nodeIntegration`、无 preload；全部权限请求默认拒绝。

## 未验证项

以下结论出来之前不产出安装包：

- 锁定版 dsh 的 launch URL 输出行与命令行选项（当前依据 0.2.2-rc.5 的静态阅读）。
- Electron 44.7.0 内嵌 Node 下 `node:sqlite` 与凭据存储的可用性。
- Windows 与 Linux 自承载、三平台打包链、麒麟托盘可用性。
- 随包 pnpm 在 Windows 与 Linux 上的包操作（本机只在 mac-arm64 实测）。
- 首启失败明细、日志与密钥入库通道在 Windows 与 Linux 上的表现（本机只在 mac-arm64 实测；SQLite 凭据库在 Electron 内嵌 Node 下可写已在本机证实）。
- `main.mjs` 中内嵌运行时与企业资产的路径是打包步骤将要暂存的布局，随首个安装包确认。

## 检查

```sh
node scripts/link-workspace.mjs
node --test services/forge-desktop/test/*.test.mjs
```

构建—壳契约（统一构建产出的员工包能被壳接受、安装器经壳的执行器启动内嵌运行时）在仓库根用例里：`tests/desktop-shell-contract.test.mjs`。
