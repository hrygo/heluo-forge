# 技能管理

状态：可用（本地实现；迁移后的验证边界见[设计索引](../../docs/design/README.md#22-实现与验证入口)）。

`@heluo/forge-skills-manager` 为 DSH 提供全局与项目技能、其他本机 Agent 技能、本地创建和导入、启停分类、回收站，以及 Nacos 企业公共技能库。下载包含完整资源，默认禁用，须由用户显式启用。界面支持中文、英文。

在「发现技能」按名称搜索企业技能，打开详情阅读 Markdown 说明与资源清单，选择全局或已登记项目后下载。成功提示可直接前往对应技能页查看和启用；本地修改不会上传到企业库。

本包可独立安装，也由 `@heluo/forge-enterprise` 组合交付。目标宿主版本由根 `.dsh-version` 管理。实现与部署边界见[设计](../../docs/design/plugins/forge-skills-manager.md)，配置字段见[Nacos 契约](../../docs/contracts/nacos-skills.md)。

## 配置与替换

```yaml
- id: skills-manager
  config:
    nacos:
      serverUrl: https://nacos.corp.example/nacos
      namespaceId: public
      usernameEnv: FORGE_NACOS_USERNAME
      passwordEnv: FORGE_NACOS_PASSWORD
```

凭据只经 Host 环境变量引用，不写入补丁。Nacos 账号必须由服务端赋予读取权限；客户端不使用管理员、不提供上传接口。共享账号不是个人 IAM 身份映射。只读账号的服务端拒写须另行验证。

替换旧版时先备份 profile 配置，再停用并移除旧 `@michengai/dsh-skills-manager` 挂载，安装新包并检查同一个 `skills-manager` 行只出现一次。保留原 `$DSH_HOME/skills-manager` 数据、宿主全局与项目技能；不同时运行两个管理器。卸载本包不删除这些数据。正式 `enterprise-*` 流程技能保留给企业 provider，本包拒绝同名个人副本覆盖。

## 开发

在仓库根使用固定 pnpm 工具链安装开发依赖，单锁文件管理。本包保留 TypeScript/esbuild 构建，`lib/` 是提交的生成物：

```sh
pnpm --filter @heluo/forge-skills-manager build
pnpm --filter @heluo/forge-skills-manager verify
pnpm check
```

只发布清单声明的生成物和资源。fflate、react-markdown 与 remark-gfm 在构建期内联，React 复用宿主。构建仅生成运行代码，检查命令核对生成物与源码一致性。终端不安装开发依赖、不编译。合成离线用例不连接企业 Nacos，也不代替真实宿主、企业联调或国产平台验证。用户页面写入不等同于 Agent 工具授权；首版不注册自动 `create_skill` 工具，不放宽企业策略的宿主目录保护。同账户进程和同权 Host 插件仍能绕过进程内检查，本包不提供进程隔离。
