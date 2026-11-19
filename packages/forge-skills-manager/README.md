# 技能管理

状态：可用（本地实现；迁移后的验证边界见[设计索引](../../docs/design/README.md#22-实现与验证入口)）。

`@heluo/forge-skills-manager` 为 DSH 提供全局与项目技能、其他本机 Agent 技能、本地创建和导入、启停分类、回收站，以及 Nacos 企业公共技能库。下载包含完整资源，默认禁用，须由用户显式启用。下载响应中断时可核对结果，确认前不会重复安装。界面支持中文、英文。

在「发现技能」按名称搜索企业技能，打开详情阅读 Markdown 说明与资源清单，选择全局或已登记项目后下载。成功提示可直接前往对应技能页查看和启用；本地修改不会上传到企业库。

再次进入或刷新发现页时，卡片显示当前版本已下载的全局/项目范围，详情按所选位置提示并避免重复下载。本地修改保留下载标识并单独提示；移入回收站或移除后重新核验，恢复后重新显示。状态来自宿主安装记录及本地资源，不依赖浏览器历史；待确认或暂不可核验时不显示下载成功。不同来源及版本分别识别，不自动覆盖同名技能或升级。

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

预览版在启动 DSH 的进程环境中设置 `FORGE_NACOS_USERNAME`、`FORGE_NACOS_PASSWORD`，上述配置只写变量名。也可使用自定义变量名；省略这两个配置字段时使用上述默认名称。账号密码不需在构建或安装时设置、不打进插件包，也不需录入宿主凭据库。若使用本机私有 `.env`，须由启动脚本加载并注入 Host 环境，插件不自动读取该文件；秘密文件不得提交或放入交付物。修改外部环境或 `.env` 后须重启 DSH。

缺少或空白凭据时，企业库拒绝访问且不复用缓存令牌，本地管理仍可使用。进程内凭据变化会触发重新登录；令牌仅缓存于内存。Nacos 账号必须由服务端赋予读取权限；客户端不使用管理员、不提供上传接口。共享账号不是个人 IAM 身份映射；只读账号的服务端拒写须另行验证。环境变量方式是仅限预览版的 P8 受信存储临时例外，正式版接入仍须核验，详见[设计](../../docs/design/plugins/forge-skills-manager.md#3-配置与数据)。

本地操作响应丢失时显示待确认，通过「核对操作结果」读取 Host 回执，确认前不重复提交。确认后重新读取当前状态；刷新失败会明确提示视图尚未更新。插件卸载停止排队任务和远端读取，已开始的本地事务与下一实例串行衔接。

替换旧版时先备份 profile 配置，再停用并移除旧 `@michengai/dsh-skills-manager` 挂载，安装新包并检查同一个 `skills-manager` 行只出现一次。保留原 `$DSH_HOME/skills-manager` 数据、宿主全局与项目技能；不同时运行两个管理器。卸载本包不删除这些数据。本包在创建、导入与自身 provider 中拒绝 `enterprise-*` 个人候选；宿主原生 provider 的同名候选选择仍遵循宿主规则。

## 开发

在仓库根使用固定 pnpm 工具链安装开发依赖，单锁文件管理。本包保留 TypeScript/esbuild 构建，`lib/` 是提交的生成物：

```sh
pnpm --filter @heluo/forge-skills-manager build
pnpm --filter @heluo/forge-skills-manager verify
pnpm check
```

隔离宿主验收使用已安装 DSH 的 CLI 入口和本轮制品：

```sh
node packages/forge-skills-manager/scripts/verify-host.mjs <installed-dsh-cli.js> <plugin-or-enterprise.tgz>
```

该命令离线安装到全新临时 profile，启动仅绑定环回地址的真实 web 宿主，核对认证路由、并发管理、下载中断回执、重启恢复、同进程禁用/重载及卸载保留数据。Nacos 为合成 HTTP 服务，不读取用户默认配置；证据写入命令返回的临时目录。单包与企业组合制品分别执行。运行环境须提供与 Node 配套的 npm；浏览器交互、企业权限及目标平台另行验收。

只发布清单声明的生成物和资源。fflate、react-markdown 与 remark-gfm 在构建期内联，React 复用宿主。构建仅生成运行代码；生成物检查先通过包内 `scripts/check-sdk.mjs` 核对本包开发 SDK 与根 `.dsh-version` 一致，再比对生成物与源码。终端不安装开发依赖、不编译。合成离线用例不连接企业 Nacos，也不代替真实宿主、企业联调或国产平台验证。用户页面写入不等同于 Agent 工具授权；首版不注册自动 `create_skill` 工具，不放宽企业策略的宿主目录保护。同账户进程和同权 Host 插件仍能绕过进程内检查，本包不提供进程隔离。
