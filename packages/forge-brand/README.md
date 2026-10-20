# @heluo/forge-brand

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle |
| 职责 | 产品名、Logo 与主题 token 的覆盖 |
| 名称基线 | 中文“河洛企业级智能研发平台”，英文“Heluo Forge”，工程标识 `heluo-forge` |
| 不负责 | 不隐含白标客户端发行授权，不修改核心界面结构 |
| 衔接点 | `brand`、`client-ui-theme` |
| 详细设计 | [详细设计](../../docs/design/plugins/forge-brand.md)（草案，已建立；状态见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 只覆盖受支持的品牌与主题 token，不注入脚本或远程资源。
- 品牌配置不等于可对外发行独立客户端；白标需范围变更并单独立项。
- 图标与字体须有可用授权，仓库内不放入来源不明的素材。
