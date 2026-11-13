/**
 * @heluo/forge-devops — Web 配置页（settings.section「企业 DevOps」）。
 *
 * 定位：页面即状态，不是表单。装配期自动发现的结果经同源 `/api/forge-devops/cli`
 * 读到本页；用户常态下「只读不填」，只有未命中或被显式覆盖时才进编辑态。
 *
 * 数据通道（见 TECHNICAL §3.1 / §4）：
 *   GET  /api/forge-devops/cli            读装配期快照（CliSnapshot，含路径）
 *   GET  /api/forge-devops/cli?refresh=1  重新做一次有界发现（唯一会重扫的动作）
 *   POST /api/forge-devops/cli            保存，头 `x-forge-devops-request: 1`，
 *                                         体 `{ revision, fields }`，null = 清除该键
 *
 * 三条不许越过的线：
 *   1. 路径只出现在输入框的值与 title 上；不进 URL、不进 data-*、不拼进请求（AC-10）。
 *   2. 只把文本交给 React 渲染（不注入原始 HTML），不写调试输出（静态用例守）。
 *   3. 校验规则与环境变量层共用同一份语义（src/cli-config.mjs）；本页只做格式校验，
 *      存在性/可直接执行由服务端在保存时判定（422 逐字段返回）。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-devops',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * 契约常量（与 src/cli-config.mjs / src/http.mjs 逐字对齐）           *
     * ------------------------------------------------------------------ */

    /** i18n 命名空间（与 src/index.mjs 的 locale 注册同名）。 */
    const NS = 'devops';
    /** 同源配置端点（前缀 CLI_API_PREFIX 下的 `/cli`）。 */
    const CLI_ENDPOINT = '/api/forge-devops/cli';
    /** 企业账号统一托管的扩展凭据同源端点。 */
    const IAM_EXT_CREDENTIALS_ENDPOINT = '/api/forge-iam/ext-credentials';
    const IAM_EXT_CREDENTIAL_ENDPOINT = `${IAM_EXT_CREDENTIALS_ENDPOINT}/devops`;
    const IAM_MUTATION_HEADERS = { 'x-forge-iam-request': '1', 'content-type': 'application/json', accept: 'application/json' };
    const IAM_READ_HEADERS = { accept: 'application/json' };
    /** 写操作的 CSRF 风格预检头，缺头服务端回 400。 */
    const REQUEST_HEADERS = { 'x-forge-devops-request': '1', 'content-type': 'application/json' };
    /** 读也带预检头：契约只对 POST 要求，带上对 GET 无害且免掉两次形态假设。 */
    const READ_HEADERS = { accept: 'application/json', 'x-forge-devops-request': '1' };
    /** 样式标签去重键（重复挂载不产生第二个 style）。 */
    const CSS_TAG_ID = '@heluo/forge-devops/client.css';

    /** 四个配置键（与服务端 CLI_FIELDS 同名同序；页面只用到其中两个，契约仍是四个）。 */
    const CLI_FIELDS = ['dopBin', 'dopEndpoint', 'sourceType', 'timeoutMs'];
    /** 需要「发现」的可执行文件字段：只读展示 + 候选展开 + 手动指定。 */
    const ENTRY_FIELDS = ['dopBin'];
    /**
     * 页面可编辑面（两键）：渲染、页面校验、dirty、POST body 与 422 聚焦都只走这张表。
     * 隐藏两键（dopEndpoint / sourceType）**不进 DOM、不进 staged、不发送**——
     * 「保存时逐字保留」由服务端 `buildCliPatch` 的补丁合并兜底：页面不持有自己无法校验的状态，
     * 服务端也不必因为页面收敛而收窄校验。
     */
    const PAGE_FIELDS = ['dopBin', 'timeoutMs'];
    /** 入口字段 → 工具名：**只用于 i18n 插值 `{tool}`**，不参与解析 / 校验 / 请求（与服务端 TOOL_BY_FIELD 不互用）。 */
    const TOOL_OF_FIELD = Object.freeze({ dopBin: 'dop' });
    /**
     * 与服务端同源的字段规则（服务端另有存在性/可执行判定，且对四个键一律不放松）。
     * 逐字段的取值边界都要与 `src/runtime-config.mjs` 的规则等值：浏览器半不能 import 服务端模块，
     * 等值关系由 `test/client-rule-parity.test.mjs` 的跨面矩阵用例守着（改任何一侧先红在那里）。
     * 隐藏两键没有页面规则——"页面收窄、服务端不放宽"正由该矩阵断言。
     *
     * 入口字段只剩这条长度上界（与服务端 `MAX_PATH_LENGTH` 等值，挡住误粘整段日志）。
     * r8 起页面**不再**判后缀：`.cmd`/`.bat`/`.ps1`/无后缀 shim 都允许暂存与提交，
     * 形态与可执行性的唯一真源是服务端的 `src/entry-form.mjs`；浏览器半复制第二份，
     * 只会让「能保存」和「能起起来」两套口径再次分叉（失败时由服务端 422 / 运行期提示说明）。
     */
    const MAX_PATH_LENGTH = 4096;
    const TIMEOUT_MIN = 1000;
    const TIMEOUT_MAX = 600000;

    /* ------------------------------------------------------------------ *
     * r15「企业研发」汇总面（AC-2 / AC-3 / AC-10）                        *
     * ------------------------------------------------------------------ */

    /** 汇总面读的三个同源端点：一个失败只影响自己那一行（AC-2 的四组反例）。 */
    const READINESS_ENDPOINTS = Object.freeze({
      iam: '/api/forge-iam/view',
      devops: CLI_ENDPOINT,
      gitee: '/api/forge-gitee/config',
    });
    /**
     * 状态词表（r16 契约的唯一一份）：身份七态（含"退出未确认"）、配置三态、Key 三态、
     * 检查六态都从这里取词，页面任何位置都不许再写字面量"已登录/未配置/通过"。词表键 = `readiness.state.*`。
     */
    const READINESS_STATES = Object.freeze({
      signedIn: 'signedIn',
      signedOut: 'signedOut',
      signedOutUnknown: 'signedOutUnknown',
      authenticating: 'authenticating',
      expired: 'expired',
      unreachable: 'unreachable',
      unknown: 'unknown',
      missing: 'missing',
      unconfigured: 'unconfigured',
      configured: 'configured',
      keyUnverified: 'keyUnverified',
      keyVerified: 'keyVerified',
      unchecked: 'unchecked',
      checking: 'checking',
      pass: 'pass',
      fail: 'fail',
      stale: 'stale',
    });
    /**
     * 身份端点 `state` → 状态词。**未列出的一律"退出未确认"**：既不是"已登录"，也不许画成
     * "未登录"——把"不知道"画成"没登录"会诱导用户重复登录，正是 AC-3 的反面目标。
     * 端点整体不可用时才回落到 `sourceState`（404 = 未安装 / 0 = 不可达）。
     */
    const IAM_STATE_OF = Object.freeze({
      ready: READINESS_STATES.signedIn,
      'signed-out': READINESS_STATES.signedOut,
      unconfigured: READINESS_STATES.signedOut,
      authenticating: READINESS_STATES.authenticating,
      expired: READINESS_STATES.expired,
      unreachable: READINESS_STATES.unreachable,
      error: READINESS_STATES.signedOutUnknown,
    });
    /** 身份导航：分区 id 与宿主可能提供的两个切换方法（只做能力探测，不猜路由）。 */
    const SECTION_FORGE_IAM = 'forge-iam';
    const NAV_METHODS = Object.freeze(['openSection', 'selectSection']);
    /** 四层证据与三态/依据：与服务端 `src/readiness.mjs` 逐字一致（`tests/ui-contract` 守）。 */
    const EVIDENCE_LAYERS = Object.freeze(['file', 'executable', 'target', 'readonly']);
    const EVIDENCE_STATES = Object.freeze({ pass: 'pass', fail: 'fail', notRun: 'not-run' });
    const EVIDENCE_BASIS_OF = Object.freeze({
      'filesystem-stat': 'filesystemStat',
      'config-shape': 'configShape',
      'policy-admission': 'policyAdmission',
    });
    const EVIDENCE_REASONS = Object.freeze([
      'no-dop-bin',
      'path-resolution-required',
      'file-not-found',
      'is-directory',
      'not-executable',
      'source-type-unknown',
      'policy-unavailable',
      'policy-denied',
      'confirmation-required',
      'no-evidence',
    ]);
    const READINESS_SOURCE_TYPES = Object.freeze(['local-diagnostic', 'fixture', 'enterprise-evidence', 'unknown']);
    /** 检查子原因（AC-10）：只认这四个码，其它一律"未知"。 */
    const CHECK_REASON_OF = Object.freeze({
      NO_CLI: 'noCli',
      ENTRY_NOT_EXECUTABLE: 'notExecutable',
      ENDPOINT_UNREACHABLE: 'unreachable',
      POLICY_DENIED: 'policyDenied',
    });
    /**
     * 汇总面固定两条行（DESIGN §3）：每行是若干成员的聚合，成员只在详情里出现。
     * 行的顺序、标签与 `data-group` 一起构成对外契约，渲染与断言共用这张表。
     */
    const READINESS_GROUPS = Object.freeze(['identity', 'tools']);
    const READINESS_GROUP_MEMBERS = Object.freeze({
      identity: Object.freeze(['identity', 'key']),
      tools: Object.freeze(['device', 'devops', 'gitee']),
    });

    /* ------------------------------------------------------------------ *
     * 度量常量（DESIGN §5.2 与 §0.6；组件内部不再出现裸数字）             *
     * ------------------------------------------------------------------ */

    const METRICS = {
      titleSize: 16,
      titleLine: 24,
      introSize: 12,
      introLine: 18,
      introGap: 12,
      statusHeight: 30,
      statusGap: 8,
      statusPadX: 12,
      dotSize: 6,
      groupLine: 20,
      groupGapTop: 10,
      groupGapBottom: 6,
      labelSize: 13,
      labelWeight: 500,
      labelLine: 20,
      layerLabelWidth: 88,
      headGap: 6,
      inputHeight: 34,
      inputGap: 6,
      hintSize: 12,
      hintLine: 18,
      fieldPadY: 12,
      scalarInputWidth: 220,
      footerGapTop: 16,
      buttonHeight: 32,
      separator: 0.5,
      tagHeight: 18,
      tagSize: 11,
      codeSize: 12,
      candidatePadY: 6,
      skeletonRow: 108,
      ease: 'var(--ds-ease-in-out)',
      fast: 100,
      swap: 160,
      breathe: 1200,
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
    };

    const CSS = `
.fdv-root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-family:inherit;container-type:inline-size}
.fdv-title{margin:0;font-size:${METRICS.titleSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.titleLine}px}
.fdv-intro{margin:${METRICS.introGap}px 0 0;font-size:${METRICS.introSize}px;line-height:${METRICS.introLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-status{box-sizing:border-box;display:flex;align-items:center;gap:${METRICS.statusGap}px;height:${METRICS.statusHeight}px;margin-top:${METRICS.statusGap}px;padding:0 ${METRICS.statusPadX}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fdv-dot{flex:none;width:${METRICS.dotSize}px;height:${METRICS.dotSize}px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);transition:background-color ${METRICS.swap}ms ${METRICS.ease}}
.fdv-status-ready .fdv-dot{background:var(--dsw-static-green-500)}
.fdv-status-missing .fdv-dot{background:var(--dsw-static-amber-500)}
.fdv-status-unavailable .fdv-dot{background:var(--dsw-static-red-600)}
.fdv-status-text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.fdv-status-missing .fdv-status-text{color:var(--dsw-alias-state-warn-primary)}
.fdv-status-unavailable .fdv-status-text{color:var(--dsw-alias-state-error-primary)}
.fdv-status-actions{flex:none;display:flex;align-items:center;gap:${METRICS.statusGap}px}
.fdv-group{margin:${METRICS.groupGapTop}px 0 ${METRICS.groupGapBottom}px;font-size:${METRICS.hintSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.groupLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-cards{display:flex;flex-direction:column}
.fdv-card{padding:${METRICS.fieldPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-card-first{border-top:0 none}
.fdv-head{display:flex;align-items:center;flex-wrap:wrap;row-gap:4px;gap:${METRICS.statusGap}px;min-width:0;line-height:${METRICS.labelLine}px}
.fdv-label{font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px;color:var(--dsw-alias-label-primary)}
.fdv-head-actions{margin-left:auto;display:flex;align-items:center;gap:${METRICS.statusGap}px;flex:none}
.fdv-input{box-sizing:border-box;display:block;width:100%;height:${METRICS.inputHeight}px;margin-top:${METRICS.headGap}px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:${METRICS.radiusSm};background:transparent;color:inherit;font-family:inherit;font-size:${METRICS.labelSize}px;line-height:${METRICS.labelLine}px;transition:border-color ${METRICS.fast}ms ${METRICS.ease}}
.fdv-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.fdv-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.fdv-input:read-only{cursor:text;color:var(--dsw-alias-label-secondary)}
.fdv-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.fdv-input:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.fdv-foot{display:flex;align-items:center;gap:${METRICS.statusGap}px;margin-top:${METRICS.inputGap}px;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-tertiary)}
.fdv-hint{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fdv-foot-error .fdv-hint{color:var(--dsw-alias-state-error-primary)}
.fdv-foot-actions{margin-left:auto;display:flex;align-items:center;gap:${METRICS.statusGap}px;flex:none}
.fdv-link{appearance:none;margin:0;padding:0;border:0;background:none;cursor:pointer;font-family:inherit;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);transition:color ${METRICS.fast}ms ${METRICS.ease}}
.fdv-link:hover{color:var(--dsw-alias-label-primary)}
.fdv-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:2px}
.fdv-link:disabled{cursor:default;opacity:.4}
.fdv-hint-toggle{display:inline-flex;align-items:center;gap:4px;max-width:100%;overflow:hidden}
.fdv-caret{display:inline-block;transition:transform ${METRICS.fast}ms ${METRICS.ease};font-size:10px;line-height:1}
.fdv-caret-open{transform:rotate(180deg)}
.fdv-candidates{display:flex;flex-direction:column;margin-top:${METRICS.inputGap}px;animation:fdv-reveal ${METRICS.swap}ms ${METRICS.ease} both}
.fdv-candidate{display:flex;align-items:center;gap:${METRICS.statusGap}px;padding:${METRICS.candidatePadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2);font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fdv-candidate:first-child{border-top:0 none}
.fdv-candidate-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:${METRICS.codeSize}px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.fdv-candidate-tier{flex:none;color:var(--dsw-alias-label-tertiary)}
.fdv-tag{display:inline-flex;align-items:center;flex:none;height:${METRICS.tagHeight}px;padding:0 6px;border-radius:${METRICS.radiusSm};background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:${METRICS.tagSize}px;font-weight:400;line-height:${METRICS.tagHeight}px;white-space:nowrap}
.fdv-tag-accent{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.fdv-tag-quiet{color:var(--dsw-alias-label-tertiary)}
.fdv-tag-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.fdv-tag-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.fdv-scalar{box-sizing:border-box;padding:${METRICS.fieldPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-scalar-input{width:${METRICS.scalarInputWidth}px;max-width:100%;font-variant-numeric:tabular-nums}
.fdv-footer{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px;padding-top:${METRICS.footerGapTop}px}
.fdv-note{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-note-error{color:var(--dsw-alias-state-error-primary)}
.fdv-note-action{margin-left:${METRICS.statusGap}px}
.fdv-primary{flex:none;box-sizing:border-box;height:${METRICS.buttonHeight}px;padding:0 16px;border:0 none;border-radius:${METRICS.radiusSm};background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;font-family:inherit;font-size:${METRICS.hintSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.hintLine}px;transition:opacity ${METRICS.fast}ms ${METRICS.ease},transform ${METRICS.fast}ms ${METRICS.ease}}
.fdv-primary:hover{opacity:.92}
.fdv-primary:active{opacity:.86;transform:scale(.98)}
.fdv-primary:disabled{cursor:default;opacity:.4;transform:none}
.fdv-primary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.fdv-unavailable{padding:${METRICS.fieldPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-unavailable-title{font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px}
.fdv-unavailable-body{margin:${METRICS.headGap}px 0 0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-unavailable-env{display:block;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:${METRICS.codeSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.fdv-row{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px;padding:${METRICS.candidatePadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-row-main{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px;flex:1;min-width:0}
.fdv-row-actions{flex:none;display:flex;align-items:center;gap:${METRICS.statusGap}px}
.fdv-summary-row{display:flex;align-items:center;gap:${METRICS.statusGap}px;margin:${METRICS.statusGap}px 0 0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-summary-text{flex:1;min-width:0;overflow-wrap:anywhere}
.fdv-row-label{flex:none;width:112px;font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px}
.fdv-row-state{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.headGap}px;flex:1;min-width:0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary)}
.fdv-row-detail{min-width:0;overflow-wrap:anywhere}
.fdv-next{min-width:0;overflow-wrap:anywhere}
.fdv-details{flex-basis:100%;margin:0 0 0 112px;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fdv-detail-line{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.headGap}px;min-width:0}
.fdv-detail-label{flex:none;width:${METRICS.layerLabelWidth}px;color:var(--dsw-alias-label-secondary)}
.fdv-detail-text{min-width:0;overflow-wrap:anywhere}
.fdv-details-body .fdv-details{margin:0}
.fdv-details-body .fdv-check{margin:${METRICS.headGap}px 0 0;padding-top:0;border-top:0}
.fdv-summary{cursor:pointer;color:var(--dsw-alias-label-secondary);list-style:none}
.fdv-summary::-webkit-details-marker{display:none}
.fdv-summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:${METRICS.radiusSm}}
.fdv-details-body{display:flex;flex-direction:column;gap:2px;margin-top:${METRICS.headGap}px;padding-left:${METRICS.statusPadX}px;border-left:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-layer-line{display:flex;gap:${METRICS.statusGap}px}
.fdv-layer-label{flex:none;width:${METRICS.layerLabelWidth}px;color:var(--dsw-alias-label-secondary)}
.fdv-layer-value{min-width:0;overflow-wrap:anywhere}
.fdv-check{flex-basis:100%;margin:${METRICS.headGap}px 0 0 112px;padding:${METRICS.fieldPadY}px 0 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:${METRICS.headGap}px ${METRICS.statusPadX}px}
.fdv-check-item{display:flex;gap:${METRICS.headGap}px;min-width:0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fdv-check-label{flex:none;color:var(--dsw-alias-label-secondary)}
.fdv-check-value{min-width:0;overflow-wrap:anywhere}
.fdv-evidence{display:flex;flex-direction:column;gap:2px;margin:${METRICS.headGap}px 0 0;padding:0;list-style:none;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fdv-evidence-row{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.headGap}px}
.fdv-evidence-layer{flex:none;width:${METRICS.layerLabelWidth}px;color:var(--dsw-alias-label-secondary)}
.fdv-evidence-reason{min-width:0;overflow-wrap:anywhere}
.fdv-evidence-basis{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fdv-check-footer{display:flex;align-items:center;gap:${METRICS.statusGap}px;margin-top:${METRICS.headGap}px}
.fdv-receipt{display:flex;align-items:center;gap:${METRICS.statusGap}px;padding-top:${METRICS.groupGapTop}px;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fdv-receipt{flex:1 1 100%}
.fdv-receipt-actions{flex:none;display:flex;align-items:center;gap:${METRICS.statusGap}px;margin-left:auto}
.fdv-receipt-hint{flex:0 0 100%;margin:2px 0 0;font-size:${METRICS.tagSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));overflow-wrap:anywhere}
.fdv-disclaimer{margin:${METRICS.footerGapTop}px 0 0;font-size:${METRICS.tagSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fdv-skeleton{display:flex;flex-direction:column;margin-top:${METRICS.groupGapTop}px}
.fdv-skeleton-group{height:${METRICS.groupLine}px;margin:0 0 ${METRICS.groupGapBottom}px;border-radius:${METRICS.radiusSm};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe ${METRICS.breathe}ms ease-in-out infinite}
.fdv-skeleton-row{height:${METRICS.skeletonRow}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe ${METRICS.breathe}ms ease-in-out infinite}
.fdv-skeleton-row + .fdv-skeleton-row{border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-cred{display:flex;flex-direction:column;gap:${METRICS.headGap}px;padding:${METRICS.fieldPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-l2)}
.fdv-cred-head{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px}
.fdv-cred-main{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.headGap}px;flex:1;min-width:0}
.fdv-cred-title{font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px}
.fdv-cred-status{font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fdv-cred-actions{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px;flex:none}
.fdv-cred-form{display:flex;flex-direction:column;gap:${METRICS.inputGap}px;margin-top:${METRICS.headGap}px}
.fdv-cred-form-actions{display:flex;flex-wrap:wrap;align-items:center;gap:${METRICS.statusGap}px;margin-top:${METRICS.headGap}px}
.fdv-cred-alert{display:flex;flex-direction:column;gap:${METRICS.headGap}px;padding:${METRICS.statusGap}px ${METRICS.statusPadX}px;border-radius:${METRICS.radiusMd};background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-primary)}
.fdv-cred-details{margin:${METRICS.headGap}px 0 0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
@keyframes fdv-breathe{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes fdv-reveal{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@container (max-width:519px){.fdv-candidates{max-height:176px;overflow-y:auto}}
@media (prefers-reduced-motion:reduce){.fdv-skeleton-group,.fdv-skeleton-row{animation:none}.fdv-candidates{animation:none}.fdv-caret,.fdv-dot,.fdv-input,.fdv-primary,.fdv-link{transition:none}}
`;

    /* ------------------------------------------------------------------ *
     * 双语字典（zh 为准，en 同键镜像；hint 里不出现环境变量名）            *
     * ------------------------------------------------------------------ */

    const zh = {
      nav: 'DevOps',
      title: 'DevOps',
      intro: '插件会自己找 dop；只有找不到时才需要指定。',
      'status.ready': 'dop 已自动找到',
      'status.checking': '正在检测命令行位置',
      'status.unchanged': '位置未变',
      'status.missing': '未找到 {cli} · 已查 PATH、候选目录、环境变量',
      'status.unavailable': '配置面不可用 · {reason}',
      'action.takeOver': '改为手动',
      'action.reset': '重新自动发现',
      'action.refresh': '刷新',
      'action.check': '检查',
      'action.check.busy': '检查中…',
      'entry.dop': 'dop 可执行文件',
      'entry.placeholder': '粘贴 {tool} 的完整路径',
      'entry.placeholder.reset': '保存后自动发现',
      'entry.hint.discovered': '已自动找到 · 另有 {n} 个候选',
      'entry.hint.discovered.single': '已自动找到',
      'entry.hint.env': '来自环境变量 · 在此保存将覆盖它',
      'entry.hint.config': '已手动指定 · 清空即回落自动发现',
      'entry.hint.missing': '未找到 · 已查 PATH、候选目录、环境变量',
      'entry.hint.help': '在资源管理器里选中 {tool} 文件右键 →「复制文件地址」，粘贴到这里',
      'entry.hint.reset': '已重置为自动发现 · 保存后生效',
      'entry.hint.override': '已指定 · 保存后覆盖下一层来源',
      'origin.config': '配置',
      'origin.env': '环境变量',
      'origin.discovered': '自动发现',
      'origin.default': '默认',
      'origin.missing': '未找到',
      'origin.overridesEnv': '覆盖环境变量',
      'candidates.summary': '另有 {n} 个候选',
      'candidates.current': '当前生效',
      'field.timeoutMs': '命令超时（毫秒）',
      'field.timeoutMs.hint': '命令超过这个时间就判失败；按毫秒填，20 秒就是 20000',
      'field.timeoutMs.default': '20000（20 秒，默认）',
      'field.timeoutMs.seconds': '{ms}（{seconds} 秒）',
      'field.timeoutMs.millis': '{ms} 毫秒',
      'error.notFound': '找不到这个文件',
      'error.pathLength': '路径太长（上限 4096 个字符），请确认没有粘进整段日志',
      'error.timeout': '请输入 1000–600000 之间的整数（毫秒）',
      'error.load': '无法读取命令行位置',
      load: '正在读取命令行位置',
      save: '保存',
      saving: '保存中…',
      'saveFailed': '保存失败：{reason}',
      saveFailedStale: '配置已被其它窗口改动 · 刷新后重试',
      'unavailable.title': '这里暂时不能保存',
      'unavailable.body': '当前 profile 没有挂载配置面（settings / config-editor）。',
      'unavailable.envHint': '可以改用环境变量：',
      'unavailable.envDop': 'FORGE_DEVOPS_DOP_BIN  dop 可执行文件',
      'unavailable.readme': '详见 packages/forge-devops/README.md',
      'receipt.check': '检查：{state}',
      'receipt.unsaved': '未保存',
      'receipt.saved': '已保存 · 已生效',
      'receipt.notApplied': '已保存 · 未生效（{reason}）',
      'receipt.reason.rebuildFailed': '命令面未按新配置重建，请检查企业端点与命令行入口',
      'receipt.reason.configInvalid': '配置不合法，请检查填写的值',
      'receipt.reason.unknown': '原因未知',
      'receipt.unverified': '已保存 · 生效状态未知（{reason}）',
      'receipt.reason.apply-unverified': '宿主已注入流程/读取器，无法确认新配置已生效',
      'receipt.cleared': '已保存 · 已清除（本机暂无可用命令行入口）',
      'receipt.appliedUnknown': '已保存 · 生效状态未知',
      'receipt.saveHint': '保存：写入本机覆盖，服务端会立即按新配置重建。',
      'receipt.checkHint': '检查：重新发现配置并重建读面；不执行 CLI、不请求企业端点，也不改动数据。',
      'check.at': '{state} · {time}',
      'readiness.nav': '企业研发',
      'readiness.title': '企业研发',
      'readiness.row.identity': '身份与 Key',
      'readiness.row.tools': '本机工具',
      'readiness.row.device': '本机覆盖',
      'readiness.row.key': '网关 Key',
      'readiness.row.devops': 'DevOps',
      'readiness.row.gitee': 'Gitee',
      'readiness.summary.pending': '待处理',
      'readiness.summary.ready': '可以开始',
      'readiness.summary.hint': '先处理身份与 Key',
      'readiness.key.unconfigured': '未配置个人 Key',
      'readiness.key.unverified': 'Key 未验证',
      'readiness.key.verified': 'Key 已验证',
      'readiness.tools.dop.ready': 'dop 已找到',
      'readiness.tools.dop.missing': 'dop 未找到',
      'readiness.tools.gitee.unconfigured': 'Gitee 未配置',
      'readiness.tools.gitee.ready': 'Gitee 已配置',
      'readiness.detail.title': '详情',
      'readiness.detail.public': '公共参数：企业分发，本机不可改',
      'readiness.detail.write': '写权限：由企业侧判定，本页不判断',
      'readiness.footer': '本页只显示本机可见性，不代表业务授权。公共参数由企业分发；写权限由企业侧判定，本页不判断。',
      'readiness.state.signedIn': '已登录',
      'readiness.state.signedOut': '未登录',
      'readiness.state.signedOutUnknown': '退出未确认',
      'readiness.state.authenticating': '登录中',
      'readiness.state.expired': '过期',
      'readiness.state.unreachable': '不可达',
      'readiness.state.unknown': '未知',
      'readiness.state.missing': '未安装',
      'readiness.state.unconfigured': '未配置',
      'readiness.state.configured': '已配置',
      'readiness.state.keyUnverified': '已配置·未验证',
      'readiness.state.keyVerified': '已验证',
      'readiness.state.unchecked': '未检查',
      'readiness.state.checking': '检查中',
      'readiness.state.pass': '通过',
      'readiness.state.fail': '失败',
      'readiness.state.stale': '已过期',
      'readiness.reason.noCli': '未配置命令行入口',
      'readiness.reason.notExecutable': '入口不可执行',
      'readiness.reason.unreachable': '目标不可达',
      'readiness.reason.policyDenied': '策略拒绝',
      'readiness.key.reason.ownerMismatch': '凭据属于其他账号',
      'readiness.key.reason.notConfigured': '尚未写入网关凭据',
      'readiness.key.reason.invalid': '凭据记录不可读',
      'readiness.key.reason.modelUnavailable': '模型访问未就绪',
      'readiness.key.reason.unknown': '无法判定',
      'readiness.key.reason.notInstalled': '账号插件未安装',
      'readiness.next.signIn': '前往企业账号登录',
      'readiness.next.signingIn': '返回账号页等待登录完成',
      'readiness.next.signedIn': '身份已就绪，可继续核对网关 Key',
      'readiness.next.expired': '登录已过期，需要重新登录',
      'readiness.next.unreachable': '账号服务不可达，请稍后重试',
      'readiness.next.unconfirmed': '请到企业账号页核对是否已退出',
      'readiness.next.missingPlugin': '安装企业账号插件后再查看',
      'readiness.next.keyConfigure': '到企业账号页写入网关凭据',
      'readiness.next.keyVerify': '到企业账号页验证网关凭据',
      'readiness.next.check': '重新发现配置并重建读面',
      'readiness.next.refresh': '刷新后重试',
      'readiness.next.giteeBlocked': '本页不主动探测 Gitee 连通性',
      'readiness.action.openAccount': '前往企业账号',
      'readiness.nav.guide': '设置 → 企业账号',
      'readiness.check.item.revision': '基准',
      'readiness.check.item.time': '检查时间',
      'readiness.check.item.object': '对象',
      'readiness.check.item.sourceType': '来源类型',
      'readiness.check.sourceType.local-diagnostic': '本地诊断',
      'readiness.check.sourceType.fixture': '夹具',
      'readiness.check.sourceType.enterprise-evidence': '企业真实证据',
      'readiness.check.sourceType.unknown': '未知',
      'readiness.evidence.layer.file': '文件存在',
      'readiness.evidence.layer.executable': '可启动',
      'readiness.evidence.layer.target': '目标可识别',
      'readiness.evidence.layer.readonly': '权限策略放行',
      'readiness.evidence.state.pass': '通过',
      'readiness.evidence.state.fail': '未通过',
      'readiness.evidence.state.notRun': '未执行',
      'readiness.evidence.basis.filesystemStat': '本地文件系统检查',
      'readiness.evidence.basis.configShape': '配置形状',
      'readiness.evidence.basis.policyAdmission': '策略准入（未发起真实请求）',
      'readiness.evidence.reason.no-dop-bin': '未配置命令行入口',
      'readiness.evidence.reason.path-resolution-required': '需要可解析的完整路径',
      'readiness.evidence.reason.file-not-found': '路径不存在或不是普通文件',
      'readiness.evidence.reason.is-directory': '路径是目录',
      'readiness.evidence.reason.not-executable': '入口不可执行',
      'readiness.evidence.reason.source-type-unknown': '来源类型无法判定',
      'readiness.evidence.reason.policy-unavailable': '策略不可用',
      'readiness.evidence.reason.policy-denied': '策略拒绝访问',
      'readiness.evidence.reason.confirmation-required': '需要确认',
      'readiness.evidence.reason.no-evidence': '无可复核证据',
      'readiness.layers.title': '三层来源',
      'readiness.layers.inherited': '公共参数',
      'readiness.layers.override': '本机覆盖',
      'readiness.layers.effective': '最终生效',
      'readiness.layers.origin': '生效来源',
      'readiness.plugin.unknown': '版本未知',
      'readiness.layers.reason.LAYERS_UNAVAILABLE': '无法读取条目，三层来源未知',
      'readiness.layers.reason.INHERITED_EMPTY': '公共参数层为空',
      'readiness.layers.reason.OVERRIDE_EMPTY': '本机覆盖层为空',
      'readiness.layers.reason.NO_REVISION': '缺少 revision，无法确认最终生效',
      'readiness.origin.config': '配置',
      'readiness.origin.env': '环境变量',
      'readiness.origin.discovered': '自动发现',
      'readiness.origin.default': '默认',
      'readiness.origin.unset': '未配置',
      'readiness.origin.unknown': '未知',
      'readiness.local.none': '无本机覆盖',
      'readiness.local.keys': '本机覆盖：{keys}',
      'readiness.local.unknown': '未提供',
      'readiness.gitee.notExecuted': '未执行 · 本页不主动发起请求',
      'readiness.loading': '正在读取…',
      'readiness.failed': '无法读取（{reason}）',
      'readiness.action.check': '检查 DevOps',
      'readiness.action.check.busy': '检查中…',
      'readiness.action.checkGitee': '检查 Gitee',
      'readiness.action.refresh': '刷新',
      'credential.title': 'DevOps',
      'credential.state.follow': '跟随本机登录（正常可用，无需配置）',
      'credential.state.hosted': '已在此单独保存（优先于本机环境）',
      'credential.state.signedOut': '前往「设置 → 企业账号」登录后可用（已托管的凭据暂不外发）',
      'credential.state.unavailable': '跟随本机登录（独立安装模式：未接入企业账号托管，正常使用本机环境）',
      'credential.state.mismatchTag': '已停用（账号不匹配）',
      'credential.state.mismatch': '存在其他企业账号遗留的独立凭据，已安全停用（不会使用旧账号凭据，也不会回退本机环境）',
      'credential.state.pending': '上一笔凭据保存尚未完成，请稍候等待完成',
      'credential.state.keychainTag': '安全存储不可用',
      'credential.state.keychainUnavailable': '本机安全存储暂不可用，无法读取或保存托管凭据（请重试或改用本机 CLI 登录）',
      'credential.state.loading': '正在读取 DevOps 凭据状态…',
      'credential.state.loadFailed': '暂时无法读取凭据状态，请稍后重试',
      'credential.action.specify': '单独指定 Token',
      'credential.action.replace': '更换 Token',
      'credential.action.reset': '清除并恢复跟随本机',
      'credential.action.clearOld': '清除旧配置',
      'credential.action.resetAccount': '使用当前账号重设',
      'credential.action.save': '保存 Token',
      'credential.action.saving': '保存中…',
      'credential.action.clearing': '清除中…',
      'credential.action.cancel': '取消',
      'credential.action.retry': '重试',
      'credential.input.label': 'DevOps 访问凭据（只写不回显）',
      'credential.input.placeholder': '输入新的 DevOps 访问凭据',
      'credential.input.hint': '在此保存后，本应用将优先使用这里的 Token 覆盖本机环境；保存后页面不回显原值。',
      'credential.details.title': '环境详情',
      'credential.details.envVars': '检测到本机环境变量：{names}',
      'credential.notice.saved': '已在此单独保存（优先于本机环境）',
      'credential.notice.cleared': '已清除单独凭据，恢复跟随本机登录',
      'credential.fail.invalid': '请输入有效的凭据内容后再保存',
      'credential.fail.notSignedIn': '请先前往「设置 → 企业账号」登录企业账号，再保存或清除独立凭据',
      'credential.fail.pending': '上一笔凭据操作尚未完成，请稍候重试（已保留当前输入）',
      'credential.fail.keychainUnavailable': '本机安全存储暂不可用，未保存（详情可重试或改用本机 CLI 登录）',
      'credential.fail.ownerMismatch': '存在其他企业账号遗留凭据，请先清除旧配置或使用当前账号重设',
      'credential.fail.notFound': '尚未登记 DevOps 凭据扩展，请确认企业账号服务已就绪',
      'credential.fail.generic': '凭据操作未能完成，请稍后重试',
    };

    const en = {
      nav: 'DevOps',
      title: 'DevOps',
      intro: 'The plugin locates dop by itself; you only point at a path when it fails.',
      'status.ready': 'dop found automatically',
      'status.checking': 'Detecting command-line locations',
      'status.unchanged': 'locations unchanged',
      'status.missing': '{cli} not found · searched PATH, candidate folders, environment',
      'status.unavailable': 'Configuration unavailable · {reason}',
      'action.takeOver': 'Set manually',
      'action.reset': 'Rediscover',
      'action.refresh': 'Refresh',
      'action.check': 'Check',
      'action.check.busy': 'Checking…',
      'entry.dop': 'dop executable',
      'entry.placeholder': 'Paste the full path to {tool}',
      'entry.placeholder.reset': 'Resolved on save',
      'entry.hint.discovered': 'Found automatically · {n} more candidate',
      'entry.hint.discovered.single': 'Found automatically',
      'entry.hint.env': 'From environment · saving here overrides it',
      'entry.hint.config': 'Set manually · clear it to fall back to autodiscovery',
      'entry.hint.missing': 'Not found · searched PATH, candidate folders, environment',
      'entry.hint.help': 'In Explorer, select the {tool} file, right-click → "Copy as path", then paste it here',
      'entry.hint.reset': 'Reset to autodiscovery · takes effect on save',
      'entry.hint.override': 'Specified · overrides the layer below on save',
      'origin.config': 'config',
      'origin.env': 'environment',
      'origin.discovered': 'autodiscovery',
      'origin.default': 'default',
      'origin.missing': 'not found',
      'origin.overridesEnv': 'overrides environment',
      'candidates.summary': '{n} more candidate',
      'candidates.current': 'active',
      'field.timeoutMs': 'Command timeout (ms)',
      'field.timeoutMs.hint': 'A command fails after this long. Milliseconds: 20 s = 20000',
      'field.timeoutMs.default': '20000 (20 s, default)',
      'field.timeoutMs.seconds': '{ms} ({seconds} s)',
      'field.timeoutMs.millis': '{ms} ms',
      'error.notFound': 'That file does not exist',
      'error.pathLength': 'Path is too long (4096 chars max); check you did not paste a log block',
      'error.timeout': 'Enter an integer between 1000 and 600000 (ms)',
      'error.load': 'Cannot read command-line locations',
      load: 'Reading command-line locations',
      save: 'Save',
      saving: 'Saving…',
      'saveFailed': 'Save failed: {reason}',
      saveFailedStale: 'Changed in another window · refresh and retry',
      'unavailable.title': 'Saving is unavailable here',
      'unavailable.body': 'This profile mounts no configuration surface (settings / config-editor).',
      'unavailable.envHint': 'Environment variables still work:',
      'unavailable.envDop': 'FORGE_DEVOPS_DOP_BIN  dop executable',
      'unavailable.readme': 'See packages/forge-devops/README.md',
      'receipt.check': 'Check: {state}',
      'check.at': '{state} · {time}',
      'receipt.unsaved': 'unsaved',
      'receipt.saved': 'saved · in effect',
      'receipt.notApplied': 'saved · not in effect ({reason})',
      'receipt.reason.rebuildFailed': 'the command face was not rebuilt from the new configuration; check the endpoint and CLI entry',
      'receipt.reason.configInvalid': 'the configuration is invalid; check the values you entered',
      'receipt.reason.unknown': 'unknown reason',
      'receipt.unverified': 'saved · effect unknown ({reason})',
      'receipt.reason.apply-unverified': 'host-provided flow/reader; cannot confirm the new configuration is in effect',
      'receipt.cleared': 'saved · cleared (no CLI entry available on this host)',
      'receipt.appliedUnknown': 'saved · effect unknown',
      'receipt.saveHint': 'Save: writes the local override; the server rebuilds from the new configuration immediately.',
      'receipt.checkHint': 'Check: re-discovers configuration and rebuilds the read path; runs no CLI, calls no configured endpoint, and changes nothing.',
      'readiness.nav': 'Enterprise R&D',
      'readiness.title': 'Enterprise R&D',
      'readiness.row.identity': 'Identity & Key',
      'readiness.row.tools': 'Local tools',
      'readiness.row.device': 'Local override',
      'readiness.row.key': 'Gateway key',
      'readiness.row.devops': 'DevOps',
      'readiness.row.gitee': 'Gitee',
      'readiness.summary.pending': 'pending',
      'readiness.summary.ready': 'ready to start',
      'readiness.summary.hint': 'start with Identity & Key',
      'readiness.key.unconfigured': 'no personal key configured',
      'readiness.key.unverified': 'key unverified',
      'readiness.key.verified': 'key verified',
      'readiness.tools.dop.ready': 'dop found',
      'readiness.tools.dop.missing': 'dop not found',
      'readiness.tools.gitee.unconfigured': 'Gitee not configured',
      'readiness.tools.gitee.ready': 'Gitee configured',
      'readiness.detail.title': 'Details',
      'readiness.detail.public': 'Shared settings: distributed by the enterprise; cannot be changed here',
      'readiness.detail.write': 'Write access: decided by the enterprise; this page does not judge it',
      'readiness.footer': 'This page shows local visibility only; it does not represent business authorization. Shared settings are distributed by the enterprise; write access is decided by the enterprise and not judged here.',
      'readiness.state.signedIn': 'signed in',
      'readiness.state.signedOut': 'not signed in',
      'readiness.state.signedOutUnknown': 'sign-out unconfirmed',
      'readiness.state.authenticating': 'signing in',
      'readiness.state.expired': 'expired',
      'readiness.state.unreachable': 'unreachable',
      'readiness.state.unknown': 'unknown',
      'readiness.state.missing': 'not installed',
      'readiness.state.unconfigured': 'not configured',
      'readiness.state.configured': 'configured',
      'readiness.state.keyUnverified': 'configured · unverified',
      'readiness.state.keyVerified': 'verified',
      'readiness.state.unchecked': 'not checked',
      'readiness.state.checking': 'checking',
      'readiness.state.pass': 'passed',
      'readiness.state.fail': 'failed',
      'readiness.state.stale': 'stale',
      'readiness.reason.noCli': 'no command-line entry configured',
      'readiness.reason.notExecutable': 'entry is not executable',
      'readiness.reason.unreachable': 'target unreachable',
      'readiness.reason.policyDenied': 'denied by policy',
      'readiness.key.reason.ownerMismatch': 'credential belongs to another account',
      'readiness.key.reason.notConfigured': 'no gateway credential written yet',
      'readiness.key.reason.invalid': 'credential record unreadable',
      'readiness.key.reason.modelUnavailable': 'model access not ready',
      'readiness.key.reason.unknown': 'cannot determine',
      'readiness.key.reason.notInstalled': 'account plugin not installed',
      'readiness.next.signIn': 'Open the enterprise account page to sign in',
      'readiness.next.signingIn': 'Return to the account page and wait for sign-in to finish',
      'readiness.next.signedIn': 'Identity is ready; verify the gateway key next',
      'readiness.next.expired': 'Sign-in expired; sign in again',
      'readiness.next.unreachable': 'Account service unreachable; retry later',
      'readiness.next.unconfirmed': 'Check the enterprise account page to confirm sign-out',
      'readiness.next.missingPlugin': 'Install the enterprise account plugin first',
      'readiness.next.keyConfigure': 'Write the gateway credential on the account page',
      'readiness.next.keyVerify': 'Verify the gateway credential on the account page',
      'readiness.next.check': 'Re-discover configuration and rebuild the read path',
      'readiness.next.refresh': 'Refresh and retry',
      'readiness.next.giteeBlocked': 'This page does not actively probe Gitee',
      'readiness.action.openAccount': 'Open enterprise account',
      'readiness.nav.guide': 'Settings → Enterprise account',
      'readiness.check.item.revision': 'Baseline',
      'readiness.check.item.time': 'Checked at',
      'readiness.check.item.object': 'Object',
      'readiness.check.item.sourceType': 'Source type',
      'readiness.check.sourceType.local-diagnostic': 'local diagnostic',
      'readiness.check.sourceType.fixture': 'fixture',
      'readiness.check.sourceType.enterprise-evidence': 'enterprise evidence',
      'readiness.check.sourceType.unknown': 'unknown',
      'readiness.evidence.layer.file': 'file exists',
      'readiness.evidence.layer.executable': 'launchable',
      'readiness.evidence.layer.target': 'target recognizable',
      'readiness.evidence.layer.readonly': 'policy permitted',
      'readiness.evidence.state.pass': 'passed',
      'readiness.evidence.state.fail': 'failed',
      'readiness.evidence.state.notRun': 'not run',
      'readiness.evidence.basis.filesystemStat': 'local filesystem check',
      'readiness.evidence.basis.configShape': 'config shape',
      'readiness.evidence.basis.policyAdmission': 'policy admission (no real request sent)',
      'readiness.evidence.reason.no-dop-bin': 'no command-line entry configured',
      'readiness.evidence.reason.path-resolution-required': 'a resolvable full path is required',
      'readiness.evidence.reason.file-not-found': 'path missing or not a regular file',
      'readiness.evidence.reason.is-directory': 'path is a directory',
      'readiness.evidence.reason.not-executable': 'entry is not executable',
      'readiness.evidence.reason.source-type-unknown': 'source type cannot be determined',
      'readiness.evidence.reason.policy-unavailable': 'policy unavailable',
      'readiness.evidence.reason.policy-denied': 'access denied by policy',
      'readiness.evidence.reason.confirmation-required': 'confirmation required',
      'readiness.evidence.reason.no-evidence': 'no verifiable evidence',
      'readiness.layers.title': 'Layer sources',
      'readiness.layers.inherited': 'shared settings',
      'readiness.layers.override': 'local override',
      'readiness.layers.effective': 'effective',
      'readiness.layers.origin': 'effective source',
      'readiness.plugin.unknown': 'version unknown',
      'readiness.layers.reason.LAYERS_UNAVAILABLE': 'entry unreadable; layer sources unknown',
      'readiness.layers.reason.INHERITED_EMPTY': 'shared-settings layer is empty',
      'readiness.layers.reason.OVERRIDE_EMPTY': 'local-override layer is empty',
      'readiness.layers.reason.NO_REVISION': 'revision missing; effective layer unconfirmed',
      'readiness.origin.config': 'config',
      'readiness.origin.env': 'environment variable',
      'readiness.origin.discovered': 'discovered',
      'readiness.origin.default': 'default',
      'readiness.origin.unset': 'not configured',
      'readiness.origin.unknown': 'unknown',
      'readiness.local.none': 'no local override',
      'readiness.local.keys': 'local overrides: {keys}',
      'readiness.local.unknown': 'not provided',
      'readiness.gitee.notExecuted': 'Not run · this page does not send requests',
      'readiness.loading': 'Reading…',
      'readiness.failed': 'Cannot read ({reason})',
      'readiness.action.check': 'Check DevOps',
      'readiness.action.check.busy': 'Checking…',
      'readiness.action.checkGitee': 'Check Gitee',
      'readiness.action.refresh': 'Refresh',
      'credential.title': 'DevOps',
      'credential.state.follow': 'Uses local CLI sign-in (works automatically, no setup needed)',
      'credential.state.hosted': 'Saved separately here (takes priority over local environment)',
      'credential.state.signedOut': 'Sign in under Settings → Enterprise account to use saved credentials',
      'credential.state.unavailable': 'Uses local CLI sign-in (standalone mode: works with local environment)',
      'credential.state.mismatchTag': 'Disabled (account mismatch)',
      'credential.state.mismatch': 'A saved credential from another enterprise account was disabled for safety',
      'credential.state.pending': 'A previous credential save is still in progress; wait a moment',
      'credential.state.keychainTag': 'Secure storage unavailable',
      'credential.state.keychainUnavailable': 'Local secure storage is temporarily unavailable; retry or sign in with local CLI',
      'credential.state.loading': 'Reading DevOps credential status…',
      'credential.state.loadFailed': 'Unable to read credential status right now; retry later',
      'credential.action.specify': 'Set custom token',
      'credential.action.replace': 'Replace token',
      'credential.action.reset': 'Clear and use local sign-in',
      'credential.action.clearOld': 'Clear old credential',
      'credential.action.resetAccount': 'Set with current account',
      'credential.action.save': 'Save token',
      'credential.action.saving': 'Saving…',
      'credential.action.clearing': 'Clearing…',
      'credential.action.cancel': 'Cancel',
      'credential.action.retry': 'Retry',
      'credential.input.label': 'DevOps access token (write-only)',
      'credential.input.placeholder': 'Enter a new DevOps access credential',
      'credential.input.hint': 'Once saved here, this app uses it in place of local environment settings; the saved value is never shown again.',
      'credential.details.title': 'Environment details',
      'credential.details.envVars': 'Detected local environment variables: {names}',
      'credential.notice.saved': 'Saved separately here (takes priority over local environment)',
      'credential.notice.cleared': 'Cleared custom credential; restored local sign-in behavior',
      'credential.fail.invalid': 'Enter a valid credential value before saving',
      'credential.fail.notSignedIn': 'Sign in under Settings → Enterprise account before saving or clearing',
      'credential.fail.pending': 'Previous credential update is still in progress; retry shortly (draft kept)',
      'credential.fail.keychainUnavailable': 'Local secure storage is temporarily unavailable; retry or sign in with local CLI',
      'credential.fail.ownerMismatch': 'An older credential belongs to another enterprise account; clear or replace it below',
      'credential.fail.notFound': 'DevOps credential extension is not registered yet; verify account services',
      'credential.fail.generic': 'Credential update failed; retry in a moment',
    };

    /* ------------------------------------------------------------------ *
     * 纯函数helper                                                       *
     * ------------------------------------------------------------------ */

    const normalize = (value) => (value === null || value === undefined ? '' : String(value).trim());

    /** 删除一个键，返回新对象（不改原对象，配合 setState 使用）。 */
    function omit(object, key) {
      const next = { ...object };
      delete next[key];
      return next;
    }

    /** 字段的生效值：入口字段读 `path`，其余读 `value`（CliSnapshot.entries）。 */
    function effectiveValue(field, entry) {
      if (!entry) return '';
      return ENTRY_FIELDS.includes(field) ? normalize(entry.path) : normalize(entry.value);
    }

    /**
     * 客户端字段校验：只做**格式**判定，且只覆盖 `PAGE_FIELDS` 两键（页面能编辑的那两个）。
     * 存在性、是否目录、是否可执行由服务端在保存时判定（422 逐字段返回）；隐藏两键没有页面规则，
     * 页面既不渲染也不提交它们，服务端仍按四键契约校验——收窄在页面，不在服务端。
     * @returns {string|null} i18n 键；合法返回 null。空值 = 清除该层，恒合法。
     */
    function validateField(field, raw) {
      const value = normalize(raw);
      if (value === '') return null;
      if (field === 'dopBin') {
        // 只有长度这一条（服务端同样按 4096 截断，否则用户要等到 422 才知道粘多了）；
        // 形态/存在性/执行位一律留到保存期：页面判形态就会把可保存的 shim 提前拦掉。
        return value.length > MAX_PATH_LENGTH ? 'error.pathLength' : null;
      }
      if (field === 'timeoutMs') {
        const timeout = Number(value);
        return Number.isInteger(timeout) && timeout >= TIMEOUT_MIN && timeout <= TIMEOUT_MAX ? null : 'error.timeout';
      }
      return null;
    }

    /** 提交值：空串一律转 null（= 清除该层，回落下一层）；两键里只有 timeoutMs 需要转数字。 */
    function payloadValue(field, raw) {
      const value = normalize(raw);
      if (value === '') return null;
      return field === 'timeoutMs' ? Number(value) : value;
    }

    /** 服务端 422 的字段消息可能是 i18n 键，也可能是可直接展示的句子。 */
    function fieldMessage(t, message) {
      if (typeof message !== 'string') return String(message ?? '');
      return message.startsWith('error.') ? t(message) : message;
    }

    /** 统一错误体 `{ ok:false, code, message, errors? }`（TECHNICAL §3.1）；兼容带信封的写法。 */
    function errorCode(body) {
      if (!body || typeof body !== 'object') return null;
      if (typeof body.code === 'string') return body.code;
      if (body.error && typeof body.error.code === 'string') return body.error.code;
      return null;
    }

    /** 解析 JSON 响应体；非 JSON / 空体一律 null（不抛，调用方只看 `ok` 与 `code`）。 */
    async function readJsonBody(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    /**
     * `?refresh=1` 的唯一拼法（AC-10）：只有「检查」动作会走到这里。
     * 两处调用（DevOps 分区刷新、企业研发的检查行）共用一份，避免两处字符串各自漂移。
     */
    const refreshUrl = () => `${CLI_ENDPOINT}?refresh=1`;

    /**
     * 配置层压过环境变量时是否额外提示。
     * `overrides` 是 `cli-config.mjs` 里 `entryOf()` 既有的字段（被本层压过的下层数组）；
     * Snapshot 没投影该字段时静默不提示——不自行推断"环境变量有没有值"。
     */
    function overridesEnv(entry) {
      return Array.isArray(entry.overrides) && entry.overrides.includes('env');
    }

    /** origin → Tag 色调（与 DESIGN 语义一致：配置=blue、环境=灰、发现=绿、未找到=amber）。 */
    const ORIGIN_TONE = {
      config: 'accent',
      env: 'quiet',
      discovered: 'ok',
      default: 'quiet',
      missing: 'warn',
    };

    /* ------------------------------------------------------------------ *
     * 展示组件                                                            *
     * ------------------------------------------------------------------ */

    /** 小标签：来源、覆盖关系、当前生效项。 */
    function Tag(props) {
      // `text` 与 children 两种写法都要认：readiness 面板用 children 传状态词，
      // 早先这里只读 `props.text`，结果每行只画出一个空标签（屏上一排灰块）。
      // 回归用例：test/readiness-section.test.mjs「状态标签必须有字」。
      const label = props.text ?? props.children;
      return h('span', { className: `fdv-tag fdv-tag-${props.tone ?? 'quiet'}` }, label);
    }

    /** 状态行：唯一结论 + 全页唯一全局动作（重新自动发现）。 */
    function StatusLine(props) {
      const { tone, text } = props;
      // 状态行只讲「现在怎样」一句话；重新发现已由回执区的「检查」承担，不再挂第二个按钮。
      return h(
        'div',
        { className: `fdv-status fdv-status-${tone}` },
        h('span', { className: 'fdv-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fdv-status-text', role: 'status', 'aria-live': 'polite', title: text }, text),
      );
    }

    /** 候选展开区：默认收起，展开后逐行列出发现结果，当前项带 Tag。 */
    function CandidateList(props) {
      const { t, candidates, active } = props;
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      return h(
        'div',
        { className: 'fdv-candidates' },
        candidates.map((candidate) =>
          h(
            'div',
            { className: 'fdv-candidate', key: candidate.path },
            h('code', { className: 'fdv-candidate-path', title: candidate.path }, candidate.path),
            candidate.path === active ? h(Tag, { tone: 'accent', text: t('candidates.current') }) : null,
            candidate.tier ? h('span', { className: 'fdv-candidate-tier' }, candidate.tier) : null,
          ),
        ),
      );
    }

    /** 输入框下方一行：错误优先，否则提示；右侧放文本动作。 */
    function FieldFoot(props) {
      const { id, error, hint, action } = props;
      return h(
        'div',
        { className: `fdv-foot${error ? ' fdv-foot-error' : ''}`, id },
        h('span', { className: 'fdv-hint', title: error ?? hint }, error ?? hint),
        action ? h('span', { className: 'fdv-foot-actions' }, action) : null,
      );
    }

    /**
     * 入口字段（dop）：只读展示生效路径，覆盖时才可编辑。
     * 三态：resolved（只读）/ editing（可编辑）/ reset（已置空，保存后回落）。
     */
    function CliEntryField(props) {
      const { t, field, entry, tool, staged, editing, reset, expanded, error, first, locked, inputRef } = props;
      const { onTakeOver, onReset, onToggle, onInput, onBlur } = props;
      const origin = entry.origin ?? 'missing';
      const owned = origin === 'config';
      const editable = locked !== true && !reset && (owned || editing || origin === 'missing');
      const value = reset ? '' : staged !== undefined ? staged : normalize(entry.path);
      const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
      const others = candidates.length - 1;

      let hint;
      if (reset) hint = t('entry.hint.reset');
      else if (origin === 'missing') hint = editable ? t('entry.hint.help', { tool }) : t('entry.hint.missing');
      else if (origin === 'discovered') hint = others > 0 ? t('entry.hint.discovered', { n: others }) : t('entry.hint.discovered.single');
      else if (origin === 'env') hint = t('entry.hint.env');
      else if (owned) hint = t('entry.hint.config');
      else hint = t('entry.hint.override');

      const expandable = others > 0 && !editable;
      const hintAction = expandable
        ? h(
            'button',
            {
              type: 'button',
              className: 'fdv-link fdv-hint-toggle',
              'aria-expanded': expanded === true,
              onClick: onToggle,
            },
            h('span', null, hint),
            h('span', { className: `fdv-caret${expanded === true ? ' fdv-caret-open' : ''}`, 'aria-hidden': 'true' }, '⌄'),
          )
        : null;

      let action = null;
      if (locked === true) action = null;
      else if (reset) action = h('button', { type: 'button', className: 'fdv-link', onClick: onTakeOver }, t('action.takeOver'));
      else if (editable && (owned || editing)) action = h('button', { type: 'button', className: 'fdv-link', onClick: onReset }, t('action.reset'));
      else if (!editable) action = h('button', { type: 'button', className: 'fdv-link', onClick: onTakeOver }, t('action.takeOver'));

      const footId = `fdv-${field}-foot`;
      return h(
        'div',
        { className: `fdv-card${first ? ' fdv-card-first' : ''}` },
        h(
          'div',
          { className: 'fdv-head' },
          h('label', { className: 'fdv-label', htmlFor: `fdv-${field}` }, t('entry.dop')),
          h(Tag, { tone: ORIGIN_TONE[origin] ?? 'quiet', text: t(`origin.${origin}`) }),
          origin === 'config' && overridesEnv(entry) ? h(Tag, { tone: 'quiet', text: t('origin.overridesEnv') }) : null,
          action ? h('span', { className: 'fdv-head-actions' }, action) : null,
        ),
        h('input', {
          id: `fdv-${field}`,
          className: 'fdv-input',
          type: 'text',
          value,
          placeholder: reset ? t('entry.placeholder.reset') : t('entry.placeholder', { tool }),
          readOnly: !editable,
          spellCheck: false,
          autoComplete: 'off',
          'aria-invalid': error ? 'true' : undefined,
          'aria-describedby': footId,
          ref: inputRef,
          onChange: editable ? (event) => onInput(event.target.value) : undefined,
          onBlur: editable ? onBlur : undefined,
        }),
        h(FieldFoot, { id: footId, error, hint, action: hintAction }),
        expanded === true && expandable ? h(CandidateList, { t, candidates, active: normalize(entry.path) }) : null,
      );
    }

    /**
     * 超时单行（`PAGE_FIELDS` 里唯一的非路径字段）：值来自 staged，生效值走 placeholder。
     * 与入口卡同节律（12 上下内距 + 6 label/input + 6 input/hint），行间只靠 `.fdv-scalar`
     * 的上边框分隔——不新开分组、不加外框：超时是第二行，不是第二组。
     */
    function TimeoutField(props) {
      const { t, field, label, hint, placeholder, value, error, locked, inputRef, onChange, onBlur } = props;
      const id = `fdv-${field}`;
      const readOnly = locked === true;
      // 降级（写面缺失）时输入框只读但**可聚焦**：把生效值镜像进 value 才能选中复制。
      // 正常态则只放用户暂存值、生效值走 placeholder——否则「没改过」的生效值会被算成 dirty。
      const shown = readOnly ? value || placeholder || '' : value;
      return h(
        'div',
        { className: 'fdv-scalar' },
        h('label', { className: 'fdv-label', htmlFor: id }, label),
        h('input', {
          id,
          className: 'fdv-input fdv-scalar-input',
          type: 'text',
          inputMode: 'numeric',
          readOnly,
          value: shown,
          placeholder,
          spellCheck: false,
          autoComplete: 'off',
          'aria-invalid': error ? 'true' : undefined,
          'aria-describedby': `${id}-foot`,
          ref: inputRef,
          onChange: readOnly ? undefined : (event) => onChange(event.target.value),
          onBlur: readOnly ? undefined : onBlur,
        }),
        h(FieldFoot, { id: `${id}-foot`, error, hint }),
      );
    }

    /**
     * 首次加载骨架：与两行一列**同构**（`groupLine` 标题占位 + 两行 `skeletonRow` + `separator`），
     * 加载完成到表单零跳动。不再画 2×2 四格——那会暗示页面上有四个字段。
     */
    function Skeleton() {
      return h(
        'div',
        { className: 'fdv-skeleton', 'aria-hidden': 'true' },
        h('div', { className: 'fdv-skeleton-group' }),
        [0, 1].map((index) => h('div', { key: index, className: 'fdv-skeleton-row' })),
      );
    }

    /**
     * 写面不可用时的说明：页面降级为只读，给出环境变量兜底与文档入口。
     * 不服输地保留只读字段——用户至少能看到"现在用的是哪条路径"。
     */
    function UnavailableNote(props) {
      const { t } = props;
      return h(
        'div',
        { className: 'fdv-unavailable' },
        h('div', { className: 'fdv-unavailable-title' }, t('unavailable.title')),
        h('p', { className: 'fdv-unavailable-body' }, t('unavailable.body')),
        h('p', { className: 'fdv-unavailable-body' }, t('unavailable.envHint')),
        h('code', { className: 'fdv-unavailable-env' }, t('unavailable.envDop')),
        h('p', { className: 'fdv-unavailable-body' }, t('unavailable.readme')),
      );
    }

    /* ------------------------------------------------------------------ *
     * r15「企业研发」汇总面（AC-2 / AC-3 / AC-10）                        *
     * ------------------------------------------------------------------ */

    /** 读一个同源端点：任何失败都收敛成 `{ok:false,status}`，绝不抛（一行坏掉不牵连其它行）。 */
    async function readSource(url) {
      try {
        const response = await fetch(url, { headers: READ_HEADERS, cache: 'no-store' });
        const body = await readJsonBody(response);
        return { ok: response.ok, status: response.status, body };
      } catch {
        return { ok: false, status: 0, body: null };
      }
    }

    /** 端点不可用时的状态词：404 = 未安装（AC-7），其它 = 不可达。 */
    function sourceState(source) {
      if (source.ok) return null;
      return source.status === 404 ? READINESS_STATES.missing : READINESS_STATES.unreachable;
    }

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * 身份状态（AC-3）：未列出的 state 一律「退出未确认」，绝不回落成未登录/未知。
     * 回落等于把"不知道"说成"知道"，正是本需求要消灭的假绿灯。
     */
    function iamStateOf(source) {
      if (!source.ok) return sourceState(source);
      const state = source.body?.state;
      return Object.prototype.hasOwnProperty.call(IAM_STATE_OF, state) ? IAM_STATE_OF[state] : READINESS_STATES.signedOutUnknown;
    }

    /** 网关 Key（AC-2）：三条同时成立才算已验证，其余已配置一律「已配置·未验证」。 */
    function keyStateOf(source) {
      if (!source.ok) return source.status === 404 ? READINESS_STATES.missing : READINESS_STATES.unknown;
      const gateway = isObject(source.body?.gatewayCredential) ? source.body.gatewayCredential : null;
      if (!gateway) return READINESS_STATES.unknown;
      if (gateway.state === 'unconfigured') return READINESS_STATES.unconfigured;
      const verified = gateway.state === 'configured'
        && gateway.matchesAccount === true
        && source.body?.modelAccess?.state === 'ready';
      return verified ? READINESS_STATES.keyVerified : READINESS_STATES.keyUnverified;
    }

    /** Key 行的原因键：只读白名单里的三个字段，不碰凭据正文。 */
    function keyReasonKey(source, state) {
      if (state === READINESS_STATES.missing) return 'readiness.key.reason.notInstalled';
      if (state === READINESS_STATES.unconfigured) return 'readiness.key.reason.notConfigured';
      const gateway = isObject(source.body?.gatewayCredential) ? source.body.gatewayCredential : null;
      if (!gateway) return 'readiness.key.reason.unknown';
      if (gateway.state === 'invalid') return 'readiness.key.reason.invalid';
      if (gateway.matchesAccount === false) return 'readiness.key.reason.ownerMismatch';
      if (gateway.state !== 'configured') return 'readiness.key.reason.invalid';
      if (source.body?.modelAccess?.state !== 'ready') return 'readiness.key.reason.modelUnavailable';
      return 'readiness.key.reason.unknown';
    }

    /** 证据原因只认白名单里的十个码，其它一律「无可复核证据」。 */
    function evidenceReasonOf(reason) {
      return EVIDENCE_REASONS.includes(reason) ? reason : 'no-evidence';
    }

    /** 结论由四层证据唯一决定：客户端不采信服务端 verdict（证据才是事实）。 */
    function verdictOfEvidence(evidence) {
      const failed = evidence.find((item) => item.state === EVIDENCE_STATES.fail);
      if (failed) return { verdict: 'fail', blockedBy: failed.id, reason: failed.reason };
      const pending = evidence.find((item) => item.state === EVIDENCE_STATES.notRun);
      if (pending) return { verdict: 'incomplete', blockedBy: pending.id, reason: pending.reason };
      return { verdict: 'pass', blockedBy: null, reason: null };
    }

    /** 服务端 readiness 视图归一：contract/object/evidence 三者不符即「无证据」。 */
    function readinessOf(body) {
      const view = isObject(body?.readiness) ? body.readiness : null;
      if (!view || view.contract !== 1 || view.object !== 'devops') return null;
      if (!Array.isArray(view.evidence) || view.evidence.length !== EVIDENCE_LAYERS.length) return null;
      const evidence = EVIDENCE_LAYERS.map((id) => {
        const item = view.evidence.find((candidate) => candidate?.id === id);
        const state = Object.values(EVIDENCE_STATES).includes(item?.state) ? item.state : EVIDENCE_STATES.notRun;
        return {
          id,
          state,
          reason: state === EVIDENCE_STATES.pass ? null : evidenceReasonOf(item?.reason),
          basis: EVIDENCE_BASIS_OF[item?.basis] ?? null,
        };
      });
      return {
        at: typeof view.at === 'string' ? view.at : null,
        revision: typeof view.revision === 'string' ? view.revision : null,
        sourceType: READINESS_SOURCE_TYPES.includes(view.sourceType) ? view.sourceType : 'unknown',
        plugin: isObject(view.plugin) && typeof view.plugin.name === 'string'
          ? { name: view.plugin.name, version: typeof view.plugin.version === 'string' ? view.plugin.version : null }
          : null,
        layers: isObject(view.layers) ? view.layers : null,
        evidence,
        ...verdictOfEvidence(evidence),
      };
    }

    function layerListOf(value) {
      return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : null;
    }

    /** DevOps 三层来源：服务端只给键名，客户端不再二次推断。 */
    function devopsLayersOf(body) {
      const layers = isObject(body?.layers) ? body.layers : null;
      if (!layers) {
        return { inherited: null, override: null, effective: null, revision: null, missing: ['LAYERS_UNAVAILABLE'] };
      }
      const inherited = layerListOf(layers.inherited);
      const override = layerListOf(layers.override);
      const effective = inherited && override ? [...new Set([...inherited, ...override])].sort() : null;
      const revision = typeof body?.revision === 'string' ? body.revision : null;
      const missing = new Set(Array.isArray(layers.missing) ? layers.missing.filter((code) => typeof code === 'string') : []);
      if (inherited && inherited.length === 0) missing.add('INHERITED_EMPTY');
      if (override && override.length === 0) missing.add('OVERRIDE_EMPTY');
      if (!revision) missing.add('NO_REVISION');
      return { inherited, override, effective, revision, missing: [...missing] };
    }

    /** Gitee 三层来源：服务端给的是三层"值"，客户端只投影键名（值永不进渲染）。 */
    function giteeLayersOf(body) {
      const entries = isObject(body?.entries) ? body.entries : null;
      if (!entries) {
        return { inherited: null, override: null, effective: null, revision: null, missing: ['LAYERS_UNAVAILABLE'] };
      }
      const inherited = [];
      const override = [];
      for (const field of Object.keys(entries)) {
        const entry = isObject(entries[field]) ? entries[field] : {};
        if (entry.inherited !== null && entry.inherited !== undefined) inherited.push(field);
        if (entry.override !== null && entry.override !== undefined) override.push(field);
      }
      inherited.sort();
      override.sort();
      const effective = [...new Set([...inherited, ...override])].sort();
      const revision = typeof body?.revision === 'string' ? body.revision : null;
      const missing = [];
      if (inherited.length === 0) missing.push('INHERITED_EMPTY');
      if (override.length === 0) missing.push('OVERRIDE_EMPTY');
      if (!revision) missing.push('NO_REVISION');
      return { inherited, override, effective, revision, missing };
    }

    /** 生效来源枚举：内部 origin 值收敛成六个可显示枚举（未知不猜成默认）。 */
    function originKeyOf(origin) {
      switch (origin) {
        case 'config': return 'config';
        case 'env': return 'env';
        case 'discovered': return 'discovered';
        case 'default': return 'default';
        case 'missing': return 'unset';
        default: return 'unknown';
      }
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** 检查时间只显示到秒的本地时间（不引日期库，也不显示原始 ISO 串）。 */
    function formatTime(value) {
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) return '—';
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    function shortRevision(value) {
      return typeof value === 'string' && value.length > 0 ? value.slice(0, 8) : '—';
    }

    /** 三源全失败时只显示类别：不可达 / 未安装 / 失败，不暴露底层错误文本。 */
    function failureCategory(sources) {
      if (sources.every((source) => source.status === 0)) return READINESS_STATES.unreachable;
      if (sources.every((source) => source.status === 404)) return READINESS_STATES.missing;
      return READINESS_STATES.fail;
    }

    function toneOf(state) {
      if (state === READINESS_STATES.configured || state === READINESS_STATES.signedIn || state === READINESS_STATES.keyVerified || state === READINESS_STATES.pass) return 'ok';
      if (state === READINESS_STATES.fail || state === READINESS_STATES.missing || state === READINESS_STATES.expired
        || state === READINESS_STATES.signedOutUnknown || state === READINESS_STATES.keyUnverified) return 'warn';
      return 'quiet';
    }

    /**
     * 设置面板分区「企业研发」：七行汇总本机可见性（AC-1/2/3/4/6）。
     *
     * 五条不许越过的线：
     *   1. 三源并行读，任一失败只改自己那行（四组反例各断言另一行不变）；
     *   2. 只列**键名**与来源枚举，不显示任何配置值、路径或 endpoint（AC-12）；
     *   3. `?refresh=1` 只由「检查 DevOps」触发，且只打 DevOps 端点；
     *   4. 固定声明「本页只汇总本机可见性，不代表业务授权」恒在场；
     *   5. 迟到的旧回包整包丢弃（readSeq / checkSeq 双令牌），不让旧绿灯复活。
     */
    function ReadinessSection(props) {
      const t = props.t;
      // 嵌在容器条目里时不再画自己的标题与页脚：容器已经给了「企业研发工具」标题，
      // 再出现一个「企业研发」h2 就是三层同名标题（§6.3 的信息层级）。
      const embedded = props.embedded === true;
      const navigate = typeof props.navigate === 'function' ? props.navigate : null;
      const [reading, setReading] = React.useState({ mode: 'loading', sources: null, reason: null });
      const [check, setCheck] = React.useState({
        state: READINESS_STATES.unchecked,
        at: null,
        basis: null,
        verdict: null,
        reason: null,
        evidence: null,
        sourceType: null,
      });
      const [busy, setBusy] = React.useState(false);

      const mounted = React.useRef(true);
      const readSeq = React.useRef(0);
      const checkSeq = React.useRef(0);
      // 回包落定时必须比较"此刻最新"的读面与检查结论，而不是请求发起时的闭包快照：
      // 刷新与检查交错时，闭包会让旧结论对着另一代读面继续显示通过（P2）。
      const readingRef = React.useRef(reading);
      const checkRef = React.useRef(check);
      // 请求发起序号：服务端按请求到达顺序构建读面，序号大即读面新。
      const requestSeq = React.useRef(0);
      // 当前显示的 DevOps 读面由哪一次请求建立；`?refresh=1` 与三源刷新共用这一序。
      const devopsFaceSeq = React.useRef(0);

      function commitReading(next) {
        const value = typeof next === 'function' ? next(readingRef.current) : next;
        readingRef.current = value;
        setReading(value);
      }

      function commitCheck(next) {
        const value = typeof next === 'function' ? next(checkRef.current) : next;
        checkRef.current = value;
        setCheck(value);
      }

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      React.useEffect(() => {
        void load();
      }, []);

      async function load() {
        const token = readSeq.current + 1;
        readSeq.current = token;
        const seq = requestSeq.current + 1;
        requestSeq.current = seq;
        const previous = readingRef.current.sources;
        commitReading({ mode: previous ? 'refreshing' : 'loading', sources: previous, reason: null });
        const [iam, devops, gitee] = await Promise.all([
          readSource(READINESS_ENDPOINTS.iam),
          readSource(READINESS_ENDPOINTS.devops),
          readSource(READINESS_ENDPOINTS.gitee),
        ]);
        if (!mounted.current || token !== readSeq.current) return;
        const fetched = { iam, devops, gitee };
        const sources = [iam, devops, gitee];
        const allFailed = sources.every((source) => !source.ok);
        if (allFailed && previous) {
          // 刷新失败保留旧表：一次网络抖动不该把已有事实擦成空白。
          commitReading({ mode: 'ready', sources: readingRef.current.sources ?? previous, reason: failureCategory(sources) });
          return;
        }
        // 发起得更晚的请求（如本次刷新在途时落地的检查）读面更新，不能被更早发出的回包退回旧代。
        const keepCheckedFace = devopsFaceSeq.current > seq && readingRef.current.sources !== null;
        const applied = keepCheckedFace
          ? { ...fetched, devops: readingRef.current.sources.devops ?? devops }
          : fetched;
        if (!keepCheckedFace && applied.devops.ok) devopsFaceSeq.current = seq;
        commitReading({ mode: 'ready', sources: applied, reason: allFailed ? failureCategory(sources) : null });
        // 读面换代即让旧检查结论过期；回到旧 revision 也不自动复活（AC-9）。
        const latest = checkRef.current;
        const nextRevision = applied.devops.ok && typeof applied.devops.body?.revision === 'string' ? applied.devops.body.revision : null;
        if (latest.basis && nextRevision && latest.basis !== nextRevision && latest.state !== READINESS_STATES.stale) {
          commitCheck({ ...latest, state: READINESS_STATES.stale });
        }
      }

      /** 生效来源：只出"键名: 来源枚举"，不出任何值。 */
      function originsOf(snapshot) {
        const entries = isObject(snapshot?.entries) ? snapshot.entries : {};
        return Object.keys(entries)
          .filter((field) => typeof entries[field]?.origin === 'string')
          .map((field) => `${field}: ${t(`readiness.origin.${originKeyOf(entries[field].origin)}`)}`);
      }

      /**
       * 本机覆盖：只认服务端 layers 投影，不从合并后的 entries.origin 反推。
       * 任一来源没有提供投影时返回 null（未知），由调用方显示「未提供」，不猜。
       */
      function localOverrides(devops, gitee) {
        // `LAYERS_UNAVAILABLE` 说明服务端也拿不到配置层，此时空数组不是"没有覆盖"，而是"不知道"。
        const projected = (layers) => (layers.missing.includes('LAYERS_UNAVAILABLE') ? null : layers.override);
        const lists = [projected(devopsLayersOf(devops.body)), projected(giteeLayersOf(gitee.body))];
        if (lists.some((list) => list === null)) return null;
        return [...new Set(lists.flat())].sort();
      }

      /** Key 的说明位：只讲"有没有、验没验"；具体原因留给详情。 */
      function keyPhrase(iam, keyState) {
        if (keyState === READINESS_STATES.keyVerified) return t('readiness.key.verified');
        if (keyState === READINESS_STATES.keyUnverified) return t('readiness.key.unverified');
        if (keyState === READINESS_STATES.unconfigured) return t('readiness.key.unconfigured');
        return t(keyReasonKey(iam, keyState));
      }

      function dopPhrase(state) {
        return state === READINESS_STATES.configured ? t('readiness.tools.dop.ready') : t('readiness.tools.dop.missing');
      }

      function giteePhrase(state) {
        return state === READINESS_STATES.configured ? t('readiness.tools.gitee.ready') : t('readiness.tools.gitee.unconfigured');
      }

      function memberTable() {
        const sources = reading.sources ?? {};
        const iam = sources.iam ?? { ok: false, status: 0, body: null };
        const devops = sources.devops ?? { ok: false, status: 0, body: null };
        const gitee = sources.gitee ?? { ok: false, status: 0, body: null };
        const overrides = localOverrides(devops, gitee);
        const identityState = iamStateOf(iam);
        const keyState = keyStateOf(iam);
        const devopsState = devops.ok
          ? (devops.body?.ready === true ? READINESS_STATES.configured : READINESS_STATES.unconfigured)
          : sourceState(devops);
        const giteeState = gitee.ok
          ? (gitee.body?.ready === true ? READINESS_STATES.configured : READINESS_STATES.unconfigured)
          : sourceState(gitee);
        const devopsView = readinessOf(devops.body);

        const identityNext = (() => {
          switch (identityState) {
            case READINESS_STATES.signedOut: return { kind: 'navigate', key: 'readiness.next.signIn' };
            case READINESS_STATES.signedIn: return { kind: 'navigate', key: 'readiness.next.signedIn' };
            case READINESS_STATES.authenticating: return { kind: 'text', key: 'readiness.next.signingIn' };
            case READINESS_STATES.expired: return { kind: 'navigate', key: 'readiness.next.expired' };
            case READINESS_STATES.unreachable: return { kind: 'button', key: 'readiness.next.unreachable', label: 'readiness.action.refresh', onClick: () => void load() };
            case READINESS_STATES.signedOutUnknown: return { kind: 'navigate', key: 'readiness.next.unconfirmed' };
            case READINESS_STATES.missing: return { kind: 'text', key: 'readiness.next.missingPlugin' };
            default: return { kind: 'text', key: 'readiness.next.refresh' };
          }
        })();

        return {
          identity: {
            id: 'identity',
            state: identityState,
            detail: null,
            phrase: t(`readiness.state.${identityState}`),
            next: identityNext,
          },
          key: {
            id: 'key',
            state: keyState,
            detail: keyState === READINESS_STATES.keyVerified ? null : t(keyReasonKey(iam, keyState)),
            phrase: keyPhrase(iam, keyState),
            next: keyState === READINESS_STATES.keyUnverified || keyState === READINESS_STATES.unconfigured
              ? { kind: 'navigate', key: keyState === READINESS_STATES.unconfigured ? 'readiness.next.keyConfigure' : 'readiness.next.keyVerify' }
              : keyState === READINESS_STATES.missing
                ? { kind: 'text', key: 'readiness.next.missingPlugin' }
                : { kind: 'none', key: null },
          },
          device: {
            id: 'device',
            state: overrides === null
              ? READINESS_STATES.unknown
              : overrides.length > 0 ? READINESS_STATES.configured : READINESS_STATES.unconfigured,
            detail: overrides === null
              ? t('readiness.local.unknown')
              : overrides.length > 0
                ? t('readiness.local.keys', { keys: overrides.join('、') })
                : t('readiness.local.none'),
            phrase: null,
            next: { kind: 'none', key: null },
          },
          devops: {
            id: 'devops',
            state: devopsState,
            detail: devops.ok ? null : t(`readiness.state.${sourceState(devops)}`),
            phrase: dopPhrase(devopsState),
            next: { kind: 'text', key: 'readiness.next.check' },
            layers: devopsLayersOf(devops.body),
            plugin: devopsView?.plugin ?? (isObject(devops.body?.plugin) ? devops.body.plugin : null),
            origins: originsOf(devops.body),
          },
          gitee: {
            id: 'gitee',
            state: giteeState,
            detail: gitee.ok ? null : t(`readiness.state.${sourceState(gitee)}`),
            phrase: giteePhrase(giteeState),
            next: { kind: 'text', key: 'readiness.next.giteeBlocked' },
            layers: giteeLayersOf(gitee.body),
            plugin: isObject(gitee.body?.plugin) ? gitee.body.plugin : null,
            origins: originsOf(gitee.body),
          },
        };
      }

      /** 组状态取成员最差 tone（warn > quiet > ok，同 tone 取靠前成员）。 */
      const TONE_RANK = { warn: 2, quiet: 1, ok: 0 };
      function worstTone(list) {
        let worst = null;
        for (const member of list) {
          const tone = toneOf(member.state);
          if (worst === null || TONE_RANK[tone] > TONE_RANK[worst]) worst = tone;
        }
        return worst ?? 'quiet';
      }

      function groupTable(members) {
        const devops = members.devops;
        return {
          identity: {
            id: 'identity',
            tone: worstTone([members.identity, members.key]),
            state: members.identity.state,
            detail: members.key.phrase,
            next: members.identity.next,
          },
          tools: {
            id: 'tools',
            tone: worstTone([members.device, devops, members.gitee]),
            state: devops.state,
            detail: `${devops.phrase} · ${members.gitee.phrase}`,
            next: null,
          },
        };
      }

      function summaryOf(members) {
        const pending = [];
        if (members.identity.state !== READINESS_STATES.signedIn) pending.push(members.identity);
        if (members.key.state !== READINESS_STATES.keyVerified) pending.push(members.key);
        if (members.devops.state !== READINESS_STATES.configured) pending.push(members.devops);
        if (members.gitee.state !== READINESS_STATES.configured) pending.push(members.gitee);
        if (pending.length === 0) return `✅ ${t('readiness.summary.ready')}`;
        if (pending.length === 1) return `⚠ 1 项${t('readiness.summary.pending')} · ${pending[0].phrase}`;
        return `⚠ ${pending.length} 项${t('readiness.summary.pending')} · ${t('readiness.summary.hint')}`;
      }

      /** 检查：只打 DevOps 端点，且只有它带 `?refresh=1`（AC-4）。 */
      async function runCheck() {
        const token = checkSeq.current + 1;
        checkSeq.current = token;
        const seq = requestSeq.current + 1;
        requestSeq.current = seq;
        setBusy(true);
        commitCheck({
          state: READINESS_STATES.checking,
          at: null,
          basis: null,
          verdict: null,
          reason: null,
          evidence: null,
          sourceType: null,
        });
        const result = await readSource(refreshUrl());
        if (!mounted.current || token !== checkSeq.current) return;
        setBusy(false);
        const at = new Date().toISOString();
        if (!result.ok) {
          const code = CHECK_REASON_OF[errorCode(result.body) ?? ''] ?? null;
          commitCheck({
            state: result.status === 0 ? READINESS_STATES.unknown : READINESS_STATES.fail,
            at,
            basis: null,
            verdict: null,
            reason: code ? `readiness.reason.${code}` : null,
            evidence: null,
            sourceType: null,
          });
          return;
        }
        // 同一次响应既是检查结论也是来源快照：先同步读面，汇总才不会继续写"dop 未找到"（P2）。
        syncDevopsSource(result, seq);
        const view = readinessOf(result.body);
        const basis = typeof result.body?.revision === 'string' ? result.body.revision : null;
        if (!view) {
          commitCheck({
            state: READINESS_STATES.unknown,
            at,
            basis,
            verdict: null,
            reason: 'readiness.evidence.reason.no-evidence',
            evidence: null,
            sourceType: null,
          });
          return;
        }
        commitCheck({
          state: view.verdict === 'pass' ? READINESS_STATES.pass : view.verdict === 'fail' ? READINESS_STATES.fail : READINESS_STATES.unknown,
          at,
          basis: basis ?? view.revision,
          verdict: view.verdict,
          reason: view.reason ? `readiness.evidence.reason.${view.reason}` : null,
          evidence: view.evidence,
          sourceType: view.sourceType,
        });
      }

      /** 把检查重建后的 DevOps 读面并入来源快照；首屏未就绪时由 load 统一上屏。 */
      function syncDevopsSource(result, seq) {
        const latest = readingRef.current;
        if (!latest.sources || !result.ok) return;
        devopsFaceSeq.current = seq;
        commitReading({
          mode: latest.mode,
          sources: { ...latest.sources, devops: result },
        });
      }

      function checkDetailOf(value) {
        // D-1：未检查是一行状态，不能与检查结果的「未执行」同词（四层证据另有「未执行」）。
        if (value.state === READINESS_STATES.unchecked) return t('readiness.state.unchecked');
        const state = t(`readiness.state.${value.state}`);
        if (value.state === READINESS_STATES.checking) return `${state} · ${t('readiness.next.check')}`;
        const time = value.at ? formatTime(value.at) : '—';
        if (value.reason) return `${state} · ${t(value.reason)} · ${time}`;
        return t('check.at', { state, time });
      }

      function evidenceNode(item) {
        const stateKey = item.state === EVIDENCE_STATES.notRun ? 'notRun' : item.state;
        return h(
          'li',
          { className: 'fdv-evidence-row', key: item.id },
          h('span', { className: 'fdv-evidence-layer' }, t(`readiness.evidence.layer.${item.id}`)),
          h(Tag, { tone: item.state === EVIDENCE_STATES.pass ? 'ok' : item.state === EVIDENCE_STATES.fail ? 'warn' : 'quiet' }, t(`readiness.evidence.state.${stateKey}`)),
          item.reason && item.state !== EVIDENCE_STATES.pass
            ? h('span', { className: 'fdv-evidence-reason' }, t(`readiness.evidence.reason.${item.reason}`))
            : null,
          item.basis ? h('span', { className: 'fdv-evidence-basis' }, t(`readiness.evidence.basis.${item.basis}`)) : null,
        );
      }

      function checkPanel() {
        const items = [
          ['readiness.check.item.revision', check.basis ? shortRevision(check.basis) : t('readiness.state.unknown')],
          ['readiness.check.item.time', check.at ? formatTime(check.at) : '—'],
          ['readiness.check.item.object', 'DevOps'],
          ['readiness.check.item.sourceType', check.sourceType
            ? t(`readiness.check.sourceType.${check.sourceType}`)
            : t('readiness.check.sourceType.unknown')],
        ];
        const evidence = check.evidence ?? EVIDENCE_LAYERS.map((id) => ({
          id,
          state: EVIDENCE_STATES.notRun,
          reason: 'no-evidence',
          basis: null,
        }));
        return h(
          'div',
          { className: 'fdv-check', key: 'check' },
          h('div', { className: 'fdv-check-grid' }, items.map(([labelKey, value]) =>
            h('div', { className: 'fdv-check-item', key: labelKey },
              h('span', { className: 'fdv-check-label' }, t(labelKey)),
              h('span', { className: 'fdv-check-value' }, value)))),
          h('ul', { className: 'fdv-evidence' }, evidence.map(evidenceNode)),
          h(
            'div',
            { className: 'fdv-check-footer' },
            h(
              'span',
              { className: 'fdv-note', role: 'status', 'aria-live': 'polite' },
              `${t('receipt.check', { state: checkDetailOf(check) })}`,
            ),
          ),
        );
      }

      function layersNode(row) {
        const layers = row.layers;
        const keyList = (list) => (list === null ? t('readiness.origin.unknown') : list.length === 0 ? '—' : list.join('、'));
        const plugin = row.plugin;
        return h(
          'details',
          { className: 'fdv-details', key: `${row.id}-layers` },
          h('summary', { className: 'fdv-summary' }, t('readiness.layers.title')),
          h(
            'div',
            { className: 'fdv-details-body' },
            row.origins && row.origins.length > 0
              ? h('div', { className: 'fdv-layer-line' },
                h('span', { className: 'fdv-layer-label' }, t('readiness.layers.origin')),
                h('span', { className: 'fdv-layer-value' }, row.origins.join('、')))
              : null,
            h('div', { className: 'fdv-layer-line' },
              h('span', { className: 'fdv-layer-label' }, t('readiness.layers.inherited')),
              h('span', { className: 'fdv-layer-value' }, keyList(layers.inherited))),
            h('div', { className: 'fdv-layer-line' },
              h('span', { className: 'fdv-layer-label' }, t('readiness.layers.override')),
              h('span', { className: 'fdv-layer-value' }, keyList(layers.override))),
            h('div', { className: 'fdv-layer-line' },
              h('span', { className: 'fdv-layer-label' }, t('readiness.layers.effective')),
              h('span', { className: 'fdv-layer-value' }, `${keyList(layers.effective)}${layers.revision ? ` · ${shortRevision(layers.revision)}` : ''}`)),
            plugin && typeof plugin.name === 'string'
              ? h('div', { className: 'fdv-layer-line' },
                h('span', { className: 'fdv-layer-label' }, t(`readiness.row.${row.id}`)),
                h('span', { className: 'fdv-layer-value' }, `${plugin.name} · ${typeof plugin.version === 'string' ? plugin.version : t('readiness.plugin.unknown')}`))
              : null,
            layers.missing.length > 0
              ? h('div', { className: 'fdv-layer-line' },
                h('span', { className: 'fdv-layer-label' }, t('readiness.layers.title')),
                h('span', { className: 'fdv-layer-value' }, layers.missing.map((code) => t(`readiness.layers.reason.${code}`)).join('；')))
              : null,
          ),
        );
      }

      function detailLine(text, key) {
        return h('span', { className: 'fdv-detail-text', key }, text);
      }

      /** 详情成员：三层来源、插件名与版本、检查四项与四层证据都挂在这里。 */
      function memberNode(member) {
        const nextText = member.next && member.next.kind !== 'none'
          ? `${t(member.next.key)}${member.next.kind === 'text' ? '' : ` · ${t('readiness.nav.guide')}`}`
          : null;
        return h(
          'div',
          { className: 'fdv-detail-line', key: member.id, 'data-member': member.id },
          h('span', { className: 'fdv-detail-label' }, t(`readiness.row.${member.id}`)),
          h(Tag, { tone: toneOf(member.state) }, t(`readiness.state.${member.state}`)),
          member.detail ? h('span', { className: 'fdv-detail-text' }, member.detail) : null,
          nextText && member.id !== 'identity' ? h('span', { className: 'fdv-next' }, nextText) : null,
          member.layers ? layersNode(member) : null,
          member.id === 'devops' ? checkPanel() : null,
          member.id === 'gitee' ? h('span', { className: 'fdv-next' }, t('readiness.gitee.notExecuted')) : null,
        );
      }

      function detailsNode(groupId, members) {
        const body = [];
        if (groupId === 'identity') body.push(detailLine(t('readiness.detail.public'), 'public'));
        for (const member of READINESS_GROUP_MEMBERS[groupId].map((id) => members[id])) {
          body.push(memberNode(member));
        }
        if (groupId === 'identity' && members.identity.next && members.identity.next.kind !== 'none') {
          body.push(detailLine(
            `${t(members.identity.next.key)}${members.identity.next.kind === 'text' ? '' : ` · ${t('readiness.nav.guide')}`}`,
            'identity-next',
          ));
        }
        if (groupId === 'tools') body.push(detailLine(t('readiness.detail.write'), 'write'));
        return h(
          'details',
          { className: 'fdv-details', key: 'details' },
          h('summary', { className: 'fdv-summary' }, t('readiness.detail.title')),
          h('div', { className: 'fdv-details-body' }, body),
        );
      }

      /** 身份组：可导航时给按钮，不可达时保留「重新检查」并把账号页文字入口留在详情。 */
      function identityActions(group) {
        const next = group.next;
        if (!next) return null;
        if (next.kind === 'navigate' && navigate) {
          return h(
            'button',
            { type: 'button', className: 'fdv-link', key: 'account', onClick: () => navigate(SECTION_FORGE_IAM) },
            t('readiness.action.openAccount'),
          );
        }
        if (next.kind === 'button') {
          return h(
            'button',
            { type: 'button', className: 'fdv-link', key: 'retry', disabled: busy, onClick: next.onClick },
            t(next.label),
          );
        }
        return null;
      }

      function toolsActions() {
        return [
          h(
            'button',
            { type: 'button', className: 'fdv-link', key: 'check', disabled: busy, onClick: () => void runCheck() },
            busy ? t('readiness.action.check.busy') : t('readiness.action.check'),
          ),
          h(
            'button',
            { type: 'button', className: 'fdv-link', key: 'gitee', disabled: true, title: t('readiness.gitee.notExecuted') },
            t('readiness.action.checkGitee'),
          ),
        ];
      }

      if (reading.mode === 'loading' && !reading.sources) {
        return h(
          'div',
          { className: 'fdv-root' },
          embedded ? null : h('div', { className: 'fdv-title' }, t('readiness.title')),
          h(Skeleton, { key: 'skeleton' }),
          h('p', { className: 'fdv-note', role: 'status', 'aria-live': 'polite' }, t('readiness.loading')),
        );
      }

      const members = memberTable();
      const groups = groupTable(members);

      const rowNode = (groupId) => {
        const group = groups[groupId];
        return h(
          'div',
          { className: 'fdv-row', key: groupId, 'data-group': groupId },
          h('span', { className: 'fdv-row-label' }, t(`readiness.row.${groupId}`)),
          h(
            'div',
            { className: 'fdv-row-main' },
            h(
              'span',
              { className: 'fdv-row-state' },
              h(Tag, { tone: group.tone }, t(`readiness.state.${group.state}`)),
              h('span', { className: 'fdv-row-detail' }, ` · ${group.detail}`),
            ),
            h('span', { className: 'fdv-row-actions' }, groupId === 'identity' ? identityActions(group) : toolsActions()),
          ),
          detailsNode(groupId, members),
        );
      };

      return h(
        'div',
        { className: 'fdv-root', 'aria-busy': reading.mode === 'refreshing' ? 'true' : undefined },
        embedded ? null : h('div', { className: 'fdv-title' }, t('readiness.title')),
        h(
          'div',
          { className: 'fdv-summary-row' },
          h('span', { className: 'fdv-summary-text', role: 'status', 'aria-live': 'polite' }, summaryOf(members)),
          h(
            'button',
            { type: 'button', className: 'fdv-link', disabled: busy, onClick: () => void load() },
            t('readiness.action.refresh'),
          ),
        ),
        h('div', { className: 'fdv-group' }, READINESS_GROUPS.map(rowNode)),
        reading.reason
          ? h('p', { className: 'fdv-note fdv-note-error', role: 'status' }, t('readiness.failed', { reason: t(`readiness.state.${reading.reason}`) }))
          : null,
        embedded ? null : h('p', { className: 'fdv-footer fdv-disclaimer', key: 'footer' }, t('readiness.footer')),
      );
    }

    /* ------------------------------------------------------------------ *
     * 页面编排                                                            *
     * ------------------------------------------------------------------ */

    /**
     * 设置面板分区：读快照 → 只读展示 → 覆盖/重置 → 校验 → 保存。
     * 状态机：loading → form | degraded | error；form 内 idle → checking / saving。
     */
    function DevopsSection(props) {
      const t = props.t;
      const [view, setView] = React.useState({ mode: 'loading', snapshot: null, reason: null });
      const [staged, setStaged] = React.useState({});
      const [errors, setErrors] = React.useState({});
      const [phase, setPhase] = React.useState('idle');
      const [notice, setNotice] = React.useState(null);
      const [editing, setEditing] = React.useState({});
      const [expanded, setExpanded] = React.useState({});
      const [steady, setSteady] = React.useState(false);
      // 回执只讲一句：保存成功与否，以及服务端是否声明生效（缺 `applied` 就是「未知」）。
      const [receipt, setReceipt] = React.useState(null);
      const [checkedAt, setCheckedAt] = React.useState(null);

      const mounted = React.useRef(true);
      const snapshotRef = React.useRef(null);
      const paths = React.useRef(null);
      const nodes = React.useRef({});
      const nodeRefs = React.useRef({});
      const pendingFocus = React.useRef('');

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      React.useEffect(() => {
        void load(false);
      }, []);

      // 焦点移到第一个非法字段（blur 校验与 422 共用一条通道）。
      React.useEffect(() => {
        const field = pendingFocus.current;
        if (!field) return;
        pendingFocus.current = '';
        const node = nodes.current[field];
        if (node && typeof node.focus === 'function') node.focus();
      }, [errors]);

      /** 每个字段一个稳定的 ref 回调，避免每次渲染重挂。 */
      function inputRef(field) {
        if (!nodeRefs.current[field]) {
          nodeRefs.current[field] = (node) => {
            nodes.current[field] = node;
          };
        }
        return nodeRefs.current[field];
      }

      /** 焦点移到第一个非法字段（只在页面可见的两键里找，别为隐藏键聚焦一个不存在的输入框）。 */
      function focusFirst(map) {
        for (const field of PAGE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(map, field)) {
            pendingFocus.current = field;
            return;
          }
        }
      }

      function applySnapshot(snapshot) {
        snapshotRef.current = snapshot;
        const writable = !(snapshot.writable && snapshot.writable.ok === false);
        setView({ mode: writable ? 'form' : 'degraded', snapshot, reason: snapshot.reason ?? null });
      }

      function originOf(field) {
        return snapshotRef.current?.entries?.[field]?.origin ?? 'missing';
      }

      /** 判断一个 staged 值是否真的与用户层现值不同（等值噪声不提交，AC-7）。 */
      function isChanged(field, value) {
        const entry = snapshotRef.current?.entries?.[field];
        const base = originOf(field) === 'config' ? effectiveValue(field, entry) : '';
        return normalize(value) !== base;
      }

      async function readJson(response) {
        try {
          return await response.json();
        } catch {
          return null;
        }
      }

      async function readCli(refresh) {
        try {
          const response = await fetch(refresh ? refreshUrl() : CLI_ENDPOINT, {
            headers: READ_HEADERS,
            cache: 'no-store',
          });
          const body = await readJson(response);
          if (!response.ok) return { ok: false, reason: errorCode(body) ?? `HTTP ${response.status}` };
          if (!body || typeof body !== 'object' || !body.entries) return { ok: false, reason: t('error.load') };
          return { ok: true, snapshot: body };
        } catch (error) {
          return { ok: false, reason: error && error.message ? error.message : t('error.load') };
        }
      }

      /** 读快照；refresh=1 是页面唯一会触发重新扫描的动作（AC-4）。 */
      async function load(refresh) {
        setPhase(refresh ? 'checking' : 'loading');
        if (!refresh) setSteady(false);
        const result = await readCli(refresh);
        if (!mounted.current) return;
        setPhase('idle');
        if (!result.ok) {
          if (snapshotRef.current) {
            setNotice({ kind: 'failed', text: t('saveFailed', { reason: result.reason }) });
            return;
          }
          setView({ mode: 'error', snapshot: null, reason: result.reason });
          return;
        }
        const snapshot = result.snapshot;
        const next = {
          dop: normalize(snapshot.entries?.dopBin?.path),
        };
        const unchanged = refresh && paths.current !== null && paths.current.dop === next.dop;
        paths.current = next;
        if (!mounted.current) return;
        applySnapshot(snapshot);
        setSteady(refresh && unchanged);
        if (refresh) setCheckedAt(new Date().toISOString());
        setReceipt(null);
        setNotice(null);
      }

      function takeOver(field) {
        // 预填当前生效值（可能是环境变量或发现命中），让用户从真实值改，而不是从空白猜。
        const current = effectiveValue(field, snapshotRef.current?.entries?.[field]);
        setStaged((prev) => ({ ...prev, [field]: current }));
        setEditing((prev) => ({ ...prev, [field]: true }));
        setErrors((prev) => omit(prev, field));
        setReceipt(null);
        setNotice(null);
      }

      function resetToAuto(field) {
        setStaged((prev) => ({ ...prev, [field]: null }));
        setEditing((prev) => ({ ...prev, [field]: false }));
        setErrors((prev) => omit(prev, field));
        setReceipt(null);
        setNotice(null);
      }

      /** 输入即写 staged；只有已经出错的字段才边输边复验。 */
      function onInput(field, value) {
        setStaged((prev) => ({ ...prev, [field]: value }));
        setErrors((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, field)) return prev;
          const key = validateField(field, value);
          return key ? { ...prev, [field]: t(key) } : omit(prev, field);
        });
        setReceipt(null);
        setNotice(null);
      }

      function onBlur(field) {
        if (!Object.prototype.hasOwnProperty.call(staged, field)) return;
        const key = validateField(field, staged[field]);
        setErrors((prev) => (key ? { ...prev, [field]: t(key) } : omit(prev, field)));
      }

      function toggleCandidates(field) {
        setExpanded((prev) => ({ ...prev, [field]: prev[field] !== true }));
      }

      /** 保存：只提交真正变化的键（且只可能是 PAGE_FIELDS 两键）；空值转 null（= 清除该层，回落下一层）。 */
      async function save() {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const fields = {};
        for (const field of PAGE_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(staged, field)) continue;
          if (!isChanged(field, staged[field])) continue;
          fields[field] = payloadValue(field, staged[field]);
        }
        if (Object.keys(fields).length === 0) return;

        const local = {};
        for (const field of Object.keys(fields)) {
          const key = validateField(field, fields[field]);
          if (key) local[field] = t(key);
        }
        if (Object.keys(local).length > 0) {
          focusFirst(local);
          setErrors(local);
          setNotice(null);
          return;
        }

        setErrors({});
        setPhase('saving');
        setNotice(null);
        try {
          const response = await fetch(CLI_ENDPOINT, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ revision: snapshot.revision ?? '', fields }),
          });
          const body = await readJson(response);
          if (!mounted.current) return;
          setPhase('idle');
          if (response.ok && body && body.snapshot) {
            applySnapshot(body.snapshot);
            setSteady(false);
            setStaged({});
            setEditing({});
            setExpanded({});
            setErrors({});
            // 只记录服务端给的 `applied`：没有这个键就是"未知"，页面不替它编一个"已生效"。
            setReceipt({ applied: body.applied ?? null });
            setNotice(null);
            return;
          }
          const failure = errorCode(body) ?? `HTTP ${response.status}`;
          if (response.status === 409) {
            // 保留 staged：用户填的东西不能因为别人改了配置就被清空。
            setNotice({ kind: 'conflict', text: t('saveFailedStale'), refresh: true });
            return;
          }
          if (response.status === 422) {
            const returned = body && typeof body.errors === 'object' && body.errors !== null ? body.errors : {};
            const serverErrors = {};
            for (const field of Object.keys(returned)) {
              // 只映射页面可见的两键：隐藏键没有输入框，为一个不存在的字段画红字就是"幽灵字段"。
              if (PAGE_FIELDS.includes(field)) serverErrors[field] = fieldMessage(t, returned[field]);
            }
            if (Object.keys(serverErrors).length > 0) {
              focusFirst(serverErrors);
              setErrors(serverErrors);
              return;
            }
            // 422 却只带回隐藏键的原因（页面根本不发送它们）：原因折进 footer 兜底，
            // 这样"服务端比页面更严"仍然可见，而页面不会造出不可见字段。
            setNotice({ kind: 'failed', text: t('saveFailed', { reason: errorCode(body) ?? 'CLI_CONFIG_INVALID' }) });
            return;
          }
          setNotice({
            kind: 'failed',
            text: t('saveFailed', { reason: failure === 'CLI_CONFIG_UNAVAILABLE' ? t('unavailable.title') : failure }),
          });
        } catch (error) {
          if (!mounted.current) return;
          setPhase('idle');
          setNotice({ kind: 'failed', text: t('saveFailed', { reason: error && error.message ? error.message : t('error.load') }) });
        }
      }

      /* -------------------------------- 渲染 -------------------------------- */

      const snapshot = view.snapshot;
      const entries = (snapshot && snapshot.entries) || {};
      const changed = snapshot ? PAGE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(staged, field) && isChanged(field, staged[field])) : [];
      const dirty = changed.length > 0;

      function statusView() {
        if (view.mode === 'loading' || phase === 'checking') return { tone: 'idle', text: t('status.checking') };
        if (view.mode === 'error') return { tone: 'unavailable', text: t('status.unavailable', { reason: view.reason ?? t('error.load') }) };
        if (!snapshot || snapshot.ready !== true) {
          return { tone: 'missing', text: t('status.missing', { cli: 'dop' }) };
        }
        const text = t('status.ready');
        return { tone: 'ready', text: steady ? `${text} · ${t('status.unchanged')}` : text };
      }

      const status = statusView();

      /** 超时按人类单位展示（字段值仍是毫秒）：20000 → 「20 秒（默认）」，覆盖值 → 「45 秒」。 */
      function timeoutText(field, ms) {
        const value = Number(ms);
        if (!Number.isFinite(value) || value <= 0) return t('field.timeoutMs.default');
        if (originOf(field) !== 'config' && value === 20000) return t('field.timeoutMs.default');
        return value % 1000 === 0
          ? t('field.timeoutMs.seconds', { ms: value, seconds: value / 1000 })
          : t('field.timeoutMs.millis', { ms: value });
      }

      /** 超时行（第二行）：值来自 staged，生效值走 placeholder。 */
      function timeoutField() {
        const field = 'timeoutMs';
        const entry = entries[field] ?? {};
        const stagedValue = Object.prototype.hasOwnProperty.call(staged, field) ? normalize(staged[field]) : '';
        const live = effectiveValue(field, entry);
        return h(TimeoutField, {
          key: 'scalar',
          t,
          field,
          label: t('field.timeoutMs'),
          hint: t('field.timeoutMs.hint'),
          placeholder: timeoutText(field, live),
          value: stagedValue,
          error: errors[field] ?? null,
          locked,
          inputRef: inputRef(field),
          onChange: (next) => onInput(field, next),
          onBlur: () => onBlur(field),
        });
      }

      const children = [
        h('h2', { className: 'fdv-title', key: 'title' }, t('title')),
        h('p', { className: 'fdv-intro', key: 'intro' }, t('intro')),
        h(StatusLine, { key: 'status', t, tone: status.tone, text: status.text }),
      ];

      if (view.mode === 'loading') {
        children.push(h(Skeleton, { key: 'skeleton' }));
        return h('div', { className: 'fdv-root' }, children);
      }

      // 写面缺失（configEditor 未挂载 / profile 无可写条目）：读面照常，字段降级只读（不关页面）。
      const locked = view.mode !== 'form';

      if (view.mode === 'error') {
        children.push(h(UnavailableNote, { key: 'unavailable', t }));
        return h('div', { className: 'fdv-root' }, children);
      }

      children.push(
        h(
          'div',
          { className: 'fdv-cards', key: 'cards' },
          ENTRY_FIELDS.map((field, index) =>
            h(CliEntryField, {
              key: field,
              t,
              field,
              entry: entries[field] ?? {},
              tool: TOOL_OF_FIELD[field],
              staged: Object.prototype.hasOwnProperty.call(staged, field) ? staged[field] : undefined,
              editing: editing[field] === true,
              reset: Object.prototype.hasOwnProperty.call(staged, field) && staged[field] === null,
              expanded: expanded[field] === true,
              error: errors[field] ?? null,
              first: index === 0,
              locked,
              inputRef: inputRef(field),
              onTakeOver: () => takeOver(field),
              onReset: () => resetToAuto(field),
              onToggle: () => toggleCandidates(field),
              onInput: (next) => onInput(field, next),
              onBlur: () => onBlur(field),
            }),
          ),
        ),
      );

      // 第二行：超时（单行 .fdv-scalar）。页面只有两行一列，行间只有一条 .5px 分隔线。
      children.push(timeoutField());

      const noteTone = notice && (notice.kind === 'failed' || notice.kind === 'conflict') ? ' fdv-note-error' : '';
      /** 回执一句：保存态优先，其次才是失败原因；不再为「应用」单开一行假状态。 */
      const receiptSentence = (() => {
        if (notice) return notice.text;
        if (phase === 'saving') return t('saving');
        if (dirty) return t('receipt.unsaved');
        if (!receipt) return '';
        const applied = receipt.applied;
        if (applied === null || typeof applied !== 'object') return t('receipt.appliedUnknown');
        // 三态：已生效 / 合法清除（本机已无入口，不再说「已生效」）/ 其余按原因。
        if (applied.ok === true) return applied.active === false ? t('receipt.cleared') : t('receipt.saved');
        // 「宿主注入、无法确认」是未知，不是未生效：DESIGN §6 第四态，不复用 notApplied。
        if (applied.reason === 'CLI_APPLY_UNVERIFIED') {
          return t('receipt.unverified', { reason: t('receipt.reason.apply-unverified') });
        }
        // 原因码只给排查用，不上屏：页面只说人能看懂的那部分。
        const plain = applied.reason === 'CLI_REBUILD_FAILED'
          ? t('receipt.reason.rebuildFailed')
          : applied.reason === 'CLI_CONFIG_INVALID'
            ? t('receipt.reason.configInvalid')
            : t('receipt.reason.unknown');
        return t('receipt.notApplied', { reason: plain });
      })();

      children.push(
        locked
          ? h(UnavailableNote, { key: 'unavailable', t })
          : h(
              'div',
              { className: 'fdv-footer', key: 'footer' },
              h(
                'div',
                { className: 'fdv-receipt', key: 'receipt' },
                h(
                  'span',
                  { className: `fdv-note${noteTone}`, role: 'status', 'aria-live': 'polite' },
                  receiptSentence,
                  notice && notice.refresh
                    ? h(
                        'button',
                        { type: 'button', className: 'fdv-link fdv-note-action', onClick: () => void load(true) },
                        t('action.refresh'),
                      )
                    : null,
                ),
                h(
                  'span',
                  { className: 'fdv-receipt-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'fdv-link',
                      disabled: phase === 'checking',
                      onClick: () => {
                        if (phase !== 'checking') void load(true);
                      },
                    },
                    phase === 'checking' ? t('action.check.busy') : t('action.check'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'fdv-primary',
                      disabled: !dirty || phase === 'saving',
                      onClick: () => void save(),
                    },
                    phase === 'saving' ? t('saving') : t('save'),
                  ),
                ),
              ),
              h('p', { className: 'fdv-receipt-hint', key: 'saveHint' }, t('receipt.saveHint')),
              h('p', { className: 'fdv-receipt-hint', key: 'checkHint' }, t('receipt.checkHint')),
              checkedAt
                ? h(
                    'p',
                    { className: 'fdv-receipt-hint', key: 'checkResult', role: 'status' },
                    t('receipt.check', {
                      state: `${snapshot && snapshot.ready === true ? t('status.ready') : t('status.missing', { cli: 'dop' })} · ${formatTime(checkedAt)}`,
                    }),
                  )
                : null,
            ),
        h(DevopsCredentialItem, { key: 'credential', t }),
      );

      return h('div', { className: 'fdv-root' }, children);
    }

    /* ------------------------------------------------------------------ *
     * 装配                                                                *
     * ------------------------------------------------------------------ */

    /**
     * 注入一次全局样式（重复挂载复用同一 tag，卸载时移除）。
     *
     * **返回值必须是 disposer 或 null**：`ctx.effect` 的回调只接受
     * 函数 / null / Promise / 可迭代——返回 `<style>` 元素会抛
     * `TypeError: Invalid effect`，让整条 entry 不激活（真实浏览器首挂载必现，
     * 页面报 "web boot: 1 entry did not activate / @heluo/forge-devops: failed"；
     * Node 离线测不到：无 document 走 `return null` 合法分支）。
     * 既有 tag 由别处（同插件重复挂载）创建时不接管，返回 null 即不代其释放。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return null;
      const existing = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
      if (existing) return null;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@heluo/forge-devops';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * 宿主设置页的分区切换能力探测（AC-1）：能探测到才给按钮，探测不到就退回文字指引。
     * 宿主 API 未在真实环境核验（NOT RUN-7），所以只做能力探测，不猜路由、不伪造跳转。
     */
    function sectionNavigatorOf(ctx) {
      const candidates = [];
      try {
        // 两种入口都得在 try 内：Cordis 对未在 `inject` 声明的服务不返回 undefined，
        // 而是直接抛 `cannot get property "settings" without inject`。r16 GUI 装载时
        // `ctx.settings` 那一句曾落在 try 外，异常逃到 apply，整条客户端判 failed，
        // 宿主随即拒绝启动 Web UI（用例外置：test/client-inject.test.mjs）。
        const service = typeof ctx.get === 'function' ? ctx.get('settings') : null;
        if (service && typeof service === 'object') candidates.push(service);
        if (ctx.settings && typeof ctx.settings === 'object') candidates.push(ctx.settings);
      } catch {
        // 探测失败按"没有该能力"处理，不影响分区注册。
      }
      for (const service of candidates) {
        for (const method of NAV_METHODS) {
          if (typeof service[method] === 'function') {
            return (id) => {
              try {
                service[method](id);
              } catch {
                // 导航失败不能把面板打崩：按钮点击是尽力而为。
              }
            };
          }
        }
      }
      return null;
    }

    /**
     * `ctx.slots.register` 返回函数型 disposer（宿主内部是 `ctx.effect` 的返回值）。
     * 只认函数：拿到别的形态多半是宿主契约变了，凭猜测调 `.dispose()` 可能整个插件 fiber 被卸掉。
     */
    function releaseDisposable(handle) {
      if (typeof handle === 'function') handle();
    }

    /** 扩展凭据 HTTP 失败码 → 纯自然语言提示键（不在主界面透出内部枚举码）。 */
    const EXT_CREDENTIAL_FAIL_KEYS = Object.freeze({
      IAM_EXT_CREDENTIAL_INVALID: 'credential.fail.invalid',
      IAM_EXT_TOKEN_INVALID: 'credential.fail.invalid',
      ENTERPRISE_CREDENTIAL_INVALID: 'credential.fail.invalid',
      IAM_NOT_SIGNED_IN: 'credential.fail.notSignedIn',
      PENDING_WRITE: 'credential.fail.pending',
      ENTERPRISE_CREDENTIAL_PENDING: 'credential.fail.pending',
      KEYCHAIN_UNAVAILABLE: 'credential.fail.keychainUnavailable',
      ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE: 'credential.fail.keychainUnavailable',
      OWNER_MISMATCH: 'credential.fail.ownerMismatch',
      ENTERPRISE_CREDENTIAL_OWNER_MISMATCH: 'credential.fail.ownerMismatch',
      IAM_EXT_CREDENTIAL_NOT_FOUND: 'credential.fail.notFound',
    });

    async function requestCredentialJson(url, options) {
      const response = await fetch(url, options);
      const body = await readJsonBody(response);
      return { response, body };
    }

    function devopsCredentialFailKey(code) {
      if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(EXT_CREDENTIAL_FAIL_KEYS, code)) {
        return EXT_CREDENTIAL_FAIL_KEYS[code];
      }
      return 'credential.fail.generic';
    }

    /**
     * 内置在 DevopsSection 诊断面板中的 DevOps 独立凭据托管卡片。
     * 常态不主动读取或要求录入 Token；仅在用户主动覆盖或存在跨账号冲突/安全存储异常时展开。
     */
    function DevopsCredentialItem(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key;
      const sessionReady = props?.sessionReady;
      const [statusView, setStatusView] = React.useState({ mode: 'loading', entry: null });
      const [openForm, setOpenForm] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [busyAction, setBusyAction] = React.useState(null);
      const [feedback, setFeedback] = React.useState(null);
      const mounted = React.useRef(true);
      const reqSeq = React.useRef(0);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      async function reload() {
        const seq = ++reqSeq.current;
        try {
          const { response, body } = await requestCredentialJson(IAM_EXT_CREDENTIALS_ENDPOINT, {
            headers: IAM_READ_HEADERS,
            cache: 'no-store',
          });
          if (!mounted.current || reqSeq.current !== seq) return;
          if (!response.ok) {
            const code = errorCode(body);
            if ((response.status === 404 || response.status === 501) && !code) {
              setStatusView({ mode: 'ready', entry: { extensionId: 'devops', state: 'IAM_UNAVAILABLE', envHitNames: [] } });
              return;
            }
            if (code === 'IAM_NOT_SIGNED_IN') {
              setStatusView({ mode: 'ready', entry: { extensionId: 'devops', state: 'IAM_NOT_SIGNED_IN', envHitNames: [] } });
              return;
            }
            setStatusView({ mode: 'failed', entry: null });
            setFeedback({ tone: 'warn', text: t(devopsCredentialFailKey(code)) });
            return;
          }
          const list = Array.isArray(body?.credentials) ? body.credentials : [];
          const found = list.find((item) => item && item.extensionId === 'devops') ?? null;
          setStatusView({ mode: 'ready', entry: found });
        } catch {
          if (!mounted.current || reqSeq.current !== seq) return;
          setStatusView({ mode: 'failed', entry: null });
        }
      }

      React.useEffect(() => {
        void reload();
      }, [sessionReady]);

      async function saveToken() {
        const trimmed = normalize(draft);
        if (!trimmed) {
          setFeedback({ tone: 'warn', text: t('credential.fail.invalid') });
          return;
        }
        const seq = ++reqSeq.current;
        setBusyAction('saving');
        setFeedback(null);
        try {
          const { response, body } = await requestCredentialJson(IAM_EXT_CREDENTIAL_ENDPOINT, {
            method: 'PUT',
            headers: IAM_MUTATION_HEADERS,
            body: JSON.stringify({ token: trimmed }),
          });
          if (!mounted.current || reqSeq.current !== seq) return;
          setBusyAction(null);
          if (!response.ok) {
            setFeedback({ tone: 'warn', text: t(devopsCredentialFailKey(errorCode(body))) });
            return;
          }
          const nextEntry = body?.credential
            ?? (Array.isArray(body?.credentials) ? body.credentials.find((item) => item && item.extensionId === 'devops') : null)
            ?? { extensionId: 'devops', state: 'HOSTED_ACTIVE', hosted: true, envHitNames: [] };
          setStatusView({ mode: 'ready', entry: nextEntry });
          setDraft('');
          setOpenForm(false);
          setFeedback({ tone: 'ok', text: t('credential.notice.saved') });
        } catch {
          if (!mounted.current || reqSeq.current !== seq) return;
          setBusyAction(null);
          setFeedback({ tone: 'warn', text: t('credential.fail.generic') });
        }
      }

      async function clearToken() {
        const seq = ++reqSeq.current;
        setBusyAction('clearing');
        setFeedback(null);
        try {
          const { response, body } = await requestCredentialJson(IAM_EXT_CREDENTIAL_ENDPOINT, {
            method: 'DELETE',
            headers: IAM_MUTATION_HEADERS,
          });
          if (!mounted.current || reqSeq.current !== seq) return;
          setBusyAction(null);
          if (!response.ok) {
            setFeedback({ tone: 'warn', text: t(devopsCredentialFailKey(errorCode(body))) });
            return;
          }
          const nextEntry = body?.credential
            ?? (Array.isArray(body?.credentials) ? body.credentials.find((item) => item && item.extensionId === 'devops') : null)
            ?? { extensionId: 'devops', state: 'UNSET_NO_HOSTED', hosted: false, envHitNames: [] };
          setStatusView({ mode: 'ready', entry: nextEntry });
          setDraft('');
          setOpenForm(false);
          setFeedback({ tone: 'ok', text: t('credential.notice.cleared') });
        } catch {
          if (!mounted.current || reqSeq.current !== seq) return;
          setBusyAction(null);
          setFeedback({ tone: 'warn', text: t('credential.fail.generic') });
        }
      }

      const entry = statusView.entry;
      const state = entry?.state ?? (statusView.mode === 'loading' ? 'LOADING' : statusView.mode === 'failed' ? 'LOAD_FAILED' : 'UNSET_NO_HOSTED');
      const isPending = busyAction !== null || state === 'PENDING_WRITE';
      const isHosted = state === 'HOSTED_ACTIVE';
      const isMismatch = state === 'OWNER_MISMATCH';
      const isSignedOut = state === 'IAM_NOT_SIGNED_IN';
      const isUnavailable = state === 'IAM_UNAVAILABLE';
      const isKeychainUnavailable = state === 'KEYCHAIN_UNAVAILABLE';
      const envHitNames = Array.isArray(entry?.envHitNames) ? entry.envHitNames : [];

      const statusInfo = (() => {
        if (statusView.mode === 'loading') return { tone: 'quiet', badge: null, text: t('credential.state.loading') };
        if (statusView.mode === 'failed') return { tone: 'warn', badge: null, text: t('credential.state.loadFailed') };
        if (isHosted) return { tone: 'ok', badge: t('credential.state.hosted'), text: t('credential.state.hosted') };
        if (isMismatch) return { tone: 'warn', badge: t('credential.state.mismatchTag'), text: t('credential.state.mismatch') };
        if (isSignedOut) return { tone: 'quiet', badge: null, text: t('credential.state.signedOut') };
        if (isUnavailable) return { tone: 'quiet', badge: null, text: t('credential.state.unavailable') };
        if (isKeychainUnavailable) return { tone: 'warn', badge: t('credential.state.keychainTag'), text: t('credential.state.keychainUnavailable') };
        if (state === 'PENDING_WRITE') return { tone: 'quiet', badge: null, text: t('credential.state.pending') };
        return { tone: 'quiet', badge: null, text: t('credential.state.follow') };
      })();

      const actions = [];
      if (!isSignedOut && !isUnavailable && !openForm && statusView.mode === 'ready') {
        if (state === 'PENDING_WRITE') {
          actions.push(
            h('button', { type: 'button', className: 'fdv-link', key: 'retry', disabled: busyAction !== null, onClick: () => void reload() }, t('credential.action.retry')),
          );
        } else if (isHosted) {
          actions.push(
            h('button', { type: 'button', className: 'fdv-link', key: 'replace', disabled: isPending, onClick: () => { setOpenForm(true); setFeedback(null); } }, t('credential.action.replace')),
            h('button', { type: 'button', className: 'fdv-link', key: 'reset', disabled: isPending, onClick: () => void clearToken() }, busyAction === 'clearing' ? t('credential.action.clearing') : t('credential.action.reset')),
          );
        } else if (isMismatch) {
          actions.push(
            h('button', { type: 'button', className: 'fdv-link', key: 'clearOld', disabled: isPending, onClick: () => void clearToken() }, busyAction === 'clearing' ? t('credential.action.clearing') : t('credential.action.clearOld')),
            h('button', { type: 'button', className: 'fdv-link', key: 'resetAccount', disabled: isPending, onClick: () => { setOpenForm(true); setFeedback(null); } }, t('credential.action.resetAccount')),
          );
        } else if (isKeychainUnavailable) {
          actions.push(
            h('button', { type: 'button', className: 'fdv-link', key: 'retry', disabled: isPending, onClick: () => void reload() }, t('credential.action.retry')),
          );
        } else if (state !== 'PENDING_WRITE') {
          actions.push(
            h('button', { type: 'button', className: 'fdv-link', key: 'specify', disabled: isPending, onClick: () => { setOpenForm(true); setFeedback(null); } }, t('credential.action.specify')),
          );
        }
      } else if (statusView.mode === 'failed' && !openForm) {
        actions.push(
          h('button', { type: 'button', className: 'fdv-link', key: 'retry', disabled: isPending, onClick: () => void reload() }, t('credential.action.retry')),
        );
      }

      return h(
        'div',
        { className: 'fdv-cred', 'data-extension-id': 'devops', 'data-credential-state': state },
        h(
          'div',
          { className: 'fdv-cred-head' },
          h(
            'div',
            { className: 'fdv-cred-main' },
            h('span', { className: 'fdv-cred-title' }, t('credential.title')),
            statusInfo.badge ? h(Tag, { tone: statusInfo.tone }, statusInfo.badge) : null,
            !statusInfo.badge ? h('span', { className: 'fdv-cred-status' }, statusInfo.text) : null,
          ),
          actions.length > 0 ? h('div', { className: 'fdv-cred-actions' }, actions) : null,
        ),
        (isMismatch || isKeychainUnavailable)
          ? h(
              'div',
              { className: 'fdv-cred-alert', role: 'alert' },
              h('span', null, statusInfo.text),
            )
          : null,
        openForm
          ? h(
              'div',
              { className: 'fdv-cred-form' },
              h('label', { className: 'fdv-hint', htmlFor: 'fdv-cred-input' }, t('credential.input.label')),
              h('input', {
                id: 'fdv-cred-input',
                className: 'fdv-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                disabled: isPending,
                value: draft,
                placeholder: t('credential.input.placeholder'),
                'aria-label': t('credential.input.label'),
                onChange: (event) => {
                  setDraft(event.target.value);
                  setFeedback(null);
                },
              }),
              h('p', { className: 'fdv-hint' }, t('credential.input.hint')),
              h(
                'div',
                { className: 'fdv-cred-form-actions' },
                h(
                  'button',
                  { type: 'button', className: 'fdv-primary', disabled: isPending, onClick: () => void saveToken() },
                  busyAction === 'saving' ? t('credential.action.saving') : t('credential.action.save'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fdv-link',
                    disabled: isPending,
                    onClick: () => {
                      setOpenForm(false);
                      setDraft('');
                      setFeedback(null);
                    },
                  },
                  t('credential.action.cancel'),
                ),
              ),
            )
          : null,
        envHitNames.length > 0
          ? h(
              'details',
              { className: 'fdv-cred-details' },
              h('summary', { className: 'fdv-summary' }, t('credential.details.title')),
              h('p', { className: 'fdv-hint' }, t('credential.details.envVars', { names: envHitNames.join(', ') })),
            )
          : null,
        feedback
          ? h(
              'p',
              {
                className: feedback.tone === 'warn' ? 'fdv-note fdv-note-error' : 'fdv-note',
                role: feedback.tone === 'warn' ? 'alert' : 'status',
                'aria-live': 'polite',
              },
              feedback.text,
            )
          : null,
      );
    }

    /** 容器子槽位只放一个 DevOps 条目：就绪检查在上，配置面板在下（设计 §6.3）。 */
    function DevopsEngineeringTab(props) {
      // 顺序：先跨工具就绪总览，再 DevOps 配置；就绪面板在容器里以 embedded 形态渲染，
      // 不重复画容器已给出的标题与页脚（§6.3）。
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(ReadinessSection, { ...props, embedded: true }),
        React.createElement(DevopsSection, props),
      );
    }

    const ENGINEERING_TAB_SLOT = 'heluo.engineering.tab';

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const navigate = sectionNavigatorOf(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-devops: copy');
      ctx.effect(() => ensureStyle(), 'forge-devops: styles');
      // `settings.section` 由父条目声明，冷启动最坏时序下会**晚于**本插件 apply；
      // 直接 `register` 会抛 `slot "settings.section" is not declared ...` 并让分区消失（QA D-2）。
      // 研发组合装了容器时，DevOps 与就绪检查合并成一个容器条目（order 10，设计 §6.3），
      // 不再各占侧栏分区；单独安装单包（ADR-0012）时容器缺席，两个独立分区保持原样。
      //
      // 两个槽位的声明先后不定（容器可能晚于 apply 声明，也可能运行期被禁用而塌陷），
      // 所以用声明标志 + `reconcile()` 收敛：任一标志变化都按当前状态重建挂载，
      // 新挂载成功后才释放旧的，容器塌陷时把独立分区补回来。
      let container = false;
      let section = false;
      /** 当前生效的挂载：`{ kind: 'tab' | 'section', releases: Array<() => void> }`。 */
      let mounted;

      const mountSection = () => {
        const releases = [];
        try {
          releases.push(ctx.slots.register({
            name: 'settings.section',
            id: 'devops',
            order: 60,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t, navigate }),
          }, DevopsSection));
          releases.push(ctx.slots.register({
            name: 'settings.section',
            id: 'devops-readiness',
            order: 29,
            label: () => t('readiness.nav'),
            locale: NS,
            inject: () => ({ t, navigate }),
          }, ReadinessSection));
        } catch (error) {
          // 两笔注册不是事务：第二笔失败时把第一笔撤掉，别留下孤立分区。
          for (const release of releases) releaseDisposable(release);
          throw error;
        }
        return releases;
      };

      const mountTab = () => [
        ctx.slots.register({
          name: ENGINEERING_TAB_SLOT,
          id: 'devops',
          order: 10,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t, navigate }),
        }, DevopsEngineeringTab),
      ];

      const reconcile = () => {
        const wanted = container ? 'tab' : (section ? 'section' : undefined);
        if (wanted === undefined) {
          const previous = mounted;
          mounted = undefined;
          if (previous !== undefined) for (const release of previous.releases) releaseDisposable(release);
          return;
        }
        if (mounted !== undefined && mounted.kind === wanted) return;
        let releases;
        try {
          releases = wanted === 'tab' ? mountTab() : mountSection();
        } catch (error) {
          // 卸载期 `ctx.effect` 已冻结（宿主抛 INACTIVE_EFFECT）：cleanup 里不该再冒泡。
          if (error?.code !== 'INACTIVE_EFFECT') throw error;
          return;
        }
        const previous = mounted;
        mounted = { kind: wanted, releases };
        if (previous !== undefined) for (const release of previous.releases) releaseDisposable(release);
      };

      ctx.effect(
        () => ctx.slots.inject(ENGINEERING_TAB_SLOT, () => {
          container = true;
          reconcile();
          return () => {
            container = false;
            reconcile();
          };
        }),
        'forge-devops: engineering tab',
      );
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => {
          section = true;
          reconcile();
          return () => {
            section = false;
            reconcile();
          };
        }),
        'forge-devops: settings section',
      );
    }

    const inject = ['slots', 'locale'];

    return { apply, inject, DevopsSection, ReadinessSection, DevopsEngineeringTab, DevopsCredentialItem, CliEntryField, StatusLine, CandidateList };
  },
});
