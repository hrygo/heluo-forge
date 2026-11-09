# IAM 最新主线结合核验（Agent 代拟）

核验日期：2026-11-05。主线基准 `a1d7263`，当前分支文档提交重放为 `0db3c65`；未推送。原提交保留在本地 backup 引用中。原有 Demo 及未提交改动保留。

## 验证结果

- 采用仓库正式指南 `packages/forge-iam/docs/local-mock-testing.md` 与 `scripts/probe/run-iam-local-uat.sh`，从 HEAD 打包临时副本，使用独立 DSH_HOME/profile；未修改日常 profile。测试采用本机端口 48488/48489，避开默认端口。
- 当前 CLI 宿主为 DSH 0.2.1-rc.5，低于指南实测的 0.2.2-rc.1；未升级全局宿主。
- 真实浏览器走查：开始、模拟登录、进入凭证步骤、稍后配置、完成、打开企业账号设置、退出。没有输入真实 Key，没有调用真实网关或收费模型。
- `/api/forge-iam/view` 返回 200；模拟登录成功；退出后 `signedIn=false`、`state=signed-out`、模型目录为空。之前旧版遇到的 `IAM_CONNECTION_UNAVAILABLE` 未再出现。
- 最新 `run-iam-managed-models-probe.mjs` 独立执行成功，使用安装的 Cordis/LLM/PiAiAdapter、Mock IAM/网关和内存凭证；登录、目录、对话、刷新、退出通过，退出后调用次数为 0。它不是 GUI 或真实企业验收。
- 最新 `pnpm check`：2726 个测试，2723 通过、2 失败、1 跳过。文档、仓库、打包和版本检查通过。两项失败均为 `tests/host-probe.test.mjs` 的宿主组合探针，在当前 CLI 上报 `Cannot read properties of undefined (reading '0')`，不能声称全库通过。未为消除失败降低测试要求。
- 此前版本检查将 Demo 的 engines.dsh 清单声明误判为运行代码固定版本：新增正反向用例（先失败），仅扩展清单识别到 demos 一级包；依赖固定版本与运行代码仍拒绝。修正未提交。

## 结合方向

1. **唯一身份入口归 IAM**：复用企业账号启动器、登录/退出、onboarding、个人网关凭证和模型设置。正式产品不复制 Demo 的三个独立模拟登录、不创建另一套身份/凭证记录。
2. **企业研发页负责准备状态**：公共参数来源/版本、本机 CLI 差异、DevOps/Gitee 检查结果和下一步提示。身份状态来自 IAM 非敏感视图；登录操作引导至已有账号页。
3. **认证与工具授权分开**：IAM 登录不等于 DevOps/Gitee CLI 已绑定或具备写权限。目前 Gitee runner 使用 CLI/环境凭据路径，并非已经统一消费 IAM；不能将 IAM access token 自动塞给两个 CLI。
4. **公共配置仍需正式闭环**：预置参数与个人覆盖分层、校验/保存/应用/检查分别呈现；复用插件真实配置读写，保留未知配置。Demo 的维护视角不是真实管理权限，不能直接上线。
5. **Mock 注入只用于临时副本**：默认生产装配的原子存储/安全准入门禁不因本次演示解除。真实 IAM、Keychain、企业 CLI 与双端验证仍未执行。

## 资产取舍

后续统一使用协作者维护的 UAT 脚本。此目录的 `iam-review.patch.yml` 和 `scripts/probe/iam-review-memory-credentials.mjs` 是排查旧版本问题的临时装配，仅用来复现未配置/安全拒绝；不作为推荐部署或生产组合，不需要安装到日常 profile。原 Demo 保持独立的虚构数据交互演示，本轮没有将其改为生产认证 UI。
