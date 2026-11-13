# @heluo/forge-skill-nacos

状态：可用（开发骨架；目录三模式客户端、ZIP 有界校验与原子安装事务、台账（作用域/回收站）、`ctx.skills` Provider、只读+写工具面、**设置面板「企业技能市场」页（Web）**已实现，离线测试与宿主探针通过；企业 Nacos 已本地联调（2026-10-29），安装类动作按范围差异保持关闭）

一句话：把企业 Nacos Skill Registry 接进 DSH 原生技能机制——发现只读、安装固定精确版本、启用后经原生目录/`skill` 工具/`/技能名` 使用；拒绝即零副作用，凭据与可信源配置不进模型上下文。

| 项 | 内容 |
|---|---|
| 需求 | [#97](https://github.com/hrygo/heluo-forge/issues/97)（T1–T5、AC1–AC10） |
| 设计 | [docs/design/plugins/forge-skill-nacos.md](../../docs/design/plugins/forge-skill-nacos.md) |
| 形态 | Host 插件；`inject: skills, tools, credentials`，缺一即不挂载（fail closed） |
| 目录路线 | `console-list`（3.2.x console 只读）/ `client-search`（≥3.3）/ `config-index`（兜底）；下载固定走 client OPEN API |
| 作用域 | 安装可选全局/项目级（台账字段，不写入项目源码树），可随时转换；同名本地技能冲突拒绝安装 |
| 安全边界 | ZIP 有界解包（路径穿越/链接/重复大小写/炸弹/条目数/大小负测）；受管目录在 `$DSH_HOME` 保护圈内；自算 SHA-256 不构成来源认证（见设计 §8） |
| 不做 | 不改 DSH 核心；不执行包内脚本；不安装包声明的依赖；不做外部 Agent 目录管理；不承诺擦除已进入会话的指令 |

## 当前实现

| 项 | 状态 |
|---|---|
| 目录客户端 | 三模式（响应字段名按 Nacos 源码核验防御式解析，P0 实测后定稿） |
| 安装事务 | 下载→校验→staging 隔离→rename 原子提交→台账→`invalidate`；文档锁跨进程互斥 |
| 台账 | `state.json` 0600 原子写；scope/user/project；回收站保留安装身份 |
| Provider | `list/get` 纯本地、rank 700、作用域过滤（`project:<root>` 仅项目内可见） |
| 工具面 | `skill_nacos_search/show` 只读；`install/enable/disable/upgrade/uninstall` 写动作（参数 `target` 对齐 forge-policy 门禁，默认按未登记被拒） |
| Client 面板 | 设置 →「企业技能市场」（`settings.section` 槽）：状态条/搜索/安装/启停/作用域转换/卸载；走 Host prefix 路由（同源校验，与服务/工具同一判定）；`webServer` 缺席时自动跳过路由 |
| 端点契约 | 2026-10-29 本地 Nacos 3.2 实测收敛：console 面（`consoleEndpoint`，默认 8080）与 client 面（`endpoint`，8848+/nacos）分离；`/v3/auth/user/login` 换 accessToken（query 参数携带，TTL 缓存） |
| 轮询 | 有界目录刷新（超时/退避/抖动），刷新零安装副作用 |

## 测试

```sh
node --test packages/forge-skill-nacos/test/*.test.mjs   # 离线：41 例
DSH_BIN=<dsh 可执行文件> node scripts/probe/run-skill-nacos-probe.mjs   # 宿主探针：10 项
```

宿主探针 2026-10-29 在 DSH 0.2.1-rc.3 源码构建上 10/10 通过（sdk profile + 临时 patch 挂载本插件与探针、仿 Nacos、临时 `$DSH_HOME` 隔离；无 `dsh` 时退出码 2 跳过，不伪装通过）。根检查：`pnpm check`

## 未验证 / 待办

- 企业 Nacos 实测（版本矩阵、低权限目录入口、鉴权头、TLS/CA 通道）与 `docs/contracts/skill-nacos-contract.md` 定稿。
- S6/ADR-11/13 范围差异批准前，安装类动作保持关闭。
- forge-policy 受控动作目录登记（`skill-nacos.*`）与审批台账。
- 真实 DSH 宿主探针与三平台实机（AC10）。
- Client 管理面板（PRD P0 面板范围另行准入）。
