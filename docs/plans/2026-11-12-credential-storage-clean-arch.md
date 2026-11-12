# 凭据存储整洁架构实施方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-017 |
| 文档名称 | 凭据存储整洁架构实施方案 |
| 版本 | V0.3.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-12 |
| 门禁 | 设计评审；不改写现有实现状态，不授予生产能力 |
| 文档层级 | L2 实施计划；存储契约与字段以设计文档为准 |

> 编制依据：issue #147 与 PR #237 描述的实现，以及字段值统一加解密的决定。PR #237 已合并，以 `origin/main` 为基线。本计划后续增加 SQLite 数据与密钥分目录的要求，并保留已创建的 SQLite 数据兼容；此前的整文档加密后端不重新引入。

> 关联文档：[IAM 接入详细设计](<../design/plugins/forge-iam.md>)、[网关凭据双模式设计](<../design/credential-modes.md>)、[凭据包说明](<../../packages/forge-credentials-keychain/README.md>)、[总体架构 ADR-19](../architecture/platform-architecture.md)、[issue #147](https://github.com/hrygo/heluo-forge/issues/147)、[PR #237](https://github.com/hrygo/heluo-forge/pull/237)。

## 1. 结论与范围

存储层按整洁架构分为实体、用例、端口、适配器、框架四层，依赖只向内。字段值在写入前统一加密，加密实现为适配器层的装饰器，用例与实体不感知。

- **做**：值级 AES-256-GCM 信封；`keyring` 多密钥与轮换；`Backend`、`Cipher`、`KeyProvider` 端口；SQLite 后端；CLI、插件方法、同源 HTTP、桥接 HTTP 四个面读取同一底层会话，对齐可比较的身份、令牌与错误语义。
- **不做**：旧整文档格式读取、数据迁移、双读回退、回退到旧后端；按应用隔离；跨机同步。
- **删除**：整文档加密路径、迁移模块、CLI 自建 provider 的分支逻辑。

旧同目录 keyring 与缺少密钥绑定的旧 SQLite 库不兼容、不迁移，保留原物且不覆盖；密钥文件丢失会使对应加密数据不可用。

## 2. 目标结构

```tree
框架层 | 最外层，只提供原语
  内置 SQLite | 关系存储
  内置 crypto | AES-256-GCM
  Cordis 宿主 | 服务与生命周期
适配器层 | 实现端口
  SQLite 后端 | Backend
  加密装饰器 | Backend
  内存后端 | 测试用
  密钥文件 | KeyProvider
  CLI 与路由 | 接入面
用例层 | 编排，只依赖端口
  会话读取
  网关凭据保存
  密钥轮换
实体层 | 零依赖
  引用
  记录
```

| 规则 | 含义 |
|---|---|
| 实体零依赖 | 不 import 框架、数据库与网络 |
| 用例只依赖端口 | 不知道 SQLite、文件或钥匙串 |
| 适配器实现端口 | 可替换，不反向依赖用例 |
| 组合根只装配 | 在插件 `apply` 中注入实现 |

## 3. 统一加解密

数据库位于 `D/credentials.sqlite`，密钥文件位于同级 `D.keys/keyring.json`；发现旧 `D/keyring.json` 或缺少密钥绑定的旧库时拒绝访问并保留原物。POSIX 密钥文件权限为 0600、密钥目录为 0700；Windows 访问控制依赖用户目录 ACL。文件带版本与多个 `kid`。备份和恢复新库时须同时保存并配对两个目录，复制整个用户目录仍会同时包含两者。

```text
keyring.json
{ "v": 1, "active": "k2", "keys": { "k1": "<base64>", "k2": "<base64>" } }

信封
magic "HFSE" | ver 1B | alg 1B | kidLen 1B | kid | iv 12B | tag 16B | ciphertext

AAD
"HFSE|1|record|heluo-iam/session|E1001|k2"
```

- 每条值独立随机 IV，禁止复用。
- AAD 绑定 kind、键名、属主与 `kid`。属主取自 `secret.owner` 明文列：写入时同时落列与信封，读取时先取列再解密，不从密文推断，冷启动因此可读。
- 属主列被改动会使 AAD 不匹配并解密失败；整行挪用会因键名或属主不符而失败。
- 解密失败与 AAD 不匹配返回同一错误码 `CRED_DECRYPT_FAILED`，不区分为解密预言机。
- 联合提交时先解密当前值再比较明文；随机 IV 使密文不可直接比较，比对通过后只封一次再写。
- 轮换只切 `meta.active`；旧 `kid` 保留到重封完成，移除后该值返回 `CRED_KEY_UNAVAILABLE`。
- 读路径只解密不写库；重封由显式任务或该键的下一次写入完成。

## 4. 数据模型

```sql
CREATE TABLE secret (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,      -- 'ref' | 'record'
  owner      TEXT NOT NULL DEFAULT '',  -- AAD 中的属主，引用可为空
  envelope   BLOB NOT NULL,
  kid        TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

端口只保留签名，实现由组合根注入：`Cipher.seal/open`、`KeyProvider.exists/initialize/active/byId/add/activate`、`Backend.get/set/delete/list`、可选 `Backend.transaction`。SQLite 使用同步密钥来源；`exists` 只在能确认密钥材料不存在时返回 `false`，无法确认或访问失败时拒绝操作。现有文件来源仍是默认实现，其他来源须分别验证持久化和跨进程语义。

## 5. 标准 API 面

| 面 | 入口 | 内容 | 鉴权 |
|---|---|---|---|
| CLI | `heluo-forge auth token`、`whoami --json` | 令牌为 stdout 单行纯文本；身份为不含令牌的 JSON | 本机用户；可选经桥接取令牌 |
| 插件方法 | `ctx.iam.getSession()`、`getAccessToken()` | 身份快照不含令牌；令牌返回字符串 | 宿主内 |
| 同源 HTTP | `GET /api/forge-iam/session`、`POST /api/forge-iam/token` | 身份为 JSON；令牌为 `{ token, expiresAt }` | Connection 守卫；令牌请求另需同源意图 Header |
| 桥接 HTTP | `POST /api/forge-iam/bridge/token` | `{ token, expiresAt }` | loopback 与 Bearer 能力值 |

同一稳定会话在相应准入条件成立时，各身份读取入口返回同一身份，四个入口返回同一令牌；未登录、无效 grant 与凭据解密等可比较的共同失败保持一致的错误码，各入口保留自身输出封装、鉴权错误和退出码。CLI 调本包导出的 reader，不自建 provider；离线 CLI 只读本地会话，不刷新，只有 Host 可刷新。

Host 还校验 grant 与当前配置的 `issuer`、`clientId` 和已配置 `resource`。离线 CLI 不持有 Host 当前配置，不能完成这项核验；需要确认该上下文一致时必须经 Host 桥接。Host 会话是内存快照，离线令牌在到期前 30 秒即拒绝；比较时需排除刷新或快照同步带来的时序差异。

## 6. 扩展点

| 扩展对象 | 方式 | 不改动 |
|---|---|---|
| 新存储后端 | 实现 `Backend`，跑契约套件，注册名字 | 用例、API、密文格式 |
| 新加密算法 | 实现 `Cipher`，注册 `alg` 编号 | 存储与 API |
| 新密钥来源 | 实现 `KeyProvider`，文件、钥匙串或 KMS | 加密与存储 |
| 新接入面 | 复用既有会话与令牌语义 | 存储与加密 |

后端能力不靠自报：注册表只列出通过契约套件的实现，`capabilities()` 由测试证明。

契约套件至少覆盖三类结果：普通读写、两键联合提交的原子性、以及缺少联合提交的后端被拒绝。网关写只允许落在通过联合提交原子性用例的后端上，其余一律拒绝，不做静默降级。

非规范底层键和损坏记录的原始写入等额外测试输入不属于共同 provider 契约；SQLite 与内存后端在这些输入上的行为不要求一致。

## 7. 实施步骤

| 步 | 内容 | 完成判据 |
|---|---|---|
| 1 | 抽实体、端口与用例；删除旧格式与迁移模块 | 新增用例测试全绿，删除后无悬空引用 |
| 2 | 加密装饰层接入，`keyring` 落地 | 往返、篡改、AAD 错位用例通过 |
| 3 | SQLite 后端与契约套件 | 共同 provider 契约内有效输入及错误语义一致 |
| 4 | 四个接入面读取同一会话 | 可比较的身份、令牌与错误语义一致；保留各自封装、鉴权与刷新边界 |
| 5 | 三平台与 Electron 取证 | 记录写入验收清单 |

第 1 步即删旧路径，不留兼容分支。加密未生效前不得写库。

## 8. 测试与验收

| 层 | 用例 |
|---|---|
| 单元 | 往返、AAD 错位、篡改、截断、未知 `kid`、密钥文件 0644 拒绝 |
| 属性 | 任意字节往返；空值被拒绝 |
| 集成 | 契约套件跑 sqlite 与内存后端；联合提交注入失败后两键均不可见；缺联合提交的后端被拒绝；崩溃后重开 |
| 接口 | 真实 CLI 子进程、Host 与两条 HTTP 路径对照身份、令牌及共同失败；验证各自封装和鉴权，仅 Host 刷新；发行者等运行配置经 Host 核验 |
| 冷启动 | 新进程直接读取 session 与网关引用，不需要先验状态 |
| 轮换 | 旧 `kid` 仍可解；移除后返回 `CRED_KEY_UNAVAILABLE` |
| 安全 | 库、`-wal`、`-shm` 扫描固定 32 字节标记，结果为空 |
| 平台 | Node 24 三平台，加 Electron 宿主 |

篡改用例必须失败：改动一个字节后抛 `CRED_DECRYPT_FAILED`，不返回旧值。

## 9. 删除清单

- `migrate.mjs` 与旧格式解密器。
- 文件后端及其整文档 AES-256-GCM 路径；只保留 SQLite 与测试用内存后端。
- 探测后端是否支持原子能力的自报字段判断。
- CLI 中的后端解析、目录解析与不取证开关复制。

## 10. 风险与未验证

- `node:sqlite` 在 Node 24 为 1.2 Release candidate，需锁定版本并在两个宿主验证。
- 同步 API 不允许在事务中 `await`；占用写锁跨 I/O 会让其他进程 busy 超时。
- Windows、麒麟与 Electron 宿主尚未按本方案取证。
- 密钥未再加密，分目录只减少单独复制数据库目录时的密钥暴露；隔离边界仍是用户账户，不是单个应用。旧同目录密钥保留原位，不自动读取、迁移、覆盖或删除。
- 读路径不写库；轮换后的重封需显式任务或下次写入，本计划未为批量重封排期。
- 本计划不覆盖企业 IAM 与网关联调，相关结论以既有门禁为准。

## 11. 附图

同目录 [HTML 版](<2026-11-12-credential-storage-clean-arch.html>) 为评审视图，控制稿为本文。两者冲突时以本文为准；状态、门禁与未验证项只以本文为准。
