# IAM 本地 mock 用户流程测试

本指南在开发者本机启动一套隔离的 DSH，用模拟 IAM 与内存凭证走完登录、配置网关、模型对话和退出。它从当前 `HEAD` 打包企业插件，因此不包含未提交的修改，也不改动现有 DSH 配置或正在运行的验收环境。

模拟 IAM 与内存凭证只用于本机测试。该组合显式注入测试夹具，绕过正式组合的存储信任门禁；它不能证明真实企业身份、授权、撤销或生产凭证存储可用，测试注入也不得用于生产。CLIProxyAPI 的上游调用可以是真实请求，可能产生费用。

回调按与真实 IAM 一致的前缀形态运行：插件自建回环监听，端口由系统分配，只在该次登录期间存在；IAM 管理台对 `http://127.0.0.1:` 前缀放行任意端口，本指南的 mock 走同一条路径。

## 准备

- 完整仓库和当前版本的 DSH 命令行宿主；`dsh` 能从 `PATH` 运行，或设置 `DSH_BIN` 指向可执行文件。本步骤在 macOS 的 DSH `0.2.2-rc.1` 上验证；其他平台和宿主版本需自行验证。
- Node.js 版本见仓库 `.node-version`，另需 `bash`、`npm`、`python3`、`git` 和 `tar`。在仓库根目录运行 `node --version`、`dsh --version` 及 `git status --short` 确认环境；`HEAD` 未包含的修改不会打包。
- 若要实际对话，先启动自己的本机 CLIProxyAPI，确认它提供 OpenAI 兼容的 `/v1/models` 和对话接口，且已有可用模型及访问 Key。默认地址为 `http://127.0.0.1:8317/v1`。不必将 Key 写入配置文件、命令或聊天，稍后在企业账号页面填写。无需真实模型时，可先完成登录、跳过配置及退出检查。
- 默认占用本机端口 `48388`（DSH）和 `48389`（入口）；如端口已使用，执行前设置 `IAM_UAT_HOST_PORT`、`IAM_UAT_ENTRY_PORT`。`IAM_UAT_CALLBACK_PORT` 只用于把回调端口固定下来做负向验证，取值 `0`（默认，系统分配）或 `1024–65535`；`IAM_UAT_GATEWAY` 可改预填网关地址，仅支持 `http://127.0.0.1` 上以 `/v1` 结尾的地址。

## 启动

在仓库根目录打开终端，执行以下命令并保持终端运行。脚本创建系统临时目录，通过 `git archive HEAD` 制作源码快照，在隔离 profile 安装企业插件，并仅在该副本注入模拟存储。`npm install` 可能需要访问已配置的包源。

```sh
bash scripts/probe/run-iam-local-uat.sh
```

非交互自检（验证打包、注入与宿主启动仍匹配当前 `HEAD`）：

```sh
IAM_UAT_SMOKE=1 bash scripts/probe/run-iam-local-uat.sh
```

脚本先检查 `node`、`npm`、`python3`、`git`、`tar` 与 `dsh`；Node 与仓库 `.node-version` 不一致时给出警告。`SMOKE OK` 表示入口 `/health` 返回 200，脚本随即停掉宿主与模拟 IAM。

终端会打印两行：测试入口，以及本次的回调端口形态（系统分配或固定值）。在本机浏览器打开入口；宿主尚未就绪时稍等并刷新。入口只监听 `127.0.0.1`，跳转地址中的一次性访问参数属于本地会话信息，不要分享。另开终端可检查 `curl -i http://127.0.0.1:48389/health`；若自定义了入口端口，替换其中的 `48389`。`200` 表示宿主已给出访问入口。

## 手动验证

1. 首次进入后选择开始，用模拟企业账号登录；浏览器完成回调后应进入凭证步骤。回调端口只在该次尝试期间开着，通常一闪而过，肉眼难以确认——需要确定性证据时用下方的自动用例，不必反复刷新。
2. 检查网关地址，输入自己的 CLIProxyAPI Key 并保存。Key 仅输入本机页面，不要截图或粘贴给他人；测试凭证保存在内存中，停止环境后丢失。也可选择稍后配置，再从“设置 → 企业账号”填写。
3. 等待或手动刷新模型列表，确认显示 CLIProxyAPI 提供的模型；选择模型发送一条不含敏感信息的测试消息，确认收到回复。模型是否可用取决于本机网关和上游服务；如果失败，先在本机网关侧排查认证、模型和上游状态，不记录 Key。
4. 在“设置 → 企业账号”退出，确认账号显示未登录、企业模型不再可选，尝试访问模型时提示重新登录。重新登录可继续验证；凭证是否仍可用以页面显示为准。
5. 如需覆盖令牌刷新，在登录状态下保持会话并等待模拟 access token 接近 120 秒有效期后再操作，观察会话仍可用；要证明刷新请求本身发生，使用下方自动探针，单凭页面状态不能证明。

退出检查后，在启动终端按 `Ctrl+C` 停止本次宿主和模拟 IAM。脚本会打印隔离目录；确认不再需要后，可按本机习惯删除该目录。重新执行会创建新目录和新状态，不影响原有配置。

## 负向验证

回环监听与端口拒绝是本指南最值得手工确认的两条路径，二者都不依赖真实模型。

- **端口被占用时拒绝登录**：先用 `node -e "require('node:net').createServer().listen(17890,'127.0.0.1')"` 占住 `17890`，再用 `IAM_UAT_CALLBACK_PORT=17890 bash scripts/probe/run-iam-local-uat.sh` 启动。点击登录应立即提示“登录回调端口被占用，暂时无法登录”，不跳转、不改用宿主端口（`48388`）。
- **尝试过期后回调失效**：回调尝试默认在 `attemptTimeoutSeconds`（300 秒）后过期，监听也随之关闭。手工验证需要等待，通常交给单元用例覆盖，不必在 UAT 里空等。

## 读取路径矩阵（2026-11-06）

存储读取不是单条路径，也不是单平台成立就算完成。当前覆盖：

| 读取路径 | 入口 | 覆盖方式 |
|---|---|---|
| Provider 读取 | `createKeychainProvider(...).readRecord()` | 6 个 `platform-arch` 全覆盖（Windows/Linux 注入原生模块，macOS 临时加密目录） |
| 身份投影 | `sessionFromRecord()`（`auth whoami` 的数据源） | 同上 |
| 访问令牌投影 | `accessTokenOf()`（`auth token` 的数据源） | 同上 |
| 独立读取器重开 | 新建 provider 读取同一 store | 同上 |
| Host 服务读取 | `ctx.iam.getSession()` / `getAccessToken()` | 6 个 `platform-arch` 全覆盖，store 由各平台后端提供 |
| HTTP 身份 | `GET /api/forge-iam/session` | 同上，经真实路由处理 |
| HTTP 令牌 | `POST /api/forge-iam/token` | 同上，含请求头门禁 |
| CLI 端到端 | `heluo-forge auth whoami / token` | macOS 加密存储真机用例；Windows/Linux 由 CI 按真实平台覆盖 |

矩阵用例：`node --test packages/forge-iam/test/read-paths-matrix.test.mjs`。CI 的 `device` job 在六台真实 runner 上复跑同一批读取路径与凭据后端用例：`ubuntu-24.04`、`ubuntu-24.04-arm`、`windows-2022`、`windows-11-arm`、`macos-26`、`macos-26-intel`；每台先断言 `process.platform`/`process.arch`，再执行测试。CLI 的 macOS 端到端用例在 `packages/forge-iam/test/cli-session.test.mjs`（仅 darwin 运行）。

平台交付形状：

- Windows x64/arm64、Linux x64/arm64：`@napi-rs/keyring` 2.1.2 原生 addon；未取证前 `unvetted`，CLI 与插件一样拒绝，`HELUO_FORGE_ALLOW_UNVETTED=1` 仅用于本地验证。
- macOS arm64/x64：应用层加密文档（AES-256-GCM + 0600 密钥），不经过 `unvetted` 开关，SSH 会话可用。

CLI 默认走与插件相同的 `createPlatformBackend()`；`HELUO_FORGE_CREDENTIALS_FILE` 仍是显式开发用明文覆盖，不用于生产。

## 自动验证与排障

回调监听的生命周期由单元用例确定性覆盖，不依赖浏览器时序：

```sh
node --test packages/forge-iam/test/callback-port.test.mjs
```

该组用例覆盖系统分配端口、固定端口、端口被占用时拒绝且不回落、回调结束后释放端口、客户端挂起连接不能拖住释放、Host 与路径与非回环对端的拒绝，以及 IPv6 回环的真实请求。

无需手动提供 Key 的宿主组合探针使用模拟 IAM、模拟模型网关和内存存储，验证模型目录、对话、令牌刷新及退出后的拒绝：

```sh
node scripts/probe/run-iam-managed-models-probe.mjs
```

探针需要已安装的 DSH；如 `dsh` 不在 `PATH`，可通过 `DSH_BIN` 指定。需要显式指定宿主模块目录时使用 `DSH_NODE_MODULES`，具体发现规则见 `scripts/lib/dsh-probe-runtime.mjs`。探针不是浏览器 GUI 或真实上游验收。

- **端口冲突**：更换 `IAM_UAT_HOST_PORT` 和 `IAM_UAT_ENTRY_PORT` 后重新启动；不要结束其他人的进程。
- **宿主找不到或无法启动**：核对 `dsh --version`、`DSH_BIN` 和终端输出；该步骤未安装 DSH。
- **登录提示“登录回调端口被占用”**：仅当把 `IAM_UAT_CALLBACK_PORT` 固定到已被占用的端口时出现；去掉该变量即回到系统分配。
- **回调页返回 403 或 404**：Host 或路径与监听地址不一致，通常是手工改写地址或代理改写 `Host`；用脚本打印的入口重新发起，不要手工拼接回调 URL。
- **未登录或尚未保存凭证时无法获取模型**：先完成模拟登录并保存网关凭证，这是预期门禁。只运行 `packages/forge-iam/scripts/mock-oidc.mjs` 不会提供本指南的测试存储，不能单独解除正式组合的门禁。
- **无法获取列表或对话失败**：确认网关地址以 `/v1` 结尾、服务正在监听、Key 和上游模型可用；未授权的 `/v1/models` 返回 401 只能证明服务可到达，不能证明 Key 正确。
- **重启后需要重新填写**：本指南使用短暂的内存存储；保留临时目录不会保留测试凭证。

如需复现未提交的源码修改，先通过项目正常流程形成可供测试的提交或单独准备可审阅快照；本指南不会擅自打包其他会话的未提交改动。

**入口**：本指南的常驻页是 [issue #147](https://github.com/hrygo/heluo-forge/issues/147)（置顶、不关闭）的 B 段。与本指南不符之处请在该页留言，附命令、平台与版本。