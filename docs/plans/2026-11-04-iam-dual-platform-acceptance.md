# IAM 双端验收矩阵（Windows / 麒麟）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-012 |
| 文档名称 | IAM 双端验收矩阵（Windows / 麒麟） |
| 版本 | V0.4.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-20 |
| 门禁 | 2026-11-04 已在远程 macbook 与 megacube 做过一次部署复验；完整验收仍待目标环境与 IAM 账号 |
| 交付门禁 | 远程 macbook 与 megacube 已做首次部署复验；完整验收仍待目标环境与 IAM 账号 |
| 文档层级 | L2 验收矩阵；能力证据引用 #120—#122 的记录，本文只做平台复验 |

> 编制依据：2026-11-04 对 #123 正文、PLAN-011 M5 与既有 `pnpm check`、组合探针结果的核对。§3 保留当时的 NOT RUN / BLOCKED 状态；文档存在不构成验收证据。
>
> 关联文档：[IAM 接入设计](<../design/plugins/forge-iam.md>)、[凭据包说明](../../packages/forge-credentials-keychain/README.md)、[机密客户端隔离契约](../contracts/iam-client-auth-isolated.md)、[多端凭据存储方案](<2026-11-03-credential-multiplatform.md>)、[实施计划](<2026-11-04-iam-issues-implementation.md>)、[开发与验收约定](<../engineering/development-conventions.md>)。

本矩阵沿用 2026-11-04 的结果，以下判据已按现行设计修订，不能把旧结果直接当作新判据的执行证据。后续 [issue #303](https://github.com/hrygo/heluo-forge/issues/303) 汇总插件在 Windows、麒麟、UOS、macOS 多机真测，但文件权限、重启、用户隔离及恢复等专项的具体 SHA、环境与逐项证据仍待梳理，不能自动映射为本表 PASS；[issue #304](https://github.com/hrygo/heluo-forge/issues/304) 的网关契约验证尚未关闭。

## 1. 使用方式

1. 按 §2 填环境表，一行一台机器；版本、配置、责任人、账号权限都要写，敏感值脱敏。
2. 按 §3 逐条执行，只填四类结果：`PASS`、`FAIL`、`BLOCKED`、`NOT RUN`；每行在“证据”列写命令与产物路径（脱敏后）。
3. 失败项不跳过：写复现步骤与现象，回到对应子项修完再复验。
4. 执行前确认 `pnpm check` 通过，`git diff --check` 干净。

## 2. 环境登记表

| 项 | Windows | 麒麟 |
|---|---|---|
| 平台与版本 | 待填（如 Windows 11 23H2 x64） | 待填（发行版与内核版本） |
| DSH 版本 | 待填（按被测制品锁定版本） | 待填 |
| Node / pnpm | 待填（按 `.node-version`） | 待填 |
| IAM 端点、client ID、注册方式与认证方法 | 待填（脱敏；`confidential` + PKCE S256，方法与登记一致） | 待填（同左） |
| 网关与模型 | 待填 | 待填 |
| 凭据后端 | 待填（当前默认 SQLite 值级加密及同级目录文件 keyring；记录实际配置） | 待填（同左） |
| 测试账号与权限 | 待填 | 待填 |
| 执行人与日期 | 待填 | 待填 |

## 3. 用例矩阵

### 3.1 主路径

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| A-01 | 从实际安装的私版完成机密客户端预置和浏览器新登录 | 按[管理员预置指南](../../packages/forge-iam/docs/credential-access.md#9-管理员预置与轮换-iam-客户端密钥)预置并核对绑定，和 IAM 登记一致；视图 `signedIn=true`，主体与 IAM 一致 | NOT RUN | |
| A-02 | 首轮正常计划续期 | 授权码换票与刷新均使用同一登记方法；日志出现 `refresh-committed`，会话保持 `ready`，新授权可用 | NOT RUN | [issue #408](https://github.com/hrygo/heluo-forge/issues/408#issuecomment-7034227656) 事故 401 发生在刷新令牌校验前 |
| A-03 | 退出登录 | 本地立即停止企业调用，视图回到未登录 | NOT RUN | |
| A-04 | 重启应用后恢复会话 | 不要求重新登录，或按设计明确要求 | NOT RUN | |

### 3.2 故障路径

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| F-01 | 认证配置无效或预置缺失（仅用合成值） | 公版及私版拒绝原始密钥；公开模式拒绝非秘密引用；机密模式遇到缺记录或绑定不匹配时拒绝换票与刷新 | NOT RUN | |
| F-02 | 回调地址不精确匹配 | 拒绝，不换票 | NOT RUN | |
| F-03 | 授权码重放 | 第二次换票失败 | NOT RUN | |
| F-04 | 已有 SQLite 存储缺失 keyring、损坏，或 POSIX 权限不符 | 按实际错误拒绝，不自动重建密钥、迁移或回退其他后端；Windows NTFS ACL 与目标平台隔离须另行实证 | NOT RUN | |
| F-05 | 机密客户端密钥轮换 | 同一绑定更新预置后旧 V2 不可用，旧刷新令牌不重发；核对实际 IAM 生效时间，新登录后再次完成 A-02 | NOT RUN | D2 为历史书面答复，实际窗口待验证 |
| F-06 | 多进程竞争刷新 | 同一刷新周期仅一方发起换票；其他进程等待并可采用完成结果，不重放旧刷新令牌，超时不抢占 | NOT RUN | |
| F-07 | 断网后恢复 | 分类为网络故障，不误判为授权失效 | NOT RUN | |
| F-08 | 登录过程中取消 | 尝试结束，无残留 pending | NOT RUN | |

### 3.3 O3 禁用与组合行为（复用 #122 结论，本项复验一次）

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| O-01 | 官方登录入口不可用 | 无官方登录旁路 | NOT RUN | |
| O-02 | 官方模型与 API Key 不可用 | 不回落公网模型 | NOT RUN | |
| O-03 | 账户页显示企业身份 | 不显示官方账户 | NOT RUN | |
| O-04 | 缺凭据时 shell 仍可用 | 与 AC6 一致 | NOT RUN | |
| O-05 | 升级回灌后禁用仍生效 | 覆写层未被覆盖 | NOT RUN | |
| O-06 | 旧凭据保留与新存储兼容 | 旧 `credentials.json` / `credentials.key` 保留，不读取或自动迁移，也不单独阻止新存储；旧同目录 keyring 或未绑定旧库拒绝使用并保留原物。若涉及卸载，另行确认授权与隔离 | NOT RUN | |

### 3.4 服务端语义（引用 #120 记录，本项复验）

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| S-01 | 管理员停用后五分钟内按人拒绝 | IAM/网关联合证据 | BLOCKED | 依赖企业环境 |
| S-02 | 登出只断当前授权及后代 | 达不到则记 BLOCKED，不改需求 | BLOCKED | D1 仅能撤销访问令牌，刷新令牌不可撤销；后代不成立 |
| S-03 | 其他设备与 SSO 不受影响 | 同上 | BLOCKED | 需企业环境验证撤销不牵连同会话其他应用 |

### 3.5 审计与诊断

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| D-01 | 制品、配置、审计与诊断无令牌、密钥或个人 Key 原值 | 双端分别检查公版、私版、安装/预置输出与诊断；私版只含模式、方法和非秘密引用 | NOT RUN | |
| D-02 | 取消流不推断上游停止或零计费 | 文案与日志如实标注 | NOT RUN | |

### 3.6 仓库与产物

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| R-01 | `pnpm check` 全绿 | 命令输出 | NOT RUN | |
| R-02 | `git diff --check` 干净 | 命令输出 | NOT RUN | |
| R-03 | 私版可安装到目标 profile | 装载时确认 Windows 与麒麟的制品摘要、版本和目标 profile；分别执行 A-01、A-02 | NOT RUN | |

## 4. 首次实机部署复验（2026-11-04）

环境：远程 macbook（macOS 26.5.1 arm64，Node 26.4.0）、megacube（Linux aarch64，Node 24.21.0，DSH 0.2.1-rc.3）；macbook 用新装 DSH 0.2.1-rc.5。两台都从 `main@730f76e` 的 bundle 克隆，`pnpm install --frozen-lockfile`，再装同一份企业制品。

| 项 | macbook（macOS） | megacube（Linux） | 结论 |
|---|---|---|---|
| `pnpm check` | 2514 项 / 2508 通过 / 6 跳过 / 0 失败 | 同左 | PASS |
| 制品安装 | `dsh plugin add` 成功 | 同 | PASS |
| 组合树 | 3 条企业行、官方四行 `disabled: true` | 同 | PASS |
| 缺失条目告警 | `ui-settings-account` not found | 同 | 最小 profile 无该客户端插件；跳过 ≠ 已禁用 |
| 启动 | `KEYCHAIN_UNAVAILABLE`，`authorization` 等待 `credentials`，无明文凭据文件 | 同 | PASS（按设计 fail closed） |
| 系统钥匙串 | 未接入，需开发覆盖层 | 未接入 | AC4 仍 BLOCKED |

实机暴露并已修的三处环境假设：

1. `team-full-install.mjs` 只接受 Node 24，macOS 的 Node 26 被拒；改为要求 24 及以上。
2. 密钥链测试用 `os.tmpdir()` 当“仓库外目录”，而 megacube 的 `/tmp` 本身是 git 仓库；改为挑选可证明在仓库外的临时根。
3. 安装器测试夹具继承用户全局 gitignore，`device-key.pem` 被忽略导致 `git add` 失败；夹具隔离 `GIT_CONFIG_GLOBAL`。

Linux 以 `umask 002` 克隆时文件为 664，安装器曾只回一句 `unsafe package script`。按评审结论改为：报错带路径、实际权限位与修复命令，另加 `--allow-group-writable` 显式开关（只接受属主仍是当前用户的副本，目标端仍写 0600/0700）。见 PR #143。

### 4.1 开发覆盖层实机尝试（macbook，2026-11-04）

默认组合在 macOS 与 Linux 都停在 `KEYCHAIN_UNAVAILABLE`，因此试一次文档里的逃生门。

- 生效位置：`--patch` 传入同一行会被 bundle 层覆盖，必须写进 profile 的 `cordis.patch.yml`（“applied after every bundle layer”）。
- 组合证据：`--dump-config` 中该行带上了 `filePath` 与 `allowInsecureFile: true`。
- 启动观察：不再出现 `KEYCHAIN_UNAVAILABLE`，也不再出现 `warning: 2 entries did not activate`，日志为空。
- 最小 profile 没有 HTTP 监听（150 秒无响应），无法判定就绪，改用 `--from-default-profile web` 新建的完整 web profile 重试。

完整 web profile 的结果（2026-11-04，macbook）：

| 项 | 结果 |
|---|---|
| 启动 | `dsh web: http://127.0.0.1:47930/?token=…`，带 token 访问首页 303（就绪） |
| 鉴权 | `/api/forge-iam/view` 返回 401，连接守卫在位 |
| 未激活条目 | 只剩 `account-controller` 等 `deepseekAccount`；该依赖已被补丁禁用，属组合残留告警 |
| 凭据文档 | 首次使用后生成 `~/forge-pilot/credentials.json`，0600，键只有 `entries`、`version` |
| 非生产告警 | 日志里未见“明文文件已启用”提示，插件用 `ctx.logger.warn` 输出，未进 stderr，诊断可见性待查 |
| 清理 | 停进程、删 profile 与目录；补丁改动未写入仓库 |

结论：覆盖层在完整 web profile 上可用且能到就绪；但“非生产”提示不可见、`account-controller` 残留两处需要处理。

## 5. 当前状态

- §3 保留原记录：多数用例 `NOT RUN`，服务端语义三项 `BLOCKED`。
- 2026-11-04 的阻塞原因为当时没有 Windows 与麒麟实机及对应测试账号权限；后续多平台测试汇总见 [issue #303](https://github.com/hrygo/heluo-forge/issues/303)，不等于本矩阵逐项通过。
- 当前逐项验收仍须对应制品 SHA、目标环境、授权及可追溯证据；网关契约验证见 [issue #304](https://github.com/hrygo/heluo-forge/issues/304)。执行结果回写本表与 #123，不新建平行记录。
