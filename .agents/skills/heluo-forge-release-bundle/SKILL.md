---
name: heluo-forge-release-bundle
description: 供打包人员通过问答收集企业 IAM/网关配置，在 macOS 上生成员工安装负担最小的企业 DSH 交付包（私版插件、按平台启动器、安装说明与校验和），并完成本地核验；配置只写入仓库外临时文件，密钥不得进入交付物。
---
# 企业 DSH 交付包制作

## 何时使用

打包人员要求“给员工做一个企业 DSH 包”“按当前 PR 的方式打包”，并且已拿到公版插件制品时使用。

不适用：日常开发构建、公开发布、把企业制品上传公共 CI、未获授权的公证。本包只供企业内部使用，不对外分发。

## 角色

- **打包人员**：与本 Skill 对话，提供企业地址与版本，执行确认。
- **员工**：只收到最终 zip，按 `安装说明.md` 三步安装，不接触企业配置和制作命令。
- Skill 只服务打包人员，不要求安装用户填写任何企业字段。

## 不可让步的边界

- 真实配置只写入仓库外的临时文件（`umask 077`，权限 600）；结束后删除。
- 配置值不进入交付物、报告、日志或命令行参数；报告里只出现键名、摘要前缀与结论。
- 公版摘要必须来自发布页或另一条可信渠道，不信任制品旁边的 `SHA256SUMS`。
- 禁止全局文本替换；只允许工具声明的配置注入位置。
- 密钥、令牌、`client_secret` 不属于本交付；出现即停止（工具会报 `BUNDLE_SECRET_EMBED_UNSUPPORTED`）。
- 输出目录必须在仓库外；缺字段、摘要不符、目录已存在或用户取消时安全失败，不覆盖、不留半成品。
- 官方 DSH 宿主原样使用：交付包不重签、不公证、不修改官方载荷，只安装企业插件。
- 运行期挂载只能在宿主「设置 → 插件」确认；工具输出 `mounted=unknown` 是正常的，不得写成挂载证据。

## 问答协议

逐个问题询问打包人员，每问给出默认值与校验规则；不要一次倾倒全部问题。

| 槽位 | 必填 | 默认 | 校验 |
|---|---|---|---|
| 公版 `.tgz` 路径 | 是 | — | 存在、文件名含版本 |
| 公版 SHA-256 | 是 | — | 64 位 hex，与本地文件一致；来源可信 |
| IAM issuer | 是 | — | `https://` 绝对地址；无 query/fragment |
| IAM client_id | 是 | — | 非空，不含空白 |
| 网关 baseURL | 是 | — | `https://` 绝对地址，通常以 `/v1` 结尾 |
| 回调端口 | 否 | `17321` | 1024–65535 整数 |
| 回调地址 | 否 | `127.0.0.1` | IPv4 回环或主机名 |
| Gitee host | 否 | 空 | 企业 Gitee 的 `https://` 地址；没有就跳过 |
| 版本号 | 是 | 公版版本 + `-corp.1` | 与公版不同，符合 semver |
| 输出目录 | 是 | — | 仓库外、不存在或为空 |

收齐后写入临时文件：

```sh
umask 077
config="$(mktemp -t heluo-enterprise.XXXXXX.env)"
cat > "$config" <<'ENV'
HELUO_IAM_AUTH_MODE=public
HELUO_IAM_ISSUER=<issuer>
HELUO_IAM_CLIENT_ID=<client_id>
HELUO_IAM_SCOPES=openid profile offline_access
HELUO_IAM_CALLBACK_PORT=<port>
HELUO_IAM_CALLBACK_ADDRESS=<address>
HELUO_IAM_MANAGED_MODELS_BASE_URL=<gateway baseURL>
HELUO_IAM_DEFAULT_PROVIDER=<provider id>
HELUO_GITEE_HOST=<gitee host>
ENV
```

`HELUO_IAM_DEFAULT_PROVIDER` 使用企业网关的模型路由标识；不确定时向打包人员确认，不要编造。Gitee 未提供时删掉该行。

## 生成与交付

1. 先预览（不写盘），把回显的键名、版本、摘要前缀给打包人员核对：

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
4. 删除临时配置：`rm -f "$config"`。
5. 向打包人员报告：zip 路径与 SHA-256、私版版本与摘要、员工三步安装方式、未验证项（真实 IAM 登录、个人 Key、运行期挂载、企业网络与平台）。

## 员工侧

交付 zip 根目录含：

- `enterprise-plugin/` — 私版 `.tgz`、`private-release.json`、`bundle-manifest.json`；
- `installer/` — `init-enterprise-plugin.mjs` 与 macOS/Windows/Linux 启动器；
- `安装说明.md` — 安装前、安装、安装后、回滚；
- `SHA256SUMS` — 整包校验和。

员工只需：官方渠道装 DSH → 启动一次并完全退出 → 运行对应启动器 → 重启并登录，首次登录录入个人网关 Key。

## 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 重新预览并让打包人员确认；不要复用旧摘要 |
| `PUBLIC_DIGEST_MISMATCH` | 停止。重新取得公版与可信摘要，不猜测文件 |
| `PUBLIC_UNSAFE` | 公版含敏感样本或非中性补丁，拒绝继续，报告命中的类别 |
| `CONFIG_*` | 按字段回显修正；未知键不写入 |
| `BUNDLE_SECRET_EMBED_UNSUPPORTED` | 企业采用 public+PKCE，不应有 secret；删掉密钥行或停止 |
| `OUTPUT_*` | 换仓库外的新目录；不要删除已有文件 |
| `VERIFY_FAILED` | 制作或清单不一致，保留现场并报告错误行，不手工改清单 |

## 按需材料

- [references/sop.md](references/sop.md) — 打包人员问答清单、确认与证据、员工安装步骤、失败恢复。
