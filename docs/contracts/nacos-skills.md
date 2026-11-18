# Nacos 公共技能库契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-001 |
| 文档名称 | Nacos 公共技能库契约 |
| 版本 | V0.4.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-18 |
| 门禁 | 本地合成与独立实例验证；企业环境未验 |

> 编制依据：来源插件的只读 Nacos 客户端、合成用例与本机历史实验；企业部署尚未联调。
>
> 关联文档：[技能管理器设计](../design/plugins/forge-skills-manager.md)、[需求基线](../requirements/requirements-baseline.md)。

## 1. 连接

Host 连接 Nacos 3.2 AI Skill API，使用专用只读账号，不使用管理员账号，不映射 DSH 个人身份。HTTPS 为默认要求；本机演示 HTTP 必须显式允许。服务根示例为 `https://nacos.corp.example/nacos`。密码与令牌不进入 URL、客户端快照、日志或错误体。

| 配置 | 类型 | 默认 |
|---|---|---|
| `nacos.serverUrl` | string | 无；未配置时发现页显示未配置 |
| `nacos.namespaceId` | string | `public`，由维护者配置 |
| `nacos.usernameEnv` | string | `FORGE_NACOS_USERNAME`，Host 进程环境变量名 |
| `nacos.passwordEnv` | string | `FORGE_NACOS_PASSWORD`，Host 进程环境变量名 |
| `nacos.timeoutMs` | integer | 15000 |
| `nacos.allowInsecureHttp` | boolean | false |

预览版从 Host 进程环境读取账号和密码，配置仅保存变量名，不接入宿主凭据库或 IAM 换票。变量名须匹配 `[A-Za-z_][A-Za-z0-9_]*`；变量缺失、为空或全空白时返回 `error.nacos.config`（503），不发送远端请求，也不复用已缓存的令牌。本地管理不依赖企业库凭据。非空凭据按原值发送，不裁剪密码中的首尾空白。

每次企业库操作重新读取当前进程环境；凭据变化使旧令牌失效并重新登录，令牌仅在内存缓存。外部终端或配置文件的修改不会自动更新运行中的 Host 环境，部署方须在重启 Host 前加载新值；插件不自行读取 `.env`。构建、打包和安装均不嵌入账号密码，补丁及页面不保存原值。

环境变量接入仅适用于预览版本，是[高阶规范 P8](../engineering/dsh-plugin-conventions.md#38-p8-安全边界不因可禁用而放宽)中受信凭据存储要求的临时例外，不代表正式版合规；秘密仍不得进入日志、视图、错误体、仓库或交付物。正式版凭据接入须另行核验。

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

`POST /api/forge-skills-manager/nacos/install` 接受可选 `operationId`（36 位十六进制及连字符组成的请求标识，客户端生成 UUID）。同一标识及目标复用原请求结果，不重新下载或提交；同一标识不得用于不同目标。同目标的待确认请求阻止新安装。旧客户端省略标识时由 Host 生成，仅保留原安装行为。

`GET /api/forge-skills-manager/nacos/install-status?operationId=...` 使用同一已认证连接，只读取 Host 回执。成功响应仍为 `{ok:true,data:...}`，data 的 state 为 `pending`、`succeeded` 或 `rejected`；成功包含 result.name/root，确认拒绝包含 code/error。未见请求、Host 重启或已回收回执均返回 pending，不能推断失败或允许重发。Host 仅在提交完成后确认成功；安装记录未确认及未知异常保持 pending。运行时最多保留 256 个回执，空间不足先回收已结束请求，待确认请求不自动丢弃；持久安装意图与本地恢复仍由安装管理器拥有。

安装请求的传输失败、非 JSON 响应及取消均使客户端保持待确认，关闭详情与组件重挂载不清除此标记；核对结果只调用只读状态接口，无效回执保持待确认。安装直接成功时说明默认禁用；核对成功后刷新本地视图，以当前宿主持久状态展示启用情况；确认拒绝后才恢复下载按钮。完整页面重载不持久化客户端标记，Host 运行时仍拒绝同目标待确认的新写入；Host 重启后的历史回执不提供跨进程幂等保证。

已认证插件返回的明确拒绝错误体携带 `outcome: "rejected"`，客户端可直接恢复操作，无须等待尚未创建的回执。安装状态未确认错误携带 `outcome: "pending"`；未知 Host 错误及缺少此声明的传输结果不能推断为拒绝。

普通本地变更 POST 可携带 `x-dsh-skills-operation` UUID 请求头；标识绑定请求路径及请求体，同一标识不得用于不同操作。`GET /api/forge-skills-manager/operation-status?operationId=...` 返回 pending、succeeded（含原操作 result）或 rejected（含 code/error），使用与安装回执相同的认证边界。未知、已回收或 Host 重启后的操作标识保持 pending，不自动重发；该回执不提供跨进程幂等保证。明确拒绝才能解除提交锁，确认成功后读取当前宿主状态；刷新失败保留确认事实并提示视图未更新。未携带标识的既有调用保持兼容。

压缩包上限 10 MiB、最多 1000 条、单文件 32 MiB、解压合计 64 MiB。拒绝路径穿越、Windows 保留名、大小写重复及不匹配的技能名称；保留子目录和二进制资源。`SKILL.md` 必须有效且名称、说明与所选技能一致；摘要只用于完整性及恢复判断，不证明发布者签名。

固定业务码以 `error.nacos.` 开头：unconfigured/config/auth/notFound/response/size/package/query/cancelled/timeout/unavailable。未知编程异常保持可辨识的 500，不伪装成网络不可达。列表未配置可返回 configured=false；其他失败不报告成功、不同步旧数据覆盖 Host。

已结束但结果待确认的运行时请求，可通过现有安装记录查询回执；只有记录已确认、目标有效且完整文件摘要一致时才能转为 succeeded。该查询不执行恢复、不修改磁盘、不重新下载。安装意图未确认或文件不匹配时继续 pending；正常本地恢复在管理视图读取前执行。核对成功只确认安装事实，不把历史默认禁用状态当作用户当前启用状态。

## 4. 兼容与验证边界

接口基于来源插件实现与本机 Nacos 3.2.3 历史实验；迁移后的离线用例、本机真实宿主、企业实际部署分别验收。Nacos 升级须重新检查 API、PUBLIC 可见性与服务端拒写，不以客户端版本范围代替实测。
