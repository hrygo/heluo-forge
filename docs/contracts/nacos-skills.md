# Nacos 公共技能库契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-001 |
| 文档名称 | Nacos 公共技能库契约 |
| 版本 | V1.2.3 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-25 |
| 门禁 | 本地合成与独立实例验证；企业环境未验 |

> 编制依据：本仓库的只读 Nacos 客户端、合成用例与本机历史实验；企业部署尚未联调。
>
> 关联文档：[技能管理器设计](../design/plugins/forge-skills-manager.md)、[需求基线](../requirements/requirements-baseline.md)。

## 1. 连接

Host 连接 Nacos 3.2 AI Skill API，使用专用只读账号，不使用管理员账号，不映射 DSH 个人身份。服务根接受 HTTP 和 HTTPS，不设置 HTTP 开关；当前企业服务使用 HTTP，服务根示例为 `http://nacos.corp.example/nacos`。密码与令牌不进入 URL、客户端快照、日志或错误体。

| 配置 | 类型 | 默认 |
|---|---|---|
| `nacos.serverUrl` | string | 无；未配置时发现页显示未配置 |
| `nacos.namespaceId` | string | 开发默认 `public`；正式制包必须显式提供 |
| `nacos.username` | string | 无；正式制包必填，只读账号 |
| `nacos.password` | string | 无；正式制包必填，保留非空原值 |
| `nacos.usernameEnv` | string | `FORGE_NACOS_USERNAME`，Host 进程环境变量名 |
| `nacos.passwordEnv` | string | `FORGE_NACOS_PASSWORD`，Host 进程环境变量名 |
| `nacos.timeoutMs` | integer | 15000 |

### 1.1 正式制包输入

`make-private-bundle.mjs` 与 `release-delivery.mjs` 对装配 `heluo-skills-manager` 的企业公版要求下列四项配置；测试环境私版与正式环境私版采用同一判据。未装配技能管理器的企业包无需提供 Nacos 字段，回执不声明内嵌 Nacos 密码；向该类包提供 Nacos 字段时拒绝，不静默丢弃。中性企业公版的源码构建不要求部署值。

| 专用配置文件字段 | 写入运行字段 | 校验与默认 |
|---|---|---|
| `HELUO_NACOS_SERVER_URL` | `nacos.serverUrl` | 必填；HTTP/HTTPS 绝对 URL，不含 userinfo、query、fragment；不设置 HTTP 开关 |
| `HELUO_NACOS_NAMESPACE_ID` | `nacos.namespaceId` | 必填；1–128 位字母数字、点、下划线或连字符，首位为字母数字；不默认补 `public` |
| `HELUO_NACOS_USERNAME` | `nacos.username` | 必填；非空且非全空白的专用只读账号 |
| `HELUO_NACOS_PASSWORD` | `nacos.password` | 必填；非空且非全空白；带首尾空格时用引号保留原值 |
| `HELUO_NACOS_TIMEOUT_MS` | `nacos.timeoutMs` | 可选；100–120000 的整数，单位毫秒；未填时运行默认 15000 |

专用文件按 `KEY=VALUE` 数据解析，不接受 `export`、重复键、未知键及命令/展开语法；引号仅用于包裹值，不执行 shell 或转义求值。旧制包字段 `HELUO_NACOS_USERNAME_ENV`、`HELUO_NACOS_PASSWORD_ENV`、`HELUO_NACOS_ALLOW_INSECURE_HTTP` 不在白名单中，报 `CONFIG_UNKNOWN_KEY`。缺少四项必填值或校验失败报 `CONFIG_INVALID`，不回显原值。

正式制包从未跟踪、受 Git 忽略的专用配置读取上述字段，写入 bundle 内声明 `heluo-skills-manager` 的补丁层。代码及中性公版不包含部署值。员工不再注入环境变量；完整配置文件不进入交付物，预检和回执只列字段名，明确标记已内嵌 Nacos 密码。

私版元数据的 `config.embeddedSecrets` 仅列包内 Nacos 密码（`["nacos.password"]` 或 `[]`）；`config.clientSecretEmbedded` 单独声明是否采用现有 IAM 客户端密钥独立文件交付，`config.secretEmbedded` 是两者的合计布尔值。Nacos 密码不触发 IAM 绑定文件读取；两者同时交付时，安装器分别核验 Nacos 必填字段和 IAM 绑定文件。旧版仅以 `secretEmbedded: true` 声明的 IAM 交付继续要求有效绑定文件。IAM 客户端密钥不写入插件补丁或元数据，仍按其独立流程预置到目标凭据库。

Nacos 专项字段解析、完整性与运行文件匹配判据集中在 `scripts/lib/nacos-release.mjs`；两个制包入口及库调用共用此模块。预检在输出计划和请求摘要确认前检查公版中的 Nacos 运行文件与配套工具一致，仅允许 LF/CRLF 差异；缺失或不匹配报 `NACOS_RUNTIME_MISMATCH`，不输出已配置成功计划。正式写包前重复核验，不信任之前的预检状态。独立工具链附带 `packages/forge-skills-manager/docs/packaging.md`，不要求制包人员取得源码或修改公共 Skill。

### 1.2 开发配置与生效方式

开发联调使用完整企业组合包，在隔离 profile 的 `cordis.patch.yml` 修改 `nacos` 字段并重启 Host，无需重新编译或打包。旧开发环境可继续使用 `usernameEnv`、`passwordEnv`；只要显式提供了 `username` 或 `password` 任一字段，就必须提供完整账号密码，不回落环境变量。缺失、空白或类型不符时返回 `error.nacos.config`（503），不发送远端请求，也不复用缓存令牌。本地管理仍可使用。凭据变化后重新登录，令牌仅缓存于内存。插件不自行加载 `.env`，也不实现 IAM 换票。

正式包更新连接或账号密码时，修改专用配置并使用新的私版版本重新预检、确认、安装和重启，无需重编译源码。旧 profile 覆盖项须备份后移除，避免覆盖包内预置。员工不提供 Nacos 环境变量，安装器不读取或注入制包 `.env`；只有开发兼容路径可在未配置显式账号密码时读取运行环境。完整命令见[随包打包说明](../../packages/forge-skills-manager/docs/packaging.md)。

### 1.3 凭据与交付边界

项目负责人于 2026-11-24 确认 Nacos 账号密码随内部正式交付包预置、四项制包必填及移除 Nacos HTTP 开关，适用范围仅为此专用只读账号；这是当前用户明确指定的限定要求，与[高阶规范 P8](../engineering/dsh-plugin-conventions.md#38-p8-安全边界不因可禁用而放宽)及[公共打包 Skill](../../.agents/skills/heluo-forge-release-bundle/SKILL.md#不可让步的边界)的通用凭据边界存在差异；公共 Skill 及配套 SOP 保持原样，不将本项描述为公共规约已有的许可。该要求不扩展到 IAM client secret、个人 Key 或访问令牌。包内配置可被解包读取，不提供加密保密；HTTP 传输不提供 TLS 保护。凭据及含凭据的制品不提交源码仓库或公开发布；真实服务端只读权限及企业联调仍须实测。

## 2. 只读服务端交互

| 方法与路径 | 字段与结果 |
|---|---|
| `POST /v3/auth/user/login` | 表单 username/password；响应 accessToken、tokenTtl；Host 缓存令牌 |
| `GET /v3/admin/ai/skills/list` | namespaceId、skillName、search、pageNo、pageSize；浏览列表固定 orderBy=download_count；响应 code=0、data.pageItems、totalCount |
| `GET /v3/admin/ai/skills/version/download` | namespaceId、skillName、version；返回完整 ZIP |

读取携带 `Authorization: Bearer`；不接受页面指定任意 API 路径或凭据，不自动跳转。条目字段为 name、description、enable、labels.latest；缺少发布标签或已禁用的条目不提供安装。安装前用 accurate 查询复验选定版本仍为 latest。服务端 PUBLIC 可见性和读取权限必须由部署方实际配置，不由客户端改变 scope。

列表向浏览器提供条目的 `namespaceId` 与可选 `downloadCount`。列表、详情和安装复验中的命名空间均须与本次查询一致，服务端省略时使用查询命名空间；不向页面开放命名空间切换。下载次数仅接受非负安全整数，缺失、null 或异常值不展示，不补零。它是 Nacos 的资源下载统计，不表示安装人数或使用次数；当前详情读取也调用完整资源下载接口。

列表每页请求 20 条，Nacos 按下载次数降序后分页，插件保留服务端顺序，不在浏览器重排当前页。搜索与刷新使用相同排序。`totalCount` 包含客户端过滤的未发布或禁用项，只用于翻页，不作为可下载技能总数。Nacos 3.2.3 本机独立实例已验证 orderBy=download_count 的跨页降序；相同次数的次序由服务端决定，动态计数下分页不提供快照保证，企业部署仍须核验。

## 3. 本地边界与错误

浏览器只请求 `/api/forge-skills-manager` 下的 state、nacos/list、nacos/detail、nacos/install、nacos/install-status 及本地管理端点。安装选择包含 skillName/version 和可选已登记 workspace。下载目标仅 DSH 全局或已登记项目，不写其他 Agent 目录，不覆盖已有同名副本。

`nacos/list` 的每个条目及 `nacos/detail` 的结果包含 `installations` 数组，由 Host 安装管理器从持久记录与本地文件投影，不采用浏览器下载历史。身份沿用规范化服务根、命名空间、技能名称和版本的联合摘要；不同来源或版本、其他 Agent 的同名技能不视为该版本已下载。位置用可选 `workspace` 表示已登记项目的规范根路径，省略表示 DSH 全局。每个位置的 `state` 为 `downloaded`（已确认且完整资源摘要一致）、`modified`（已确认但本地资源已修改）、`pending`（安装意图尚未确认）或 `unavailable`（无法安全核验目标或资源）。无法读取持久记录时请求失败，不将未知状态报告为空数组。

无位置的旧记录不猜测归属；回收站中的记录和已确认但技能目录已移除的副本不展示已下载。回收恢复后重新核验，普通启停不改变下载状态。列表查询不额外下载 ZIP，详情沿用现有资源读取。投影查询与安装、回收事务共用安装管理器串行队列及既有本地恢复流程；它是当前文件与来源记录的展示，不代替严格只读的操作回执，也不证明发布者或人工替换目录的身份。

进入发现页、刷新、重新打开详情以及下载确认后重新读取投影。卡片展示下载状态及全局/项目范围；详情按所选目标提示。已下载或已修改的目标提供前往本地技能的入口并禁止重复下载；pending/unavailable 目标同样不开放下载，不显示成功。其他可用目标仍可下载，不提供自动覆盖或升级；市场版本变化后不把旧版本标为当前版本已下载，同名冲突仍由 Host 拒绝。

`POST /api/forge-skills-manager/nacos/install` 接受可选 `operationId`（36 位十六进制及连字符组成的请求标识，客户端生成 UUID）。同一标识及目标复用原请求结果，不重新下载或提交；同一标识不得用于不同目标。同目标的待确认请求阻止新安装。旧客户端省略标识时由 Host 生成，仅保留原安装行为。

`GET /api/forge-skills-manager/nacos/install-status?operationId=...` 使用同一已认证连接，只读取 Host 回执。成功响应仍为 `{ok:true,data:...}`，data 的 state 为 `pending`、`succeeded` 或 `rejected`；成功包含 result.name/root，确认拒绝包含 code/error。未见请求、Host 重启或已回收回执均返回 pending，不能推断失败或允许重发。Host 仅在提交完成后确认成功；安装记录未确认及未知异常保持 pending。运行时最多保留 256 个回执，空间不足先回收已结束请求，待确认请求不自动丢弃；持久安装意图与本地恢复仍由安装管理器拥有。

安装请求的传输失败、非 JSON 响应及取消均使客户端保持待确认，关闭详情与组件重挂载不清除此标记；核对结果只调用只读状态接口，无效回执保持待确认。安装直接成功时说明默认禁用；核对成功后刷新本地视图，以当前宿主持久状态展示启用情况；确认拒绝后才恢复下载按钮。完整页面重载不持久化客户端标记，Host 运行时仍拒绝同目标待确认的新写入；Host 重启后的历史回执不提供跨进程幂等保证。

已认证插件返回的明确拒绝错误体携带 `outcome: "rejected"`，客户端可直接恢复操作，无须等待尚未创建的回执。安装状态未确认错误携带 `outcome: "pending"`；未知 Host 错误及缺少此声明的传输结果不能推断为拒绝。

首次安装意图写入失败且资源尚未复制时，Host 重新只读核验持久记录；确认该来源和目标没有已落盘意图则返回 `error.repo.state` 和 `outcome: "rejected"`，释放请求，磁盘恢复后可用新操作标识重试。核验读取失败或已存在相关意图时仍返回 `error.repo.installState` 和 `outcome: "pending"`，保留记录且不放开重复提交；临时文件清理失败不代表意图未提交。

普通本地变更 POST 可携带 `x-dsh-skills-operation` UUID 请求头；标识绑定请求路径及请求体，同一标识不得用于不同操作。`GET /api/forge-skills-manager/operation-status?operationId=...` 返回 pending、succeeded（含原操作 result）或 rejected（含 code/error），使用与安装回执相同的认证边界。未知、已回收或 Host 重启后的操作标识保持 pending，不自动重发；该回执不提供跨进程幂等保证。明确拒绝才能解除提交锁，确认成功后读取当前宿主状态；刷新失败保留确认事实并提示视图未更新。未携带标识的既有调用保持兼容。

`trash-restore` 对带来源记录的技能保存恢复前的来源身份、位置及完整资源摘要，包含本地编辑。正常管理视图读取可执行既有本地恢复；随后操作回执只读核验原记录已确认、回收目录已移除、来源和目标有效且资源与恢复前摘要一致，满足后返回 succeeded 并解除提交锁。仅有完成标记或同名文件不足以确认，核验失败保持 pending；回执查询不执行恢复、不写盘、不重复移动资源。

企业库压缩包上限 10 MiB、最多 1000 条 ZIP 条目（含目录）、单文件 32 MiB、解压合计 64 MiB；路径长度最多 512 个 JavaScript 字符串代码单元、最多 64 层。拒绝路径穿越、控制字符、Windows 保留字符及设备名、末尾点或空格；路径按 Unicode NFC 规范化并忽略大小写判重，同一父目录的不同大小写或规范化拼写也拒绝，写入保留原始名称。不匹配的技能名称同样拒绝；保留子目录和二进制内容，不还原 POSIX 执行位、所有者或链接元数据，脚本须通过已安装解释器调用。以上是企业 ZIP 下载限制；浏览器本地上传的压缩包上限为 32 MiB，承载 Base64 资源的上传 HTTP 请求体上限另为 88 MiB，三者不可混用。`SKILL.md` 必须有效且名称、说明与所选技能一致；摘要只用于完整性及恢复判断，不证明发布者签名。

固定业务码以 `error.nacos.` 开头：unconfigured/config/auth/notFound/response/size/package/query/cancelled/timeout/unavailable。未知编程异常保持可辨识的 500，不伪装成网络不可达。列表未配置可返回 configured=false；其他失败不报告成功、不同步旧数据覆盖 Host。

已结束但结果待确认的运行时请求，可通过现有安装记录查询回执；只有记录已确认、目标有效且完整文件摘要一致时才能转为 succeeded。该查询不执行恢复、不修改磁盘、不重新下载。安装意图未确认或文件不匹配时继续 pending；正常本地恢复在管理视图读取前执行。核对成功只确认安装事实，不把历史默认禁用状态当作用户当前启用状态。

## 4. 兼容与验证边界

接口基于本仓库实现与本机 Nacos 3.2.3 历史实验；离线用例、本机真实宿主、企业实际部署分别验收。Nacos 升级须重新检查 API、PUBLIC 可见性与服务端拒写，不以客户端版本范围代替实测。
