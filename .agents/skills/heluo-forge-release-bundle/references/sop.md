# 打包人员问答与企业 DSH 交付 SOP

## 1. 开始前

- 公版 `.tgz` 已下载；SHA-256 来自发布页或另一条可信渠道，不采用制品同目录的 `SHA256SUMS`。
- 打包人员能提供：企业 IAM issuer、client_id、网关 baseURL、回调地址（端口默认随机）、Gitee host（可选）、交付版本号。
- 输出目录在仓库之外，且不存在或为空；磁盘空间足够。
- 企业采用公开客户端 + PKCE，**没有** `client_secret`；要求提供 secret 时说明企业方案不适用并停止。

## 2. 问答（逐项确认）

1. 公版制品路径与 SHA-256：核对文件名、大小与摘要；摘要不一致立即停止。
2. IAM issuer：默认必须是 `https://` 绝对地址，不带 query/fragment；企业内网只有 http 时，先说明明文风险，取得明确确认后才允许 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`。
3. Discovery URL：默认取 `issuer + /.well-known/openid-configuration`。maker 会自动请求，要求 200、`issuer` 与配置一致、`authorization_endpoint`/`token_endpoint`/`jwks_uri` 齐全；不确定时让管理员提供。只有打包机确实无法访问 IAM 时才加 `--skip-discovery-check`，并在交付报告里注明该检查未执行。
4. client_id：企业的公开客户端 ID，不是员工个人标识。
5. 网关 baseURL：企业模型网关地址，通常以 `/v1` 结尾；用于 `managedModels.baseURL`，http 同上需显式确认。
6. 回调端口与地址：端口默认 `0`（系统分配），地址默认 `127.0.0.1`。企业 IAM 按 `http://127.0.0.1:` 前缀登记回环回调，端口可随机，不需要为每个包约定固定值；只有 IAM 明确要求精确匹配固定 URI 时，才填 1024–65535，并保证与登记值逐字节一致。固定端口被占用会直接拒绝登录（`IAM_CALLBACK_PORT_UNAVAILABLE`），不回落随机端口。
7. Gitee host：没有企业 Gitee 就跳过，不写空键。
8. 版本号：必须与公版不同（例如 `0.1.0-corp.1`）；同名同版本不允许不同字节。
9. 输出目录：仓库外、不存在或为空。
10. 凭据存储：Windows 与 macOS 使用插件内置的加密文档后端，`.env` 不需要任何相关配置；Linux 目标没有可用凭据后端，安装后向导会提示“凭据存储不可用”，交付前向使用方说明。

答案写入临时文件，内网 http 时追加 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`：

```sh
umask 077
config="$(mktemp -t heluo-enterprise.XXXXXX.env)"
```

写入键值后 `chmod 600`；不要把值放进 `--issuer` 之类的命令行参数，也不要写进仓库、报告或聊天记录。

## 3. 预览与确认

1. 运行 `release-delivery --dry-run`，只回显公版摘要、版本、输出目录、配置键名、`loginReady`、`discovery`、平台列表与 `planDigest`；`loginReady` 不是 `true` 或 `discovery.checked` 不是 `true`（除非显式跳过）就停止，不得生成交付包。
2. 把键名、版本、摘要前缀交给打包人员核对；确认企业地址与其预期一致。
3. 用回显的摘要前缀（至少 8 位）重跑并带 `--confirm`；换制品、配置或版本必须重新预览。
4. 成功后删除临时配置文件。

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

zip 与目录同名；zip 的 SHA-256 作为交付摘要。

## 5. 员工安装

1. 员工机器只需有 Node.js LTS（自带 npm）。DSH 可以已安装，也可以完全没装。
2. macOS 双击 `installer/install-macos.command`；Windows 双击 `installer/install-windows.cmd`；麒麟/Linux 运行 `sh installer/install-linux.sh`。
3. 启动器会：检查 Node.js → 缺 dsh 时执行 `npm install -g @deepseek-ai/dsh@<锁定版本>` → 用 `dsh --profile web --dump-config` 创建 web profile（若已有 desktop/web 则复用）→ 校验插件摘要 → 只调用 `dsh plugin --profile <p> add <tgz>`。
4. 启动 DSH（`dsh web` 或 Desktop），在「设置 → 插件」确认已加载；登录后录入个人网关 Key。

官方 Desktop 应用的 desktop profile 由 Electron 独占，命令行无法管理（0.2.1-rc.5 实测）；仅检测到 Desktop profile 时启动器会报 `DESKTOP_PROFILE_UNSUPPORTED`，应在应用内插件设置中安装，不要改 Electron 的 profile。

脚本回显 `mounted=unknown` 是预期行为：运行期挂载只能在宿主内确认。

## 6. 允许的输出与证据

- 可以出现：配置键名、profile 名、版本号、摘要前缀、成功/失败结论、文件清单。
- 不得出现：配置值、密钥、令牌、完整 `.env`、本机绝对路径、未脱敏的原始错误。
- 应保留：公版文件名/摘要/来源、临时配置的键名与权限检查、确认摘要前缀、私版与 zip 摘要、员工安装回显与设置页确认结果。
- 企业内实测记录：宿主版本与架构、Desktop/Web profile、是否离线、升级/回退、数据保留、员工步数。

## 7. 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 重新预览，重新确认；不复用旧摘要 |
| `PUBLIC_MISSING` / `PUBLIC_DIGEST_MISMATCH` | 停止，重新获取公版与可信摘要 |
| `PUBLIC_UNSAFE` | 公版含敏感样本或非中性补丁，拒绝继续并报告类别 |
| `CONFIG_INVALID` / `CONFIG_UNKNOWN_KEY` | 按字段修正；未知键不写入 |
| `CONFIG_PERMISSIONS` | `chmod 600` 后重试 |
| `BUNDLE_SECRET_EMBED_UNSUPPORTED` | 删除 secret 行；企业方案不应有共享密钥 |
| `OUTPUT_INSIDE_REPO` / `OUTPUT_EXISTS` | 换仓库外的新目录；不删除或覆盖已有文件 |
| `VERIFY_FAILED` | 保留现场，报告错误行；不手工改清单或重新打包绕过 |

## 8. 边界

- 官方 DSH 宿主原样使用；不重签、不公证、不修改官方载荷。
- 回调端口默认 `0`（系统分配），这是生产形态；固定端口只是 IAM 要求精确登记时的兼容选项，不是交付前提。
- 本交付只供企业内部使用，不对外分发。
- 真实 IAM 登录、PKCE、回调、个人 Key、运行期挂载、六平台与企业网络属于企业实测项，本地工具通过不代表企业联调完成。
