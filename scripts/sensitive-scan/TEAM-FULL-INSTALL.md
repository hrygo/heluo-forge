# 团队敏感扫描工具：完整分发包安装说明

**受控团队内部使用。** 完整包包含团队共用的 Ed25519 私钥、现有正式敏感规则、本地扫描与签名脚本、团队公钥及安装器；无需成员自行生成私钥或另找规则。压缩包是未加密的标准 ZIP；任何取得它的人都可以读取私钥和规则，必须按密钥材料级别保管并通过受控渠道分发。不得提交压缩包、解压后的私钥或规则到 Git，不得上传到 GitHub 或公开网盘。

## 安装前准备

1. 从授权保管人通过受控渠道取得未加密的完整包，并在独立可信渠道核对包的 SHA-256。
2. 安装 Node.js **24.x** 和 Git；使用标准 ZIP 解压工具。在终端确认 `node --version` 和 `git --version`。本包不需 npm/pnpm 安装依赖。
3. 将包解压到**仓库外、由当前用户或可信管理员控制且其他人不可写的私有目录**。解压会产生明文私钥和规则；不要在公共可写或未经批准的共享／同步目录解压。不要把整个解压目录放入项目工作树。
4. 在 Git 仓库确认 `git rev-parse --git-path hooks/commit-msg`。如果已存在不同的 `commit-msg`，安装器会拒绝覆盖，也不会自动串联。联系维护者先整合既有 hook。其他 hook 不会被改动。Linked worktrees 或共享 `core.hooksPath` 可能共用同一个 hook，安装前确认影响范围。

## 安装

解压后 `<工具目录>` 指包含 `scripts/` 和 `private/` 的 `heluo-sensitive-scan-team` 文件夹。`<项目仓库>` 指团队项目的 Git 仓库目录。示例中的尖括号需替换为实际路径；保留引号以支持空格。

### Windows PowerShell

```powershell
node --version
git --version
node "<工具目录>\scripts\sensitive-scan\team-full-install.mjs" --repo "<项目仓库>"
```

### macOS / Linux / 银河麒麟

```sh
node --version
git --version
node '<工具目录>/scripts/sensitive-scan/team-full-install.mjs' --repo '<项目仓库>'
```

安装器会验证包中的 Ed25519 私钥与团队公钥匹配、验证正式规则，再将脚本、密钥及规则安装到 Git common dir，并在 Git 选定的路径安装 `commit-msg`。使用 `git rev-parse --git-common-dir` 查看当前仓库的 common dir；默认结构如下，不需要在工作树添加忽略规则：

```text
<git-common-dir>/heluo-sensitive-scan/
├── private/
│   ├── device-key.pem
│   └── rules.json
└── scripts/
    ├── lib.mjs
    ├── team-scan.mjs
    └── team-commit-msg.mjs
```

在默认共享 hook 配置下，同一 clone 的 linked worktrees 共用此安装；hook 被 Git 调用时从当前工作树解析实际 common dir 并扫描当前工作树的暂存内容。安装器只核对安装时已有的工作树；新建 worktree 后须在该工作树执行 `git rev-parse --git-path hooks/commit-msg`，确认实际路径指向已安装的共享 hook。后续的 `includeIf.gitdir`、worktree 专属配置、环境变量或其他 Git 配置覆盖可能让 Git 不调用共享 hook，程序无法强制覆盖这些配置。安装器拒绝相对 `core.hooksPath`，并检查已有工作树是否选用同一个 hook 路径；可使用安全的绝对共享路径。common dir 不得位于任何工作树的普通可跟踪目录，正常的工作树直属 `.git` 元数据目录除外。对于外置 `--separate-git-dir`，若 Git 将元数据目录列为主工作树且存在 linked worktree，安装和运行会因无法确认真实主工作树而失败关闭；需由维护者调整 Git 布局。独立 clone 各需安装；如果不同 clone 共用 `core.hooksPath`，已有不同 hook 会被拒绝，须由维护者协调。安装器不改写未知的 `pre-commit`：若旧入口通过 worktree 私有 git-dir 查找 `dsh-hooks`，应由维护者迁移至 common-dir，不能关闭或绕过原 hook。

若已有不同的密钥、规则或 hook，常规安装停止且不覆盖；完全相同且权限安全的配置可重复安装。此前安装过完整包 v1 的成员需要使用新版完整包升级，见下节；不要自行覆盖已有脚本或未知 hook，也不要替换密钥和规则。旧 `sensitive:scan` / `sensitive:install` 使用不同的规则格式和路径，属于 legacy v1，不能满足团队 v2 远端验签；旧安装器拒绝覆盖团队 hook。可通过 `SENSITIVE_SCAN_KEY_FILE`、`SENSITIVE_SCAN_RULES` 指定对应文件；这两个环境变量必须使用绝对路径，并且同时对安装器、Git 和图形 Git 客户端生效。`XDG_CONFIG_HOME` 不改变此完整包的默认位置。目标仓库内的覆盖路径同样必须被忽略且未跟踪，不能经过符号链接或不安全目录；不得放在其他 Git 工作树中。Windows 原生 Node 需使用 Windows 原生路径。

macOS/Linux/Kylin 会为新目录设为 `700`、新私钥和规则设为 `600`，并拒绝权限过宽的现有目标；hook 也会在读取前检查文件权限及仓库内忽略和跟踪状态。请确保父目录不被其他用户写入。Windows 文件 ACL 由管理员按单位策略设置，安装器不会验证 Windows ACL。Git 忽略不是访问控制，也不能阻止 `git add -f`；请勿强制添加、分享或备份到不受信任的位置。

## 从完整包 v1 升级

使用通过受控渠道取得并核对摘要的新版完整包，按上文安全解压。升级时运行的 Node 可执行文件路径必须与既有 hook shim 记录的路径一致；路径不一致时停止并联系维护者，不要修改未知 hook。

Windows PowerShell：

```powershell
node "<工具目录>\scripts\sensitive-scan\team-full-install.mjs" --repo "<项目仓库>" --upgrade-known-v1
```

macOS / Linux / 银河麒麟：

```sh
node '<工具目录>/scripts/sensitive-scan/team-full-install.mjs' --repo '<项目仓库>' --upgrade-known-v1
```

此显式升级仅接受完整的已知 v1 安装，或中断后由已知 v1 与新版包中完全一致的程序组成的混合状态；已有 hook、私钥和规则必须与安装包匹配。安装器将发生变化的公开源码备份到 Git common dir 内 `heluo-sensitive-scan/backups/`，再逐个原子替换程序；不覆盖规则、私钥或未知 hook。替换不是整体事务，中断后先暂停提交，再使用相同命令重试；若检查失败，联系维护者检查备份，不要强行覆盖。旧 v1 签名会被 v2 远端验签拒绝；升级后按下节检查 v2 trailer，已签名的在途 v1 提交须重新扫描和签名。

## 安装完成后

- 核对安装器输出的团队公钥 SHA-256 指纹：

```text
b8d63d50c82fee19b3b39f0acd2723494ede9b3309e502a1f262b084628b299b
```

- 在仓库暂存一个不含敏感内容的普通文本变更并执行 `git commit -m "test: local check"`。成功应有 `sensitive-scan: clean; attestation written`；`git show -s --format=%B HEAD` 中应有 `Sensitive-Scan: v2`。不要将专门的测试提交推到生产分支。
- 密钥和规则确认已安装后，**由使用者手动安全处理解压目录中的明文副本**；hook 执行 common dir 内安装的脚本，不再依赖解压脚本目录，但仍依赖安装时的 Node 可执行文件。原包应按密钥材料级别保管；后续为其他 clone 安装或重装时，从受控包重新安全提取，完成后再次处理明文副本。
- 密钥、规则、权限或现有 hook 冲突时应联系维护者，不要自行生成新团队密钥，也不要覆盖不认识的文件。

## 工作方式与限制

团队 v2 trailer 和签名内容不包含规则文件指纹，远端拒绝带规则字段的旧试验版 v2；旧试验版验签器也不能验证新版 v2。若已安装过旧试验版 v2，请暂停提交并联系维护者安全迁移；`--upgrade-known-v1` 不支持升级该试验版，不要自行覆盖未知文件。旧版 `scan.mjs` 会输出规则摘要、旧版 `commit-msg.mjs` 会将摘要写入 v1 trailer；不要将旧命令用于真实敏感规则，团队应只使用新版 team hook。历史已公开的摘要不会因代码更新而消失。

本地 hook 使用包内的现有正式规则：提交信息和暂存文件路径会扫描；普通 UTF-8 文本默认检查新增／修改行，UTF-16 文本保守地扫描全文件；设置 `DSH_HOOK_FULL=1` 时检查整份暂存文本；`.xlsx`、`.xlsm` 和 `.xltx` 检查工作簿包中的 XML 和关系文件文本；包含无法扫描的宏、图片或嵌入对象等二进制内容时会阻断，而不是声称已扫描其内容。现有允许项和忽略路径保留。未忽略的未知二进制、过大或不可读取内容会阻断签名。发现敏感项只在本地提示，不向 GitHub 上传规则或命中详情；正常 Git 源码推送仍会把提交的文件送到远端。

团队 hook 的 v2 签名绑定实际扫描基线 HEAD tree；远端要求提交恰有一个父提交，且父提交 tree 与签名基线一致，并拒绝 v1。root 和 merge 提交不签名。rebase 后基线 tree 改变须重新扫描并签名；普通 amend 的最终父树通常与 hook 扫描的 HEAD tree 不同，须重新扫描并签名，amend 时生成的不匹配签名会被远端拒绝。仅当基线 tree、提交 tree 和消息均不变时，committer 改写或无冲突 rebase 可保留签名；这不能防止扫描过程中的竞态。

这是 Git hook，不是对 DSH 插件安装的直接证明。后续 Git 配置覆盖或 `git commit --no-verify` 可绕过本地 hook；团队共享私钥的持有人也能自行签名。只有 GitHub 验签工作流和公钥合入基线、测试通过并设为 required 后，才有远端验签合并门禁作为兜底；当前包本身不会更改 GitHub 设置，也不能防止共享私钥持有人自行签名。

## 管理员上线和轮换

先在受控渠道分发完整包，确认团队配置；将单公钥验签代码及公钥经 review 合入 PR 基线，实测有效签名通过、缺失/错误签名失败，再将 `sensitive-attestation-verify` 设为 required，并保持 linear history、rebase-only 和分支最新。安装包不自动启用这些设置。团队私钥泄露或需撤销持有人时，由保管人安排全员密钥轮换并重签在途 PR；共享密钥无法单独撤销一个成员。

此前完整包在本机 macOS / Node 24 上验证；新版 v2 包及升级路径须另行验收，Windows、Linux、银河麒麟和图形 Git 客户端也须各自实机验收。仓库实现和 GitHub 门禁的部署状态以实际 PR 与分支保护为准。
