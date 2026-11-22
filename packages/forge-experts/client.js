window.__ModuleLoader__.load({
  id: '@heluo/forge-experts',
  factory(require) {
    // 分区索引（P1 单 bundle 边界锚点：纯函数与常量 ← IO 边界 ← 状态投影 ← 视图与出口）
    // §1 常量与文案 / §2 唯一错误码解包 / §3 同源 HTTP 与 SSE / §4 状态派生 / §5 管理页视图 / §6 出口

    // §1 常量与文案
    const React = require('react');
    const h = React.createElement;
    const API_BASE = '/api/forge-experts';
    const REQUEST_HEADERS = Object.freeze({
      'x-forge-experts-request': '1',
      'content-type': 'application/json',
    });

    const ERROR_NOTICE = Object.freeze(Object.assign(Object.create(null), {
      EXPERT_MANAGEMENT_DISABLED: '专家智能体管理入口当前未开放。',
      EXPERT_MENTIONS_DISABLED: '专家 @ 候选投影当前未开放。',
      EXPERT_UNAUTHENTICATED: '请先登录企业账号后再查看专家目录。',
      EXPERT_AUTH_INVALID: '企业登录状态无效，请重新登录。',
      EXPERT_AUTH_REVOKED: '企业授权已撤销，请重新登录。',
      EXPERT_ORG_FORBIDDEN: '当前账号无权访问所选组织的专家目录。',
      EXPERT_CALL_FORBIDDEN: '当前账号仅具备查看权限，无法启停该专家。',
      EXPERT_NOT_FOUND: '未找到该专家或当前无权访问。',
      EXPERT_SCOPE_MISMATCH: '账号或组织范围已变化，正在刷新目录。',
      EXPERT_SCOPE_UNVERIFIED: '当前会话委派范围尚未确认，已暂停专家候选。',
      EXPERT_CURSOR_STALE: '目录版本已更新，请重新加载列表。',
      EXPERT_EDIT_TOKEN_INVALID: '页面状态已过期，请刷新后重试。',
      EXPERT_EDIT_TOKEN_EXPIRED: '操作凭证已过期，请刷新后重试。',
      EXPERT_REVISION_CONFLICT: '该专家状态已在其他窗口更新，请核对最新状态。',
      EXPERT_DIRECTORY_UNAVAILABLE: '专家目录服务暂不可达，已保留您原有的个人设置。',
      EXPERT_STORAGE_UNAVAILABLE: '本地偏好存储暂不可用，请稍后重试。',
      EXPERT_PREF_SAVE_UNKNOWN: '保存结果尚未确认，正在回读服务端最新状态，请勿重复点击。',
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
      const suffix = editToken ? `?editToken=${encodeURIComponent(editToken)}` : '';
      const response = await fetch(`${API_BASE}/preferences/${encodeURIComponent(expertId)}${suffix}`);
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
        acceptingLabel: accepting === 'accepting'
          ? '可接单'
          : accepting === 'paused'
            ? '暂不接单'
            : accepting === 'unavailable'
              ? '暂不可用'
              : '接单状态未知',
      };
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

      return h('div', { className: 'forge-experts-ui', 'data-testid': 'forge-experts-panel' },
        h('div', { className: 'fexp-header' },
          h('h2', null, '专家智能体'),
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
        state.phase === 'loading'
          ? h('div', { 'data-testid': 'fexp-loading' }, '正在加载专家目录…')
          : state.items.length === 0
            ? h('div', { 'data-testid': 'fexp-empty' }, view === 'callable' ? '暂无可调用专家。' : '暂无可见专家。')
            : h('ul', { className: 'fexp-list' },
              ...state.items.map((item) => {
                const row = deriveRowStatus(item);
                const busy = Boolean(state.savingIds[item.expertId]) || row.pending;
                return h('li', { key: item.expertId, 'data-expert-id': item.expertId },
                  h('div', null,
                    h('strong', null, item.displayName),
                    item.disambiguation ? h('span', null, ` · ${item.disambiguation}`) : null,
                    h('span', null, ` (${row.acceptingLabel})`),
                  ),
                  h('div', null, item.summary?.disclosureState === 'available'
                    ? (item.summary.responsibility ?? '已获准披露能力摘要')
                    : '能力与权限摘要暂不可披露或未提供'),
                  row.callable
                    ? h('button', {
                      type: 'button',
                      disabled: busy || !item.preference?.editToken,
                      onClick: () => toggleExpert(item),
                    }, busy ? '待确认…' : (row.enabled ? '停用' : '启用'))
                    : h('span', null, '仅可查看'),
                );
              }),
            ),
      );
    }

    // §6 出口（管理包默认只注册设置页；仅在 Stage 3A-2 隔离预览下挂载 @ 候选组与失效注销）
    function mountIsolatedMentionsSource(ctx) {
      const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers;
      if (!triggers || typeof triggers.registerSource !== 'function') return () => {};

      let unregister = null;
      let generation = 0;
      let activeEpoch = 0;
      let activeVersion = 0;

      const dropGroup = () => {
        generation += 1;
        if (typeof unregister === 'function') {
          const fn = unregister;
          unregister = null;
          try { fn(); } catch { /* best effort */ }
        }
      };

      const registerGroup = () => {
        if (unregister) return;
        const mountedGen = ++generation;
        unregister = triggers.registerSource({
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
            return list.map((item) => ({
              id: item.expertId,
              label: item.disambiguation ? `${item.displayName} · ${item.disambiguation}` : item.displayName,
              description: item.responsibility ?? '',
              expertId: item.expertId,
              scopeEpoch: item.scopeEpoch,
              viewVersion: item.viewVersion,
            }));
          },
          onPick(picked) {
            if (!picked || picked.scopeEpoch !== activeEpoch || picked.viewVersion !== activeVersion) {
              return { accepted: false, reason: 'EXPERT_SCOPE_MISMATCH' };
            }
            return { accepted: true, expertId: picked.expertId, scopeEpoch: picked.scopeEpoch, viewVersion: picked.viewVersion };
          },
        });
      };

      registerGroup();
      const closeStream = openEventStream(
        (payload) => {
          if (payload.type === 'ready') {
            registerGroup();
            return;
          }
          if (payload.type === 'scope-changed' || payload.type === 'preference-updated' || payload.type === 'mentions-invalidated') {
            dropGroup();
            registerGroup();
          }
        },
        () => {
          // SSE 断开时立即撤下旧专家组，待重连 ready 后恢复，防止过期候选留驻已开菜单。
          dropGroup();
        },
      );

      return () => {
        closeStream();
        dropGroup();
      };
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
