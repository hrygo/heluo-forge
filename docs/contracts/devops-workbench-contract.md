# DOP 工作台数据、鉴权、工具与离线模拟契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-TOOLS-002 |
| 文档名称 | DOP 工作台数据、鉴权、工具与离线模拟契约 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | 内部 |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组 |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-28 |
| 门禁 | G1 接口事实与脱敏样本核验；G2 工具与隔离模拟冻结 |

> 编制依据：基于仓库现行 [需求与场景基线](../requirements/requirements-baseline.md)、[企业工程工具最小契约](engineering-tools.md)、[dop CLI 接口规格](dop-cli-spec.md)、[IAM 凭据访问说明](../../packages/forge-iam/docs/credential-access.md)，并结合 2026-11-26 内网DOP 前端源码分析、真实 HTTP 探针样本以及 2026-11-27 内网补充语料（P0-1~P0-5 外链真实路由、`odo_procalmation` 纯数组报文、`sprint/{sprintId}/issue/list` 真实路径与 `/odo/api/online/process/url` 单一换票接口）定版；三大进展板数字点击跳转的精准筛选列表页 URL 路由尚待内网补采（当前统一映射 `/dop/asd/dashboard`），RMP `/sso` 令牌同源性待内网联调确认。
>
> 关联文档：[需求基线](../requirements/requirements-baseline.md)、[总体架构](../architecture/platform-architecture.md)、[DOP 工作台详细设计](../design/plugins/forge-devops-workbench.md)、[企业 DevOps 插件设计](../design/plugins/forge-devops.md)、[工程工具契约](engineering-tools.md)、[dop CLI 规格](dop-cli-spec.md)、[IAM 凭据访问说明](../../packages/forge-iam/docs/credential-access.md)、[IAM 隔离开发契约](iam-client-auth-isolated.md)。

## 1. 结论与边界

本契约定义独立扩展包 `@heluo/forge-devops-workbench`（「DOP 工作台」）一期所需的真实 HTTP 接口路由、双轨 `Authorization` 鉴权协议、数据结构、已有 CLI / 可选 MCP 分层边界、标准化提示词模板以及外网进程外挡板规范。

1. **取数主通道与分域路由**：工作台所有看板与需求/RMP 数据均由 Host 后端直调企业 DOP 服务唯一基准地址（`apiBaseUrl`），按 Path 前缀区分后台域：
   - **DOP 域**：`/uam/api/**`、`/asd/api/**`、`/ppm/api/**`、`/bpm/api/**`、`/odo/api/**`、`/tmp/api/**`；
   - **RMP 域**：同一 DOP 服务入口下的反向代理路径 `/rdp/vpgatway/**`（无独立域名，不另配 Base URL）。
2. **认证方式与内网快速切换**：认证方式统一复用 `@heluo/forge-iam`（「企业账号（IAM）」），不单独暴露静态凭据模式。公版默认不内置内网域名（示例使用脱敏域名 `https://dop.corp.example`），内网切换按优先级支持三层：`本机连接配置热更新` > `企业包配置 (apiBaseUrl)` > `环境变量 HELUO_DOP_BASE_URL`（兼容复用 `FORGE_DEVOPS_DOP_ENDPOINT`）。
3. **工作台简化（取消分队切换）**：经实测核对，DOP 工作台各进展板视角完全由各自 Query 参数与 `myProfile` 驱动，原原型中的分队/小组列表（`/uam/api/team/list`、`/uam/api/group/list`）仅为冗余展开，不参与面板过滤。顶部工作台仅保留「待办[N]▾」与「⚙ 定制」，彻底取消分队下拉框、`squadId` 请求参数与相关状态字段。
4. **零内置 Mock 红线**：与 `@heluo/forge-iam` 一致，工作台插件源码（`packages/forge-devops-workbench/`）**零内置 Mock、零夹具文件、零 Mock 开关**；外网研发与测试通过进程外独立挡板 `scripts/probe/mock-dop-server.mjs` 提供 1:1 真实 HTTP 仿真。
5. **全流程定位与一期边界**：插件覆盖需求、项目、研发、测试与效能研发全流程；P0 开放顶部待办汇聚、三大进展板及「需求」页签（含需求/故事深读与提示词构造），「项目」「研发」「效能」「测试」四页签留待二期澄清。卡片快捷动作严格只生成标准化工程提示词交由用户二次确认后填入对话草稿箱或剪贴板，不自动调用消息发送，不直写上游平台。

## 2. 双轨鉴权与 HTTP Authorization 链路契约

内网实测确认 DOP 域与 RMP 域使用同一网关入口但执行**两套完全不同的鉴权协议与失效响应**，工作台 Host `src/shared/dop-client.mjs`（及各域 `api.mjs`）与 `src/shared/rmp-sso.mjs` 必须严格区分处理：

| 域 | 路径前缀 | 合法请求头与换票要求 | 无效/过期响应（实测） | Host 自动恢复策略 |
|---|---|---|---|---|
| **DOP 域** | `/uam\|asd\|ppm\|bpm\|odo\|tmp/api/**` | `Authorization: <token>` **裸格式（严禁加 `Bearer ` 前缀）**；不附加额外自定义网关头 | **HTTP 403**（JSON `{timestamp, status: 403, error: "Forbidden", message: "Access Denied", path}` 或纯文本 `Access Denied`） | 当 IAM 通道启用时静默刷新 Access Token 并至多重试 1 次；仍 403 归一为 `UPSTREAM_AUTH_DENIED` / `UNAUTHORIZED` 引导重登 |
| **RMP 域** | `/rdp/vpgatway/**` | IAM `AT-` 令牌不能直透；先调 `GET /rdp/vpgatway/vrmprovider/rms/api/sso?page=createRequirement&token=<SSO token>` 获取 302 `Set-Cookie: _tk`（约 12h 有效），再带 **`Authorization: Bearer <_tk>`** 调用业务接口 | **HTTP 401 空响应体**（非 JSON） | 进程内存按账号会话缓存 `_tk`（TTL 上限不超过 11.5h）；任一 RMP 接口返回 401 时立即丢弃 `_tk`、触发 `/sso` 重换并至多重试 1 次 |

令牌向 Host 端的获取通道仍按以下 4 级规范隔离管理，严禁将任何上游令牌或 `_tk` 透出给浏览器端 `client.js`：

| 优先级 | 通道 | 适用场景 | 令牌来源与生命周期 | 安全约束 |
|---|---|---|---|---|
| 1 | Host 进程内 IAM 服务注入 | DSH 本机/Web Host 插件后端唯一主路径 | `inject = ['iam']`；`ctx.iam.getSession()` 判态，发请求前调 `await ctx.iam.getAccessToken()` 按需刷新 | 令牌与 `_tk` 仅驻留 Host 进程内存，绝不落偏好库或传回前端 |
| 2 | IAM CLI / 本地桥接复用 | 本地排查脚本或命令行联调辅助 | 复用 `heluo-forge auth whoami --json` 与 `heluo-forge auth token`（经 `HELUO_FORGE_IAM_URL=http://127.0.0.1:<port>` 与 Host 通信） | 遵循退出码 `0` 正常 / `2` `NOT_SIGNED_IN` / `3` `REAUTH_REQUIRED` / `4` `UNAVAILABLE` / `64` `USAGE` |
| 3 | 同源 Web 会话态查询 | 浏览器半展示登录态、引导去 `@heluo/forge-iam` 重登 | 复用 `GET /api/forge-iam/session` 查非敏态；工作台同源端点接入宿主 `connection` 鉴权并强校验 `x-forge-workbench-request: 1` | 浏览器禁止拉取上游业务 Token |

待内网联调核验的鉴权确认项：`/rdp/vpgatway/vrmprovider/rms/api/sso` 所需的 `<SSO token>` 参数是否直接传入与 DOP/IAM 一致的访问令牌（或是否需单独读取网关换票参数）。

## 3. 真实工作台 HTTP API 路由与数据契约

以下接口清单与字段结构均来自内网真实前端与 HTTP 探针实测验证，供外网正式开发与 `scripts/probe/mock-dop-server.mjs` 挡板 1:1 对齐。

### 3.1 个人档案与个性化偏好（取消分队字段）

| 路由与方法 | 实测返回体与 Host 处理硬约束 | 个人定制持久化结构 |
|---|---|---|
| `GET /uam/api/user/myProfile` | 返回 14 个顶层键（含 `loginCode`、`name`、`dashboardId`、`simulating`、`firstOrg`、`secondOrg`、`roles`、`teams` 等）。实测内网全量响应高达约 **4.77 MB**（`teams` 数组占大头）。**Host 必须在内存中按字段白名单投影**（仅向前端返回 `loginCode`、`name`、`dashboardId`、`simulating` 与必要角色摘要）并做会话期短缓存，**严禁原样转发给浏览器**。`/uam/api/team/list` 与 `/uam/api/group/list` 本插件不调用 | `rolePreset`（`biz_mgr` \| `req_mgr` \| `dev_owner` \| `tech_lead` \| `custom`）、`visibleBoards`、`boardOrder`、`visibleDomains`、`domainOrder`；**不再保存任何 `activeSquadId` / 分队字段** |

### 3.2 顶部待办聚合（7 路并行请求）

DOP 平台无单一待办聚合接口，Host 总览域服务 `src/domains/overview/service.mjs` 并发调用以下 7 路接口（独立 `AbortController` 超时 + 局部失败降级）并按前端页签分流统计：

| 分类 | Method | Path | 参数与载体 | 核心返回字段 |
|---|---|---|---|---|
| 全局待办 | `GET` | `/asd/api/todo/list` | Query: `pageNum, pageSize` | `{ items[], pageNum, pageSize, totalItems, totalPages }` |
| 故事/任务待办 | `GET` | `/asd/api/issue/myIssue/list` | Query: `pageNum, pageSize, typeIds=main_story,assistance_story` | `{ items[{ id, code, summary, type, state, progressState, planOnlineDate, parentId, mainStoryId, assignee, manager, businessOwner, scheduleDelay, releaseDelay }], totalItems }` |
| 流程/评审会待办 | `GET` | `/odo/api/bizFlow/myTasks` | Query: `pageNum, pageSize` | `{ code, data: { pageNum, pageSize, total, workItems[] }, message, total }` |
| 阻塞缺陷 | `POST` | `/tmp/api/app/defect/myDefect/query` | JSON Body: `{ pageNum, pageSize }` | `{ items[], pageNum, pageSize, totalItems, totalPages }` |
| 公告/发布窗口 | `GET` | `/odo/api/procalmation/list` | Query: `page, size` | `{ code, data: [{ id, procalmationTitle, startTime, endTime, createTime, releaseFlag, publishStatus }], total, message }`（实测 `data` 为纯数组，总条数在顶层 `total`） |
| ITSM 待办与换票 | `GET` | `/odo/api/online/process/list` & `/odo/api/online/process/url` | 列表：`page, size, type`；换票：`wjbiid` | 列表：`{ code, data: { totalPage, pageSize, totalRecord, pageNum, results[{ BUSINESS_ID, WJBIID, title, typeName, ASSIGN_TIME, STATUS, CREATETIME, USERTASK_NAME }] } }`；换票：`{ code: 0, data: "<ticketUrl>" }` |
| 需求平台待办 | `POST` | `/rdp/vpgatway/vrmprovider/rms/api/listAllTodoTask` | JSON Body: `{ userName, currentPage, numPerPage }` | `{ timestamp, infocode, msg, data: { numPerPage, totalRows, totalPages, currentPage, resultList[] }, status, requestTraceId }` |

### 3.3 三大进展板真实接口与字段表

| 看板与视角参数 | Method & Path | 实测返回核心字段（原样映射，禁止改名猜词） |
|---|---|---|
| **需求进展 KPI**<br>（`type=manager \| business`） | `GET /asd/api/dashboard/requirement/progress` | `total`, `unAnalyzed`, `notAccepted`, `notCompleteAcceptance`, `averageAcceptDays`, `averageAnalyzeDays`, `userId`（`type=business` 时两个 `average*Days` 返回 `null`，UI 须渲染为 `--`） |
| **需求进展 U 型 5 阶段**<br>（`type=manager \| business`） | `GET /asd/api/dashboard/requirement/inProgress` | `pending`, `reviewed`, `inOperation`, `accepted`, `released`, `progressTotal` |
| **实施进展 5 列排期**<br>（`personnel=responsible \| participate \| creator`） | `GET /asd/api/release/progress` | `approvingNum`, `changingNum`, `waitReleasingNum`, `releasingNum`, `delayedNum` |
| **实施进展故事 4 态健康条**<br>（`personnel=responsible \| participate \| creator`） | `GET /asd/api/story/progress` | `normalNum`, `pauseNum`, `releaseDelayNum`, `scheduleDelayNum` |
| **项目进展 9 里程碑 + 延期**<br>（`qType=responsible \| participant`） | `GET /ppm/api/project/progress` | `newCreateNum`, `projectApplicationNum`, `projectPlanningNum`, `requirementAnalysisNum`, `designAndDevelopmentNum`, `systemTestingNum`, `regressionTestingNum`, `acceptanceTestingNum`, `releaseNum`, `delayNum` |

### 3.4 「需求」页签与 RMP 文档接口表

| 用途 | Method & Path | 参数与请求体约定 | 返回结构与字段事实 |
|---|---|---|---|
| 我的需求列表 | `GET /asd/api/commonDashboard/requirement/query` | Query: `search`, `pageNum`, `pageSize` 及 4 个互斥布尔视角（**恰一个为 `true`**：`managedByMe` / `acceptanceByMe` / `appliedByMe` / `participantHasMe`） | `items[{ requirementId, requirementNo, requirementName, projectCode, projectId, projectName, mode, stage, state, errorState, managerUser, businessOwnerUser, archManagerUser, projectManager }]` |
| 单条需求详情 | `GET /asd/api/requirement/one/<id>` | Path 参数 `id` | 77 个字段，含双负责人 `manager`（需求经理）与 `businessOwner`（业务负责人）、澄清阶段 `stage`+`state`、`backGround`、`description`、`reqBenefit`、`reqDocs[]` |
| 单条用户故事详情 | `GET /asd/api/story/one/<id>` | Path 参数 `id` | 64 个字段：`requirement{ no, name, id }` 与 `systemChanges[]` 可直接用于提示词与跳转；实测 `priority`、`storyPoint` 恒为 `null` 且顶层无 `sprint` 字段 |
| 故事迭代与估算补充（可选增强） | `GET /asd/api/sprint/<sprintId>/issue/list` | Path 参数 `sprintId`（旧无参 `/asd/api/sprint/issue/list?storyId=` 内网实测 HTTP 404） | 仅在故事详情存在 `sprintId` 且生成排期类提示词时按需调用（实测返回 63 字段故事条目含 `storyPoints`/`sprint`） |
| 故事→RMP 条目映射 | `GET /asd/api/story/reqItem/query` | Query: `storyId, pageNum, pageSize` | `{ items[], pageNum, pageSize, totalItems, totalPages }`（无关联时 `totalItems=0` 为合法空态） |
| RMP 文档检索（全版本 / 最新版 / 按需求号） | `POST /rdp/vpgatway/vrmprovider/rms/api/listAllVerDoc` / `listAllNewVerDoc` / `listRelDocByReqCode` | JSON Body: `{ reqCode, userIds, quickSearch, currentPage, numPerPage }` 或 `{ reqCode }` | `{ infocode: "VP000000", data: { resultList[{ code, docver, iid, docid, docname, reqcode, docstatus, username, deptname }], totalRows }, status: 200 }` |
| RMP 单篇大纲树 & 条目列表 | `POST /rdp/vpgatway/vrmprovider/vrm/docArt/getOutlineTree` / `selectArtInfo` | **`application/x-www-form-urlencoded` 表单参数（非 JSON）**：`selectType=1`, `docId`, `associatedSystem`, `currentPage`, `numPerPage` | `data[{ scode, doc_name, parent_id, sname, idoc_id, disp_indx, doc_outline_id, sys_name, sbus_version }]` |
| RMP 条目正文读取 | `GET /rdp/vpgatway/vrmprovider/vrm/docArt/getTabContent` | Query: `entityid=56&iid=<iid>` | `data{ sname, entityid, html }`；无正文时返回 `<p class="nodata"></p>`，前端与提示词构造器须识别空正文占位 |

### 3.5 统一错误与降级信封

当工作台局部或全局 HTTP API 查询失败时，后端返回与 [企业工程工具最小契约](engineering-tools.md) 一致的可判别错误信封，严禁伪造空列表掩盖失败：

```json
{
  "ok": false,
  "endpointKind": "enterprise",
  "error": {
    "code": "UPSTREAM_AUTH_DENIED",
    "message": "DOP认证凭据已失效（HTTP 403），请前往企业账号重新登录后重试",
    "retryable": false,
    "upstream": "dop-api",
    "httpStatus": 403,
    "requestId": "req_000001_workbench"
  },
  "partialData": null
}
```

标准错误码枚举：`UNAUTHORIZED`（无登录态 / CLI 退出码 `2` 或 `3`）、`UPSTREAM_AUTH_DENIED`（DOP HTTP `403 Access Denied` 且刷新重试仍失败）、`RMP_SSO_EXCHANGE_FAILED`（`/rdp/vpgatway/.../sso` 换票失败或续换后仍 `401`）、`FORBIDDEN`（有身份但业务越权）、`UNAVAILABLE`（`502`/`503`/CLI 退出码 `4`）、`RATE_LIMITED`（`429` 透传 `retryAfterSec`）、`UPSTREAM_SCHEMA_DRIFT`（响应非预期 JSON，例如被网关重定向 HTML 拦截页）、`CONFLICT_BUSY`（串行刷新去抖丢弃）。

### 3.6 页面外链跳转路由模板（对齐内网实测 P0-1~P0-5，集中配置）

点击工作台需求编号、用户故事编号、RMP 文档、待办明细以及三大进展板统计数字/阶段节点时，一律通过系统默认浏览器或外部新标签页（`window.open(url, '_blank', 'noopener,noreferrer')`）直跳外部页面，不占用 DSH 右侧多页签栏。所有路由集中由 `src/portal-links.mjs` 基于当前生效的 DOP 服务地址 `apiBaseUrl` 构造（公版示例占位为 `https://dop.corp.example`，支持环境变量与可视化热更新）：

| 目标实体 / 入口 | 构造器方法 | 内网实测外链路由模板 | 安全校验与约束 |
|---|---|---|---|
| 需求详情页 | `requirementUrl(id)` | `${apiBaseUrl}/dop/asd/requirement?id=<encodeURIComponent(id)>` | 由 `sanitizePortalUrl` 强校验仅允许 `http:`/`https:` 协议；严禁包含 userinfo，严禁向 URL 附加任何 Token 或 `_tk` |
| 用户故事详情页 | `storyUrl(id)` | `${apiBaseUrl}/dop/asd/storyDetail?id=<encodeURIComponent(id)>` | 优先传故事 UUID（`id`），外网由 `mock-dop-server.mjs` 提供脱敏 HTML 详情示意页 |
| RMP 文档正文页 | `rmpDocUrl(docId)` | `${apiBaseUrl}/rdp/vpgatway/vrmprovider/rms/api/viewDocContent?docId=<encodeURIComponent(docId)>` | 仅传 `docId`，不拼接 `_tk`/`token`；网关按需 302 跳转 `/rdp/#/sso_login` |
| ITSM 工单详情页 | `itsmUrl(wjbiid)` | `${apiBaseUrl}/backstage/workflow/serviceApply/applyCopyView?wjbiid=<encodeURIComponent(wjbiid)>` | 优先调 `GET /api/forge-devops-workbench/itsm/open-url` 换取单一实例免密链接，不可用时安全回退本模板 |
| 流程审批任务页 | `bizFlowUrl(key, taskId)` | `${apiBaseUrl}/dop/asd/<definitionKey>?taskId=<taskId>` | 缺参数时回退 `${apiBaseUrl}/dop/asd/dashboard` |
| 全局待办中心 & 三大进展板指标 | `todoCenterUrl()` / `boardLink(boardKey, metricKey, view)` | `${apiBaseUrl}/dop/asd/dashboard` | 三大进展板统计数字与 U 型阶段节点当前统一跳转DOP全局中心，预留 `boardLink` 参数待内网补采精准筛选列表路由后单点切换 |

## 4. 一期接口、CLI 与工具复用边界

| 类别 | 通道 / 工具标识 | 载体与来源 | 一期权限 | 用途说明 |
|---|---|---|---|---|
| 工作台 UI 聚数主通道 | DOP 19 条 HTTP API（见 §3） | Host `src/shared/dop-client.mjs` + `src/domains/{overview,requirement}/api.mjs` + `src/shared/rmp-sso.mjs` | 一期 P0 只读 | 支撑 7 路待办、三大进展板、「我的需求」「我的用户故事」「RMP 文档检索/大纲/正文」全部面板与提示词上下文 |
| 工作台只读模型工具 | `forge_workbench_requirement_read`、`forge_workbench_story_read`、`forge_workbench_rmp_doc_search`、`forge_workbench_rmp_outline_read`、`forge_workbench_rmp_section_read`、`forge_workbench_todo_summary` | `@heluo/forge-devops-workbench` Host `src/tools.mjs`（经 `ctx.tools.register`） | 一期 P0 只读 | 供主对话大模型在用户确认发送提示词后按需深读需求/故事详情、RMP 文档大纲与章节正文（识别 `<p class="nodata"></p>`）及 7 路待办统计；失败返回脱敏 JSON 错误信封，零写上游接口 |
| 对话框交互式澄清选单 | `ask_user_question` | DSH 内置 `@deepseek-ai/dsh-tool-ask-user` 与 `@deepseek-ai/dsh-client-ui-user-questions` | 对话交互协同 | 工作台提示词显式要求模型对缺失业务口径、阈值与拆分粒度优先发起原生单选/多选推荐卡片，待用户点选提交后再继续产出澄清结论或拆解方案 |
| 已有 CLI 复用 | `forge_devops_query`、`forge_devops_change_context` | `@heluo/forge-devops`（`dop`） | 只读启用 | 联合读取故事关联 `systemChanges` 的变更详情、子系统与独立验收要求 |
| 已有 CLI 复用 | `forge_devops_artifact_write` | `@heluo/forge-devops`（`dop`） | 本地产物 | 将 AI 生成的需求澄清纪要或方案草稿写入本机隔离工作区产物目录 |
| 已有 CLI 复用 | `forge_devops_change_update` | `@heluo/forge-devops`（`dop`） | 默认拒绝 | 需经 `change.clarification.write` 策略与用户确认，一期不从工作台触发 |
| 已有 CLI 复用 | `forge_gitee_*`（只读查询与评审判定） | `@heluo/forge-gitee`（`gh`） | 只读启用 | 核查待评审 PR/MR 与代码库上下文；写与 push 保持默认拒绝 |
| 已有鉴权复用 | `heluo-forge auth whoami` / `token` | `@heluo/forge-iam` CLI 与 `ctx.iam` | 只读/刷新 | 为工作台 API 适配器与调试脚本提供统一会话判态与 Access Token |
| 对话 Agent 可选扩展 | DOP MCP Server | DSH 原生 `dsh-mcp-client` | 可选独立配置 | 供用户在将提示词填入对话并发送后，主对话大模型按需补充调用，不作为工作台看板轮询后端 |
| 待定 / 二期候选 | 新建需求/流转写 API 及 `project` / `dev` / `eff` / `test` 四页签接口 | DOP API / 各领域平台 | 一期禁用 | 涉及写回平台与二期四个未定页签，需经需求澄清与策略 G2 审批后单列契约 |

## 5. 一期提示词模板契约

工作台右侧 UI 触发的标准化提示词生成动作必须携带显式来源标头、结构化上下文、人机确认边界及澄清交互指引（引导模型按需调用 `forge_workbench_*` 只读工具并通过内置 `ask_user_question` 发起带推荐项的选单澄清，工作台绝不自动发送）：

| 场景键 | 触发入口 | 注入上下文来源 | 输出上限与裁剪规则 | 送入对话行为 |
|---|---|---|---|---|
| `req.create.one_sentence` | 顶部快捷动作「+ 一句话新建需求」 | 用户一句话输入、`user.displayName`（只读归属）、规范模板 | 输入不超过 2,000 字符；模板指令与输出结构约束固定在 4,000 字符内 | 确认后填入对话草稿箱或剪贴板，不自动发送 |
| `req.clarify.from_doc` | 顶部快捷动作「已有文档澄清」 | RMP 文档大纲（`getOutlineTree`）+ 选中条目正文（`getTabContent`，过滤 `<p class="nodata"></p>`）或本地上传文件摘录 | 文档注入正文默认上限 16 KiB，超限时按大纲节点分段保留摘要并标注截断 | 展示将带出的文档标题、版本与字节数供用户确认 |
| `req.card.clarify_and_split` | 「我的需求」卡片操作 | `/asd/api/requirement/one/<id>`（77 字段中的核心描述、双负责人与 `reqDocs`） | 仅提取核心业务背景与附件目录，不塞入无关系统/审批冗余字段 | 提示词携带 `reqNo`，引导 Agent 按需深挖 |
| `story.card.design_and_prep` | 「我的用户故事」卡片操作 | `/asd/api/story/one/<id>`（`requirement` + `systemChanges` + `storyAC`）+ 可选 `/asd/api/sprint/issue/list` 与 `forge_devops_change_context` | 单条故事完整字段与验收准则，附加 `systemChanges` 变更号便于串联查询 | 用户确认后填入草稿箱，支持一键切换/复制到当前对话 |

## 6. 外网独立挡板与内网零 Mock 硬约束

遵循与 `@heluo/forge-iam` 一致的“插件本体零内置 Mock + 进程外独立 HTTP 挡板”架构，从物理与工程双重维度保证内网环境绝不可能使用假数据：

1. **插件代码与配置红线**：
   - `packages/forge-devops-workbench/` 源码中禁止存在 `mock-provider`、测试 fixture JSON 文件、`authMode: 'mock'`、`credentialRef` 或 `allowMock` 开关。
   - 公版默认不内置真实内网域名（UI 示例占位 `https://dop.corp.example`）；内网可通过「本机连接配置（`apiBaseUrl` 热更新持久化）」>「企业私版包配置」>「环境变量 `HELUO_DOP_BASE_URL` / `FORGE_DEVOPS_DOP_ENDPOINT`」三层快速切换（持久化文件仅保存 `apiBaseUrl` 与 `requestTimeoutMs`）；若均未配置且未设置环境变量则按 Fail-Closed 报错引导，不回退、不伪造空/假看板数据。
   - 若配置的 `apiBaseUrl` 主机为 `127.0.0.1` 或 `localhost`，UI 仅在顶部渲染只读提示「当前连接本地联调端点」，用以防止本地调试与内网生产混淆，不改变真实请求行为。
2. **外网进程外独立挡板（`scripts/probe/mock-dop-server.mjs`）**：
   - 位于仓库 `scripts/probe/` 目录下（打包审计规则 [scripts/lib/bundle-rules.mjs](../../scripts/lib/bundle-rules.mjs) 禁止测试与脚本文件进入发布 tarball），完全独立于插件包运行。
   - 仅使用 Node.js 内置模块实现，强制监听 `127.0.0.1` 本地回环地址，读取 [fixtures/dop-workbench](../../scripts/probe/fixtures/dop-workbench/manifest.json) 二次脱敏夹具，1:1 仿真全部 DOP 裸头+403、RMP `/sso` 换 `_tk`+Bearer+401、form-urlencoded 强校验及 `x-mock-scenario` / `x-mock-fault` 可控故障注入。
   - 外网可与 `scripts/probe/mock-iam-gateway.mjs` 联合启动完成从企业 IAM 登录到工作台看板及提示词生成的完整端到端闭环；进入内网发布时通过 [private-bundle.mjs](../../scripts/lib/private-bundle.mjs) 注入真实企业 `apiBaseUrl`，即可直接联调上线。

## 7. 夹具脱敏审计规则

纳入仓库 `scripts/probe/fixtures/dop-workbench/` 的所有样本必须满足二次脱敏审计底线，并纳入自动化单元测试守卫：

1. **网络与服务标识**：所有域名与内网 IP 剔除或改为 `corp.example` / `dop.example` / `rmp.example` / `127.0.0.1`。
2. **人员、电话与组织脱敏**：所有工号（`000001`）、人员中文名（`示例用户N`，含 ITSM 工单 `ASSIGN_NAME`/`CREATOR`/`applicantName`/`CURRENT_ACCEPTANCEMAN_NAME`）、部门全称与部门编码（`ORG-MOCK-NNN` / `示例一级部门` / `示例二级部门`）、手机号（采用 `000-0000-0001` 等非 11 位真实号段占位）与邮箱（采用 `user01[at]corp.example` 或 `null`，严禁含标准邮箱地址格式）均须彻底泛化，禁止保留具体单位、分支机构或个人隐私。
3. **文件体积裁薄与代表性**：例如 `/uam/api/user/myProfile` 实测响应达 4.77 MB，入库测试夹具必须裁剪 `teams`/`roles` 数组至 1–2 条代表项（控制在 10 KiB 以内），不得触及仓库单文件体积限制。
4. **字段契约零失真**：所有 JSON 顶层键名、数据类型、合法空态（如 `story_one` 的 `sprint: null`、`requirement_progress_business` 的 `averageAcceptDays: null`、`rmp_getTabContent` 的 `<p class="nodata"></p>`）与枚举结构原样保留；`odo_procalmation.json`（纯数组 `data` + `total`）、`sprint_issue_list.json`（63 字段实测样本）与 `odo_itsm_process_url.json` 已由 2026-11-27 补充语料完成对齐并彻底二次脱敏（清除内网残留 IP/域名/真实姓名）。
