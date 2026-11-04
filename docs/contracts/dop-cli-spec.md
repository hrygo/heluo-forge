# dop CLI 接口规格（1.0.4）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-CLI-001 |
| 文档名称 | dop CLI 接口规格（1.0.4） |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-04 |
| 门禁 | G1 接口事实 |

> 编制依据：2026-11-03 对 dop-cli 1.0.4（Windows）的 `--help`、`--debug` 与输出样例整理；**本文件为脱敏版**——内网地址、账号、真实业务编号与仓库路径已替换为占位，原始捕获不入库；本轮未重新实机复核，标“推断”的条目仍为推断。
>
> 关联文档：[工程工具契约](engineering-tools.md)、[DevOps 接入详细设计](../design/plugins/forge-devops.md)、[包 README](../../packages/forge-devops/README.md)。

> 用途：作为 dop 接口事实的核对基准，供适配器、测试与 mock 实现逐条对照。
> 采集环境：Windows，dop-cli **1.0.4**（Go + cobra 编译的 `dop.exe`，经 npm 包 `@cli-tools/dop` 分发），
> 所有输出样例均为对真实二进制的实测捕获（2026-11-03，脱敏后入库），API 端点来自 `--debug` 实测。

---

## 1. 总览

- `dop` 是一个 DevOps 命令行工具，管理**系统变更（system change）**和**用户故事（user story）**，并提供 API Token 认证管理。
- 版本输出（`dop -v` 与 `dop --version` 相同）：
  ```
  dop version dop-cli 1.0.4
  ```
- 默认（且唯一生效的）API 端点：`http://dop.example`
- 命令树（**只有这些命令，多一个少一个都不行**）：

```
dop
├── auth
│   ├── login     (flags: -t, --token string)
│   ├── logout
│   └── status
├── change
│   ├── done <code>
│   ├── list      (flags: --page, --page-size, --search, --state, --team)
│   └── view <code>
├── story
│   ├── list      (flags: --acceptance-by-me, --assigned-to-me, --created-by-me, --managed-by-me, --page, --page-size, --search, --sort-desc)
│   └── view <code>
└── help <任意命令路径>
```

- 各层 `--help` 的逐字输出见 §3。
- `dop help` / `dop <组命令>`（无子命令）→ stdout 打印组帮助，exit 0。
- `dop`（无参数）→ stdout 打印根帮助，exit 0。
- 未知命令 → stderr `Error: unknown command "X" for "dop"` + `Run 'dop --help' for usage.`，exit 1。
- **没有** `completion` 子命令（`dop completion` → 未知命令错误）。
- **没有** `dop config`、`dop change create`、`dop change start`、`dop story create`（npm 包 README 是过时文档，描述了这些不存在的命令——mock 必须忽略 README，以本文档为准）。

---

## 2. 全局约定

### 2.1 全局 flags（每个命令都接受）

| Flag | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--api-endpoint` | string | `http://dop.example` | "API endpoint URL (overrides config)"。**注意：实测该 flag 在 1.0.4 中被解析但不影响实际请求**（设成别的地址，`--debug` 显示请求仍发往默认端点）。mock 应原样接受该参数、在 help 中显示，可选择不生效。 |
| `--debug` | bool | false | 在 stdout 打印 `[DEBUG]` 前缀的请求/响应细节（格式见 §2.5） |
| `--json` | bool | false | 强制输出为合法 JSON（覆盖人类可读表格/详情视图） |
| `-h, --help` | bool | - | 打印帮助，exit 0 |
| `-v, --version` | bool | - | 仅根命令有；打印 `dop version dop-cli 1.0.4`，exit 0 |

### 2.2 输出流约定

| 内容 | 流 |
|---|---|
| 帮助文本、`--debug` 行、正常结果（表格/JSON/详情） | **stdout** |
| 运行时错误 `Error: ...`、错误后的 Usage 块 | **stderr** |
| `dop auth status` 的 "Verifying token..." 等 | stdout |

### 2.3 退出码

| 情形 | exit |
|---|---|
| 成功（含下文"未找到但按空结果处理"的情形） | 0 |
| 未知命令、缺少必填 flag、API 返回错误体等硬错误 | 1 |

### 2.4 认证头

所有 `/asd/api/*`、`/uam/api/*` 请求携带：
```
Authorization: <token 原文>
Content-Type: application/json
Accept: application/json
```
`--debug` 打印时 Authorization 被打码为 `perm****`（前 4 字符 + `****`）。

未认证（无凭据且无 `DEVOPS_API_KEY` 环境变量）时的提示文本（二进制内实测字符串）：
```
Not authenticated.
run `dop auth login` to authenticate, or set environment variable DEVOPS_API_KEY
```

---

## 3. 各级 `--help` 逐字输出

### 3.1 根（`dop --help` / `dop` 无参数）

```
DevOps CLI is a command-line tool for managing system changes and user stories,
providing efficient operations for development and deployment workflows.

Usage:
  dop [command]

Available Commands:
  auth        Authentication commands
  change      Manage system changes
  help        Help about any command
  story       Manage user stories

Flags:
      --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
      --debug                 Enable debug mode: print detailed request and response info.
  -h, --help                  help for dop
      --json                  Force all output to be valid JSON.
  -v, --version               version for dop

Use "dop [command] --help" for more information about a command.
```

### 3.2 `dop auth --help`

```
Authentication commands

Usage:
  dop auth [command]

Available Commands:
  login       Authenticate with a DevOps API token.
  logout      Log out from DevOps.
  status      View authentication status.

Flags:
  -h, --help   help for auth

Global Flags:
      --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
      --debug                 Enable debug mode: print detailed request and response info.
      --json                  Force all output to be valid JSON.

Use "dop auth [command] --help" for more information about a command.
```

### 3.3 `dop change --help`

```
Change CLI provides operations for managing system changes, including create, list, get, update, and delete.

Usage:
  dop change [command]

Available Commands:
  done        Complete development for a system change
  list        List system changes
  view        View system change details

Flags:
  -h, --help   help for change

Global Flags:
      --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
      --debug                 Enable debug mode: print detailed request and response info.
      --json                  Force all output to be valid JSON.

Use "dop change [command] --help" for more information about a command.
```

### 3.4 `dop story --help`

```
Story CLI provides operations for managing user stories, including create, list, get, update, and delete.

Usage:
  dop story [command]

Available Commands:
  list        List user stories
  view        View user story details

Flags:
  -h, --help   help for story

Global Flags:
      --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
      --debug                 Enable debug mode: print detailed request and response info.
      --json                  Force all output to be valid JSON.

Use "dop story [command] --help" for more information about a command.
```

### 3.5 叶子命令 `--help`

`dop auth login --help`：
```
Authenticate with a DevOps API token.

Usage:
  dop auth login [flags]

Flags:
  -h, --help           help for login
  -t, --token string   DevOps API token.

Global Flags:
      --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
      --debug                 Enable debug mode: print detailed request and response info.
      --json                  Force all output to be valid JSON.
```

`dop auth logout --help` / `dop auth status --help`：同上骨架，无 `--token`，首行为 `Log out from DevOps.` / `View authentication status.`，Usage 分别为 `dop auth logout [flags]` / `dop auth status [flags]`。

`dop change done --help`：
```
Complete development for a specific system change by its code.

Usage:
  dop change done <code> [flags]

Flags:
  -h, --help   help for done

Global Flags: ...（同上）
```

`dop change list --help`：
```
List all system changes with optional filtering.

Usage:
  dop change list [flags]

Flags:
  -h, --help            help for list
      --page int        Page number (default: 1) (default 1)
      --page-size int   Items per page (default: 20) (default 20)
      --search string   Search keyword
      --state string    Filter by state ID
      --team string     Filter by team ID

Global Flags: ...
```

`dop change view --help`：
```
View detailed information about a specific system change by its code.

Usage:
  dop change view <code> [flags]

Flags:
  -h, --help   help for view

Global Flags: ...
```

`dop story list --help`：
```
List user stories (main stories and assistance stories) with optional filtering.

Usage:
  dop story list [flags]

Flags:
      --acceptance-by-me   Show stories where I am acceptor
      --assigned-to-me     Show stories assigned to me
      --created-by-me      Show stories created by me
  -h, --help               help for list
      --managed-by-me      Show stories managed by me
      --page int           Page number (default: 1) (default 1)
      --page-size int      Items per page (default: 20) (default 20)
      --search string      Search keyword
      --sort-desc          Sort in descending order

Global Flags: ...
```

`dop story view --help`：
```
View detailed information about a specific user story by its code.

Usage:
  dop story view <code> [flags]

Flags:
  -h, --help   help for view

Global Flags: ...
```

---

## 4. 命令逐条行为规格

### 4.1 `dop auth login [-t TOKEN]`

- `--token/-t` 为必填 string flag（cobra `MarkFlagRequired`）。
- 缺 flag（`dop auth login`，无 tty 交互）：
  ```
  [stderr] Error: required flag(s) "token" not set
  [stderr] Usage:
  [stderr]   dop auth login [flags]
  [stderr]
  [stderr] Flags:
  [stderr]   -h, --help           help for login
  [stderr]   -t, --token string   DevOps API token.
  [stderr]
  [stderr] Global Flags:
  [stderr]       --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
  [stderr]       --debug                 Enable debug mode: print detailed request and response info.
  [stderr]       --json                  Force all output to be valid JSON.
  ```
  exit 1。
- 空 token（`dop auth login -t ""`）：stderr `Error: token is required` + 同款 Usage 块，exit 1。
- 正常流程（成功/失败的逐字文本未做破坏性实测，以下字符串来自二进制内实测提取，mock 可直接采用）：
  - 校验中提示：`Verifying token...`
  - 成功：`Login successful!` 与 `Token saved to system credential manager`
  - 失败：`token verification failed` / `Please check your token and try again.` /
    `Your token is invalid or has expired. Please run `iam auth login` or `dop auth login` again.`
- 成功后凭据保存位置见 §6。

### 4.2 `dop auth logout`

删除已存凭据。相关错误字符串：`failed to %s credential`（save/delete/get 三处复用）。成功输出未在实测中捕获（避免破坏真实会话），mock 建议打印删除确认即可。

### 4.3 `dop auth status`

实测输出（stdout，exit 0）：
```
Verifying token...
Logged in to DevOps as 000001
  Name:  示例用户
  Token: ab12...cd34
  Stored in system credential manager
```
- `as <loginCode>`、`Name:` 值来自 `GET /uam/api/user/myProfile` 的返回。
- Token 打码规则：前 4 字符 + `...` + 后 4 字符（`ab12...cd34`）。
- 未认证时输出 `Not authenticated.`（+ §2.4 的 hint 行）。

### 4.4 `dop change list`

参数 → 查询映射：`--page`→`pageNum`、`--page-size`→`pageSize`、`--search`→`search`、`--state`→`stateId`、`--team`→`teamId`；固定追加 `typeIds=system_change`。
请求：`GET /asd/api/issue/myIssue/list?pageNum=1&pageSize=2&typeIds=system_change[&search=..&stateId=..&teamId=..]`

**人类可读输出（stdout）**，实测样例：
```
编号         概要                  变更类型       状态         归属分队       创建时间
---------  ------------------  ---------  ---------  ---------  ---------
ARD000001  示例变更          系统变更       开发中        示例研发分队     2026-09-01 09:20:11
HLR000001  在线debug 类增...       系统变更       新建         示例平台      2022-12-30 18:13:42
第 1 页，共 6 页（总计 12 条）
```
渲染规则（由样例归纳）：
- 列：`编号 | 概要 | 变更类型 | 状态 | 归属分队 | 创建时间`，列间 2 空格；
- 每列固定宽度 = 该列所有单元格（含表头）最大显示宽度（CJK 字符按 2 宽）+ 少量余量（样例中 17 宽内容列宽 18）；
- 分隔线：短列为 9 个 `-`，比 9 宽的列按列宽打满 `-`（样例 18 宽列即 18 个 `-`）；
- 超宽单元格尾部截断并追加 `...`（如 `在线debug 类增强字节码加载验证问题修复` → `在线debug 类增...`）；
- 末行页脚：`第 <page> 页，共 <pages> 页（总计 <total> 条）`。

**`--json` 输出**（stdout，单行 JSON 数组，字段顺序实测如下）：
```json
[{"code":"ARD000001","summary":"示例变更","changeType":"系统变更","state":"开发中","team":"示例研发分队","createDate":"2026-09-09 09:20:11"},{"code":"HLR000001","summary":"在线debug 类增强字节码加载验证问题修复","changeType":"系统变更","state":"新建","team":"示例平台","createDate":"2022-12-30 18:13:42"}]
```
（注意：JSON 中 `summary` 是**完整**文本，不截断。）

### 4.5 `dop change view <code>`

- 位置参数必填 1 个（cobra `ExactArgs(1)`）。
- 请求：`GET /asd/api/systemChange/info?code=<code>`

**人类可读输出（stdout）**，实测样例：
```
System Change: ARD000001

Basic Information:
  Change Type    : 代码开发
  Team           : 示例研发分队
  State          : 开发中
  Summary        : 示例变更
  Created        : 2026-09-01 09:20:11

People:
  Assignee    : 示例用户 (000001)
  CreateUser  : 示例用户 (000001)
  Manager     : 示例用户 (000001)

Sub Systems:
  - SYS.example-sdk (示例研发平台.示例套件)

Timeline:
  Dev Start         : 2026-09-01 20:46:44
  Dev Complete      : 
  Acceptance Start  : 
  Acceptance End    : 
  Regression Start  : 
  Regression End    : 

Workload:
  Employee Dev   : 10
  Supplier Dev   : 0
  Employee Test  : 0
  Supplier Test  : 0

User Story:
  ID                : 00000000000000000000000000000001
  Code              : US-000001
  Title             : 示例变更
  Type              : 主办故事
  State             : 暂停
  Stage             : 开发中
  Team              : 示例研发分队
  Assignee          : 示例用户 (000001)
  Business Owner    : 示例用户 (000001)
  Release Info:
  release info not found
```
（空时间字段保留 `: ` 前缀后为空；`User Story` 缺失/无 ReleaseInfo 时打印 `release info not found`。）

**`--json` 输出**（单对象，字段顺序实测）：
```json
{"code":"ARD000001","changeType":"代码开发","team":"示例研发分队","state":"开发中","summary":"示例变更","description":"","created":"2026-09-01 09:20:11","assignee":{"name":"示例用户","loginCode":"000001"},"createUser":{"name":"示例用户","loginCode":"000001"},"manager":{"name":"示例用户","loginCode":"000001"},"subSystems":[{"name":"SYS.example-sdk","description":"示例研发平台.示例套件"}],"timeline":{"devStart":"2026-09-01 20:46:44","devComplete":"","acceptanceStart":"","acceptanceEnd":"","regressionStart":"","regressionEnd":""},"workload":{"employeeDev":10,"employeeTest":0,"supplierDev":0,"supplierTest":0},"userStory":{"id":"00000000000000000000000000000001","type":"主办故事","code":"US-000001","title":"示例变更","summary":"示例变更","category":"需求类","state":"暂停","stage":"开发中","team":"示例研发分队","createdAt":"2026-09-01 09:19:06","planOnlineAt":"2026-09-24 00:00:00","assignee":{"name":"示例用户","loginCode":"000001"},"businessOwner":{"name":"示例用户","loginCode":"000001"},"manager":{"name":"示例用户","loginCode":"000001"},"managerDesc":"","storyAC":"<p>详细规则：<br/></p>...","ReleaseInfo":null}}
```

**未找到**：stdout `No system change found.`，**exit 0**；`--json` 时 stdout 为 `{}`，exit 0。
（注意这个"未找到=成功"的不对称行为，mock 必须保留。）

### 4.6 `dop change done <code>`

- 位置参数必填 1 个。
- 流程：先 `GET /asd/api/systemChange/info?code=<code>`；
  - 未找到 → stdout `No system change found.`，exit 0（`--json` → `{}`，exit 0）；
  - 找到 → 执行"完成开发"状态流转（二进制内含 `systemChange/%s` URL 模板与 `DoneSystemChange` 调用；确切的方法+路径未能在无副作用情况下实测，mock 服务端可自定义，如 `POST /asd/api/systemChange/done?code=<code>`，CLI 侧行为不受影响）。
- 成功时的提示文本未实测（需要真实变更号，避免副作用）。mock 可打印 `Completed.` 类提示并在文档中标注。

### 4.7 `dop story list`

参数 → 查询映射：`--assigned-to-me`→`assignedToMe`、`--created-by-me`→`createdByMe`、`--managed-by-me`→`managedByMe`、`--acceptance-by-me`→`acceptanceByMe`（bool，未置为 `false`）、`--page`→`pageNum`、`--page-size`→`pageSize`、`--search`→`search`、`--sort-desc`→`sortDesc`；固定追加 `typeIds=main_story%2Cassistance_story`。
请求（`--debug` 实测）：
```
GET /asd/api/issue/myIssue/list?acceptanceByMe=false&assignedToMe=false&createdByMe=false&managedByMe=false&pageNum=1&pageSize=20&sortDesc=false&typeIds=main_story%2Cassistance_story
```

**人类可读输出（stdout）**，实测样例：
```
主辅办        编号         概要             类型         状态         阶段         归属分队       主办人
---------  ---------  ---------      ---------  ---------  ---------  ---------  ---------
主办故事       US-000002  AI原生框架 Hoo...  需求类        正常         开发中        示例研发分队     示例审批人
主办故事       US-000001  示例变更     需求类        暂停         开发中        示例研发分队     示例用户
第 1 页，共 1 页（总计 2 条）
```
列：`主辅办 | 编号 | 概要 | 类型 | 状态 | 阶段 | 归属分队 | 主办人`（渲染规则同 §4.4）。

**`--json` 输出**（字段顺序实测）：
```json
[{"id":"00000000000000000000000000000002","type":"主办故事","code":"US-000002","title":"示例故事","summary":"示例故事","category":"需求类","state":"正常","stage":"开发中","team":"示例研发分队","createdAt":"2026-10-14 11:16:43","planOnlineAt":"2026-11-06 00:00:00","assignee":{"name":"示例审批人","loginCode":"000002"},"businessOwner":{"name":"示例用户","loginCode":"000001"},"manager":{"name":"示例审批人","loginCode":"000002"},"managerDesc":"","storyAC":"","ReleaseInfo":null}]
```

### 4.8 `dop story view <code>`

- 位置参数必填 1 个。
- 请求：`GET /asd/api/story/info?code=<code>`（实测中还会伴随 `GET /asd/api/story/one/<id>` 取完整记录）。

**人类可读输出（stdout）**，实测样例：
```
User Story: US-000002

Basic Information:
  Summary      : 示例故事
  Type         : 主办故事
  State        : 正常
  Stage        : 开发中
  Team         : 示例研发分队
  Story AC     : <p>详细规则：<span style="font-size: 1em;">示例故事</span></p><p><br/><br/>界面设计：</p>
  Created      : 2026-10-14 11:16:43
  Plan Online  : 2026-11-06 00:00:00

Release Info:
  Release Num    : R20261100001
  Release Name   : 示例故事
  Release Date   : 2026-11-06 00:00:00
  Release Stage  : 设计开发

People:
  Assignee        : 示例审批人
  Manager         : 示例审批人
  Business Owner  : 示例用户
```

**`--json` 输出**（字段顺序实测）：
```json
{"id":"00000000000000000000000000000002","type":"主办故事","code":"US-000002","title":"示例故事","summary":"示例故事","category":"需求类","state":"正常","stage":"开发中","team":"示例研发分队","createdAt":"2026-10-14 11:16:43","planOnlineAt":"2026-11-06 00:00:00","assignee":{"name":"示例审批人","loginCode":"000002"},"businessOwner":{"name":"示例用户","loginCode":"000001"},"manager":{"name":"示例审批人","loginCode":"000002"},"managerDesc":"","storyAC":"<p>详细规则：<span style=\"font-size: 1em;\">...</span></p>","ReleaseInfo":{"releaseNum":"R20261100001","releaseDate":"2026-11-06 00:00:00","name":"示例故事","stage":"设计开发","state":"已审批"}}
```

**未找到**（与 change view 不对称！）：服务端返回 400 + JSON 错误体，CLI 行为：
- stdout 无输出；
- stderr：
  ```
  Error: failed to get user story: API error: {
  	"path":"/story/info",
  	"error":"Common Exception",
  	"message":"数据不存在",
  	"timestamp":"2026-11-03 19:20:20",
  	"status":400
  }
  Usage:
    dop story view <code> [flags]
  
  Flags:
    -h, --help   help for view
  
  Global Flags:
        --api-endpoint string   API endpoint URL (overrides config) (default "http://dop.example")
        --debug                 Enable debug mode: print detailed request and response info.
        --json                  Force all output to be valid JSON.
  ```
- exit 1（带不带 `--json` 行为相同）。

---

## 5. API 协议汇总（mock 服务端需要实现的路由）

Base：`http://dop.example`（仅 CLI 默认值；请求路径全部如下）

| 命令 | 方法与路径 | 查询参数 |
|---|---|---|
| `auth status` | `GET /uam/api/user/myProfile` | 无（认证头里的 token 即校验对象） |
| `change list` | `GET /asd/api/issue/myIssue/list` | `pageNum, pageSize, typeIds=system_change[, search, stateId, teamId]` |
| `change view` | `GET /asd/api/systemChange/info` | `code` |
| `change done` | 先 `GET /asd/api/systemChange/info?code=`，后状态流转（二进制模板 `systemChange/%s`，方法/完整路径未实测） | `code` |
| `story list` | `GET /asd/api/issue/myIssue/list` | `acceptanceByMe, assignedToMe, createdByMe, managedByMe, pageNum, pageSize, sortDesc[, search], typeIds=main_story,assistance_story` |
| `story view` | `GET /asd/api/story/info`（随后 `GET /asd/api/story/one/<id>`） | `code` |

### 5.1 服务端响应体（原始形状，CLI 只做投影）

`/asd/api/issue/myIssue/list` 返回（实测节选，字段比 CLI 显示的多，**mock 可按此形状返回**）：
```json
{
  "items": [ {
    "code": "ARD000001",
    "createDate": "2026-09-01 09:20:11",
    "assignee": { "loginCode": "000001", "name": "示例用户", "email": "user[at]corp.example",
                 "firstOrg": {"code":"41904Y","name":"软件研发中心"},
                 "secondOrg": {"code":"41905D","name":"基础技术研发部"},
                 "sex": "女", "type": {"id":"employee","name":"员工"}, "blocked": 0 },
    "creator": { /* 同 assignee 形状 */ },
    "businessOwner": null, "businessPartners": null, "category": null, "children": null
  } ],
  /* 分页元信息（总页数/总条数，CLI 用于页脚 "第 x 页，共 y 页（总计 n 条）"） */
}
```
CLI 侧投影（list 表格/JSON 只用这些字段）：
- change：`code, summary, changeType, state, team, createDate`
- story：`id, type, code, title, summary, category, state, stage, team, createdAt, planOnlineAt, assignee{name,loginCode}, businessOwner{name,loginCode}, manager{name,loginCode}, managerDesc, storyAC, ReleaseInfo`

`/asd/api/systemChange/info` 返回形状（CLI 直接投影成 §4.5 JSON，字段：`code, changeType, team, state, summary, description, created, assignee, createUser, manager, subSystems[], timeline{devStart,devComplete,acceptanceStart,acceptanceEnd,regressionStart,regressionEnd}, workload{employeeDev,employeeTest,supplierDev,supplierTest}, userStory{...同 story 形状...}`）。
原始响应中的时间线字段名为 `aiAssistedStartDate/aiAssistedEndDate/acceptanceStartDate/acceptanceEndDate/regressionStartDate/regressionEndDate`、工作量字段为 `employeeDevWorkload/supplierDevWorkload`（二进制内实测字符串）。

### 5.2 错误体（服务端）

```json
{"path":"/story/info","error":"Common Exception","message":"数据不存在","timestamp":"2026-11-03 19:20:20","status":400}
```
- `story/info` 未找到 → HTTP 400 + 上述体（CLI exit 1）。
- `systemChange/info` 未找到 → 返回"空"（CLI 打印 `No system change found.`，exit 0；mock 可用 200+空体或 204 实现）。
- 认证失败相关字符串：`token verification failed`（CLI 本地判定）。

---

## 6. 凭据存储（1:1 要点）

- 存储介质：**Windows 系统凭据管理器（Credential Manager）**，generic credential（`CredWrite/CredRead/CredDelete`，`danieljoos/wincred` 库）；非 Windows 平台走 keyring（二进制含 `secret not found in keyring` 回退提示）。
- **凭据 target 名（实测 cmdkey 枚举确认）**：`iam-cli:devops:<loginCode>`（如 `iam-cli:devops:000001`），user 字段同为 loginCode。该命名与 `iam` CLI 共享（二进制含 `iam-cli:devops`、`iam-cli:metadata` 两个 target 前缀）——mock 必须沿用同一 target，才能与真实环境互通。
- Token 形态：长字符串，以 `permament ...` 开头（实测 blob 前缀 `permament 05f578...`，显示打码为 `ab12...cd34`，即前 4 + `...` + 后 4）。
- 环境变量回退：`DEVOPS_API_KEY`（无凭据时可替代，见 §2.4 提示文本）。
- mock 若不想接 Credential Manager，可用本地文件模拟"存储"，但 **CLI 对外行为**（status 文案、打码规则、`Stored in system credential manager` 字样）需保持一致。

---

## 7. npm 分发层（真实 CLI 的运行外壳；mock 可选实现）

`dop` 命令实际是 `npm i -g @cli-tools/dop`（registry `https://npm.example/artifactory/api/npm/example-npm-local/`）安装的 wrapper：

1. `bin/run.js`（Node）先做**后台版本检查**：
   - 缓存文件 `~/.dop-cli-update-cache`，JSON `{lastCheck, remoteVersion}`；
   - 缓存中 remoteVersion 严格大于当前版本时，stdout 打印黄色横幅（`\x1b[33m`）：
     ```
     =====================================================
     🚀 发现新版本 DOP CLI: <cur> -> <new>
     👉 请运行命令平滑升级: npm install -g @cli-tools/dop@latest
     =====================================================
     ```
   - 超过 1 天才真正 fork 一个 `--background-check-update` 子进程去 `npm view @cli-tools/dop version` 更新缓存（失败也写时间戳防抖）；
2. 然后 `spawnSync(bin/dop.exe, args, {stdio:'inherit'})`，透传参数与退出码；找不到二进制时 stderr 打印
   `❌ 找不到底层核心程序: <path>` + `👉 请尝试运行: npm install -g @cli-tools/dop 重新安装。`，exit 1。
3. `postinstall`（`scripts/install.js`）从 `https://npm.example/artifactory/dop-generic-local/dop-cli/<version>/dop-<os>-<arch>(.exe)` 下载 Go 二进制（可用环境变量 `DOP_CLI_BIN_URL` 覆盖）。

> 对"mock 全部能力的 CLI"而言，第 2 步（exec + 退出码透传）是核心；版本横幅与下载脚本属于安装期行为，mock 可省略或按上文原样实现。

---

## 8. 已验证的边界行为速查（mock 自检用例）

| 输入 | 期望 |
|---|---|
| `dop` | 根帮助 → stdout，exit 0 |
| `dop change` | 组帮助 → stdout，exit 0 |
| `dop bogus` | stderr 两行错误，exit 1 |
| `dop -v` / `dop --version` | `dop version dop-cli 1.0.4`，exit 0 |
| `dop auth login`（无 -t） | stderr `Error: required flag(s) "token" not set` + Usage，exit 1 |
| `dop auth login -t ""` | stderr `Error: token is required` + Usage，exit 1 |
| `dop change view NOPE` | stdout `No system change found.`，exit 0 |
| `dop change view NOPE --json` | stdout `{}`，exit 0 |
| `dop change done NOPE` / `--json` | 同上（`No system change found.` / `{}`），exit 0 |
| `dop story view NOPE`（±`--json`） | stdout 空；stderr `Error: failed to get user story: API error: {...400 体...}` + Usage 块；exit 1 |
| `dop --api-endpoint http://x ...` | 参数被接受；**请求仍发往默认端点**（1.0.4 实测） |
| `dop --debug <任何业务命令>` | stdout 输出 `[DEBUG]` 请求块 + 响应块（格式 §2.5 示例见下） |

`--debug` 行格式（stdout，实测）：
```
[DEBUG] ───────── DEBUG: Request ─────────
[DEBUG] GET http://dop.example/asd/api/issue/myIssue/list?pageNum=1&pageSize=2&typeIds=system_change
[DEBUG] Headers:
[DEBUG]   Authorization: perm****
[DEBUG]   Content-Type: application/json
[DEBUG]   Accept: application/json
[DEBUG] ──────────────────────────────────
[DEBUG] ───────── DEBUG: Response ────────
[DEBUG] 200 200 
[DEBUG] Headers:
[DEBUG]   <逐行响应头，缩进 2 空格>
[DEBUG] Body:
[DEBUG]   <响应体，逐行缩进>
```

---

## 9. 与 npm README 的差异（防坑清单）

npm 包内 `README.md` 是**过期文档**，描述了 v1.0.4 二进制中**不存在**的命令与 flag。mock 一律不要实现：

- ❌ `dop change create` / `dop change start` / `dop story create`
- ❌ `dop config set --api-endpoint ...`（无 `config` 命令，端点硬编码默认值）
- ❌ `change list` 的 `--status/--limit/--type/--assignee`、`story list` 的 `--status/--priority/--epic/--assignee` 等 README flag
- ❌ `story create` 的 `--role/--goal/--benefit/--priority/--epic/--story-points/--assignee-id`

真实二进制的命令/flag 全集 = §1 + §3 + §4，一个不多一个不少。

---

## 附：给 mock 实现者的验收方法

1. 用同一组 mock 数据（可直接采用本文样例 JSON）驱动你的 mock CLI；
2. 将 stdout/stderr/exit code 与 §4 中逐字样例做**字节级对比**（注意表格的列宽与 `...` 截断）；
3. 用 §8 速查表逐条跑边界用例；
4. 服务端若需自测，按 §5 的路由表实现 6 个路由 + 400 错误体即可与真实 CLI 互通。
