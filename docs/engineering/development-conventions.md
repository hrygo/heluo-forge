# 工程开发与发布约定

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-ENG-002 |
| 文档名称 | 工程开发与发布约定 |
| 版本 | V0.6.6 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-28 |
| 门禁 | 随首个可发布包复核 |

> 编制依据：2026-10-20 核对仓库结构、`package.json`、`pnpm-workspace.yaml`、`scripts/check-*.mjs` 与 `.github/workflows/check.yml` 的实际内容；工具链实测为 Node.js 24.21.0、pnpm 11.28.5。未执行远端 CI，也未发布任何包。
>
> 关联文档：[工程仓库结构设计](<repository-structure-design.md>)、[逐模块设计索引](../design/README.md)、[文档总览](../README.md)、[项目协作规范](../../AGENTS.md)。

2026-10-21 复核根脚本、工作流、市场包与参考服务及其测试。当前默认工具链与声明不一致时，验证报告须写明实际版本；不将上述历史 Node 24 实测沿用为当前环境证明。

## 1. 结论

仓库采用 pnpm workspace 单仓多包。`packages/` 放安装进 DSH 的扩展，`services/` 放独立运行的服务，`deploy/` 放部署资产。根工程不发布，子包只在设计完成、接口核验与测试具备后才建立清单。

合入前必须通过 `pnpm check`：文档与仓库结构检查，加上 `node --test` 自动发现的全部测试。当前已覆盖检查器、市场插件、目录参考服务与本地集成链路；CI 以只读权限执行同一定义。其余模块的测试矩阵仍为规划，不由市场测试代替。

## 2. 工作区与依赖

- 根 `package.json` 固定 `private: true`、`packageManager` 与 `engines.node`；工作区成员由 `pnpm-workspace.yaml` 声明。
- 平台名称统一为“河洛 / Heluo Forge”，根工程名为 `heluo-forge`，包名为 `@heluo/forge-*`，包目录为 `packages/forge-*`；DSH 指上游运行时，`CORP-DSH-*` 保留为文档编号。
- 包之间使用 `workspace:` 协议引用，禁止跨包直接导入源码路径。
- 新增依赖须有真实消费者，并在变更说明中写清用途与许可证；不为“可能用到”预装框架、SDK 或构建缓存。
- 升级 Node 主版本、pnpm 主版本或引入构建编排工具，单独提案并记录理由，不夹带在功能变更中。
- 锁文件提交入库；安装使用 `--frozen-lockfile`，避免不同机器解析结果漂移。

## 3. 分支与提交

| 项 | 约定 |
|---|---|
| 主分支 | `main` 保持可检查、可评审；不直接堆积未验证改动 |
| 分支 | 短生命周期，按 `feat/`、`fix/`、`docs/`、`chore/` 命名，合并后删除 |
| 提交 | 一次提交只做一件事；类型使用 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` |
| 说明 | 写“改了什么、为什么”，不写“按用户要求”；不把格式化与行为变更混在一起 |
| 迁移 | 文件移动使用 `git mv`，同一提交内更新全部引用 |

推送与发布是独立动作：提交不自动触发推送，推送不自动触发发布。

## 4. 设计先行

- 新模块先写详细设计并登记[设计索引](../design/README.md)，再创建 `package.json` 与源码。
- 设计须核验目标 DSH 版本的真实接口，并记录核验方式与日期；未核验的接口只能标注为待确认。
- 实现与设计不一致时，先改设计再改代码；契约字段变化先改 `docs/contracts/`。
- 设计未完成、测试未建立时，`packages/` 与 `services/` 中只保留职责 README，状态写“规划”。

## 5. 测试分层

| 层级 | 位置 | 负责验证 | 当前状态 |
|---|---|---|---|
| 工程工具测试 | `tests/` | 文档与仓库检查器本身的正反向行为 | 已建立 |
| 模块单元测试 | `packages/forge-market/test/`、`services/market-index/test/` | 历史市场包契约与索引校验 | 已建立；市场服务/生成器不再建设 |
| 契约测试 | 市场包 `test/` | 市场自有协议、错误码、配置与包形态 | 市场已有本地用例；IAM、网关、DevOps 等企业契约仍待联调 |
| 集成测试 | `packages/forge-market/test/integration.test.mjs`、`tests/integration/` | 历史归档安装链路与失败传播 | 已建立；临时目录与仿服务，不访问企业系统 |
| 宿主与终端验收 | DESIGN-007 历史记录；后续实机证据 | DSH 挂载、Windows 与银河麒麟业务路径 | 有测试 profile 挂载/面板记录，已恢复；双端企业路径未验，无 `tests/e2e/` 自动化入口 |

### 5.1 包体闭包检查

`scripts/lib/bundle-rules.mjs` 接入 `scripts/lib/repo-rules.mjs`，对 `packages/*` 做静态闭包核验：包名与目录一致、`engines.dsh` 具体、无 install 期构建脚本、不依赖 DSH 内核、`files`/`main`/`bin`/`exports` 目标存在、`@heluo/*` 依赖必须 `workspace:` 且可解析、不跨包导入源码路径、补丁层随包发行且 `insert:` 不指向不存在的包、不挂历史市场包、`locale` 双语文案随包发行。规则来源与用途见[企业组合设计 §5.3](../design/plugins/forge-enterprise.md#53-组合与包体闭包e01-37)；正反向夹具在 `tests/bundle-closure.test.mjs`。静态规则不替代真实 tarball 与安装语义验证。

`scripts/check-bundle-tarballs.mjs` 对每个有清单的包跑 `npm pack --dry-run --json`，核对实际进包的文件与模式位（声明项、入口、`bin` 执行位、locale 成对、不得混入测试/lockfile）。它用 npm 而不是 pnpm：CI 只装 Node，不安装 pnpm。`node --run check` 已包含该步，也可单跑 `pnpm check:tarballs`。

该步固定使用**与当前 Node 同目录的 npm**（`npmExecutable()`），不走 `PATH` 上的任意 npm：npm 11 输出数组、npm 12 输出按包名索引的对象，`--dry-run` 的文件选择也按 npm 版本变化，混用会让"tarball 内容"这一断言随机器漂移。解析失败时错误信息带 npm 路径、版本与 stdout 开头，不再只说"没有可解析的文件列表"。（2026-10-24 在 Linux aarch64 + Node 24.21.0 上复现并按此修复。）

- 没有真实用例时不建立会“零用例成功”的业务测试入口。
- 安全负向用例（拒绝、超时、结果未知、权限不足）与正向用例同等对待。
- 测试不得依赖真实生产凭据；使用占位身份与受控测试环境。

## 6. 检查与 CI

- 本地：`pnpm check` 直接串行执行文档检查、仓库检查、包体 tarball 闭包检查、DSH 版本检查与 `node --test`；`test:unit` 当前也是全量 Node 测试发现，不能按命名误解为仅工程单元测试。
- 需要缩小范围定位时使用根 README 的市场包/参考服务命令；全量检查已覆盖的有效结果无需重复执行。真实仓库归档检查与 DSH/企业实机操作不进入离线 CI。
- `check:docs` 校验元数据、登记一致性、链接与锚点、表格列数、禁写修订记录与询问函问题序列。
- `check:repo` 校验必需文件、工作区配置、模块状态声明、工作流权限与动作固定、凭据与本机绝对路径，以及包体闭包（清单/入口/workspace 依赖/补丁层/locale）。
- `check:tarballs` 校验真实 tarball 内容与模式位。
- `check:version` 校验 DSH 版本单一真源：声明位置的非历史命中必须等于 `.dsh-version`（同一文件里出现第二处过期表述也会失败）、目标声明行不得写死目标版本、代码与脚本（全仓，排除 `docs/` 与依赖/产物目录）不得硬编码版本、`engines.dsh` 下限必须与基线同发布线且不得高于基线。
- CI 使用 `.github/workflows/check.yml` 的单个 `verify` job，执行 `node --run check`；默认 `contents: read`，外部动作固定到完整提交 SHA，常规检查不使用 `pull_request_target`。触发与依赖策略见[贡献指南](../../CONTRIBUTING.md#71-github-actions)。
- `.github/workflows/check.yml` 另有非必需的 `sensitive-scan` 矩阵，仅在 Ubuntu、macOS、Windows runner 上执行本地敏感扫描单测，用于跨环境回归；稳定后再评估是否设为 required。
- 唯一例外是 `.github/workflows/sensitive-attestation.yml`：它使用 `pull_request_target` 仅为从基线加载受信任的验签脚本，checkout 基线、只 fetch PR 的 git 对象，不 checkout、不执行 PR 代码，不读取 secrets，权限仅 `contents: read`。本地敏感规则与扫描内容不上传；远端只验证本地签名的 tree/规则摘要。实现与边界见[敏感扫描说明](../../scripts/sensitive-scan/README.md)。启用前必须完成密钥登记、规则摘要 allowlist 与 required check 配置。
- CI 只跑离线检查；不接触企业系统、不注入生产密钥、不自动发布。

## 7. 版本与发布

- 包版本按语义化版本管理；`0.x` 阶段允许接口调整，`1.0.0` 起不兼容变更必须升主版本。
- 版本更新与说明在准备发布时生成，不手工散改；具体工具在首个可发布包时确定并回写本文。
- 发布前置条件：设计已评审、接口已核验、测试通过、`engines.dsh` 明确；读取真实 npm tarball 核验 Host/Client/patch/资源与 exports/files 闭包，不以本地 link 代替实际包验收。自身和内部定制补 en/zh meta.title/description、授权图标及导出；第三方缺显示资源允许明确 fallback，不一刀切拒收。
- [ADR-11/13](<../architecture/plugin-registry-source-decision.md>)确定企业私有 npm 为唯一制品源：公网包由仓库同步，内部定制包从固定 Gitee group 源码构建后发布。AIHUB 维护并托管 format-1 索引，只列发布前策展的精确稳定版；本项目只校验索引契约，不生成索引、不保存逐版本证据；内部 scope 不回落公网。
- [ADR-12](<../architecture/plugin-registry-source-decision.md>)限定首版自包含双端稳定包，不允许终端另解运行时 npm 依赖、自动补 peer 或现场编译；devDependencies/普通build脚本属于上游CI，不据键名误拒。源码workspace依赖如需进入首版，须在构建产物内闭合，不能带workspace/runtime引用发布。统一索引取双端交集，同一profile只用一个规范企业registry；展示资源仅获准内网或省略。
- 同名同版本不可变；上传/发布权限与包名准入分开，无逐版审批。原生索引只承载目录：索引可读即可安装，没有写前授权/租约/当前许可；不要把它描述成强门禁。更版按原生能力，没有通用 upgrade 时卸载后安装；不私改 profile、不承诺原子升级或自动回滚。实际通道与角色覆盖由 G1/G2 验证，不足只读且不算准入通过。
- 根工程永不发布；未通过门禁的包不得出现在市场目录。

### 7.1 DSH 版本的单一真源

- 当前目标 DSH 版本只写在仓库根 `.dsh-version`；文档、脚本与测试一律不写死版本号。
  包清单的 `engines.dsh` 是宿主安装时直接读取的兼容下限，必须是字面量，属唯一例外；
  `forge-market` 故意按基础版本表达下限（预发布 `-rc.N` 在比较上小于基础版本），
  该例外在工具里登记了原因。
- 工具：`node scripts/dsh-version.mjs report | check | apply <version>`。
  `apply` 默认演练，只改声明的"基线位置"（`锁版本`、`一期兼容目标`），
  **带日期或标注为编制依据/实测/探针的历史记录不会被改写**；`--write` 落盘，
  `--engines` 才一并提升包清单下限（跳过登记过的例外）。
- `check` 已并入 `node --run check`：正文基线位置与 `.dsh-version` 不一致、或
  代码/脚本里出现硬编码版本（测试夹具与清单除外）都会失败。
- 改版本后按文档总览 §6 升受影响的受控文档版本与登记行，并复核 `report` 里"未分类"的记录：
  它们既没被声明为基线位置、也不在带日期的证据块里，可能是漏标的"当前基线"表述，也可能是该补日期的证据；
  确认后补进声明位置或补证据日期，不要为了让报告好看而扩大声明范围。
- 下限口径：`engines.dsh` 写**已核验过**的最小 DSH。当前 6 个包停在 `>=0.2.1-rc.2`（预发布在比较上小于同号正式版，
  `check` 会逐条提示但不算失败）：rc.3 只跑过安装/升级/回退/卸载循环，兼容性套件尚未开跑，故不提升下限；
  提限与兼容套件结果同批处理。`forge-market` 按基础版本写 `>=0.2.0`（2026-10-25 复核：预发布比较上小于基础版本，写 `-rc.N` 会让基础版本宿主自判不兼容），是登记在 `ENGINE_FLOOR_EXCEPTIONS` 的例外。
- 代码扫描面是全仓（跳过 `node_modules`/`.git`/`dist`/`build`/`coverage` 等，排除 `docs/`），覆盖
  `.mjs/.cjs/.js/.ts/.json/.yml/.yaml/.sh`；带 `v` 前缀与清单里的版本都会被解析。清单只放行 `engines.dsh`
  里实际写的那个版本，`dependencies` 里钉死的 DSH 版本仍算硬编码。测试夹具若确需写死版本（模拟旧宿主或
  第三方包形状），登记在 `TEST_FIXTURE_EXCEPTIONS` 并在 `report`/`check` 里逐条列出，不做静默放行。
- 能力边界：该检查拦的是**字面量**。把版本拆成字符串拼接（`'0.2.' + '1-rc.3'`）、用全角字符书写、
  或从别处算出再写回，正则都看不出来；这类只能靠评审。反例自证见本文件 §7.1 的注入用例与 `tests/dsh-version.test.mjs`。
- 分类口径：`基线位置`＝声明式命中；`历史记录`＝版本的**紧邻处**有"曾/当时/此前/历史"一类措辞（整行提到
  "历史节奏"或"已实测"不改变这句就是当前声明），或所在小节/加粗小标题带日期或实测/核验/探针/编制依据等判据；
  `example`＝格式示例（如 `engines` 语法），版本有意固定；登记行（`| CORP-DSH-…`）按其结构排除，因为末列是文档版本；
  DSH 名称与版本的距离超过 24 字符且本行与本块都不涉及 DSH 时，不视为 DSH 版本。

## 8. 安全

- 不提交令牌、密钥、证书、真实用户数据或内网地址；示例使用 `corp.example` 等占位。
- 凭据经受控存储获取，不进入日志、命令参数、提示词或模型上下文。
- 发现疑似泄露时停止提交、轮换凭据并按内部安全渠道处理，不把秘密写入工单或聊天记录。
- 外部动作与依赖升级须审查来源与固定版本；不因便利放宽权限或关闭检查。

## 9. 待确认

| 问题 | 需要谁回答 | 影响 |
|---|---|---|
| 版本与变更日志工具、发布审批人 | 平台与发布责任方 | 首个可发布包的发布流程 |
| 私有 registry 的认证方式与保留策略 | IT、安全 | 发布与回滚手册 |
| 分支保护、必需评审与 CODEOWNERS 是否启用 | 项目负责人 | 合入约束强度 |
