# 凭据存储提供器

状态：可用（开发实现，非生产就绪）。`@heluo/forge-credentials-keychain` 为 DSH `ctx.credentials` 提供本机 SQLite 存储，并向 IAM 注入独立的联合原子存储服务。Node 24 本机离线测试不能代替 Windows、麒麟、Electron 宿主及企业环境取证。

## 存储与安全边界

每个 `ref` 和 `record` 的值先使用 AES-256-GCM 单独加密，再写入 `credentials.sqlite`。每次写入使用随机 IV；认证数据绑定种类、完整存储键、属主和 `kid`。属主以明文列保存，属主或密文被篡改时返回 `CRED_DECRYPT_FAILED`；缺少对应密钥时返回 `CRED_KEY_UNAVAILABLE`。

数据库与 `keyring.json` 位于同一目录；keyring 中的 Base64 是编码，密钥本身没有再加密。在支持 POSIX 权限的平台，目录必须为 `0700`，数据库和密钥文件必须为 `0600` 且属于当前用户；权限不符时拒绝使用。代码不检查扩展 ACL；Windows 的 mode 位也不能证明 NTFS ACL，实际隔离依赖文件系统和目标机权限配置，尚未实机验证。密钥与数据库同目录，同账户进程可以读取密钥，不提供按应用隔离。密钥丢失后，对应密文不可恢复。

仅支持同机、同 PID namespace 的本地文件系统。所有写操作共用数据库级逻辑锁；短数据库事务负责锁定和提交，异步回调不占用 SQLite 写事务。凭据提交与逻辑锁释放在同一事务中完成；读写遇到 SQLite 竞争时有界等待，不重放写回调。等待上界按初始化、获取、提交和释放等阶段分别计算，一次操作的总耗时可能超过单阶段上界。操作已结束但释放受阻时，会发布绑定进程与随机锁令牌的私有完成标记，后续写入在事务内验证标记后可回收该锁；标记无法发布时返回 `CRED_LOCK_RECOVERY_FAILED` 并保持关闭。进程确实不存在时也可回收；锁损坏、操作仍活跃或完成状态不明时超时拒绝。数据库 `meta.active` 是活动密钥真源；轮换先落盘新密钥与 keyring 活动标记，再切换数据库中的 `kid`，两者暂时不一致时以数据库为准。旧密钥继续用于读取，读取不会触发重封或写库。

首次建库由初始化标记协调并发写入；初始化中断且完整性无法确认时保留文件并拒绝写入，需人工核查。已完成的数据库和活动密钥通过校验后，遗留标记不阻止写入。初始化尚未完成时只读打开可能暂时失败。支持 POSIX 的平台在切换活动密钥前同步密钥文件及目录，同步失败会拒绝切换；Windows 的目录持久性行为尚待实证。

新部署不读取或迁移旧文件。发现旧 `credentials.json` 或 `credentials.key` 时保留原物并拒绝初始化；已经存在的数据库缺少 keyring 时也不会重建密钥。

## 密钥生命周期与备份

首次写入新存储时随机生成 `k1`；重启后继续使用已有密钥，不按时间自动轮换。存储层提供显式 `rotate(kid)`：新密钥先写入 keyring，再切换数据库活动密钥，旧密钥保留以读取旧值。旧值只有在下次写入时才使用当前密钥重封；当前没有用户命令、定时轮换、批量重封或安全移除旧密钥的功能，不应手工删除仍被数据引用的密钥。

备份须先关闭使用该目录的 Host、CLI 和其他进程，再将整个存储目录作为一致快照保存在受保护的位置；备份也含明文密钥。恢复前应在独立目录验证副本，避免覆盖现有存储。本机合成数据测试覆盖关闭后复制整个目录并读回轮换前后的值，以及只有 SQLite 文件、缺少 keyring 时拒绝读写；没有内置备份或恢复命令，也没有目标机备份验收结论。

## 装配与读取

企业组合先挂载本包并禁用官方 `dsh-credentials-local`，再挂载 `@heluo/forge-iam`。内置 SQLite 后端由组合根绑定到当前 provider，单记录和网关联合写入分别受 IAM 门禁约束；其他注入对象不能通过自报方法获得信任。同权 JavaScript 代码仍可绕过进程内门禁，这不是进程隔离。

`storeDirectory` 可指定隔离存储目录，必须在 Git 工作区外；省略时使用平台用户目录：macOS 为 `~/Library/Application Support/HeluoForge`，Windows 为 `%LOCALAPPDATA%/HeluoForge`，Linux 为 `$XDG_DATA_HOME/HeluoForge`，未设置或无效时为 `~/.local/share/HeluoForge`。Windows 的 `LOCALAPPDATA` 为空或不是绝对路径时使用用户目录下的 `AppData/Local/HeluoForge`。

Linux 上旧默认目录已存在时继续使用该目录；旧目录与 XDG 目录是两个不同且均已存在的目录时，返回 `CRED_STORE_PATH_CONFLICT`，由使用者显式选择，不自动迁移、合并或覆盖。CLI 与 Host 必须使用同一目录和命名空间；CLI 可通过 `HELUO_FORGE_STORE_DIRECTORY` 指定目录。`openCredentialReader` 只暴露读记录、解析引用和关闭操作，不创建存储、不刷新令牌。CLI 的 `auth token` 输出仍适合脚本使用；Host 桥接的鉴权规则见 [凭据访问说明](../forge-iam/docs/credential-access.md)。

测试注入的内存后端需 `allowEphemeral: true`；数据仅存在当前进程内，不获得 IAM 可信声明，也不作为生产后备。没有明文文件或系统钥匙串回退。

## macOS 存储边界

默认目录在用户的 Application Support 目录下；未签名宿主不依赖系统钥匙串的应用签名 ACL。文件权限和同账户隔离不等于系统钥匙串的按应用隔离。

## 开发/试点覆盖层（非生产）

隔离测试可为凭据插件设置 `storeDirectory`，使用临时目录和合成凭据。此设置不能建立企业生产准入或证明目标机行为。不要在仓库、日志、命令参数或报告中保存真实 Key 与令牌。

## 验证

```sh
node --test packages/forge-credentials-keychain/test/*.test.mjs
pnpm check
```

单元与集成检查覆盖信封认证、密钥轮换、双键条件提交、异步锁、崩溃后的拒绝与恢复，以及 SQLite 文件中合成标记的明文扫描。Node、操作系统、Electron 和企业链路需分别实测；具体已验项以[设计索引](../../docs/design/README.md#22-实现与验证入口)为准。
