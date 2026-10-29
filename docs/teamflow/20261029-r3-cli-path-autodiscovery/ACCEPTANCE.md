# ACCEPTANCE.md — CLI 路径自动发现与 Web 配置页（20261029-r3）

> 阶段：验收（acceptance）｜分支 `feat/devops-change-flow`｜HEAD `041315e`｜交付形态：**未提交改动**（10 改 + 13 未跟踪 = 12 个新文件 + 本任务夹）
> 验收时间：2026-10-29 16:52–16:58 CST｜OS：macOS 26.5.1 / Darwin arm64｜Node `v24.13.0`｜宿主 DSH CLI `0.2.1-rc.2`（包 `engines.dsh >=0.2.1-rc.2`；仓库目标 `0.2.1-rc.3` 差分 **NOT RUN**）
> 来源类型：**本机离线实测**（mock dop、注入 win32 平台、假 fs/假 configEditor、隔离 profile）。**企业实测 0 条**；Windows 真机与真实浏览器点击均为 NOT RUN。

## 1. 验收结论摘要

**通过（可验收）**。PRD 的 15 条 AC（P0 九条 / P1 六条）逐条有可复跑证据，P0 无缺口；架构与 tech 蓝图逐模块对位，无「应抽未抽」、无未被门禁守护的重复实现；既有安全语义零回退。唯一遗留为 1 条 P3 源码注释错指（功能零影响）。Windows 实机、真实浏览器、真实 profile 重启属环境限制，已按 AC-13 标注 NOT RUN 并转入人工补测，不构成交付缺陷。

## 2. 独立复核证据（验收人在最终树上亲自实跑，非转述 QA）

| # | 命令 | 实测结果 |
|---|---|---|
| 1 | `pnpm check` | exit 0 · **1211/1211** pass · docs / repo / 全仓测试全绿 |
| 2 | `cd packages/forge-devops && node --test "test/*.test.mjs"` | exit 0 · **425/425** pass |
| 3 | `bash logs/…/install-load-probe.sh` | exit 0 · **PASS install+load**（隔离 profile：装入 → 激活 → 9 工具 → 卸载） |
| 4 | `node logs/…/qa-r3-cli-mainpath.mjs` | exit 0 · **13/13**（A1–A6 / B1–B7，含状态码矩阵与 4097 字符零写盘） |
| 5 | `node logs/…/qa-r3-client-render.mjs` | exit 0 · **14/14**（渲染态保存 / 409 / 降级只读 / 失焦即拒） |
| 6 | `node logs/…/qa-r3-rule-parity.mjs` | exit 0 · 一致 **26/27** · 委托 1 · **漂移 0** |
| 7 | `qa-r3-client-mount` / `qa-r3-interface` / `t1-discovery-to-access` / `assembly-e2e` | exit 0 · 4/4 · 5/5 · 3/3 · status ok / 9 tools |
| 8 | 直读内核（不经 QA） | 清单 `exports['./client']` + `dsh.client{web,slots,locale}` + `files` 含 `client.js` 三项齐；`index` 导出 `Config=ConfigStandard` 与服务四方法；`http` 导出前缀/预检头/`createCliApi`/`toNodeRoute` 且全响应 `cache-control: no-store`；`cli-access` 返回 `{entryId, revision, snapshot, describe, save}`；`READ_REASONS` 恰 **11** 码；工具面 **9** 个（4 读 + 5 流程）；`cli-discovery` 的 `child_process/execSync/spawn` 计数 **0** |
| 9 | 行为抽查（直接调模块） | `describeCliAccess` 输出正则零路径、零 endpoint；`cliGuidance` = `未找到 dop · 已查 配置、环境变量、PATH、候选目录 · 请到「设置 → DevOps 变更流程」指定位置`；env 层 `dopBin/sourceType` 归 `origin=env` 且 ready |

## 3. 逐条 AC 核对（PRD 15 条）

| AC | 级别 | 判据要点 | 验收证据（可复跑） | 结论 |
|---|---|---|---|---|
| AC-1 零配置可用 | P0 | 无 `FORGE_DEVOPS_*` 时发现命中即 ready | 主路径 A1/A2（注入 win32 + 假 fs）；`t1` 3/3；install+load PASS | 通过（逻辑面）；**Windows 真机 NOT RUN** |
| AC-2 只认直接可执行 | P0 | 只认 `.exe`/执行位，包装脚本不选、零子进程 | 跨面矩阵 wrapper 两侧；`cli-discovery` 零 `child_process`；全仓 selfcheck 扫描 | 通过 |
| AC-3 三层优先级 + origin | P1 | config > env > discovered，页面与状态可见 | 主路径 A3；`cli-config` 表驱动用例；渲染 2/7；验收人直跑 env 层得 `origin=env` | 通过 |
| AC-4 发现成本有界 | P1 | 仅装配/刷新扫；200 目录 ≤300ms | A4 `no-scan=12 / after-refresh=24`（读快照不新增 readdir）；A5 200 dirs **3.9ms** | 通过 |
| AC-5 找不到即如实失败 | P0 | fail closed + reason + 类别名 + 指引、零路径 | A6 `CLI_NOT_FOUND`；`cliGuidance` 实跑只含类别名与配置页指引 | 通过 |
| AC-6 真实配置页可达 | P0 | ≤2 点击、一屏 6 字段、离线 | 渲染 1/3（`settings.section` id=devops order=60；6 字段 = 5 文本 + 1 段控）；`client.js` 零外部 URL/字体/图片 | 通过（DOM 级）；**真实浏览器点击 NOT RUN** |
| AC-7 页面即状态 | P1 | 只读展示 + 覆盖/清空回落 + 重新发现 | 渲染 2/4/6/10；B3 `edits=1`（等值不写噪声） | 通过 |
| AC-8 保存即持久 | P0 | 写活动 profile 补丁、重启仍 ready、不落工作区 | 渲染 7（真 POST → 假 configEditor 收到写入）；B4 重启 ready → 清空 → 自动发现；`git status` 无仓库内新增；`cli-access` 无直接写盘调用 | 通过（后端形状）；**真实 profile 重启 NOT RUN** |
| AC-9 非法值逐字段拒 | P0 | 逐字段原因、冲突不覆盖、原配置不动 | 矩阵 26/27 漂移 0；B2 400/409/422/503；B7 4097 字符 → 422 且 `edits=0`、4096 不误伤 | 通过 |
| AC-10 回显边界 | P0 | 路径/endpoint 只在配置页内 | B5：错误体/响应头/脱敏描述零路径；验收人直跑 `describeCliAccess` 零命中 | 通过 |
| AC-11 环境变量仍可用 | P1 | 三层互不排斥，任一成功即可用 | 三层矩阵 env 行；验收人直跑 env 解析 ready | 通过 |
| AC-12 文档 UI 优先 | P1 | 配置页步骤在前、环境变量降为兜底、六键表 | `packages/forge-devops/README.md`：`配置（配置页优先，环境变量兜底）` 在 `环境变量兜底（CI / 无界面 profile）` 之前，含六键表与 `.exe` 限制；补丁注释同口径；仓库内另无在册 devops 安装/UAT 长文（旧长文仅存于未合并 worktree） | 通过 |
| AC-13 证据纪律 | P0 | 命令/时间/宿主/OS/来源类型齐全，未跑标 NOT RUN | `QA-REPORT.md` §1–§9 + 本文件 §2/§5；未跑项逐条标 NOT RUN | 通过 |
| AC-14 零回退 | P0 | 白名单/四状态/幂等/审计/提交信息校验不退化 | 包内 425/425、根 1211/1211、`READ_REASONS` 11 码、工具 9 个、`policy-guard`/适配器未改 | 通过 |
| AC-15 可回滚 | P1 | 清空/卸载回到自动发现、无残留 | B4 清空回落；`cli-access` 全空走删除路径；README「回滚」段 | 通过 |

## 4. 架构一致性（M3 质量门）

- **蓝图对位**：`cli-discovery`（有界发现）/`cli-config`（三层合并+校验+脱敏）/`cli-access`（快照+revision 栅栏+保存）/`http`（同源 GET+POST）/`runtime-config` 增量/`index` 装配/`client.js` 七处逐一对上，导出与蓝图 `api` 字段一致，无缺失模块、无额外职责漂移。
- **无应抽未抽**：文件系统只出现在 `cli-discovery`（`fs`/`now` 全注入）；`configEditor` 只在 `cli-access` 被消费（`index` 仅把服务传进去）；origin 只在 `cli-config` 一处产生。
- **重复实现**：全包唯一内联副本 = `client.js` 的字段规则（浏览器半不能 import 服务端模块，结构性必需），由 `test/client-rule-parity.test.mjs` 跨面矩阵（26/27、漂移 0）双向守护，非裸重复。
- **两个路径面分离**：`snapshot()` 含路径 / `describeCliAccess()` 零路径，是两个函数而非 reveal 开关。
- **既有结构未破**：白名单、四状态、审计、提交信息校验与 `flow.normalizeResolution` 语义未变（仅把 `unavailable` 升级为 `{code,message,detail}` 信封）。

## 5. 遗留、未验范围与风险

1. **R3-1（P3，QA 编号，验收人复核仍在）**：`packages/forge-devops/client.js:52` 注释写「等值关系由 `test/client-shape.test.mjs` 的跨面矩阵用例守着」，实际矩阵在 `test/client-rule-parity.test.mjs`（`client-shape.test.mjs` 内 `MATRIX`/`buildCliPatch`/`validateConfigField` 命中 0）。功能零影响，随后续改动改指即可，不阻断。
2. **NOT RUN（环境限制，非交付缺陷）**：Windows 实机零配置（AC-1/2）、真实浏览器点击走查（AC-6/7）、真实 web profile 重启（AC-8，且该 profile 现存 2026-10-28 的 `file://` UAT 段需先删再装）、`0.2.1-rc.3` 差分、企业 `dop.exe` 离线探针与安装目录分布（PRD openQuestion F1/F2）。
3. **构建产物提示**：`dist/UAT-WINDOWS.md`（11:34 生成的旧口径，仍写环境变量为前置）与 `dist/heluo-forge-devops-0.1.0.tgz`（11:32，早于 r3 改动）位于被 `.gitignore:41` 忽略的 `dist/`，**不属本次交付**，勿作为 r3 包或 UAT 材料分发；发布前须重建。
4. **企业安装/UAT 长文**（`enterprise-install-and-uat.md`）目前只存在于未合并 worktree `.agents/worktrees/fix-acceptance-20261026/`，合入时须按 AC-12 新口径改写。

## 6. 放行建议

本机与离线证据充分，可进入提交/打包阶段；提交面干净（10 改 + 13 未跟踪，无 `node_modules/`、`dist/`、`.env`、日志噪声）。企业内网投产前建议至少补跑 Windows 实机（AC-1/2）与真实浏览器配置页走查（AC-6/7），并把配置页写入后的真实 profile 重启验证（AC-8）列为上线前置。

验收结论：✅ 通过
