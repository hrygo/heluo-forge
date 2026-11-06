<!-- meta: summary="T0 只读准入复核：当前阶段位于授权 worktree，但宿主 journal 仍绑定主工作树且最终提交模板固定 feat 前缀；M1 阻塞，T1～T5 未释放。" -->
# T0 宿主准入复核

> 编制：实施执行者（代拟）；核验日期：2026-11-05；状态：**M1 阻塞，未进入业务实现**。依据本任务 [PRD](<PRD.md>) AC-6、AC-9、AC-10、AC-13 及 [技术方案](<TECHNICAL.md#10-任务划分与所有权>)，当前唯一释放项为 T0。本文不是 QA 通过、独立审查或用户验收结论。

## 1. 本次实测与版本

- 本阶段 `pwd`、`git rev-parse --show-toplevel HEAD`、`git branch --show-current` 与 `git worktree list --porcelain` 的真实结果一致：执行根为用户授权的隔离 worktree，分支 `feat/plugin-workflow-new`，HEAD `55e964c7d347cfd1a89160de8035ebee16992ae9`。初始未跟踪项仅为本任务夹；旧快照中的主目录分支和未提交项不属于本阶段执行根。
- 实际工具版本：Node `v24.13.0`、pnpm `11.28.5`、DSH `0.2.1-rc.5`；仓库 [目标版本](<../../../.dsh-version>) 仍为 `0.2.1-rc.3`。已安装 Teamflow 清单版本为 `0.3.2`，本次只读查看其已安装源码，没有安装、升级或改配置。
- 真实调用一次 `teamflow_status({runId:'tf-mw39rd97-pmo6is'})`，返回 `running`，当前阶段为开发、任务 `dt-1`。这是对既有 run 的查询，不是新启动或续跑。该返回同时保留了 PRD 状态读取失败记录；不能单凭历史日志推定当前执行根。
- 进一步只读核对宿主持久化 journal，**其 `workspacePath` 实际仍为主工作树，不等于当前授权隔离 worktree**。这将问题从旧日志冲突收窄为本次可直接复核的根绑定不一致；没有修改 journal，也不推断造成错位的原因。

## 2. 门禁与短证据表

| 门禁 | 本次证据及其性质 | 结论与未验边界 |
|---|---|---|
| G0 授权根与机器通道 | 本地 Git 实跑确认当前授权 worktree；宿主 journal 第 24 行 `workspacePath` 指向主工作树。journal 第 197、217 行分别记录 PRD、技术状态缺失；本地对应状态文件存在且可读取。Teamflow 已安装源码第 12049～12057 行使用 `gitRun(journal.workspacePath, ['commit', '-m', …])` | **阻塞**。当前 shell 根正确不等于宿主收口根正确。最终提交代码使用 journal 根，存在向未授权主工作树收口的风险；不得让当前 run 继续自动收口。状态缺失的具体读取原因仍未单独实测，不声称已确诊所有机器通道问题 |
| G1 实际提交首行 | Teamflow 0.3.2 已安装源码第 675、1104 行的 `commit.final` 均固定 `feat:`；第 12049～12057 行最终提交调用使用该模板。第 11403～11404 行仅在 `preAction=commit` 使用 `commitMessage` | **阻塞**。与 AC-10 的实际首行 `[变更号]` 不兼容。未执行真实最终提交，未提交临时仓库，不用模板检查冒充 Git 实跑；未修改宿主、钩子或提交历史 |
| G2 权威业务关联 | 本仓库 [Gitee 详情字段](../../../packages/forge-gitee/src/gitee-adapter.mjs) 不含结构化变更关联；[DevOps 外部仓库事实边界](../../../packages/forge-devops/src/change-context.mjs) 仍为 `REPO_FACTS_EXTERNAL`。当前没有选定的真实企业 Issue／变更／仓库证据 | **未解除**。这是源码投影核对，不是企业读实测；不能据此断言企业平台没有其他接口。权威唯一关联、范围、验收、依赖及要求版本均未取得，不伪造对象进行联调 |
| G3 完整既有 run 查询 | Teamflow 0.3.2 已安装源码第 13460～13503 行：有 runId 时读取单个 run；无参仅 `runsFor(sc.projectKey).slice(0, 10)`，需求摘要截为 60 字。公开 start 工具参数未声明 Issue 绑定或外部幂等键 | **未解除**。已知本 run 可读取，不证明可完整排除更早的企业任务 run；不把当前 workspace 键当唯一业务绑定，不新增映射库或再启动一个 run |
| G4 独立只读审查 | 本轮 `cordis_inspect_list` 及 `Service.listService({})` 可发现 `agentLoop`、`subagents` 的创建／查询契约；本执行者为可写的实现上下文，剩余委派深度为 0 | **未解除／NOT RUN**。没有创建审查子上下文、没有写拒绝实测，也没有独立同版本审查。能力发现不是权限隔离证明，不尝试扩大既定授权 |
| G5 目标宿主与企业条件 | 实际 DSH rc.5 与仓库目标 rc.3 不同；本轮未提供首个真实企业对象及必要仓库规则证据 | **未解除／NOT RUN**。目标 rc.3、企业 Gitee／dop 关联、凭据／授权、IAM、受保护仓库规则、Windows／麒麟均未验证，不声称企业链路可交付 |

宿主证据的可复核逻辑位置（以下是配置路径表达式，不是新增产物）：

- journal：`$DSH_HOME/teamflow/ws-heluo-forge-eda4cf81/runs/tf-mw39rd97-pmo6is.json`。
- 已安装插件：`$DSH_HOME/profiles/web/node_modules/.pnpm/dsh-plugin-teamflow@0.3.2/node_modules/dsh-plugin-teamflow/`；以上源码行号均指其 `lib/host.mjs`，版本取自其 `package.json` 第 3 行。
- 原生查询引用：`dsh-resource://teamflow/run/ws-heluo-forge-eda4cf81/tf-mw39rd97-pmo6is`。完整只读工具记录保留在本阶段宿主会话，不复制命令输出、不落主机绝对路径或日志副本。

## 3. 停止点与交接

1. **本阶段到此停止业务实施。** T0 完成了准入核查及阻塞记录，但没有通过 M1；T1～T5 未释放。没有修改产品源码、发行资源、profile、宿主或历史任务夹；没有安装、启动／续跑业务 run、stash、暂存、提交、推送、合并或修改企业对象。
2. 发起端应先阻止本 run 在主工作树自动最终提交，再核对实际阶段根、journal 根、状态读取根及最终收口根。当前执行者只读报告，不调用取消／续跑工具、不改 journal、不代用户选择宿主根、不将状态复制到主目录补票。
3. G0 恢复一致后仍须解除 G1：取得支持公开提交契约的实际宿主／插件及隔离 Git 实跑证据，或者由用户明确调整范围；不能只把变更号写进 requirement、补提交、amend 或绕过钩子。
4. G2～G5 需要真实来源与宿主证据补齐。确认这些门禁闭合后再由发起端释放条件化任务；不能用本次“整体开发”通用任务标题覆盖技术方案明确的停止条件。
5. 本文新增文档与规定开发状态文件留在当前授权 worktree，不提交。本阶段仅验证记录及边界，不存在可计为产品主链路终态的运行；全仓代码测试、打包安装、真实交接／续跑、独立审查及最终提交均为 **NOT RUN**。

## 4. 静态验证口径

本阶段执行结果以阶段回复的 `[Verification evidence]` 为准。文档／状态结构与差异检查通过只证明本次记录可读取且格式合规，不解除上述门禁。全仓文档检查若仍报告既有 PRD 授权原文含主机绝对路径，应原样报告并保留输入，不改 PRD、不放宽检查器，不将其写成全仓检查通过。
