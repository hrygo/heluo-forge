# 企业研发设置交互演示

> 非生产 DEMO。设计与实施说明由 Agent 代拟，基于用户已确认的演示范围；不是企业接入或业务验收证明。

## 已确认设计

- 企业公共参数默认预置，个人只需连接自己的账号与处理本机差异，不重复填写企业参数。
- 安装目标是现有 DSH 的 `settings.section`，不是独立网页，也不替换现有设置壳。
- 概览、个人账号、本机工具、交付示例、能力边界，以及模拟维护者可见的公共配置，全部只操作组件内存。
- 首次使用、已就绪、连接故障是可重置的 fixture。故障场景三个账号已连接，但发现的是公共 GitHub CLI，而不是企业 Gitee CLI。覆盖路径只模拟选择正确工具；恢复自动发现仍回到故障 fixture。
- 登录有明确页内模拟确认和取消，不跳转、不请求密码或令牌。准备检查通过也不会启用远端写入、推送、合并或业务验收。
- 维护者只能模拟保存公共配置草稿与检查应用。保存递增版本但不应用；应用后清空全部个人连接及检查。表单基准版本过期时拒绝保存。
- 不连接真实网络、配置、认证或业务服务，不执行 CLI，不读取工具路径，不改仓库。无浏览器持久存储、真实凭据输入、定时器或系统文件选择器。
- 状态在设置入口卸载或页面刷新后重置。维护视角不授予真实权限。
- 用户明确要求本阶段不做双平台验证。

## 实施计划与职责边界

1. 先编写并运行 [模型行为测试](./model.test.mjs)，确认模型缺失的红灯，再实现 [纯函数模型](./model.mjs)。
2. 在 [视图](./view.js) 提供双语文案、可访问的本地交互与 scoped 主题样式。
3. 使用 [构建器](./build.mjs) 将纯模型与视图内联至 [Client 制品](./client.js)，只从宿主加载 React，不增加依赖或安装期构建脚本。
4. 使用 locale namespace `heluo-settings-demo` 和 `ctx.effect` 托管资源；使用 `ctx.slots.inject` 等待现有设置槽位，再注册顺序 25 的“企业研发演示”分区。Host 入口不做任何工作。
5. 本地验证模型、生成物语法及打包资源闭包。主代理单独负责获授权的安装和真实浏览器交互检查，本目录实现不执行安装、不改 profile、不启动服务器。

包名：`@local/heluo-enterprise-settings-demo`。私有本地包；不是 `@heluo/forge-enterprise` 生产能力的替代品。资源清单与兼容性声明见 [包清单](./package.json)。图标为本演示原创齿轮与连接节点 SVG，无外部素材依赖。

## 本地构建与验证

从仓库根目录运行：

```sh
node --test demos/enterprise-settings/model.test.mjs
node demos/enterprise-settings/build.mjs
node demos/enterprise-settings/build.mjs --check
node --check demos/enterprise-settings/client.js
git diff --check
```

可在本目录执行以下命令检查实际打包资源，不会安装插件或改 profile：

```sh
npm pack --dry-run --ignore-scripts --json
```

只修改 [模型](./model.mjs) 和 [视图](./view.js) 源文件，再运行构建器；不要直接修改生成的 Client。构建器只读写本目录文件，不生成 HTML。

## 模型约定

- `initialState(scenario)` 返回独立 fixture；`reduce(state, action)` 不修改传入状态；`readiness(state)` 始终返回 `remoteReady: false`。
- `validatePublic(values)` 返回 `{ ok: boolean }`。名称非空；三个地址只接受 HTTPS 的 `*.corp.example`，拒绝 userinfo、query、hash 和控制字符。
- 路径仅存字符串，须非空且无控制字符；超时只接受 1,000–600,000 的整数毫秒。
- 所有动作同步完成，不代表探测过系统或验证过身份。交付样例只表达关联结构，不构成真实人工验收或批准。

## 验证边界

本地纯模型、构建和资源检查不能证明真实权限、企业 CLI、SSO 或 DevOps/Gitee 联调成功。未进行生产验证；双平台验证明确不在本轮范围。不把本说明或 fixture 就绪状态当作企业实测证据。

## 当前宿主走查记录（2026-11-04，Agent 代拟）

- 使用官方插件管理工具安装此独立本地包，返回 `application: applied`；没有修改已有业务插件配置或开放业务权限。
- 在现有 DSH 页面观察到“设置 → 企业研发演示”，并确认暗色界面可以正常显示。未另启服务器。
- 通过真实页面操作确认：单个账号模拟登录后显示已连接，且远端写入仍关闭。
- 连接故障场景中，选择示例企业 CLI、保存覆盖路径、运行模拟检查后，显示本地准备就绪；没有执行真实 CLI。
- 公共配置从 r1 保存到 r2 时，已应用版本仍为 r1；点击模拟检查应用后变为 r2，并提示个人连接已清空。
- 模拟另一维护者保存后，旧表单保存显示版本冲突，未静默覆盖。
- 已重置为“首次使用”概览，方便从头体验。
- 浅色主题、真实配置持久化、真实登录、企业业务联调和双平台验证未执行。这里只交付交互演示。

当前安装是链接到本演示目录的 profile 级演示插件，会出现在同一 profile 的其他会话中。可在 DSH 插件管理页面禁用或移除 `@local/heluo-enterprise-settings-demo`；不要删除或改写其他插件配置。源码仍为工作区未提交变更，未推送或发布。
