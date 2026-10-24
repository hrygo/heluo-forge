# 插件索引契约（format-1 / AIHUB 交付）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-012 |
| 文档名称 | 插件索引契约（format-1 / AIHUB 交付） |
| 版本 | V2.0.1 |
| 文档状态 | 评审稿 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-25 |
| 门禁 | G1 索引契约；G2 三目标安装 |

> 编制依据：2026-10-21 用户决定采用 DSH 原生索引源轻量模式，由 AI 开发者平台（AIHUB）维护并托管 format-1 JSON；不再生成 `policy/evidence/current`，不设写前授权与租约。AIHUB 交付项见 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。
>
> 关联文档：[轻量市场设计](<../plugins/forge-market.md>)、[ADR-11／13](<../../architecture/plugin-registry-source-decision.md>)、[需求基线](<../../requirements/requirements-baseline.md>)、[P0 取证单](<../../plans/market-p0-verification.md>)。
>
> 核验边界：format-1 字段与解析行为于 2026-10-21 对 DSH `0.2.1-rc.2` 做只读核对；未验证企业 Artifactory、AIHUB 实际索引或三目标安装。`0.2.1-rc.2` 是接口核验版本，不是企业发行批准。

## 1. 一页速览

| 问题 | 答案 |
|---|---|
| 产物是什么 | 一份 UTF-8 JSON，`format: 1` |
| 谁生成 | AI 开发者平台（AIHUB） |
| 谁托管 | AIHUB，提供稳定只读 URL |
| 谁消费 | DSH 原生「插件市场 → 索引源」 |
| 包体从哪来 | 企业 Artifactory；由 `versions[].source.registry` 指定 |
| 本项目做什么 | 定义字段、校验工具、验收清单；不生成、不托管、不代理 |
| 不包含什么 | integrity、OS/CPU、policyRevision、installEnabled、expiresAt、证据 |
| 当前状态 | 目标链路为 DSH 原生「索引源」+ AIHUB 托管 format-1 JSON，不要求企业发行预置自定义市场插件；`packages/forge-market` 与旧 HTTP 服务为历史参考；企业审核批准、AIHUB 索引交付、三目标安装与发行分发尚未完成 |

一句话：**索引只回答“有哪些包、哪些精确版本、从哪个 npm 源装”，不回答“现在是否允许装”。**

## 2. 范围与边界

**本文覆盖**

- format-1 顶层、插件、版本、metadata、展示资源字段。
- `source` 只允许 npm；registry 指向企业 Artifactory。
- 版本排序、去重、稳定版规则。
- 托管、更新、撤回与校验要求。

**本文不覆盖**

- 插件构建、审查、Gitee 建仓、npm 发布（AIHUB 现有流程）。
- 终端安装实现（官方 `pluginManager` 与 pnpm）。
- 逐用户/逐版本授权、撤回强制执行、审计证据。
- Git/tarball/本地路径来源。

## 3. 顶层结构

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `format` | number | 是 | 固定 `1` |
| `title` | string \| object | 是 | 非空；语言对象必须含 `en` |
| `description` | string \| object | 否 | 同上 |
| `metadata` | object | 否 | 只允许 `categories`、`labels`、`sortKeys` |
| `plugins` | array | 是 | 可为空；每个元素见 §4 |

`metadata.categories` / `labels`：`{ "<id>": { "title": { "en": "...", "zh": "..." } } }`。
`metadata.sortKeys`：`{ "<id>": { "title": {...}, "order": "asc" \| "desc" } }`。

```json
{
  "format": 1,
  "title": { "en": "Enterprise Plugins", "zh": "企业插件" },
  "description": { "en": "Curated by AIHUB", "zh": "由 AI 开发者平台维护" },
  "metadata": {
    "categories": { "tools": { "title": { "en": "Tools", "zh": "工具" } } },
    "labels": { "stable": { "title": { "en": "Stable", "zh": "稳定" } } },
    "sortKeys": { "updated": { "title": { "en": "Updated", "zh": "更新时间" }, "order": "desc" } }
  },
  "plugins": []
}
```

## 4. 插件字段

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `name` | string | 是 | 合法 npm 包名；同一索引内唯一；禁止 `*`、scope 通配、版本/tag/range |
| `title` | string \| object | 否 | 含 `en`；缺失时原生回退到 `name` |
| `description` | string \| object | 否 | 同上 |
| `icon` | string | 否 | 见 §7 |
| `author` | string | 否 | 展示用；不得放凭据 |
| `homepage` | string | 否 | HTTPS |
| `repository` | object | 否 | `{ "url": "https://...", "directory": "可选相对路径" }` |
| `metadata` | object | 否 | `category`、`keywords[]`、`labels[]`、`sortKeys{}`；引用必须先声明 |
| `versions` | array | 是 | 非空；见 §5 |

## 5. 版本字段

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `version` | string | 是 | 精确 SemVer；首版只放稳定版（无 prerelease）；同包内唯一 |
| `publishTimestamp` | number | 是 | Unix 秒整数，`0 ≤ x < 10^11` |
| `source.type` | string | 是 | 固定 `npm` |
| `source.registry` | string | 否 | 企业 npm 入口；可为内网 HTTP；不得含凭据/query/fragment |
| `engines.dsh` | string | 否 | 合法 SemVer range；需与企业 DSH 版本兼容 |

排序与去重：

- `versions` 按 SemVer 降序；预发布低于同版本正式版。
- 同一包内版本不得重复；同一索引内 `name` 不得重复。
- 不跟随 dist-tag；索引里写什么精确版本，市场就展示什么。

## 6. `source` 与 Artifactory

- 只允许 `{ "type": "npm", "registry": "..." }`；不支持 Git、tarball、file、alias。
- `registry` 必须是终端可访问的企业 npm 入口（虚拟仓），聚合内部包与公网缓存。
- 终端读权限由统一分发的 `.npmrc` 或受管配置提供；**索引不得包含 token/用户名/密码**。
- 内部 scope 禁止回源公网；公网镜像包只允许单向缓存。
- 同名同版本不可变；索引不得指向已覆盖或删除的版本。

## 7. 展示资源

- `icon` 可为：
  - HTTPS 绝对地址；
  - 与索引同源的相对路径（按索引 URL 解析；仅当索引为 HTTPS 时可用，HTTP 索引请用 data URL 或 HTTPS 绝对地址）；
  - `data:image/(svg+xml|png|jpeg|webp);base64,...`，解码后 ≤32 KiB。
- 不得使用公网 CDN、HTTP 图片或带凭据的 URL。
- `title`/`description` 建议 en + zh；至少 en。

## 8. 托管与更新

| 项 | 要求 |
|---|---|
| URL | 稳定、只读、无凭据；优先 HTTPS，内网 HTTP 可接受 |
| 重定向 | 不返回 3xx，直达最终地址 |
| Content-Type | `application/json; charset=utf-8` |
| 缓存 | 提供 `ETag` 或 `Last-Modified`；`Cache-Control` ≤ 5 分钟 |
| 大小 | ≤ 2 MiB |
| 编码 | UTF-8，无 BOM |
| 原子性 | 先写临时对象再整体替换，或平台提供的等价机制；失败保留上一份完整 JSON，不得半份覆盖 |
| 可用性 | 内网匿名可读，或走现有网络准入；不得要求浏览器额外登录 |

索引更新后，原生市场按自身缓存策略刷新；本项目不控制客户端缓存 TTL。

## 9. 更新与撤回时限

| 场景 | 时限 | 行为 |
|---|---|---|
| 新版本上架 | ≤10 分钟 | 追加到 `versions`，保持降序 |
| 插件首次上架 | ≤10 分钟 | 新增 `plugins[]` 条目 |
| 版本撤回 | ≤5 分钟 | 从 `versions` 删除；必要时删整个插件 |
| 紧急阻断 | 立即 | 先删索引条目，再在 Artifactory 撤销/隔离 |
| 生成失败 | — | 保留上一份完整 JSON；不发布空文件 |

撤回后不恢复旧版本，除非重新审批并发布新版本号。

## 10. 校验

仓库提供只读校验器 [validate-index.mjs](<../../../services/market-index/validate-index.mjs>)：

```sh
node services/market-index/validate-index.mjs https://aihub.example/plugin-index.json
node services/market-index/validate-index.mjs ./index.json --base https://aihub.example/plugin-index.json
```

校验内容：

1. JSON 可解析，`format === 1`，`title` 含 `en`。
2. 包名、版本、时间戳、source、engines、icon、metadata 引用合法。
3. 版本去重、降序；`source.type` 只允许 npm。
4. 未知成员按原生行为忽略，但不得用未知字段承载授权/策略。

AIHUB 交付前须用该脚本自检，并在三目标各做一次真实安装（见 DESIGN-007 §9）。

## 11. 已知限制

- format-1 没有 `integrity`、OS/CPU、matrix、policyRevision、installEnabled 或 expiresAt。
- 因此本契约**不能**提供写前授权、租约、逐版本证据、撤回强制或全通道覆盖。
- 安装信任来自：AIHUB 策展、Artifactory ACL/不可变、原生市场提示与终端网络边界。
- 不能阻止用户添加其它索引、用 CLI 或任意 spec 安装；不宣称 REQ-14/G2 通过。

## 12. AIHUB 交付与跟踪

稳定 URL、示例 JSON、更新时限、三目标联调、负责人与待确认问题统一见 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。该 issue 是本契约的交付与验收入口；契约变更先改本文，再同步 issue。

## 附录 A 历史参考实现（HTTP 服务契约，不属目标）

以下保留旧 HTTP 参考服务的端点/错误码表，仅供 `packages/forge-market` 的历史契约测试与追溯；当前轻量模式不使用该服务，也不代表目标链路。

### 旧服务说明（自有 JSON 服务）

> **可跳过。** 记录旧协议、字段与计数局限，供维护与迁移使用；不证明 npm 目标。

### A.1 旧配置草案

以下配置表是**历史生产草案**，仅用于追溯旧 HTTP 服务；该服务已移除，本表不是当前 schema、部署承诺或目标前置。当前仓库只有[只读校验器](<../../../services/market-index/README.md>)。

| 配置项 | 类型 | 默认值 | 必填 | 旧草案含义（未实现，非目标必填） |
|---|---|---|---|---|
| `service.listen` | string | `:8080` | 是 | 旧监听地址草案；当前 CLI 默认 loopback |
| `service.db` | string | 空 | 是 | 历史数据库连接草案；当前服务及目标最小路径都不要求它 |
| `gitee.host` | string | 空 | 是 | 旧 Gitee 主机字段；目标仅内部定制证据相关 |
| `gitee.group` | string | 空 | 是 | 旧 group 字段；不适用于公网镜像 |
| `review.required` | boolean | `true` | 否 | 历史人工评审开关，目标不采用逐版本审批 |
| `metrics.syncHours` | number | `6` | 否 | star 同步间隔草案，当前无同步任务 |

### A.2 端点

以下端点状态只描述当前参考实现，不表示 npm 或上游 format-1 兼容；规划端点返回 404。

```text title="端点"
GET  /api/plugins                  已实现；条目列表与筛选；`mine=1&submitter=` 只返回该提交方的条目与待审记录，缺 submitter 返回 400 `missing-submitter`
GET  /api/plugins/{name}           已实现；详情与版本；响应为 `{ entry }`，不提供评价聚合分
POST /api/plugins                  已实现；必填字段与 tag 校验后加入内存待审队列
GET  /api/metrics?plugin=          已实现；旧下载请求数与 star，返回计数保存能力标记、star 来源与同步时间
GET  /api/plugins/{name}/versions/{v}/download  已实现；发放 Gitee 归档地址和可空 digest，撤回版本返回 409；不代理包体
POST /api/admin/review             已实现；上架、退回、撤回
GET  /api/discover/gitee           规划；扫描专门 group 的仓库尚未实现
```

`/api/admin/*` 一律要求 `authorization: Bearer <令牌>`；服务端未配置 `adminToken`（`HELUO_MARKET_TOKEN`）时全部 401，不回退成开放。

```text title="端点（其余）"
GET  /api/admin/unindexed          已实现（返回空列表）；未收录条目与原因，供诊断视图
```

### A.3 数据模型与字段

| 实体 | 关键字段 |
|---|---|
| plugin | `name`、`title`、`summary`、`scenarios`、`maintainer`、`repo`、`status`；旧草案拟按 group 成员解析维护人，当前并未连接该接口；新发布条目填空字符串，已载入目录可带值，空值表示「未知」而非「无维护人」 |
| version | `version`、`tag`、`archiveUrl`、`engines`、`submittedAt` |
| review_task | 条目、状态、评审人、理由、时间 |
| metric | 条目、`downloads`、`stars`、`syncedAt`；参考实现返回 `countsPersisted`、`starsSource`、`starsSyncedAt` 作为口径说明 |

当前参考协议字段级约定（现有客户端与 JSON 目录按此命名；不覆盖目标 npm/upstream 字段）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 包名，条目唯一键 |
| `title` | string | 展示名；缺省与 `name` 相同 |
| `status` | string | `pending`、`listed`、`rejected`、`revoked` 之一 |
| `tag` | string | 发布标签；缺失时按 `v<version>` 推导，不得由客户端伪造 |
| `archiveUrl` | string | 归档地址，由服务端填写 |
| `engines` | string | 目标 `engines.dsh`，形如 `>=0.2.1` |
| `submittedAt` | string | ISO 8601 提交时间 |
| `revoked` | boolean | 版本已撤回；为真时不再发放归档地址，下载端点返回 409 |

### A.4 提交与评审

**提交请求体**（`POST /api/plugins`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 包名，须在受信范围 |
| `repo` | string | 是 | 仓库地址，须属于专门 group |
| `tag` | string | 是 | 形如 `v0.1.0`，与清单版本一致 |
| `summary` | string | 否 | 一句话说明，展示时按纯文本 |
| `scenarios` | string[] | 否 | 适用场景 |
| `submitter` | string | 否 | 提交方标识；仅用于「我的提交」过滤，**不是身份认证** |

`submitter` 是唯一归属线索：服务端没有账号体系，该值由调用方自报，**只能用于过滤展示**；缺 `submitter` 时返回 400，而不是退回全量。

**评审请求体**（`POST /api/admin/review`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 条目包名 |
| `action` | string | `approve`、`reject`、`revoke` |
| `version` | string | 可选；`revoke` 时给出则只撤回该版本，条目本身仍上架并可从其他版本安装 |
| `reason` | string | 可选；退回与撤回的原因，写入审计 |

`revoke` 不带 `version` 时整条下架；带 `version` 时只标记该版本（下载端点返回 409），其余版本仍可安装。响应返回 `{ name, version?, state }`。

旧 Gitee 方案原设想按仓库成员判定维护人、读取归档与 `engines.dsh`；不是 npm 目标要求。当前参考实现未连接 Gitee，新建条目维护人为空，提交只检查必填字段与 tag；`approve` 不代表包格式、摘要、来源或兼容性已核验。

**并发**：旧草案的条目发布锁尚未实现；计数按（条目, 机器哈希, 日）在内存去重，缺机器哈希时按（条目, 日），重启不保留。不能据此声称发布事务或 npm 全局计数已完成。

**超时**：旧 Gitee 扫描/调用没有接线；目标 CI 取包超时不新增候选，保留可解释失败。客户端结果未知先核对，不自动重放安装。

### A.5 格式校验码

下表保留现有 `validate.mjs` 校验码及旧内部包规范；插件自检已调用它，但当前 HTTP 服务提交/审批**并未执行完整校验**，不能把“不进索引”误认成已强制。

| 错误码 | 触发条件 | 处理 |
|---|---|---|
| `patch-unresolved-name` | insert 行名像文件（`ui/panel.js`）却缺 `./` 前缀，挂载时会被当包名解析 | 不进索引 |
| `patch-missing-target` | insert 行用 `./x` 指向 patch 旁的文件，但归档里没有该文件 | 不进索引 |
| `patch-name-mismatch` | `cordis.patch.yml` 的 insert 行名不是 `package.json` 的 `name` | 不进索引 |
| `missing-file` | 缺 `cordis.patch.yml`、`package.json` 或 `README.md`；三者必须在仓库根目录，`hint` 指出同名文件的实际位置 | 不进索引 |
| `scope-not-allowed` | 包名不在受信范围（默认 `@heluo`） | 不进索引 |
| `bad-version` \| `bad-tag` \| `tag-mismatch` | 版本非 `x.y.z`、标签非 `vX.Y.Z`、两者不一致 | 不进索引 |
| `missing-engines` \| `bad-engines` | 未声明，或写法不在 `>=`、`^`、`~`、`=`、裸版本之内 | 不进索引 |
| `install-script` | 声明了 `preinstall`、`install` 或 `postinstall` | 不进索引 |
| `missing-section` | README 缺 `## 用途` 或 `## 维护人` | 不进索引 |
| `missing-name` | `package.json` 缺 `name` | 不进索引 |
| `patch-not-array` | `cordis.patch.yml` 顶层不是数组（映射写法能过 YAML 解析，但挂载报「must be a top-level YAML array」） | 不进索引 |
| `patch-js-expr` | `cordis.patch.yml` 含 `!!js` 表达式 | 不进索引 |
| `patch-disables-row` | 补丁里出现 `disabled: true` | 不进索引 |
| `patch-overrides-protected` | 覆盖 IAM、策略、凭据、沙箱或权限预设的行 id | 不进索引 |
| `patch-include` | 使用 `cordis:include` 加载包外文件 | 不进索引 |
| `patch-unsafe-path` | 引用包外相对路径或绝对路径 | 不进索引 |

`engines.dsh` 只接受 `>=0.2.1`、`^0.2.1`、`~0.2.1`、`=0.2.1` 与裸 `0.2.1` 五种写法；`*`、`latest` 与复合区间（如 `>=0.2.0 <0.3.0`）判 `bad-engines`。`^` 与 `~` 对 `0.x` 按次版本收敛；超出范围失败为 `outside-range`，低于下限为 `requires-newer-dsh`——对用户含义不同。

`cordis.patch.yml` 会被 loader 执行，按代码对待而非配置：格式校验通过后仍要过内容规则，两者同属索引前置条件。

判定逻辑由 `packages/forge-market/src/validate.mjs` 承担；规则变更需同步该文件、本表与 `test/error-codes.test.mjs`。

### A.6 计数与持久化局限

`downloads` 是“发放归档地址次数”，**不是安装成功数**；只有启动时给了 `--counts` 才写文件，去重集合在内存，重启后同机器同日可重复计数。`stars` 来自目录文件，不写入、不同步，上架时写 0。

旧草案的访问 90 天、审计 180 天、任务 30 天仅为未批准目标，不作为保留承诺。若建设结果上报，须另定幂等、脱敏、权限与留存契约。

### A.7 参考测试

`node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs` 覆盖旧列表/详情、鉴权、提交/评审/撤回、计数恢复与本地归档安装；不覆盖 npm、生成器、双端或授权。

## 附录 B 原生解析行为（2026-10-21 只读核验）

- 顶层 `format` 必须为 `1`；`title` 必填且语言对象必须含 `en`。
- 插件 `name` 走 npm 包名规则（允许 `~`，长度 ≤214）。
- `versions` 非空；解析后按 SemVer 降序；安装目标为 `name@version`，并带 `source.registry`（若有）。
- `icon` 接受 HTTPS、同源相对路径或 ≤32 KiB 的 png/jpeg/webp/svg base64；不接受公网 HTTP。
- 未定义成员被**丢弃**而不是报错；企业策略字段写进索引会被静默忽略。
- 原生只把索引当目录；安装由 `pluginManager` 与 pnpm 执行，索引不参与写前授权。
