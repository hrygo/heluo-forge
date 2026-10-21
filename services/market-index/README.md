# 插件索引校验（轻量模式）

状态：规划（只读校验器已实现，供开发/验收使用；不构成服务上线）。核对日期：2026-10-21。

本目录只保留 **format-1 索引的只读校验工具**，不再包含市场服务、索引生成器、发布控制或 `current/policy/evidence`。

## 目标链路

```text
AI 开发者平台（AIHUB）
  维护并托管 format-1 索引 JSON（只读 URL）
        │
        ▼
DSH 原生「插件市场 → 索引源」
        │ 选择精确 name@version
        ▼
官方 pluginManager + pnpm
        │
        ▼
企业 Artifactory（包体、ACL、同版不可变）
```

- 本项目不生成索引、不托管包体、不代理下载、不参与安装。
- 索引契约见 [DESIGN-012](<../../docs/design/services/market-index.md>)。
- AIHUB 交付项与验收见 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。

## 校验器

```sh
node services/market-index/validate-index.mjs https://aihub.example/plugin-index.json
node services/market-index/validate-index.mjs ./index.json --base https://aihub.example/plugin-index.json
```

- 只读：`GET` 不跟随重定向，超时 15 秒，上限 2 MiB。
- 本地文件含相对 `icon` 时必须给 `--base`，否则按文件 URL 解析会因非 HTTPS 被拒。
- 退出码：`0` 合法，`1` 不合法，`2` 参数错误。

校验内容：`format: 1`、`title.en`、包名、精确稳定版本、时间戳、npm source、registry、engines、icon、metadata 引用、版本去重与降序。未知成员按原生行为忽略。

## 允许的例外

- registry 可为内网 HTTP（已批准例外）；索引 URL 优先 HTTPS，若用 HTTP 需 P0 M8 结论；icon/homepage/repository 仍要求 HTTPS。轻量模式没有控制/证据端点。
- 索引不得包含 token；终端通过 `.npmrc` 或受管配置获得 Artifactory 读权限。
- 首版只放稳定版、自包含包；三目标兼容由 AIHUB/平台在发布前验证。

## 历史

旧的生成器、发布器、更版状态机与 HTTP 参考服务已移除；需要追溯时见 Git 历史与 [DESIGN-007 附录 A](<../../docs/design/plugins/forge-market.md>)。它们不属于当前目标，也不参与 `pnpm check`。
