# 文档漂移检查记录（2026-11-16）

首次核查基线为 `main` 提交 `aa4820bfb232c2c4e20a48ac9bb7cfdab61a08fe`；提交前已合入后续 `main` 提交 `4538f616a18acbcaad32ae9794d5e04ec46963ac` 中 PR #300 的相关文档修订。本报告记录核查发现及本次修订。范围覆盖 `docs/design/` 的 20 份 Markdown；对计划、契约、运维及随包说明做了与本轮发现相关的定点检查，并非对全仓文档逐句审计。以下“未发现漂移”仅表示已核查范围内未确认漂移，不代表计划能力已实现或通过企业验收。设计目标和有明确历史时点的记录不因未实现而自动判为错误。

## docs/design/README.md

- 已修订：研发 Token 位于各工具面板；Host watch 与 SSE 已接线，Client Remote 仍未接线。区分 #303 的多机测试汇总与具体专项证据，以及 #304 的网关验证。

## docs/design/client-identification.md

No drift detected.

## docs/design/conflict-resolution.md

No drift detected.

## docs/design/credential-modes.md

- 已修订：`credential_revoked` 的本地清除是目标条件，当前实现保留记录并阻断；限流退避目标与当前实现分开记载。

## docs/design/enterprise-menu-and-token-unification.md

- 已修订：研发凭据位置、三步引导、手动模型接口、默认模型所有权，以及扩展凭据存储与同进程安全边界。
- 待处理：当前客户端对跟随本机配置仍显示“正常可用”，凭据来源本身不能证明认证成功；文档已提示，运行时文案未修改。

## docs/design/iam-confidential-isolated.md

- 已修订：普通退出使用当前 AT 自证 GET 撤销；机密认证 POST 属回调清理等其他路径。远端撤销结果不明时保留 pending。

## docs/design/iam-consumer-isolated.md

No drift detected.

## docs/design/plugins/forge-brand.md

No drift detected.

品牌加载、目标系统资源解析及对比度未实测；文档中的能力与验收矩阵为目标。

## docs/design/plugins/forge-devops-lifecycle.md

No drift detected.

历史探针和目标验收已区分；六阶段全部企业能力、指标摄取和外部工具链未逐项联调。

## docs/design/plugins/forge-devops.md

- 已修订：设置页、可选凭据 Broker、共享六条只读策略目录和默认内存审计；Windows `dop` 1.0.4 的 `--state` 及 `--api-endpoint` 行为限定于已取证版本。

## docs/design/plugins/forge-engineering.md

- 已修订：组合补丁使用六条只读目录及内存审计，不支持旧示例中的 `failClosed` 和持久审计配置；修正不存在的检查命令。

## docs/design/plugins/forge-enterprise.md

- 已修订：当前组合包与研发套件的职责、五行研发补丁、IAM 受控模型运行时及默认模型只读边界。

## docs/design/plugins/forge-gateway.md

- 已修订：网关设计为规划入口，IAM 当前承载受管模型接入；限流/过载退避目标不等于已有实现。

## docs/design/plugins/forge-gitee.md

- 已修订：设置页、工具与策略目录数量、凭据优先级、明文风险扫描和审计持久性。

## docs/design/plugins/forge-iam.md

- 已修订：模型运行时归属、Host SSE 与 Client Remote、退出 pending、401 错误归因、模型目录保留和手动模型持久化边界。
- 待验证：绑定变更的重试受首个输出分片约束；真实宿主与网关的发送时序、请求次数及计费结果尚无对应证据。
- 待修复：重建等待期间取消后，当前运行时再次派发前不复查取消状态。独立合成探针观察到以已取消的 signal 第二次调用派发函数；这不证明真实网关收到请求。

## docs/design/plugins/forge-market.md

- 已修订：format-1 允许省略 `source.registry`，但企业交付如何保证始终使用企业源仍待确认；不假定缺省时的原生回退行为。

## docs/design/plugins/forge-policy.md

- 已修订：删去当前安装器不支持的配置字段，区分受门禁控制的动作与作用域外工具；本包未配置时无审计落点，发行补丁显式配置内存落点，持久 sink 和留存是后续要求。

## docs/design/plugins/forge-sdd.md

No drift detected.

已核对仓内包与企业补丁的退役状态；已安装 profile、已发布制品及外部调用方未检查。

## docs/design/services/devops-mcp.md

- 已修订：条件性 MCP 方案不以共享服务账号替代用户权限；身份传递和提供方协议仍待核验。

## docs/design/services/market-index.md

- 已修订：原有独立市场服务已移除；校验器接受合法预发布版本，并尝试排序而非拒绝乱序输入。
- 待处理：首版只收稳定版本及输入降序仍是交付目标，现有校验器没有强制执行这两项；预发布标识含连字符时比较器也不能保证正确排序。企业交付是否必须显式指定 `source.registry` 待裁决。

## docs/contracts/gateway-contract.md

- 已修订：区分当前不透明访问令牌与后续 JWT 候选、限定可重试错误及条件，并明确停用、当前授权退出和单个凭据吊销的作用范围。

## docs/contracts/iam-consumer-isolated.md 和 docs/contracts/iam-view-observer-isolated.md

- 已修订：根组合 E 是实际 IAM 工厂与 mock IdP 的本地联合验证；私有订阅只投影 12 个字段，不包含 `modelAccess`。

## docs/contracts/gh-cli-spec.md

- 已修订：历史命令输出示例中的疑似人员标识替换为占位符。当前文件已修正；已有 Git 历史中的内容未改写。

## docs/plans/2026-11-04-iam-dual-platform-acceptance.md

- 已修订：采用 public + PKCE、当前 SQLite/keyring 与旧数据保留边界；保留历史 NOT RUN/BLOCKED，不用旧记录覆盖 #303 后续多机汇总。

## docs/plans/2026-11-12-credential-storage-clean-arch.md 和 docs/plans/2026-11-12-credential-storage-execution.md

- 已修订：仅兼容当前绑定及分目录布局；旧 JSON/key 保留但不单独阻止新库，旧同目录 keyring 或无绑定旧库拒绝使用并保留原物。

## docs/plans/2026-11-12-iam-call-failure-recovery.md

- 已修订：未输出分片不能证明请求未发送或不会重复计费；模拟适配器的请求次数不代表真实宿主。
- 待修复：当前取消检查仅发生在异常捕获时，重建等待期间取消的窗口不在现有定向测试的覆盖内。

## docs/plans/2026-11-13-enterprise-manual-model-add-luna-guide.md 和 docs/plans/2026-11-13-enterprise-settings-and-manual-model-master-plan.md

- 已修订：将旧波次、旧 API 与所有权标为历史，记录当前 POST、`IAM_MANUAL_MODEL_*` 与 `hasManualEntry`；删除不存在的手动 ID 返回 `removed: false, persisted: false`，不代表写入失败。隐藏入口不会停用已保存模型，旧版写入可能覆盖手动声明。
- 待裁决：写入失败时采用事务回滚，还是维持当前 `ok: true, persisted: false` 的会话级 best-effort；不能仅凭现有测试把任一方案视为已获批准。
- 待验证：分别关闭管理入口与撤回运行支持的候选步骤、旧版写入后的恢复、真实宿主、网关和目标平台专项，见 #303、#304 和 #305。候选步骤需另行实施，现无现成的全局停用开关。

## docs/operations/README.md 和 docs/operations/enterprise-uat-2026-11/

- 已修订 `docs/operations/README.md` 与 `docs/operations/enterprise-uat-2026-11/README.md`、`安装与启动.md`、`验收测试清单.md`：限定为旧制品历史记录；仅隔离 `DSH_HOME` 不隔离当前凭据，移除无条件删除指导并补充日志脱敏。当前制品的隔离与安全清理流程仍待设计和实测。

## packages/ 和 services/market-index/ 的相关说明

- 已修订 `packages/forge-iam/README.md`、`packages/forge-iam/docs/developer-guide.md`、`packages/forge-iam/docs/user-guide.md`：退出、流取消、SSE、Key 格式和手动模型说明。
- 已修订 `packages/forge-policy/README.md`、`packages/forge-enterprise/README.md`、`packages/forge-engineering/README.md`：审计字段与持久 sink 的实现边界。
- 已修订 `packages/forge-devops/README.md` 的包归属及 `services/market-index/README.md` 的校验覆盖范围。
- 已移除 `packages/forge-gitee/README.md` 中将 Token 嵌入远端 URL 的建议，并修订审计说明。安全的替代认证传输须在目标环境核验，当前文档不宣称已经具备。

## 文档入口与架构

- 已同步 `docs/DOCUMENT-REGISTER.md`、`docs/README.md` 的版本、入口和实现状态。
- 已修订 `docs/architecture/platform-architecture.md` 的网关路线、市场和 Skill 职责及撤销证据边界。
- 已修订 `docs/architecture/public-enterprise-bundle.md` 的 Skill 路径、前置材料和制品验证状态。
