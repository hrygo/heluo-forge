# ACCEPTANCE — 企业 DevOps 配置页瘦身（20261030-r5）

- 需求：`docs/teamflow/20261030-r5-devops-config-slimming/PRD.md`（基线 r3，显式取代 r3 的 AC-6 / AC-9 / AC-12）
- 技术方案：同夹 `TECHNICAL.md`（含架构蓝图）；QA：同夹 `QA-REPORT.md`
- 分支：`feat/devops-change-flow`（未提交、未切分支、未 stash）；改动集合 = 10 个已跟踪文件 + 本任务夹
- 交付面：`packages/forge-devops/{client.js, src/cli-config.mjs, README.md, cordis.patch.yml, package.json}` + `test/{client-shape, client-rule-parity, cli-config, cli-access}.test.mjs`
- 验收人：产品经理（acceptance lead）· 2026-10-30

## 一、结论摘要

PRD 的 14 条 AC（P0 七条、P1 五条、P2 两条）逐条核对均有可复现证据：本阶段独立复跑门禁与 QA 四个探针全绿，包内测试 432/432、`pnpm check` 1395 pass / 0 fail、`git diff --check` 干净。架构与 TECH 蓝图逐项一致：`sourceType` 推导单点在 `cli-config.resolveCliAccess`、页面可编辑面恰三键、装配/HTTP/流程层零改动。未发现 P0–P3 缺陷。未验项仅剩环境阻塞的人工补测（真实浏览器走查、窄窗视觉、宿主 profile 重启、Windows/麒麟实机、企业真实 CLI 链路），按 AC-13 标 NOT RUN，不构成本轮阻滞。

## 二、本阶段独立验证（acceptance 亲跑，不复用 QA 结论）

| 命令 | 结果 |
|---|---|
| `pnpm check` | exit 0；docs / repo / bundle-tarballs / dsh-version 全过；`node --test` 1398 tests、1395 pass、0 fail、3 skipped、0 todo |
| `node --test "packages/forge-devops/test/*.test.mjs"` | exit 0；432/432 pass，skipped 0，todo 0 |
| `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-derivation.mjs` | exit 0；24/24 |
| `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-save-contract.mjs` | exit 0；19/19 |
| `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-client-render.mjs` | exit 0；22/22 |
| `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-static.mjs` | exit 0；16/16 |
| `git diff --check` | exit 0，零输出（空白与冲突标记干净） |
| `git diff --name-only -- packages/forge-devops/src/` | 仅 `src/cli-config.mjs`（`http/index/flow/cli-access` 零改动） |
| 旧名 grep（`packages/`、`docs/`、根 `README.md`，排除 `docs/teamflow/`） | 唯一命中 `packages/forge-devops/test/cli-config.test.mjs:121` 的反向断言（`includes(...) === false`），不是残留 |
| `test(` 计数对比 HEAD 与工作区（四个被改测试文件） | `client-shape` 37→43、`client-rule-parity` 6→7、`cli-config` 29→31、`cli-access` 19→20（合计 91→101，无一下降、无删除） |

说明：仓库级 3 个 `skipped` 均来自 HEAD 既有的环境条件用例（`tests/bundle-install-rehearsal.test.mjs` 两个、`tests/host-probe.test.mjs` 一个，减跳条件均为 `dsh` 在 PATH），这两个文件本次未被修改，故非本交付引入；本包 28 个测试文件 skipped 0。AC-12 的「零 skip/todo」按「不得新增 skip、交付面零 skip」判为成立，口径见 §五 O-1。

## 三、逐条 AC 核对表

| AC | 优先级 | 判据核对结果 | 证据（文件位置 / 探针） |
|---|---|---|---|
| AC-1 改名全链路 | P0 | zh `nav`/`title` 均为「企业 DevOps」，en 为 `Enterprise DevOps`；`CLI_PAGE_HINT` 逐字「设置 → 企业 DevOps」；分区 id 仍 `devops`、包名仍 `@heluo/forge-devops`、HTTP 端点与工具名未变 | `client.js:185/186`、`client.js:242/243`、`src/cli-config.mjs:96`、`test/cli-config.test.mjs:120`；探针 A 与静态探针（D） |
| AC-2 字段集收敛到 3 项 | P0 | 页面恰 3 个输入（`dopBin`/`ghBin`/`timeoutMs`）；隐藏三键零 DOM、零 staged、不发送；页面文本（含 hint、`title`、`aria`、占位符）对「事实来源」「连接与身份」「mock」「enterprise」「dopEndpoint」「ghOwner」「sourceType」零命中 | `client.js:50`（`PAGE_FIELDS` 三键）、`client.js:46` 注释；探针 C（22 项）与 D |
| AC-3 用户可见文案去 `.exe` | P1 | 占位符「粘贴 dop 的完整路径」、帮助句「在资源管理器里选中 dop 文件右键 →「复制文件地址」，粘贴到这里」、包装脚本句「…请指向可直接执行的文件」；en 同键镜像；zh/en 用户可见文案 `.exe` 零命中；真实路径值不改写 | `client.js:201`、`client.js:208`、`client.js:105`（`WRAPPER_MESSAGE`）；探针 A/C；Windows 只认 `.exe` 的规则句按 DESIGN 保留 |
| AC-4 路径区交互零回退 | P0 | 只读展示 / origin 标记 / 候选展开 / 改为手动指定 / 重置为自动发现 / 重新自动发现（`?refresh=1`、结论未变提示「位置未变」）/ 状态三态 / 未改动时保存 disabled 全部在位；`aria-live` 与键盘可达保留 | 探针 C（22 项中覆盖上述全部交互）；`client-shape` 回归用例改写未删除 |
| AC-5 保存只提交 3 键增量，隐藏键逐字保留 | P0 | 保存仅 1 次 POST，`fields` 键集仅实际改动键；继承层 `dopEndpoint`/`ghOwner`/`sourceType` 逐字保持；409 保留输入并给刷新、422 逐字段不丢其它字段；重置提交 `null` 并删用户层该键 | `client.js:754`（只遍历 `PAGE_FIELDS`）；探针 B（19 项）与 C；`client.js:806`（422 隐藏键折入 footer） |
| AC-6 页面校验收敛、服务端不放宽 | P1 | 页面失焦校验只覆盖路径类与 `timeoutMs`；服务端 `validateCliField`/`buildCliPatch` 对六键（含隐藏三键）拒绝语义与原因不变；双面矩阵逐行比较 | 探针 A（24/24）；`test/client-rule-parity.test.mjs:138/150/186` 双面矩阵用例 |
| AC-7 sourceType 后端单点推导 | P0 | 优先级 ① 配置 ② 环境变量 ③ 推导；`entryReady` 要求值非空且 origin ∈ config/env/discovered，双入口就绪才 `enterprise`；推导只落既有 `default` 槽位（origin 词表不新增、`overrides` 恒空）；页面永不发送该键 | `src/cli-config.mjs:287`（`entryReady`）、`:297`（唯一实现）、`:383`（唯一调用）；`test/cli-config.test.mjs:192` 四态表 + 覆盖优先级 |
| AC-8 不伪造企业证据 | P0 | 仅 dop 或仅 gh 均回落 `mock`；三个 mock 态序列化零 `enterprise`；`describeCliAccess()` 无路径与 endpoint 实值；装配层推导生效且显式声明不被覆盖 | 探针 B（19 项）；`test/cli-access.test.mjs` 新增「事实来源推导经快照到装配层」；`entryReady` 把 `default` 裸命令 `gh` 排除（宁可少标） |
| AC-9 快照与 HTTP 契约不变 | P1 | GET 仍 6 键 entries + revision + writable；POST 白名单 6 键；400/409/422 原因码不变；页面持有 6 键快照但不渲染隐藏键；契约层零 diff | `git diff --name-only -- src/` 仅 `cli-config.mjs`；探针 B 与 D；`src/http.mjs`、`src/index.mjs`、`src/flow.mjs`、`src/cli-access.mjs` 未改（`flow.mjs:166` 仅消费 `runtime.sourceType`） |
| AC-10 文档与指引同步 | P1 | README 进入路径改「设置 → 企业 DevOps」，配置项按 3 项可页面设置 / 2 项仅环境变量与配置文件 / 1 项后端推导标注；`package.json` description 与 `cordis.patch.yml` 注释同源英文新名；旧名全库零命中（历史任务夹除外） | `README.md:9/32/52-56/78/103`；`package.json:6`；`cordis.patch.yml:8-14`；旧名 grep（§二） |
| AC-11 死代码与词表清理 | P2 | `SegmentedField`/`SEGMENT_FIELDS`/`SOURCE_TYPES`/`segmentField`/`fdv-segment`/`fdv-grid` 等零残留；保留 6 键契约表 `CLI_FIELDS`（与服务端同序）与 3 键渲染表 `PAGE_FIELDS`，后者严格 ⊂ 前者；导出面不再含段控件 | `client.js:41`（`CLI_FIELDS` 六键）、`:50`（`PAGE_FIELDS` 三键）；探针 D 静态断言；导出面 `{apply, inject, DevopsSection, CliEntryField, StatusLine, CandidateList}` |
| AC-12 回归基线 | P0 | `pnpm check` 与 `git diff --check` 全绿；用例数只增不减（四个被改文件 +10）；包内 skipped 0、todo 0 | §二首行与计数行；3 个仓库级 skip 为 HEAD 既有环境条件用例（§五 O-1） |
| AC-13 证据纪律 | P1 | QA-REPORT 与本报告均把真实浏览器走查、窄窗截图、宿主 profile 重启、双端实机标 NOT RUN；未出现「企业已验」表述；本轮为组件级离线实测 | `QA-REPORT.md` §1/§5；本报告 §六 |
| AC-14 渲染自检 | P2 | 骨架 1 组标题 + 3 行、表单 1 个分组 + 2 张入口卡 + 1 个超时标量行、恰两条分隔线（首行无上边框）、零 `grid-template-columns`、`.fdv-head` 允许换行、`prefers-reduced-motion` 关闭动效保留；窄窗视觉为 NOT RUN | 探针 C 与 D（组件级结构断言）；窄窗与动效观感见 §六 |

## 四、架构一致性核对（M3 质量门）

- **蓝图落地逐项一致**：`deriveSourceType(entries)` 只在 `src/cli-config.mjs` 定义（`:297`）并在 `resolveCliAccess` 内调用一次（`:383`），推导与三层合并同处发生；页面、`index.mjs`、`flow.mjs` 只消费合并结论，全仓无第二处推导（grep `deriveSourceType` 仅源码定义 + 唯一调用 + 测试）。
- **页面半按蓝图收敛**：`PAGE_FIELDS = ['dopBin','ghBin','timeoutMs']` 为内部常量（`:50`，未导出）；`TOOL_OF_FIELD` 仅用于 i18n 插值（`:52` 注释与用法）；`TimeoutField` 为内部组件（`:516`，不在导出面）；隐藏三键不进 DOM、不进 staged、不发送。
- **测试面与蓝图一致**：`client-shape`（页面形态 + 假 React/假 fetch 的组件级 E2E）、`client-rule-parity`（页面三键矩阵 vs 服务端六键矩阵逐行比较，隐藏三键断言页面 null 而服务端仍拒）、`cli-config`（推导四态与覆盖优先级）、`cli-access`（快照与装配链）四个文件职责与蓝图一一对应。
- **契约层零改动**：`git diff --name-only -- src/` 仅 `cli-config.mjs`；`http/index/flow/cli-access` 未动，`flow.mjs:166` 仍只读 `runtime.sourceType`，不存在页面或装配层二次推导。
- **重复实现风险核对**：页面 `validateField` 与服务端 `validateCliField` 的规则双写是蓝图既定取舍（浏览器半不能 import 服务端模块），由 `client-rule-parity` 双面矩阵守等值，未发现 page-loose / page-strict 漂移；`CLI_FIELDS` 在客户端与服务端各有一份属契约对齐所需（AC-11 要求同序、探针断言 `PAGE_FIELDS ⊂ CLI_FIELDS`）；`TOOL_OF_FIELD` 与 `TOOL_BY_FIELD` 无交叉使用。
- **结构完整性**：无「该抽未抽」的新增重复、无既有结构破坏；`README` / `cordis.patch.yml` / `package.json` 改名同源，`memory.md` 仅同主题行替换（2 行 diff，无 changelog 追加）。
- 结论：实现与架构蓝图一致，无偏离、无重复实现漂移、无应抽未抽项。

## 五、缺陷与观察

- **缺陷：0**（P0/P1/P2/P3 均为 0）。QA 四个探针、包内 432 用例、仓库门禁在验收阶段复跑均全绿，未复现任何失败。
- **O-1（口径说明，非缺陷）**：仓库级 3 个 `skipped` 为 HEAD 既有的环境条件用例（`dsh` 不在本机 PATH），本次未修改这两个测试文件，包内 28 个测试文件 skipped 0。AC-12 判为成立，但严格读「零 skip」时建议 CI 提供 `dsh` 以消除该 3 个既有 skip（历史遗留，不阻塞本需求）。
- **O-2（过程建议，非缺陷）**：交付自检阶段（T4）对技术阶段产物 `TECHNICAL.md` 做了 3 处勘误（表格竖线转义、一处日文词、回归命令改为 glob 形式），属文档卫生、非语义改动，已在 `logs/teamflow/tf-mvuiifsi-0iovha/dev-t4-notes.md` 记录；建议后续明确「非本阶段产物的格式勘误」归属，避免门禁因文档格式长期变红。
- **O-3（未验项）**：真实浏览器走查、窄窗视觉、宿主 profile 重启、Windows/麒麟 aarch64 实机、企业真实 `dop`/`gh` 保存链路均未运行（环境限制，非交付缺陷），见 §六。

## 六、人工补测清单（环境具备时执行，结果应回写本夹或后续需求）

| 项 | 方法 | 工具 | 说明 |
|---|---|---|---|
| 真实浏览器走查：改名可见、两段消失、`.exe` 文案、保存不回退、隐藏键仍在补丁层 | 以补丁装入 web profile 后逐项点选 | `dsh` + 浏览器 | 环境限制，本轮 NOT RUN |
| 窄窗 < 700px 与 < 520px 不溢出 | DevTools 设备模式缩放截图，看 `.fdv-head` 换行与候选区滚动 | 浏览器 | 静态兜底已验，视觉需人眼 |
| 真实 profile 安装、重启与 load-safety | `dsh --profile web --patch packages/forge-devops/cordis.patch.yml --dump-config` 后启动 | `dsh` | 本机 `dsh` 不在 PATH，未执行 |
| Windows 与麒麟 aarch64 实机（`.exe` 判据、路径大小写） | 目标机装入后指定真实入口 | Windows 与麒麟机器 | 环境限制，未执行 |
| `prefers-reduced-motion` 视觉手感 | 系统开启「减少动效」后观察骨架与候选动画 | 浏览器 | 静态已在位，观感需人眼 |
| 企业真实 `dop`/`gh` 保存链路 | 用企业 CLI 真实路径走一次保存与回读 | 企业环境 | 无企业凭据与环境 |

## 七、意见与遗留

- 本需求可按「通过」结案：功能面、契约面、文档面与架构面均有机器证据，且未发现需返工项。
- 遗留仅为 §六 的人工补测；在补测完成前，不得把本需求写成「已在企业环境验证」（遵循 AC-13 与仓库证据纪律）。
- 工作区仍在 `feat/devops-change-flow`，复跑确认未提交、未切分支；提交、合并与推送由用户决策，本阶段未做任何 git 写操作。回滚路径见 `README.md` 第 103 行起的回滚三步。
- `memory.md` 的「CLI 入口与配置面」同主题行已由 PRD 阶段替换为本轮口径（页面 3 项、隐藏三键仅环境变量/配置文件、`sourceType` 后端推导、显示名与 `.exe` 文案口径），本阶段复核无追加必要，未再改动。

验收结论：✅ 通过
