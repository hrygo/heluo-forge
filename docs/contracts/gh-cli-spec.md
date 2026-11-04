# Gitee CLI（gh）接口规格（1.0.6）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-CLI-002 |
| 文档名称 | Gitee CLI（gh）接口规格（1.0.6） |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-04 |
| 门禁 | G1 接口事实 |

> 编制依据：2026-11-03 对 Gitee CLI（`gh`）1.0.6（Windows）的实测输出、`--help` 与二进制字符串提取整理；**本文件为脱敏版**——内网地址、账号、真实业务编号与仓库路径已替换为占位，原始捕获不入库；本轮未重新实机复核，标“推断”的条目仍为推断。
>
> 关联文档：[工程工具契约](engineering-tools.md)、[Gitee 接入详细设计](../design/plugins/forge-gitee.md)、[包 README](../../packages/forge-gitee/README.md)。

> **用途**：本文档是对 Gitee CLI（`gh`）1.0.6 的行为规格，供适配器、测试与 mock 实现逐条对照。
> 除特别标注“推断”的条目外，全部条目均通过对真实二进制的 **实测输出逐字节比对** 或 **二进制字符串提取** 验证；入库版本已脱敏。
> 验证环境：Windows 10/11，`gh` = npm 包 `@cli-tools/gh` v1.0.6（Go/Cobra 核心程序 `gh.exe`）。

---

## 0. 元信息（必须 1:1 复现的身份信息）

| 项 | 值 |
| --- | --- |
| 命令名 | `gh` |
| `gh --version` / `gh -v` 输出（stdout） | `gh version gitee-cli 1.0.6` |
| 根帮助首行 | `Work seamlessly with Gitee from the command line.` |
| 工具自我描述 | “Gitee CLI，使用习惯和标准向 GitHub CLI (`gh`) 看齐” |
| 默认 API base_url | `http://gitee.example/api/v8`（可被配置覆盖） |
| 配置文件位置 | `<用户主目录>/.gitee-cli/config.json`（仅存已设置的键） |
| 凭据存储 | 操作系统凭据管理器（Windows = DPAPI/keyring），服务名 `gitee-cli-go` |
| 环境变量 | `GITEE_TOKEN`（存在时优先于凭据管理器） |

命令树（完整，无遗漏；`help` 为 Cobra 内置命令）：

```
gh                          根命令（auth/config/help/issue/pr/repo）
├── auth
│   ├── login               用 token 登录
│   ├── logout              登出
│   └── status              查看认证状态
├── config
│   ├── get <key>           读配置
│   ├── list                列配置
│   └── set <key> <value>   写配置
├── help [command]          （Cobra 内置）
├── issue
│   ├── close <number>      关闭 issue
│   ├── comment <number>    评论 issue
│   ├── create              创建 issue
│   ├── list                列 issue
│   └── view <number>       查看 issue
├── pr
│   ├── close <number>      关闭 PR
│   ├── comment <number>    评论 PR
│   ├── create              创建 PR
│   ├── diff <number>       查看 PR diff
│   ├── edit <number>       编辑 PR
│   ├── list                列 PR
│   ├── merge <number>      合并 PR
│   ├── reopen <number>     重新打开 PR
│   ├── review <number>     提交 review
│   └── view <number>       查看 PR
└── repo
    ├── clone [repo] [dir]  克隆仓库
    ├── list                列仓库
    └── view [repo]         查看仓库
```

> 注意：**没有** `gh api`、`gh search`、`gh completion`、`gh workflow`、`gh release` 等 GitHub CLI 命令。命令面就以上述 4 个模块 + help 为止。

---

## 1. 全局约定（所有命令共享）

### 1.1 全局 Flags（出现在每条命令的帮助里）

| Flag | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `-R, --repo` | string | 无 | 目标仓库，`osc/<OWNER>/<REPO>` 格式（也接受两段 `<OWNER>/<REPO>`） |
| `--json` | string | 无 | **存在即生效，值被完全忽略**（实测 `--json false`、`--json x`、裸 `--json` 全部触发 JSON 输出）。按“flag 是否被设置（Changed）”判断 |
| `--debug` | bool | false | 打印详细请求/响应信息（输出到 **stderr**，格式见 1.8） |
| `-h, --help` | bool | | Cobra 标准帮助 |
| `-v, --version` | bool | | 仅根命令可用，打印 `gh version gitee-cli 1.0.6` |

子命令私有 flag 不继承；上表为全部“Global Flags”。

### 1.2 仓库上下文解析（`-R` / git remote）

解析顺序：
1. 若给了 `-R`：按 `/` 切分。
   - 3 段 `osc/OWNER/REPO`：正常。
   - 2 段 `OWNER/REPO`：当作路径使用（能查到仓库则正常，查不到则 API 报 `API error (500): 未找到关联的相关仓库的信息`）。
   - **1 段（无 `/`）：触发 Go panic**（`panic: runtime error: index out of range [0] with length 0`，打印 goroutine 栈），**退出码 2**。这是真实二进制的已知缺陷，mock 可选择复现 panic 行为或改为报错——验收时以退出码 2 为准。
2. 若未给 `-R`：解析当前目录 git 仓库的 origin remote URL，用配置项 `remote_pattern`（默认见 1.5）的正则提取路径；不在 git 仓库内或无法匹配时，报错（stderr）：
   ```
   missing required option: --repo <owner/repo>. Specify the target repository with -R or --repo, or run from within a Gitee git repository
   ```
   退出码 1。

### 1.3 认证与 Token

- Token 来源优先级：环境变量 `GITEE_TOKEN` > 系统凭据管理器（keyring，服务 `gitee-cli-go`）。
- 无任何 token 时（读命令需要鉴权），stderr 输出（常量已确认）：
  ```
  Not authenticated.
    Run iam auth login or gh auth login to authenticate.
  ```
  token 无效/过期时：
  ```
    Your token is invalid or has expired. Please run 'iam auth login or gh auth login' again.
  ```
  另有错误串 `error: not authenticated`（API 401 路径，推断用于 401 响应）。
- 请求头（所有 API 请求）：
  ```
  Private-Token: <token>
  Oauth: enabled
  ```
  两个头都会发送；`--debug` 打印时 token 被掩码（见 1.9），且两个头的**打印顺序不固定**（实测两种顺序都出现过，推断为 Go map 迭代）。
- API 403 时 stderr：`API error (403): token验证失败!`（消息为服务端原文）。

### 1.4 Token 掩码规则（两种，注意区分）

| 场景 | 规则 | 示例（token=`AbCdEf12...YTlj`） |
| --- | --- | --- |
| `auth status` / `config list` / `auth login` 成功回显 | 前 4 字符 + `****` + 后 4 字符 | `YzAx****YTlj` |
| `--debug` 请求头打印 | 前 4 字符 + `****` | `YzAx****` |

（短于 8 字符的 token 行为未实测，推断：按同规则截断。）

### 1.5 配置文件 `~/.gitee-cli/config.json`

- 只存**被显式 set 过的键**；目录/文件不存在 = 全默认。
- 已知键（`config get/set` 仅接受这三个，其他键报错）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `base_url` | `http://gitee.example/api/v8` | Gitee API 基础地址 |
| `token` | 无（`(not set)`） | 访问令牌 |
| `remote_pattern` | `^(?:https?://[^/]+/*\|ssh://git@[^/]+:\d+/*\|git@[^:]+:)(.*?)(\.git)?$` | git remote URL 匹配/提取正则（第一个捕获组 = 仓库路径） |

- 文件为 2 空格缩进 JSON，只含已设置的键，例如：
  ```json
  {
    "remote_pattern": "^(?:x)(.*)$"
  }
  ```
- `config set` 对未知键：stderr `Unknown config key: <key>` + 换行 + `  Available keys: base_url, token, remote_pattern`，退出码 1。

### 1.6 退出码约定（实测）

| 场景 | 退出码 |
| --- | --- |
| 成功（含空列表） | 0 |
| `gh`（无参数，打印帮助） | 0 |
| API 错误（4xx/5xx）、认证失败、参数校验错误、config 未知键、网络错误 | 1 |
| Cobra 用法错误（未知命令、缺参数、缺必填 flag） | 1 |
| Go panic（如 `-R` 无 `/`） | 2 |

### 1.7 表格渲染算法（**关键**，决定 list 类命令能否 1:1）

所有 list 命令的文本输出是“列对齐表格”，算法如下（已对 4 组真实数据 ≥100 行逐字节验证，100% 吻合）：

```
对表格（表头行 H + 数据行）：
  对每一列 j：
      W[j] = max(utf8.RuneCount(cell))   # 该列所有单元格（含表头）的最大 rune 数
  表头行：
      对 j < 最后一列：输出 H[j] + 空格*(W[j] - runeCount(H[j]))，后接 2 个空格
      最后一列：原样输出
  数据行：
      对 j < 最后一列：输出 cell + 空格*(W[j] - runeCount(cell))，后接 2 个空格
      最后一列：原样输出（无填充、无尾随空格）
```

要点与推论（mock 必须遵守）：
1. **宽度按 rune 数计算，但单元格按字节输出** → 含 CJK 的单元格实际字节长度 = rune 数 + 2×(3 字节字符数)，会**把同一行后续列整体右移**（表头不动，只有数据行错位）。这是真实二进制逐字节可复现的行为，不是 bug 规避对象——mock 要 1:1 就应产生同样的错位。
2. 列间分隔固定 **2 个空格**；最后一列不填充。
3. 单元格超长（rune 数 > W）时**不截断**，多出的部分自然把后列推远。
4. API 返回的文本可能包含**截断到半个 UTF-8 字符的脏字节**（Gitee API 会按字符截断 description），CLI **原样透传**，不做修复/替换。mock 直接透传即可。

真实样例（`issue list`，注意 CJK 行把 UPDATED 列推右）：
```
ID  TITLE                                      LABELS  UPDATED
5   [UDP000001]: 0805出库缺陷修复代码合并                        2025-11-29 18:15:45
1   修改 getFwTranInfoByKeyAndCreateDate 查询 SQL          2025-11-29 18:15:48
```

### 1.8 `--debug` 输出格式（stderr；stdout 照常）

```
───────── DEBUG: Request ─────────
GET <method 首字母大写> <完整 URL（含 query）>
Headers:
  <请求头逐行，2 空格缩进；token 按 1.4 掩码>
──────────────────────────────────
───────── DEBUG: Response ────────
Status: <code> <reason>
Headers:
  <响应头逐行>
Body:
  <响应体原文，整体 2 空格缩进>
──────────────────────────────────
```

实测样例（节选）：
```
───────── DEBUG: Request ─────────
GET http://gitee.example/api/v8/projects?order_by=created_at&page=1&per_page=1
Headers:
  Private-Token: YzAx****
  Oauth: enabled
──────────────────────────────────
───────── DEBUG: Response ────────
Status: 200 OK
Headers:
  X-Envoy-Upstream-Service-Time: 92
  Server: nginx
  Date: Tue, 03 Nov 2026 11:20:49 GMT
  Content-Type: application/json; charset=utf-8
  Connection: keep-alive
  Vary: Accept-Encoding
Body:
  {"data":[{"id":10604,...}],"meta":{"current_page":1,"total_pages":215,"total_count":215}}
──────────────────────────────────
```

### 1.9 `--json` 输出行为（三种形态，按命令区分）

1. **列表类**（`repo list` / `issue list` / `pr list`）：输出 API 原始 envelope 的 pretty-print JSON（2 空格缩进）。注意 envelope 形状**各不相同**（见 §4 各命令）：
   - `repo list` / `issue list`：`{"data":{"list":[...]},"meta":{...}}`
   - `pr list`（非空）：`{"data":[...],"meta":{...}}`（**data 直接是数组**，元素为完整 PR 对象）
   - `pr list`（**空**）：`{"message":"No pull requests found."}`（单行，无缩进）
2. **详情类**（`repo view` / `issue view` / `pr view`）：直接输出单个 JSON 对象（pretty-print，2 空格缩进；字段为 Go 结构体默认字母序）。
3. **行输出类**（`auth status` / `config list`）：把原本要打印到 stdout 的每一行包成 **JSON Lines**：每行一个 `{"message":"<原行>"}`。空行省略；个别行会保留字符串中间的 `\n`（原样）。实测样例（`auth status --json`）：
   ```
   {"message":"Verifying token..."}
   {"message":"Logged in to Gitee as 000001"}
   {"message":"  Token:  YzAx****YTlj"}
   {"message":"  Stored in system credential manager"}
   ```

### 1.10 错误消息模板（stderr，退出码 1）

| 场景 | 原文 |
| --- | --- |
| API 非 2xx | `API error (<HTTP code>): <服务端 message 字段>`（message 可能为空，如 `API error (500): `） |
| 网络/客户端错误 | `network / client error: <err>`（字符串常量确认，未实测触发） |
| 缺仓库上下文 | 见 1.2 |
| 必填 flag 缺失 | `Error: required flag(s) "<flags>" not set` + 该命令 Usage 块（Cobra 标准） |
| 参数个数错误 | `Error: accepts 1 arg(s), received 0` / `Error: requires at least %d arg(s), only received %d` + Usage 块 |
| 未知命令 | `Error: unknown command "<cmd>" for "gh"` + 换行 + `Run 'gh --help' for usage.` |
| 读取 body 文件失败 | `Failed to read body file: <err>` |
| clone 无法确定 URL | `Could not determine clone URL for <repo>` |

### 1.11 浏览器（`--web` / `-w`）

- 打开前先打印（stdout）：`Opening <url> in your browser.`，然后调用系统默认浏览器（Windows 下经 ShellExecute `open <url>`；无参数、非交互）。
- URL 派生规则（host 取自 `base_url` 的 host；**只用到 owner，不用 repo 的 web_url 字段**）：

| 命令 | URL 模板（实测） |
| --- | --- |
| `repo view -w` | `{host}/osc/{owner}/{repo}` → `http://gitee.example/acme/group/demo` |
| `issue view <n> -w` | `{host}/osc/{owner}/issues/{n}` → `http://gitee.example/acme/group/issues/1` |
| `issue list -w` | `{host}/osc/{owner}/issues` → `http://gitee.example/acme/group/issues` |
| `pr view <n> -w` | `{host}/osc/{owner}/pulls/{n}` → `http://gitee.example/acme/group/pulls/6` |
| `pr list -w` | `{host}/osc/{owner}/pulls`（推断，与 issue list 对称） |

### 1.12 ANSI 颜色

| 颜色 | 码 | 用途 |
| --- | --- | --- |
| 绿 | `\x1b[32m` | `pr view` 状态 `opened` |
| 品红 | `\x1b[35m` | `pr view` 状态 `merged` |
| 红 | `\x1b[31m` | `pr view` 状态 `closed` |
| 青 | `\x1b[36m` | 常量 `\x1b[36m• Newest comment\x1b[0m`（二进制中存在；管道输出中未观察到，推断 TTY 下标注最新评论） |

状态行模板（`pr view`）：`<color><state>\x1b[0m • <author.name> wants to merge <source> into <target>`
（`drafted` 状态的颜色未实测，推断无色或复用其中之一；二进制中只有 32/35/31 三个状态色常量。）

### 1.13 日期/时间格式

- 表格内（UPDATED 列）：`2006-01-02 15:04:05`（Go 布局），如 `2026-10-28 16:40:30`。
- `issue view` 第二行：同格式。
- `repo view` 的 `Last Activity:`：原始 RFC3339 带微秒透传，如 `2026-09-17T10:19:48.000000+08:00`。
- JSON 中：API 原始时间串透传（如 `2026-10-22T09:40:00.597916+08:00`）。

### 1.14 空结果文本（stdout，退出码 0）

| 命令 | 原文 |
| --- | --- |
| `repo list`（0 行） | `No repositories found.` |
| `issue list`（0 行） | `No issues found.` |
| `pr list`（0 行） | `No pull requests found.` |

非空列表的表头行（注意“of 后面恒为 0”的真实 quirk，以及 owner-only 路径）：

| 命令 | 模板 | 实测样例 |
| --- | --- | --- |
| `repo list` | `Showing <n> of 0 repository(s)` | `Showing 100 of 0 repository(s)` |
| `issue list` | `Showing <n> of 0 issue(s) in <owner>` | `Showing 5 of 0 issue(s) in osc/UAF` |
| `pr list` | `Showing pull requests in <owner>/<repo?>` | `Showing pull requests in acme/group` |

（`<n>` = 实际打印行数；“of” 后的 total 在文本模式恒为 `0`，无论 API meta.total_count 是多少——真实二进制即如此，1:1 mock 照抄。）
列表输出结构：`<空行><表头行><空行><表格>`（首行前有一个空行）。

---

## 2. 命令详细参考

> 每个命令给出：描述（= 帮助首行）、Usage、Flags（短/长、类型、默认值）、行为、输出格式（字节级模板）、退出码。
> “描述”均为二进制中的原文，mock 的帮助文本应逐字使用。
> 全部命令的完整逐字帮助文本见 §2.0 代码块（含全部 flags 与默认值标注，如 `(default 30)`、`(default "created")`）；下文直接给出行为规格。

### 2.0 根命令 `gh`

`gh`、`gh help`、`gh --help` 的输出（stdout，退出码 0）：

```
Work seamlessly with Gitee from the command line.

Usage:
  gh [command]

Available Commands:
  auth        Authenticate gitee cli
  config      Manage configuration for gitee cli
  help        Help about any command
  issue       Manage issues
  pr          Manage pull requests
  repo        View and clone gitee repositories

Flags:
      --debug         Enable debug mode: print detailed request and response info.
  -h, --help          help for gh
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.
  -v, --version       version for gh

Use "gh [command] --help" for more information about a command.
```

- `gh`（无参数）：stdout 打印上述帮助，退出码 0。
- `gh --version` / `gh -v`：`gh version gitee-cli 1.0.6`。
- 子命令帮助由 Cobra 生成，结构恒定：`<描述>\n\nUsage:\n  gh <path> <args> [flags]\n\nFlags:\n  <本地 flags>\n\nGlobal Flags:\n  --debug ...\n      --json string ...\n  -R, --repo string ...\n`；含子命令的命令末尾附 `Use "gh <path> [command] --help" for more information about a command.`。
- `gh help <path>` 等价于 `gh <path> --help`。
- 各子命令帮助全文（与下文各节 Flags 一致，供 mock 直接复用）：

```
# gh auth
Authenticate gitee cli

Usage:
  gh auth [command]

Available Commands:
  login       Authenticate with a Gitee personal access token.
  logout      Log out of Gitee.
  status      View authentication status.

Flags:
  -h, --help   help for auth

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

Use "gh auth [command] --help" for more information about a command.

# gh auth login
Authenticate with a Gitee personal access token.

Usage:
  gh auth login [flags]

Flags:
  -h, --help           help for login
  -t, --token string   Gitee personal access token.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh auth logout
Log out of Gitee.

Usage:
  gh auth logout [flags]

Flags:
  -h, --help   help for logout

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh auth status
View authentication status.

Usage:
  gh auth status [flags]

Flags:
  -h, --help   help for status

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh config
Manage configuration for gitee cli

Usage:
  gh config [command]

Available Commands:
  get         Get a configuration value. Keys: base_url, token, remote_pattern.
  list        List all configuration values.
  set         Set a configuration value. Keys: base_url, token, remote_pattern.

Flags:
  -h, --help   help for config

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

Use "gh config [command] --help" for more information about a command.

# gh config get
Get a configuration value. Keys: base_url, token, remote_pattern.

Usage:
  gh config get <key> [flags]

Flags:
  -h, --help   help for get

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh config list
List all configuration values.

Usage:
  gh config list [flags]

Flags:
  -h, --help   help for list

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh config set
Set a configuration value. Keys: base_url, token, remote_pattern.

Usage:
  gh config set <key> <value> [flags]

Flags:
  -h, --help   help for set

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh help
Help provides help for any command in the application.
Simply type gh help [path to command] for full details.

Usage:
  gh help [command] [flags]

Flags:
  -h, --help   help for help

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh issue
Manage issues

Usage:
  gh issue [command]

Available Commands:
  close       Close an issue.
  comment     Add a comment to an issue.
  create      Create a new issue.
  list        List issues in a repository.
  view        View details of an issue.

Flags:
  -h, --help   help for issue

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

Use "gh issue [command] --help" for more information about a command.

# gh issue list
List issues in a repository.

Usage:
  gh issue list [flags]

Flags:
  -a, --assignee string    Filter by assignee.
  -A, --author string      Filter by author.
      --direction string   Sort direction: asc, desc. Default: desc. (default "desc")
  -h, --help               help for list
  -l, --label string       Filter by label name.
  -L, --limit int          Maximum number of items to fetch. Default: 30 (default 30)
  -S, --search string      Fuzzy search issues by keyword.
      --state string       Filter by state: created, processing, rejected, finished, all. Default: created. (default "created")
  -w, --web                List issues in your browser.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh issue view
View details of an issue.

Usage:
  gh issue view <number> [flags]

Flags:
  -c, --comments   View the full conversation including all comments.
  -h, --help       help for view
  -w, --web        Open the issue in your browser.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh issue create
Create a new issue.

Usage:
  gh issue create [flags]

Flags:
      --assignee string          Assignee ID.
  -b, --body string              Description of the issue.
  -F, --body-file string         Read body text from file. Use "-" to read from stdin.
      --branch-name string       Related branch.
      --due-date string          Plan finish time.
  -h, --help                     help for create
      --iid int                  Issue iid. 0 for auto-increment, >0 to set explicitly.
  -l, --label string             Comma-separated list of labels.
      --plan-started-at string   Plan start time.
      --priority string          Priority: unassigned, low, medium, high, urgent. (default "unassigned")
  -t, --title string             Title of the issue.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh issue comment
Add a comment to an issue.

Usage:
  gh issue comment <number> [flags]

Flags:
  -b, --body string        The comment body text
  -F, --body-file string   Read body text from file. Use "-" to read from stdin.
  -h, --help               help for comment

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh issue close
Close an issue.

Usage:
  gh issue close <number> [flags]

Flags:
  -c, --comment string   Leave a closing comment.
  -h, --help             help for close

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr
Manage pull requests

Usage:
  gh pr [command]

Available Commands:
  close       Close a pull request.
  comment     Add a comment to a pull request.
  create      Create a pull request.
  diff        View the diff of a pull request.
  edit        Edit a pull request.
  list        List pull requests in a repository.
  merge       Merge a pull request.
  reopen      Reopen a pull request.
  review      Submit a review comment on a pull request.
  view        View details of a pull request.

Flags:
  -h, --help   help for pr

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

Use "gh pr [command] --help" for more information about a command.

# gh pr list
List pull requests in a repository.

Usage:
  gh pr list [flags]

Flags:
  -a, --assignee string   Filter by assignee.
  -A, --author string     Filter by author.
  -B, --base string       Filter by base branch.
  -H, --head string       Filter by head branch.
  -h, --help              help for list
  -l, --label string      Filter by label name.
  -L, --limit int         Maximum number of items to fetch. Default: 30 (default 30)
      --order_by string   Order field: updated_at, created_at. Default: created_at. (default "created_at")
  -S, --search string     Search pull requests with a query.
      --sort string       Sort field: asc, desc. Default: desc. (default "desc")
      --state string      Filter by state: opened, closed, merged, all. Default: opened. (default "opened")
  -w, --web               List pull requests in your browser.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr view
View details of a pull request.

Usage:
  gh pr view <number> [flags]

Flags:
  -c, --comments   View the full conversation including all comments.
  -h, --help       help for view
  -w, --web        Open the pull request in your browser.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr create
Create a pull request.

Usage:
  gh pr create [flags]

Flags:
  -B, --base string                   The branch into which you want your code merged.
  -b, --body string                   Body for the pull request.
  -F, --body-file string              Read body text from file. Use "-" to read from stdin.
  -d, --draft                         Mark the pull request as a draft.
  -H, --head string                   The branch that contains commits for your pull request.
  -h, --help                          help for create
  -l, --label string                  Add labels by name (comma-separated).
      --primary_reviewer_ids string   Comma-separated primary reviewer IDs.
      --primary_reviewer_num string   Minimum number of primary reviewers. Default: 0 (default "0")
  -r, --reviewer string               Request reviews from people (comma-separated IDs). Alias for --primary_reviewer_ids.
      --remove-source-branch          Remove source branch after merge.
  -t, --title string                  Title for the pull request.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr edit
Edit a pull request.

Usage:
  gh pr edit <number> [flags]

Flags:
  -b, --body string          Body for the pull request.
  -h, --help                 help for edit
      --state-event string   State event: closed, opened, drafted. Default: opened. (default "opened")
  -t, --title string         Title for the pull request.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr diff
View the diff of a pull request.

Usage:
  gh pr diff <number> [flags]

Flags:
  -h, --help   help for diff

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr review
Submit a review comment on a pull request.

Usage:
  gh pr review <number> [flags]

Flags:
  -a, --approve            Approve pull request
  -b, --body string        Review comment body.
  -F, --body-file string   Read body text from file. Use "-" to read from stdin.
  -c, --comment            Leave a general comment
  -h, --help               help for review
  -r, --request-changes    Request changes to a pull request

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr merge
Merge a pull request.

Usage:
  gh pr merge <number> [flags]

Flags:
  -b, --body string      Body text for the merge commit.
  -d, --delete-branch    Delete the local and remote branch after merge.
  -h, --help             help for merge
  -m, --merge            Merge the pull request (default) (default true)
  -r, --rebase           Rebase and merge
  -s, --squash           Squash and merge
  -t, --subject string   Subject text for the merge commit.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr comment
Add a comment to a pull request.

Usage:
  gh pr comment <number> [flags]

Flags:
  -b, --body string        The comment body text
  -F, --body-file string   Read body text from file. Use "-" to read from stdin.
  -h, --help               help for comment

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr close
Close a pull request.

Usage:
  gh pr close <number> [flags]

Flags:
  -c, --comment string   Leave a closing comment.
  -h, --help             help for close

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh pr reopen
Reopen a pull request.

Usage:
  gh pr reopen <number> [flags]

Flags:
  -h, --help   help for reopen

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh repo
View and clone gitee repositories

Usage:
  gh repo [command]

Available Commands:
  clone       Clone a repository to local filesystem.
  list        List repositories.
  view        View repository information and README.

Flags:
  -h, --help   help for repo

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

Use "gh repo [command] --help" for more information about a command.

# gh repo clone
Clone a repository to local filesystem.

Usage:
  gh repo clone [repository] [dir] [flags]

Flags:
      --depth string   Create a shallow clone with the given depth.
  -h, --help           help for clone
      --ssh            Use SSH URL instead of HTTPS. Default: false.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh repo list
List repositories.

Usage:
  gh repo list [flags]

Flags:
  -h, --help              help for list
      --keywords string   Filter by repository keywords (fuzzy match)
  -L, --limit int         Maximum number of repositories to fetch. Default: 20 (default 20)
      --orderBy string    Order by field: name, created_at, updated_at. Default: created_at (default "created_at")

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.

# gh repo view
View repository information and README.

Usage:
  gh repo view [repository] [flags]

Flags:
  -b, --branch string   View a specific branch of the repository.
  -f, --file string     Path to the file to view (default is README.md) (default "README.md")
  -h, --help            help for view
  -w, --web             Open the repository in your browser.

Global Flags:
      --debug         Enable debug mode: print detailed request and response info.
      --json string   Force all output to be valid JSON.
  -R, --repo string   Target repository in osc/<OWNER>/<REPO> format.
```

### 2.1 `gh auth`

#### `gh auth login`（描述：`Authenticate with a Gitee personal access token.`）

Flags：`-t, --token string`（Gitee personal access token.）；无其他 flag。无位置参数。

流程与输出（stdout）：
1. 打印 `Verifying token...`
2. 用 token 调 `GET {base}/user`（带 `Private-Token` 头）验证：
   - **失败**（403/401/网络错误）：
     ```
     Token verification failed
       Please check your token and try again.
     ```
     退出码 1。
   - **成功**（实测完整输出）：
     ```
     Verifying token...
     Login successful!
       Name : 000001-示例用户
       Username : 000001
       Email    : user[at]corp.example
       Git Email: user[at]corp.example
       Token saved to system credential manager
     ```
     （字段取自 `/user` 响应：`name` / `username` / `email` / `git_email`（缺失时对应行如何省略未实测，推断整行不打印或打空）。）
3. 成功后把 token 写入系统凭据管理器（keyring，服务 `gitee-cli-go`）。
4. 退出码 0。

#### `gh auth logout`（描述：`Log out of Gitee.`）

- 删除凭据管理器中的条目，stdout：`Logged out successfully.`，退出码 0。
- 无 flag（仅 `-h` 与全局）。

#### `gh auth status`（描述：`View authentication status.`）

- 有有效 token 时（stdout，实测）：
  ```
  Verifying token...
  Logged in to Gitee as 000001
    Token:  YzAx****YTlj
    Stored in system credential manager
  ```
  模板：`Verifying token...\nLogged in to Gitee as {username}\n  Token:  {掩码}\n  Stored in system credential manager`
  （`as` 后跟 `/user` 返回的 username；token 掩码见 1.4。）
- token 来自环境变量时，第二行为：`Logged in to Gitee as {username} (via environment variable GITEE_TOKEN)`（字符串确认，未实测整行触发）。
- 无 token：见 1.3 的 `Not authenticated.` 文案。
- `--json`：按 1.9 的 JSON Lines 包装。
- 退出码 0（有效）/ 1（无效或无）。

### 2.2 `gh config`

#### `gh config list`（描述：`List all configuration values.`）

stdout（实测）：
```
Config file: %USERPROFILE%\.gitee-cli\config.json
Exists:      false

base_url       = http://gitee.example/api/v8
remote_pattern = ^(?:https?://[^/]+/*|ssh://git@[^/]+:\d+/*|git@[^:]+:)(.*?)(\.git)?$
name           = 
username       = 000001
token          = YzAx****YTlj
```
模板（逐行）：
```
Config file: {config 文件绝对路径}
Exists:      {true|false}
<空行>
base_url       = {base_url}
remote_pattern = {remote_pattern}
name           = {name}
username       = {username}
token          = {token 掩码 | (not set)}
```
- `name` / `username` 来自当前登录用户（`/user`）；无 token 时推断为 `(not set)` 或空（未实测）。
- `token` 未登录时输出 `token          = (not set)`（字符串常量确认）。
- 键值列对齐规则（逐字节验证）：**`%-15s = %s`**——键名左对齐 15 字符 + ` = ` + 值。核对：`base_url`(8)→7 空格、`remote_pattern`(14)→1 空格、`name`(4)→11 空格、`username`(8)→7 空格、`token`(5)→10 空格。
- 退出码 0。`--json`：JSON Lines（1.9）。

#### `gh config get <key>`（描述：`Get a configuration value. Keys: base_url, token, remote_pattern.`）

- 位置参数：1 个（`<key>`）。
- 成功：stdout 打印值（单行，无装饰），退出码 0。
  - `config get base_url` → `http://gitee.example/api/v8`
  - `config get token`：有 token 时打印掩码还是原值未实测；按 `config list` 行为推断为**掩码值**（`YzAx****YTlj`）。mock 按掩码实现并备注。
- 未知键：stderr：
  ```
  Unknown config key: <key>
    Available keys: base_url, token, remote_pattern
  ```
  退出码 1。
- 0 个参数：Cobra `Error: accepts 1 arg(s), received 0` + Usage，退出码 1。

#### `gh config set <key> <value>`（描述：`Set a configuration value. Keys: base_url, token, remote_pattern.`）

- 位置参数：2 个。
- 成功：stdout 打印 `<key> = <value>`（实测：`remote_pattern = ^(?:x)(.*)$`），退出码 0；写入 `~/.gitee-cli/config.json`（目录不存在则创建；JSON 只含已设置键，2 空格缩进）。
- 未知键 / 参数个数错误：同 `get`（§1.5 / Cobra）。

---

### 2.3 `gh repo`

#### `gh repo list`（描述：`List repositories.`）

Flags：`--keywords string`（fuzzy 过滤仓库）、`-L, --limit int`（默认 **20**，帮助原文 `Default: 20 (default 20)`）、`--orderBy string`（默认 `created_at`，可选 `name, created_at, updated_at`）。

行为：`GET {base}/projects?page=1&per_page={limit}&order_by={orderBy}`（`--keywords` 推断附加 `keywords=` 查询参数；实测请求仅含 `order_by&page&per_page`）。

文本输出（stdout）：
```
<空行>
Showing {n} of 0 repository(s)
<空行>
NAME  DESCRIPTION  INFO  UPDATED        ← 表头，按 §1.7 算法对齐
{path_with_namespace}  {description}  {visibility}  {last_activity_at 格式化 2006-01-02 15:04:05}
```
- 列：`NAME` = `path_with_namespace`（如 `acme/group/demo`）；`DESCRIPTION` = `description`（可能含脏 UTF-8，透传）；`INFO` = `visibility`（`private` / `internal` / `public`）；`UPDATED` = `last_activity_at` 格式化 `2006-01-02 15:04:05`。
- 0 行：`No repositories found.`
- 分页：恒为 `page=1`，无翻页 flag；`per_page` 超过 API 上限（100）时 API 截断（实测 `-L 215` 只返回 100 条，`Showing 100 of 0`）。
- 实测样例（节选）：
  ```
  Showing 10 of 0 repository(s)

  NAME                          DESCRIPTION        INFO      UPDATED
  acme/group/demo          后端代码               private   2026-10-28 16:40:30
  acme/group/demo-web      前端代码               private   2026-10-22 10:39:20
  ```
- `--json`（实测）：
  ```json
  {
    "data": {
      "list": [
        {
          "created_at": "2026-10-22T09:40:00.597916+08:00",
          "description": "后端代码",
          "fork_from_path": "",
          "http_url": "http://gitee.example/acme/group/demo.git",
          "id": 10604,
          "last_activity_at": "2026-10-28T16:40:30.000000+08:00",
          "name": "aia-platform",
          "path_with_namespace": "acme/group/demo",
          "ssh_url": "ssh://git@{host}:30004/acme/group/demo.git"
        }
      ]
    },
    "meta": { "current_page": 1, "total_count": 215, "total_pages": 72 }
  }
  ```
  每个元素**恰好 9 个字段**（如上，字母序），无 visibility/public 字段。

#### `gh repo view [repository]`（描述：`View repository information and README.`）

Flags：`-b, --branch string`（无默认）、`-f, --file string`（默认 `README.md`）、`-w, --web`。
位置参数：`[repository]`（可选；缺省时用仓库上下文 `-R`/git remote）。

行为：`GET {base}/projects/{urlencoded 路径}`（仓库对象）+ 文件内容接口（`-f` 指定文件、`-b` 指定分支）。

文本输出（stdout，实测）：
```
Repository: {path_with_namespace}
Description: {description}
Stars:       {star_count}
Forks:       {fork_count}
Open Issues: {open_issues_count}
Commits:     {statistics.commit_count}
Tags:        {statistics.tag_count}
Default branch: {default_branch}
Last Activity:  {last_activity_at 原始 RFC3339 串}
Web URL:     {web_url}
SSH URL:     {ssh_url_to_repo}
HTTP URL:    {http_url_to_repo}
<空行>
--- {file} ---
{文件内容（README 默认 README.md）}
```
（`Last Activity:` 后是**两个**空格；`Stars:/Forks:/Open Issues:/Commits:/Tags:` 的数值列对齐到 13 字符宽；`Web URL:/SSH URL:/HTTP URL:` 键列宽 11 字符 + 冒号。照抄样例字节即可。）

`--json`（实测）：输出**完整仓库对象**（字段字母序，节选）：
```json
{
  "archived": false,
  "avatar_url": "",
  "card_enable": false,
  "created_at": "2026-09-11T14:59:40.497945+08:00",
  "creator_id": 257,
  "default_branch": "master",
  "description": "sdd企业AI工作流工具",
  "empty_status": 0,
  "fork_count": 0,
  "fork_from_path": "",
  "http_url_to_repo": "http://gitee.example/acme/group/demo.git",
  "id": 10531,
  "import_url": "",
  "is_favorite": true,
  "issues_enabled": false,
  "last_activity_at": "2026-09-17T10:19:48.000000+08:00",
  "merge_requests_enabled": true,
  "name": "ard-comet",
  "name_with_namespace": "acme/group/demo",
  "namespace": { "avatar_url": "", "full_path": "acme/group", "id": 4613, "kind": "Group", "name": "ard", "path": "ard", "web_url": "" },
  "open_issues_count": 0,
  "open_source_organizations": null,
  "owner": { "created_at": "2025-11-14T12:19:59.000000+08:00", "id": 257, "name": "DevOps Bot" },
  "path": "ard-comet",
  "path_with_namespace": "acme/group/demo",
  "readme_url": "",
  "repository_storage": "",
  "ssh_url_to_repo": "ssh://git@{host}:30004/acme/group/demo.git",
  "star_count": 1,
  "statistics": { "commit_count": 6, "repository_size": 37228, "storage_size": 37228, "tag_count": 0, "wiki_size": 0 },
  "tag_list": { "labels": [], "tags": [] },
  "user_permission": { "code": 6, "permission": "Operator" },
  "visibility": "private",
  "web_url": "http://gitee.example/osc/_code/acme/group/demo/-/code/"
}
```

#### `gh repo clone [repository] [dir]`（描述：`Clone a repository to local filesystem.`）

Flags：`--depth string`（shallow 深度）、`--ssh`（bool，用 SSH URL）。
位置参数：`[repository] [dir]`（均可选；repository 缺省用仓库上下文，dir 缺省 = 仓库名目录）。

流程（stdout）：
1. `Cloning {clone_url} ...`
2. 执行 `git clone [--depth N] <clone_url> <dir>`，git 原始输出直接透传（`Cloning into '...'...` + `Updating files: 30% ...` 进度串）。
3. 完成后打印 `Clone complete.`

clone_url 规则：
- HTTPS（默认）：`http://{token}@{host}/{path}.git` —— **token 明文嵌入 userinfo**（实测：`Cloning http://<token>@{host}/acme/group/demo.git ...`）。host 取自 base_url 的 host；`path` = `owner/repo`（或 3 段路径）。
- `--ssh`：直接用仓库对象的 `ssh_url`（`ssh://git@{host}:30004/{path}.git`，无 token）。
- 无法确定 URL：stderr `Could not determine clone URL for {repo}`，退出码 1。
- git 失败：git 的 stderr 透传，退出码 1。成功退出码 0。

---

### 2.4 `gh issue`

#### `gh issue list`（描述：`List issues in a repository.`）

Flags：`-a, --assignee string`、`-A, --author string`、`--direction string`（默认 `desc`，`asc|desc`）、`-l, --label string`、`-L, --limit int`（默认 30）、`-S, --search string`、`--state string`（默认 `created`，可选 `created, processing, rejected, finished, all`）、`-w, --web`。
需要仓库上下文（`-R` 或 git remote）。

行为：`GET {base}/projects/{path}/issues?page=1&per_page={limit}`（filters 推断为同名查询参数 `state/label/assignee/author/search`；实测请求仅含 `page&per_page`）。

文本输出（stdout）：
```
<空行>
Showing {n} of 0 issue(s) in {owner}
<空行>
ID  TITLE  LABELS  UPDATED
{iid}  {title}  {labels 逗号拼接}  {updated_at 格式化 2006-01-02 15:04:05}
```
- 表头行 `Showing ... in {owner}` 只取仓库路径的**第一段**（`osc/UAF/gravity-2.0` → `osc/UAF`）。
- `ID` = API 的 `iid`（数字），不是 `id`（大 id）。
- `UPDATED` = `updated_at`。
- 0 行：`No issues found.`
- 实测样例（注意 CJK 推右）：
  ```
  Showing 5 of 0 issue(s) in osc/UAF

  ID  TITLE                                      LABELS  UPDATED
  5   [UDP000001]: 0805出库缺陷修复代码合并                        2025-11-29 18:15:45
  4   2022.2.25 流水表重构代码评审                                2025-11-29 18:15:46
  1   修改 getFwTranInfoByKeyAndCreateDate 查询 SQL          2025-11-29 18:15:48
  ```
- `--json`（实测，元素**恰好 5 字段**，字母序；`id` = iid）：
  ```json
  {
    "data": {
      "list": [
        {
          "description": "",
          "id": 5,
          "labels": [],
          "title": "[UDP000001]: 0805出库缺陷修复代码合并",
          "updated_at": "2025-11-29T18:15:45.702000+08:00"
        }
      ]
    },
    "meta": { "current_page": 1, "total_count": 5, "total_pages": 1 }
  }
  ```
- `--json` 空列表：`{"data":{"list":[]},"meta":{...0...}}`（**不是** message 对象——与 pr list 空行为不同！）。
- `-w`：`Opening {host}/osc/{owner}/issues in your browser.`

#### `gh issue view <number>`（描述：`View details of an issue.`）

位置参数：1 个（issue 数字号，即 iid）。Flags：`-c, --comments`、`-w, --web`。

文本输出（stdout，实测）：
```
{title} {jump_info.full_path}#{ident}
{StateLabel} • {author.name} opened {created_at 2006-01-02 15:04:05} • {noteable_count} comment(s)
<空行>
Priority: {priority}
State:    {state 原样小写}
<空行>
  {description 经 HTML 剥离后的文本，每行 2 空格缩进}
```
- 第一行：`{title} {path}#{ident}`（空格分隔；`ident` 是 issue key，如 `I4JR`；`path` 用 `jump_info.full_path`，如 `osc/UAF/Gravity-2_0`——**注意用显示名而非小写 path**）。
- `StateLabel` = state 首字母大写映射：`created→Created`、`processing→Processing`、`rejected→Rejected`、`finished→Finished`。
- `author` = API `author.name`（如 `000002-示例审批人`）。
- `State:` 行：`State:` 后 4 空格（`%-4s` 语义？实测 `State:    finished` = "State:" + 4 空格）。
- body 的 HTML 剥离规则：去标签、折叠空白（表格会压成单行连续文本）、原文换行保留。**Gitee 返回的 description 常是 HTML 片段，可能含截断半个字符的脏 UTF-8，CLI 原样透传不修复**。
- 实测样例：
  ```
  2022.2.25 流水表重构代码评审 osc/UAF/Gravity-2_0#I2N6
  Finished • 000002-示例审批人 opened 2022-02-25 14:48:33 • 2 comment(s)

  Priority: medium
  State:    finished

    1. 判断接触节点是否配置是否存在补偿节点
    2. FwReverseControl fwReverseControl = new FwReverseControl();
    ...
  ```

`-c` 时，body 之后追加评论块（每条评论，**按时间倒序**，实测）：
```
{评论作者名} • {评论时间 2006-01-02 15:04:05}
  {评论文本（2 空格缩进）}
<空行>
```
实测样例（接在上例之后）：
```
osc-admin • 2022-03-03 08:40:33
  8ca06c27844a51ad4b6cee6f1632f07081c601c3

osc-admin • 2022-03-03 08:40:21
  d6471e1081f4f6257754fb5bebbd5a8bb9e856c7
```
（二进制中存在青色常量 `\x1b[36m• Newest comment\x1b[0m`，推断 TTY 下标注最新评论；管道输出中未观察到，mock 可不实现或仅 TTY 实现。）

`--json`（实测，**恰好 8 字段**，字母序）：
```json
{
  "author": "000002-示例审批人",
  "created_at": "2022-02-25T14:48:33.000000+08:00",
  "description": "<HTML/原文，透传>",
  "id": "I2N6",
  "labels": [],
  "priority": "medium",
  "state": "finished",
  "title": "2022.2.25 流水表重构代码评审"
}
```
- 不存在的 issue：stderr `API error (500): `（**消息为空，冒号后直接结束**），退出码 1。
- `-w`：`Opening {host}/osc/{owner}/issues/{n} in your browser.`

#### `gh issue create`（描述：`Create a new issue.`）

Flags：`--assignee string`（Assignee ID.）、`-b, --body string`、`-F, --body-file string`（`-` = stdin）、`--branch-name string`（Related branch.）、`--due-date string`（Plan finish time.）、`--iid int`（`0` = 自增，`>0` 显式指定）、`-l, --label string`（逗号分隔）、`--plan-started-at string`（Plan start time.）、`--priority string`（默认 `unassigned`，可选 `unassigned, low, medium, high, urgent`）、`-t, --title string`（**必填**）。

- 缺 `--title`：stderr `Error: required flag(s) "title" not set` + Usage，退出码 1。
- 成功：`POST {base}/projects/{path}/issues` 后 stdout 打印（字符串常量确认）：
  `Created issue #{ident}: {title}`（`ident` 为 issue key，推断——成功路径未实测以免产生副作用；mock 按此模板）。
- 退出码 0。

#### `gh issue comment <number>`（描述：`Add a comment to an issue.`）

位置参数：1 个。Flags：`-b, --body string`（The comment body text）、`-F, --body-file string`。
- `-b`/`-F` 都缺：stderr `Body is required. Use --body or --body-file.`，退出码 1。
- `-F -` 从 stdin 读；文件读失败：stderr `Failed to read body file: {err}`。
- 成功：`POST {base}/projects/{path}/issues/{n}/notes`，stdout：`Comment posted on Issue #{n}`，退出码 0。

#### `gh issue close <number>`（描述：`Close an issue.`）

位置参数：1 个。Flags：`-c, --comment string`（Leave a closing comment.）。
- 成功：先关 issue，stdout：`Closed issue {n}`（常量 `Closed issue %v`，**无 `#`**），退出码 0。
- 带 `-c`：先关后评论；关成功但评论失败时 stderr 警告 `Issue closed, but failed to post comment: {err}`（退出码推断仍 0，未实测）。
- 失败：`API error (...)`，退出码 1。

---

### 2.5 `gh pr`

#### `gh pr list`（描述：`List pull requests in a repository.`）

Flags：`-a, --assignee string`、`-A, --author string`、`-B, --base string`（Filter by base branch.）、`-H, --head string`（Filter by head branch.）、`-l, --label string`、`-L, --limit int`（默认 30）、`--order_by string`（默认 `created_at`，可选 `updated_at, created_at`）、`-S, --search string`、`--sort string`（默认 `desc`，`asc|desc`）、`--state string`（默认 `opened`，可选 `opened, closed, merged, all`）、`-w, --web`。
**命名坑（1:1 照抄）**：`--order_by` 是**字段**，`--sort` 是**方向**——名字与直觉相反。

行为：`GET {base}/projects/{path}/merge_requests?order_by={order_by}&page=1&per_page={limit}&sort={sort}`（实测顺序即 `order_by&page&per_page&sort`；filters 推断同名查询参数）。

文本输出（stdout）：
```
<空行>
Showing pull requests in {owner}
<空行>
ID  TITLE  STATE  BRANCH
{iid}  {title}  {state 原样小写}  {source_branch} -> {target_branch}
```
- 表头行**没有数量**（与 repo/issue list 不同）。
- `STATE` ∈ `opened|closed|merged`（API 原值小写；`drafted` 未实测）。
- `BRANCH` 模板：`{head} -> {base}`（空格-箭头-空格）。
- 0 行：`No pull requests found.`
- 实测样例：
  ```
  Showing pull requests in acme/group

  ID  TITLE                                         STATE   BRANCH
  6   [DevOps] Automatic release version v20261030  opened  release_20261030 -> master
  ```
- `--json` 非空（实测）：**`data` 直接是数组**（元素为**完整 PR 对象**，同 `pr view --json` 的字段集，字母序），外层：
  ```json
  { "data": [ {完整PR}, ... ], "meta": { "current_page": 1, "total_count": 6, "total_pages": 3 } }
  ```
- `--json` 空列表（实测，**单行、无缩进**）：`{"message":"No pull requests found."}`
- `-w`：推断 `Opening {host}/osc/{owner}/pulls in your browser.`

#### `gh pr view <number>`（描述：`View details of a pull request.`）

位置参数：1 个（iid）。Flags：`-c, --comments`、`-w, --web`。

文本输出（stdout，实测）：
```
{title} (#{iid})
{ANSI}{state}\x1b[0m • {author.name} wants to merge {source_branch} into {target_branch}
<空行>
  {description | (no description)}
```
- 第二行状态带 ANSI 色：`opened`→`\x1b[32m`（绿）、`merged`→`\x1b[35m`（品红）、`closed`→`\x1b[31m`（红）；`drafted` 未实测（推断无色或复用，二进制中仅 32/35/31 三色常量）。
- description 为空时打印 `(no description)`（两行都 2 空格缩进）。
- `-c`：**实测无可见效果**——有 8 条 notes 的 PR 加 `-c` 输出与不加完全相同（v1.0.6 未渲染 PR 评论段，属已知缺陷；mock 1:1 即“`-c` 不改变 pr view 输出”）。
- 实测样例：
  ```
  0918 解决压测发现的问题，解决s3的tcp连接不释放的问题 (#1)
  \x1b[35mmerged\x1b[0m • 001839-杨晓兵 wants to merge release_20260918 into master

    (no description)
  ```
  ```
  [DevOps] Automatic release version v20261030 (#6)
  \x1b[32mopened\x1b[0m • DevOps Bot wants to merge release_20261030 into master

    (no description)
  ```
- PR 不存在：stderr `API error (500): PullRequest未找到`，退出码 1。
- `--json`（实测）：完整 PR 对象（字段字母序，全集）：
  `author{name,user_name,avatar_url,state,web_url}`、`can_be_merge`、`can_merge`、`can_operation_conflict`、`can_resolved_conflict_files`、`changes_count`、`closed_at`、`closed_by`、`created_at`、`description`、`diff_refs{base_sha,head_sha,start_sha}`、`full_path`、`general_org_reviewers`、`general_reviewer_num`、`general_reviewers`、`has_conflict`、`id`、`iid`、`is_squash_merged`、`labels`、`merge_commit_sha`、`merge_status`、`merged_at`、`merged_by`、`pr_auto_merge_enabled`、`primary_org_reviewers`、`primary_reviewer_num`、`primary_reviewers[]`（含 `approve_status,assign_type,avatar,avatar_url,can_not_edit,childs,created_at,email,html_url,...`）、`project_id`、`project_name`、`project_path`、`resolved_conflict_files_count`、`restrict_merge_type`、`sha`、`should_remove_source_branch`、`show_conflict`、`source_branch`、`source_project_id`、`squash_commit_sha`、`state`、`target_branch`、`title`、`updated_at`、`user_notes_count`、`web_url`、`work_items`。
- `-w`：`Opening {host}/osc/{owner}/pulls/{n} in your browser.`

#### `gh pr diff <number>`（描述：`View the diff of a pull request.`）

- 成功：stdout 打印**原始 unified diff**（逐字透传，含 `--- a/...` / `+++ b/...` / `Binary files ... differ` / `@@ ... @@` 等，无任何装饰/截断）。
- PR 无 diff：stdout `No diffs found or PR is empty.`（字符串常量确认）。
- PR 不存在：`API error (500): PullRequest未找到`，退出码 1。

#### `gh pr create`（描述：`Create a pull request.`）

Flags：`-B, --base string`（**必填**）、`-b, --body string`、`-F, --body-file string`（`-`=stdin）、`-d, --draft`、`-H, --head string`（**必填**）、`-l, --label string`（逗号分隔）、`--primary_reviewer_ids string`（逗号分隔 ID）、`--primary_reviewer_num string`（默认 `"0"`）、`-r, --reviewer string`（`--primary_reviewer_ids` 的别名）、`--remove-source-branch`、`-t, --title string`（**必填**）。

- 缺必填：stderr `Error: required flag(s) "base", "head", "title" not set` + Usage，退出码 1（多 flag 按字母序列出）。
- 成功：`POST {base}/projects/{path}/merge_requests`，stdout：`Pull request created!`（**不带编号**），退出码 0。

#### `gh pr edit <number>`（描述：`Edit a pull request.`）

Flags：`-b, --body string`、`--state-event string`（默认 `opened`，可选 `closed, opened, drafted`）、`-t, --title string`。
- 成功：`PUT {base}/projects/{path}/merge_requests/{n}`，stdout：`Pull request edited.`，退出码 0。

#### `gh pr review <number>`（描述：`Submit a review comment on a pull request.`）

Flags：`-a, --approve`（Approve pull request）、`-b, --body string`（Review comment body.）、`-F, --body-file string`、`-c, --comment`（Leave a general comment）、`-r, --request-changes`（Request changes to a pull request）。
- 语义：`-a/-c/-r` 三选一决定 review 动作（推断：approve→`approved`、comment→`comment`、request-changes→`request-changes` 状态值，提交到 `POST .../reviews`）。
- 无动作 flag 或 body 缺失时按 `Body is required. Use --body or --body-file.` 处理（推断；精确校验文案未实测）。
- 成功：stdout：`Review submitted on PR #{n} with state: {state}`，退出码 0。

#### `gh pr merge <number>`（描述：`Merge a pull request.`）

Flags：`-b, --body string`（Body text for the merge commit.）、`-d, --delete-branch`、`-m, --merge`（**默认 true**，Merge the pull request (default)）、`-r, --rebase`、`-s, --squash`、`-t, --subject string`。
- 合并方式 flag 互斥：`-m`（默认）/`-r`/`-s`，对应 API `merge_method` = `merge|rebase|squash`（推断）。
- 成功：`POST {base}/projects/{path}/merge_requests/{n}/merge`，stdout：`Merged Pull Request #{n}`，退出码 0。
- 失败（如 PR 不存在）：stderr `API error (500): PullRequest未找到`，退出码 1。

#### `gh pr comment <number>`（描述：`Add a comment to a pull request.`）

位置参数：1 个。Flags：`-b, --body string`、`-F, --body-file string`。
- 无 body：`Body is required. Use --body or --body-file.`，退出码 1。
- 成功：`POST {base}/projects/{path}/merge_requests/{n}/notes`，stdout：`Comment posted on PR #{n}`，退出码 0。

#### `gh pr close <number>`（描述：`Close a pull request.`）

Flags：`-c, --comment string`（Leave a closing comment.）。
- 成功：stdout `Closed Pull Request #{n}`（带 `#`，与 issue close 不同），退出码 0。
- 关成功但评论失败：stderr `PR closed, but failed to post comment: {err}`（推断退出码 0）。

#### `gh pr reopen <number>`（描述：`Reopen a pull request.`）

无 flag。成功：stdout `Reopened Pull Request #{n}`，退出码 0。

---

## 3. API 契约（mock 后端 / 联调参考）

Base：`{base_url}`（默认 `http://gitee.example/api/v8`）。所有请求头：`Private-Token: {token}`、`Oauth: enabled`。路径中的仓库路径需 **URL 编码**（`/` → `%2F`，实测 `projects/osc%2FUAF%2Fgravity-2.0/issues`）。

| 用途 | 方法与路径 | 已知 query | 响应 `data` 形状 |
| --- | --- | --- | --- |
| 用户（auth 验证/login/status） | `GET /user` | — | 用户对象（`name, username, email, git_email, ...`） |
| 仓库列表 | `GET /projects` | `order_by&page&per_page`（`keywords` 推断） | **数组**（元素 = 仓库对象） |
| 仓库详情 | `GET /projects/{path}` | — | 仓库对象 |
| 仓库文件 | `GET /projects/{path}/repository/files/{file}` | 分支参数推断 | 文件内容 |
| issue 列表 | `GET /projects/{path}/issues` | `page&per_page`（`state/label/assignee/author/search` 推断） | **对象 `{"list":[issue]}`** |
| issue 详情 | `GET /projects/{path}/issues/{n}` | — | issue 对象（含 `ident, iid, noteable_count, jump_info, author, project`） |
| issue 创建 | `POST /projects/{path}/issues` | —（JSON body：title/description/labels/assignee/priority/due_date/plan_started_at/branch_name/iid） | issue 对象 |
| issue 评论 | `POST /projects/{path}/issues/{n}/notes` | —（JSON body） | note 对象 |
| issue 关闭 | 方法推断 `PATCH/PUT /projects/{path}/issues/{n}` | —（state=finished/rejected 推断） | issue 对象 |
| issue 评论读取（`-c`） | `GET /projects/{path}/issues/{n}/notes` | — | notes 数组（`author.name` + 时间 + 文本） |
| PR 列表 | `GET /projects/{path}/merge_requests` | `order_by&page&per_page&sort`（filters 推断） | **数组**（元素 = 完整 PR 对象） |
| PR 详情 | `GET /projects/{path}/merge_requests/{iid}` | — | 完整 PR 对象 |
| PR 创建 | `POST /projects/{path}/merge_requests` | —（source_branch/target_branch/title/description/draft/labels/primary_reviewer_ids/primary_reviewer_num/remove_source_branch） | PR 对象 |
| PR 编辑 | `PUT /projects/{path}/merge_requests/{iid}` | —（title/description/state_event） | PR 对象 |
| PR diff | `GET /projects/{path}/merge_requests/{iid}/diffs` | — | diff 文本（CLI 直接透传） |
| PR 合并 | `POST /projects/{path}/merge_requests/{iid}/merge` | —（merge_method/commit 消息，推断） | PR 对象 |
| PR 评论 | `POST /projects/{path}/merge_requests/{iid}/notes` | — | note 对象 |
| PR review | `POST /projects/{path}/merge_requests/{iid}/reviews` | —（state + body，推断） | review 对象 |
| PR 关闭/重开 | 方法推断 `PATCH/PUT .../merge_requests/{iid}` | —（state_event closed/opened） | PR 对象 |

通用 envelope：`{"data": ..., "meta": {"current_page": int, "total_pages": int, "total_count": int}}`。
- **注意 data 形状不对称**：`/projects` 与 `/merge_requests` 的 data 是**数组**；`/issues` 的 data 是 **`{"list": [...]}`** 对象。CLI 的 `--json` 输出基本原样透传该 envelope（repo/issue list 重新包成 `data.list`，pr list 保留 `data` 数组——见 §1.9）。
- issue 对象关键字段（API 原始）：`id`(大数)、`iid`(CLI 展示用)、`ident`(key 如 `I2N4`)、`title`、`description`、`priority`、`state`(created/processing/rejected/finished)、`noteable_count`、`labels[]`、`author{name,username,...}`、`jump_info{full_path,full_name,project_name}`、`created_at/updated_at`。
- 401/403：`API error (401/403): ...`（403 实测文案 `token验证失败!`）。
- 404 类资源缺失：Gitee 返回 **500** + 业务消息（如 `PullRequest未找到`、`未找到关联的相关仓库的信息`；issue 缺失时消息为**空串** → `API error (500): `）。

---

## 4. 已知缺陷与边界行为（1:1 mock 必须复现或显式豁免）

1. **`-R` 单段值 → Go panic**：`gh any-repo-cmd -R badformat`（无 `/`）触发 `panic: runtime error: index out of range [0] with length 0` + 完整 goroutine 栈，**退出码 2**。
2. **`pr view -c` 无效**：加 `-c` 输出与不加完全一致（PR 评论段未实现）。
3. **文本表格 total 恒 0**：`Showing {n} of 0 ...`（无论 meta.total_count）。
4. **`--json` 值被忽略**：存在即生效（`--json false` 也触发）；string 类型但无需值。
5. **空结果 JSON 不对称**：`pr list` 空 → `{"message":"No pull requests found."}`；`issue list` 空 → `{"data":{"list":[]},"meta":{...}}`。
6. **脏 UTF-8 透传**：API 截断的半个 UTF-8 字符直接透传到 stdout，不替换不报错。
7. **CJK 表格错位**：按 §1.7 算法自然产生，属预期行为。
8. **`repo list` per_page 上限 100**：API 侧截断，`-L 215` 只出 100 行。
9. **`config get token` 输出掩码**（推断）。
10. **`--debug` 请求头打印顺序不固定**（Go map 迭代）；token 掩码 `YzAx****`（仅前 4）。
11. `issue close` 成功消息**无 `#`**（`Closed issue 123`），`pr close` **有 `#`**（`Closed Pull Request #123`）——不对称，照抄。
12. 表格“Showing”行与表头之间、表头与数据之间**各有且仅有一个空行**；列表开头还有一个前置空行（结构：`\nShowing...\n\n表头\n数据...`）。

---

## 5. 验收清单（对 mock 直接跑，与真实输出 diff）

```bash
# 身份与帮助（退出码 0）
gh --version            # → gh version gitee-cli 1.0.6
gh                       # → 根帮助全文
gh help pr view          # → pr view 帮助全文（与 §2.0 块逐字一致）

# 参数错误路径（退出码 1，stderr 逐字一致）
gh frobnicate            # → Error: unknown command "frobnicate" for "gh"
gh issue view           # → Error: accepts 1 arg(s), received 0 + Usage
gh pr create            # → Error: required flag(s) "base", "head", "title" not set + Usage
gh -R badformat repo list   # → Go panic + 退出码 2（或 mock 豁免项）

# 认证
gh auth status          # 4 行模板（§2.1）
gh auth status --json   # 4 行 JSON Lines
gh config list          # 7 行模板（§2.2，注意 %-15s 对齐）
gh config get base_url  # 单行值
gh config get bogus     # Unknown config key + Available keys，退出码 1

# 列表（表格对齐 + 空行结构 + "of 0" quirk）
gh repo list -L 10
gh issue list -R osc/UAF/gravity-2.0 --state all -L 5
gh pr list -R acme/group/demo --state all -L 5

# 详情（ANSI 色码 + 字节级模板）
gh issue view 4 -R osc/UAF/gravity-2.0 -c
gh pr view 1 -R osc/ecm/ecm-dm        # merged → \x1b[35m
gh pr view 6 -R acme/group/demo       # opened → \x1b[32m
gh pr diff 1 -R osc/ecm/ecm-dm
gh repo view acme/group/demo

# JSON 模式（与 §2 各节样例逐字 diff）
gh repo list -L 3 --json
gh issue list -R osc/UAF/gravity-2.0 --state all -L 2 --json
gh pr list -R acme/group/demo --state all -L 2 --json
gh pr list -R <无PR仓库> --state all --json   # → {"message":"No pull requests found."}
gh repo view acme/group/demo --json
gh issue view 1 -R acme/group/demo --json     # 8 字段
gh pr view 1 -R osc/ecm/ecm-dm --json

# 调试/浏览器
gh repo list -L 1 --debug    # stderr 双段 DEBUG 框（§1.8）
gh repo view acme/group/demo -w   # Opening ... in your browser.（URL 规则 §1.11）

# 错误路径
gh issue view 999999 -R acme/group/demo   # API error (500): PullRequest未找到 / issue 空消息
```

---

## 6. 原始采集材料（.ghspec 目录，供回归比对）

- `help/help_*.txt` — 全部 31 个命令/子命令的 `--help` 原文
- `rl.txt, rl2.txt, rl_all.txt` — `repo list` 原始输出（100 行级）
- `il1.txt, il2.txt, il3.txt` — `issue list` 原始输出（含 CJK 错位样本）
- `prlist_*.txt` — 5 个仓库的 `pr list` 原始输出
- `api_issue_list.txt, api_pr_list.txt` — `--debug` 捕获的原始 API 请求/响应
- `pr1.json` — `pr view --json` 完整对象；`repo_view.json` — `repo view --json` 完整对象
- `found_issues.txt, found_prs.txt` — 可用于回归的 issue/PR 仓库清单

> 采集约束：除一次 `auth login`（同值回写 keyring）、一次 `config set`（文件已删）、一次 `repo clone`（目录已删）、一次 `--web`（开 1 个浏览器标签）外，全部探测均为只读。
