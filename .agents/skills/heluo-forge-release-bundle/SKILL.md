---
name: heluo-forge-release-bundle
description: 供打包人员收集企业 IAM/网关配置，在 macOS 上生成企业 DSH 交付包并完成本地核验；从不提交仓库的 .env 读取配置，允许的企业配置写入私版，密钥不得进入交付物。
---
# 企业 DSH 交付包制作

## 何时使用

打包人员要求“给员工做一个企业 DSH 包”“按当前 PR 的方式打包”，并且已拿到公版插件制品时使用。

不适用：日常开发构建、公开发布、把企业制品上传公共 CI、未获授权的公证。本包只供企业内部使用，不对外分发。

## 角色

- **打包人员**：与本 Skill 对话，提供企业地址与版本，执行确认。
- **员工**：只收到最终 zip，按 `INSTALL.md` 三步安装，不接触企业配置和制作命令。
- Skill 只服务打包人员，不要求安装用户填写任何企业字段。

## 不可让步的边界

- 使用仓库根目录受 Git 忽略的专用 `.env` 文件（`umask 077`，权限 600）；可供后续打包复用，不提交、不自动删除或覆盖。独立工具链未放入 Git 仓库时，配置保存在不受版本管理的位置。
- IAM 和网关地址等允许的配置会写入私版插件的 `cordis.patch.yml`，交付对象可见；完整 `.env`、密钥和令牌不进入交付物。配置值不作为命令行参数。
- Discovery 预检结果与错误只显示状态、字段名和受限错误码，不回显 issuer、端点或网络异常原文。预览与交付回执仍包含本地路径；分享报告前人工脱敏。
- 公版摘要必须来自发布页或另一条可信渠道，不信任制品旁边的 `SHA256SUMS`。
- 制作器核对工具链与公版中的 IAM 配置校验模块；不一致时使用该公版配套的工具链，不能跳过检查。
- 禁止全局文本替换；只允许工具声明的配置注入位置。
- 密钥、令牌、`client_secret` 不属于本交付；发现即停止。原始 `HELUO_IAM_CLIENT_SECRET` 和 `HELUO_IAM_CLIENT_SECRET_FILE` 键会报 `BUNDLE_SECRET_EMBED_UNSUPPORTED`，未知键会被拒绝。
- 输出目录必须在仓库外；缺字段、摘要不符、目录已存在或用户取消时安全失败，不覆盖、不留半成品。
- 官方 DSH 宿主原样使用：交付包不重签、不公证、不修改官方载荷，只安装企业插件。
- 企业地址默认只接受 HTTPS。确需内网 HTTP 时，必须先说明令牌与个人 Key 会明文传输，取得打包人员明确确认后才写 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`。
- 运行期挂载只能在宿主「设置 → 插件」确认；工具输出 `mounted=unknown` 是正常的，不得写成挂载证据。

## 问答协议

逐个问题询问打包人员，每问给出默认值与校验规则；不要一次倾倒全部问题。

| 槽位 | 必填 | 默认 | 校验 |
|---|---|---|---|
| 公版 `.tgz` 路径 | 是 | — | 存在、文件名含版本 |
| 公版 SHA-256 | 是 | — | 64 位 hex，与本地文件一致；来源可信 |
| IAM issuer | 是 | — | `https://` 绝对地址；无 query/fragment；内网 http 需显式安全确认 |
| IAM client_id | 是 | — | 非空，不含空白 |
| 网关 baseURL | 是 | — | `https://` 绝对地址，通常以 `/v1` 结尾；内网 http 需显式安全确认 |
| IAM Discovery URL | 条件必填 | issuer + `/.well-known/openid-configuration` | 优先提供。maker 请求并检查 issuer、授权、token 与 JWKS 端点；不用 Discovery 时须显式提供 issuer 和三个端点，并记录未执行 Discovery 核验 |
| IAM 访问令牌撤销端点 | 默认退出需要 | 空 | 显式提供 D1 的完整端点地址，不带查询参数；核验其 GET 回执。Discovery 检查不会保证此端点存在或兼容 D1 |
| 网关 provider | 配置网关时必填 | — | 企业网关的准确模型路由标识；不确定时确认，不编造 |
| 内网 HTTP opt-in | 否 | 空 | 仅当打包人员确认接受明文传输风险时写 `true` |
| 凭据存储 | 否 | 空 | 内置 SQLite 值级加密存储与文件 keyring；不需在 `.env` 中配置。目标平台权限、宿主兼容性与企业环境仍待实测 |
| 回调端口 | 否 | `0` | `0`（系统分配）或 1024–65535 整数；固定端口只在 IAM 要求精确登记时使用 |
| 回调地址 | 否 | `127.0.0.1` | `127.0.0.1` 或 `::1`，不接受 `localhost` 或 `[::1]`；须与 IAM 登记的回调前缀一致 |
| Gitee host | 否 | 空 | 企业 Gitee 的 `https://` 地址；没有就跳过 |
| 版本号 | 是 | 公版版本 + `-corp.1` | 与公版不同，符合 semver |
| 输出目录 | 是 | — | 仓库外、不存在或为空 |

企业 IAM 按回调前缀登记（`http://127.0.0.1:` 或 `http://127.0.0.1/`，2026-11-06 答复：端口可随机），因此端口默认填 `0`：端口在登录发起时由系统分配，插件只为本次登录临时监听，不需要预登记，也不会因端口被其他进程占用而登录失败。只有 IAM 明确要求逐字节匹配固定回调 URI 时，才填 1024–65535，并保证与登记值完全一致；固定端口被占用时插件以 `IAM_CALLBACK_PORT_UNAVAILABLE` 拒绝登录，不回落到随机端口。选 `0` 时不要额外写 `redirectUri`，端口在运行时才确定。

在仓库根目录准备专用 `.env`，确认 Git 忽略该文件且未跟踪；已有文件按实际需要维护，不用模板覆盖，也不要在可提交的 `.env.example` 中填写企业配置：

```dotenv
HELUO_IAM_AUTH_MODE=public
HELUO_IAM_ISSUER=<issuer>
HELUO_IAM_DISCOVERY_URL=<discovery url>
HELUO_IAM_CLIENT_ID=<client_id>
HELUO_IAM_SCOPES=openid profile offline_access
HELUO_IAM_REVOCATION_ENDPOINT=<D1 revocation endpoint>
HELUO_IAM_CALLBACK_PORT=<0 或固定端口>
HELUO_IAM_CALLBACK_ADDRESS=<address>
HELUO_IAM_MANAGED_MODELS_BASE_URL=<gateway baseURL>
HELUO_IAM_DEFAULT_PROVIDER=<provider id>
HELUO_IAM_ALLOW_INSECURE_HTTP=<true 仅内网 http 且已确认>
HELUO_GITEE_HOST=<gitee host>
```

`HELUO_IAM_DEFAULT_PROVIDER` 使用企业网关的模型路由标识；不确定时向打包人员确认，不要编造。Gitee 未提供时删掉该行。未配置 Discovery 时，以 `HELUO_IAM_AUTHORIZATION_ENDPOINT`、`HELUO_IAM_TOKEN_ENDPOINT` 和 `HELUO_IAM_JWKS_URI` 显式给出端点。当前实现用同一个 `tokenEndpoint` 换票和刷新；企业刷新是否使用同一端点须联调确认。只有制包端验证使用 `HELUO_IAM_ALLOW_INSECURE_HTTP`，运行时不依靠此字段阻止 HTTP。

提供现有文件路径给 `config`，并在 macOS 制包机上检查忽略规则、设置文件权限；检查失败时停止：

```sh
config="<仓库根目录>/.env"
git -C "<仓库根目录>" check-ignore -q -- .env && chmod 600 "$config"
```

独立工具链没有 Git 仓库时，`config` 指向不受版本管理的专用文件，并单独设置权限为 `600`。

脚本按数据解析 `KEY=VALUE`，不执行 `source`、变量展开或命令替换；不得写入个人 Key、令牌或 `client_secret`。

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
5. 向打包人员报告：zip 路径与 SHA-256、私版版本与摘要、员工三步安装方式、未验证项（真实 IAM 登录与刷新、D1 撤销、个人 Key、运行期挂载、企业网络与平台）。

## 员工侧

交付 zip 根目录含：

- `enterprise-plugin/` — 私版 `.tgz`、`private-release.json`、`bundle-manifest.json`；
- `installer/` — `init-enterprise-plugin.mjs` 与 macOS/Windows/Linux 启动器；
- `INSTALL.md` — 安装前、安装、安装后、回滚；
- `SHA256SUMS` — 整包校验和。

员工只需安装 Node.js LTS 并运行对应启动器：缺官方 DSH 时启动器用 npm 自动安装并创建 web profile，再安装插件。官方 Desktop 应用的 desktop profile 由 Electron 独占，命令行无法安装（0.2.1-rc.5 实测）；Desktop 用户需在应用内插件设置中安装，启动器在只有 Desktop profile 时明确拒绝。登录后首次录入个人网关 Key。

## 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 重新预览并让打包人员确认；不要复用旧摘要 |
| `PUBLIC_DIGEST_MISMATCH` | 停止。重新取得公版与可信摘要，不猜测文件 |
| `PUBLIC_UNSAFE` | 公版含敏感样本或非中性补丁，拒绝继续，报告命中的类别 |
| `CONFIG_*` | 按字段回显修正；未知键不写入。出现 `IAM login is incomplete` 时补 Discovery URL（或 issuer + 三个端点），不要删掉 issuer 绕过 |
| `IAM_VALIDATOR_MISMATCH` | 公版与制作工具链中的 IAM 校验模块不一致或缺失；使用配套版本并重新核对来源与摘要 |
| `DISCOVERY_*` | 打包机到 IAM 的网络不可达，或 Discovery 文档与配置不一致（issuer/端点）。先修网络或配置；确实只能离线制作时才用 `--skip-discovery-check`，并在报告里列为未验证项 |
| 安装后向导显示“凭据存储不可用” | 检查目标平台的 SQLite、目录权限、磁盘空间与配套 keyring；目标平台行为须实测，不以平台名称推定后端不可用 |
| `BUNDLE_SECRET_EMBED_UNSUPPORTED` | public + PKCE 不使用 `client_secret`；不要把密钥写入配置或交付物，修正专用配置后重新预览 |
| `OUTPUT_*` | 换仓库外的新目录；不要删除已有文件 |
| `VERIFY_FAILED` | 制作或清单不一致，保留现场并报告错误行，不手工改清单 |

## 按需材料

- [references/sop.md](references/sop.md) — 打包人员问答清单、确认与证据、员工安装步骤、失败恢复。
