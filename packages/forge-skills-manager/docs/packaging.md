# 技能管理器独立制包与安装说明

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-002 |
| 文档名称 | 技能管理器独立制包与安装说明 |
| 版本 | V0.2.3 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-26 |
| 门禁 | 独立包闭包、profile 装载及同 Host IAM 共存验证 |

本说明描述 `@heluo/forge-skills-manager` TGZ 的构建、校验与 DSH profile 安装。

## 1. 制品与配置边界

- Skill Manager 由自己的 `package.json`、`cordis.patch.yml` 和构建入口生成 TGZ。
- 正式交付在制包时预置 Nacos 四项连接信息；地址、命名空间及 `credentialsRef: bundled` 写入独立 TGZ 的 `cordis.patch.yml`，账号密码写入 `private/nacos-credentials.json`。安装后直接生效，无需员工填写。
- 源码构建的中性 TGZ 不含部署值，仅用于开发与构建核验。
- Nacos 使用专用只读账号，不使用个人 IAM 权限。

## 2. 构建并核验

从仓库根目录使用仓库固定的 Node 与 pnpm：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @heluo/forge-skills-manager build
pnpm --filter @heluo/forge-skills-manager verify
node scripts/build-enterprise-bundle.mjs --entry @heluo/forge-skills-manager <new-output-dir>
node scripts/verify-enterprise-bundle.mjs <tarball.tgz> --manifest <new-output-dir>/bundle-manifest.json --json
```

以上得到中性包。正式交付使用本包自己的预配置入口，它从当前构建产物重新制作完整独立 TGZ，不需要 enterprise 或 IAM 配置：

```sh
node packages/forge-skills-manager/scripts/package.mjs --config <private-nacos.env> --version <private-semver> --output <new-output-dir> --dry-run
node packages/forge-skills-manager/scripts/package.mjs --config <private-nacos.env> --version <private-semver> --output <new-output-dir>
node scripts/verify-enterprise-bundle.mjs <private-tarball.tgz> --manifest <new-output-dir>/bundle-manifest.json --json
```

专用配置文件只接受以下 Nacos 字段，按数据读取，不执行 shell。四项必填，`HELUO_NACOS_TIMEOUT_MS` 可选：

```dotenv
HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos
HELUO_NACOS_NAMESPACE_ID=public
HELUO_NACOS_USERNAME=svc-ci
HELUO_NACOS_PASSWORD='<只读账号密码>'
```

配置输入必须未跟踪且受 Git 忽略，或保存在源码仓库外。输入文件的 POSIX 权限设置为 0600；Windows ACL 禁用继承，仅允许当前用户、SYSTEM 和 Administrators。完整输入文件不进入 TGZ。制包器生成仅含 `username`、`password` 的 UTF-8 JSON，大小不超过 16 KiB，归档权限为 0600，并将固定文件路径加入私版包的 `files` 清单。npm 解包权限受目标系统和安装方式影响；归档模式不保证 Windows ACL 或所有 POSIX 安装后的权限，交付验收须核验实际文件权限。持有交付包或同账户权限的人仍可读取凭据；这不提供加密或进程隔离。含凭据制品不得提交源码仓库或公开发布，凭据轮换需用新版本重新制包。

输出目录应位于源码仓库外且此前不存在，私版版本必须区别于中性包。保留源提交、工作区状态、构建记录、`bundle-manifest.json`、SHA-256 和 `packaging-receipt.json`。回执仅列字段名及 `nacos.password` 已内嵌声明，不打印值。`--dry-run` 完成预检但不生成最终目录。构建器按本包运行时依赖闭包制作单个 TGZ；当前没有 workspace runtime dependencies。

部署配置只注入根清单声明且实际生效的补丁行；插件 ID、包名和启用状态必须匹配。归档中的 `lib/THIRD-PARTY-NOTICES.txt` 随内联代码交付，构建时根据实际输出模块、依赖版本及原始许可生成，生成物一致性检查同时校验此文件。

## 3. 安装到隔离 profile

先创建一个新的测试 profile：

```sh
dsh --profile skills-debug --from-default-profile web --dump-config
```

在该 profile 目录安装 TGZ，并在现有 `package.json` 的 `dsh.profile.bundles` 数组中登记包名：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false <absolute-skills-manager.tgz>
```

不要覆盖 profile 中已有的其他配置。与其他插件共存时，各入口包在同一 profile 的 `dsh.profile.bundles` 中分别登记一次。

## 4. 启动与开发覆盖

正式交付包已带连接配置，登记 bundle 后直接启动同一 profile。已有 profile 若存在 `heluo-skills-manager.config.nacos` 覆盖项，会遮盖包内值；更新包时先备份并移除过时覆盖，不覆盖其他插件配置。

仅中性开发包联调需要临时覆盖时，在隔离 profile 的 `cordis.patch.yml` 中加入以下配置，并通过启动进程环境提供凭据：

```yaml
- id: heluo-skills-manager
  config:
    nacos:
      serverUrl: http://nacos.corp.example/nacos
      namespaceId: public
      usernameEnv: FORGE_NACOS_USERNAME
      passwordEnv: FORGE_NACOS_PASSWORD
```

使用中性开发包且未配置 Nacos 时，本地技能管理仍可使用。开发覆盖变更后重启对应 DSH profile。

正式包的补丁示例：

```yaml
    nacos:
      serverUrl: http://nacos.corp.example/nacos
      namespaceId: public
      credentialsRef: bundled
```

Host 只读取自身包下的固定文件，不接受任意路径引用，也不将读取结果写回配置对象。文件缺失、链接、超限、编码或字段无效时，企业库返回 `error.nacos.config`，清除缓存令牌，不使用环境变量补救；本地管理继续可用。不允许把 `credentialsRef` 与旧明文或环境变量字段混用。旧开发明文字段仍会被 Host 配置诊断序列化；正式包安装前须移除旧覆盖项。

维护人员在隔离环境可用 `dsh --profile skills-debug --dump-config` 核对：

- `@heluo/forge-skills-manager` 的 `heluo-skills-manager` 行恰好出现一次。
- 其他已安装插件的挂载与配置保留。

包结构与配置 dump 只证明制品闭包及装配；浏览器 UI、企业 Nacos 权限和目标平台分别验收。

员工排障只报告插件是否装载，以及 `error.nacos.config`、`error.nacos.auth` 等公开错误分类，不收集整份配置或凭据文件。独立包没有项目级安装器排障入口；企业安装器和交付器不参与此路径。最终 TGZ、合成凭据及真实 Host 的可复跑回归命令见源码仓库 `packages/forge-skills-manager/README.md` 的“自动化验证”章节。

## 5. 历史制品工具兼容

既有企业私版工具保留对含 `heluo-skills-manager` 挂载行制品的配置校验：`HELUO_NACOS_SERVER_URL`、`HELUO_NACOS_NAMESPACE_ID`、`HELUO_NACOS_USERNAME`、`HELUO_NACOS_PASSWORD` 为必填输入；`--dry-run` 预检，`--confirm` 确认生成。该路径仅服务已有组合制品；当前独立 TGZ 使用本文 §2–§4，不经过企业安装器或交付器。

历史组合工具仍可能把账号密码写入补丁；本文配置诊断无凭据的保证限定于 §2 的独立预置包及无旧明文覆盖的 profile，不追溯改变历史制品。
