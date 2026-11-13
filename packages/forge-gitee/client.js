/**
 * Gitee 设置分区（r17 / DESIGN §5）。
 *
 * 这一页只回答一个问题：**本机和企业分发有什么不同**。
 *   1. **一行一个动作**：行卡给「值 + 一个动作」，三层来源不再摊成四列表格。
 *   2. **只有两个键可写**：`cliPath`、`timeoutMs`；`host`、`authEnv`、`persistentToken`
 *      由企业分发或运行期决定，结构上就不含值（AC-5/AC-12）。
 *   3. **保存 ≠ 应用**：两个结论分开显示，互不覆盖（AC-8）。
 *
 * 与本机公共值相同的键显示「沿用公共值」，不铺一排「未配置」。
 *
 * 这里不推导配置：`origin`、`value`、`inherited`、`override` 全部来自服务端快照。页面自己再合并一次
 * 就等于有了第二个真源，一旦两边口径漂移，用户看到的就是"页面说生效、运行期没生效"。
 *
 * 模块外壳与 `@heluo/forge-devops/client.js` 同形（`__ModuleLoader__.load` + `require('react')`）：
 * 浏览器半不读 package.json，也不 import 服务端源码。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-gitee',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'gitee';
    const CLI_ENDPOINT = '/api/forge-gitee/config';
    /** 与 `src/http.mjs` 的 `GITEE_REQUEST_HEADER` 逐字一致（`tests/ui-contract.test.mjs` 守这条）。 */
    const REQUEST_HEADER = 'x-forge-gitee-request';
    const REQUEST_HEADERS = { [REQUEST_HEADER]: '1', 'content-type': 'application/json' };
    const READ_HEADERS = { accept: 'application/json', [REQUEST_HEADER]: '1' };
    const CSS_TAG_ID = '@heluo/forge-gitee/client.css';

    /** 页面字段（与 `src/config-access.mjs` 的 `GITEE_PAGE_FIELDS` 同序）。 */
    const PAGE_FIELDS = ['cliPath', 'timeoutMs'];
    /** 只读字段（host / authEnv / persistentToken）：结构上不含值，页面只显示来源，不参与"本机改动"计数。 */

    /**
     * 几何与节奏：参考内容宽 564px，520px 以下换行。
     * 数字集中在这里，是为了让"宽屏约 78px / 窄屏约 106px"这类验收说法有一个可改的落点。
     */
    const METRICS = Object.freeze({
      titleSize: 16,
      titleLine: 24,
      introSize: 12,
      introLine: 18,
      introGap: 12,
      statusHeight: 30,
      statusGap: 8,
      statusPadX: 12,
      dotSize: 6,
      listGapTop: 14,
      rowPadY: 10,
      labelSize: 13,
      labelWeight: 500,
      labelLine: 20,
      cellSize: 12,
      cellLine: 18,
      inputHeight: 34,
      inputGap: 6,
      hintSize: 12,
      hintLine: 18,
      footerGapTop: 14,
      buttonHeight: 32,
      separator: 0.5,
      tagSize: 11,
      codeSize: 12,
      skeletonRow: 108,
      ease: 'var(--ds-ease-in-out)',
      fast: 100,
      swap: 160,
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
    });

    const CSS = `
.fge-root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-family:inherit;container-type:inline-size}
.fge-title{margin:0;font-size:${METRICS.titleSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.titleLine}px}
.fge-intro{margin:${METRICS.introGap}px 0 0;font-size:${METRICS.introSize}px;line-height:${METRICS.introLine}px;color:var(--dsw-alias-label-secondary)}
.fge-status{box-sizing:border-box;display:flex;align-items:center;gap:${METRICS.statusGap}px;height:${METRICS.statusHeight}px;margin-top:${METRICS.statusGap}px;padding:0 ${METRICS.statusPadX}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fge-dot{flex:none;width:${METRICS.dotSize}px;height:${METRICS.dotSize}px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);transition:background-color ${METRICS.swap}ms ${METRICS.ease}}
.fge-status-ready .fge-dot{background:var(--dsw-static-green-500)}
.fge-status-unset .fge-dot{background:var(--dsw-alias-state-idle-primary)}
.fge-status-unavailable .fge-dot{background:var(--dsw-static-amber-500)}
.fge-status-text{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.fge-status-actions{display:flex;flex:none;align-items:center;gap:${METRICS.statusGap}px}
.fge-cards{display:flex;flex-direction:column;width:100%;margin:${METRICS.listGapTop}px 0 0}
.fge-card{display:flex;align-items:flex-start;gap:12px;padding:${METRICS.rowPadY}px 0;border-top:${METRICS.separator}px solid var(--dsw-alias-border-secondary)}
.fge-card:first-child{border-top:none}
.fge-card-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fge-card-label{font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px}
.fge-card-value{font-size:${METRICS.cellSize}px;line-height:${METRICS.cellLine}px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fge-card-value-local{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.fge-card-actions{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:8px}
.fge-code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:${METRICS.codeSize}px;overflow-wrap:anywhere}
.fge-input{box-sizing:border-box;width:100%;height:${METRICS.inputHeight}px;margin-top:${METRICS.inputGap}px;padding:0 10px;border:${METRICS.separator * 2}px solid var(--dsw-alias-border-secondary);border-radius:${METRICS.radiusSm};background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:${METRICS.cellSize}px;line-height:${METRICS.inputHeight - 4}px}
.fge-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.fge-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.fge-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fge-input[aria-invalid=true]{border-color:var(--dsw-static-red-500)}
.fge-input:disabled{opacity:.6}
.fge-scalar{max-width:220px}
.fge-hint{margin:${METRICS.inputGap}px 0 0;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-tertiary)}
.fge-hint-error{color:var(--dsw-static-red-500)}
.fge-link{display:inline-flex;align-items:center;height:${METRICS.tagSize + 7}px;padding:0;border:none;background:none;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:${METRICS.hintSize}px;line-height:1;cursor:pointer;text-decoration:none}
.fge-link:hover{text-decoration:underline}
.fge-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:${METRICS.radiusSm}}
.fge-link:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;text-decoration:none}
.fge-advanced{margin:${METRICS.listGapTop}px 0 0;padding-top:${METRICS.rowPadY}px;border-top:${METRICS.separator}px solid var(--dsw-alias-border-secondary)}
.fge-advanced-head{font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.fge-advanced-body{display:flex;flex-direction:column;gap:6px;margin:${METRICS.inputGap}px 0 0}
.fge-advanced-row{display:flex;align-items:baseline;gap:12px;font-size:${METRICS.cellSize}px;line-height:${METRICS.cellLine}px}
.fge-advanced-key{flex:none;min-width:96px;color:var(--dsw-alias-label-tertiary)}
.fge-advanced-value{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fge-footer{margin-top:${METRICS.footerGapTop}px;padding-top:${METRICS.rowPadY}px;border-top:${METRICS.separator}px solid var(--dsw-alias-border-secondary);font-size:${METRICS.tagSize}px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fge-receipt{display:flex;flex-direction:column;gap:2px;margin-top:${METRICS.footerGapTop}px;font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px;color:var(--dsw-alias-label-secondary)}
.fge-receipt-line{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.fge-receipt-key{flex:none;min-width:56px;color:var(--dsw-alias-label-tertiary)}
.fge-receipt-error{color:var(--dsw-static-red-500)}
.fge-unavailable{display:flex;flex-direction:column;gap:4px;margin-top:${METRICS.listGapTop}px;padding:12px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);font-size:${METRICS.hintSize}px;line-height:${METRICS.hintLine}px}
.fge-unavailable-title{font-size:${METRICS.labelSize}px;font-weight:${METRICS.labelWeight};line-height:${METRICS.labelLine}px}
.fge-unavailable-body{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fge-skeleton{display:flex;flex-direction:column;gap:8px;margin-top:${METRICS.listGapTop}px}
.fge-skeleton-row{height:${METRICS.skeletonRow}px;border-radius:${METRICS.radiusMd};background:var(--dsw-alias-interactive-bg-hover);animation:fge-breathe 1200ms ${METRICS.ease} infinite alternate}
@keyframes fge-breathe{from{opacity:.55}to{opacity:.9}}
.fge-primary{box-sizing:border-box;height:${METRICS.buttonHeight}px;padding:0 14px;border:${METRICS.separator * 2}px solid transparent;border-radius:${METRICS.radiusSm};background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:${METRICS.cellSize}px;line-height:1;cursor:pointer;transition:opacity ${METRICS.fast}ms ${METRICS.ease}}
.fge-primary:hover:not(:disabled){opacity:.9}
.fge-primary:active:not(:disabled){opacity:.8}
.fge-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fge-primary:disabled{opacity:.5;cursor:default}
@container (max-width:519px){
  .fge-status{height:auto;min-height:${METRICS.statusHeight}px;padding:4px ${METRICS.statusPadX}px;flex-wrap:wrap}
  .fge-status-actions{width:100%;justify-content:flex-start}
  .fge-card{flex-direction:column;gap:6px}
  .fge-card-actions{width:100%}
  .fge-advanced-row{flex-direction:column;gap:0}
}
@media (prefers-reduced-motion:reduce){
  .fge-dot,.fge-primary{transition:none}
  .fge-skeleton-row{animation:none}
}
`;

    const zh = {
      nav: 'Gitee',
      title: 'Gitee',
      intro: '公共参数由企业分发；这一页只改本机差异。',
      'status.ready': '本机已改动 {n} 项',
      'status.unconfigured': '全部沿用公共值与默认值',
      'status.unavailable': '配置面不可用 · {reason}',
      'status.loading': '正在读取配置',
      'field.cliPath': '命令行入口',
      'field.timeoutMs': '命令超时',
      'field.host': '服务地址与凭据',
      'field.authEnv': '凭据变量名',
      'field.persistentToken': '持久化令牌策略',
      'value.inherited': '沿用公共值',
      'value.detected': '已自动找到 {tool}',
      'value.timeoutDefault': '{seconds} 秒（默认）',
      'value.timeout': '{seconds} 秒',
      'value.host': '由企业分发，本页只读',
      'value.empty': '—',
      'card.action.manual': '手动指定',
      'card.action.auto': '改为自动',
      'card.action.edit': '修改',
      'card.action.done': '完成',
      'field.cliPath.hint': '保存后生效；本页不判后缀，运行期失败会说明原因。',
      'field.cliPath.restoreHint': '保存后只删除本键的本机覆盖，其它键不动。',
      'field.timeoutMs.hint': '单位毫秒，1000–600000；清空即回落公共参数或默认值。',
      'placeholder.cliPath': '粘贴 gitee CLI 的完整路径',
      'placeholder.timeoutMs': '20000',
      'advanced.title': '高级 · 通常不用改',
      'advanced.hint': '由运行期决定，不在本页修改',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.refresh': '刷新',
      'save.untouched': '未改动',
      'save.saved': '已保存',
      'save.applied': '运行时已应用',
      'save.notApplied': '已保存；未应用 · {reason}',
      'save.conflict': '保存冲突 · 配置已在别处修改，请刷新后重试（草稿已保留）',
      'save.invalid': '保存被拒 · 请按字段提示修正',
      'save.unavailable': '无法保存 · 本机配置面不可用',
      'save.nochange': '没有需要保存的改动',
      'footer.declaration': '本页只显示本机可见性，不代表业务授权。',
      'unavailable.title': '本机配置面不可用',
      'unavailable.body': '缺少可写的配置条目，页面只能读取。请确认 profile 里存在 {entry} 条目。',
      'unavailable.readonly': '当前 profile 不允许写本机配置，页面只读。',
      'error.load': '读取配置失败 · {reason}',
      'error.retry': '重试',
    };

    const en = {
      nav: 'Gitee',
      title: 'Gitee',
      intro: 'Shared parameters come from the enterprise distribution; this page only changes local differences.',
      'status.ready': '{n} local change(s) on this machine',
      'status.unconfigured': 'Everything inherits shared values and defaults',
      'status.unavailable': 'Configuration surface unavailable · {reason}',
      'status.loading': 'Reading configuration',
      'field.cliPath': 'Command entry',
      'field.timeoutMs': 'Command timeout',
      'field.host': 'Service endpoint and credentials',
      'field.authEnv': 'Credential variable',
      'field.persistentToken': 'Persistent token policy',
      'value.inherited': 'Uses the shared value',
      'value.detected': 'Auto-detected {tool}',
      'value.timeoutDefault': '{seconds} s (default)',
      'value.timeout': '{seconds} s',
      'value.host': 'Distributed by the enterprise; read-only here',
      'value.empty': '—',
      'card.action.manual': 'Specify manually',
      'card.action.auto': 'Use automatic',
      'card.action.edit': 'Change',
      'card.action.done': 'Done',
      'field.cliPath.hint': 'Takes effect after saving; this page does not judge the file suffix — runtime failures explain themselves.',
      'field.cliPath.restoreHint': 'Saving only removes the local override of this key.',
      'field.timeoutMs.hint': 'In milliseconds, 1000–600000; clear it to fall back to the shared value or the default.',
      'placeholder.cliPath': 'Paste the full path of the gitee CLI',
      'placeholder.timeoutMs': '20000',
      'advanced.title': 'Advanced · rarely changed',
      'advanced.hint': 'Decided at runtime; not edited here',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.refresh': 'Refresh',
      'save.untouched': 'No changes',
      'save.saved': 'Saved',
      'save.applied': 'Applied at runtime',
      'save.notApplied': 'Saved; not applied · {reason}',
      'save.conflict': 'Save conflict · the configuration changed elsewhere; refresh and retry (draft kept)',
      'save.invalid': 'Save rejected · fix the fields below',
      'save.unavailable': 'Cannot save · the local configuration surface is unavailable',
      'save.nochange': 'Nothing to save',
      'footer.declaration': 'This page only shows local visibility; it does not represent business authorization.',
      'unavailable.title': 'Local configuration surface unavailable',
      'unavailable.body': 'No writable configuration entry was found, so this page is read-only. Confirm the {entry} entry exists in the profile.',
      'unavailable.readonly': 'The current profile does not allow writing local configuration; this page is read-only.',
      'error.load': 'Failed to read configuration · {reason}',
      'error.retry': 'Retry',
    };

    function normalize(value) {
      return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
    }

    /** 只删 `keys` 里存在的键；一个都没删到时原样返回，避免一次无意义的重渲染。 */
    function withoutKeys(previous, keys) {
      let next = null;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(previous, key)) continue;
        if (next === null) next = { ...previous };
        delete next[key];
      }
      return next ?? previous;
    }

    /** 毫秒 → 秒：`20000` 显示成 `20 秒`，1500 显示成 `1.5 秒`（不四舍五入成整数骗人）。 */
    function secondsOf(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      return Number.isInteger(ms / 1000) ? String(ms / 1000) : (ms / 1000).toFixed(1);
    }

    function StatusLine({ tone, text, actions }) {
      return h(
        'div',
        { className: `fge-status fge-status-${tone}`, role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'fge-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fge-status-text' }, text),
        actions === null || actions === undefined ? null : h('span', { className: 'fge-status-actions' }, actions),
      );
    }

    function SaveReceipt({ t, receipt }) {
      if (receipt === null) return null;
      const lines = [];
      if (receipt.saved !== null) lines.push(['save', receipt.saved]);
      if (receipt.applied !== null) lines.push(['applied', receipt.applied]);
      if (receipt.check !== null && receipt.check !== undefined) lines.push(['check', receipt.check]);
      if (lines.length === 0) return null;
      return h(
        'div',
        { className: 'fge-receipt', role: 'status', 'aria-live': 'polite' },
        lines.map(([key, line]) =>
          h(
            'div',
            { className: 'fge-receipt-line', key },
            h('span', { className: 'fge-receipt-key' }, t(`receipt.${key}`)),
            h('span', { className: line.error === true ? 'fge-receipt-error' : undefined }, line.text),
          ),
        ),
      );
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'fge-skeleton', 'aria-hidden': 'true' },
        h('div', { className: 'fge-skeleton-row' }),
      );
    }

    function UnavailableNote({ t, reason, entryId }) {
      const body = reason === 'GITEE_CONFIG_UNAVAILABLE' ? t('unavailable.body', { entry: entryId }) : t('unavailable.readonly');
      return h(
        'div',
        { className: 'fge-unavailable', role: 'note' },
        h('span', { className: 'fge-unavailable-title' }, t('unavailable.title')),
        h('span', { className: 'fge-unavailable-body' }, body),
      );
    }

    function GiteeSection(props) {
      const t = props?.t ?? ((key) => key);
      const [reading, setReading] = React.useState({ mode: 'loading', snapshot: null, reason: null });
      const [staged, setStaged] = React.useState({});
      const [errors, setErrors] = React.useState({});
      const [saving, setSaving] = React.useState({ state: 'idle', at: null, applied: null });
      const [editing, setEditing] = React.useState({});
      const [notice, setNotice] = React.useState(null);
      const mounted = React.useRef(true);
      const snapshotRef = React.useRef(null);
      const readSeq = React.useRef(0);
      const sessionEpoch = React.useRef(0);

      React.useEffect(
        () => () => {
          mounted.current = false;
        },
        [],
      );

      /**
       * 回填快照并清草稿。传了 `submitted` 就只清这次 POST 提交的键。
       *
       * 保存是异步的：回包到达前用户可能在别的字段里继续写，甚至事件在"禁用"生效前已经入队。
       * 无条件清空 `staged` 会把这些回包之后才有的草稿静默丢掉，看起来就像白输入了一遍。
       */
      function applySnapshot(snapshot, submitted = null) {
        if (!mounted.current) return;
        snapshotRef.current = snapshot;
        const submittedKeys = Array.isArray(submitted) ? submitted : null;
        if (submittedKeys === null) {
          setStaged({});
          setEditing({});
          setErrors({});
        } else {
          setStaged((previous) => withoutKeys(previous, submittedKeys));
          setEditing((previous) => withoutKeys(previous, submittedKeys));
          setErrors((previous) => withoutKeys(previous, submittedKeys));
        }
        const writable = !(snapshot?.writable && snapshot.writable.ok === false);
        setReading({ mode: writable ? 'ready' : 'degraded', snapshot, reason: snapshot?.reason ?? null });
      }

      async function readJson(response) {
        try {
          return await response.json();
        } catch {
          return null;
        }
      }

      // 读快照。Gitee 分区只有"读"和"写"两个动作，没有探测：`?refresh=1` 是
      // 检查动作的专属参数（AC-10），本分区不发。
      const load = React.useCallback(async () => {
        const seq = readSeq.current + 1;
        readSeq.current = seq;
        setReading((previous) => (previous.snapshot === null ? { mode: 'loading', snapshot: null, reason: null } : previous));
        const url = CLI_ENDPOINT;
        try {
          const response = await fetch(url, { method: 'GET', headers: READ_HEADERS, credentials: 'same-origin' });
          const body = await readJson(response);
          if (seq !== readSeq.current) return; // 迟到丢弃：旧响应不覆盖新状态
          if (body === null || typeof body !== 'object') {
            setReading({ mode: 'failed', snapshot: null, reason: 'GITEE_SNAPSHOT_FAILED' });
            return;
          }
          applySnapshot(body);
        } catch (error) {
          if (seq !== readSeq.current) return;
          setReading({ mode: 'failed', snapshot: null, reason: error?.name === 'AbortError' ? 'ENDPOINT_UNREACHABLE' : 'ENDPOINT_UNREACHABLE' });
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const snapshot = reading.snapshot;
      const entryOf = (field) => snapshotRef.current?.entries?.[field] ?? { origin: 'unset' };
      /** "本机有覆盖"= 本机覆盖层里有这个键；`origin` 说的是生效值来自哪一层，不是这件事。 */
      const localOf = (field) => {
        const override = entryOf(field).override;
        return override !== null && override !== undefined && String(override).trim() !== '';
      };

      /** 页面上显示的值：有草稿用草稿，否则用生效值（与"本机覆盖层"无关，显示的是最终值）。 */
      function displayValue(field) {
        if (Object.prototype.hasOwnProperty.call(staged, field)) {
          return staged[field] === null ? '' : String(staged[field]);
        }
        const value = entryOf(field).value;
        return value === null || value === undefined ? '' : String(value);
      }

      /**
       * 行卡上的一句话（DESIGN §5）：只有与本机公共值不同时才给覆盖值；
       * 相同给「沿用公共值」。未改动的字段不会出现一排「未配置」。
       */
      function cardValueOf(field) {
        if (Object.prototype.hasOwnProperty.call(staged, field)) {
          const raw = staged[field];
          if (raw === null || normalize(raw) === '') return { text: t('value.inherited'), own: false };
          if (field === 'timeoutMs') return { text: t('value.timeout', { seconds: secondsOf(raw) }), own: true };
          return { text: String(raw), own: true };
        }
        const entry = entryOf(field);
        const override = entry.override;
        const hasOverride = override !== null && override !== undefined && String(override).trim() !== '';
        if (hasOverride) {
          if (normalize(override) === normalize(entry.inherited)) return { text: t('value.inherited'), own: false };
          if (field === 'timeoutMs') return { text: t('value.timeout', { seconds: secondsOf(override) }), own: true };
          return { text: String(override), own: true };
        }
        if (field === 'timeoutMs' && entry.origin === 'default') {
          return { text: t('value.timeoutDefault', { seconds: secondsOf(entry.value) }), own: false };
        }
        if (field === 'cliPath' && entry.origin === 'default') {
          return { text: t('value.detected', { tool: entry.tool ?? 'gh' }), own: false };
        }
        return { text: t('value.inherited'), own: false };
      }

      function isChanged(field) {
        if (!Object.prototype.hasOwnProperty.call(staged, field)) return false;
        const entry = entryOf(field);
        // 与"本机覆盖层"比，而不是与生效值比：POST 写的就是覆盖层。
        const base = entry.override === null || entry.override === undefined ? '' : normalize(entry.override);
        const next = staged[field] === null ? '' : normalize(staged[field]);
        // 没有覆盖时留空 = 没改动（点了「手动指定」又没填，不该发一次 null 写）。
        if (next === '' && base === '') return false;
        return next !== base;
      }

      function onInput(field, value) {
        setStaged((previous) => ({ ...previous, [field]: value }));
        setErrors((previous) => {
          if (!Object.prototype.hasOwnProperty.call(previous, field)) return previous;
          const next = { ...previous };
          delete next[field];
          return next;
        });
        setNotice(null);
      }

      /** "手动指定"：先把输入框变成可编辑（staged 记空串），用户再填路径。 */
      function takeOver(field) {
        setEditing((previous) => ({ ...previous, [field]: true }));
        if (!Object.prototype.hasOwnProperty.call(staged, field)) {
          setStaged((previous) => ({ ...previous, [field]: '' }));
        }
      }

      /** "改为自动"：提交 `null` = 只删这一个键的本机覆盖。 */
      function restore(field) {
        setEditing((previous) => ({ ...previous, [field]: false }));
        setStaged((previous) => ({ ...previous, [field]: null }));
        setErrors((previous) => {
          const next = { ...previous };
          delete next[field];
          return next;
        });
      }

      async function save() {
        const current = snapshotRef.current;
        if (current === null || saving.state === 'saving') return;
        const fields = {};
        for (const field of PAGE_FIELDS) {
          if (!isChanged(field)) continue;
          const raw = staged[field];
          if (raw === null) {
            fields[field] = null;
            continue;
          }
          const text = normalize(raw);
          if (text === '') {
            fields[field] = null;
            continue;
          }
          fields[field] = field === 'timeoutMs' ? Number(text) : text;
        }
        if (Object.keys(fields).length === 0) {
          setNotice({ key: 'save.nochange', error: false });
          return;
        }
        const epoch = sessionEpoch.current;
        setSaving({ state: 'saving', at: null, applied: null });
        setErrors({});
        try {
          const response = await fetch(CLI_ENDPOINT, {
            method: 'POST',
            headers: REQUEST_HEADERS,
            credentials: 'same-origin',
            body: JSON.stringify({ revision: current.revision, fields }),
          });
          const body = await readJson(response);
          if (epoch !== sessionEpoch.current) return; // 迟到丢弃：换代后不认旧回执
          if (response.status === 409) {
            setSaving({ state: 'conflict', at: new Date().toISOString(), applied: null });
            return; // 保留 staged：草稿不能因为冲突被清掉
          }
          if (response.status === 422) {
            const mapped = {};
            const raw = body?.errors;
            if (raw !== null && typeof raw === 'object') {
              for (const field of PAGE_FIELDS) {
                if (typeof raw[field] === 'string') mapped[field] = raw[field];
              }
            }
            setErrors(mapped);
            setSaving({ state: 'invalid', at: new Date().toISOString(), applied: null });
            return;
          }
          if (response.status === 503) {
            setSaving({ state: 'unavailable', at: new Date().toISOString(), applied: null });
            return;
          }
          if (response.ok !== true || body?.ok !== true) {
            setSaving({ state: 'unavailable', at: new Date().toISOString(), applied: null });
            return;
          }
          if (body.snapshot !== null && typeof body.snapshot === 'object') applySnapshot(body.snapshot, Object.keys(fields));
          const applied = body.applied ?? null;
          setSaving({
            state: applied !== null && applied.ok === false ? 'saved-not-applied' : 'saved',
            at: new Date().toISOString(),
            applied,
          });
        } catch {
          if (epoch !== sessionEpoch.current) return;
          setSaving({ state: 'unavailable', at: new Date().toISOString(), applied: null });
        }
      }

      if (reading.mode === 'loading') {
        return h(
          'div',
          { className: 'fge-root' },
          h('h3', { className: 'fge-title' }, t('title')),
          h('p', { className: 'fge-intro' }, t('intro')),
          h(StatusLine, { tone: 'unset', text: t('status.loading'), actions: null }),
          h(Skeleton),
        );
      }

      if (reading.mode === 'failed') {
        return h(
          'div',
          { className: 'fge-root' },
          h('h3', { className: 'fge-title' }, t('title')),
          h('p', { className: 'fge-intro' }, t('intro')),
          h(StatusLine, {
            tone: 'unavailable',
            text: t('status.unavailable', { reason: reading.reason ?? '' }),
            actions: h(
              'button',
              { type: 'button', className: 'fge-link', onClick: () => load() },
              t('error.retry'),
            ),
          }),
        );
      }

      const writable = !(snapshot?.writable && snapshot.writable.ok === false);
      const localCount = PAGE_FIELDS.filter((field) => localOf(field)).length;
      const statusTone = writable ? (localCount > 0 ? 'ready' : 'unset') : 'unavailable';
      const statusText = writable
        ? localCount > 0
          ? t('status.ready', { n: localCount })
          : t('status.unconfigured')
        : t('status.unavailable', { reason: snapshot?.reason ?? 'GITEE_CONFIG_UNAVAILABLE' });

      const receipt = buildReceipt(t, saving);

      /**
       * 一张行卡：标签、值、右侧动作。
       *
       * 只有两个可编辑键；编辑态才渲染输入框（默认收起，页面不铺一排输入框）。
       * `cliPath` 有本机覆盖时多一个「改为自动」——提交 `null` 只删这一个键。
       */
      function renderFieldCard(field) {
        // 保存期间锁住编辑：否则回包会与"刚敲进去的草稿"抢同一份状态，而回包只认旧快照。
        const locked = !writable || saving.state === 'saving';
        const local = localOf(field);
        const isEditing = editing[field] === true;
        const shown = cardValueOf(field);
        const pendingRestore = Object.prototype.hasOwnProperty.call(staged, field) && staged[field] === null;
        const id = `fge-${field}`;
        const fieldError = errors[field];
        const invalid = typeof fieldError === 'string' && fieldError.length > 0;
        const actions = [];
        if (isEditing) {
          actions.push(
            h(
              'button',
              {
                key: 'done',
                type: 'button',
                className: 'fge-link',
                disabled: locked,
                onClick: () => setEditing((previous) => ({ ...previous, [field]: false })),
              },
              t('card.action.done'),
            ),
          );
        } else {
          actions.push(
            h(
              'button',
              {
                key: 'edit',
                type: 'button',
                className: 'fge-link',
                disabled: locked,
                onClick: () => {
                  if (local || field !== 'cliPath') {
                    setEditing((previous) => ({ ...previous, [field]: true }));
                    return;
                  }
                  takeOver(field);
                },
              },
              field === 'cliPath' ? t('card.action.manual') : t('card.action.edit'),
            ),
          );
        }
        if (field === 'cliPath' && local) {
          actions.push(
            h(
              'button',
              { key: 'auto', type: 'button', className: 'fge-link', disabled: locked, onClick: () => restore(field) },
              t('card.action.auto'),
            ),
          );
        }
        return h(
          'div',
          { className: 'fge-card', key: field },
          h(
            'div',
            { className: 'fge-card-main' },
            h('span', { className: 'fge-card-label' }, t(`field.${field}`)),
            isEditing
              ? h(
                  React.Fragment,
                  null,
                  h('input', {
                    id,
                    className: field === 'timeoutMs' ? 'fge-input fge-scalar' : 'fge-input',
                    type: 'text',
                    inputMode: field === 'timeoutMs' ? 'numeric' : 'text',
                    value: displayValue(field),
                    placeholder: t(`placeholder.${field}`),
                    disabled: locked,
                    spellCheck: false,
                    autoComplete: 'off',
                    'aria-label': t(`field.${field}`),
                    'aria-invalid': invalid ? 'true' : 'false',
                    'aria-describedby': invalid ? `${id}-error` : `${id}-hint`,
                    onChange: (event) => onInput(field, event.target.value),
                  }),
                  invalid
                    ? h('p', { className: 'fge-hint fge-hint-error', id: `${id}-error`, role: 'alert' }, fieldError)
                    : h('p', { className: 'fge-hint', id: `${id}-hint` }, t(`field.${field}.hint`)),
                )
              : h('span', { className: shown.own ? 'fge-card-value fge-card-value-local fge-code' : 'fge-card-value' }, shown.text),
            // 「改为自动」是待保存的动作：只有点了它（草稿 = null）才解释"保存后只删这一个键"。
            field === 'cliPath' && pendingRestore && !isEditing
              ? h('span', { className: 'fge-hint' }, t('field.cliPath.restoreHint'))
              : null,
          ),
          h('div', { className: 'fge-card-actions' }, actions),
        );
      }

      const advancedNames = Array.isArray(entryOf('authEnv').value) ? entryOf('authEnv').value : [];
      const persistentTokenValue = entryOf('persistentToken').value;

      return h(
        'div',
        { className: 'fge-root' },
        h('h3', { className: 'fge-title' }, t('title')),
        h('p', { className: 'fge-intro' }, t('intro')),
        h(StatusLine, {
          tone: statusTone,
          text: statusText,
          actions: h(
            React.Fragment,
            null,
            h('button', { type: 'button', className: 'fge-link', onClick: () => load() }, t('action.refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'fge-primary',
                disabled: !writable || saving.state === 'saving',
                onClick: save,
              },
              saving.state === 'saving' ? t('action.saving') : t('action.save'),
            ),
          ),
        }),
        h(
          'div',
          { className: 'fge-cards' },
          renderFieldCard('cliPath'),
          renderFieldCard('timeoutMs'),
          h(
            'div',
            { className: 'fge-card', key: 'host' },
            h(
              'div',
              { className: 'fge-card-main' },
              h('span', { className: 'fge-card-label' }, t('field.host')),
              h('span', { className: 'fge-card-value' }, t('value.host')),
            ),
          ),
        ),
        h(
          'details',
          { className: 'fge-advanced' },
          h('summary', { className: 'fge-advanced-head' }, t('advanced.title')),
          h(
            'div',
            { className: 'fge-advanced-body' },
            h(
              'div',
              { className: 'fge-advanced-row' },
              h('span', { className: 'fge-advanced-key' }, t('field.authEnv')),
              h('span', { className: 'fge-advanced-value fge-code' }, advancedNames.length > 0 ? advancedNames.join(', ') : t('value.empty')),
            ),
            h(
              'div',
              { className: 'fge-advanced-row' },
              h('span', { className: 'fge-advanced-key' }, t('field.persistentToken')),
              h(
                'span',
                { className: 'fge-advanced-value fge-code' },
                persistentTokenValue === null || persistentTokenValue === undefined || persistentTokenValue === ''
                  ? t('value.empty')
                  : String(persistentTokenValue),
              ),
            ),
            h('p', { className: 'fge-hint' }, t('advanced.hint')),
          ),
        ),
        notice === null ? null : h('p', { className: 'fge-hint', role: 'status' }, t(notice.key)),
        writable ? null : h(UnavailableNote, { t, reason: snapshot?.reason ?? 'GITEE_CONFIG_UNAVAILABLE', entryId: snapshot?.entryId ?? 'heluo-gitee' }),
        h(SaveReceipt, { t, receipt }),
        h('p', { className: 'fge-footer' }, t('footer.declaration')),
      );
    }

    /**
     * 保存回执的两行（AC-8）：保存结论与应用结论各占一行，谁也不覆盖谁。
     * 两者来自同一次 POST 的响应，但语义上是两件事——"写进文件"不等于"运行时用上了"。
     */
    function buildReceipt(t, saving) {
      let saved = null;
      let applied = null;
      if (saving.state === 'saving') saved = { text: t('action.saving'), error: false };
      else if (saving.state === 'saved' || saving.state === 'saved-not-applied') saved = { text: t('save.saved'), error: false };
      else if (saving.state === 'conflict') saved = { text: t('save.conflict'), error: true };
      else if (saving.state === 'invalid') saved = { text: t('save.invalid'), error: true };
      else if (saving.state === 'unavailable') saved = { text: t('save.unavailable'), error: true };

      if (saving.applied !== null && saving.applied !== undefined) {
        applied = saving.applied.ok === true
          ? { text: t('save.applied'), error: false }
          : { text: t('save.notApplied', { reason: saving.applied.reason ?? '' }), error: true };
      }

      if (saved === null && applied === null) return null;
      return { saved, applied, check: null };
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return null;
      const existing = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
      if (existing) return null;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@heluo/forge-gitee';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * `ctx.slots.register` 的释放句柄可能是函数，也可能是 Fiber/对象：两种都要能释放，
     * 否则容器后到时会留下一个已废弃的独立分区。
     */
    function releaseDisposable(handle) {
      if (typeof handle === 'function') {
        handle();
        return;
      }
      if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') handle.dispose();
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-gitee: copy');
      ctx.effect(() => ensureStyle(), 'forge-gitee: styles');
      // 研发组合同时装了容器（`@heluo/forge-enterprise` 的 `forge-engineering` 分区）时，
      // 本插件不另占侧栏分区，而是把同一面板挂进容器的子槽位 `heluo.engineering.tab`
      // （order 20，设计 §6.3）；单独安装单包（ADR-0012）时容器缺席，保留独立分区。
      //
      // 两条挂载都走两段式：槽位可能晚于本插件 apply 声明，直接 register 会抛
      // `slot "..." is not declared` 并让入口整块消失。容器后到时先撤掉已经注册的
      // 独立分区再注册标签页；容器先到时标记 `tabbed` 让独立分区不再注册。
      const ENGINEERING_TAB_SLOT = 'heluo.engineering.tab';
      let standalone;
      let tabbed = false;
      ctx.effect(
        () =>
          ctx.slots.inject(ENGINEERING_TAB_SLOT, () => {
            tabbed = true;
            const releaseSection = standalone;
            standalone = undefined;
            const releaseTab = ctx.slots.register(
              {
                name: ENGINEERING_TAB_SLOT,
                id: 'gitee',
                order: 20,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ t }),
              },
              GiteeSection,
            );
            return () => {
              releaseDisposable(releaseTab);
              if (releaseSection !== undefined) releaseDisposable(releaseSection);
              tabbed = false;
            };
          }),
        'forge-gitee: engineering tab',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () => {
            // 容器已在场时由标签页接管入口，不再重复注册分区。
            if (tabbed) return undefined;
            const releaseSection = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'gitee',
                order: 50,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ t }),
              },
              GiteeSection,
            );
            standalone = releaseSection;
            return () => {
              releaseDisposable(releaseSection);
              if (standalone === releaseSection) standalone = undefined;
            };
          }),
        'forge-gitee: settings section',
      );
    }

    const inject = ['slots', 'locale'];

    return { apply, inject, GiteeSection, StatusLine };
  },
});
