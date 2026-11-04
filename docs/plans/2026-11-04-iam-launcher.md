# IAM 侧边栏页脚企业账号启动器实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-013 |
| 文档名称 | IAM 侧边栏页脚企业账号启动器实施计划 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-04 |
| 门禁 | 待负责人评审；覆盖 settings.launcher 挂载与盘龙盾徽头像 |

> 编制依据：2026-11-04 对 DSH Client 插槽契约（`settings.launcher`）实测与 `@heluo/forge-iam` 现有 `client.js` 代码的只读核对，结合用户关于“默认头像采用 forge-iam banner / 盘龙盾徽”的明确设计决定。
>
> 关联文档：[IAM 接入设计](<../design/plugins/forge-iam.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)、[需求基线](<../requirements/requirements-baseline.md>)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@heluo/forge-iam` 客户端中认领并实现 DSH 侧边栏左下角 `settings.launcher` 单占位插槽，以专属盘龙盾徽作为常驻头像，提供员工身份/网关凭据复合就绪状态指示、未登录一键唤起、气泡安全菜单与 D1 契约设备级退出。

**Architecture:** 客户端完全依托 DSH Cordis 插槽体系中的 `settings.launcher` 单占位机制，响应 `wide` 状态实现展开态（Wide）与收起态（56px Rail 导轨模式）的双态流体渲染；深度复用现有 2 秒轮询机制（`fetchView` / `useSessionPoll`）驱动复合状态机；气泡菜单封装脱敏诊断导出（navigator.clipboard）与设备安全退出（调用 `/api/forge-iam/sign-out`）。

**Tech Stack:** React (React.createElement 纯 JS，无 JSX 编译负担)、DSH 主题设计变量（`--dsw-*`）、SVG 矢量图形、Node.js 内置测试套件 (`node:test`, `node:assert/strict`)。

**Spec:** [`docs/design/plugins/forge-iam.md#441-左下角企业账号启动器settingslauncher规格`](<../design/plugins/forge-iam.md#441-左下角企业账号启动器settingslauncher规格>)

---

## Global Constraints

- **内核零入侵**：严禁修改 DSH 内核或官方包源码；完全依托 Client 插件的 `ctx.slots.inject('settings.launcher', ...)` 机制挂载。
- **视觉真源一致**：头像图形直接复用 `packages/forge-iam/icon.svg` 声明的盘龙护盾（Cyber-Long 品牌精炼盾徽），保持渐变色阶与曲率逐字节一致，不另行手绘变形。
- **敏感信息白名单导出**：脱敏诊断信息严格限定于布尔标记、状态枚举、到期秒数与设备标签，严禁导出任何 Token、Secret、Verifier 或 Key 明文。
- **D1 契约退出安全**：退出操作仅撤销本机访问令牌（调用现有 `POST /api/forge-iam/sign-out`）并清理本地登录凭据，保留个人长期网关 Key；绝不默认发起全局 RP 登出导致全浏览器会话下线。
- **双态紧凑约束**：收起导轨态（56px Rail）严格居中约束在 36×36px 边界内，不得导致侧边栏横向溢出或纵向重排。

---

## Review Focus

1. **未登录态点击唤起**：未配置或未登录时，点击启动器是否能正确调用 `openLoginWindow()` 并发起 sign-in 请求，且弹窗被拦截时降级展示备用链接。
2. **56px Rail 导轨模式溢出**：在 `wide === false` 时，是否完全隐藏文字描述、昵称和快捷键，仅保留 36×36px 盾徽及状态点，悬停展现完整 Tooltip。
3. **复合就绪点状态漂移**：当 IAM 已登录（`ready`）但个人网关 Key 未配置（`unconfigured`）或账号不匹配（`owner-mismatch`）时，状态指示点必须准确呈现为 🟡 黄色，不可误显为 🟢 绿色。
4. **气泡菜单外部点击与 Esc 关闭**：弹出气泡菜单后，点击组件外部视口或按下 Escape 键时是否能正常收回，焦点是否正确回退。
5. **脱敏诊断剪贴板安全性**：执行“复制脱敏诊断”时，导出的 JSON 结构中是否被彻底过滤，绝对不含 `token`、`secret`、`authorizationUrl`、`key` 原文字段。

---

## Task Decomposition

### Task 1: 契约测试先行 —— Launcher 结构、插槽挂载与状态映射断言

**Files:**
- Create: `packages/forge-iam/test/client-launcher.test.mjs`
- Modify: `packages/forge-iam/test/client-shape.test.mjs:30-45`

**Interfaces:**
- Consumes: `packages/forge-iam/client.js`
- Produces: `client-launcher.test.mjs` 测试套件，覆盖四个核心状态（未登录、已登录+缺Key、已登录+双就绪、已过期）及 `wide` 切换参数。

- [ ] **Step 1: 在 `packages/forge-iam/test/client-launcher.test.mjs` 中编写失败测试**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('client declares settings.launcher injection and registration', () => {
  assert.match(clientSource, /ctx\.slots\.inject\(['"]settings\.launcher['"]/);
  assert.match(clientSource, /name:\s*['"]settings\.launcher['"]/);
  assert.match(clientSource, /id:\s*['"]forge-iam-launcher['"]/);
});

test('client contains IamLauncher component and shield icon renderer', () => {
  assert.match(clientSource, /function IamLauncher\(/);
  assert.match(clientSource, /fiam-launcher/);
  assert.match(clientSource, /fiam-shield-icon/);
});

test('launcher renders composite status indicator for gateway and session', () => {
  assert.match(clientSource, /statusDotClass/);
  assert.match(clientSource, /fiam-launcher-menu/);
});
```

- [ ] **Step 2: 在 `packages/forge-iam/test/client-shape.test.mjs` 中补充断言**

增加对 `settings.launcher` 的注册断言：
```javascript
assert.match(client, /settings\.launcher/);
assert.match(client, /forge-iam-launcher/);
```

- [ ] **Step 3: 运行测试以确认失败**

运行：`node --test packages/forge-iam/test/client-launcher.test.mjs`
预期结果：FAIL（由于当前尚未在 `client.js` 中声明 `settings.launcher` 与 `IamLauncher`）。

- [ ] **Step 4: 提交测试桩代码**

```bash
git add packages/forge-iam/test/client-launcher.test.mjs
```

---

### Task 2: 品牌盾徽头像与复合状态指示点实现

**Files:**
- Modify: `packages/forge-iam/client.js` (在 UI 组件区增加 `IamShieldIcon` 与样式)

**Interfaces:**
- Consumes: `packages/forge-iam/icon.svg` 视觉定义
- Produces: `IamShieldIcon({ size, grayscale })` 渲染函数、状态圆点计算函数 `getLauncherStatus(view)`

- [ ] **Step 1: 编写 `IamShieldIcon` 渲染函数**

在 `packages/forge-iam/client.js` 中新增内联 SVG 组件 `IamShieldIcon({ size, grayscale })`：
- 复用 `icon.svg` 的 viewBox `0 0 320 320` 与线性渐变 `iamGradient`。
- 支持 `grayscale: boolean` 参数；当未登录时，将 SVG 设为 `filter: grayscale(1); opacity: 0.55`。
- 定义容器样式：Wide 模式下外层正圆直径 28px，内层盾徽 18px；Rail 模式下外层 36×36px，内层 22px。

- [ ] **Step 2: 编写状态计算与指示点逻辑**

```javascript
function getLauncherStatus(view) {
  if (!view || view.state === 'signed-out' || view.state === 'unconfigured') {
    return { kind: 'signed-out', dotClass: 'idle', label: '企业账号未登录', tooltip: '点击登录企业账号' };
  }
  if (view.state === 'authenticating') {
    return { kind: 'authenticating', dotClass: 'authenticating', label: '等待登录完成', tooltip: '正在等待浏览器授权' };
  }
  if (view.state === 'expired' || view.state === 'error') {
    return { kind: 'error', dotClass: 'error', label: '授权已失效', tooltip: '登录已失效，请重新登录' };
  }
  if (view.state === 'ready') {
    const gw = view.gatewayCredential?.state ?? 'unconfigured';
    if (gw === 'configured') {
      return { kind: 'ready', dotClass: 'success', label: '企业网关就绪', tooltip: `${view.subject || '企业账号'} · 双模式凭据就绪` };
    }
    return { kind: 'missing-key', dotClass: 'warn', label: '待配置网关凭据', tooltip: `${view.subject || '企业账号'} · 未录入个人网关凭据` };
  }
  return { kind: 'unknown', dotClass: 'idle', label: '状态未知', tooltip: '企业账号' };
}
```

- [ ] **Step 3: 增加配套 CSS 规则**

向 `interactionStyles` 字符串追加：
- `.fiam-launcher-root`: 弹性横排布局、高度 36px、圆角 `var(--dsw-radius-sm)`、悬停浅灰背景。
- `.fiam-launcher-rail`: 56px 导轨模式下尺寸固定 36×36px、居中排版。
- `.fiam-launcher-dot`: 7px 实心绝对定位状态小圆点（白边阴影隔开）。
- `.fiam-launcher-details`: 文本溢出隐藏、字号 13px、状态说明 11px 次级颜色。

- [ ] **Step 4: 运行单测验证**

运行：`node --test packages/forge-iam/test/client-launcher.test.mjs`

---

### Task 3: 启动器组件 `IamLauncher` 与气泡菜单实现

**Files:**
- Modify: `packages/forge-iam/client.js`

**Interfaces:**
- Consumes: 宿主注入的 `SettingsLauncherOwnerProps` (`wide`, `settingsOpen`, `settingsShortcut`, `openSettings`, `openOnboarding`)
- Produces: `IamLauncher` 组件及内部 `IamLauncherMenu` 浮层

- [ ] **Step 1: 编写 `IamLauncherMenu` 气泡菜单**

气泡菜单包含以下块：
1. **身份信息区**：
   - 员工主体（`view.subject`）与发行者（`view.issuer`）；
   - Access Token 有效期倒计时（从 `view.accessExpiresAt` 计算分钟）。
2. **网关状态区**：
   - 个人凭据状态（配置状态、设备标签 `deviceLabel`、存储介质）；
3. **操作按钮列表**：
   - **“录入/更换网关凭据”**：触发 `openSettings()` 并可定位至 `forge-iam` 分区；
   - **“复制脱敏诊断”**：提取当前白名单字段 JSON 写入 `navigator.clipboard`，并在按钮旁呈现 2 秒“已复制”反馈；
   - **“安全退出当前设备”**：二次确认提示，确认后调用 `POST /api/forge-iam/sign-out`，注销当前设备访问令牌。
4. **点击外部/Esc 关闭机制**：
   - 在 `document` 挂载 `mousedown` 与 `keydown` (Escape) 监听，自动关闭菜单。

- [ ] **Step 2: 组装 `IamLauncher` 主体交互**

```javascript
function IamLauncher(props) {
  const { wide, settingsOpen, settingsShortcut, openSettings } = props;
  const [view, setView] = React.useState(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [signingIn, setSigningIn] = React.useState(false);

  // 沿用已验证的 useSessionPoll 订阅当前视图
  useSessionPoll(true, (nextView) => setView(nextView));

  // 1. 未登录处理：点击直接发起登录
  // 2. 已登录处理：点击切换 menuOpen 状态
  // 3. 右侧设置齿轮：点击调用 openSettings()
}
```

- [ ] **Step 3: 增加键盘无障碍属性**

为启动器与菜单补齐无障碍支持：
- `role="button"` / `aria-haspopup="menu"` / `aria-expanded={menuOpen}`；
- 展开态右侧设置齿轮绑定 `aria-label="设置"` 与 `aria-keyshortcuts={settingsShortcut?.aria}`。

---

### Task 4: 注册挂载与端到端形态验证

**Files:**
- Modify: `packages/forge-iam/client.js:1770-1788`
- Modify: `packages/forge-iam/test/client-shape.test.mjs`

**Interfaces:**
- Consumes: `ctx.slots.inject('settings.launcher', ...)`
- Produces: 运行时完整的左下角企业入口。

- [ ] **Step 1: 在 `packages/forge-iam/client.js` 的 `apply(ctx)` 中注册**

```javascript
ctx.slots.inject('settings.launcher', () => ctx.slots.register({
  name: 'settings.launcher',
  id: 'forge-iam-launcher',
}, IamLauncher));
```

- [ ] **Step 2: 运行定向测试套件**

运行：`node --test packages/forge-iam/test/client-launcher.test.mjs`
预期结果：PASS。
运行：`node --test packages/forge-iam/test/client-shape.test.mjs`
预期结果：PASS。

- [ ] **Step 3: 运行包内全体测试**

运行：`node --test packages/forge-iam/test/client-*.test.mjs`
预期结果：全部通过，无衰退。

---

### Task 5: 全库格式、文档与敏感扫描校验

**Files:**
- Modify: `docs/DOCUMENT-REGISTER.md` (登记本计划)

**Interfaces:**
- Consumes: `scripts/check-docs.mjs`, `git diff --check`
- Produces: 绿色的全库工程自检。

- [ ] **Step 1: 登记计划至 `docs/DOCUMENT-REGISTER.md`**

在 `docs/DOCUMENT-REGISTER.md` 新增条目：
```markdown
| CORP-DSH-PLAN-013 | IAM 侧边栏页脚（左下角）企业账号启动器实施计划 | [plans/2026-11-04-iam-launcher.md](<plans/2026-11-04-iam-launcher.md>) | V0.1.0 | 草案 | 平台组（代拟） | 待负责人评审；覆盖 settings.launcher 挂载与盘龙盾徽头像 |
```

- [ ] **Step 2: 运行文档检查与仓库格式检查**

```bash
node scripts/check-docs.mjs
git diff --check
```
预期结果：通过无错误。

---

## Self-Review Checklist

1. **Spec coverage:** 是否覆盖了设计文档 §4.4.1 的全部要求？
   - 盘龙盾徽默认头像（Task 2）
   - 复合状态小圆点 4 态（Task 2）
   - Wide 与 56px Rail 导轨双态自适应（Task 2, Task 3）
   - 未登录一键浏览器拉起（Task 3）
   - 气泡菜单、脱敏诊断复制、D1 契约安全退出（Task 3）
   - `settings.launcher` 插槽注册与注入（Task 4）
2. **Step scan:** 每个 Step 是否具备确定性的执行与测试命令？是，完全按照“编写失败测试 → 验证失败 → 实现功能 → 验证通过”节奏推进。
3. **Type consistency:** 组件 props、Slot 名称（`settings.launcher` / `forge-iam-launcher`）、样式命名（`fiam-launcher-*`）保持全生命周期一致。
4. **Review Focus:** Review Focus 提出的 5 类核心边界（未登录点击、56px 导轨溢出、缺 Key 黄点状态、气泡外部 Esc 关闭、脱敏诊断安全性）均在 Task 1 与 Task 3 中作为测试用例予以钉死。
5. **Proportion:** 计划紧凑，聚焦于变更接口与测试，无冗余源码副本。
