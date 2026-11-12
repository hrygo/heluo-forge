# CI 平台验证优化实施计划

> **For agentic workers:** 使用测试驱动的分步实施；各任务以可独立验证的结果结束。

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-019 |
| 文档名称 | CI 平台验证优化实施计划 |
| 版本 | V0.2.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-12 |
| 门禁 | 仓库离线检查与托管平台回归；目标宿主和企业环境另行取证 |

> 编制依据：需求基线规定的目标终端、仓库现有 CI 与分支保护要求。

> 关联文档：[需求基线](../requirements/requirements-baseline.md)、[工程开发约定](../engineering/development-conventions.md)、[贡献指南](../../CONTRIBUTING.md)。

**Goal:** 使 CI 的名称、测试和成本符合实际平台验证范围，维护既有合并门禁。

**Architecture（初始阶段）:** 保留已被 `main` 分支保护引用的历史检查名称，改进其他作业及步骤名称；将 Windows 回调与敏感扫描测试合并到同一个非必需作业的一次测试运行中，保持必需门禁不变。平台安装冒烟验证实际制品中的 SQLite 分目录、轮换和恢复；目标机验收独立记录。

**Tech Stack:** GitHub Actions、Node.js 内置测试与 SQLite、现有离线包构建脚本。

**Spec:** [需求基线](../requirements/requirements-baseline.md)、[工程开发约定](../engineering/development-conventions.md)。

## 2026-11-12：检查名称与分支保护迁移

初始阶段为保持必需检查上下文而保留旧名称。用户随后要求将六个平台作业的显示名称改为与 SQLite、IAM 验证内容一致；job ID、平台、测试、分类与失败关闭行为保持不变。

2026-11-12 只读核验 `main` 的分支保护：下表六项旧名称仍为必需检查；四项 Linux/Windows 检查绑定 GitHub Actions（`app_id=15368`），两项 macOS 检查未指定来源。`verify (ubuntu-x64)` 与 `sensitive-attestation-verify` 也为必需检查，后者绑定同一 GitHub Actions 来源。远端状态以再次实测为准。

| 旧名称 | 新名称 |
|---|---|
| `native keychain (linux-x64)` | `SQLite and IAM (linux-x64, ubuntu-24.04)` |
| `native keychain (linux-arm64)` | `SQLite and IAM (linux-arm64, ubuntu-24.04-arm)` |
| `native keychain (win32-x64)` | `SQLite and IAM (win32-x64, windows-2022)` |
| `native keychain (win32-arm64)` | `SQLite and IAM (win32-arm64, windows-11-arm)` |
| `document backend (macos-15)` | `SQLite and IAM (darwin-arm64, macos-15)` |
| `document backend (macos-15-intel)` | `SQLite and IAM (darwin-x64, macos-15-intel)` |

迁移顺序：

1. 提交待评审的工作流和文档改动后，在目标 PR 的实际受检提交上运行六项新检查，核对名称、来源与结果均符合预期。
2. 新检查成功后，由获明确授权的用户或操作者将分支保护中的六项旧名称替换为新名称，保留既有来源绑定、`verify (ubuntu-x64)`、`sensitive-attestation-verify` 及其他保护配置。
3. 重新读取分支保护和 PR 检查状态，确认六项新名称与工作流完全一致、其他必需项未丢失；结果以实际远端记录为准。

旧名称仍为必需项时，仅改名会使 PR 缺少旧检查而被分支保护阻塞；因此必须在合并前完成名称迁移，不能等待合并后才切换。本计划记录所需步骤，不代表远端配置已更改。

## 初始阶段约束

- 已配置的必需检查上下文、受信验签、文档变更的保守分类和失败关闭行为保持不变；不修改远端分支保护。
- 保留已有平台及架构覆盖；托管 Windows Server、Ubuntu 和 macOS 的合成测试不充当目标桌面、国产系统、DSH/Electron 或企业联调取证。
- 不新增运行时依赖、系统钥匙串或真实凭据；临时数据库、密钥和备份均在测试专用目录内。

## 失败模式审阅

- 平台作业名称或 required 上下文被误改：回归用例核对固定名称与平台。
- 平台测试被删除、跳过、改成 `echo` 或仅写在注释中：工作流守卫及负向变异必须拒绝。
- Windows 回调或敏感扫描测试没有执行，或一项失败使另一项跳过：通过同一次测试运行及工作流正反向用例约束。
- 安装包缺少轮换、分目录或配对恢复能力：安装冒烟与故障夹具必须失败。
- 文档把托管测试称为企业目标机验收：核对开发约定、贡献指南与实际步骤一致。

## 任务 1：工作流与门禁

**文件：** `.github/workflows/check.yml`、`tests/ci-workflow-conditions.test.mjs`。

1. 先为必需上下文、可安全改名的作业、Windows 回调并入和实际执行命令补正反向断言，确认旧工作流或变异会失败。
2. 调整可安全改名的作业与步骤，把 Windows 回调测试并入现有的非必需 Windows 敏感扫描作业，在同一次 `node --test` 运行中执行；保持分类、取消、权限、必需检查及其他平台验证。
3. 执行 `node --test tests/ci-workflow-conditions.test.mjs`，并检查 Windows、Linux、macOS 作业条件与必需上下文。

## 任务 2：已安装制品验证

**文件：** `scripts/probe/installed-credential-smoke.mjs`、`tests/installed-credential-smoke.test.mjs`。

1. 增加缺少轮换或持久文件能力的合成包负例，确认旧冒烟不能发现问题。
2. 使用安装包 API 和合成值验证分目录、轮换前后值、停止访问后的配对复制及只读恢复；不访问用户存储。
3. 执行 `node --test tests/installed-credential-smoke.test.mjs`，并保留目标机、ACL 与断电耐久性未验边界。

## 任务 3：文档与交付

**文件：** `CONTRIBUTING.md`、`docs/engineering/development-conventions.md`、`docs/DOCUMENT-REGISTER.md`。

1. 按最终工作流更新受控文档版本与登记，说明历史 required 名称、实际测试对象和目标机取证边界。
2. 执行 `pnpm check`、`git diff --check`、`git status --short` 和敏感扫描证明校验，记录结果与耗时。
3. 提交并更新现有 PR，核对 GitHub 平台矩阵与审查状态；不将 CI 绿灯等同企业验收。
