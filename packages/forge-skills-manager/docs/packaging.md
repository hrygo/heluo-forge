# 技能管理器独立制包与安装说明

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-SKILLS-002 |
| 文档名称 | 技能管理器独立制包与安装说明 |
| 版本 | V0.2.0 |
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
- 正式交付在制包时预置 Nacos 地址、命名空间、专用只读账号和密码，写入独立 TGZ 的 `cordis.patch.yml`。安装后直接生效，无需员工填写。
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

配置必须未跟踪且受 Git 忽略，或保存在源码仓库外。POSIX 权限设置为 0600；Windows ACL 禁用继承，仅允许当前用户、SYSTEM 和 Administrators。完整配置文件不进入 TGZ；账号密码写入包内补丁，因此持有交付包的人可以解包读取。含凭据制品不得提交源码仓库或公开发布，凭据轮换需用新版本重新制包。

输出目录应位于源码仓库外且此前不存在，私版版本必须区别于中性包。保留源提交、工作区状态、构建记录、`bundle-manifest.json`、SHA-256 和 `packaging-receipt.json`。回执仅列字段名及 `nacos.password` 已内嵌声明，不打印值。`--dry-run` 完成预检但不生成最终目录。构建器按本包运行时依赖闭包制作单个 TGZ；当前没有 workspace runtime dependencies。

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

仅开发联调需要临时覆盖时，在隔离 profile 的 `cordis.patch.yml` 中加入以下配置；真实账号密码不能提交源码仓库：

```yaml
- id: heluo-skills-manager
  config:
    nacos:
      serverUrl: http://nacos.corp.example/nacos
      namespaceId: public
      username: svc-ci
      password: '<只读账号密码>'
```

使用中性开发包且未配置 Nacos 时，本地技能管理仍可使用。开发覆盖变更后重启对应 DSH profile。

启动前用 `dsh --profile skills-debug --dump-config` 核对：

- `@heluo/forge-skills-manager` 的 `heluo-skills-manager` 行恰好出现一次。
- 其他已安装插件的挂载与配置保留。

包结构与配置 dump 只证明制品闭包及装配；浏览器 UI、企业 Nacos 权限和目标平台分别验收。

## 5. 历史制品工具兼容

既有企业私版工具保留对含 `heluo-skills-manager` 挂载行制品的配置校验：`HELUO_NACOS_SERVER_URL`、`HELUO_NACOS_NAMESPACE_ID`、`HELUO_NACOS_USERNAME`、`HELUO_NACOS_PASSWORD` 为必填输入；`--dry-run` 预检，`--confirm` 确认生成。该路径仅服务已有组合制品；当前独立 TGZ 使用本文 §2–§4，不经过企业安装器或交付器。
