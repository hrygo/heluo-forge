# 桌面壳（河洛 Forge 企业版）

状态：可用（壳的判断逻辑与装配层已实现并离线测试，清单已建立）。Electron 入口尚未运行，打包链未验证，不构成可分发客户端。核对日期：2026-11-24。

本目录是自有的 Electron 应用工程：一个窗口加载本机 `dsh --profile web`，一个托盘图标驻留。壳不修改 DSH，不编译上游 `apps/desktop`。设计见[桌面壳详细设计](../../docs/design/services/desktop-shell.md)（CORP-DSH-DESIGN-025），实施与验证归[桌面端成套打包工作计划](../../docs/plans/2026-11-19-desktop-bundle-packaging.md)（CORP-DSH-PLAN-026）。

## 清单

`package.json` 暂不声明依赖。壳运行所需的 `electron` 精确钉在 `44.7.0`（dsh 的原生加载器带 Electron 指纹白名单，浮动解析会被拒绝启动），它与 `electron-builder` 随计划 P2 的打包步骤一并加入，届时同步锁文件：现在声明会让本地的 `pnpm check` 联网安装并改写锁文件，而单靠声明依赖也拿不到 Electron 二进制。清单里的 `engines.dsh` 是仓库检查器对服务清单的要求，取值与内嵌运行时的锁定版一致；壳本身不是 DSH 插件。仓库的离线检查不安装依赖，用例不需要 `electron`。

## 模块

| 文件 | 职责 |
|---|---|
| `src/runtime.mjs` | dsh 子进程的生命周期状态机：`idle → starting → ready → stopping → stopped`，失败态 `failed` |
| `src/launch-url.mjs` | 从子进程输出取 launch URL（`dsh web: <地址>` 行），识别端口占用 |
| `src/loopback.mjs` | 回环地址的唯一判定：只有 `http://127.0.0.1:<端口>` |
| `src/navigation.mjs` | 窗口对目标地址的处置与权限请求判定（一律拒绝） |
| `src/shell-env.mjs` | 登录 shell 环境解析、与 GUI 环境合并、子进程环境净化 |
| `src/process.mjs` | 一次性子命令的执行与超时；交给安装器的内嵌运行时执行器 |
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
- 插件安装、客户端密钥入库与明文删除由员工包内的安装器完成（`scripts/init-enterprise-plugin.mjs` 的 `runInit`）；壳不自己写 profile。向 `web` profile 写入 `cordis.patch.yml` 与企业 npm 源 / 索引 preset 是否需要，待计划 P0 第 6 项结论后确定，在此之前不写入。
- 子进程的环境是用户登录 shell 的环境，与在终端运行一致，不构成安全边界。壳只剥离会改变内嵌运行时工作方式的 Node 与 Electron 开关；库注入类变量保留，企业的终端管控常经它们注入。
- 渲染进程不获得任何壳能力：`contextIsolation`、`sandbox`、无 `nodeIntegration`、无 preload；全部权限请求默认拒绝。

## 未验证项

以下结论出来之前不产出安装包：

- 锁定版 dsh 的 launch URL 输出行与命令行选项（当前依据 0.2.2-rc.5 的静态阅读）。
- Electron 44.7.0 内嵌 Node 下 `node:sqlite` 与凭据存储的可用性。
- Windows 与 Linux 自承载、三平台打包链、麒麟托盘可用性。
- `main.mjs` 中内嵌运行时与企业资产的路径是打包步骤将要暂存的布局，随首个安装包确认。

## 检查

```sh
node scripts/link-workspace.mjs
node --test services/forge-desktop/test/*.test.mjs
```

构建—壳契约（统一构建产出的员工包能被壳接受、安装器经壳的执行器启动内嵌运行时）在仓库根用例里：`tests/desktop-shell-contract.test.mjs`。
