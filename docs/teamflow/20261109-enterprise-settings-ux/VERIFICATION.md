# 四页精简上屏核验

> 代拟：Agent 起草，2026-11-09。记录本机一次性 profile 的实机证据，不代表企业侧联调或双端验证。

## 1. 环境

| 项 | 值 |
|---|---|
| 宿主 | 本机 DSH，`DSH_HOME=/tmp/ux-uat-dsh`，profile `uat`（一次性，验完删除） |
| 端口 | `127.0.0.1:48493` |
| 装载 | `@heluo/forge-devops`、`@heluo/forge-gitee` 由 `dist/ux-20261109/*/*.tgz` 安装；`@heluo/forge-iam` 以目录安装并写入补丁层 `- insert: heluo-iam`（该包无 `dsh.bundle`，`dsh plugin add` 不会自动进 bundles） |
| 视口 | 1440×810（截图为 1400×785 预览） |
| 主题 | 浅色 |

日常 `desktop` profile 未被改动；安装仅在 `/tmp` 副本内完成。

## 2. 定位限制（供后续复验参考）

设置面板内容挂在**闭合 shadow root** 内：`dsh_browser_click` 的 text/xpath 定位全部返回 `element not found`，页面内 `querySelectorAll` 也查不到；`document.body.innerText` 与 `dsh_browser_a11y` 可读。因此上屏操作走 a11y 坐标 + 坐标点击：

- 设置齿轮 `(254,742)`；左栏导航 x=385，y=108/152/196/240/284/328/372/416，依次为 通用设置 / 模型 / 内置插件 / Agent 预设 / 企业研发 / 企业账号 / Gitee / DevOps。

## 3. 逐页结果

### 企业研发

- 摘要行：`⚠ 3 项待处理 · 先处理身份与 Key`；右上 `刷新`。
- 行 1 `身份与 Key`：`未登录` + `· 无法判定`；展开 `详情` 可见 `公共参数：企业分发，本机不可改`、`身份与 Key 未登录`、`网关 Key 未知`、`前往企业账号登录 · 设置 → 企业账号`。
- 行 2 `本机工具`：`已配置` + `· dop 已找到 · Gitee 未配置`；右侧 `检查 DevOps`、`检查 Gitee`（禁用）；`详情` 折叠。
- 页脚一句：`本页只显示本机可见性，不代表业务授权。公共参数由企业分发；写权限由企业侧判定，本页不判断。`
- 七行合并为两行后，交付参数 / 写权限不再占主列表行。

### 企业账号

- journey：`1 身份 待配置登录 / 2 凭据 待配置 / 3 模型 待解锁`（当前步 `aria-current="step"`）。
- 卡片：`企业账号认证 · 单点登录至企业账号 · 企业登录尚未设置`；问题一条 `登录设置有冲突，请联系管理员。`，其余收进 `查看全部问题`。
- `刷新`；`登录后可配置` 折叠（未登录时凭据/模型卡不挂载）；`诊断` 折叠（复制登录链接 / 复制问题信息）。
- 头部唯一免责句：`登录只建立身份，不代表已获得业务写权限。`

### Gitee

- 标题 `Gitee`；intro `公共参数由企业分发；这一页只改本机差异。`
- 状态行 `全部沿用公共值与默认值` + `刷新` + `保存`。
- 行：`命令行入口 / 已自动找到 gh / 手动指定`；`命令超时 / 20 秒（默认）/ 修改`；`服务地址与凭据 / 由企业分发，本页只读`。
- `高级 · 通常不用改` 折叠（凭据变量名、持久化令牌策略）。
- 页脚：`本页只显示本机可见性，不代表业务授权。`

### DevOps

- 标题 `DevOps`；intro `插件会自己找 dop；只有找不到时才需要指定。`
- 状态行 `dop 已自动找到`。
- `dop 可执行文件`：`自动发现` + 实际路径 + `已自动找到` + `改为手动`。
- `命令超时`：`20 秒（默认）` + `命令超过这个时间就判失败`。
- 页脚：`检查` `保存`（未改动时禁用）+ 两行小字（保存/检查各一行）；未保存、未改动时不出回执句。

## 4. 实机发现的缺陷与修复

上屏核验发现三处测试未覆盖的缺陷，均已先补用例跑红再修。

### D-1 企业账号页重复报错

- 现象：问题清单之外多一行通用错误 `操作未完成，请重试；如仍有问题，请联系管理员。`
- 根因：`/api/forge-iam/view` 的 `error` 是服务端原始 reason `exclusive-violation`（`packages/forge-iam/src/exclusive.mjs:8`、`src/service.mjs:166`），`errorNotice()` 只识别 `IAM_*` 码，落到兜底句；而问题清单已用中文说明同一件事。
- 修复 `packages/forge-iam/client.js`：`errorNotice` 增加 `exclusive-violation` → `登录设置有冲突，请联系管理员。`、`exclusive-check-unavailable` → `暂时无法确认登录设置是否与其他插件冲突，请稍后重试。`；面板用 `hostErrorText` / `hostErrorDuplicatesIssue` 去重。
- 用例：`packages/forge-iam/test/client-settings-ux.test.mjs` 夹具补 `error: 'exclusive-violation'`，并断言正文不含 `操作未完成`。

### D-2 Gitee「保存」按钮黑底黑字

- 现象：按钮只剩黑色圆角块，文字不可见。
- 根因：`.fge-primary` 用 `--dsw-alias-brand-primary` 作底色、`--dsw-alias-label-inverse` 作文字色，当前主题两个 token 都解析为 `rgb(15,17,21)`。宿主成对用法见 `packages/forge-iam/client.js:20-23`：`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（实测后者为白色）。
- 修复 `packages/forge-gitee/client.js`：改用上述配对。
- 用例：`packages/forge-gitee/test/client-shape.test.mjs` 新增「主按钮用宿主的填充色/反白文字 token 配对」；回退 token 后 12 pass / 1 fail，恢复后 13/13。

### D-3 DevOps 页脚两行小字被挤成一行

- 现象：`检查` `保存` 右侧紧接两句说明，与设计「按钮下方两行小字」不符。
- 根因：`.fdv-footer` 为单行 `display:flex`，两个 `.fdv-receipt-hint` 被当作同一行的 flex 项。
- 修复 `packages/forge-devops/client.js`：`.fdv-footer` 加 `flex-wrap:wrap`，`.fdv-receipt-hint` 加 `flex:0 0 100%`，`.fdv-receipt` 加 `flex:1 1 100%`。
- 用例：`packages/forge-devops/test/client-shape.test.mjs` 新增「两行小字各占一行」；变异回退后 0 pass / 1 fail，恢复后 448/448。

## 5. 检查结果

```sh
node --test packages/forge-gitee/test/*.test.mjs     # 262 / 262 pass
node --test packages/forge-devops/test/*.test.mjs    # 448 / 448 pass
node --test packages/forge-iam/test/*.test.mjs       # 1209 / 1209 pass
node --test tests/ui-contract.test.mjs               # 9 / 9 pass
pnpm check                                           # exit 0；2846 例 / 2845 通过 / 0 失败 / 1 跳过
```

## 6. 未验与边界

- 全部证据来自 `/tmp` 一次性 profile 与本机主题；**未**接真实企业 IAM / 网关 / Gitee / DevOps 端点，**未**做 Windows、麒麟双端验证。
- 「未登录 / 未配置 / 不可达」是空环境与页内故障注入下的真实渲染，不等于企业侧实测。
- 截图未入库（含本机路径），仅作本机核对。
- 改动未提交、未推送；日常 `desktop` profile 需重新安装新 tarball 才能看到这些改动。
