# @heluo/forge-sdd

状态：可用（本地交付清单校验骨架；未经 CI 验证，未接企业仓库 CLI）

2026-11-03 当前用户已确认本组件**退出默认交付要求，以独立组件退役为目标**；先盘 CLI／bin、bundle dependency、测试和调用者，只保留有清晰用途的最小能力，不为旧代码制造冻结需求。本轮仅改文档，包、源码、CLI、依赖及已安装 profile **未删除、未卸载、未停用，不能称已实际退役**。需求真源见[基线 §2.3](../../docs/requirements/requirements-baseline.md#23-issue-交付模型与受控研发目标需求已确认)，兼容与退出顺序见[SDD 设计](../../docs/design/plugins/forge-sdd.md)。

以下描述仍存在的 freeze／verify 兼容能力，不是当前 Issue 交付的必填清单或 spec／freeze／archive 门槛。指纹只证明指定文件字节一致，**不证明业务正确、测试真实来源、当前 HEAD 或 Git／跨仓库原子交付**。充分 Issue 不另写规格，Agent 按需设计，Teamflow 内部 PRD／蓝图可作运行材料但不是第二需求真源。

| 项 | 内容 |
|---|---|
| 形态 | 现存本地 CLI／库（非 Host 插件）；退出默认、待盘点兼容及退役，同项本地／CI 检查仍共用规则版本 |
| 职责 | 兼容既有清单校验、freeze／verify、文件摘要与锁；保留范围由真实用途盘点决定，不是默认交付门禁 |
| 不负责 | 不接管对话流程，不替代代码评审，不自行执行路径门禁（路径规则由 [@heluo/forge-policy](../forge-policy/README.md) 执行） |
| 衔接点 | CLI（`forge-sdd`）、CI 检查任务 |
| 详细设计 | [详细设计](../../docs/design/plugins/forge-sdd.md)（草案；§5.1 交付清单契约与校验规则） |
| 实现状态 | 清单校验、冻结（原子写入 + `O_EXCL` 锁）、CLI 与本地/CI 一致性用例已实现；企业仓库 CLI 与 CI 任务接入未实现 |

## 当前实现

| 项 | 状态 |
|---|---|
| 规则分级 | HARD 规则恒生效；**无阶段元数据时只跑 HARD 规则**，不阻断普通开发；SOFT（归档缺失）只在声明阶段时提示 |
| 交付单元 | `unitId`/`changeId` 必须显式声明，**不按文件名猜业务范围**；产物条目属于其他单元即失败并指出文件 |
| 指纹 | `sha256` 按产物原始字节逐文件写入（文本、二进制一致，不先解码 UTF-8）；冻结后任何改动报 `fingerprint-mismatch` 并指出路径；显式变更须重新冻结 |
| 版本 | 调用者给出 `currentRevision` 时，比对清单版本，不一致报 `revision-drift`；当前版本仍是可选输入，不能保证自动校验 HEAD。`testedRevision` 与清单 `revision` 不同报 `test-revision-mismatch`，只比对声明，未认证真实测试来源；`not-run`／`timeout` 不算通过 |
| 清单内类别检查 | 既有实现声明阶段时要求 spec 与 implementation 同列，否则报 `atomic-delivery`；无阶段时不额外要求类别，归档缺失为 SOFT。仅为旧清单规则，不证明 Git 或跨仓库原子交付，不成为新 Issue 的规格要求 |
| 并发与原子性 | `freeze` 先写临时文件再原子改名，失败不留半份清单；同一目录用 `O_EXCL` 锁串行，锁被占用即拒绝且**不自动回收** |
| 路径 | 绝对路径与 `..` 穿越直接拒绝；与策略插件同源的路径纪律，不另建第二套 |
| 声明 | 本地结论标注"未经 CI 验证"，不冒充 CI 结果；本地 hook 不是服务端强制。必要 CI／分支保护仍守，但不统一以 CI 或已合并作为用户验收前提：本地验证与独立 AI 审查后可待用户对实际版本验收，各状态分记 |
| 无关改动 | 冻结只写自己的清单文件，不触碰工作区中无关文件（用例校验内容与 mtime 不变） |

## 用法

```sh
node packages/forge-sdd/src/cli.mjs freeze --root . --manifest docs/sdd/freeze.json \
  --unit U-1 --change C-2026-1 --revision "$(git rev-parse HEAD)" --tested-revision "$(git rev-parse HEAD)" \
  --artifact docs/sdd/spec.md:spec --artifact src/a.mjs:implementation
node packages/forge-sdd/src/cli.mjs verify --root . --manifest docs/sdd/freeze.json --revision "$(git rev-parse HEAD)" --json
```

退出码：`0` 通过；`1` 有阻断项；`2` 用法或环境问题（清单缺失、锁被占用）。

安装包公开 `@heluo/forge-sdd/cli` 子入口，供组合方通过包解析定位并作为独立 Node 命令执行；该入口会读取进程参数并设置退出码，不适合常规 library import，也不是 Host 插件。库调用请使用包根入口或 `/freeze`、`/manifest` 子入口。

产物默认按原始字节读取；`verifyManifest` 保留既有 `readText(path)` 注入参数，文本用例可返回 UTF-8 字符串，二进制 reader 应返回 `Buffer`，缺文件返回 `undefined`。旧实现对非 UTF-8 产物生成的指纹可能不同，需核实原始产物后显式重新冻结；合法 UTF-8 文本的指纹不变，不以有损解码兼容旧二进制指纹。
