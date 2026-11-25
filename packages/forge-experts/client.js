window.__ModuleLoader__.load({
  id: '@heluo/forge-experts',
  factory(require) {
    // 分区索引（P1 单 bundle 边界锚点：纯函数与常量 ← IO 边界 ← 状态投影 ← 视图与出口）
    // §1 常量与文案 / §2 唯一错误码解包 / §3 同源 HTTP 与 SSE / §4 状态派生 / §5 管理页视图 / §6 出口

    // §1 常量与文案
    const React = require('react');
    const h = React.createElement;
    const API_BASE = '/api/forge-experts';
    const EDIT_TOKEN_HEADER = 'x-forge-experts-edit-token';
    const REQUEST_HEADERS = Object.freeze({
      'x-forge-experts-request': '1',
      'content-type': 'application/json',
    });

    const ACCEPTING_LABELS = Object.freeze(Object.assign(Object.create(null), {
      accepting: '可接单',
      paused: '暂不接单',
      unavailable: '暂不可用',
    }));

    const ERROR_NOTICE = Object.freeze(Object.assign(Object.create(null), {
      EXPERT_MANAGEMENT_DISABLED: '专家智能体管理入口当前未开放。',
      EXPERT_MENTIONS_DISABLED: '专家 @ 候选投影当前未开放。',
      EXPERT_DISPATCH_DISABLED: '专家任务委派入口当前未开放。',
      EXPERT_UNAUTHENTICATED: '请先登录企业账号后再查看专家目录。',
      EXPERT_AUTH_INVALID: '企业登录状态无效，请重新登录。',
      EXPERT_AUTH_REVOKED: '企业授权已撤销，请重新登录。',
      EXPERT_ORG_FORBIDDEN: '当前账号无权访问所选组织的专家目录。',
      EXPERT_CALL_FORBIDDEN: '当前账号仅具备查看权限，无法启停或委派该专家。',
      EXPERT_POLICY_DENIED: '当前外发委派已被企业策略拒绝，草稿已保留。',
      EXPERT_POLICY_CONFIRMATION_REQUIRED: '当前委派需要人工确认后方可发送，草稿已保留。',
      EXPERT_NOT_FOUND: '未找到该专家或当前无权访问。',
      EXPERT_TASK_NOT_FOUND: '未找到该专家任务或当前无权查看。',
      EXPERT_SCOPE_MISMATCH: '账号或组织范围已变化，正在刷新目录。',
      EXPERT_SCOPE_UNVERIFIED: '当前会话委派范围尚未确认，已暂停专家候选。',
      EXPERT_SELECTION_INVALID: '专家选择已失效或草稿已变更，请重新选择专家后再发送。',
      EXPERT_NOT_ACCEPTING: '该专家当前暂不接单，已保留您的草稿。',
      EXPERT_IDEMPOTENCY_CONFLICT: '同一请求标识对应了不同的任务内容，请核对原任务状态。',
      EXPERT_TASK_STATE_CONFLICT: '任务状态已变更，正在同步服务端最新状态。',
      EXPERT_CURSOR_STALE: '目录版本已更新，请重新加载列表。',
      EXPERT_EDIT_TOKEN_INVALID: '页面状态已过期，请刷新后重试。',
      EXPERT_EDIT_TOKEN_EXPIRED: '操作凭证已过期，请刷新后重试。',
      EXPERT_REVISION_CONFLICT: '该专家状态已在其他窗口更新，请核对最新状态。',
      EXPERT_DIRECTORY_UNAVAILABLE: '专家目录服务暂不可达，已保留您原有的个人设置。',
      EXPERT_STORAGE_UNAVAILABLE: '本地偏好存储暂不可用，请稍后重试。',
      EXPERT_PREF_SAVE_UNKNOWN: '保存结果尚未确认，正在回读服务端最新状态，请勿重复点击。',
      EXPERT_ISOLATION_UNVERIFIED: '目标运行环境隔离尚未验证，已暂停专家委派。',
      EXPERT_ACCEPTANCE_UNKNOWN: '任务受理结果暂未确认，请通过原请求号对账，切勿重复发送。',
      EXPERT_REQUEST_FAILED: '操作未完成，请稍后重试。',
    }));

    // §2 唯一错误码解包（P5：全文件唯一读取口）
    function resultCode(result) {
      return result?.body?.error?.code ?? 'EXPERT_REQUEST_FAILED';
    }

    function resultNotice(result) {
      return ERROR_NOTICE[resultCode(result)] ?? ERROR_NOTICE.EXPERT_REQUEST_FAILED;
    }

    // §3 同源 HTTP 与 SSE（P7：只读投影与经 Host 提交，绝不反向回写配置）
    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    async function fetchCatalog({ view = 'callable', query = '', cursor = null, signal } = {}) {
      const params = new URLSearchParams({ view });
      if (query.trim()) params.set('query', query.trim());
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`${API_BASE}/catalog?${params.toString()}`, signal ? { signal } : undefined);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function fetchMentions({ sessionId, query = '' }) {
      const params = new URLSearchParams({ sessionId });
      if (query.trim()) params.set('query', query.trim());
      const response = await fetch(`${API_BASE}/mentions?${params.toString()}`);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function putPreference(expertId, { enabled, editToken }) {
      const response = await fetch(`${API_BASE}/preferences/${encodeURIComponent(expertId)}`, {
        method: 'PUT',
        headers: REQUEST_HEADERS,
        body: JSON.stringify({ enabled, editToken }),
      });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function reconcilePreference(expertId, editToken) {
      const init = editToken ? { headers: { [EDIT_TOKEN_HEADER]: editToken } } : undefined;
      const response = await fetch(`${API_BASE}/preferences/${encodeURIComponent(expertId)}`, init);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function postSelectionPrepare(payload) {
      const response = await fetch(`${API_BASE}/selections`, {
        method: 'POST',
        headers: REQUEST_HEADERS,
        body: JSON.stringify(payload),
      });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    function openEventStream(onMessage, onError) {
      if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return () => {};
      const source = new window.EventSource(`${API_BASE}/events`);
      source.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || typeof payload !== 'object') return;
        onMessage(payload);
      };
      if (typeof onError === 'function') {
        source.onerror = () => onError();
      }
      return () => {
        try { source.close(); } catch { /* closing */ }
      };
    }

    // §4 状态派生
    function deriveRowStatus(item) {
      const pref = item?.preference;
      const accepting = item?.availability?.acceptingTasks ?? 'unknown';
      const pending = pref?.pending === true;
      const enabled = pref?.enabled === true;
      return {
        callable: item?.access?.callableInOrg === true,
        pending,
        enabled,
        acceptingLabel: ACCEPTING_LABELS[accepting] ?? '接单状态未知',
      };
    }

    function formatSummaryText(summary) {
      if (summary?.disclosureState === 'available') {
        return summary.responsibility ?? '已获准披露能力摘要';
      }
      return '能力与权限摘要暂不可披露或未提供';
    }

    function formatActionLabel(busy, enabled) {
      if (busy) return '待确认…';
      return enabled ? '停用' : '启用';
    }

    // §5 管理页视图
    function ExpertsManagementPanel() {
      const [view, setView] = React.useState('callable');
      const [query, setQuery] = React.useState('');
      const [state, setState] = React.useState({
        phase: 'loading',
        items: [],
        completeness: 'unknown',
        scopeEpoch: 0,
        viewVersion: 0,
        notice: null,
        savingIds: {},
      });
      const requestSeq = React.useRef(0);

      const load = React.useCallback(async (nextView = view, nextQuery = query) => {
        const seq = ++requestSeq.current;
        setState((prev) => ({ ...prev, phase: prev.items.length ? 'ready' : 'loading', notice: null }));
        try {
          const result = await fetchCatalog({ view: nextView, query: nextQuery });
          if (seq !== requestSeq.current) return;
          if (!result.ok) {
            setState((prev) => ({ ...prev, phase: 'error', items: [], notice: resultNotice(result) }));
            return;
          }
          setState((prev) => ({
            ...prev,
            phase: 'ready',
            items: Array.isArray(result.body?.items) ? result.body.items : [],
            completeness: result.body?.completeness ?? 'unknown',
            scopeEpoch: result.body?.scopeEpoch ?? prev.scopeEpoch,
            viewVersion: result.body?.viewVersion ?? prev.viewVersion,
            notice: result.body?.completeness && result.body.completeness !== 'complete'
              ? '当前目录覆盖范围不完整，展示结果仅反映已返回部分。'
              : null,
          }));
        } catch {
          if (seq !== requestSeq.current) return;
          setState((prev) => ({ ...prev, phase: 'error', notice: ERROR_NOTICE.EXPERT_DIRECTORY_UNAVAILABLE }));
        }
      }, [view, query]);

      // Latest view/query for the stream callback: an SSE frame must refresh the
      // current query without re-subscribing the stream on every keystroke.
      const viewRef = React.useRef(view);
      const queryRef = React.useRef(query);
      viewRef.current = view;
      queryRef.current = query;

      React.useEffect(() => {
        // Typing filters the loaded snapshot immediately (§3.3); the directory
        // query is debounced so one keystroke never becomes one remote read.
        const timer = setTimeout(() => { load(view, query); }, query ? 250 : 0);
        return () => clearTimeout(timer);
      }, [view, query, load]);

      React.useEffect(() => openEventStream((payload) => {
        if (payload.type === 'ready' || payload.type === 'scope-changed' || payload.type === 'catalog-invalidated' || payload.type === 'preference-updated') {
          load(viewRef.current, queryRef.current);
        }
      }), []);

      const toggleExpert = async (item) => {
        const pref = item?.preference;
        if (!item?.access?.callableInOrg || !pref?.editToken || state.savingIds[item.expertId]) return;
        const nextEnabled = !pref.enabled;
        setState((prev) => ({ ...prev, savingIds: { ...prev.savingIds, [item.expertId]: true }, notice: null }));
        try {
          const result = await putPreference(item.expertId, { enabled: nextEnabled, editToken: pref.editToken });
          if (!result.ok) {
            const code = resultCode(result);
            setState((prev) => ({ ...prev, notice: resultNotice(result) }));
            if (code === 'EXPERT_PREF_SAVE_UNKNOWN') {
              // Same edit token: the Host answers saved / not_executed / pending.
              const settled = await reconcilePreference(item.expertId, pref.editToken).catch(() => null);
              const settlement = settled?.body?.settlement;
              if (settlement === 'saved') {
                setState((prev) => ({ ...prev, notice: '服务端已确认保存，已回读最新状态。' }));
              } else if (settlement === 'not_executed') {
                setState((prev) => ({ ...prev, notice: '该次保存未执行，已保持上次确认的启用状态。' }));
              }
            }
            await load(view, query);
            return;
          }
          await load(view, query);
        } catch {
          setState((prev) => ({ ...prev, notice: ERROR_NOTICE.EXPERT_PREF_SAVE_UNKNOWN }));
          await reconcilePreference(item.expertId, pref.editToken).catch(() => {});
          await load(view, query);
        } finally {
          setState((prev) => {
            const next = { ...prev.savingIds };
            delete next[item.expertId];
            return { ...prev, savingIds: next };
          });
        }
      };

      let listBody;
      if (state.phase === 'loading') {
        listBody = h('div', { 'data-testid': 'fexp-loading' }, '正在加载专家目录…');
      } else if (state.items.length === 0) {
        const emptyText = view === 'callable' ? '暂无可调用专家。' : '暂无可见专家。';
        listBody = h('div', { 'data-testid': 'fexp-empty' }, emptyText);
      } else {
        listBody = h('ul', { className: 'fexp-list' },
          ...state.items.map((item) => {
            const row = deriveRowStatus(item);
            const busy = Boolean(state.savingIds[item.expertId]) || row.pending;
            const actionNode = row.callable
              ? h('button', {
                type: 'button',
                disabled: busy || !item.preference?.editToken,
                onClick: () => toggleExpert(item),
              }, formatActionLabel(busy, row.enabled))
              : h('span', null, '仅可查看');
            return h('li', { key: item.expertId, 'data-expert-id': item.expertId },
              h('div', null,
                h('strong', null, item.displayName),
                item.disambiguation ? h('span', null, ` · ${item.disambiguation}`) : null,
                h('span', null, ` (${row.acceptingLabel})`),
              ),
              h('div', null, formatSummaryText(item.summary)),
              actionNode,
            );
          }),
        );
      }

      return h('div', { className: 'forge-experts-ui', 'data-testid': 'forge-experts-panel' },
        h('div', { className: 'fexp-header' },
          h('h2', null, '专家智能体'),
          // Stage 3A 管理页暂不开放聊天 @ 委派发起入口；上方预置的委派/策略类错误文案供 Stage 3B 委派交互接入后直接消费。
          h('p', { 'data-testid': 'fexp-dispatch-notice' }, '聊天 @ 专家委派尚未开放，当前可在管理页提前维护个人启用列表。'),
        ),
        h('div', { className: 'fexp-toolbar' },
          h('button', { type: 'button', onClick: () => setView('callable'), 'aria-pressed': view === 'callable' }, '可调用'),
          h('button', { type: 'button', onClick: () => setView('directory'), 'aria-pressed': view === 'directory' }, '专家目录'),
          h('input', {
            type: 'search',
            value: query,
            placeholder: '搜索专家名称或职责…',
            'aria-label': '搜索专家',
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        state.notice ? h('div', { role: 'status', 'data-testid': 'fexp-notice' }, state.notice) : null,
        listBody,
      );
    }

    // §6 出口（管理包默认只注册设置页；隔离预览仅挂载候选组，dispatchEnabled 开放生产 @ 选择绑定与草稿保护）
    function mountMentionsSource(ctx, { enableSelectionBinding }) {
      const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers;
      if (!triggers || typeof triggers.registerSource !== 'function') return () => {};

      let unregister = null;
      let generation = 0;
      let activeEpoch = 0;
      let activeVersion = 0;

      const dropGroup = () => {
        generation += 1;
        activeEpoch = 0;
        activeVersion = 0;
        if (typeof unregister === 'function') {
          const fn = unregister;
          unregister = null;
          try { fn(); } catch { /* best effort */ }
        }
      };

      const registerGroup = () => {
        if (unregister) return;
        const mountedGen = ++generation;
        const sourceSpec = {
          id: 'forge-experts-mentions',
          trigger: '@',
          label: '专家智能体',
          async query(text, queryCtx) {
            const sessionId = typeof queryCtx?.sessionId === 'string' ? queryCtx.sessionId : '';
            if (!sessionId) return [];
            const result = await fetchMentions({ sessionId, query: typeof text === 'string' ? text : '' });
            if (mountedGen !== generation || !result.ok) return [];
            activeEpoch = result.body?.scopeEpoch ?? activeEpoch;
            activeVersion = result.body?.viewVersion ?? activeVersion;
            const list = Array.isArray(result.body?.candidates) ? result.body.candidates : [];
            const nameCounts = Object.create(null);
            for (const item of list) {
              if (typeof item?.displayName === 'string') {
                nameCounts[item.displayName] = (nameCounts[item.displayName] ?? 0) + 1;
              }
            }
            return list.map((item) => {
              const duplicateName = typeof item?.displayName === 'string' && nameCounts[item.displayName] > 1;
              const suffix = item.disambiguation
                ? item.disambiguation
                : (duplicateName ? (item.responsibility || item.expertId) : '');
              return {
                id: item.expertId,
                label: suffix ? `${item.displayName} · ${suffix}` : item.displayName,
                description: item.responsibility ?? '',
                expertId: item.expertId,
                scopeEpoch: item.scopeEpoch,
                viewVersion: item.viewVersion,
              };
            });
          },
          onPick(picked) {
            if (!picked || picked.scopeEpoch !== activeEpoch || picked.viewVersion !== activeVersion) {
              return { accepted: false, reason: 'EXPERT_SCOPE_MISMATCH' };
            }
            return { accepted: true, expertId: picked.expertId, scopeEpoch: picked.scopeEpoch, viewVersion: picked.viewVersion };
          },
        };

        const pendingDrafts = new Map();
        let draftRecoveryListener = null;

        if (enableSelectionBinding) {
          // 生产 @ 选择绑定：仅在用户显式点选且未失效时向 Host 申请单次 selectionToken；
          // 任何失效、撤权或网络异常均保留草稿并给出明确提示，不静默发送（#245 / #246）。
          sourceSpec.onDraftRecovery = (listener) => {
            draftRecoveryListener = typeof listener === 'function' ? listener : null;
            return () => {
              if (draftRecoveryListener === listener) draftRecoveryListener = null;
            };
          };
          sourceSpec.prepareSubmit = async ({ picked, sessionId, taskText, draftVersion, reuseRefs = [] } = {}) => {
            const draft = { taskText: typeof taskText === 'string' ? taskText : '', draftVersion: draftVersion ?? null, reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [] };
            if (!picked || picked.scopeEpoch !== activeEpoch || picked.viewVersion !== activeVersion || !picked.expertId) {
              return {
                ok: false,
                code: 'EXPERT_SELECTION_INVALID',
                preserveDraft: true,
                draft,
                notice: ERROR_NOTICE.EXPERT_SELECTION_INVALID,
              };
            }
            try {
              const result = await postSelectionPrepare({
                expertId: picked.expertId,
                sessionId,
                scopeEpoch: picked.scopeEpoch,
                viewVersion: picked.viewVersion,
                taskText: draft.taskText,
                ...(Number.isInteger(draft.draftVersion) ? { draftVersion: draft.draftVersion } : {}),
                ...(draft.reuseRefs.length > 0 ? { reuseRefs: draft.reuseRefs } : {}),
              });
              if (!result.ok || !result.body?.selectionToken) {
                return {
                  ok: false,
                  code: resultCode(result),
                  preserveDraft: true,
                  draft,
                  notice: resultNotice(result),
                };
              }
              if (typeof sessionId === 'string' && sessionId.trim()) {
                pendingDrafts.set(sessionId.trim(), draft);
              }
              return {
                ok: true,
                selectionToken: result.body.selectionToken,
                expertId: result.body.expertId,
                sessionId: result.body.sessionId,
                draftDigest: result.body.draftDigest,
                expiresAt: result.body.expiresAt,
                preserveDraft: false,
              };
            } catch {
              return {
                ok: false,
                code: 'EXPERT_DIRECTORY_UNAVAILABLE',
                preserveDraft: true,
                draft,
                notice: ERROR_NOTICE.EXPERT_DIRECTORY_UNAVAILABLE,
              };
            }
          };
        }

        unregister = triggers.registerSource(sourceSpec);
        return { pendingDrafts, getRecoveryListener: () => draftRecoveryListener };
      };

      let activeHooks = registerGroup();
      const closeStream = openEventStream(
        (payload) => {
          if (payload.type === 'ready') {
            activeHooks = registerGroup() ?? activeHooks;
            return;
          }
          if (payload.type === 'turn-finalized' && enableSelectionBinding && payload.preserveDraft === true) {
            const sessionKey = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
            const recoveredDraft = sessionKey ? (activeHooks?.pendingDrafts?.get(sessionKey) ?? null) : null;
            if (sessionKey) activeHooks?.pendingDrafts?.delete(sessionKey);
            const notice = typeof payload.notice === 'string' && payload.notice
              ? payload.notice
              : (ERROR_NOTICE[payload.code] ?? ERROR_NOTICE.EXPERT_SELECTION_INVALID);
            const listener = activeHooks?.getRecoveryListener?.();
            if (typeof listener === 'function') {
              try {
                listener({
                  sessionId: sessionKey || null,
                  expertId: payload.expertId ?? null,
                  status: payload.status ?? 'failed',
                  code: payload.code ?? null,
                  preserveDraft: true,
                  draft: recoveredDraft,
                  notice,
                });
              } catch { /* best effort */ }
            }
            return;
          }
          if (payload.type === 'scope-changed' || payload.type === 'preference-updated' || payload.type === 'mentions-invalidated') {
            dropGroup();
            activeHooks = registerGroup();
          }
        },
        () => {
          // SSE 断开时立即撤下旧专家组，待重连 ready 后恢复，防止过期候选留驻已开菜单。
          dropGroup();
        },
      );

      return () => {
        closeStream();
        activeHooks?.pendingDrafts?.clear();
        dropGroup();
      };
    }

    function mountIsolatedMentionsSource(ctx) {
      return mountMentionsSource(ctx, { enableSelectionBinding: false });
    }

    function mountProductionMentionsSource(ctx) {
      return mountMentionsSource(ctx, { enableSelectionBinding: true });
    }

    return {
      inject: ['slots'],
      apply(ctx, options = {}) {
        const disposers = [];
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'forge-experts',
            order: 25,
            label: () => '专家智能体',
          }, ExpertsManagementPanel));
          if (typeof disposeSection === 'function') disposers.push(disposeSection);
        }
        if (options?.isolatedMentionsPreview === true) {
          disposers.push(mountIsolatedMentionsSource(ctx));
        } else if (options?.dispatchEnabled === true) {
          disposers.push(mountProductionMentionsSource(ctx));
        }
        // Cordis collects cleanup through `ctx.effect`; it never emits a
        // `dispose` event, so registering one leaks every slot subscription.
        ctx.effect?.(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* best effort */ }
          }
        });
      },
    };
  },
});
