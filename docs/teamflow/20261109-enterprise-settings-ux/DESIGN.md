# 企业设置四页精简设计（V1，已确认）

> 代拟：Agent 起草，2026-11-09 用户逐条确认（合并七行为两行；Gitee 高级折叠；DevOps 保留应用/检查但去术语）。

## 1. 目标与非目标

目标：不改信息架构（仍是四个 `settings.section`），把每页的冗余、术语与免责声明收敛到「一行一个动作 + 一个可展开详情」。

非目标：

- 不合并分区、不新增跨插件设置面板接口、不改 order（企业研发 29 / 企业账号 30 / Gitee 50 / DevOps 60）。
- 不改任何能力边界：企业研发仍然只读、只发一次 `?refresh=1`；Gitee 分区仍不发探测请求；不新增写接口、不授予权限。
- 不改服务端、契约字段、`src/*.mjs`；只改 `client.js` 与对应测试。

## 2. 全局规则

1. **每页一问**：研发页=「我现在能不能用」；账号页=「我是谁、Key 配了没有」；Gitee/DevOps 页=「本机和企业分发有什么不同」。
2. **一行一句话**，状态词 + 一句 ≤20 字的说明；技术口径（基准 revision、来源类型、四层证据、插件版本、读取时间）只在 `<details>` 里出现，默认收起。
3. **免责每页最多一条**，统一句式：`本页只显示本机可见性，不代表业务授权。`
4. **三档用词**替代“未知”：
   - `未提供来源`：接口没给这个字段 / 本机无来源；
   - `尚未检查`：可检查但还没查；
   - `检查失败`：查了但失败。
   `readiness.state.unknown` 仍可作为兜底，但主列表不得直接显示裸“未知”。
5. **术语表**：`dop` 首次出现写「dop 命令」；`CLI`→「命令」；`凭据`→「个人 Key」（除 IAM 页的「个人访问凭证」保留）；`只读面 ready`→「只读命令可用」；`自动发现命中`→「已自动找到」。
6. 分区页脚 `分区由 @heluo/xxx 0.1.0 提供 · 读取于 …` 从 Gitee/DevOps 两页删除；版本与时间只在研发页详情出现。

## 3. 页面 A：企业研发（`packages/forge-devops/client.js` → `ReadinessSection`）

### 3.1 结构

```
⚠ N 项待处理 · <一句主因>              （无待处理时：✅ 可以开始）
[刷新]

① 身份与 Key    未登录 · 未配置个人 Key        [登录企业账号]   详情
② 本机工具      dop 已找到 · Gitee 未配置      [查看]           详情

本页只显示本机可见性，不代表业务授权。公共参数由企业分发；写权限由企业侧判定，本页不判断。
```

- 行数固定 2 行：`identity`（合并原 identity + key）、`tools`（合并原 local + devops + gitee）。原 `public`、`write` 不再占行。
- 顶部摘要行：统计 warn 行数；1 项时用该行说明，≥2 项时用「先处理身份」类一句；0 项时 `✅ 可以开始`。
- 每行右侧「详情」= 现有 `<details>` 内容（三层来源、插件名与版本、四层证据、检查四项），但**按成员分组**：identity 组内放 identity/key，tools 组内放 local/devops/gitee。
- `公共参数：未提供来源`、`写权限：不判断` 两行只在所属行的详情里出现（identity 详情放开头，tools 详情放末尾）。
- 「检查 DevOps」按钮移进 tools 行（保持 disabled=busy、只打 `?refresh=1`）；Gitee 的禁用按钮与原因文案留在 tools 行，`title` 保留。
- 检查四项 + 四层证据渲染不变，仍在 tools 详情内；`检查：未检查 / 检查：通过 …` 一行保留在详情底部。

### 3.2 聚合规则（不得含糊）

- 组状态取成员里**最差的 tone**：`warn > quiet > ok`；同 tone 取更靠前的成员。
- identity 组主状态 = identity 行状态；key 状态写在说明位（`未配置个人 Key` / `Key 未验证` / `Key 已验证`），不覆盖主状态。
- tools 组主状态 = devops 行状态；说明位拼 `dop…` + `Gitee…`，用 ` · ` 连接。
- 组的下一步 = 成员里第一个 `next.kind === 'navigate'` 或 `=== 'button'` 的动作；没有则显示成员第一条文字说明。
- 三源读取失败仍只影响自己那一行/组，不得清空别组（保留既有反例测试语义）。

### 3.3 文案键（zh 为准，en 同步）

| 键 | 值 |
|---|---|
| `readiness.row.identity` | 身份与 Key |
| `readiness.row.tools` | 本机工具 |
| `readiness.summary.pending` | 待处理 |
| `readiness.summary.ready` | 可以开始 |
| `readiness.summary.hint` | 先处理身份与 Key |
| `readiness.key.unconfigured` | 未配置个人 Key |
| `readiness.key.unverified` | Key 未验证 |
| `readiness.key.verified` | Key 已验证 |
| `readiness.tools.dop.ready` | dop 已找到 |
| `readiness.tools.dop.missing` | dop 未找到 |
| `readiness.tools.gitee.unconfigured` | Gitee 未配置 |
| `readiness.tools.gitee.ready` | Gitee 已配置 |
| `readiness.detail.title` | 详情 |
| `readiness.detail.public` | 公共参数：企业分发，本机不可改 |
| `readiness.detail.write` | 写权限：由企业侧判定，本页不判断 |
| `readiness.footer` | 本页只显示本机可见性，不代表业务授权。公共参数由企业分发；写权限由企业侧判定，本页不判断。 |

保留 `readiness.state.*` 与证据相关键不动；删除仅因七行存在的死键（例如 `readiness.row.public` / `row.write` / `row.devops` / `row.gitee`，以及以点号加 local 结尾的那一个 若不再被引用，按字典等值测试要求同步删 zh/en 两侧与引用）。

### 3.4 测试改动（`packages/forge-devops/test/readiness-section.test.mjs`）

- 「七行顺序与标签固定」→「两行顺序与标签固定，摘要行与页脚恒在场」，断言 `identity`/`tools` 顺序、行文本、摘要统计、`readiness.footer` 全文。
- 「四组反例各自只改自己那一行」→ 改为只改自己那一组；其余组逐字不变。
- 「Key 五态映射」「身份六态」→ 断言到说明位与详情，不再断言独立行。
- 「导航」「迟到回包」「检查 ?refresh=1」「检查四项」「四层证据」「过期」「Gitee 不发请求」「只 GET 不写」「三层来源」「脱敏」「标签非空」「D-1 未检查词」「D-2 不可达文字入口」→ 全部保留，选择器改为组内定位。
- 新增：`主列表不出现裸「未知」`（断言 `.fdv-row-state` 文本不含「未知」）；`每页免责只一条`。
- 字典等值测试保留（zh/en 键集相同、无未引用键）。

## 4. 页面 B：企业账号（`packages/forge-iam/client.js`）

- 未登录时**只展开第一步**（登录企业账号），第二步（个人访问凭证）与第三步（模型）折叠成一行可点击的 `登录后可配置`；登录后三步全部展开，步骤条高亮当前步。
- 问题清单只显示**最高优先级一条**（冲突 > 不完整 > 尚未设置），其余进 `查看全部问题` 折叠。
- 合并重复：`个人访问凭证：状态未知` 与 `网关凭据状态尚未确认，请刷新核实` 合成 `凭据状态尚未确认`；删除底部与顶部按钮重复的 `下一步：登录企业账号。`。
- `复制问题信息` 收进 `诊断` 折叠（默认收起），仍在诊断里可点。
- 免责保持一条：`登录只建立身份，不代表已获得业务写权限。`

## 5. 页面 C：Gitee（`packages/forge-gitee/client.js`，标签改名）

- 分区标签 `nav`/`title`：`企业 Gitee` → `Gitee`（en：`Gitee`）。同步 `tests/ui-contract.test.mjs` 中若断言标签文本的地方。
- 顶部一句：`公共参数由企业分发；这一页只改本机差异。`
- 删除三列表头（字段/公共参数/本机覆盖/最终生效），改为行卡：
  - `命令行入口`：值「已自动找到 gh」或当前覆盖值；动作 `手动指定` / `改为自动`；
  - `命令超时`：值 `20 秒（默认）` 或覆盖值；动作 `修改`；
  - `服务地址与凭据`：`由企业分发，本页只读`，无输入框；
  - `高级 · 通常不用改`（`<details>`，默认收起）：`凭据变量名`、`持久化令牌策略`，只读展示，说明改为 `由运行期决定，不在本页修改`。
- 只在**与公共值不同**时显示覆盖值；相同显示 `沿用公共值`，不得出现一排「未配置」。
- 删除页内「检查详情」整段与 `分区由 … 提供 · 读取于 …` 页脚。
- 保存/刷新/错误提示保留；校验规则与持久化字段不变。

## 6. 页面 D：DevOps（`packages/forge-devops/client.js` → `DevopsSection`，标签改名）

- 分区标签：`企业 DevOps` → `DevOps`（en：`DevOps`）。
- 顶部一句：`插件会自己找 dop；只有找不到时才需要指定。`
- 字段区两行：
  - `dop 可执行文件`：`已自动找到` 或显示覆盖值；动作 `改为手动` / `重新自动发现`；
  - `命令超时`：`20 秒（默认）` 或覆盖值；编辑态说明一句 `命令超过这个时间就判失败`。
- 回执区改为一句 + 两按钮。本包没有独立「应用」请求（保存 POST 成功后服务端即重建读面并回 `applied`），所以不造第二个按钮：
  - 主按钮仍是 `[保存]`，请求与语义不变；旁边 `[检查]`（`?refresh=1` 只读重扫）。
  - 回执一句按状态取：`未保存` / `已保存 · 已生效` / `已保存 · 未生效（{reason}）` / `已保存 · 生效状态未知`（响应没有 `applied` 键时）。
  - 按钮下方两行小字：`保存：写入本机覆盖，服务端会立即按新配置重建。`、`检查：只读试跑一次，不会改动数据。`
- 删除：`只读面 ready`、`自动发现命中`、`1000–600000，默认 20000`、以及 `保存：已保存 / 应用：未知 / 检查：未执行` 三连。
- 保存/应用/检查三个动作的语义与请求不变（保存不自动应用；检查只读）。

## 7. 测试与验收

- 每包先改测试跑红，再改视图。命令：
  - `node --test packages/forge-devops/test/*.test.mjs`
  - `node --test packages/forge-gitee/test/*.test.mjs`
  - `node --test packages/forge-iam/test/*.test.mjs`
  - `node --test tests/ui-contract.test.mjs`
- 收口：`pnpm check` 全绿；`node scripts/check-docs.mjs` ok；`git diff --check` ok。
- 上屏复验由主 agent 在一次性 profile 做，本轮不改日常 profile；结果与三处实机缺陷见 [VERIFICATION.md](VERIFICATION.md)。

## 8. 禁止

- 不新增接口、工具、权限或写入路径；不把只读页改成可写。
- 不改 order、分区 id、注入常量；不在 `src/` 增加逻辑。
- 不引用真实企业地址、凭据、账号；示例一律 `corp.example`。
- 不删除既有安全不变量测试（迟到回包、过期、Gitee 零请求、脱敏、标签非空）。
