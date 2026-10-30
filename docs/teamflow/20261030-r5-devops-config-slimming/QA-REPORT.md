<!-- meta: summary="r5 配置页瘦身 QA：4 个自写探针 81 项断言全绿（推导 24 / 保存链 19 / 页面渲染交互 22 / 静态接口架构 16），pnpm check 1395/1398 通过（3 个 skip 为 dsh 不在 PATH 的既有环境用例）、包内 432/432、定向 74/74、git diff --check 干净；未发现 P0–P3 缺陷，真实浏览器走查/窄窗截图/真实 profile 重启为环境限制 NOT RUN，结论可验收。" -->

# QA-REPORT — 企业 DevOps 配置页瘦身（20261030-r5）

## 1. 范围与环境

- 交付面：`packages/forge-devops/{client.js,src/cli-config.mjs,README.md,cordis.patch.yml,package.json}` + 4 个测试文件；分支 `feat/devops-change-flow`（未提交、未切分支）。`src/{http,index,flow,cli-access}.mjs` 零改动（见 §3 AC-9）。
- 本次行为变更：配置页三键一列、改名「企业 DevOps」、用户可见文案去 `.exe`、`sourceType` 后端单点推导；契约面（6 键快照/白名单/状态码）按 AC-9 不变。
- 环境：macOS arm64、Node v24.13.0、pnpm 单仓。沙箱内**真实浏览器不可启动**（宿主沙箱限制，非交付缺陷），`dsh` 不在本机 PATH → 真实 web profile 安装/重启/`--dump-config` 无法执行。
- 证据纪律（AC-13）：本轮为**组件级实测 + 静态审计**；真实浏览器走查、窄窗截图、真实 profile 重启**均未运行**，不得写成企业已验。AC-15～AC-25 属本产品既有契约、不在本次行为变更面，由包内 432 用例回归覆盖。

## 2. 用例与结果（全部为 QA 亲跑）

| 组 | 检查器 / 命令 | 覆盖 | 结果 |
|---|---|---|---|
| A 推导与文案 | `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-derivation.mjs` | AC-1/7/8/10/11、AC-6 服务端侧 | exit 0，**24/24** |
| B 快照与保存链 | `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-save-contract.mjs` | AC-5/7/8/9 | exit 0，**19/19** |
| C 页面渲染与交互 | `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-client-render.mjs` | AC-1/2/3/4/5/6/11/14 | exit 0，**22/22** |
| D 静态/接口/架构 | `node logs/teamflow/tf-mvuiifsi-0iovha/scripts/qa-r5-static.mjs` | 0a/0c + AC-1/2/10/11/12/14 | exit 0，**16/16** |
| 回归门禁 | `pnpm check` | AC-12 | exit 0，tests 1398 / pass 1395 / fail 0 / skipped 3 |
| 包内全量 | `node --test "packages/forge-devops/test/*.test.mjs"` | AC-12 | exit 0，**432/432**，skipped 0 |
| 定向四条 | `node --test test/{cli-config,cli-access,client-shape,client-rule-parity}.test.mjs`（包内） | AC-11/12 | exit 0，**74/74**，skipped 0 |
| 空白与冲突标记 | `git diff --check` | AC-12 | exit 0，零输出 |

- 3 个 skip 全部来自仓库既有环境条件用例（`tests/bundle-install-rehearsal.test.mjs` ×2、`tests/host-probe.test.mjs` ×1，条件均为 `dsh` 在 PATH），本包零 skip。

## 3. 关键结论（逐条给证据）

- **AC-1 改名全链路**：分区 label/nav/title「企业 DevOps」、「Enterprise DevOps」、「命令行入口与超时」、保存按钮文案均在渲染树上逐字命中；`CLI_PAGE_HINT === '设置 → 企业 DevOps'` 且 `cliGuidance` 含该句；分区 id 仍 `devops`、包名仍 `@heluo/forge-devops`（C + D + A）。
- **AC-2 字段收敛**：页面恰 3 个输入（`fdv-dopBin`/`fdv-ghBin`/`fdv-timeoutMs`），隐藏三键零 input、零 DOM，`.fdv-card` 2 + `.fdv-scalar` 1；页面文本/占位符/title 对「事实来源」「连接与身份」「变更流程」「change flow」「mock」「enterprise」「dopEndpoint」「ghOwner」「sourceType」零命中（C）。
- **AC-3 去 `.exe`**：页面 zh/en 全表与渲染结果零 `.exe`；`WRAPPER_MESSAGE` 已改「请指向可直接执行的文件」。保留项与 DESIGN §6.3 一致：`cli-config.mjs:184` 的 Windows 规则句「（Windows 上请指向 .exe）」是规则事实，README 的 `.exe` 说明同为规则，按 DESIGN §6.4 口径不列入零命中面（A + D）。
- **AC-4 路径区零回退**：状态三态（ready 带来源、检测中「正在检测命令行位置」+ 按钮「检测中…」disabled、missing 说明已查 PATH）、入口卡来源 Tag、候选默认收起→展开列出 2 条且仅当前生效项带「当前生效」、只读→「改为手动指定」并预填生效值、config 归属可编辑→「重置为自动发现」、`重新自动发现` 走 `?refresh=1` 且结论未变显示「位置未变」、未改动时保存 disabled（C + A）。
- **AC-5 只提交 3 键增量**：改 `ghBin` 后保存仅 1 次 POST、`fields` 键集仅 `['ghBin']`、带 `x-forge-devops-request: 1`；继承层 `dopEndpoint`/`ghOwner`/`sourceType` 逐字保留；409 保留用户输入并给「刷新」，422 仅页面键落字段并聚焦、只带回隐藏键时折进 footer 不造幽灵字段；重置提交 `{ghBin: null}` 并删掉用户层该键（B + C）。
- **AC-6 页面校验收敛、服务端不放宽**：`.cmd` 输入 blur 后 `aria-invalid` + 「包装脚本」提示 + 点击保存零 POST；服务端 `validateCliField` 对隐藏三键保持完整校验、`buildCliPatch` 仍拒未知键与非法路径（C + A）。
- **AC-7/AC-8 推导单点、不伪造证据**：双入口（config/env/discovered 任意组合）→`enterprise`，单入口/双缺失→`mock`；推导只占 `default` 槽位、`overrides` 为空；显式 config/env 压过推导；`describeCliAccess` 与 flow 侧 `sourceType` 同源；三个 mock 态序列化零 `enterprise`；装配层 `index.apply` 起来后推导生效、显式 `sourceType` 不被覆盖（A + B）。
- **AC-9 契约不变**：GET 200 仍 6 键 entries + revision + `writable{ok,documentPath}`；POST 白名单/409 `CLI_CONFIG_CONFLICT`/422 `CLI_CONFIG_INVALID`/400（缺预检头、未知键）语义不变；`git diff --name-only -- src/{http,index,flow,cli-access}.mjs` 空输出（B + D）。
- **AC-10/AC-11 文档、死代码**：README 3/2/1 三档标注 + 新进入路径 + 拒收句；`package.json` description、`cordis.patch.yml` 注释同步英文新名且 YAML 正文未动；旧名在交付面零命中（仅测试里的反向断言）；段控件/2×2 网格/`TEXT_FIELDS` 等死代码与类名零残留；i18n zh/en 各 54 键同键镜像；`PAGE_FIELDS ⊂ CLI_FIELDS ⊂ RUNTIME_CONFIG_KEYS`（D）。
- **AC-14 渲染自检**：骨架 1 组 + 3 行、表单 1 个 `.fdv-group` + 2 卡 + 1 标量行、仅两条分隔线（首行无上边框）、零 `grid-template-columns`、`.fdv-head` 允许换行、`prefers-reduced-motion` 关闭动效保留（C + D）。
- **0a 接口一致性**：对 `src/*.mjs` 的每一条本地 `import {...} from './x.mjs'` 做动态 import 校验，符号全部真实存在；页面导出面恰为 `{apply, inject, DevopsSection, CliEntryField, StatusLine, CandidateList}` 且 `PAGE_FIELDS`/`TOOL_OF_FIELD` 不外泄；页面端点 `/api/forge-devops/cli`、预检头、`{revision, fields}` 提交体与服务端导出逐字一致。
- **0a2 执行过的主路径**：B 探针用真 `createCliAccess + createCliApi + index.apply` 完成 GET→POST→快照回读→隐藏键保留；C 探针在真 HTTP handler 上完成「渲染→接管→输入→保存→409/422 分流→降级→重置」全链路点击驱动，非静态存在性检查。
- **架构核对**：`deriveSourceType` 全仓仅「1 处定义 + 1 处调用」（`cli-config.mjs`），`index/cli-access/http/flow` 零复算、零 `'enterprise'` 字面；浏览器半只 `require('react')`、不 import 服务端；无重复实现、无该抽未抽、既有结构无损。
- **0b 交付形态**：本轮 state 切片**未注入**「交付形态契约」段；bundle 打包面由 `pnpm check` 的 `check-bundle-tarballs`（bundles ok）覆盖，真实 profile 安装/重启因 `dsh` 不在 PATH 未执行 → 见 §5。
- **0c 版本卫生**：`git status --porcelain` 仅 10 个已跟踪文件 + 任务夹，无 `node_modules/`、`dist/`、`.pnpm-store/`、IDE/密钥类噪声；`logs/` 被 `.gitignore` 覆盖未进 status；`.gitignore` 含 `node_modules/ dist/ logs/ *.tgz .DS_Store .pnpm-store/`（D）。

## 4. 缺陷表

**未发现缺陷**（P0/P1/P2/P3 均为 0）。craft 对照 DESIGN §0.3/§2：hover/`focus-visible`/active、`role=status`+`aria-live`、`aria-invalid`、只读可复制（`readOnly` 而非 `disabled`）、三行两条分隔线、骨架三行、动效偏好关闭均在位，无需登记 observation。

## 5. 人工补测清单

| 项 | 方法 | 工具 | 说明 |
|---|---|---|---|
| 真实浏览器走查：改名可见、两段消失、`.exe` 文案、保存不回退、隐藏键仍在 patch | 以 patch 装入 web profile 后逐项点选 | `dsh` + 浏览器 | 环境限制，非交付缺陷 |
| 窄窗 <700px / <520px 不溢出 | DevTools 设备模式缩放截图，看 `.fdv-head` 换行与候选区滚动 | 浏览器 | 环境限制，非交付缺陷（静态兜底已验） |
| 真实 web profile 安装/重启/load-safety | `dsh --profile web --patch packages/forge-devops/cordis.patch.yml --dump-config` 后启动 | `dsh` | 本机 `dsh` 不在 PATH，未执行 |
| Windows / 麒麟 aarch64 实机（`.exe` 判据、路径大小写） | 在目标机装入后指定真实入口 | Windows/麒麟 机器 | 环境限制，非交付缺陷 |
| `prefers-reduced-motion` 视觉手感 | 系统开启「减少动效」后看骨架/候选动画 | 浏览器 | 静态已在位，观感需人眼 |
| 企业真实 `dop`/`gh` 保存链路 | 用企业 CLI 真实路径走一次保存与回读 | 企业环境 | 无企业凭据/环境 |

## 6. 结论

**可验收**。本轮 4 个探针 81 项断言、包内 432 用例、定向 74 用例与 `pnpm check` 全绿，AC-1～AC-14 均有可重复的机器证据；未发现缺陷；未验证项仅剩环境阻塞的浏览器走查、窄窗截图、真实 profile 重启与双端实机，已列入 §5。工作区仍在 `feat/devops-change-flow`，未提交、未切分支。
