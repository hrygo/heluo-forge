# Nacos 公共技能库契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-001 |
| 文档名称 | Nacos 公共技能库契约 |
| 版本 | V0.1.2 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-17 |
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
| `nacos.usernameEnv` | string | `FORGE_NACOS_USERNAME` |
| `nacos.passwordEnv` | string | `FORGE_NACOS_PASSWORD` |
| `nacos.timeoutMs` | integer | 15000 |
| `nacos.allowInsecureHttp` | boolean | false |

## 2. 只读服务端交互

| 方法与路径 | 字段与结果 |
|---|---|
| `POST /v3/auth/user/login` | 表单 username/password；响应 accessToken、tokenTtl；Host 缓存令牌 |
| `GET /v3/admin/ai/skills/list` | namespaceId、skillName、search、pageNo、pageSize；浏览列表固定 orderBy=download_count；响应 code=0、data.pageItems、totalCount |
| `GET /v3/admin/ai/skills/version/download` | namespaceId、skillName、version；返回完整 ZIP |

读取携带 `Authorization: Bearer`；不接受页面指定任意 API 路径或凭据，不自动跳转。条目字段为 name、description、enable、labels.latest；缺少发布标签或已禁用的条目不提供安装。安装前用 accurate 查询复验选定版本仍为 latest。服务端 PUBLIC 可见性和读取权限必须由部署方实际配置，不由客户端改变 scope。

列表向浏览器提供条目的 `namespaceId` 与可选 `downloadCount`。命名空间须与本次查询一致，服务端省略时使用查询命名空间；不向页面开放命名空间切换。下载次数仅接受非负安全整数，缺失、null 或异常值不展示，不补零。它是 Nacos 的资源下载统计，不表示安装人数或使用次数；当前详情读取也调用完整资源下载接口。

列表每页请求 20 条，Nacos 按下载次数降序后分页，插件保留服务端顺序，不在浏览器重排当前页。搜索与刷新使用相同排序。`totalCount` 包含客户端过滤的未发布或禁用项，只用于翻页，不作为可下载技能总数。Nacos 3.2.3 本机独立实例已验证 orderBy=download_count 的跨页降序；相同次数的次序由服务端决定，动态计数下分页不提供快照保证，企业部署仍须核验。

## 3. 本地边界与错误

浏览器只请求 `/api/forge-skills-manager` 下的 state、nacos/list、nacos/detail、nacos/install 及本地管理端点。安装选择包含 skillName/version 和可选已登记 workspace。下载目标仅 DSH 全局或已登记项目，不写其他 Agent 目录，不覆盖已有同名副本。

压缩包上限 10 MiB、最多 1000 条、单文件 32 MiB、解压合计 64 MiB。拒绝路径穿越、Windows 保留名、大小写重复及不匹配的技能名称；保留子目录和二进制资源。`SKILL.md` 必须有效且名称、说明与所选技能一致；摘要只用于完整性及恢复判断，不证明发布者签名。

固定业务码以 `error.nacos.` 开头：unconfigured/config/auth/notFound/response/size/package/query/cancelled/timeout/unavailable。未知编程异常保持可辨识的 500，不伪装成网络不可达。列表未配置可返回 configured=false；其他失败不报告成功、不同步旧数据覆盖 Host。

## 4. 兼容与验证边界

接口基于来源插件实现与本机 Nacos 3.2.3 历史实验；迁移后的离线用例、本机真实宿主、企业实际部署分别验收。Nacos 升级须重新检查 API、PUBLIC 可见性与服务端拒写，不以客户端版本范围代替实测。
