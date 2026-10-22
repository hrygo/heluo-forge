window.__ModuleLoader__.load({
  id: '@heluo/forge-iam',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ONBOARDING_KEY = 'forge-iam.onboarding.v1';
    const REQUEST_HEADERS = { 'x-forge-iam-request': '1', 'content-type': 'application/json' };

    const STATUS = {
      unconfigured: 'IAM 未配置',
      'signed-out': '未登录',
      authenticating: '等待浏览器登录',
      ready: '已登录',
      expired: '授权已过期',
      unreachable: 'IAM 暂不可达',
      error: '需要处理',
    };

    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    async function fetchView() {
      const response = await fetch('/api/forge-iam/view');
      const view = await readJson(response);
      if (!response.ok) throw new Error(view?.error?.code ?? 'IAM_VIEW_FAILED');
      return view;
    }

    async function postJson(path) {
      const response = await fetch(path, { method: 'POST', headers: REQUEST_HEADERS, body: '{}' });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    function openLoginWindow() {
      try {
        const popup = window.open('', '_blank');
        if (popup) {
          try { popup.opener = null; } catch { /* cross-origin about:blank is still usable */ }
        }
        return popup;
      } catch {
        return null;
      }
    }

    function navigateLoginWindow(popup, url) {
      if (!popup) {
        if (url) {
          try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* visible fallback link remains */ }
        }
        return;
      }
      if (!url) {
        try { popup.close(); } catch { /* already closed */ }
        return;
      }
      try {
        popup.location.replace(url);
      } catch {
        try { popup.close(); } catch { /* already closed */ }
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* visible fallback link remains */ }
      }
    }

    function readMarker() {
      try {
        return window.localStorage.getItem(ONBOARDING_KEY);
      } catch {
        return null;
      }
    }

    function writeMarker(value) {
      try {
        window.localStorage.setItem(ONBOARDING_KEY, value);
      } catch {
        // Storage may be unavailable in a hardened profile; keep the session
        // usable without falling back to a file.
      }
    }

    function errorNotice(code) {
      if (code === 'IAM_REQUEST_HEADER_REQUIRED') return '请求被 Host 拒绝，请刷新页面重试。';
      if (code === 'IAM_UNCONFIGURED') return 'IAM 配置不完整，请管理员补全。';
      if (code === 'IAM_CREDENTIALS_UNAVAILABLE') return '凭据存储不可用，暂时无法登录。';
      if (code === 'IAM_CREDENTIALS_CLEAR_FAILED') return '本地凭据清理失败，请检查系统凭据库。';
      if (code === 'IAM_REVOCATION_FAILED') return '本地已退出，但服务端撤销未确认。';
      if (code === 'IAM_EXCLUSIVE_CONFLICT') return '官方登录服务仍挂载，请修正企业组合包。';
      if (code === 'IAM_UNREACHABLE') return 'IAM 端点不可达，请稍后重试。';
      if (code === 'IAM_STATE_MISMATCH' || code === 'IAM_CALLBACK_INVALID') return '登录回调无效，请重新登录。';
      if (code === 'IAM_ATTEMPT_EXPIRED') return '登录尝试已过期，请重新登录。';
      if (code === 'IAM_INVALID_GRANT' || code === 'IAM_REAUTH_REQUIRED') return '登录已失效，请重新登录。';
      return `操作失败：${code}`;
    }

    function useSessionPoll(enabled, update) {
      const updateRef = React.useRef(update);
      updateRef.current = update;
      React.useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        let inFlight = false;
        const timer = setInterval(async () => {
          if (inFlight) return;
          inFlight = true;
          try {
            const view = await fetchView();
            if (live) updateRef.current(view);
          } catch {
            // The next tick retries; a transient Host failure must not erase
            // the last known state.
          } finally {
            inFlight = false;
          }
        }, 2000);
        return () => {
          live = false;
          clearInterval(timer);
        };
      }, [enabled]);
    }

    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, error: null, notice: null, authorizationUrl: null });

      const load = React.useCallback(async () => {
        try {
          const view = await fetchView();
          setState((current) => ({ ...current, phase: 'ready', view, error: null }));
        } catch (error) {
          setState({ phase: 'error', view: null, error: error.message, notice: null, authorizationUrl: null });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);
      useSessionPoll(true, (view) => setState((current) => ({ ...current, phase: 'ready', view, error: null })));

      const login = async () => {
        setState((current) => ({ ...current, notice: null }));
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          const view = result.body?.view ?? null;
          const authorizationUrl = result.body?.authorizationUrl ?? null;
          navigateLoginWindow(popup, authorizationUrl);
          setState((current) => ({ ...current, view, authorizationUrl, notice: null }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const signOut = async () => {
        try {
          const result = await postJson('/api/forge-iam/sign-out');
          if (!result.ok) {
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          setState((current) => ({ ...current, view: result.body?.view ?? null, authorizationUrl: null, notice: null }));
          if (result.body?.logoutUrl) window.location.assign(result.body.logoutUrl);
        } catch {
          setState((current) => ({ ...current, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const box = { padding: '12px 0', lineHeight: 1.6 };
      const button = { marginRight: 8, marginTop: 8, padding: '4px 10px', cursor: 'pointer' };
      const muted = { opacity: 0.7, fontSize: '0.9em' };
      const header = h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '企业 IAM');

      if (state.phase === 'loading') {
        return h('div', { style: box }, header, h('div', { style: muted }, '正在读取登录状态…'));
      }
      if (state.phase === 'error') {
        return h('div', { style: box }, header,
          h('div', null, '无法读取登录状态。'),
          h('div', { style: muted }, state.error),
          h('button', { style: button, onClick: load }, '重试'),
        );
      }

      const view = state.view ?? {};
      const label = STATUS[view.state] ?? view.state ?? '未知状态';
      const missing = Array.isArray(view.missing) && view.missing.length
        ? h('div', { style: muted }, `缺少配置：${view.missing.join('、')}`)
        : null;
      const principal = view.principal ? h('div', { style: muted }, `主体：${view.principal}`) : null;
      const expiry = view.accessExpiresAt ? h('div', { style: muted }, `access 到期：${view.accessExpiresAt}`) : null;
      const exclusive = view.exclusive && view.exclusive !== 'ok'
        ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, '企业登录独占检查未通过；请修正企业组合包。')
        : null;
      const hostError = view.error
        ? h('div', { style: { color: '#b42318', marginTop: 4 } }, errorNotice(view.error))
        : null;
      const notice = state.notice ? h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null;
      const loginLink = state.authorizationUrl
        ? h('div', { style: { marginTop: 6 } }, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录'))
        : null;

      return h('div', { style: box }, header,
        h('div', null, label),
        missing,
        principal,
        expiry,
        exclusive,
        hostError,
        notice,
        loginLink,
        h('div', null,
          h('button', { style: button, onClick: load }, '刷新'),
          view.canSignIn ? h('button', { style: button, onClick: login }, '登录企业账号') : null,
          view.canSignOut ? h('button', { style: button, onClick: signOut }, '退出') : null,
          view.state === 'authenticating' ? h('button', { style: button, onClick: () => postJson('/api/forge-iam/cancel').then(load) }, '取消') : null,
        ),
        h('div', { style: { ...muted, marginTop: 8 } }, '页面只显示非敏感状态；令牌不会进入 UI 或日志。'),
      );
    }

    function SignedOutBanner() {
      const [state, setState] = React.useState({ visible: false, notice: null, view: null, authorizationUrl: null });

      React.useEffect(() => {
        let live = true;
        fetchView()
          .then((view) => { if (live) setState((current) => ({ ...current, visible: view.state !== 'ready', view })); })
          .catch(() => {
            if (live) setState((current) => ({ ...current, visible: true, notice: '无法读取登录状态，正在重试。' }));
          });
        return () => { live = false; };
      }, []);

      // Observe for as long as the banner is mounted: display is derived from
      // the view, so keying the poll on `visible` would stop observing as soon
      // as a session becomes ready and never notice a later sign-out.
      useSessionPoll(true, (view) => setState((current) => ({
        ...current,
        view,
        visible: view.state !== 'ready',
      })));

      const login = async () => {
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          const view = result.body?.view;
          const authorizationUrl = result.body?.authorizationUrl ?? null;
          navigateLoginWindow(popup, authorizationUrl);
          setState((current) => ({
            ...current,
            view,
            authorizationUrl,
            visible: view?.state === 'ready' ? false : true,
            notice: view?.state === 'authenticating'
              ? (popup ? '浏览器已打开，等待登录完成。' : '浏览器被拦截，请使用下方链接继续。')
              : null,
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: 'Host 不可达' }));
        }
      };

      if (!state.visible) return null;
      return h('div', {
        style: {
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 900,
          pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 12px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)', boxShadow: '0 6px 24px rgba(0,0,0,0.18)', fontSize: '0.9em',
        },
      },
      h('span', null, '未登录企业 IAM'),
      state.view?.canSignIn ? h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: login }, '登录') : null,
      state.authorizationUrl
        ? h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '打开登录页')
        : null,
      state.notice ? h('span', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
      );
    }

    function Onboarding() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, step: 0, notice: null, open: false, authorizationUrl: null });

      const close = async (marker) => {
        try { await postJson('/api/forge-iam/cancel'); } catch { /* best effort */ }
        if (marker) writeMarker(marker);
        setState((current) => ({ ...current, open: false }));
      };
      const dialogRef = React.useRef(null);

      React.useEffect(() => {
        if (!state.open) return undefined;
        const node = dialogRef.current;
        node?.focus();
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close('skipped');
            return;
          }
          if (event.key !== 'Tab' || !node) return;
          const focusable = [...node.querySelectorAll('button, a[href]')];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state.open, state.step, state.view?.state]);

      React.useEffect(() => {
        let live = true;
        const marker = readMarker();
        if (marker === 'done' || marker === 'skipped') return () => { live = false; };
        fetchView()
          .then((view) => {
            if (!live) return;
            setState({ phase: 'ready', view, step: 0, notice: null, open: view.state === 'signed-out', authorizationUrl: null });
          })
          .catch(() => {
            if (live) setState((current) => ({ ...current, phase: 'ready', open: false }));
          });
        return () => { live = false; };
      }, []);

      useSessionPoll(state.open, (view) => setState((current) => ({
        ...current,
        view,
        // Advance to the success step once, then keep the user's final screen:
        // a later identical `ready` poll must not pull them back from "完成".
        ...(view.state === 'ready' && current.step < 2 ? { step: 2, authorizationUrl: null, notice: null } : {}),
        ...(view.state === 'error' ? { notice: errorNotice(view.error ?? 'IAM_REQUEST_FAILED') } : {}),
      })));

      if (!state.open) return null;

      const startLogin = async () => {
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          const view = result.body?.view;
          navigateLoginWindow(popup, result.body?.authorizationUrl);
          setState((current) => ({
            ...current,
            view,
            step: view?.state === 'ready' ? 2 : current.step,
            authorizationUrl: result.body?.authorizationUrl,
            notice: view?.state === 'ready' ? null : '浏览器已打开；若被拦截，请使用下方链接。',
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const steps = [
        {
          title: '欢迎使用企业版',
          body: '企业 IAM 是唯一登录方式。登录后，企业模型与工具才可用；应用外壳可以先打开。',
          primary: '开始',
          onPrimary: () => setState((current) => ({ ...current, step: 1 })),
        },
        {
          title: '登录企业账号',
          body: '使用系统浏览器完成企业登录，不在应用内输入密码。',
          primary: '登录',
          onPrimary: startLogin,
        },
        {
          title: '登录成功',
          body: '企业登录已就绪。可以在设置中查看账户状态或退出。',
          primary: '下一步',
          onPrimary: () => setState((current) => ({ ...current, step: 3 })),
        },
        {
          title: '准备就绪',
          body: '之后可在“设置 → 企业账号”查看主体、到期时间和退出操作。',
          primary: '完成',
          onPrimary: () => close('done'),
        },
      ];
      const step = steps[state.step] ?? steps[0];
      const overlay = {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        // shell.overlay is click-through; an interactive surface must opt back
        // into pointer events or every click falls through to the app below.
        pointerEvents: 'auto',
      };
      const card = {
        width: 'min(520px, 100%)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        borderRadius: 12, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', lineHeight: 1.6,
      };
      const button = { marginRight: 8, marginTop: 16, padding: '6px 14px', cursor: 'pointer' };

      return h('div', { style: overlay, role: 'presentation' },
        h('div', { ref: dialogRef, tabIndex: -1, style: card, role: 'dialog', 'aria-modal': 'true', 'aria-label': step.title },
          h('div', { style: { opacity: 0.6, fontSize: '0.85em' } }, `步骤 ${state.step + 1} / 4`),
          h('h2', { style: { margin: '8px 0 12px', fontSize: '1.25em' } }, step.title),
          h('p', { style: { margin: 0 } }, step.body),
          state.notice ? h('p', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
          state.authorizationUrl ? h('p', null, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录')) : null,
          h('div', null,
            h('button', { style: button, onClick: step.onPrimary }, step.primary),
            state.step < 3 ? h('button', { style: button, onClick: () => close('skipped') }, '跳过') : null,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'forge-iam',
          order: 30,
          label: () => '企业账号',
        }, Panel));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'forge-iam-banner',
        }, SignedOutBanner));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'forge-iam-onboarding',
        }, Onboarding));
      },
    };
  },
});
