# AI 网关契约

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-GW-001 |
| 文档名称 | AI 网关契约 |
| 版本 | V0.2 |
| 文档状态 | 草案 |
| 密级 | 内部 |
| 编制 | 网关团队（DSH 平台组代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-20 |
| 门禁 | G0 |

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V0.1 | 2026-10-20 | DSH 平台组 | 初稿 |
| V0.2 | 2026-10-20 | DSH 平台组 | 补充双维度额度与错误契约，正式化 |

## 1. 结论

网关承担两项职责：将 IAM token 验证为 consumer，并按“人 + consumer”双维度记账。DSH 不做本地计量，只负责携带 token、展示 429；两层额度同时生效时取更紧的一侧，错误体说明耗尽层级。

## 2. 范围与非目标

- 范围：JWT 验签、consumer 映射、额度判定、超额错误、模型目录。
- 非目标：prompt 计费策略、模型路由算法、上游供应商结算。

## 3. 现状与约束

- 网关基于 Kong 自研，已具备额度管理；具体为 Kong 插件还是外部配额服务尚未确认。
- 客户端只持有 IAM access token，不持有网关 API Key。
- 同一 token 可能同时受个人预算与团队/consumer 预算约束。

## 4. 契约

### 4.1 身份

| 项 | 要求 |
|---|---|
| 验签 | JWKS 优先；不支持时使用 introspection（RFC 7662）并缓存结果 |
| claims | `sub` 必填；`aud` 必须包含网关标识；`exp` 与 `iss` 必须验证；允许 60 秒时钟偏移 |
| consumer | 由 `sub` 或注册信息派生；一人多团队时按显式优先级归属，不在运行时推断 |
| 401 | 仅表示 token 无效或过期；错误体不包含内部细节 |

### 4.2 额度

| 维度 | 键 | 说明 |
|---|---|---|
| 人 | `sub` | 个人预算，保证公平性 |
| consumer | consumer id | 团队或工作负载预算，保证成本归属 |
| 模型 | `model` | 可按模型设置不同单价或上限 |
| 窗口 | 日 / 月 | 由网关配置，DSH 不假设 |

- 适用额度取所有匹配策略的最小值；任一层耗尽即拒绝。
- 两层同时耗尽时，`quota_scope` 报告更紧的一层，响应头同时返回两层剩余（字段名待定）。
- 计数单位支持 token、cost、request；具体按模型配置。
- 可选查询端点：`GET /v1/quota` 返回各维度剩余与重置时间，缓存不超过 30 秒。

### 4.3 超额错误

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 37
RateLimit-Limit: 1000
RateLimit-Remaining: 0
RateLimit-Reset: 37
Content-Type: application/problem+json

{
  "type": "https://ai-gateway.corp.example/problems/quota-exceeded",
  "title": "Quota exceeded",
  "status": 429,
  "detail": "Personal daily token quota exhausted",
  "instance": "/v1/chat/completions",
  "quota_scope": "person",
  "quota_limit": 1000000,
  "quota_remaining": 0,
  "quota_reset": "2026-10-21T00:00:00+08:00"
}
```

| 状态码 | 含义 | 客户端行为 |
|---|---|---|
| 401 | token 无效或过期 | 刷新一次；仍失败则重新登录 |
| 403 | 无权限或模型未授权 | 不重试，提示申请权限 |
| 429 | 额度耗尽 | 不自动重试，展示 `quota_reset` |
| 503 | 验签或配额依赖不可用 | 指数退避，提示稍后重试 |

### 4.4 模型目录

- 请求的 `model` 必须与网关配置名一致，别名由网关维护。
- 未授权模型返回 403，错误码 `model_not_allowed`，不返回可用模型列表。

## 5. 失败模式

| 场景 | 行为 | 客户端应对 |
|---|---|---|
| JWKS 拉取失败 | 使用缓存密钥；`kid` 未命中时返回 503，不返回 401 | 退避重试，不触发登出 |
| 配额存储不可用 | 建议 fail closed（503）；是否 fail open 待定 | 退避重试 |
| 计数延迟 | 超额可能延后一个请求生效 | 接受偶发超出，按窗口结算 |
| 时钟偏移 | 允许 60 秒；超过则返回 401 | 校时后重试 |

## 6. 验收

1. 有效 token 调用成功；过期 token 返回 401。
2. 个人额度耗尽返回 429，`quota_scope=person`，带 `Retry-After`。
3. consumer 额度耗尽返回 429，`quota_scope=consumer`。
4. 两层同时耗尽时报告更紧一层，且响应头可读取两层剩余。
5. 未授权模型返回 403，不泄露模型列表。
6. JWKS 轮换后新 `kid` 无需重启即可通过。
7. 额度查询端点返回剩余与重置时间（若提供）。

## 7. 待确认

| 问题 | 需要谁回答 | 截止 |
|---|---|---|
| JWKS 还是 introspection | 网关团队 | G0 |
| consumer 预置（IAM 同步）还是首次请求自动创建 | 网关 + IAM | G0 |
| 一人多团队时的归属优先级 | 网关 + IAM/HR | G0 |
| 两层同时耗尽的响应字段表达 | 网关团队 | G0 |
| 配额存储故障时 fail open 还是 fail closed | 网关 + 安全 | G0 |
| 是否提供额度查询端点 | 网关团队 | G1 |
