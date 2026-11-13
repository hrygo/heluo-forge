# IAM 本地模拟验收指南

本指南描述在开发者本机启动隔离 DSH，使用模拟 IAM 验证登录、身份与令牌读取、网关配置和退出。脚本从当前 `HEAD` 打包企业插件，因此不包含未提交的修改，也不改动现有 DSH 配置或正在运行的验收环境。各平台的已验证范围见[设计索引](../../../docs/design/README.md#22-实现与验证入口)。

身份与令牌读取、业务凭据存取的接口说明见[凭据接入指南](<credential-access.md>)；[issue #260](https://github.com/hrygo/heluo-forge/issues/260) 汇总开发者入口。

模拟 IAM 只用于本机测试。凭据插件的 `storeDirectory` 指向隔离的 SQLite 值级加密存储，IAM 通过组合注入的联合存储服务执行门禁。该环境不能证明真实企业身份、授权或撤销；本机模型网关的上游调用可能是真实请求并产生费用。

模拟登录默认使用 `http://127.0.0.1:` 回调前缀：插件为每次登录临时建立回环监听，端口由系统分配。企业 IAM 的回调登记和实际行为需在对应环境核验。

## 准备

- 完整仓库与 DSH 命令行宿主；`dsh` 需位于 `PATH`，也可设置 `DSH_BIN` 指向可执行文件。
- 仓库 `.node-version` 指定版本的 Node.js，以及 `bash`、`npm`、`python3`、`git` 和 `tar`。在仓库根目录使用 `node --version`、`dsh --version` 和 `git status --short` 检查环境与提交状态。
- 如需验证模型对话，准备本机 OpenAI 兼容网关（例如 CLIProxyAPI），确认 `/v1/models`、对话接口、模型与访问 Key 可用。仅验证 IAM 登录、读取和退出时可跳过网关配置。Key 在本机账号页录入，不写入配置文件、命令或聊天。

隔离脚本支持以下环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `IAM_UAT_HOST_PORT` | `48388` | DSH Host 端口 |
| `IAM_UAT_ENTRY_PORT` | `48389` | 测试入口端口，须与 Host 端口不同 |
| `IAM_UAT_CALLBACK_PORT` | `0` | 登录回调端口；`0` 表示系统分配，固定端口须为 1024–65535 |
| `IAM_UAT_GATEWAY` | `http://127.0.0.1:8317/v1` | 预填网关地址；仅支持 `127.0.0.1` 上以 `/v1` 结尾的 HTTP 地址 |

## 启动

在仓库根目录打开终端，执行以下命令并保持终端运行。脚本创建系统临时目录，通过 `git archive HEAD` 制作源码快照，在隔离 profile 安装企业插件，只把凭据存储目录和身份提供方指向隔离副本。`npm install` 可能需要访问已配置的包源。

```sh
bash scripts/probe/run-iam-local-uat.sh
```

非交互自检（检查打包与宿主启动，不覆盖登录或凭据写入门禁）：

```sh
IAM_UAT_SMOKE=1 bash scripts/probe/run-iam-local-uat.sh
```

脚本先检查 `node`、`npm`、`python3`、`git`、`tar` 与 `dsh`；Node 与仓库 `.node-version` 不一致时给出警告。`SMOKE OK` 表示入口 `/health` 返回 200，脚本随即停掉宿主与模拟 IAM。

构建和安装完成后，脚本打印隔离目录；宿主启动后会打印测试入口和本次的回调端口形态（系统分配或固定值）。在本机浏览器打开入口；宿主尚未就绪时稍等并刷新。入口只监听 `127.0.0.1`，跳转地址中的一次性访问参数属于本地会话信息，不要分享。另开终端可检查 `curl -i http://127.0.0.1:48389/health`；若自定义了入口端口，替换其中的 `48389`。`200` 表示宿主已给出访问入口。

## 手动验证

1. 首次进入后选择开始，用模拟企业账号登录；浏览器完成回调后应进入凭证步骤。回调端口只在该次尝试期间开放；监听行为可用下方自动用例验证。
2. 登录后、退出前，可按[读取隔离会话](#读取隔离会话)在另一个终端检查当前身份和访问令牌。只验证 IAM 时可跳过网关配置。
3. 需要验证模型对话时，检查网关地址，输入本机网关的 Key 并保存。Key 仅输入本机页面，不要截图或粘贴给他人；测试凭证写入隔离目录中的 SQLite 存储，停止进程不会自动删除。
4. 完成网关配置后，等待或手动刷新模型列表，确认显示网关提供的模型；选择模型发送一条不含敏感信息的测试消息，确认收到回复。模型是否可用取决于本机网关和上游服务；失败时检查网关认证、模型和上游状态，不记录 Key。
5. 如需观察令牌刷新，在登录状态下保持会话并等待模拟 access token 接近 120 秒有效期后再操作，观察会话仍可用；要证明刷新请求本身发生，使用下方自动探针，单凭页面状态不能证明。
6. 在“设置 → 企业账号”退出，确认账号显示未登录、企业模型不再可选，尝试访问模型时提示重新登录。重新登录可继续验证；凭证是否仍可用以页面显示为准。

退出检查后，在启动终端按 `Ctrl+C` 停止本次宿主和模拟 IAM。脚本会打印隔离目录；确认不再需要后，可按本机习惯删除该目录。重新执行会创建新目录和新状态，不影响原有配置。

## 读取隔离会话

登录完成后、停止宿主前，另开终端运行下列命令。源码 CLI 需先安装或链接工作区依赖，代码版本应与打包进 Host 的 `HEAD` 一致。未安装依赖时，可在仓库根目录运行 `node scripts/link-workspace.mjs` 离线建立同仓包链接。

将 `<隔离目录>` 替换为脚本打印的目录；如果启动时修改了 `IAM_UAT_HOST_PORT`，同时替换示例中的 `48388`。

```sh
HELUO_FORGE_STORE_DIRECTORY='<隔离目录>/dsh/credentials' \
  node packages/forge-iam/bin/heluo-forge.mjs auth whoami --json
HELUO_FORGE_STORE_DIRECTORY='<隔离目录>/dsh/credentials' \
  HELUO_FORGE_IAM_URL=http://127.0.0.1:48388 \
  node packages/forge-iam/bin/heluo-forge.mjs auth token
```

第一条读取本地身份快照；登录成功时 `signedIn` 为 `true`。第二条通过本机 Host 桥获取令牌，Host 可按需刷新；输出为测试令牌，不要记录或分享。退出成功后再次读取身份，`signedIn` 应为 `false`。读取失败时检查错误码；`whoami` 的退出码为 0 不单独证明已登录。接口与错误处理见[凭据接入指南](<credential-access.md>)。

## 负向验证

回环监听与端口拒绝可通过以下路径验证，均不依赖真实模型。

- **端口被占用时拒绝登录**：先用 `node -e "require('node:net').createServer().listen(17890,'127.0.0.1')"` 占住 `17890`，再用 `IAM_UAT_CALLBACK_PORT=17890 bash scripts/probe/run-iam-local-uat.sh` 启动。点击登录应立即提示“登录回调端口被占用，暂时无法登录”，不跳转、不改用宿主端口（`48388`）。
- **尝试过期后回调失效**：回调尝试默认在 `attemptTimeoutSeconds`（300 秒）后过期，监听也随之关闭。手工验证需要等待，通常交给单元用例覆盖，不必在 UAT 里空等。

## 目标机验证（已打包交付包）

验证已打包交付物时，可使用 `scripts/probe/mock-iam-gateway.mjs`。它只依赖 Node.js 标准库，模拟 IdP 与网关，可随交付包复制到测试机。

交付包的配置须与模拟器一致。默认值如下：

| 配置 | 默认值 |
|---|---|
| IAM issuer | `http://127.0.0.1:5599` |
| IAM client ID | `heluo-local-uat` |
| 网关 baseURL | `http://127.0.0.1:5600/v1` |

1. 测试机安装 Node.js LTS，解压交付包，在模拟脚本所在目录运行 `node mock-iam-gateway.mjs`，保持终端开启。
2. 运行交付包里的启动器安装插件，启动 `dsh web` 并打开带一次性参数的地址。
3. 在向导中登录：浏览器打开模拟 IdP，授权后回到交付包配置的回调地址，页面显示登录完成。回调端口为 `0` 时由系统分配；固定端口以交付包配置为准。
4. 录入任意非空测试 Key，模型列表应出现 `mock-chat-1`；发送一条消息应收到模拟回复。

模拟器的端口、client ID 与主体可分别通过 `MOCK_IAM_PORT`、`MOCK_GATEWAY_PORT`、`MOCK_CLIENT_ID`、`MOCK_SUBJECT` 覆盖。修改端口或 client ID 时，须重新打包或使用与之匹配的交付包配置。

它仍不是企业证据：`http` 明文、固定回环地址，模拟 IdP 的令牌状态只保存在其进程内，
客户端仍可将令牌写入本地凭据存储。模拟 IdP 不校验密码、授权策略或配额。真实验收需要企业 IAM 与网关，并按本指南的读取路径矩阵取证。

## 读取路径矩阵

四类访问令牌读取入口的调用方式和门禁如下：

| 读取路径 | 入口 | 行为与门禁 |
|---|---|---|
| 离线 CLI | `heluo-forge auth token` | 独立进程只读本地记录，不刷新，也不校验 Host 的发行者、客户端或 resource 配置 |
| Host 服务 | `ctx.iam.getAccessToken()` | 核验 Host 上下文，可在受信存储上按需刷新 |
| 同源 HTTP | `POST /api/forge-iam/token` | 经 Connection 鉴权与请求头检查后调用 Host |
| 本机桥接 | `POST /api/forge-iam/bridge/token` | 校验回环来源与能力值后调用 Host；配置 `HELUO_FORGE_IAM_URL` 的 CLI 还会回读存储核验会话 |

身份读取使用 `heluo-forge auth whoami`、`ctx.iam.getSession()` 或 `GET /api/forge-iam/session`，不返回令牌。CLI 读取本地记录，Host 与 HTTP 返回 Host 会话视图，二者可能暂时不同。

矩阵用例 `node --test packages/forge-iam/test/read-paths-matrix.test.mjs` 使用合成 SQLite 会话。测试结果适用于本次运行的环境，不能以模拟的平台标识代替其他平台或宿主的验证证据。

各平台使用同一 SQLite 后端，CLI 与插件共用存储目录解析；`HELUO_FORGE_STORE_DIRECTORY` 可为 CLI 指定隔离目录。当前已验证范围以[设计索引](../../../docs/design/README.md#22-实现与验证入口)为准。

## 自动验证与排障

### 自动验证

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

### 排障

- **端口冲突**：更换 `IAM_UAT_HOST_PORT` 和 `IAM_UAT_ENTRY_PORT` 后重新启动；不要结束其他人的进程。
- **宿主找不到或无法启动**：核对 `dsh --version`、`DSH_BIN` 和终端输出；该步骤未安装 DSH。
- **登录提示“登录回调端口被占用”**：仅当把 `IAM_UAT_CALLBACK_PORT` 固定到已被占用的端口时出现；去掉该变量即回到系统分配。
- **回调页返回 403 或 404**：Host 或路径与监听地址不一致，通常是手工改写地址或代理改写 `Host`；用脚本打印的入口重新发起，不要手工拼接回调 URL。
- **未登录或尚未保存凭证时无法获取模型**：先完成模拟登录并保存网关凭证，这是预期门禁。只运行 `packages/forge-iam/scripts/mock-oidc.mjs` 不会提供本指南的测试存储，不能单独解除正式组合的门禁。
- **无法获取列表或对话失败**：确认网关地址以 `/v1` 结尾、服务正在监听、Key 和上游模型可用；未授权的 `/v1/models` 返回 401 只能证明服务可到达，不能证明 Key 正确。
- **重新运行后需要重新填写**：脚本每次创建新的隔离目录，不自动复用以前的存储。停止宿主后原目录保留：凭据在脚本打印的 `dsh/credentials` 下以 SQLite 值级加密库 `credentials.sqlite` 保存，密钥在其兄弟目录 `dsh/credentials.keys` 的 `keyring.json`；两目录权限为 0700，属主为当前用户，跨宿主停止不会自动清除。确认不再需要后只删除本次运行打印的隔离目录（`rm -rf -- '<目录>'`），不要按通配删除其它目录；删除前确认没有其它进程仍在使用该目录。

如需验证未提交的源码修改，先形成可供测试的提交或独立可审阅快照；`git archive HEAD` 不包含工作区修改。
