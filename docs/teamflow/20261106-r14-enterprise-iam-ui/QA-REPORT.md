# 企业研发设置与 IAM 整合 QA 报告（代拟）

## 结论

**不可验收：实现未交付，T0 接线准入环境阻断；另发现 1 项 P2 文档门禁缺陷。** 本轮不能证明正式 UI 主路径工作，不将既有代码或文档存在当作功能通过证据。环境超时不登记为源码缺陷，未实现也不伪称已完成后发生的运行时故障。

## 范围与环境

- 核验时间：2026-11-06，Asia/Shanghai；目标为当前隔离工作树中的 r14 交付，来源为本地源码、任务文档和命令执行。
- 已按根 AGENTS.md 摘要及 §4/§5 核对；当前工作区即产品根，不另外创建 products 子树。
- 实测 Node v24.13.0；pnpm 可执行，但本轮未查询版本；宿主版本未取得，不继承技术方案中的版本声明。
- 开发交接与 [接线记录](<INTEGRATION-NOTES.md>) 均明确 T0 失败，T1～T5 未实施。记录的原始错误：`Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then retry.` 本轮不再次触发已重复失败的查询。
- 初末 git status 相同：两个既有版本检查文件修改、demos、既有 IAM 探针及本任务夹未跟踪。无插件业务源码差异；保留场外修改，不安装、不改 profile、不提交、不推送。

## 执行证据与结果

以下命令均于上述日期执行。shell 命令设置显式超时，不重定向输出。

| 检查 | 命令/操作 | 退出码/结果 | 断言及解释 |
|---|---|---|---|
| 业务交付差异 | `git diff --stat -- packages/forge-devops packages/forge-gitee packages/forge-iam`，10s | 0，空输出 | 与开发“未实施源码”一致，不代表功能通过 |
| 新接口静态检索 | grep 工具：packages 下 *.mjs，模式 `forge-enterprise-preparation\|settingsSnapshot\|saveSettings\|/preparation\|/local-config\|PUBLIC_CONFIG_READ_ONLY` | No matches found | 方案约定的新接口没有实现证据，不把它们当作实际跨模块调用 |
| 仓库完整门禁 | `pnpm check`，120s | 1 | 文档检查报 12 项非 Markdown 目标 fragment 错误，串行后续检查及自动测试未执行；见 D-1 |
| 技术方案回归命令 | `node --test packages/forge-devops/test/ packages/forge-gitee/test/ packages/forge-iam/test/`，120s | 1，3 fail、0 pass | Node 将三个目录作为模块入口，均报 `MODULE_NOT_FOUND`；未执行任何真实用例。停止该路径，不以替换命令绕过或宣称回归通过 |
| 空白差异 | `git diff --check`，10s | 0 | 已跟踪差异无空白错误；不覆盖未跟踪任务文档语义 |
| 提交面卫生 | `git status --porcelain`，10s，初末各一次 | 0，清单一致 | 无可见 node_modules、dist、缓存、IDE 或 .env 新增；未跟踪目录内容及包体未逐项审计，不宣称完整零泄漏 |

## AC 与轻量架构/接口检查

| 范围 | 结果 | 判断 |
|---|---|---|
| AC-1～6、8～13 | BLOCKED | 没有本轮正式页面、事务/编排/路由实现及主路径执行证据；不能拿现有 IAM 或 Demo 替代 |
| AC-7 | BLOCKED | 公共维护权限、作用域与应用接口尚未闭合；只读方案不等于维护功能完成 |
| AC-14 | FAIL/部分 BLOCKED | pnpm check 实测失败；独立 profile 浏览器与本轮回归未通过 |
| AC-15 | BLOCKED | 安装/回滚/使用说明与真实包体证据未交付；未操作日常 profile、未推送、未双端验证 |
| 架构蓝图 | 未实施，无法判合规通过 | 技术方案要求 DevOps 承载总览、Gitee 自有配置、IAM 唯一真源、单点事务装配；本轮无源码修改，无新增重复安全封装或跨包源码依赖可审。模块未抽取不是已实现架构缺陷，而是整轮未实施 |
| 跨模块接口一致性 | N/A（实际新增调用为 0） | 对照方案新方法和路由检索无匹配；不得将未来 `gitee.settingsSnapshot()`/`gitee.saveSettings()` 当现有 API。没有可审查的新增 import/obj.method 调用，不签署接口已闭合 |
| 主路径可执行性 | BLOCKED | 尝试了完整门禁及方案测试命令，均未形成新主路径工作证据；功能验收门禁不通过。因已明确环境前置阻断与未交付，不误报为已交付程序 dead-on-arrival |
| UI craft | NOT RUN | 无本轮可展示 UI，不能凭设计文档编造 P3 视觉缺陷或观感分数 |

## 缺陷表

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-1 | P2 | 交付文档 | 仓库根运行完整质量门禁 | 本任务文档符合现有链接规则，检查链可继续 | DESIGN.md 4 条、TECHNICAL.md 8 条源码链接带行 fragment，被文档检查器拒绝；共 12 error(s) | AC-14、15 | `pnpm check` | 退出码 0；不再出现 fragment on a non-Markdown target，且完整检查链通过 |

D-1 定位： [设计依据](<DESIGN.md>) 与 [技术依据](<TECHNICAL.md>) 中指向 js/mjs 的行号片段链接。修复应遵循检查器规则，不放宽门禁。本轮 QA 不修改设计/技术文档或业务源码。

## 人工补测及恢复清单

以下均为待恢复/待实施，不是已通过项目；环境限制本身非交付缺陷。

1. 宿主恢复 Client Inspect 连接后，使用真实 Slots 合同完成 T0：正式设置导航、身份失效边界、editor 移除覆盖/注释保留、Gitee 重挂载；记录宿主版本。未通过前不接线、不猜 URL。
2. 实施 T1～T5 后，运行真实配置公共 API 正反例与身份/配置交错测试，分别断言业务写=0、IAM token 注入=0、未知配置保留、基准冲突、迟到结果失效及脱敏；补正可执行测试入口。
3. 获准独立 profile 后先核验精确卸载/回滚命令，再安装并用真实浏览器验证账号跳转、保存/应用/检查、未知降级、恢复继承；失败先回滚。当前未安装，无需执行卸载。
4. 在设计规定的窄屏/200% 缩放、浅深主题下验证溢出、焦点、禁用/加载反馈与 aria-live；读屏及动效观感由人工使用浏览器/辅助技术补测。
5. 公共维护需真实权限及接口证据，未取得保持只读。真实企业凭据、CLI 平台稳定性与双端均 NOT RUN；不输入真实 Key、不调用收费模型、不扩展本轮授权。

## 交接

先修复 D-1 并恢复 T0 前置条件，再继续实现；完成后重新执行 QA，不得将本报告视为验收通过证明。当前自动检查失败和运行环境/未实施阻断分别记录，未将历史测试数量或企业证据沿用到本轮。
