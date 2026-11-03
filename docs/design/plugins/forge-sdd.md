# SDD 兼容与退役设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-008 |
| 文档名称 | SDD 兼容与退役设计 |
| 版本 | V0.6.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | G2 |
| 模块状态 | 规划（退役兼容；现存 CLI 可用但非默认） |

> 当前依据：用户于 2026-11-03 最终确认的[需求基线 §2.3](../../requirements/requirements-baseline.md#23-issue-交付模型与受控研发目标需求已确认)（V3.0.0）。用户是本项目需求及产品取舍最终决策人，Agent 提供第三方开发者意见、技术核验与实施；不等待其他团队替项目审批，但企业服务端权限、强制控制与证据不豁免。
>
> 历史依据：2026-10-20 的轻量 SDD 设计以产物、冻结和原子交付为方向；本版保留文档编号和路径以承接历史，不把旧目标改写为现行默认要求。2026-11-03 对现存 CLI、库、组合包和测试作静态核对，不代表本轮运行测试、安装或企业 CI 联调。实现与验证记录仍见[设计索引 §2.2](../README.md#22-实现与验证入口)。
>
> 关联文档：[总体架构 §7.4](../../architecture/platform-architecture.md#74-issue-研发交付与-sdd-退役)、[全流程设计](forge-devops-lifecycle.md)、[企业组合包](forge-enterprise.md)、[工程工具契约](../../contracts/engineering-tools.md)。

## 1. 结论

`forge-sdd` 退出默认 Issue 交付要求，以退役独立组件为目标。先盘点 CLI、组合包、测试和其他调用，再处理未使用部分；仅保留有明确用途的最小能力，不为已有代码创造冻结需求。**本轮只改文档，不删除源码、不改配置、不安装、不卸载或停用已安装能力。**

Teamflow 是唯一研发执行者，企业 Skill 提供变更／Issue 语义。Issue 信息充分时不另写规格，必要设计由 Agent 按复杂度、风险和接口影响决定；spec／freeze／archive 齐套不是开工或验收前提。Teamflow 自动生成的内部 PRD、技术蓝图可以是运行材料，但不是新需求真源，也不要求用户重复填写。

本地验证与独立只读 AI 审查通过后形成待用户验收的实际版本，不统一强制 CI 通过或 PR 先合并；仓库已有必要 CI、分支保护和其他强制规则必须遵守。CI、用户验收、merge、Issue close 与业务结束分别记账，不自动推导、代人工结论或执行最终 `change done`。

## 2. 适用范围与非目标

本文件仅规定现存冻结清单调用的兼容语义及后续退役依据，不是默认 Issue 的第二套交付流程。完整范围仍以[需求基线 §2](../../requirements/requirements-baseline.md#2-范围边界唯一真源)为准。

- 动作、路径、风险确认和必要审计归既有 Policy 与服务端，不在 Skill／SDD 复制硬门禁，不默认绑定旧 spec/apply/archive 状态机。
- 不新建执行 engine、通用修复循环或本地流水线；真实重复确认、阶段阻塞先以运行证据定位，再作最小修正，不宣称现有 Teamflow 已可跳过阶段。
- 不新增强制分支语法或专有 manifest。提交保留 `[变更号]`，PR 关联本次 Issue；追溯串联变更、Issue、仓库、相关 run、实际 SHA／PR 与版本对应证据。

## 3. 现存能力与调用盘点

以下为 2026-11-03 在库静态证据，不等于所有外部调用均已盘清，也不证明企业能力可用。

| 对象 | 已核实事实 | 退役时须处理 |
|---|---|---|
| [SDD 清单](../../../packages/forge-sdd/package.json) | 私有包 `@heluo/forge-sdd`，bin 为 `forge-sdd`，导出库及 CLI 子路径 | 核实真实使用者；无用途部分才进入删除范围 |
| [CLI](../../../packages/forge-sdd/src/cli.mjs) | 实际命令只有 `freeze`／`verify`；不是历史示意的 `init`／`check`／`submit --one` | 识别命令调用与兼容窗口，不据历史示意新增命令 |
| [清单库](../../../packages/forge-sdd/src/manifest.mjs)与[冻结库](../../../packages/forge-sdd/src/freeze.mjs) | 形状、声明一致性、原始字节 SHA-256、锁及清单写入；不操作 Git 或业务关联 | 明确哪些最小校验仍有真实用途，不能把库存在当作需求 |
| [enterprise 清单](../../../packages/forge-enterprise/package.json)及[bin 转发](../../../packages/forge-enterprise/src/sdd-cli.mjs) | dependencies／bundledDependencies 仍含 SDD，`forge-sdd` bin 导入 `@heluo/forge-sdd/cli` | 后续同步依赖、包体闭包与 bin，不声称已移除 |
| [enterprise 补丁](../../../packages/forge-enterprise/cordis.patch.yml) | `insert` 仅 credentials-keychain、policy、IAM 三 Host；SDD 不是 Host 挂载行 | 不以“禁用第四行”冒充退役，不补空插件实现 |
| [SDD 测试目录](../../../packages/forge-sdd/test/) | CLI、manifest、freeze、package-shape 用例覆盖已有声明与包形状 | 退役时同步有用途回归；2026-11-03 盘点复跑 27 例通过，不认证企业 CI 或业务验收 |
| [装包演练调用](../../../scripts/probe/run-bundle-install-rehearsal.mjs) | 包含拒绝 SDD 作为 Host 的负对照，及已安装 bin 的 freeze／verify／篡改夹具 | 核实演练仍需覆盖的交付面；它不是默认业务需求 |

盘点尚须覆盖实际安装、外部 caller、目标仓库 CI、锁文件与发布资产中的引用。2026-11-03 本机补充核对：`.github/workflows` 无 `forge-sdd` 引用，仓库脚本不调用 `sdd check`；`pnpm-lock.yaml` 仅 workspace link；本机 web profile 已安装的 `@heluo` 包只有 devops 与 gitee。以上只证明本机与在库静态事实，不证明外部 caller 不存在。仅在上述用途与影响明确后提出实施范围；不能因本轮文档退役方向就删除既有用户产物。此处不承诺外部调用不存在。

## 4. 明确调用下的单规则集

只有现存明确调用继续适用旧清单规则。**同一检查项**在本地与 CI 使用同一规则、同一版本；本地结果标注“未经 CI 验证”，不替代 CI 的结论，两者结论不一致按缺陷定位。不是每次交付都必须双跑，也不要求所有 Issue 先补 SDD 清单。

目标仓库确需 CI 时，按其真实规则、权限及分支保护执行；CI 未跑、不可用或超时如实记未验证或失败，不冒充通过。企业 CI 任务接入与结果仍待真实证据；本地声明一致性不认证企业测试或业务验收。

## 5. 现存接口与冻结契约（仅兼容调用）

### 5.1 实际 CLI

```sh
forge-sdd freeze --root <目录> --manifest <清单路径> --unit <单元> \
  --change <变更号> --revision <声明版本> --tested-revision <声明测试版本> \
  [--requirement-revision <需求版本>] [--stage spec|implementation|archive] \
  [--artifact <相对路径>[:kind]]...
forge-sdd verify --root <目录> --manifest <清单路径> [--revision <当前版本>] [--json]
```

`--manifest` 必填，`--root` 缺省为 `.`；freeze 还要求 unit、change、revision、tested-revision 及至少一个产物。verify 的 `--revision` 是可选 caller 输入，不会自动读取 Git HEAD。退出码 0 表示当前命令成功，1 表示 verify 有阻断项，2 表示用法或环境错误；均不是业务验收通过。

历史示意配置 `sdd.root`、`sdd.freezeFile`、`sdd.strict`、`sdd.vcsCli` 不是现存 CLI 的已实现配置，不作为本版接口。现存命令不建分支、不提交、不建 PR、不归档、不触发 CI。

### 5.2 版本 1 清单

清单只声明本次列出的文件、冻结版本与测试版本，不是变更／Issue／repo 关联的权威记录，也不取代 Issue 或实际验证证据。

| 字段 | 现存检查与限制 |
|---|---|
| `version` | 当前为 `1`，其他值拒绝 |
| `unitId`、`changeId`、`revision`、`testedRevision` | 非空字符串；未验证远端变更存在、Issue 唯一关联或 revision 对应真实 Git 对象 |
| `requirementRevision` | 可选，由 caller 声明；当前实现不查询需求平台或自动使旧人工确认失效 |
| `testedRevision` | 必须等于 `revision`，只检查声明一致；不运行或认证测试，不证明该版本真实已测 |
| `stage` | 可选 `spec`／`implementation`／`archive`；缺省不额外要求产物类别 |
| `artifacts[]` | 至少一项；相对路径、SHA-256、可选 kind 与 unitId；拒绝重复路径、非法路径、已声明的外来 unitId |
| `testEvidence[]` | 可选；检查已提供状态及版本声明，不读取 ref 内容来认证测试；省略或空数组不证明测试通过 |
| `createdAt` | freeze 写入 ISO 时间；不能由此推定业务确认或服务端审计 |

### 5.3 校验能证明什么

| 规则 | 实际边界 |
|---|---|
| 缺文件或指纹变化 | HARD；SHA-256 对原始字节，不归一化换行，不证明业务正确 |
| 版本漂移 | 仅 caller 提供 `currentRevision`（CLI 的 `--revision`）时比较；不自动读 HEAD，省略时只验内部一致性 |
| 测试声明 | 已声明 failed／not-run／timeout 为 HARD，已声明通过项有不匹配版本时失败；不认证真实执行 |
| stage 同列 spec＋implementation | HARD，规则名 `atomic-delivery`；只证明清单含两种 kind，不证明文件真实类型、Git 提交、PR 或多文件事务原子性 |
| archive 缺失 | 有 stage 时仅 SOFT，不阻断；无 stage 时不强制归档 |
| 清单写入与锁 | freeze 以临时文件＋rename 写清单，按清单路径默认 `.lock` 的排他文件锁串行；锁占用拒绝，不自动回收陈旧锁。不是仓库级 Git 原子交付 |

旧指纹不因当前默认流程退出而自动改写。显式产物变更需在该兼容调用中重冻；非 UTF-8 内容不得回退到有损文本解码以兼容旧指纹。以上不增加普通 Issue 的冻结义务。

## 6. 权限、数据与失败边界

现存 freeze 写指定清单，verify 读清单及产物；它们没有托管仓库凭据、登录、提交或服务端授权逻辑。路径/风险/审计仍归 Policy 和实际工具控制，清单通过不能扩大授权。冻结及测试版本是 caller 声明，不能用它代写人工验收。

明确调用的 HARD 项失败即返回阻断；指纹变化要求核实产物后显式重冻；锁占用先核实是否仍有进程，不能自动删锁。CI 状态与本地校验状态分开，不把环境不可用伪装通过。未核验的日志采集与保留不承诺已实现，也不沿用历史“30 天”为正式制度。

## 7. 退役次序与保留判据

1. 核实 §3 的 CLI、组合包、测试、演练及实际外部调用，逐项记录使用目的、输入输出与必要性。
2. 对默认 Issue 链路不再要求 SDD 清单；只在有明确用途时提出最小保留项及理由，不因为已有代码反向造需求。
3. 实施前列清待移除依赖、bin、导出、测试、发布资产和文档引用；用户产物不随组件删除，不通过更名或空 Host 留下假能力。
4. 在另行授权的实施范围中处理未使用部分，验证调用与包体闭包；若保留小能力，明确归属与迁移边界，不维持第二执行者。

本版并未执行这些源码或配置改动。真实重复确认／阻塞的最小适配也须先有证据，不以退役为由新建 engine。

## 8. 验证与开放项

| 检查面 | 本轮证据／尚需证据 |
|---|---|
| 静态事实 | 已读 SDD src、清单、测试与 enterprise 清单、bin 转发、补丁；规则边界见 §5 |
| 现存单测 | 入口为 `node --test packages/forge-sdd/test/*.test.mjs`；2026-11-03 盘点复跑 27 例通过，但不认证企业 CI 或业务验收 |
| 组合与演练 | 现存测试及演练仅证明所述离线或历史范围，本轮不安装、不重跑 |
| Teamflow 适配 | 实际重复确认、阻塞、提交前缀及 PR／Issue 关联须按运行证据核验；不宣称已修复 |
| 外部调用及企业 CI | 真实使用者、目标仓库任务和版本对应结果未核实，不据本地代码推定 |
| 退役验收 | 仅在实施授权与调用盘点完成后，核对无悬空入口、无数据删除、无强制控制旁路 |

独立 AI 技术审查与用户验收分别留证。文档方向确认不是组件已退役、企业 CI 已接入或产品可交付的证明。
