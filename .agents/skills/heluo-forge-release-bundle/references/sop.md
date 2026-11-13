# 打包人员问答与企业 DSH 交付 SOP

## 1. 开始前

- 公版 `.tgz` 已下载；SHA-256 来自发布页或另一条可信渠道，不采用制品同目录的 `SHA256SUMS`。
- 使用与公版配套的制作工具链；工具检查其 IAM 校验模块与公版内的运行时一致，只允许 LF / CRLF 换行差异。
- 打包人员能提供：企业 IAM issuer、client_id、Discovery 或显式授权/token/JWKS 端点、访问令牌撤销端点、网关 baseURL 和 provider、回调地址（端口默认随机）、Gitee host（可选）、交付版本号。
- 输出目录在仓库之外，且不存在或为空；磁盘空间足够。
- 企业交付采用公开客户端 + PKCE S256，不使用 `client_secret`。企业 IAM 支持该方式；真实登录、刷新与回调仍须在企业环境验证。制作器不接收 secret 或个人 Key。

## 2. 问答（逐项确认）

1. 公版制品路径与 SHA-256：核对文件名、大小与摘要；摘要不一致立即停止。
2. IAM issuer：默认必须是 `https://` 绝对地址，不带 query/fragment；企业内网只有 http 时，先说明明文风险，取得明确确认后才允许 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`。issuer 是交付包的信任锚：Discovery 文档里的 `issuer` 必须与之逐字符相同，结尾斜杠或大小写不同都按不一致拒绝，工具不会采用文档自称的 issuer。
3. Discovery URL：优先由管理员提供，常见形式为 `issuer + /.well-known/openid-configuration`，不自行推定实际地址。maker 请求后精确检查 `issuer`，并检查 `authorization_endpoint`/`token_endpoint`/`jwks_uri`；未显式指定时也校验发现的撤销、登出和用户信息端点格式。回显只给 `checked` 与匹配到的字段名，不含端点原值。无 Discovery 时显式提供 issuer、三个端点并记录未执行发现核验；打包机确实无法访问已配置的 Discovery 时可用 `--skip-discovery-check`，并记录未验证项。
4. client_id：企业的公开客户端 ID，不是员工个人标识。
5. 网关 baseURL 和 provider：地址用于 `managedModels.baseURL`，按网关实际路径填写；provider 使用准确的模型路由标识。http 同上需显式确认。
6. 回调端口与地址：端口默认 `0`（系统分配），地址默认 `127.0.0.1`（不接受 `localhost` 或 `[::1]`）。企业 IAM 按 `http://127.0.0.1:` 前缀登记回环回调，端口可随机，不需要为每个包约定固定值；只有 IAM 明确要求精确匹配固定 URI 时，才填 1024–65535，并保证与登记值逐字节一致。固定端口被占用会直接拒绝登录（`IAM_CALLBACK_PORT_UNAVAILABLE`），不回落随机端口。
7. Gitee host：只填主机名（可带端口，如 `gitee.corp.example`），不带 `https://`、路径或用户名密码；带协议会被插件拒绝加载，maker 也会在制作前拒绝。没有企业 Gitee 就跳过，不写空键。
8. 版本号：必须与公版不同（例如 `0.1.0-corp.1`）；同名同版本不允许不同字节。
9. 输出目录：仓库外、不存在或为空。
10. 凭据存储：插件使用 SQLite 值级加密存储和文件 keyring，`.env` 不需要相关配置；Windows、Linux/麒麟与 macOS 的目标宿主兼容性和权限仍须实测。
11. IAM 撤销：显式提供访问令牌 D1 撤销端点 `HELUO_IAM_REVOCATION_ENDPOINT`，地址不含查询参数；确认其 GET 回执。Discovery 预检不请求撤销端点或验证协议。没有显式或发现的端点时运行时跳过远端撤销，不能当作退出闭环。回调失败时，当前代码还会向同一字段尝试 POST 撤销刷新令牌；D1 只提供访问令牌 GET 撤销，不能据此声称刷新令牌已撤销。
12. IAM 刷新：当前插件将 `HELUO_IAM_TOKEN_ENDPOINT` 同时用于授权码换票与刷新。核对企业服务是否支持这种方式；若刷新使用独立端点，当前工具和插件均不能配置它，须先完成适配并联调。

答案保存在仓库根目录的专用 `.env`，确认被 Git 忽略且未跟踪，权限为 `600`；该文件可复用，已有文件不得自动覆盖或删除。不要在可提交的 `.env.example` 中填写企业配置。配置行见 [Skill 入口](../SKILL.md#问答协议)；内网 http 经明确确认后追加 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`：

```sh
umask 077
config="<仓库根目录>/.env"
git -C "<仓库根目录>" check-ignore -q -- .env && chmod 600 "$config"
```

忽略检查失败时停止。独立工具链没有 Git 仓库时，将 `config` 指向不受版本管理的专用文件并设置权限为 `600`。脚本只将文件按 `KEY=VALUE` 数据解析，不执行 `source` 或变量展开。允许的企业配置会写入私版中声明行所在的那一层补丁（默认 `cordis.patch.yml`，研发叠加层为 `cordis.patch.engineering.yml`）；公版包必须随包发出 `package.json` 的 `dsh.bundle.patch` 所指默认层，缺层或缺行都会在打包前置检查里被拒绝；完整 `.env`、个人 Key、令牌和 `client_secret` 不进入交付包。配置值不要放入命令行参数、提交到仓库或写入报告。

插件的 `refreshSkewSeconds`、`httpTimeoutMs` 和 `logoutMode` 不在当前制作器 `.env` 白名单中，分别使用运行时默认值 `60`、`10000` 和 `local`；不得添加未经支持的环境键来假定这些值已生效。

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

## 6. 允许的输出与证据

- 脱敏报告可以出现配置键名、profile 名、版本号、摘要前缀、成功/失败结论、文件清单。
- 脱敏报告不得包含配置值、密钥、令牌、完整 `.env`、本机绝对路径或未脱敏的原始错误；原始制作输出仍可能包含路径，不能直接作为脱敏报告。
- 应保留：公版文件名/摘要/来源、配置的键名与权限检查、确认摘要前缀、私版与 zip 摘要、员工安装回显与设置页确认结果。
- 企业内实测记录：宿主版本与架构、Desktop/Web profile、是否离线、升级/回退、数据保留、员工步数。

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
