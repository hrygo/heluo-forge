/**
 * @heluo/forge-devops — Web 配置页（settings.section「DevOps 变更流程」）。
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
    /** 写操作的 CSRF 风格预检头，缺头服务端回 400。 */
    const REQUEST_HEADERS = { 'x-forge-devops-request': '1', 'content-type': 'application/json' };
    /** 读也带预检头：契约只对 POST 要求，带上对 GET 无害且免掉两次形态假设。 */
    const READ_HEADERS = { accept: 'application/json', 'x-forge-devops-request': '1' };
    /** 样式标签去重键（重复挂载不产生第二个 style）。 */
    const CSS_TAG_ID = '@heluo/forge-devops/client.css';

    /** 六个配置键（与 CLI_FIELDS 同名同序）。 */
    const CLI_FIELDS = ['dopBin', 'dopEndpoint', 'ghBin', 'ghOwner', 'sourceType', 'timeoutMs'];
    /** 需要「发现」的可执行文件字段：只读展示 + 候选展开 + 手动指定。 */
    const ENTRY_FIELDS = ['dopBin', 'ghBin'];
    /** 文本字段（网格第一行两个 + 超时）。 */
    const TEXT_FIELDS = ['dopEndpoint', 'ghOwner', 'timeoutMs'];
    /** 段控件字段：把非法输入消灭在源头。 */
    const SEGMENT_FIELDS = ['sourceType'];
    const SOURCE_TYPES = ['mock', 'enterprise'];
    /**
     * 与服务端同源的字段规则（服务端另有存在性/可执行判定）。
     * 逐字段的取值边界都要与 `src/runtime-config.mjs` 的规则等值：浏览器半不能 import 服务端模块，
     * 等值关系由 `test/client-shape.test.mjs` 的跨面矩阵用例守着（改任何一侧先红在那里）。
     * ghOwner 上界 39（与 GitHub 一致）：写成 `{0,38}`，少一个字符就退化成"失焦放行、保存才 422"。
     */
    const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
    const WRAPPER_PATTERN = /\.(?:cmd|bat|ps1|com|vbs)$/i;
    /** 路径长度上限：与服务端 `MAX_PATH_LENGTH`（runtime-config.mjs）等值，挡住误粘整段日志。 */
    const MAX_PATH_LENGTH = 4096;
    const TIMEOUT_MIN = 1000;
    const TIMEOUT_MAX = 600000;

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
      headGap: 6,
      inputHeight: 34,
      inputGap: 6,
      hintSize: 12,
      hintLine: 18,
      fieldPadY: 12,
      gridGap: 16,
      trackHeight: 34,
      trackPad: 3,
      segmentHeight: 28,
      segmentPadX: 12,
      footerGapTop: 16,
      buttonHeight: 32,
      separator: 0.5,
      tagHeight: 18,
      tagSize: 11,
      codeSize: 12,
      candidatePadY: 6,
      skeletonHeight: 34,
      skeletonCell: 66,
      narrowWidth: 700,
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
.fdv-head{display:flex;align-items:center;gap:${METRICS.statusGap}px;min-width:0;line-height:${METRICS.labelLine}px}
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
.fdv-grid{display:grid;grid-template-columns:1fr 1fr;column-gap:${METRICS.gridGap}px;row-gap:0}
.fdv-field{box-sizing:border-box;min-width:0;padding:${METRICS.fieldPadY}px 0}
.fdv-label-row{display:flex;align-items:center;gap:${METRICS.statusGap}px;margin:0;min-width:0;line-height:${METRICS.labelLine}px}
.fdv-track{box-sizing:border-box;display:inline-flex;align-items:center;gap:0;height:${METRICS.trackHeight}px;margin-top:${METRICS.headGap}px;padding:${METRICS.trackPad}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover)}
.fdv-segment{box-sizing:border-box;height:${METRICS.segmentHeight}px;padding:0 ${METRICS.segmentPadX}px;border:0 none;border-radius:${METRICS.radiusSm};background:none;cursor:pointer;font-family:inherit;font-size:${METRICS.hintSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.segmentHeight}px;color:var(--dsw-alias-label-secondary);transition:background-color ${METRICS.fast}ms ${METRICS.ease},color ${METRICS.fast}ms ${METRICS.ease}}
.fdv-segment:hover{color:var(--dsw-alias-label-primary)}
.fdv-segment-on{background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 ${METRICS.separator}px var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.fdv-segment:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.fdv-footer{display:flex;align-items:center;gap:${METRICS.statusGap}px;padding-top:${METRICS.footerGapTop}px}
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
.fdv-skeleton{display:flex;flex-direction:column;gap:${METRICS.inputGap}px;margin-top:${METRICS.groupGapTop}px}
.fdv-skeleton-bar{height:${METRICS.skeletonHeight}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe ${METRICS.breathe}ms ease-in-out infinite}
.fdv-skeleton-grid{display:grid;grid-template-columns:1fr 1fr;column-gap:${METRICS.gridGap}px;margin-top:${METRICS.statusGap}px}
.fdv-skeleton-cell{height:${METRICS.skeletonCell}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);animation:fdv-breathe ${METRICS.breathe}ms ease-in-out infinite}
@keyframes fdv-breathe{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes fdv-reveal{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@container (max-width:519px){.fdv-grid,.fdv-skeleton-grid{grid-template-columns:1fr}.fdv-candidates{max-height:176px;overflow-y:auto}}
@media (max-width:${METRICS.narrowWidth}px){.fdv-grid,.fdv-skeleton-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.fdv-skeleton-bar,.fdv-skeleton-cell{animation:none}.fdv-candidates{animation:none}.fdv-caret,.fdv-dot,.fdv-input,.fdv-segment,.fdv-primary,.fdv-link{transition:none}}
`;

    /* ------------------------------------------------------------------ *
     * 双语字典（zh 为准，en 同键镜像；hint 里不出现环境变量名）            *
     * ------------------------------------------------------------------ */

    const zh = {
      nav: 'DevOps 变更流程',
      title: 'DevOps 变更流程',
      intro: '插件会自己找 dop 与 gh；只有找不到时才需要你指定位置。',
      'status.ready': '只读面 ready · {summary}',
      'status.summary': 'dop {dop} · gh {gh}',
      'status.checking': '正在检测命令行位置',
      'status.unchanged': '位置未变',
      'status.missing': '未找到 {cli} · 已查 PATH、候选目录、环境变量',
      'status.unavailable': '只读面不可用 · {reason}',
      'action.rediscover': '重新自动发现',
      'action.rediscover.busy': '检测中…',
      'action.takeOver': '改为手动指定',
      'action.reset': '重置为自动发现',
      'action.refresh': '刷新',
      'entry.dop': 'dop 可执行文件',
      'entry.gh': 'gh 可执行文件',
      'entry.placeholder': '粘贴 {tool} 的完整路径',
      'entry.placeholder.reset': '保存后自动发现',
      'entry.hint.discovered': '自动发现命中 · 另有 {n} 个候选',
      'entry.hint.discovered.single': '自动发现命中',
      'entry.hint.env': '来自环境变量 · 在此保存将覆盖它',
      'entry.hint.config': '已手动指定 · 清空即回落自动发现',
      'entry.hint.missing': '未找到 · 已查 PATH、候选目录、环境变量',
      'entry.hint.help': '在资源管理器里右键 dop.exe →「复制文件地址」，粘贴到这里',
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
      'field.dopEndpoint': 'dop 服务地址',
      'field.dopEndpoint.hint': 'http 或 https 地址，不含凭据；留空则不配置',
      'field.ghOwner': 'gh 组织 / 用户',
      'field.ghOwner.hint': '1–39 个字母、数字或连字符，首字符不能是连字符',
      'field.sourceType': '事实来源',
      'field.sourceType.hint': 'mock = 本地模拟，enterprise = 企业实测；默认 mock',
      'field.timeoutMs': '超时（毫秒）',
      'field.timeoutMs.hint': '1000–600000，默认 20000',
      'section.commandline': '命令行入口',
      'section.connection': '连接与身份',
      'error.notFound': '找不到这个文件',
      'error.wrapperScript': '.cmd / .bat 包装脚本不能直接执行，请指向 .exe',
      'error.pathLength': '路径太长（上限 4096 个字符），请确认没有粘进整段日志',
      'error.endpoint': '需要 http 或 https 地址，且地址里不能带用户名密码',
      'error.owner': '只能是 1–39 个字母、数字和连字符，且不能以连字符开头',
      'error.timeout': '请输入 1000–600000 之间的整数（毫秒）',
      'error.source': '事实来源只能是 mock 或 enterprise',
      'error.load': '无法读取命令行位置',
      load: '正在读取命令行位置',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      'saveFailed': '保存失败：{reason}',
      saveFailedStale: '配置已被其它窗口改动 · 刷新后重试',
      'unavailable.title': '这里暂时不能保存',
      'unavailable.body': '当前 profile 没有挂载配置面（settings / config-editor）。',
      'unavailable.envHint': '可以改用环境变量：',
      'unavailable.envDop': 'FORGE_DEVOPS_DOP_BIN  dop 可执行文件',
      'unavailable.envGh': 'FORGE_DEVOPS_GH_BIN  gh 可执行文件',
      'unavailable.readme': '详见 packages/forge-devops/README.md',
    };

    const en = {
      nav: 'DevOps change flow',
      title: 'DevOps change flow',
      intro: 'The plugin locates dop and gh by itself; you only point at a path when it fails.',
      'status.ready': 'Reader ready · {summary}',
      'status.summary': 'dop {dop} · gh {gh}',
      'status.checking': 'Detecting command-line locations',
      'status.unchanged': 'locations unchanged',
      'status.missing': '{cli} not found · searched PATH, candidate folders, environment',
      'status.unavailable': 'Reader unavailable · {reason}',
      'action.rediscover': 'Rediscover',
      'action.rediscover.busy': 'Detecting…',
      'action.takeOver': 'Set manually',
      'action.reset': 'Reset to autodiscovery',
      'action.refresh': 'Refresh',
      'entry.dop': 'dop executable',
      'entry.gh': 'gh executable',
      'entry.placeholder': 'Paste the full path to {tool}',
      'entry.placeholder.reset': 'Resolved on save',
      'entry.hint.discovered': 'Found automatically · {n} more candidate',
      'entry.hint.discovered.single': 'Found automatically',
      'entry.hint.env': 'From environment · saving here overrides it',
      'entry.hint.config': 'Set manually · clear it to fall back to autodiscovery',
      'entry.hint.missing': 'Not found · searched PATH, candidate folders, environment',
      'entry.hint.help': 'Right-click dop.exe in Explorer → "Copy as path", then paste it here',
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
      'field.dopEndpoint': 'dop service endpoint',
      'field.dopEndpoint.hint': 'http or https, no credentials; leave empty to skip',
      'field.ghOwner': 'gh owner',
      'field.ghOwner.hint': '1–39 letters, digits or dashes; must not start with a dash',
      'field.sourceType': 'Fact source',
      'field.sourceType.hint': 'mock = local simulation, enterprise = measured; default mock',
      'field.timeoutMs': 'Timeout (ms)',
      'field.timeoutMs.hint': '1000–600000, default 20000',
      'section.commandline': 'Command-line entries',
      'section.connection': 'Connection and identity',
      'error.notFound': 'That file does not exist',
      'error.wrapperScript': '.cmd / .bat wrappers cannot be executed; point at the .exe',
      'error.pathLength': 'Path is too long (4096 chars max); check you did not paste a log block',
      'error.endpoint': 'Needs an http or https URL without credentials',
      'error.owner': 'Use 1–39 letters, digits or dashes; no leading dash',
      'error.timeout': 'Enter an integer between 1000 and 600000 (ms)',
      'error.source': 'Fact source must be mock or enterprise',
      'error.load': 'Cannot read command-line locations',
      load: 'Reading command-line locations',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      'saveFailed': 'Save failed: {reason}',
      saveFailedStale: 'Changed in another window · refresh and retry',
      'unavailable.title': 'Saving is unavailable here',
      'unavailable.body': 'This profile mounts no configuration surface (settings / config-editor).',
      'unavailable.envHint': 'Environment variables still work:',
      'unavailable.envDop': 'FORGE_DEVOPS_DOP_BIN  dop executable',
      'unavailable.envGh': 'FORGE_DEVOPS_GH_BIN  gh executable',
      'unavailable.readme': 'See packages/forge-devops/README.md',
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
     * 客户端字段校验：只做**格式**判定，与服务端同一套语义的子集。
     * 存在性、是否目录、是否可执行由服务端在保存时判定（422 逐字段返回）。
     * @returns {string|null} i18n 键；合法返回 null。空值 = 清除该层，恒合法。
     */
    function validateField(field, raw) {
      const value = normalize(raw);
      if (value === '') return null;
      if (field === 'dopBin' || field === 'ghBin') {
        // 长度先判：服务端保存时同样按 4096 截断（否则用户要等到 422 才知道粘多了）。
        if (value.length > MAX_PATH_LENGTH) return 'error.pathLength';
        return WRAPPER_PATTERN.test(value) ? 'error.wrapperScript' : null;
      }
      if (field === 'dopEndpoint') {
        try {
          const url = new URL(value);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'error.endpoint';
          if (url.username !== '' || url.password !== '') return 'error.endpoint';
        } catch {
          return 'error.endpoint';
        }
        return null;
      }
      if (field === 'ghOwner') return OWNER_PATTERN.test(value) ? null : 'error.owner';
      if (field === 'timeoutMs') {
        const timeout = Number(value);
        return Number.isInteger(timeout) && timeout >= TIMEOUT_MIN && timeout <= TIMEOUT_MAX ? null : 'error.timeout';
      }
      if (field === 'sourceType') return SOURCE_TYPES.includes(value) ? null : 'error.source';
      return null;
    }

    /** 提交值：空串一律转 null（= 清除该层，回落下一层）。 */
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
      return h('span', { className: `fdv-tag fdv-tag-${props.tone ?? 'quiet'}` }, props.text);
    }

    /** 状态行：唯一结论 + 全页唯一全局动作（重新自动发现）。 */
    function StatusLine(props) {
      const { t, tone, text, busy, onRediscover } = props;
      return h(
        'div',
        { className: `fdv-status fdv-status-${tone}` },
        h('span', { className: 'fdv-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fdv-status-text', role: 'status', 'aria-live': 'polite', title: text }, text),
        h(
          'span',
          { className: 'fdv-status-actions' },
          h(
            'button',
            { type: 'button', className: 'fdv-link', onClick: onRediscover, disabled: busy === true },
            busy === true ? t('action.rediscover.busy') : t('action.rediscover'),
          ),
        ),
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
     * 入口字段（dop/gh）：只读展示生效路径，覆盖时才可编辑。
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
      else if (origin === 'missing') hint = editable ? t('entry.hint.help') : t('entry.hint.missing');
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
          h('label', { className: 'fdv-label', htmlFor: `fdv-${field}` }, t(field === 'dopBin' ? 'entry.dop' : 'entry.gh')),
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

    /** 段控件：只有合法取值可选（sourceType），方向键切换 + roving tabindex。 */
    function SegmentedField(props) {
      const { t, field, label, hint, options, value, error, locked, inputRef, onChange } = props;
      const selected = options.includes(value) ? value : options[0];

      function step(event, position) {
        const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (delta === 0) return;
        event.preventDefault();
        onChange(options[(position + delta + options.length) % options.length]);
      }

      return h(
        'div',
        { className: 'fdv-field' },
        h('div', { className: 'fdv-label-row' }, h('span', { className: 'fdv-label' }, label)),
        h(
          'div',
          { className: 'fdv-track', role: 'radiogroup', 'aria-label': label, onKeyDown: (event) => step(event, options.indexOf(selected)) },
          options.map((option) =>
            h(
              'button',
              {
                key: option,
                type: 'button',
                role: 'radio',
                'aria-checked': option === selected,
                tabIndex: option === selected ? 0 : -1,
                disabled: locked === true,
                className: `fdv-segment${option === selected ? ' fdv-segment-on' : ''}`,
                ref: option === selected ? inputRef : undefined,
                onClick: () => onChange(option),
                onKeyDown: (event) => step(event, options.indexOf(option)),
              },
              option,
            ),
          ),
        ),
        h(FieldFoot, { id: `fdv-${field}-foot`, error, hint }),
      );
    }

    /** 文本字段（endpoint / owner / timeout）：值来自 staged，占位显示当前生效值。 */
    function TextField(props) {
      const { t, field, label, hint, placeholder, value, error, locked, inputRef, onChange, onBlur } = props;
      const id = `fdv-${field}`;
      const readOnly = locked === true;
      // 降级（写面缺失）时输入框只读但**可聚焦**：把生效值镜像进 value 才能选中复制。
      // 正常态则只放用户暂存值、生效值走 placeholder——否则「没改过」的生效值会被算成 dirty。
      const shown = readOnly ? value || placeholder || '' : value;
      return h(
        'div',
        { className: 'fdv-field' },
        h('label', { className: 'fdv-label-row', htmlFor: id }, h('span', { className: 'fdv-label' }, label)),
        h('input', {
          id,
          className: 'fdv-input',
          type: 'text',
          inputMode: field === 'timeoutMs' ? 'numeric' : undefined,
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

    /** 首次加载骨架：入口区两条输入高度的呼吸条 + 网格占位，避免页面跳动。 */
    function Skeleton() {
      return h(
        'div',
        { className: 'fdv-skeleton', 'aria-hidden': 'true' },
        h('div', { className: 'fdv-skeleton-bar' }),
        h('div', { className: 'fdv-skeleton-bar' }),
        h('div', { className: 'fdv-skeleton-grid' }, [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'fdv-skeleton-cell' }))),
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
        h('code', { className: 'fdv-unavailable-env' }, t('unavailable.envGh')),
        h('p', { className: 'fdv-unavailable-body' }, t('unavailable.readme')),
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

      function focusFirst(map) {
        for (const field of CLI_FIELDS) {
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
          const response = await fetch(refresh ? `${CLI_ENDPOINT}?refresh=1` : CLI_ENDPOINT, {
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
          gh: normalize(snapshot.entries?.ghBin?.path),
        };
        const unchanged = refresh && paths.current !== null && paths.current.dop === next.dop && paths.current.gh === next.gh;
        paths.current = next;
        if (!mounted.current) return;
        applySnapshot(snapshot);
        setSteady(refresh && unchanged);
        setNotice(null);
      }

      function takeOver(field) {
        // 预填当前生效值（可能是环境变量或发现命中），让用户从真实值改，而不是从空白猜。
        const current = effectiveValue(field, snapshotRef.current?.entries?.[field]);
        setStaged((prev) => ({ ...prev, [field]: current }));
        setEditing((prev) => ({ ...prev, [field]: true }));
        setErrors((prev) => omit(prev, field));
        setNotice(null);
      }

      function resetToAuto(field) {
        setStaged((prev) => ({ ...prev, [field]: null }));
        setEditing((prev) => ({ ...prev, [field]: false }));
        setErrors((prev) => omit(prev, field));
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

      /** 保存：只提交真正变化的键；空值转 null（= 清除该层，回落下一层）。 */
      async function save() {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const fields = {};
        for (const field of CLI_FIELDS) {
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
            setNotice({ kind: 'saved', text: t('saved') });
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
              if (CLI_FIELDS.includes(field)) serverErrors[field] = fieldMessage(t, returned[field]);
            }
            if (Object.keys(serverErrors).length > 0) {
              focusFirst(serverErrors);
              setErrors(serverErrors);
              return;
            }
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
      const changed = snapshot ? CLI_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(staged, field) && isChanged(field, staged[field])) : [];
      const dirty = changed.length > 0;

      function statusView() {
        if (view.mode === 'loading' || phase === 'checking') return { tone: 'idle', text: t('status.checking') };
        if (view.mode === 'error') return { tone: 'unavailable', text: t('status.unavailable', { reason: view.reason ?? t('error.load') }) };
        if (!snapshot || snapshot.ready !== true) {
          const missing = originOf('dopBin') === 'missing' ? 'dop' : originOf('ghBin') === 'missing' ? 'gh' : 'dop';
          return { tone: 'missing', text: t('status.missing', { cli: missing }) };
        }
        const summary = t('status.summary', { dop: t(`origin.${originOf('dopBin')}`), gh: t(`origin.${originOf('ghBin')}`) });
        const text = t('status.ready', { summary });
        return { tone: 'ready', text: steady ? `${text} · ${t('status.unchanged')}` : text };
      }

      const status = statusView();

      function textField(field) {
        const entry = entries[field] ?? {};
        const stagedValue = Object.prototype.hasOwnProperty.call(staged, field) ? normalize(staged[field]) : '';
        const live = effectiveValue(field, entry);
        const placeholder = field === 'timeoutMs' ? live || '20000' : live;
        return h(TextField, {
          key: field,
          t,
          field,
          label: t(`field.${field}`),
          hint: t(`field.${field}.hint`),
          placeholder,
          value: stagedValue,
          error: errors[field] ?? null,
          locked,
          inputRef: inputRef(field),
          onChange: (next) => onInput(field, next),
          onBlur: () => onBlur(field),
        });
      }

      function segmentField(field) {
        const entry = entries[field] ?? {};
        const stagedValue = Object.prototype.hasOwnProperty.call(staged, field) ? normalize(staged[field]) : '';
        return h(SegmentedField, {
          key: field,
          t,
          field,
          label: t(`field.${field}`),
          hint: t(`field.${field}.hint`),
          options: SOURCE_TYPES,
          value: stagedValue || effectiveValue(field, entry) || SOURCE_TYPES[0],
          error: errors[field] ?? null,
          locked,
          inputRef: inputRef(field),
          onChange: (next) => onInput(field, next),
        });
      }

      const children = [
        h('h2', { className: 'fdv-title', key: 'title' }, t('title')),
        h('p', { className: 'fdv-intro', key: 'intro' }, t('intro')),
        h(StatusLine, {
          key: 'status',
          t,
          tone: status.tone,
          text: status.text,
          busy: phase === 'checking',
          onRediscover: () => {
            if (phase !== 'checking') void load(true);
          },
        }),
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

      children.push(h('div', { className: 'fdv-group', key: 'group-entries' }, t('section.commandline')));
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
              tool: field === 'dopBin' ? 'dop.exe' : 'gh.exe',
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

      children.push(h('div', { className: 'fdv-group', key: 'group-connection' }, t('section.connection')));
      children.push(
        h(
          'div',
          { className: 'fdv-grid', key: 'grid' },
          [textField('dopEndpoint'), textField('ghOwner'), segmentField('sourceType'), textField('timeoutMs')],
        ),
      );

      const noteTone = notice && (notice.kind === 'failed' || notice.kind === 'conflict') ? ' fdv-note-error' : '';
      children.push(
        locked
          ? h(UnavailableNote, { key: 'unavailable', t })
          : h(
              'div',
              { className: 'fdv-footer', key: 'footer' },
              h(
                'span',
                { className: `fdv-note${noteTone}`, role: 'status', 'aria-live': 'polite' },
                notice ? notice.text : '',
                notice && notice.refresh
                  ? h(
                      'button',
                      { type: 'button', className: 'fdv-link fdv-note-action', onClick: () => void load(true) },
                      t('action.refresh'),
                    )
                  : null,
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

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-devops: copy');
      ctx.effect(() => ensureStyle(), 'forge-devops: styles');
      // `settings.section` 由父条目（settings 壳 → settings-general 的 `slots.inject` 回调）声明，
      // 冷启动最坏时序下会**晚于**本插件 apply。直接 `register` 会抛
      // `slot "settings.section" is not declared (a parent entry's children table must declare it)`
      // 并让整个分区消失（QA D-2）；宿主内五个设置类插件与 `forge-iam/client.js`
      // 一律用 `slots.inject(<槽位>, () => register(...))` 等声明，这里同法——声明后才注册，
      // 声明已存在时立即注册，卸载时两者都随 effect 释放。
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'devops',
                order: 60,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ t }),
              },
              DevopsSection,
            ),
          ),
        'forge-devops: settings section',
      );
    }

    const inject = ['slots', 'locale'];

    return { apply, inject, DevopsSection, CliEntryField, SegmentedField, StatusLine, CandidateList };
  },
});
