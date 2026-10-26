# @heluo/forge-sdd

状态：可用（本地交付清单校验骨架；未经 CI 验证，未接企业仓库 CLI）

一句话：把"这次交付包含哪些产物、冻结在哪个版本、测试覆盖到哪个版本"写成清单，并用同一规则集在本地前置校验与 CI 两侧判断；指纹只证明文件未被改动，**不证明业务正确**。

| 项 | 内容 |
|---|---|
| 形态 | 最小企业指引 + 本地 CLI/库（本地前置校验与 CI 共用同一实现） |
| 职责 | 交付清单契约、freeze 与指纹、原子性与并发、变更追溯 |
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
| 版本 | 清单 `revision` 与当前仓库版本不一致报 `revision-drift`，冻结失效不静默沿用；`testedRevision` 必须等于清单 `revision`，不一致报 `test-revision-mismatch`，两份旧测试声明互相一致也不能通过；`not-run`/`timeout` 一律不算通过 |
| 原子交付 | 有阶段元数据时 spec 与 implementation 必须各自存在于同一清单；无 `kind`、仅 archive 或缺任一种均报 `atomic-delivery`；无阶段时不额外要求类别，归档缺失为 SOFT |
| 并发与原子性 | `freeze` 先写临时文件再原子改名，失败不留半份清单；同一目录用 `O_EXCL` 锁串行，锁被占用即拒绝且**不自动回收** |
| 路径 | 绝对路径与 `..` 穿越直接拒绝；与策略插件同源的路径纪律，不另建第二套 |
| 声明 | 本地结论标注"未经 CI 验证"，不替代 CI 权威结论；本地 hook 只做前置提示，不构成服务端级别的强制 |
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
