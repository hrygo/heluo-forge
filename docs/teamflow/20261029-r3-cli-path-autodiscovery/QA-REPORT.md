# QA-REPORT · 20261029-r3-cli-path-autodiscovery（CLI 路径自动发现 + Web 配置页）

- **结论：通过（可验收）**。上一轮 2 条遗留（R2-1 P2 / R2-2 P3）按原 Check command 复跑**全部转绿**：R2-1 的页面规则已与服务端等值（跨面矩阵 26/27、漂移 0），同类第二处（路径长度上界）在**渲染态**与**HTTP 保存面**都被实测拦住；R2-2 的措辞已改。本轮新增 1 条 P3（源码注释仍指向错误的守护用例），不影响用户路径、不阻断。
- 阶段：qa · **修复复验轮（round 3）**。本文件替代同夹上一轮报告，是本轮唯一结论源。
- 实测时间：2026-10-29 16:44–16:50 CST（Asia/Shanghai）。
- 被测工作区 `feat/devops-change-flow`，HEAD `041315e`，交付全部为**未提交改动**（10 改 + 13 未跟踪 = 12 新文件 + 任务夹目录，见 §7）。

## 1. 范围与环境

被测对象：`packages/forge-devops` 的 CLI 入口自动发现 + 三层合并 + 同源配置路由 + Web 配置页（本需求 15 条 AC，P0 九条）。

| 项 | 值 |
|---|---|
| 工作区 / 分支 / HEAD | 仓库根 `heluo-forge` · `feat/devops-change-flow` · `041315eaf10185ca61c539ac13a58e6326664906` |
| 交付形态 | 未提交（10 改 + 13 未跟踪：12 新文件 + 任务夹目录），不构成提交/推送 |
| OS / Node | macOS（Darwin 26.2 arm64）· node `v24.13.0`（`.node-version` 为 24.21.0，差额不影响本轮判据） |
| 宿主 | DSH CLI `0.2.1-rc.2`（装配/安装实测）；基线 `0.2.1-rc.3` 差分 **NOT RUN** |
| 浏览器 | **沙箱内不可启动**真实 Chromium（受限令牌 + Low 完整性，crashpad 需 `PROCESS_ALL_ACCESS`）——**环境限制，非交付缺陷**；DOM 级端到端用 `node:vm` + 真实 hook 运行时 + 真 HTTP 契约驱动 |

## 2. 回归契约复跑（本需求全部检查器，逐条 pass 计数）

全部在**当前最终树**上实跑；本轮对其中 3 个只做**追加**（新边界用例），未重建、未放宽既有断言。

| # | 检查器 / 命令 | 本轮实测 |
|---|---|---|
| 1 | `bash logs/teamflow/tf-mvt3aw99-wflwsn/scripts/install-load-probe.sh` | exit 0 · `PASS install+load`（隔离 profile：装入 → 激活 → 9 工具 → 卸载） |
| 2 | `node logs/.../scripts/qa-r3-cli-mainpath.mjs` | exit 0 · **13/13**（本轮 +B7，原 12/12） |
| 3 | `node logs/.../scripts/qa-r3-client-render.mjs` | exit 0 · **14/14**（本轮 +1 条，原 13/13） |
| 4 | `node logs/.../scripts/qa-r3-rule-parity.mjs` | exit 0 · **一致 26/27 · 委托 1 · 漂移 0**（本轮 +2 行，原 24/25） |
| 5 | `node logs/.../scripts/qa-r3-client-mount.mjs` | exit 0 · 4/4 |
| 6 | `node logs/.../scripts/qa-r3-interface.mjs` | exit 0 · 5/5 |
| 7 | `node logs/.../scripts/t1-discovery-to-access.mjs` | exit 0 · 3/3 |
| 8 | `node logs/.../scripts/assembly-e2e.mjs` | exit 0 · status ok / 9 tools |
| 9 | `node logs/.../scripts/gate-prefix-proof.mjs` | exit 0 · PASS（反证：修复前的 dopBin 4097、ghOwner 40/45 三点会被门禁判红） |

全仓门禁与包内用例：

| 命令 | 结果 |
|---|---|
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | exit 0 · **425/425** |
| `node --test "packages/forge-devops/test/client-rule-parity.test.mjs"` | exit 0 · **5/5**（含 4096 放行 / 4097 拒的页面-服务端同判） |
| `pnpm check` | exit 0 · **1211/1211** · `docs: ok`、`repo: ok` |
| `node scripts/check-docs.mjs` | exit 0 · 55 files / 494 tables / 578 links / 18 controlled documents |
| `node scripts/check-repo.mjs` | exit 0 · 24 entries / 10 packages / 576 tracked files |
| `node scripts/check-bundle-tarballs.mjs` | exit 0 · 7 packed / 151 files |
| `node scripts/dsh-version.mjs check` | exit 0 · 基线 0.2.1-rc.3，基线位置 2 处、代码无硬编码 |
| `git diff --check` | exit 0 |

## 3. 上一轮缺陷复验对照（**round-2 级** → 本轮实测）

| 编号 | round-2 级 | 复跑命令（原样，未替代） | 本轮实测 | 结论 |
|---|---|---|---|---|
| R2-1 `ghOwner` 长度上界缺失（页面放行、保存才 422） | P2 | `node logs/.../scripts/qa-r3-rule-parity.mjs` | exit 0 · 一致 24/25 · 委托 1 · **漂移 0**（39 放行 / 40、45 两侧失焦即拒） | **已关闭**（`client.js:55` 改为 `/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/`） |
| R2-2 文档把「等值副本」写成「共用实现」 | P3 | `grep -n "共用它" packages/forge-devops/README.md docs/teamflow/20261029-r3-cli-path-autodiscovery/TECHNICAL.md` | exit 1 · **0 命中** | **已关闭**（`README.md:61` 与 `TECHNICAL.md:43` 均改为「内联等值副本，一致性由 `test/client-rule-parity.test.mjs` 的跨面矩阵守护」） |

> 两条都按上一轮表格里写的 Check command 原样执行；R2-1 的判据「末行无漂移」在本轮原文输出为`页面规则与服务端保存期判定在矩阵上无漂移`。

## 4. 修复声明的命中数重算（与 dev 声明逐类比对）

| 缺陷类 | dev 声明 | 本轮重算（实测） | 一致 |
|---|---|---|---|
| 页面 `ghOwner` 缺上界 | 已修 | 页面规则 39 放行、40/45 拒；跨面矩阵该三点 page=server | 是 |
| 同类第二处：页面缺**路径长度上界** | 已修（dev 自查发现） | 页面 4096 放行 / 4097 失焦即拒；HTTP 4097 → 422「长度不能超过 4096 个字符」且 `edits=0`；4096 不命中长度规则（边界内） | 是 |
| 跨面等值门禁 | 新增 `client-rule-parity.test.mjs` | 5/5；反证探针 `gate-prefix-proof.mjs` 证明修复前三处会被判红 | 是 |
| R2-2 措辞 | 已修 | 用户可见文档 0 命中；但 `client.js:52` 源码注释仍写「由 `test/client-shape.test.mjs` 的跨面矩阵守着」，而该文件无跨面矩阵 → **计 1 条残留（R3-1 P3）** | 部分 |

未出现「声明与实际不符」的功能性项。

## 5. 本轮扩展：上一轮较少覆盖的三个面

上一轮的盲区是**「边界修了，但 QA 侧扫描范围落后一版」**：dev 修 R2-1 时自行补了路径长度上界并新增包内门禁，而 QA 的规则矩阵、渲染探针与 HTTP 探针都还停在「wrapper / 缺失路径」这一层。本轮只追加，不重建：

### 5.1 规则矩阵补两行边界（24/25 → 26/27，漂移 0）

`qa-r3-rule-parity.mjs` 增加 `dopBin` 4096 / 4097 字符路径两条；原文输出 `4096 字符（长度上界内） page=ok server=ok`、`4097 字符（超长度上界） page=error.pathLength server=reject(长度不能超过 4096 个字符)`。

### 5.2 渲染态：超长路径失焦即拒 + 提交前自检零 POST（13/13 → 14/14）

`qa-r3-client-render.mjs` 在「改为手动指定」后输入 4109 字符路径：`aria-invalid=true`、脚注出现「路径太长（上限 4096 个字符）…」、保存按钮仍可点但点击后 `POST 0 → 0`（无写入）。这条覆盖的是**用户实际会走到的面**：整段日志被粘进输入框。

### 5.3 HTTP 保存面：长度规则先于存在性、越界不写盘（12/12 → 13/13）

`qa-r3-cli-mainpath.mjs` B7：真 `createCliAccess` + 真 `createCliApi`，4097 字符 → 422 且 `errors.dopBin` 含「长度」、`editor.state.edits===0`；4096 字符 → 同样 422 但报「找不到这个文件」（证明确实是用例假 fs 里不存在，而不是被长度规则误伤）。

## 6. 架构与接口一致性核对（M3 质量门）

- **蓝图对位**：7 个新增/增量模块逐一对上（`cli-discovery` / `cli-config` / `cli-access` / `http` / `runtime-config` 增量 / `index` 装配 / `client.js`），无「该抽未抽」。
- **接口一致性（0a，静态）**：`qa-r3-interface.mjs` 5/5 —— 跨模块 import 的成员均在目标模块真实导出、蓝图 `api` 字段列出的成员全部存在、客户端端点/预检头/字段名与服务端常量逐字一致、真 `apply` 装配可服务且 teardown 干净。
- **零子进程结构性成立**：`cli-discovery.mjs` 只 import `node:path`，`fs`/`now` 全注入，`delivery-selfcheck` 全仓扫描守护。
- **重复实现**：全包唯一一处 = 页面内联的等值规则副本（浏览器半不能 import 服务端模块，属结构性必需），现有 `client-rule-parity.test.mjs` 跨面门禁 + QA 探针双向覆盖；`WRAPPER_SUFFIXES` 仍单一定义（`cli-discovery.mjs`）。
- **单点产生 origin**：三层合并在 `cli-config.mjs` 一处算 origin/overrides，页面只展示不推断（渲染探针实测 Tag 随保存从 `discovered` 变 `config`）。
- **两个路径面函数分离**：`snapshot()` 含路径 / `describeCliAccess()` 零路径，AC-10 不靠开关约束。
- 未见既有结构被破坏，无「明显坏掉」的装配。

## 7. 交付形态 / 卫生（0b / 0c）

| 项 | 命令 | 结果 |
|---|---|---|
| 清单客户端半三项齐（`exports['./client']`、`dsh.client{web,slots,locale}`、`files` 含 `client.js`） | `node logs/.../qa-r3-interface.mjs`（I5） | 通过 |
| 打包白名单 | `node scripts/check-bundle-tarballs.mjs` | ok（7 packed / 151 files） |
| 安装可加载 | `bash logs/.../install-load-probe.sh` | `PASS install+load`（隔离 profile，结束即删；未触碰真实 web profile） |
| 提交面卫生 | `git status --porcelain` | 10 改 + 13 未跟踪（12 新文件 + 任务夹目录）；**零** `node_modules/`、`dist/`、`.env`、`*.log`、IDE/缓存噪声；`logs/` 经 `.gitignore:81` 忽略 |

## 8. AC 判定（本需求 15 条）

| AC | 判据要点 | 证据 | 结论 |
|---|---|---|---|
| AC-1 零配置可用 | 无 `FORGE_DEVOPS_*` 时发现命中即 ready | 主路径 13/13（A1/A2）、`t1` 3/3、渲染探针首屏 | 通过（离线注入 win32 + 假 fs）；Windows 真机 NOT RUN |
| AC-2 只认直接可执行 | 包装脚本不选中、零子进程 | 跨面矩阵 wrapper 两侧、`delivery-selfcheck` 零 `child_process` | 通过 |
| AC-3 三层优先级 + origin | config > env > discovered，页面可见 | `cli-config` 用例、矩阵、渲染 2/7 | 通过 |
| AC-4 有界发现 | 仅装配/刷新扫，200 目录 ≤300ms | 主路径 A4/A5（无扫描 12 vs refresh 24；200 dirs 4.0ms） | 通过 |
| AC-5 找不到即如实失败 | reason + 类别名 + 指引、零路径 | 主路径 A6、`t1` 3/3 | 通过 |
| AC-6 真实配置页可达 | 一屏 6 字段、≤2 次点击 | 渲染 1/3（section#devops order=60、5 文本框 + 2 选项段） | 通过（DOM 级）；真实浏览器点击 NOT RUN |
| AC-7 页面即状态 | 只读展示、覆盖/重置、重新发现 | 渲染 2/4/6/10 | 通过 |
| AC-8 保存即持久 | 写入活动 profile 补丁、重启仍 ready | 渲染 7（真 POST → configEditor 收到写入）、主路径 B4 | 通过（后端形状）；真实 profile 重启 NOT RUN |
| AC-9 非法值逐字段拒 | 逐字段错误、冲突不覆盖、原配置不动 | 矩阵 26/27 漂移 0、渲染 5/8/9、主路径 B2/B7 | 通过（R2-1 及其同类第二处均已闭合） |
| AC-10 回显边界 | 路径/endpoint 只在页面内 | 渲染 12（路径不进 URL、零 console）、主路径 B5 | 通过 |
| AC-11 环境变量仍可用 | 三层互不排斥 | 三层矩阵（env 命中路径） | 通过 |
| AC-12 文档 UI 优先 | 配置页步骤在前、六键表、回滚步骤 | `README.md` 配置页段在环境变量段之前、六键表与 `.exe` 限制齐全 | 通过（源码注释措辞另记 R3-1 P3） |
| AC-13 证据纪律 | 命令/时间/宿主/来源类型齐全，未跑标 NOT RUN | 本报告 §1–§9 | 通过 |
| AC-14 零回退 | 白名单/四状态/审计/工具数不退化 | 包内 425/425、根 1211/1211、9 工具、`READ_REASONS` 11 码 | 通过 |
| AC-15 可回滚 | 清空 → 回落自动发现 | 主路径 B4、`cli-access` 用例（全空走删除路径） | 通过 |

## 9. 人工补测清单（环境限制，非交付缺陷）

| # | 项 | 方法 | 工具 |
|---|---|---|---|
| 1 | Windows 真机零配置（AC-1/AC-2） | 未设 `FORGE_DEVOPS_*` 的 Windows 上装包，确认只读面 ready 并能读到真实变更 | Windows 11 + dsh 0.2.1-rc.3 |
| 2 | 真实 web profile 点击走查（AC-6/AC-7） | `设置 → DevOps 变更流程`，2 次点击内可达、只读态与 Tag 正确 | Chrome / Edge |
| 3 | 重启后仍生效（AC-8） | 保存后重启宿主，确认 origin=配置 且 ready | 同上 |
| 4 | 宿主写入面细节 | 保存后看 profile 补丁：YAML 注释保留、原子写、失败回滚 | 查看 profile 补丁文件 |
| 5 | 布局几何 | 768 高视口 / 中文目录宽度下的排版（DESIGN §9） | Chrome DevTools 截图 |
| 6 | 企业 `dop.exe` 是否有离线 `--version`/`--help`（PRD openQuestion F1） | 内网机器执行探针命令 | 企业侧 |
| 7 | rc.3 差分 | 本轮装配/安装仅测 rc.2 | dsh 0.2.1-rc.3 |

## 10. 缺陷表（仅列本轮仍 OPEN 的；无 P0/P1/P2）

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| R3-1 | P3 | 架构·源码注释 | 读 `packages/forge-devops/client.js:50-53` 的「与服务端同源的字段规则」注释 | 注释指出的守护用例必须是真实存在跨面矩阵的那个 | 注释写「由 `test/client-shape.test.mjs` 的跨面矩阵用例守着」，但该文件既无 `MATRIX` / 矩阵，也不引用 `buildCliPatch` / `validateConfigField`（实为 `test/client-rule-parity.test.mjs`，README:61 与 TECHNICAL:43 已写对） | AC-12、AC-13 | `! grep -q "test/client-shape.test.mjs" packages/forge-devops/client.js`（当前 exit 1） | exit 0（注释改指 `test/client-rule-parity.test.mjs`；功能零改动） |

## 11. 结论

**通过（可验收）**。判据：

1. 上一轮 2 条遗留按原 Check command 复跑全部转绿（矩阵末行「无漂移」；`grep 共用它` 0 命中），修复声明的命中数与 QA 重算逐类一致。
2. R2-1 的同类第二处（路径长度上界）在**页面渲染态**与**HTTP 保存面**都实测拦住：失焦即拒且零 POST、越界 422 且零写盘、边界内不误伤。
3. 全仓门禁绿：包内 425/425、根 1211/1211、docs/repo/bundles/version/`git diff --check` 全 ok；提交面无噪声。
4. 唯一 OPEN = R3-1（P3，源码注释指向错误的守护用例，功能零影响）；Windows 真机、真实浏览器走查、rc.3 差分为人工补测项。
5. 放行条件：P3 不构成阻断，可随任意后续改动顺手修正；不满足时也不影响「Windows 零配置可用」这一核心诉求。
