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

    async function putJson(path, payload) {
      const response = await fetch(path, { method: 'PUT', headers: REQUEST_HEADERS, body: JSON.stringify(payload) });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function deleteJson(path) {
      const response = await fetch(path, { method: 'DELETE', headers: REQUEST_HEADERS });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    const GATEWAY_STATUS = {
      unconfigured: '未配置',
      configured: '已配置',
      'owner-mismatch': '属于其他账号，需重新录入',
      invalid: '记录损坏，请重新录入',
    };

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
      if (code === 'IAM_NOT_SIGNED_IN') return '请先登录企业账号。';
      if (code === 'IAM_ATTEMPT_CANCELLED') return '登录已取消，请重新登录。';
      if (code === 'IAM_CALLBACK_UNAVAILABLE') return '本机回调地址不可用，请检查 Web 服务是否启动。';
      if (code === 'IAM_CONFIG_INVALID') return 'IAM 配置无效，请管理员检查。';
      if (code === 'IAM_DISPOSED') return '插件已卸载，请刷新页面。';
      if (code === 'IAM_GRANT_CONTEXT_MISMATCH' || code === 'IAM_REFRESH_SUBJECT_MISMATCH') return '登录状态已变化，请重新登录。';
      if (code === 'IAM_GATEWAY_KEY_INVALID') return '凭证格式不正确：应为 uag- 加 32 位十六进制。';
      if (code === 'IAM_GATEWAY_OWNER_MISSING') return '请先登录企业账号，再录入网关凭据。';
      if (code === 'IAM_REQUEST_INVALID') return '请求内容无效，请重试。';
      if (code === 'IAM_REQUEST_TOO_LARGE') return '请求过大，请检查粘贴内容。';
      if (code === 'IAM_UNAUTHENTICATED' || code === 'IAM_CONNECTION_UNAVAILABLE') return '页面会话不可用，请刷新页面后重试。';
      if (code === 'IAM_METHOD_NOT_ALLOWED' || code === 'IAM_NOT_FOUND') return '请求不受支持，请刷新页面。';
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
      const [credential, setCredential] = React.useState({ value: '', deviceLabel: '', saving: false, notice: null });

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

      const saveCredential = async () => {
        const value = credential.value.trim();
        if (!value) {
          setCredential((current) => ({ ...current, notice: '请输入 UAG 个人凭证。' }));
          return;
        }
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', { key: value, deviceLabel: credential.deviceLabel.trim() });
          if (!result.ok) {
            setCredential((current) => ({
              ...current,
              saving: false,
              notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'),
            }));
            return;
          }
          // The value is never stored in component state after the write.
          setCredential({ value: '', deviceLabel: credential.deviceLabel, saving: false, notice: '网关凭据已保存。' });
          setState((current) => ({ ...current, view: result.body?.view ?? current.view }));
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const clearCredential = async () => {
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await deleteJson('/api/forge-iam/credential');
          if (!result.ok) {
            setCredential((current) => ({
              ...current,
              saving: false,
              notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'),
            }));
            return;
          }
          setCredential((current) => ({ ...current, saving: false, value: '', notice: '网关凭据已清除。' }));
          setState((current) => ({ ...current, view: result.body?.view ?? current.view }));
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const cancelLogin = async () => {
        try {
          const result = await postJson('/api/forge-iam/cancel');
          if (!result.ok) {
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          setState((current) => ({ ...current, view: result.body?.view ?? null, authorizationUrl: null, notice: null }));
        } catch {
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
        ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, errorNotice(view.error))
        : null;
      const notice = state.notice ? h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null;
      const loginLink = state.authorizationUrl
        ? h('div', { style: { marginTop: 6 } }, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录'))
        : null;

      const gateway = view.gatewayCredential ?? { state: 'unconfigured' };
      const gatewayStatus = GATEWAY_STATUS[gateway.state] ?? gateway.state;
      const gatewayDetails = [
        gateway.deviceLabel ? `设备：${gateway.deviceLabel}` : null,
        gateway.enteredAt ? `录入：${gateway.enteredAt}` : null,
        gateway.suggestedExpiry ? `建议到期：${gateway.suggestedExpiry}` : null,
      ].filter(Boolean);
      const storageWarning = gateway.state === 'configured' && gateway.storage && gateway.storage !== 'keychain'
        ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } },
            `存储来源：${gateway.storage}（未受系统钥匙串保护）`)
        : null;
      const gatewayBlock = h('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '模型网关凭据'),
        h('div', { style: muted }, `UAG 个人凭证：${gatewayStatus}`),
        gatewayDetails.length ? h('div', { style: muted }, gatewayDetails.join(' · ')) : null,
        storageWarning,
        gateway.state === 'configured'
          ? h('div', { style: muted }, '模型调用使用该凭据；IAM 登录状态变化不会自动替换它。')
          : h('div', { style: muted }, '到 UAG 控制台为这台设备创建个人凭证（名称建议包含设备名，有效期建议 90 天），粘贴到下方。'),
        h('div', { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('input', {
            type: 'password',
            value: credential.value,
            placeholder: 'uag-…',
            'aria-label': 'UAG 个人凭证',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setCredential((current) => ({ ...current, value: event.target.value })),
            style: { flex: '1 1 240px', padding: '4px 8px' },
          }),
          h('input', {
            type: 'text',
            value: credential.deviceLabel,
            placeholder: '设备标签（可选）',
            'aria-label': '设备标签',
            maxLength: 64,
            onChange: (event) => setCredential((current) => ({ ...current, deviceLabel: event.target.value })),
            style: { flex: '0 1 160px', padding: '4px 8px' },
          }),
          h('button', { style: button, disabled: credential.saving, onClick: saveCredential }, '保存凭据'),
          gateway.state !== 'unconfigured' || credential.value
            ? h('button', { style: button, disabled: credential.saving, onClick: clearCredential }, '清除凭据')
            : null,
        ),
        credential.notice ? h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-state-warn-primary)' } }, credential.notice) : null,
      );

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
          view.state === 'authenticating' ? h('button', { style: button, onClick: cancelLogin }, '取消登录') : null,
          view.canSignOut ? h('button', { style: button, onClick: signOut }, '退出') : null,
          view.state === 'authenticating' ? h('button', { style: button, onClick: () => postJson('/api/forge-iam/cancel').then(load) }, '取消') : null,
        ),
        gatewayBlock,
        h('div', { style: { ...muted, marginTop: 8 } }, '页面只显示非敏感状态；令牌与网关 Key 不会进入 UI 或日志。'),
      );
    }

    function SignedOutBanner() {
      const [state, setState] = React.useState({ visible: false, notice: null, view: null, authorizationUrl: null });

      const bannerFor = (view) => {
        if (!view) return { visible: true, reason: 'signed-out', sessionState: null };
        if (view.state !== 'ready') return { visible: true, reason: 'signed-out', sessionState: view.state };
        const gateway = view.gatewayCredential?.state ?? 'unconfigured';
        return gateway === 'configured'
          ? { visible: false, reason: null, gateway, sessionState: 'ready' }
          : { visible: true, reason: 'gateway', gateway, sessionState: 'ready' };
      };

      const SESSION_LABEL = {
        unconfigured: 'IAM 未配置',
        expired: '登录已过期，请重新登录',
        unreachable: 'IAM 暂不可达；保留现有授权至到期',
        error: '登录需要处理',
        authenticating: '等待浏览器登录完成',
      };

      React.useEffect(() => {
        let live = true;
        fetchView()
          .then((view) => { if (live) setState((current) => ({ ...current, ...bannerFor(view), view })); })
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
        ...bannerFor(view),
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
            ...bannerFor(view),
            view,
            authorizationUrl,
            notice: view?.state === 'authenticating'
              ? (popup ? '浏览器已打开，等待登录完成。' : '浏览器被拦截，请使用下方链接继续。')
              : null,
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: 'Host 不可达' }));
        }
      };

      const cancelLogin = async () => {
        try {
          const result = await postJson('/api/forge-iam/cancel');
          if (!result.ok) {
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          const view = result.body?.view ?? null;
          setState((current) => ({ ...current, ...bannerFor(view), view, authorizationUrl: null, notice: null }));
        } catch {
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
      h('span', null, state.reason === 'gateway'
        ? (state.gateway === 'owner-mismatch' ? '网关凭据属于其他账号' : '模型未就绪：未配置网关凭据')
        : SESSION_LABEL[state.sessionState] ?? '未登录企业 IAM'),
      state.reason === 'gateway'
        ? h('span', { style: { opacity: 0.8 } }, state.gateway === 'owner-mismatch'
          ? '到“设置 → 企业账号”重新录入'
          : '到“设置 → 企业账号”录入 UAG 个人凭证')
        : null,
      state.reason !== 'gateway' && state.view?.canSignIn
        ? h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: login }, '登录')
        : null,
      state.view?.state === 'authenticating'
        ? h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: cancelLogin }, '取消')
        : null,
      state.authorizationUrl
        ? h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '打开登录页')
        : null,
      state.notice ? h('span', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
      );
    }

    function Onboarding() {
      const [state, setState] = React.useState({
        phase: 'loading', view: null, step: 0, notice: null, open: false,
        authorizationUrl: null, keyValue: '', deviceLabel: '', saving: false,
      });

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
          const focusable = [...node.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.disabled);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
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
        // Advance into the credential step once. When this account already has a
        // matching key, skip straight to "完成"; a later identical poll must not
        // pull the user back out of the final screen.
        ...(view.state === 'ready' && current.step < 2
          ? { step: view.gatewayCredential?.state === 'configured' ? 3 : 2, authorizationUrl: null, notice: null }
          : {}),
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
            step: view?.state === 'ready'
              ? (view.gatewayCredential?.state === 'configured' ? 3 : 2)
              : current.step,
            authorizationUrl: result.body?.authorizationUrl,
            notice: view?.state === 'ready' ? null : '浏览器已打开；若被拦截，请使用下方链接。',
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: 'Host 不可达，请稍后重试。' }));
        }
      };

      const saveCredential = async () => {
        const value = state.keyValue.trim();
        if (!value) {
          setState((current) => ({ ...current, notice: '请输入 UAG 个人凭证。' }));
          return;
        }
        setState((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', {
            key: value,
            deviceLabel: state.deviceLabel.trim(),
          });
          if (!result.ok) {
            setState((current) => ({
              ...current,
              saving: false,
              notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'),
            }));
            return;
          }
          // Do not keep the pasted value in component state once stored.
          setState((current) => ({
            ...current,
            saving: false,
            keyValue: '',
            view: result.body?.view ?? current.view,
            step: 3,
            notice: null,
          }));
        } catch {
          setState((current) => ({ ...current, saving: false, notice: 'Host 不可达，请稍后重试。' }));
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
          title: '配置模型网关凭据',
          body: '企业 IAM 只负责登录；模型调用使用 UAG 个人凭证。到 UAG 控制台为本设备创建凭证后粘贴到这里。',
          primary: '保存并继续',
          onPrimary: saveCredential,
        },
        {
          title: '准备就绪',
          body: '模型是否可用取决于网关凭据是否已配置；可随时在“设置 → 企业账号”查看、更换或清除。',
          primary: '完成',
          // Without a configured credential the model is not usable; record the
          // skip rather than claiming onboarding completed.
          onPrimary: () => close(state.view?.gatewayCredential?.state === 'configured' ? 'done' : 'skipped'),
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
          state.step === 2
            ? h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
                h('input', {
                  type: 'password',
                  value: state.keyValue,
                  placeholder: 'uag-…',
                  'aria-label': 'UAG 个人凭证',
                  autoComplete: 'off',
                  spellCheck: false,
                  onChange: (event) => setState((current) => ({ ...current, keyValue: event.target.value })),
                  style: { padding: '6px 10px' },
                }),
                h('input', {
                  type: 'text',
                  value: state.deviceLabel,
                  placeholder: '设备标签（可选，例如 工作站-01）',
                  'aria-label': '设备标签',
                  maxLength: 64,
                  onChange: (event) => setState((current) => ({ ...current, deviceLabel: event.target.value })),
                  style: { padding: '6px 10px' },
                }),
                state.view?.gatewayConsoleUrl
                  ? h('a', { href: state.view.gatewayConsoleUrl, target: '_blank', rel: 'noreferrer' }, '打开 UAG 控制台创建凭据')
                  : null,
                h('div', { style: { opacity: 0.7, fontSize: '0.9em' } }, '创建时建议开启 privacy_mode，有效期 90 天。'),
              )
            : null,
          state.notice ? h('p', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
          state.authorizationUrl ? h('p', null, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录')) : null,
          h('div', null,
            h('button', { style: button, disabled: state.saving, onClick: step.onPrimary }, step.primary),
            state.step < 3
              ? h('button', { style: button, onClick: () => (state.step === 2
                ? setState((current) => ({ ...current, step: 3, notice: null }))
                : close('skipped')) }, state.step === 2 ? '稍后配置' : '跳过')
              : null,
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
