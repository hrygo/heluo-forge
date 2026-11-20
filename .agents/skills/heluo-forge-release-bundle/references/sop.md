# 打包人员问答与企业 DSH 交付 SOP

## 1. 开始前

- 公版 `.tgz` 已下载；SHA-256 来自发布页或另一条可信渠道，不采用制品同目录的 `SHA256SUMS`。
- 使用与公版配套的制作工具链；工具检查其 IAM 校验模块与公版内的运行时一致，只允许 LF / CRLF 换行差异。
- 打包人员能提供：企业 IAM Discovery URL（优先），或显式 issuer 与授权/token/JWKS 端点、client_id、访问令牌撤销端点、网关 baseURL 和 provider、回调地址（端口默认随机）、Gitee host（可选）、交付版本号。
- 输出目录在仓库之外，且不存在或为空；磁盘空间足够。
- 企业目标部署显式使用机密客户端与 PKCE S256。打包人员须知道 IAM 登记的 token 认证方法及非秘密引用，终端管理员另行预置密钥。制作器只接收非秘密配置。

## 2. 问答（逐项确认）

1. 公版制品路径与 SHA-256：核对文件名、大小与摘要；摘要不一致立即停止。
2. IAM issuer：只在不用 Discovery、改用显式端点时必填；`https://` 绝对地址，不带 query/fragment，企业内网只有 http 时先说明明文风险并取得明确确认后才允许 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`。配置 Discovery URL 时不要提供 issuer：issuer 以文档声明为准，制作器拒绝两者并存。
3. Discovery URL：优先由管理员提供，不自行推定实际地址。maker 请求后检查文档声明了合法 `issuer`，并检查 `authorization_endpoint`/`token_endpoint`/`jwks_uri`；未显式指定时也校验发现的撤销、登出和用户信息端点格式。Discovery 模式不把文档 issuer 与另一份配置比对，也不再要求单独的 issuer。回显只给 `checked` 与匹配到的字段名，不含端点原值。无 Discovery 时显式提供 issuer 与三个端点并记录未执行发现核验；打包机确实无法访问已配置的 Discovery 时可用 `--skip-discovery-check`，并记录未验证项。
4. client_id、认证模式、方法与引用：企业 IAM 登记的客户端 ID，目标部署配置 `HELUO_IAM_AUTH_MODE=confidential`、`HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_basic` 或 `client_secret_post`（须与登记的 `token_endpoint_auth_method` 一致）、`HELUO_IAM_CLIENT_SECRET_REF=<ref>`（匹配 `^[a-z][a-z0-9-]*$`）。只有明确允许无客户端认证换票和刷新的部署才使用兼容默认 `public` / `none`，同时省略引用。
5. 网关 baseURL 和 provider：地址用于 `managedModels.baseURL`，按网关实际路径填写；provider 使用准确的模型路由标识。http 同上需显式确认。
6. 回调端口与地址：端口默认 `0`（系统分配），地址默认 `127.0.0.1`（不接受 `localhost` 或 `[::1]`）。企业 IAM 按 `http://127.0.0.1:` 前缀登记回环回调，端口可随机，不需要为每个包约定固定值；只有 IAM 明确要求精确匹配固定 URI 时，才填 1024–65535，并保证与登记值逐字节一致。固定端口被占用会直接拒绝登录（`IAM_CALLBACK_PORT_UNAVAILABLE`），不回落随机端口。
7. Gitee host：只填主机名（可带端口，如 `gitee.corp.example`），不带 `https://`、路径或用户名密码；带协议会被插件拒绝加载，maker 也会在制作前拒绝。没有企业 Gitee 就跳过，不写空键。
8. 版本号：必须与公版不同（例如 `0.1.0-corp.1`）；同名同版本不允许不同字节。
9. 输出目录：仓库外、不存在或为空。
10. 凭据存储：插件使用 SQLite 值级加密存储和文件 keyring，`.env` 不需要相关配置；Windows、Linux/麒麟与 macOS 的目标宿主兼容性和权限仍须实测。
11. IAM 撤销：显式提供访问令牌 D1 撤销端点 `HELUO_IAM_REVOCATION_ENDPOINT`，地址不含查询参数，并核对 GET 回执。标准私版使用默认 `access_token_query`，退出和符合清理条件的失败回调均通过 GET 撤销访问令牌。D1 回执只证明该访问令牌的撤销结果，刷新令牌的撤销仍待核验。制作器的 Discovery 预检只校验地址，运行时仅在存在显式或发现的撤销端点时发出远端请求。
12. IAM 刷新：插件用同一 token 端点及登记认证方法完成授权码换票与刷新。核对企业端点是否接受所选方法和两种 grant；若刷新使用独立端点，须另行适配和联调。

答案保存在仓库根目录的专用 `.env`，确认被 Git 忽略且未跟踪，权限为 `600`；该文件可复用，已有文件不得自动覆盖或删除。不要在可提交的 `.env.example` 中填写企业配置。配置行见 [Skill 入口](../SKILL.md#问答协议)；内网 http 经明确确认后追加 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`：

```sh
umask 077
config="<仓库根目录>/.env"
git -C "<仓库根目录>" check-ignore -q -- .env && chmod 600 "$config"
```

忽略检查失败时停止。独立工具链没有 Git 仓库时，将 `config` 指向不受版本管理的专用文件并设置权限为 `600`。脚本只将文件按 `KEY=VALUE` 数据解析，不执行 `source` 或变量展开。允许的企业配置会写入私版中声明行所在的那一层补丁（默认 `cordis.patch.yml`，研发叠加层为 `cordis.patch.engineering.yml`）；公版包必须随包发出 `package.json` 的 `dsh.bundle.patch` 所指默认层，缺层或缺行都会在打包前置检查里被拒绝；完整 `.env`、个人 Key、令牌和 `client_secret` 不进入交付包。配置值不要放入命令行参数、提交到仓库或写入报告。

插件的 `refreshSkewSeconds`、`httpTimeoutMs` 和 `logoutMode` 使用运行时默认值 `60`、`10000` 和 `local`。制作器仅接受白名单内的 `.env` 配置。后台续期以较早的已知令牌到期点为准，目标提前量为 10 分钟，上限为排程时剩余时间的一半。`refreshSkewSeconds` 用于前台预刷新和剩余时间短于 4 分钟的后台续期。

## 3. 预览与确认

1. 运行 `release-delivery --dry-run`，确认 `loginReady` 和 `gatewayConfigured` 均为 `true`；配置 Discovery 且未主动跳过检查时确认 `discovery.checked` 为 `true`。`revocationConfigured` 标识显式配置；Discovery 成功时 `discovery.revocationEndpoint` 为 `configured`、`discovered` 或 `missing`。只提供显式端点或主动跳过检查时 `discovery.checked` 为 `false`，须另行核验并记录。静态校验不验证网关连通或 D1 协议兼容。
2. Discovery 输出和错误不回显企业地址；预览及交付回执仍含本地路径，制作输出按企业敏感信息保护，对外报告先人工脱敏。把键名、版本、摘要前缀交给打包人员核对，并在配置文件或企业受控渠道确认地址。
3. 用回显的摘要前缀（至少 8 位）重跑并带 `--confirm`；换制品、配置或版本必须重新预览。
4. 保留专用配置供后续复用，是否处置由文件所有者决定。

## 4. 交付物结构

```
heluo-enterprise-release-<version>/
  enterprise-plugin/
    heluo-forge-enterprise-<version>.tgz
    private-release.json
    bundle-manifest.json
    SHA256SUMS
  installer/
    init-enterprise-plugin.mjs
    install-macos.command
    install-linux.sh
    install-windows.cmd
  INSTALL.md
  SHA256SUMS
```

zip 与目录同名；zip 的 SHA-256 作为交付摘要。启动器把同一份 tgz 的自算摘要传给 `--sha256`，属自证（只能发现拷贝损坏）；需要独立口径时须由管理员另行核对摘要。

## 5. 员工安装

1. 员工机器只需有 Node.js LTS（自带 npm）。DSH 可以已安装，也可以完全没装。
2. macOS 双击 `installer/install-macos.command`；Windows 双击 `installer/install-windows.cmd`；麒麟/Linux 运行 `sh installer/install-linux.sh`。
3. 启动器会：检查 Node.js → 缺 dsh 时执行 `npm install -g @deepseek-ai/dsh@<锁定版本>` → 用 `dsh --profile web --dump-config` 创建 web profile（若已有 desktop/web 则复用）→ 校验插件摘要 → 只调用 `dsh plugin --profile <p> add <tgz>`。
4. 在终端运行 `dsh web`，打开它打印的本机地址，在「设置 → 插件」确认已加载（默认安装写入的是 web profile）；登录后录入个人网关 Key。不要用「打开 Desktop」代替这一步：Desktop 是另一个 profile，看不到本次安装。

官方 Desktop 应用的 desktop profile 由 Electron 独占，命令行无法管理（锁定基线版实测：`profile "desktop" is managed exclusively by the Electron application`）。Desktop 用户须在应用完全退出后于应用内插件设置中安装同一份 tgz，并在应用内确认挂载；`--profile desktop --dump-config` 可能被拒绝，不能作为核验依据。显式指定 desktop 时启动器会先探测该核验是否可用，不支持就在写入前拒绝；仅检测到 Desktop profile 时也会报 `DESKTOP_PROFILE_UNSUPPORTED`。

脚本回显 `mounted=unknown` 是预期行为：运行期挂载只能在宿主内确认。

### 5.1 终端管理员预置与轮换

在员工首次登录前，管理员用目标 Host 的本机用户、凭据目录及命名空间预置密钥。通过 `HELUO_FORGE_STORE_DIRECTORY`、`HELUO_FORGE_KEYCHAIN_SERVICE` 与 `HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX` 对齐 Host 的非默认配置。`--issuer` 使用实际 issuer（Discovery 模式读取文档的 `issuer`）；`--client-id`、`--method`、`--ref` 与登记和私版配置一致。

```sh
heluo-forge client-secret set --issuer https://iam.corp.example \
  --client-id forge-console --method client_secret_post --ref enterprise-oidc
```

使用 profile 内的标准安装时，从安装企业插件的 profile 目录运行随包 Node 入口。安装器写入的 Web profile 路径为 `$DSH_HOME/profiles/web`，未设置 `DSH_HOME` 时从当前用户的 `.dsh` 目录定位。

```sh
node node_modules/@heluo/forge-enterprise/node_modules/@heluo/forge-iam/bin/heluo-forge.mjs client-secret set --issuer https://iam.corp.example --client-id forge-console --method client_secret_post --ref enterprise-oidc
```

由获准的密钥分发工具通过管道或重定向向命令的标准输入发送原始 UTF-8 字节。禁止交互输入、回显、将值放入参数或环境变量；只有密钥原文包含尾部换行时保留该换行。管理员命令通过专用端口保存值级加密的 `iam-client-secret/<ref>`，并绑定 issuer、client ID 和方法。

轮换使用 `client-secret set` 更新绑定一致的记录。更正同一引用的预置错误时，使用 `client-secret replace`，按私版填写目标参数，再用 `--old-issuer`、`--old-client-id`、`--old-method` 精确提供旧绑定，密钥仍由标准输入提供。公开与机密模式分别使用 V1 和 V2 会话。轮换或切换登录模式后，若 Host 正在运行，在「设置 → 企业账号」点击「刷新」核验会话，再点击「登录企业账号」。

## 6. 允许的输出与证据

- 脱敏报告可以出现配置键名、profile 名、版本号、摘要前缀、成功/失败结论、文件清单。
- 脱敏报告不得包含配置值、密钥、令牌、完整 `.env`、本机绝对路径或未脱敏的原始错误；原始制作输出仍可能包含路径，不能直接作为脱敏报告。
- 应保留：公版文件名/摘要/来源、配置的键名与权限检查、确认摘要前缀、私版与 zip 摘要、员工安装回显与设置页确认结果。
- 企业内实测记录：宿主版本与架构、Desktop/Web profile、是否离线、升级/回退、数据保留、员工步数。
- IAM 联调记录所登记方法、新登录和首轮正常计划续期。确认 `refresh-committed` 后会话仍为 `ready`；真实环境和目标双端安装均需实际取证。

## 7. 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 重新预览，重新确认；不复用旧摘要 |
| `PUBLIC_MISSING` / `PUBLIC_DIGEST_MISMATCH` | 停止，重新获取公版与可信摘要 |
| `PUBLIC_UNSAFE` | 公版含敏感样本或非中性补丁，拒绝继续并报告类别 |
| `CONFIG_INVALID` / `CONFIG_UNKNOWN_KEY` | 按字段修正；未知键不写入 |
| `CONFIG_PERMISSIONS` | `chmod 600` 后重试 |
| `CONFIG_UNREADABLE` | 检查配置文件是否存在及可读，不在共享报告中复制文件路径 |
| `IAM_VALIDATOR_MISMATCH` | 换用与公版配套的工具链，重新核对来源与摘要 |
| `BUNDLE_SECRET_EMBED_UNSUPPORTED` | 不使用含 secret 的配置；修正专用 `.env` 后重新预览 |
| `OUTPUT_INSIDE_REPO` / `OUTPUT_EXISTS` | 换仓库外的新目录；不删除或覆盖已有文件 |
| `VERIFY_FAILED` | 保留现场，报告错误行；不手工改清单或重新打包绕过 |

## 8. 边界

- 官方 DSH 宿主原样使用；不重签、不公证、不修改官方载荷。
- 回调端口默认 `0`（系统分配），这是生产形态；固定端口只是 IAM 要求精确登记时的兼容选项，不是交付前提。
- 本交付只供企业内部使用，不对外分发。
- 真实 IAM 登录、PKCE、回调、个人 Key、运行期挂载、六平台与企业网络属于企业实测项，本地工具通过不代表企业联调完成。
