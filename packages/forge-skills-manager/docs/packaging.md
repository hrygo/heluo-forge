# 技能管理器企业制包说明

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-002 |
| 文档名称 | 技能管理器企业制包说明 |
| 版本 | V0.1.2 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-25 |
| 门禁 | 离线规则与工具闭包验证；macOS 完整交付及企业联调待验 |

本说明随独立工具链交付，面向制包人员；命令从工具链根目录执行，有源码时从仓库根执行。通用步骤遵循[公共打包 Skill](../../../.agents/skills/heluo-forge-release-bundle/SKILL.md)，公共 Skill 与 SOP 保持原样。本说明补充技能管理器部署字段，不表示真实 IAM、Nacos 或目标平台验收已完成。

## 选择打包方式

| 方式 | 输入与配置 | 修改连接配置 |
|---|---|---|
| 开发联调 | 源码构建中性企业组合包，在隔离 profile 配置 IAM、网关和 Nacos | 修改 profile 后重启，无需重新制包 |
| 正式交付 | 已核验的企业公版与专用配置文件，制作包含企业配置的私版 | 修改配置文件，用新私版版本重新预检、确认、安装并重启 |

开发联调需要包含 IAM 的企业组合包；独立 Skill Manager 包不包含 IAM。开发构建和安装步骤见源码仓库的包 README；仅下载制作工具链不能代替源码构建环境。测试环境私版与正式环境私版均走正式交付流程，四项 Nacos 字段同样必填。

仓库的统一员工包构建入口为 `scripts/build-employee-package.mjs`，发布流程见源码仓库的 `docs/engineering/development-conventions.md` §7；该开发文档不随独立工具链交付。`--config-from-env` 从发布 Environment 映射本说明的 Nacos 四项必填及可选超时；账号密码保留原值，仍须通过正式制包校验。以下公版加专用文件的两段式命令保留用于独立工具链与回退流程。

## 配置文件

先按公共 Skill 准备 IAM、网关及其余配置。公版装配 `heluo-skills-manager` 时，在同一个专用文件追加下列字段；没有装配该插件的企业包无需填写 Nacos，填写则拒绝，不静默忽略。

| 字段 | 要求 |
|---|---|
| `HELUO_NACOS_SERVER_URL` | 必填，HTTP/HTTPS 服务根，不含 URL 账号密码、查询参数或 fragment；无需 HTTP 开关 |
| `HELUO_NACOS_NAMESPACE_ID` | 必填，1–128 位字母数字、点、下划线或连字符，首位为字母数字；`public` 也必须显式填写 |
| `HELUO_NACOS_USERNAME` | 必填，专用只读账号，非空且非全空白 |
| `HELUO_NACOS_PASSWORD` | 必填，非空且非全空白；首尾空格用引号保留 |
| `HELUO_NACOS_TIMEOUT_MS` | 可选，100–120000 毫秒，默认 15000 |

```dotenv
HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos
HELUO_NACOS_NAMESPACE_ID=public
HELUO_NACOS_USERNAME=svc-ci
HELUO_NACOS_PASSWORD="<只读账号密码>"
HELUO_NACOS_TIMEOUT_MS=15000
```

配置文件权限须为 `600`；在仓库内须受 Git 忽略且未跟踪，独立工具链使用不受版本管理的位置。保留已有文件，不自动覆盖或删除。按 `KEY=VALUE` 数据读取，不使用 `source`、`export`、变量展开或命令替换。四项不会从启动环境补齐；旧 `HELUO_NACOS_USERNAME_ENV`、`HELUO_NACOS_PASSWORD_ENV`、`HELUO_NACOS_ALLOW_INSECURE_HTTP` 按未知键拒绝。IAM 和网关的 HTTP 确认规则仍按公共 Skill 执行。

## 预检与生成

在 macOS 制包环境使用 Node 和系统 `zip`。公版与工具链须配套，预期公版 SHA-256 从发布记录或另一可信渠道取得；输出目录在仓库外且不存在或为空，同名 zip 不得已存在。下列参数替换为实际文件路径、可信摘要和不同于公版的新私版版本：

```sh
node scripts/release-delivery.mjs --public <public.tgz> --public-sha256 <trusted-sha256> --config <private.env> --version <private-version> --output <new-output-dir> --dry-run
```

首次预检输出脱敏计划和 `planDigest`，以 `CONFIRM_REQUIRED` 退出且不写产物。核对字段名、版本、摘要，`loginReady`、`gatewayConfigured` 均应为 `true`；启用 Discovery 时核对 `discovery.checked`。包含技能管理器时，`nacosConfigured: true`、`embeddedSecrets: ["nacos.password"]`；不含时分别为 `false`、`[]`。Nacos 配置和运行文件匹配在预检阶段检查，不匹配不会输出成功计划。

配置值不出现在计划或错误中；原始输出可能含本地路径，对外分享前脱敏。配置或公版改变后重新预检，使用本次摘要的前至少 8 位生成：

```sh
node scripts/release-delivery.mjs --public <public.tgz> --public-sha256 <trusted-sha256> --config <private.env> --version <private-version> --output <new-output-dir> --confirm <planDigest-prefix>
```

生成私版 tgz、独立清单和摘要、员工启动器、`INSTALL.md` 及相邻 zip。只需私版 tgz 时可使用 `make-private-bundle.mjs` 与相同输入参数：先查看脱敏计划，再用 `--confirm` 确认；该命令不接受 `--dry-run`，不生成员工材料。任何失败均不得手工修改清单冒充成功。

## 凭据与安装边界

包内预置 Nacos 地址、命名空间及专用只读账号密码；员工无需环境注入。完整 `.env` 不进入交付物，安装启动器和插件均不读取制包文件。包内密码可被解包读取，不提供配置加密；含凭据的私版只供内部授权交付，不进源码仓库或公开 Release。HTTP 不提供 TLS 保护。

Nacos 密码预置仅适用于企业技能库专用只读账号，与公共 Skill 的“密钥和令牌不进入交付物”通用边界存在差异；公共 Skill 不因此修改，也不将此要求扩展到 IAM client secret、个人 Key 或令牌。个人网关 Key 仍由员工录入；Nacos 使用独立只读账号，不实现个人 IAM 换票。只读权限须由真实 Nacos 服务端核验。

员工按 `INSTALL.md` 安装到同一 profile 并确认插件挂载。管理员先备份并移除旧 profile 的 Nacos 覆盖项，避免覆盖包内配置。更新配置使用新私版版本重新生成、安装并重启，无需重新编译源码。安装器核验受支持的凭据声明，不代表对包内秘密的保密或任意内容扫描。

## 员工验收

按交付物 `INSTALL.md` 安装到同一 profile，确认版本、摘要和企业 bundle 单次挂载，不同时挂载独立 Skill Manager。默认员工启动器安装到 web profile，Desktop 使用独立 profile，按应用内支持的安装流程操作。

| 验收项 | 预期 |
|---|---|
| 配置覆盖 | 旧 Nacos 覆盖项已备份并移除，重启后使用包内连接配置；打开 profile 配置不会显示包内字段 |
| 本地管理 | 全局、已登记项目、其他 Agent 来源与既有数据正常，企业库不可达不影响本地管理 |
| 企业库读取 | 凭据正确时可以读取列表、查看详情和下载，下载默认禁用，再次进入显示已下载状态 |
| 凭据缺失或服务停止 | 拒绝或显示不可用，不复用不匹配的旧凭据令牌，不显示虚假下载成功 |
| 企业依赖 | 实际登录、网关模型及 Nacos 服务端只读权限分别核验，本地 mock 不算企业证据 |

记录制品版本、源提交及工作区状态、摘要、宿主版本、profile、命令结果及未验证项，不记录密码、令牌或 Cookie。

## 失败处理

| 回显 | 处理 |
|---|---|
| `CONFIG_INVALID` | 按字段名补齐或修正配置，不把密码粘贴到会话或报告 |
| `CONFIG_UNKNOWN_KEY` | 删除旧变量名或开关，修正拼写；不得绕过白名单 |
| `NACOS_RUNTIME_MISMATCH` | 使用与公版配套的工具链；必要时重建公版，不绕过校验 |
| `PUBLIC_TARBALL_INVALID` | 检查插件装配及配置消费方，不向无技能管理器的包注入 Nacos |
| `CONFIRM_REQUIRED` / `CONFIRM_MISMATCH` | 核对本次计划后重新确认，不能复用旧摘要 |

其他失败按公共 Skill 处理。预检及离线测试不证明真实企业登录、网关连通、Nacos 服务端拒写或目标平台兼容。
