---
name: heluo-forge-release-bundle
description: 供打包人员规划和制作企业 DSH 私版。GitHub Actions 私版流程使用本机未跟踪的 .env、私有发布仓库的 Actions Secrets、现有制包脚本及终端 SQLite 凭据预置。
---
# 企业 DSH 交付包制作

## 何时使用

打包人员要求在 GitHub 制作企业 DSH 私版时，读取 [GitHub Actions 私版制作方案](references/sop.md#9-github-actions-私版制作方案)。方案接通后，从指定的私有发布仓库触发制包，使用已核验的公版插件制品和配套工具链。

现有 `release-delivery` 脚本负责预览、配置注入、校验和组装员工 zip。下文的本机步骤用于当前可执行的私版制作及排查。公开源码仓库的 `release-bundle` 工作流提供公版构建输入，企业私版在指定的私有发布仓库或企业制品库交付。

## 角色

- **打包人员**负责配置、版本和公版摘要，按目标仓库的输入契约同步 Actions Secrets 并触发发布。
- **终端管理员或获准的部署工具**在目标 Host 的凭据目录和命名空间预置、轮换 IAM 客户端密钥。
- **员工**：收到最终 zip，按 `INSTALL.md` 安装并登录。终端管理员负责登录前的密钥预置。
- Skill 只服务打包人员，不要求安装用户填写任何企业字段。

## 不可让步的边界

- 本机制包使用受 Git 忽略的专用 `.env` 文件（`umask 077`，权限 600）；可供后续打包复用，不提交、不自动删除或覆盖。独立工具链的配置保存在不受版本管理的位置。GitHub Actions 方案的本机源文件与临时制包配置见 SOP §9。
- IAM 和网关地址等允许的配置会写入私版插件的 `cordis.patch.yml`，交付对象可见；完整 `.env`、密钥和令牌不进入交付物。配置值不作为命令行参数。
- Discovery 预检结果与错误只显示状态、字段名和受限错误码，不回显 issuer、端点或网络异常原文。预览与交付回执仍包含本地路径；分享报告前人工脱敏。
- 公版摘要必须来自发布页或另一条可信渠道，不信任制品旁边的 `SHA256SUMS`。
- 制作器核对工具链与公版中的 IAM 配置校验模块；不一致时使用该公版配套的工具链，不能跳过检查。
- 禁止全局文本替换；只允许工具声明的配置注入位置。
- 密钥、令牌、`client_secret` 不属于本交付；发现即停止。原始 `HELUO_IAM_CLIENT_SECRET` 和 `HELUO_IAM_CLIENT_SECRET_FILE` 键会报 `BUNDLE_SECRET_EMBED_UNSUPPORTED`，未知键会被拒绝。
- 输出目录必须在仓库外；缺字段、摘要不符、目录已存在或用户取消时安全失败，不覆盖、不留半成品。
- 官方 DSH 宿主原样使用：交付包不重签、不公证、不修改官方载荷，只安装企业插件。
- 企业地址默认只接受 HTTPS。确需内网 HTTP 时，先说明客户端密钥、令牌与个人 Key 的明文传输风险，取得打包人员明确确认后才写 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`。
- 运行期挂载只能在宿主「设置 → 插件」确认；工具输出 `mounted=unknown` 是正常的，不得写成挂载证据。

## 问答协议

逐个问题询问打包人员，每问给出默认值与校验规则；不要一次倾倒全部问题。

| 槽位 | 必填 | 默认 | 校验 |
|---|---|---|---|
| 公版 `.tgz` 路径 | 是 | — | 存在、文件名含版本 |
| 公版 SHA-256 | 是 | — | 64 位 hex，与本地文件一致；来源可信 |
| IAM issuer | 仅显式端点模式必填 | — | `https://` 绝对地址；无 query/fragment；内网 http 需显式安全确认。使用 Discovery URL 时不要提供本项：issuer 由 Discovery 文档提供，制作器拒绝两者并存，固定 issuer 与文档不一致会导致登录无法跳转 |
| IAM client_id | 是 | — | 非空，不含空白 |
| IAM 认证模式 | 企业目标部署必填 | `confidential` | `public` / `none` 仅适用于允许无认证换票和刷新的兼容部署；所有模式使用 PKCE S256 |
| IAM 客户端认证方法 | confidential 必填 | — | `client_secret_basic` 或 `client_secret_post`，与 IAM 登记的 `token_endpoint_auth_method` 精确一致 |
| IAM 客户端密钥引用 | confidential 必填 | — | 非秘密标识，匹配 `^[a-z][a-z0-9-]*$`；必须与终端预置引用一致 |
| IAM scopes | 否 | `openid profile offline_access` | 空格或逗号分隔；必须包含 `openid`，插件缺它会拒绝加载 |
| 网关 baseURL | 是 | — | `https://` 绝对地址，通常以 `/v1` 结尾；内网 http 需显式安全确认 |
| IAM Discovery URL | 与 issuer 二选一（优先） | — | 优先提供；提供后 issuer 由文档声明，运行时以 ID Token 的 `iss` 与之精确比对。maker 请求并检查文档 issuer 及授权、token、JWKS 端点；未显式指定时也校验发现的撤销、登出和用户信息端点格式。此时不要另配 `HELUO_IAM_ISSUER`。不用 Discovery 时须显式提供 issuer 和三个端点，并记录未执行 Discovery 核验 |
| IAM 访问令牌撤销端点 | 默认退出需要 | 空 | 显式提供 D1 的完整端点地址，不带查询参数；核验其 GET 回执。Discovery 检查不会保证此端点存在或兼容 D1 |
| 网关 provider | 配置网关时必填 | — | 企业网关的准确模型路由标识；不确定时确认，不编造 |
| 内网 HTTP opt-in | 否 | 空 | 仅当打包人员确认接受明文传输风险时写 `true` |
| 凭据存储 | 否 | 空 | 内置 SQLite 值级加密存储与文件 keyring；不需在 `.env` 中配置。目标平台权限、宿主兼容性与企业环境仍待实测 |
| 回调端口 | 否 | `0` | `0`（系统分配）或 1024–65535 整数；固定端口只在 IAM 要求精确登记时使用 |
| 回调地址 | 否 | `127.0.0.1` | `127.0.0.1` 或 `::1`，不接受 `localhost` 或 `[::1]`；须与 IAM 登记的回调前缀一致 |
| Gitee host | 否 | 空 | 企业 Gitee 的**主机名**，可带端口，例如 `gitee.corp.example`；不接受 `https://` 前缀、路径或用户名密码（插件只认主机名，带协议会导致该能力无法加载）。没有就跳过 |
| 版本号 | 是 | 公版版本 + `-corp.1` | 与公版不同，符合 semver |
| 输出目录 | 是 | — | 仓库外、不存在或为空 |

企业 IAM 按回调前缀登记（`http://127.0.0.1:` 或 `http://127.0.0.1/`，2026-11-06 答复：端口可随机），因此端口默认填 `0`：端口在登录发起时由系统分配，插件只为本次登录临时监听，不需要预登记，也不会因端口被其他进程占用而登录失败。只有 IAM 明确要求逐字节匹配固定回调 URI 时，才填 1024–65535，并保证与登记值完全一致；固定端口被占用时插件以 `IAM_CALLBACK_PORT_UNAVAILABLE` 拒绝登录，不回落到随机端口。选 `0` 时不要额外写 `redirectUri`，端口在运行时才确定。

在仓库根目录准备专用 `.env`，确认 Git 忽略该文件且未跟踪；已有文件按实际需要维护，不用模板覆盖，也不要在可提交的 `.env.example` 中填写企业配置：

```dotenv
HELUO_IAM_AUTH_MODE=confidential
HELUO_IAM_CLIENT_AUTH_METHOD=<registered token_endpoint_auth_method>
HELUO_IAM_CLIENT_SECRET_REF=<nonsecret ref>
HELUO_IAM_DISCOVERY_URL=<discovery url>
# HELUO_IAM_ISSUER=<issuer>  # 仅显式端点模式；不要与 Discovery URL 同时启用
HELUO_IAM_CLIENT_ID=<client_id>
HELUO_IAM_SCOPES=openid profile
HELUO_IAM_REVOCATION_ENDPOINT=<D1 revocation endpoint>
HELUO_IAM_CALLBACK_PORT=<0 或固定端口>
HELUO_IAM_CALLBACK_ADDRESS=<address>
HELUO_IAM_MANAGED_MODELS_BASE_URL=<gateway baseURL>
HELUO_IAM_DEFAULT_PROVIDER=<provider id>
# HELUO_IAM_PROFILE_FIELDS=name=<claim>,workNo=<claim>  # 仅字段口径确认后填写
HELUO_IAM_ALLOW_INSECURE_HTTP=<true 仅内网 http 且已确认>
HELUO_GITEE_HOST=<gitee host>
```

`HELUO_IAM_SCOPES` 显式写 `openid profile`：私版未设置该键时不写 scopes，插件默认值含 `offline_access`，而 6.0.3 换票直接返回刷新令牌、不要求该范围，多带只会扩大授权面。不要填写 `HELUO_IAM_GATEWAY_RESOURCE`：6.0.3 不支持 `resource` 参数，留空即不写该键。`HELUO_IAM_PROFILE_FIELDS` 只在 IAM 书面确认字段名后填写，未确认时删除该行，账户面板不显示姓名而登录不受影响。写成 `键=claim` 逗号分隔对，键只能是 `workNo`/`name`，claim 名只接受 token；键重复、缺 `=` 或 claim 非法时制包直接报 `CONFIG_INVALID`，不会静默丢弃映射。

`HELUO_IAM_DEFAULT_PROVIDER` 使用企业网关的模型路由标识；不确定时向打包人员确认，不要编造。Gitee 未提供时删掉该行。使用 Discovery URL 时 issuer 由文档提供，私版不写入 `issuer`；未配置 Discovery 时，须同时提供 `HELUO_IAM_ISSUER`、`HELUO_IAM_AUTHORIZATION_ENDPOINT`、`HELUO_IAM_TOKEN_ENDPOINT` 和 `HELUO_IAM_JWKS_URI`。授权码换票和刷新使用同一个 `tokenEndpoint` 及登记的同一种认证方法；实际端点和方法须联调确认。仅兼容部署可用 `HELUO_IAM_AUTH_MODE=public`（或省略），方法省略或填 `none`，省略 `HELUO_IAM_CLIENT_SECRET_REF`。机密模式下，显式 `HELUO_IAM_ALLOW_INSECURE_HTTP=true` 同时写入 Host 策略 `allowInsecureClientAuthHttp: true`。

提供现有文件路径给 `config`，并在 macOS 制包机上检查忽略规则、设置文件权限；检查失败时停止：

```sh
config="<仓库根目录>/.env"
git -C "<仓库根目录>" check-ignore -q -- .env && chmod 600 "$config"
```

独立工具链没有 Git 仓库时，`config` 指向不受版本管理的专用文件，并单独设置权限为 `600`。

制作脚本按数据解析 `KEY=VALUE`，不执行 `source`、变量展开或命令替换。传给 `--config` 的文件只接收白名单内的企业配置和非秘密引用。

## 生成与交付

1. 先预览（不写盘），把脱敏后的键名、版本、摘要前缀给打包人员核对。确认 `loginReady: true` 和 `gatewayConfigured: true`；配置 Discovery 且未主动跳过检查时还须确认 `discovery.checked: true`。`revocationConfigured` 标识是否显式配置撤销端点；Discovery 成功时 `discovery.revocationEndpoint` 标识 `configured`、`discovered` 或 `missing`。只提供显式端点或主动跳过检查时 `discovery.checked` 为 `false`，须另行核验端点并记录限制。预检复用 IAM 运行时配置校验，但不证明网关可用、撤销协议兼容或企业登录成功：

```sh
node scripts/release-delivery.mjs --public <tgz> --public-sha256 <hex> \
  --config "$config" --version <x.y.z> --output <dir> --dry-run
```

2. 打包人员确认后，用回显的摘要前缀重跑（至少 8 位）：

```sh
node scripts/release-delivery.mjs --public <tgz> --public-sha256 <hex> \
  --config "$config" --version <x.y.z> --output <dir> --confirm <digest 前 8+ 位>
```

3. 工具自动完成：制作私版、重算清单与摘要、独立核验、生成员工目录与 zip、写 `SHA256SUMS`。
4. 保留或由文件所有者按需处置 `.env`；不得自动覆盖、删除既有文件。
5. 向打包人员报告 zip 路径与 SHA-256、私版版本与摘要、员工安装方式和终端密钥预置要求。记录待核验的 IAM 登记方法、真实登录与计划续期（`refresh-committed` 后保持 `ready`）、D1 撤销、个人 Key、运行期挂载、企业网络与实际平台安装。静态预览无法核验目标机密钥记录。

## 员工侧

交付 zip 根目录含：

- `enterprise-plugin/` — 私版 `.tgz`、`private-release.json`、`bundle-manifest.json`；
- `installer/` — `init-enterprise-plugin.mjs` 与 macOS/Windows/Linux 启动器；
- `INSTALL.md` — 安装前、安装、安装后、回滚；
- `SHA256SUMS` — 整包校验和。

员工安装 Node.js LTS 并运行对应启动器：缺官方 DSH 时启动器用 npm 自动安装并创建 web profile，再安装插件。装好后在终端运行 `dsh web` 打开本机地址确认（默认安装写入 web profile）；Desktop 是独立 profile，不能代替这一步。官方 Desktop 应用的 desktop profile 由 Electron 独占，命令行无法管理：Desktop 用户需在应用完全退出后于应用内插件设置中安装同一份 tgz，`--profile desktop --dump-config` 可能被拒绝；启动器在只有 Desktop profile 时明确拒绝，显式指定 desktop 时也会先探测核验能力、不支持就在写入前停止。终端管理员按 [SOP §5.1](references/sop.md#51-终端管理员预置与轮换)预置密钥后，员工进行新登录并首次录入个人网关 Key。

## 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 重新预览并让打包人员确认；不要复用旧摘要 |
| `PUBLIC_DIGEST_MISMATCH` | 停止。重新取得公版与可信摘要，不猜测文件 |
| `PUBLIC_UNSAFE` | 公版含敏感样本或非中性补丁，拒绝继续，报告命中的类别 |
| `PUBLIC_INCOMPLETE` | 公版自身没通过制品闭包校验（例如缺平台原生 addon、夹带测试文件、`workspace:` 依赖未闭合）。重新取得正确的公版制品；不要重算摘要把缺件包当成新公版 |
| `CONFIG_*` | 按字段回显修正；未知键不写入。出现 `IAM login is incomplete` 时补 Discovery URL（或 issuer + 三个端点）；出现 `HELUO_IAM_ISSUER must not be set together with HELUO_IAM_DISCOVERY_URL` 时删除 issuer 行，只保留 Discovery URL |
| `IAM_VALIDATOR_MISMATCH` | 公版与制作工具链中的 IAM 校验模块不一致或缺失；使用配套版本并重新核对来源与摘要 |
| `DISCOVERY_*` | 打包机到 IAM 的网络不可达，或 Discovery 文档不合规：文档必须声明合法 `issuer`，`authorization_endpoint`/`token_endpoint`/`jwks_uri` 必须存在，显式配置过的端点必须与文档一致。Discovery 模式不以单独的 issuer 配置做比对，文档声明的 issuer 即运行期来源。先修网络或配置；确实只能离线制作时才用 `--skip-discovery-check`，并在报告里列为未验证项 |
| 安装后向导显示"凭据存储不可用" | 检查目标平台的 SQLite、目录权限、磁盘空间与配套 keyring；目标平台行为须实测，不以平台名称推定后端不可用 |
| `BUNDLE_SECRET_EMBED_UNSUPPORTED` | 私版只允许非秘密引用；从专用配置移除密钥输入键并重新预览，密钥由终端管理员独立预置 |
| `IAM_CLIENT_AUTH_UNVERIFIED` | 核对目标 Host 的存储目录、命名空间和预置绑定，缺失时按 SOP 预置 |
| `IAM_CLIENT_AUTH_CHANGED` / `IAM_CLIENT_AUTH_CONTEXT_INVALID` | 核对配置及密钥版本，再用新会话登录 |
| `OUTPUT_*` | 换仓库外的新目录；不要删除已有文件 |
| `VERIFY_FAILED` / `ARTIFACT_VERIFY_FAILED` | 制作或清单不一致（`ARTIFACT_VERIFY_FAILED` 是直接调用 maker 时对**已写出**制品的独立核验失败），保留现场并报告错误行，不手工改清单 |

## 按需材料

- [references/sop.md](references/sop.md) — 打包人员问答清单、确认与证据、员工安装步骤、失败恢复。
