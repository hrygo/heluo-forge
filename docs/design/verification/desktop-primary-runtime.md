# 内置运行时（桌面壳）实现与验证记录

记录对象是桌面壳随包携带的上游内置运行时：载荷的暂存、企业底座补丁层里让它对 `web` profile 生效的两行、壳交出其位置的方式，以及打包与流水线上的接线。设计见 [CORP-DSH-DESIGN-025](../services/desktop-shell.md)，实施计划见 [CORP-DSH-PLAN-026 §4.3](../../plans/2026-11-19-desktop-bundle-packaging.md)。

**实现边界**：

- 载荷由 `scripts/stage-primary-runtime.mjs` 组装，输入是 `services/forge-desktop/primary-runtime-lock.json` 里逐字节钉住的上游锁：Node.js、CPython、13 个 wheel 与 `runtime-lock.json` 已锁定的同一个 pnpm 制品，每个归档按 SHA-256 核对，布局取自暂存好的 dsh 闭包里上游自己导出的函数。`--verify-lock` 把钉住的锁与上游为当前 dsh 版本发布的文件比对。zip 读取（`scripts/lib/zip-archive.mjs`）不依赖外部解压工具，逐成员校验 CRC-32。
- 两行覆盖位于 `packages/forge-enterprise/cordis.patch.yml`：按 id 命中上游的 `workspace-dependencies` 与 `skill-office`，带 `name` 守卫，只在 `DSH_PRIMARY_RUNTIME` 有值时生效。
- 壳只交出位置：`layout.mjs` 的两个常量、`src/primary-runtime.mjs` 的校验、`shell-env.mjs` 对继承环境里同名变量的剥离、`main.mjs` 合并环境后的一处写入。载荷缺失、清单不可读或不是为本机构建时拒绝启动。
- 打包与流水线：内置运行时所在的目录原样随包；`release-bundle` 的两个桌面任务先核对台账与上游一致，再在 dsh 闭包之后、打包之前暂存载荷。
- 运行层核对由 `scripts/probe/run-primary-runtime-probe.mjs` 承担，见 [探针说明](../../../scripts/probe/README.md)：`--resources` 对暂存目录核对，`--app` 对打出来的应用包核对。
- 不在范围内：Windows 与 Linux 上的构建与运行；安装包签名与公证；首启安装器的界面流程；包操作改用载荷里的 Node.js 与 pnpm。

**验证结果与限制**：2026-11-26，分支 `feat/desktop-primary-runtime`（基于 `a931ff1`），macOS arm64，Node 24.21.0，DSH 0.2.2-rc.5。

| 验证 | 结果 |
|---|---|
| 本机真实构建（`mac-arm64`） | 通过，31 秒。载荷 4396 项、294.5 MiB，其中 Node.js 128 MiB、CPython 与库 175 MiB、pnpm 23 MiB；裁掉 3 个外平台原生包与 14 个上游测试目录；检查全部通过，检查前后暂存载荷的字节数不变 |
| `--dir` 打包 | 通过，15 秒（未签名）。包内载荷与暂存载荷的 4393 个普通文件路径与摘要逐一相同，两个解释器别名保持相对链接；差别只有 electron-builder 默认规则丢弃了 pnpm 副本里一个空的 `.gitkeep` |
| 打包产物端到端 | 探针 `--app` 模式 28/28。以打出来的 `.app` 为准：它自己的 Electron 44.7.0（Node 模式）、`app.asar` 里的壳入口、包内 pnpm、包内 dsh 闭包与载荷；企业底座包由本分支构建并经壳入口安装。工具经企业底座的补丁层注册，对 standard preset 的 agent 可见，包内载荷被安装到 Harness home，Office 技能指向内置依赖，agent 的 shell 用内置 Python 跑通 numpy、pandas 与三个 Office 库 |
| 运行层探针 | 对暂存目录：`--patch` 覆盖层配 Electron 44.7.0 运行器 23/23；企业底座包配 Node 24.21.0 运行器 27/27 |
| 离线用例 | 载荷暂存 25、zip 读取 9、企业包 20、壳 92 全部通过；流水线契约用例覆盖验锁、暂存参数与先后次序 |

**未验**：

- Windows 与 Linux（含麒麟）的载荷没有构建，也没有运行；`win-x64` 只会由 CI 的原生运行器暂存并检查。
- 没有走首启安装器的界面流程；端到端里的企业底座包是手工经壳入口安装的。
- 安装包压缩后的体积增量没有测量；已知载荷解包后为 294.5 MiB。
- macOS 上的签名与公证：载荷里的 Mach-O 文件（`node`、`python3.12`、各 `.so`）在签名构建下如何处理未验证。

**随包第三方组件与许可（代拟，待项目负责人确认）**：下表的 Python 发行包许可取自上游为同一 dsh 版本生成的第三方声明，并逐项核对了载荷内各 wheel 的元数据。

| 组件 | 版本 | 许可 | 载荷内的许可文本 |
|---|---|---|---|
| Node.js | 24.21.0 | MIT，另有随包第三方组件声明 | 有（`dependencies/node/LICENSE`） |
| pnpm | 11.28.5 | MIT | 有 |
| CPython（python-build-standalone 构建） | 3.12.14 | PSF-2.0 | **没有**：上游的独立发行归档不附带许可文本，载荷里也找不到 PSF 许可协议 |
| numpy | 2.3.5 | BSD-3-Clause | 有 |
| pandas | 3.0.1 | BSD-3-Clause | 有 |
| lxml | 6.1.3 | BSD-3-Clause | 有 |
| Pillow | 12.3.0 | MIT-CMU | 有 |
| python-docx | 1.2.0 | MIT | 有 |
| python-pptx | 1.0.2 | MIT | 有 |
| openpyxl | 3.1.5 | MIT | 没有（wheel 只有许可表达式） |
| XlsxWriter | 3.2.9 | BSD-2-Clause | 有 |
| et-xmlfile | 2.0.0 | MIT | 没有（wheel 另带一份 PSF 文本，自身许可只在元数据里） |
| six | 1.17.0 | MIT | 有 |
| python-dateutil | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause | 有 |
| typing_extensions | 4.16.0 | PSF-2.0 | 有 |
| tzdata | 2025.2 | Apache-2.0 | 有 |
| pip（随解释器） | 26.2.1 | MIT | 有 |

需要裁决的一项：随企业安装包分发前是否补入 CPython 的 PSF 许可文本。另有一项与本记录无关的既有义务，属于 dsh 闭包而不属于本载荷：Office 转换引擎（LibreOffice Kit 各平台包）为 MPL-2.0，上游的第三方声明写明它不在宽松许可白名单内，接收方须能获得对应源码与声明。
