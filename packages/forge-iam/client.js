window.__ModuleLoader__.load({
  id: '@heluo/forge-iam',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ONBOARDING_KEY = 'forge-iam.onboarding.v1';
    const REQUEST_HEADERS = { 'x-forge-iam-request': '1', 'content-type': 'application/json' };
    // Use the host palette so the embedded controls follow light and dark themes.
    const inputStyle = {
      boxSizing: 'border-box', minWidth: 0, minHeight: 36, padding: '0 12px',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)', font: 'var(--dsw-font-s-14)',
    };
    const secondaryButton = {
      minHeight: 32, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-label-primary)',
      font: 'var(--dsw-font-xs-13)', cursor: 'pointer',
    };
    const primaryButton = {
      ...secondaryButton, borderColor: 'transparent',
      background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    };
    const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, font: 'var(--dsw-font-s-14)' };
    const interactionStyles = `
      .forge-iam-ui {
        --fiam-primary: var(--dsw-alias-state-business-primary, #2563eb);
        --fiam-success: var(--dsw-alias-state-success-primary, #10b981);
        --fiam-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
        --fiam-error: var(--dsw-alias-state-error-primary, #ef4444);
      }
      .forge-iam-ui button:not(:disabled), .forge-iam-ui a { cursor: pointer; }
      .forge-iam-ui button:not(:disabled):hover { background-color: var(--dsw-alias-button-floating-hover) !important; }
      .forge-iam-ui button.forge-iam-primary:not(:disabled):hover { background-color: var(--dsw-alias-button-primary-hover) !important; opacity: 0.94; }
      .forge-iam-ui button:not(:disabled):active { filter: brightness(.92); transform: translateY(1px); }
      .forge-iam-ui a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
      .forge-iam-ui a:hover { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
      .forge-iam-ui input:not(:disabled):hover { border-color: var(--dsw-alias-border-l3) !important; }
      .forge-iam-ui input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary) !important; box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 15%, transparent); }
      .forge-iam-ui :is(button, a):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .forge-iam-ui :is(button, input):disabled { cursor: not-allowed; opacity: .55; }
      @media (prefers-reduced-motion: reduce) { .forge-iam-ui button:active { transform: none; } }

      .fiam-card {
        box-sizing: border-box;
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 10px);
        padding: 18px 20px;
        margin-top: 14px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .fiam-card:hover { border-color: var(--dsw-alias-border-l3); }
      .fiam-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .fiam-card-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .fiam-card-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
        line-height: 20px;
      }
      .fiam-card-subtitle {
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-secondary);
        line-height: 16px;
        margin-top: 2px;
      }
      .fiam-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: var(--dsw-font-xxs-12);
        font-weight: 500;
        line-height: 18px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .fiam-badge-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .fiam-badge-success {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
        color: var(--dsw-alias-state-success-primary);
      }
      .fiam-badge-success .fiam-badge-dot { background: var(--dsw-alias-state-success-primary); }
      .fiam-badge-idle {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
        color: var(--dsw-alias-label-secondary);
      }
      .fiam-badge-idle .fiam-badge-dot { background: var(--dsw-alias-label-tertiary, #9ca3af); }
      .fiam-badge-authenticating {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        color: var(--dsw-alias-state-business-primary);
      }
      .fiam-badge-authenticating .fiam-badge-dot {
        background: var(--dsw-alias-state-business-primary);
        animation: fiam-pulse 1.4s ease-in-out infinite;
      }
      .fiam-badge-warn {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
        color: var(--dsw-alias-state-warn-primary);
      }
      .fiam-badge-warn .fiam-badge-dot { background: var(--dsw-alias-state-warn-primary); }
      .fiam-badge-error {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .fiam-badge-error .fiam-badge-dot { background: var(--dsw-alias-state-error-primary); }
      @keyframes fiam-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.85); }
      }
      .fiam-avatar {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        color: var(--dsw-alias-state-business-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fiam-callout {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 12px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03));
        border-radius: var(--dsw-radius-sm);
        color: var(--dsw-alias-label-secondary);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        margin-top: 10px;
      }
      .fiam-callout-icon {
        flex-shrink: 0;
        margin-top: 2px;
        color: var(--dsw-alias-label-tertiary);
      }
      .fiam-notice {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: var(--dsw-radius-sm);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        margin-top: 10px;
      }
      .fiam-notice-success {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
        color: var(--dsw-alias-state-success-primary);
      }
      .fiam-notice-warn {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
        color: var(--dsw-alias-state-warn-primary);
      }
      .fiam-notice-error {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .fiam-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 14px;
      }
      .fiam-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--dsw-alias-border-l3);
        border-top-color: var(--dsw-alias-state-business-primary);
        border-radius: 50%;
        animation: fiam-spin 0.8s linear infinite;
      }
      @keyframes fiam-spin {
        to { transform: rotate(360deg); }
      }

      .fiam-model-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 14px;
        margin-bottom: 14px;
      }
      .fiam-model-item {
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 8px);
        background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
        overflow: hidden;
        transition: border-color 0.15s ease;
      }
      .fiam-model-item:hover {
        border-color: var(--dsw-alias-border-l3);
      }
      .fiam-model-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        gap: 12px;
      }
      .fiam-model-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .fiam-model-name {
        font-weight: 600;
        font-size: var(--dsw-font-s-14);
        color: var(--dsw-alias-label-primary);
      }
      .fiam-model-id {
        font-family: monospace;
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
        padding: 1px 6px;
        border-radius: 4px;
      }
      .fiam-model-advanced {
        padding: 14px;
        border-top: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .fiam-field-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px;
      }
      .fiam-checkbox-group {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        margin-top: 4px;
      }
      .fiam-checkbox-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--dsw-font-xs-13);
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .fiam-checkbox-item input[type="checkbox"] {
        cursor: pointer;
        width: 15px;
        height: 15px;
        accent-color: var(--dsw-alias-state-business-primary);
      }
      .fiam-reasoning-chips {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 4px;
      }
      .fiam-chip {
        padding: 3px 10px;
        border-radius: 999px;
        font-size: var(--dsw-font-xxs-12);
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .fiam-chip:hover {
        border-color: var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-primary);
      }
      .fiam-chip-active {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        border-color: var(--dsw-alias-state-business-primary);
        color: var(--dsw-alias-state-business-primary);
        font-weight: 500;
      }
    `;
    const interactionStyle = () => h('style', null, interactionStyles);

    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
    const CAPACITY_SCALE = { k: 1000, m: 1000000 };

    function parseCapacity(text) {
      if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? Math.round(text) : undefined;
      if (typeof text !== 'string') return undefined;
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const match = CAPACITY_PATTERN.exec(trimmed);
      if (!match) return undefined;
      const suffix = match[2]?.toLowerCase();
      const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
      const scaled = Number(match[1]) * scale;
      return Number.isFinite(scaled) && scaled > 0 ? Math.round(scaled) : undefined;
    }

    function formatCapacity(value) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return typeof value === 'string' ? value : '';
      if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`;
      if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`;
      return String(value);
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hour12: false, timeZoneName: 'short',
      }).format(date);
    }

    const STATUS = {
      unconfigured: '企业登录尚未设置',
      'signed-out': '未登录',
      authenticating: '等待浏览器登录',
      ready: '已登录',
      expired: '授权已过期',
      unreachable: '暂时无法连接登录服务',
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

    async function getJson(path) {
      const response = await fetch(path);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
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
      unknown: '状态未知',
      unconfigured: '未保存',
      configured: '已保存',
      'owner-mismatch': '属于其他账号，请核对记录',
      invalid: '记录不一致，已保留',
    };

    function statusBadgeClass(state) {
      if (state === 'ready') return 'success';
      if (state === 'signed-out') return 'idle';
      if (state === 'authenticating') return 'authenticating';
      if (state === 'expired' || state === 'unconfigured') return 'warn';
      return 'error';
    }

    function gatewayBadgeClass(state) {
      if (state === 'configured') return 'success';
      if (state === 'unconfigured') return 'idle';
      if (state === 'unknown') return 'warn';
      return 'error';
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
      if (code === 'IAM_REQUEST_HEADER_REQUIRED') return '操作未完成，请刷新页面后重试。';
      if (code === 'IAM_UNCONFIGURED') return '企业登录尚未设置完成，请联系管理员。';
      if (code === 'IAM_CREDENTIALS_UNAVAILABLE') return '凭据存储不可用，暂时无法登录。';
      if (code === 'IAM_CREDENTIALS_CLEAR_FAILED') return '无法清除本设备的登录信息，请联系管理员。';
      if (code === 'IAM_REVOCATION_FAILED') return '已在此设备退出，但无法确认服务器已撤销登录。';
      if (code === 'IAM_EXCLUSIVE_CONFLICT') return '登录设置有冲突，请联系管理员。';
      if (code === 'IAM_UNREACHABLE') return '暂时无法连接登录服务，请稍后重试。';
      if (code === 'IAM_STATE_MISMATCH' || code === 'IAM_CALLBACK_INVALID') return '登录未能完成，请重新登录。';
      if (code === 'IAM_ATTEMPT_EXPIRED') return '登录尝试已过期，请重新登录。';
      if (code === 'IAM_INVALID_GRANT' || code === 'IAM_REAUTH_REQUIRED') return '登录已失效，请重新登录。';
      if (code === 'IAM_NOT_SIGNED_IN') return '请先登录企业账号。';
      if (code === 'IAM_ATTEMPT_CANCELLED') return '登录已取消，请重新登录。';
      if (code === 'IAM_CALLBACK_UNAVAILABLE') return '登录服务暂不可用，请刷新页面后重试。';
      if (code === 'IAM_CONFIG_INVALID') return '企业登录设置有误，请联系管理员。';
      if (code === 'IAM_DISPOSED') return '登录服务已关闭，请刷新页面。';
      if (code === 'IAM_GRANT_CONTEXT_MISMATCH' || code === 'IAM_REFRESH_SUBJECT_MISMATCH') return '登录状态已变化，请重新登录。';
      if (code === 'IAM_GATEWAY_KEY_INVALID') return '个人 Key 格式不正确，请完整复制网关提供的 Key 后重试。';
      if (code === 'IAM_GATEWAY_URL_INVALID') return '请输入有效的网关地址，例如 https://gateway.example/v1。';
      if (code === 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED') return '网关未接受个人 Key，请核对或更换后重试。';
      if (code === 'ENTERPRISE_GATEWAY_FORBIDDEN') return '当前账号没有模型使用权限，请联系管理员。';
      if (code === 'ENTERPRISE_MODEL_CATALOG_INVALID') return '网关返回的模型列表无法识别，请检查网关地址。';
      if (code === 'ENTERPRISE_GATEWAY_UNAVAILABLE' || code === 'ENTERPRISE_MODELS_UNAVAILABLE') return '暂时无法获取企业模型，请检查网关地址或稍后重试。';
      if (code === 'IAM_LOGIN_REQUIRED' || code === 'IAM_MODEL_CONTEXT_CHANGED') return '账号状态已变化，请重新登录后再试。';
      if (code === 'IAM_GATEWAY_OWNER_MISSING') return '请先登录企业账号，再添加个人凭证。';
      if (code === 'IAM_GATEWAY_ATOMIC_UNVERIFIED') return '暂时无法安全地保存或清除凭证，请联系管理员。';
      if (code === 'IAM_GATEWAY_LEGACY_READ_ONLY') return '现有凭证暂时只能查看，本次没有更改。如需更换，请联系管理员。';
      if (code === 'IAM_GATEWAY_CHANGED') return '凭证已发生变化，本次没有更改。请刷新页面后核对。';
      if (code === 'IAM_GATEWAY_WRITE_UNKNOWN') return '无法确认凭证是否已更改。请刷新页面查看状态，暂时不要重复操作。';
      if (code === 'IAM_REQUEST_INVALID') return '请求内容无效，请重试。';
      if (code === 'IAM_REQUEST_TOO_LARGE') return '请求过大，请检查粘贴内容。';
      if (code === 'IAM_UNAUTHENTICATED' || code === 'IAM_CONNECTION_UNAVAILABLE') return '页面会话不可用，请刷新页面后重试。';
      if (code === 'IAM_METHOD_NOT_ALLOWED' || code === 'IAM_NOT_FOUND') return '请求不受支持，请刷新页面。';
      return '操作未完成，请重试；如仍有问题，请联系管理员。';
    }

    const DIAGNOSTIC_ERRORS = new Set([
      'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_UNCONFIGURED', 'IAM_CONFIG_INVALID',
      'IAM_CREDENTIALS_UNAVAILABLE', 'IAM_CREDENTIALS_CLEAR_FAILED', 'IAM_REVOCATION_FAILED',
      'IAM_EXCLUSIVE_CONFLICT', 'IAM_UNREACHABLE', 'IAM_STATE_MISMATCH', 'IAM_CALLBACK_INVALID',
      'IAM_ATTEMPT_EXPIRED', 'IAM_INVALID_GRANT', 'IAM_REAUTH_REQUIRED', 'IAM_NOT_SIGNED_IN',
      'IAM_ATTEMPT_CANCELLED', 'IAM_CALLBACK_UNAVAILABLE', 'IAM_DISPOSED',
      'IAM_GRANT_CONTEXT_MISMATCH', 'IAM_REFRESH_SUBJECT_MISMATCH',
      'IAM_GATEWAY_KEY_INVALID', 'IAM_GATEWAY_OWNER_MISSING', 'IAM_REQUEST_HEADER_REQUIRED',
      'IAM_GATEWAY_ATOMIC_UNVERIFIED', 'IAM_GATEWAY_LEGACY_READ_ONLY',
      'IAM_GATEWAY_CHANGED', 'IAM_GATEWAY_WRITE_UNKNOWN',
      'IAM_REQUEST_INVALID', 'IAM_REQUEST_TOO_LARGE', 'IAM_UNAUTHENTICATED',
      'IAM_CONNECTION_UNAVAILABLE', 'IAM_METHOD_NOT_ALLOWED', 'IAM_NOT_FOUND',
      'IAM_REQUEST_FAILED', 'IAM_VIEW_FAILED',
    ]);

    // Build a new scalar object: the original view/state may contain private data.
    function diagnosticSnapshot(state) {
      const view = state.view;
      const code = view?.error ?? state.error;
      return {
        format: 'forge-iam-diagnostic', version: 1,
        pagePhase: ['loading', 'ready', 'error'].includes(state.phase) ? state.phase : 'unknown',
        iamState: typeof view?.state === 'string' && Object.hasOwn(STATUS, view.state) ? view.state : 'unknown',
        configured: typeof view?.configured === 'boolean' ? view.configured : null,
        signedIn: typeof view?.signedIn === 'boolean' ? view.signedIn : null,
        exclusive: view?.exclusive === 'ok' ? 'ok' : typeof view?.exclusive === 'string' && view.exclusive ? 'not-ok' : 'unknown',
        gatewayState: typeof view?.gatewayCredential?.state === 'string' && Object.hasOwn(GATEWAY_STATUS, view.gatewayCredential.state) ? view.gatewayCredential.state : 'unknown',
        errorCode: code == null ? null : DIAGNOSTIC_ERRORS.has(code) ? code : 'unknown',
        missingConfigCount: Array.isArray(view?.missing) ? view.missing.length : null,
      };
    }

    function useSessionPoll(enabled, update, barrierRef) {
      const updateRef = React.useRef(update);
      updateRef.current = update;
      React.useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        let inFlight = false;
        const apply = (view) => {
          const epoch = barrierRef?.current.epoch;
          if (!live || (barrierRef && (barrierRef.current.pending || barrierRef.current.epoch !== epoch))) return;
          updateRef.current(view);
        };
        // Prefer the Host's read-only stream; polling stays as the fallback so
        // a proxy that buffers event-stream responses cannot freeze the panel.
        let stream = null;
        let timer = null;
        const closeStream = () => {
          if (!stream) return;
          try { stream.close(); } catch { /* already closed */ }
          stream = null;
        };
        const openStream = () => {
          if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return false;
          try {
            stream = new window.EventSource('/api/forge-iam/events');
            stream.onmessage = (event) => {
              try { apply(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
            };
            stream.onerror = () => { closeStream(); startPolling(); };
            return true;
          } catch {
            stream = null;
            return false;
          }
        };
        const poll = async () => {
          if (inFlight) return;
          inFlight = true;
          const epoch = barrierRef?.current.epoch;
          try {
            const view = await fetchView();
            if (live && (!barrierRef || (!barrierRef.current.pending && barrierRef.current.epoch === epoch))) updateRef.current(view);
          } catch {
            // The next tick retries; a transient Host failure must not erase
            // the last known state.
          } finally {
            inFlight = false;
          }
        };
        const startPolling = () => { if (!timer) timer = setInterval(poll, 2000); };
        if (!openStream()) startPolling();
        return () => {
          live = false;
          closeStream();
          if (timer) clearInterval(timer);
        };
      }, [enabled]);
    }

    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, error: null, notice: null, authorizationUrl: null });
      const [credential, setCredential] = React.useState({ value: '', deviceLabel: '', saving: false, notice: null });
      const [modelOptions, setModelOptions] = React.useState(() => {
        try {
          const raw = window.localStorage.getItem('forge-iam.model-options.v1');
          return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
      });
      const [expandedModels, setExpandedModels] = React.useState({});
      const [modelSaving, setModelSaving] = React.useState(false);
      const [modelNotice, setModelNotice] = React.useState(null);

      const toggleModelExpand = (id) => {
        setExpandedModels(prev => ({ ...prev, [id]: !prev[id] }));
      };

      const updateOptionField = (id, field, value) => {
        setModelOptions(prev => {
          const modelOpt = { ...(prev[id] || {}) };
          if (value === undefined || value === '') {
            delete modelOpt[field];
          } else {
            modelOpt[field] = value;
          }
          const next = { ...prev };
          if (Object.keys(modelOpt).length === 0) delete next[id];
          else next[id] = modelOpt;
          return next;
        });
      };

      const resetModelOption = (id) => {
        setModelOptions(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setModelNotice(`已恢复 ${id} 为默认配置，保存后生效。`);
      };

      const saveModelOptions = async () => {
        if (viewBarrier.current.pending || modelSaving) return;
        setModelSaving(true);
        setModelNotice(null);
        try {
          try { window.localStorage.setItem('forge-iam.model-options.v1', JSON.stringify(modelOptions)); } catch {}
          const result = await putJson('/api/forge-iam/models', { options: modelOptions });
          if (!result.ok) {
            setModelNotice(errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'));
            return;
          }
          setModelNotice('模型精细化配置已保存并生效。');
          if (isViewCurrent(viewBarrier.current.epoch)) {
            setState(current => ({ ...current, view: result.body?.view ?? current.view }));
          }
        } catch {
          setModelNotice('暂时无法连接服务，配置已保存在本地。');
        } finally {
          setModelSaving(false);
        }
      };
      const viewBarrier = React.useRef({ epoch: 0, pending: false });
      const linkIdentity = React.useRef(null);
      const copyRequest = React.useRef(null);
      const copyLive = React.useRef(true);
      const [copy, setCopy] = React.useState({ pending: false, notice: null, epoch: null, url: null });
      React.useEffect(() => {
        copyLive.current = true;
        return () => { copyLive.current = false; copyRequest.current = null; };
      }, []);
      const isViewCurrent = (epoch) => !viewBarrier.current.pending && viewBarrier.current.epoch === epoch;

      const load = React.useCallback(async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
        try {
          const view = await fetchView();
          if (viewBarrier.current.pending || viewBarrier.current.epoch !== epoch) return;
          if (view?.state !== 'authenticating') linkIdentity.current = null;
          setState((current) => ({ ...current, phase: 'ready', view, error: null, ...(view?.state === 'authenticating' ? {} : { authorizationUrl: null }) }));
        } catch (error) {
          if (viewBarrier.current.pending || viewBarrier.current.epoch !== epoch) return;
          linkIdentity.current = null;
          setState({ phase: 'error', view: null, error: error.message, notice: null, authorizationUrl: null });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);
      useSessionPoll(true, (view) => {
        // Invalidate before enqueueing React state, not only on the next render.
        if (view?.state !== 'authenticating') linkIdentity.current = null;
        setState((current) => ({
          ...current, phase: 'ready', view, error: null,
          ...(view?.state === 'authenticating' ? {} : { authorizationUrl: null }),
        }));
      }, viewBarrier);

      const login = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        // A new explicit login invalidates acknowledgements of the old view.
        viewBarrier.current.epoch += 1;
        const epoch = viewBarrier.current.epoch;
        setState((current) => ({ ...current, notice: null }));
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!isViewCurrent(epoch)) {
            try { popup?.close(); } catch { /* already closed */ }
            return;
          }
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          const view = result.body?.view ?? null;
          const authorizationUrl = result.body?.authorizationUrl ?? null;
          linkIdentity.current = view?.state === 'authenticating' && typeof authorizationUrl === 'string' && authorizationUrl.trim() ? authorizationUrl : null;
          navigateLoginWindow(popup, authorizationUrl);
          setState((current) => ({ ...current, view, authorizationUrl, notice: null }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          if (isViewCurrent(epoch)) setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const saveCredential = async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
        const value = credential.value.trim();
        if (!value) {
          setCredential((current) => ({ ...current, notice: '请输入 UAG 个人凭证。' }));
          return;
        }
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', { key: value, deviceLabel: credential.deviceLabel.trim(),
            baseURL: (credential.baseURL ?? state.view?.gatewayCredential?.baseURL ?? state.view?.modelAccess?.baseURL ?? '').trim() });
          if (!result.ok) {
            setCredential((current) => ({
              ...current,
              saving: false,
              notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'),
            }));
            return;
          }
          // The value is never stored in component state after the write.
          setCredential({ value: '', deviceLabel: credential.deviceLabel, saving: false, notice: '网关地址和个人 Key 已保存，正在获取模型列表。' });
          if (isViewCurrent(epoch)) setState((current) => ({ ...current, view: result.body?.view ?? current.view }));
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const refreshModels = async () => {
        if (viewBarrier.current.pending || credential.saving) return;
        const epoch = viewBarrier.current.epoch;
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await getJson('/api/forge-iam/models');
          if (!isViewCurrent(epoch)) return;
          setCredential((current) => ({ ...current, saving: false, notice: result.ok
            ? `模型列表已更新，共 ${result.body?.models?.length ?? 0} 个模型。`
            : errorNotice(result.body?.error?.code) }));
          if (result.ok) setState((current) => ({ ...current, view: result.body?.view ?? current.view }));
        } catch { if (isViewCurrent(epoch)) setCredential((current) => ({ ...current, notice: '暂时无法获取模型列表，请稍后重试。' })); }
        finally { if (copyLive.current) setCredential((current) => ({ ...current, saving: false })); }
      };

      const clearCredential = async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
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
          if (isViewCurrent(epoch)) setState((current) => ({ ...current, view: result.body?.view ?? current.view }));
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const cancelLogin = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        const epoch = viewBarrier.current.epoch;
        try {
          const result = await postJson('/api/forge-iam/cancel');
          if (!isViewCurrent(epoch)) return;
          if (!result.ok) {
            setState((current) => ({ ...current, notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED') }));
            return;
          }
          setState((current) => ({ ...current, view: result.body?.view ?? null, authorizationUrl: null, notice: null }));
        } catch {
          if (isViewCurrent(epoch)) setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const signOut = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        viewBarrier.current.epoch += 1;
        viewBarrier.current.pending = true;
        setState((current) => ({ ...current, view: null, authorizationUrl: null, notice: '正在退出…' }));
        try {
          const result = await postJson('/api/forge-iam/sign-out');
          if (!result.ok) {
            setState((current) => ({
              ...current,
              view: result.body?.view ?? null,
              authorizationUrl: null,
              notice: errorNotice(result.body?.error?.code ?? 'IAM_REQUEST_FAILED'),
            }));
            return;
          }
          const view = result.body?.view ?? null;
          setState((current) => ({
            ...current,
            view,
            authorizationUrl: null,
            // An unconfirmed revocation must stay attributable after the local
            // session is gone; silently showing "signed out" would overclaim.
            notice: view?.error ? errorNotice(view.error) : null,
          }));
          if (result.body?.logoutUrl) window.location.assign(result.body.logoutUrl);
        } catch {
          setState((current) => ({ ...current, view: null, authorizationUrl: null, notice: '无法连接服务，退出结果未确认。请刷新页面查看登录状态。' }));
        } finally {
          viewBarrier.current.epoch += 1;
          viewBarrier.current.pending = false;
        }
      };

      const copyText = async (text, url = null) => {
        if (!copyLive.current || viewBarrier.current.pending || copyRequest.current) return;
        const request = {};
        const epoch = viewBarrier.current.epoch;
        const isCurrent = () => copyLive.current && isViewCurrent(epoch)
          && (!url || linkIdentity.current === url);
        copyRequest.current = request;
        setCopy({ pending: true, notice: null, epoch, url });
        try {
          const clipboard = window.navigator?.clipboard;
          if (typeof clipboard?.writeText !== 'function') throw new Error('unavailable');
          // Invoke before any await to retain the browser's user activation.
          const receipt = clipboard.writeText(text);
          if (!receipt || typeof receipt.then !== 'function') throw new Error('unconfirmed');
          await receipt;
          if (isCurrent()) setCopy((current) => ({ ...current, notice: url
            ? '登录链接已复制，请勿转发给他人。' : '问题信息已复制，反映复制时的状态，不含账号和凭证。' }));
        } catch {
          if (isCurrent()) setCopy((current) => ({ ...current, notice: '未确认复制，请检查浏览器剪贴板权限；页面内容已保留。' }));
        } finally {
          if (copyRequest.current === request) {
            copyRequest.current = null;
            if (copyLive.current) setCopy((current) => ({ ...current, pending: false }));
          }
        }
      };
      const copyLink = () => {
        const url = linkIdentity.current;
        if (!url || url !== state.authorizationUrl || state.view?.state !== 'authenticating') return;
        return copyText(url, url);
      };
      const copyDiagnostic = () => copyText(JSON.stringify(diagnosticSnapshot(state)));

      const box = { padding: '0 0 24px', maxWidth: 680, color: 'var(--dsw-alias-label-primary)', font: 'var(--dsw-font-s-14)' };
      const button = secondaryButton;
      const muted = { color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-12)' };
      const header = h('div', { style: { marginBottom: 16 } },
        h('div', { style: { font: 'var(--dsw-font-m-18)', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '企业账号'),
        h('div', { style: { ...muted, marginTop: 4 } }, '管理企业统一身份登录与模型使用凭证'),
      );
      const copyTools = h('div', { className: 'fiam-actions' },
        state.view?.state === 'authenticating' && linkIdentity.current && state.authorizationUrl === linkIdentity.current
          ? h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyLink }, '复制登录链接') : null,
        h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyDiagnostic }, '复制问题信息'),
        copy.notice && isViewCurrent(copy.epoch) && (!copy.url || copy.url === linkIdentity.current)
          ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, copy.notice) : null,
      );

      if (state.phase === 'loading') {
        return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
          header,
          h('div', { className: 'fiam-card', style: { padding: '28px 20px', textAlign: 'center' } },
            h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 } },
              h('div', { className: 'fiam-spinner' }),
              h('div', { style: muted }, '正在读取登录状态…'),
            )
          ),
          copyTools,
        );
      }
      if (state.phase === 'error') {
        return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
          header,
          h('div', { className: 'fiam-card', style: { padding: '24px 20px' } },
            h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 14 } },
              h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', color: 'var(--dsw-alias-state-error-primary)' } },
                h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                  h('circle', { cx: 10, cy: 10, r: 8 }),
                  h('path', { d: 'M10 6v5m0 3h.01' })
                )
              ),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 4 } }, '无法读取登录状态。'),
                h('div', { style: muted }, errorNotice(state.error)),
                h('div', { className: 'fiam-actions', style: { marginTop: 14 } },
                  h('button', { type: 'button', style: primaryButton, onClick: load }, '重试'),
                  h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyDiagnostic }, '复制问题信息'),
                )
              )
            )
          ),
          copyTools,
        );
      }

      const view = state.view ?? {};
      const label = STATUS[view.state] ?? '未知状态';
      const missing = Array.isArray(view.missing) && view.missing.length
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, '企业登录设置不完整，请联系管理员。')
        : null;
      const principal = view.principal ? h('div', { style: muted }, `账号标识：${view.principal}`) : null;
      const expiry = view.accessExpiresAt ? h('div', { style: muted }, `当前访问授权到期：${formatTime(view.accessExpiresAt)}`) : null;
      const exclusive = view.exclusive && view.exclusive !== 'ok'
        ? h('div', { className: 'fiam-notice fiam-notice-error' }, '登录设置有冲突，请联系管理员。')
        : null;
      const hostError = view.error
        ? h('div', { className: 'fiam-notice fiam-notice-error' }, errorNotice(view.error))
        : null;
      const notice = state.notice && (!view.error || state.notice !== errorNotice(view.error))
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, state.notice) : null;
      const loginLink = state.authorizationUrl
        ? h('div', { style: { marginTop: 8 } }, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录'))
        : null;

      const gateway = view.gatewayCredential ?? { state: 'unknown' };
      const gatewayStatus = GATEWAY_STATUS[gateway.state] ?? '状态未知';
      const gatewayDetails = [
        gateway.deviceLabel ? `设备：${gateway.deviceLabel}` : null,
        gateway.enteredAt ? `录入：${formatTime(gateway.enteredAt)}` : null,
        gateway.suggestedExpiry ? `建议到期：${gateway.suggestedExpiry}` : null,
      ].filter(Boolean);
      const storageWarning = gateway.state === 'configured' && gateway.storage && gateway.storage !== 'keychain'
        ? h('div', { className: 'fiam-notice fiam-notice-warn' },
            '凭证未使用系统安全存储，请联系管理员。')
        : null;

      const accountCard = h('div', { className: 'fiam-card' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar' },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('path', { d: 'M16 17v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 15.5V17' }),
                h('circle', { cx: 10, cy: 7, r: 3 })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, view.state === 'ready' && view.principal ? view.principal : '企业账号认证'),
              h('div', { className: 'fiam-card-subtitle' }, view.state === 'ready' ? '已绑定企业 OIDC 身份' : '单点登录至企业账号'),
            ),
          ),
          h('span', { className: `fiam-badge fiam-badge-${statusBadgeClass(view.state)}` },
            h('span', { className: 'fiam-badge-dot' }),
            label,
          ),
        ),
        (view.principal || view.accessExpiresAt) ? h('div', { style: { padding: '10px 14px', background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02))', borderRadius: 'var(--dsw-radius-sm)', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 } },
          principal,
          expiry,
        ) : null,
        missing,
        exclusive,
        hostError,
        notice,
        loginLink,
        view.state === 'authenticating' && !state.authorizationUrl
          ? h('div', { className: 'fiam-callout' }, '请在浏览器中完成登录；如果无法继续，请取消后重试。') : null,
        h('div', { className: 'fiam-actions' },
          view.canSignIn ? h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, onClick: login }, '登录企业账号') : null,
          view.state === 'authenticating' ? h('button', { type: 'button', style: button, onClick: cancelLogin }, '取消登录') : null,
          h('button', { type: 'button', style: button, disabled: viewBarrier.current.pending, onClick: load }, '刷新'),
          view.canSignOut ? h('button', { type: 'button', style: button, onClick: signOut }, '退出') : null,
          state.view?.state === 'authenticating' && linkIdentity.current && state.authorizationUrl === linkIdentity.current
            ? h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyLink }, '复制登录链接') : null,
          h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyDiagnostic }, '复制问题信息'),
        ),
        copy.notice && isViewCurrent(copy.epoch) && (!copy.url || copy.url === linkIdentity.current)
          ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, copy.notice) : null,
      );

      const gatewayCard = h('div', { className: 'fiam-card' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)', color: 'var(--dsw-alias-state-business-primary)' } },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('path', { d: 'M10 2s6 2.5 6 7c0 4.5-3.5 7.5-6 9-2.5-1.5-6-4.5-6-9 0-4.5 6-7 6-7Z' }),
                h('path', { d: 'm7.5 10 2 2 3.5-3.5' })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, '模型使用凭证'),
              h('div', { className: 'fiam-card-subtitle' }, '配置用于大模型请求的 UAG 凭证'),
            ),
          ),
          h('span', { className: `fiam-badge fiam-badge-${gatewayBadgeClass(gateway.state)}` },
            h('span', { className: 'fiam-badge-dot' }),
            `UAG 个人凭证：${gatewayStatus}`,
          ),
        ),
        h('label', { style: fieldLabel },
          h('span', null, '网关地址'),
          h('input', { type: 'url', 'aria-label': '网关地址', autoComplete: 'off',
            value: credential.baseURL ?? gateway.baseURL ?? view.modelAccess?.baseURL ?? '',
            placeholder: 'https://gateway.example/v1', disabled: credential.saving || viewBarrier.current.pending,
            onChange: (event) => setCredential((current) => ({ ...current, baseURL: event.target.value })), style: inputStyle }),
          h('span', { style: muted }, '填写网关提供的地址；修改地址时请重新输入对应的个人 Key。'),
        ),
        credential.value || (credential.baseURL !== undefined && credential.baseURL !== (gateway.baseURL ?? view.modelAccess?.baseURL ?? ''))
          ? h('p', { role: 'status', style: muted }, '有未保存的更改。保存后将重新获取模型列表。') : null,
        gatewayDetails.length ? h('div', { style: { ...muted, marginBottom: 8 } }, gatewayDetails.join(' · ')) : null,
        storageWarning,
        h('div', { className: 'fiam-callout' },
          h('svg', { className: 'fiam-callout-icon', viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
            h('circle', { cx: 8, cy: 8, r: 6 }),
            h('path', { d: 'M8 7v4m0-6h.01' })
          ),
          h('div', null,
            gateway.state === 'configured'
              ? 'UAG 个人凭证已保存且不会显示。保存凭证不代表模型已连接或可用。'
              : gateway.state === 'unknown'
                ? '网关凭据状态尚未确认，请刷新核实。'
                : gateway.state === 'unconfigured'
                  ? '到 UAG 控制台为这台设备创建个人凭证（名称建议包含设备名，有效期建议 90 天），粘贴到下方。'
                  : '请先核对现有凭证；如有疑问，请联系管理员。',
            gateway.state === 'unconfigured' && view.gatewayConsoleUrl
              ? h('div', { style: { marginTop: 4 } },
                  h('a', { href: view.gatewayConsoleUrl, target: '_blank', rel: 'noreferrer' }, '打开 UAG 控制台创建凭据 ↗')
                )
              : null
          )
        ),
        h('div', { style: { marginTop: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { style: { ...fieldLabel, flex: '2 1 240px' } },
            h('span', { style: { fontWeight: 500, fontSize: 13 } }, 'UAG 个人凭证'),
            h('input', {
              type: 'password',
              value: credential.value,
              placeholder: gateway.state === 'configured' ? '已保存，输入新凭证可更换' : '粘贴 UAG 个人凭证',
              'aria-label': 'UAG 个人凭证',
              autoComplete: 'off',
              spellCheck: false,
              disabled: credential.saving || viewBarrier.current.pending,
              onChange: (event) => setCredential((current) => ({ ...current, value: event.target.value })),
              style: inputStyle,
            })
          ),
          h('label', { style: { ...fieldLabel, flex: '1 1 150px' } },
            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '设备标签（可选）'),
            h('input', {
              type: 'text',
              value: credential.deviceLabel,
              placeholder: '设备标签（可选）',
              'aria-label': '设备标签',
              maxLength: 64,
              disabled: credential.saving || viewBarrier.current.pending,
              onChange: (event) => setCredential((current) => ({ ...current, deviceLabel: event.target.value })),
              style: inputStyle,
            })
          ),
        ),
        h('div', { className: 'fiam-actions' },
          h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, disabled: credential.saving || viewBarrier.current.pending, onClick: saveCredential }, credential.saving ? '正在处理…' : '保存凭据'),
          (gateway.state !== 'unconfigured' && gateway.state !== 'unknown') || credential.value
            ? h('button', { type: 'button', style: secondaryButton, disabled: credential.saving || viewBarrier.current.pending, onClick: clearCredential }, '清除凭据')
            : null,
        ),
        credential.notice
          ? h('div', {
              role: 'status',
              'aria-live': 'polite',
              className: `fiam-notice fiam-notice-${credential.notice.includes('已保存') || credential.notice.includes('已清除') ? 'success' : 'warn'}`,
            }, credential.notice)
          : null,
      );

      const modelList = view.modelAccess?.models ?? [];
      const modelsCard = h('section', { className: 'fiam-card', 'aria-label': '企业模型' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)', color: 'var(--dsw-alias-state-business-primary)' } },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('rect', { x: 3, y: 3, width: 14, height: 14, rx: 2 }),
                h('path', { d: 'M7 8h6M7 12h4' })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, '企业模型设置'),
              h('div', { className: 'fiam-card-subtitle' }, view.modelAccess?.configured
                ? `网关目录同步（共 ${modelList.length} 个模型可用）`
                : '配置网关地址和凭证后自动同步可用模型'),
            ),
          ),
          view.modelAccess?.state === 'ready'
            ? h('span', { className: 'fiam-badge fiam-badge-success' },
                h('span', { className: 'fiam-badge-dot' }),
                `已同步 ${modelList.length} 个模型`
              )
            : null,
        ),
        h('p', { style: muted }, view.modelAccess?.configured
          ? '企业模型目录实时通过网关 /v1/models 获取。您可在下方对单个模型微调上下文窗口、Token 限制以及开启图片模态，个性化配置仅保存在本地设备。'
          : '请先在上方设置网关地址和个人 Key。保存后将自动获取授权模型。'),
        view.modelAccess?.configured && modelList.length > 0
          ? h('div', { className: 'fiam-model-list', 'aria-label': '企业预置模型' },
              ...modelList.map((model, idx) => {
                const opt = modelOptions[model.id] || {};
                const isExpanded = Boolean(expandedModels[model.id]);
                const displayName = opt.name || model.name || model.id;
                const contextVal = opt.contextWindow !== undefined ? opt.contextWindow : formatCapacity(model.contextWindow ?? 32768);
                const maxTokensVal = opt.maxTokens !== undefined ? opt.maxTokens : formatCapacity(model.maxTokens ?? 4096);
                const currentModalities = Array.isArray(opt.inputModalities) ? opt.inputModalities : (model.inputModalities ?? ['text']);
                const hasImage = currentModalities.includes('image');
                const hasReasoning = Boolean(opt.reasoningEfforts && Object.keys(opt.reasoningEfforts).length > 0) || Boolean(model.reasoningEfforts);
                const hasCustom = Boolean(modelOptions[model.id] && Object.keys(modelOptions[model.id]).length > 0);

                return h('div', { key: model.id, className: 'fiam-model-item' },
                  h('div', { className: 'fiam-model-row' },
                    h('div', { className: 'fiam-model-info' },
                      h('span', { className: 'fiam-model-name' }, displayName),
                      h('span', { className: 'fiam-model-id' }, model.id),
                      h('span', { className: 'fiam-badge' }, `${contextVal} 上下文`),
                      hasImage ? h('span', { className: 'fiam-badge fiam-badge-success' }, '视觉图片') : null,
                      hasReasoning ? h('span', { className: 'fiam-badge fiam-badge-authenticating' }, '深度推理') : null,
                      hasCustom ? h('span', { className: 'fiam-badge fiam-badge-warn' }, '已个性化') : null,
                    ),
                    h('button', {
                      type: 'button',
                      style: { ...secondaryButton, minHeight: 26, padding: '0 8px', fontSize: 12 },
                      'aria-expanded': isExpanded,
                      'aria-label': `配置 ${model.id}`,
                      onClick: () => toggleModelExpand(model.id),
                    }, isExpanded ? '收起配置 ▲' : '精细配置 ▼')
                  ),
                  isExpanded
                    ? h('div', { className: 'fiam-model-advanced' },
                        h('div', { className: 'fiam-field-grid' },
                          h('label', { style: fieldLabel },
                            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '显示名称'),
                            h('input', {
                              type: 'text',
                              style: inputStyle,
                              placeholder: model.id,
                              value: opt.name ?? '',
                              'aria-label': `显示名称 ${idx + 1}`,
                              onChange: (e) => updateOptionField(model.id, 'name', e.target.value),
                            }),
                            h('span', { style: muted }, '留空时使用模型 ID'),
                          ),
                          h('label', { style: fieldLabel },
                            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '上下文窗口 (Context Window)'),
                            h('input', {
                              type: 'text',
                              style: inputStyle,
                              placeholder: formatCapacity(model.contextWindow ?? 32768),
                              value: opt.contextWindow ?? '',
                              'aria-label': `上下文窗口 ${idx + 1}`,
                              onChange: (e) => updateOptionField(model.id, 'contextWindow', e.target.value),
                            }),
                            h('span', { style: muted }, '输入数字或 K/M，如 128K、131072'),
                          ),
                          h('label', { style: fieldLabel },
                            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '最大输出 Token (Max Tokens)'),
                            h('input', {
                              type: 'text',
                              style: inputStyle,
                              placeholder: formatCapacity(model.maxTokens ?? 4096),
                              value: opt.maxTokens ?? '',
                              'aria-label': `最大输出 Token ${idx + 1}`,
                              onChange: (e) => updateOptionField(model.id, 'maxTokens', e.target.value),
                            }),
                            h('span', { style: muted }, '输入数字或 K，如 8192、8K'),
                          ),
                        ),
                        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                          h('span', { style: { fontWeight: 500, fontSize: 13 } }, '输入模态与能力'),
                          h('div', { className: 'fiam-checkbox-group' },
                            h('label', { className: 'fiam-checkbox-item' },
                              h('input', { type: 'checkbox', checked: true, disabled: true }),
                              h('span', null, '文本 (Text)')
                            ),
                            h('label', { className: 'fiam-checkbox-item' },
                              h('input', {
                                type: 'checkbox',
                                checked: hasImage,
                                'aria-label': `图片输入模态 ${idx + 1}`,
                                onChange: (e) => {
                                  const checked = e.target.checked;
                                  const next = checked ? ['text', 'image'] : ['text'];
                                  updateOptionField(model.id, 'inputModalities', next);
                                },
                              }),
                              h('span', null, '图片附件 (Vision / Image)')
                            ),
                          ),
                        ),
                        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                          h('span', { style: { fontWeight: 500, fontSize: 13 } }, '推理强度等级 (Reasoning Effort)'),
                          h('div', { className: 'fiam-reasoning-chips' },
                            ...['off', 'low', 'medium', 'high'].map(level => {
                              const activeLevel = opt.reasoningEfforts
                                ? (Object.keys(opt.reasoningEfforts).find(k => k !== 'off') || 'off')
                                : 'off';
                              const isSelected = activeLevel === level;
                              const labelMap = { off: '关闭推理 (Off)', low: '轻度 (Low)', medium: '中度 (Medium)', high: '深度思考 (High)' };
                              return h('button', {
                                key: level,
                                type: 'button',
                                className: `fiam-chip ${isSelected ? 'fiam-chip-active' : ''}`,
                                onClick: () => {
                                  if (level === 'off') {
                                    updateOptionField(model.id, 'reasoningEfforts', undefined);
                                  } else {
                                    updateOptionField(model.id, 'reasoningEfforts', { off: null, [level]: level });
                                  }
                                },
                              }, labelMap[level]);
                            })
                          ),
                          h('span', { style: muted }, '适用于支持显式思考过程的模型（如 DeepSeek-R1、o1 等）'),
                        ),
                        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 } },
                          hasCustom
                            ? h('button', {
                                type: 'button',
                                style: { ...secondaryButton, minHeight: 26, fontSize: 12 },
                                onClick: () => resetModelOption(model.id),
                              }, '恢复默认')
                            : null
                        )
                      )
                    : null
                );
              })
            )
          : null,
        view.modelAccess?.state === 'loading' ? h('p', { role: 'status', style: muted }, '正在获取模型列表…') : null,
        view.modelAccess?.state === 'ready' && !modelList.length
          ? h('p', { role: 'status', style: muted }, '网关没有返回可用模型，请检查个人 Key 的模型权限。') : null,
        view.modelAccess?.error ? h('p', { role: 'status', style: muted }, errorNotice(view.modelAccess.error)) : null,
        h('div', { className: 'fiam-actions' },
          h('button', {
            type: 'button',
            style: secondaryButton,
            disabled: credential.saving || modelSaving || viewBarrier.current.pending || view.state !== 'ready' || gateway.state !== 'configured',
            onClick: refreshModels,
          }, credential.saving ? '正在处理…' : '刷新模型列表'),
          h('button', {
            type: 'button',
            className: 'forge-iam-primary',
            style: primaryButton,
            disabled: modelSaving || viewBarrier.current.pending || view.state !== 'ready' || gateway.state !== 'configured',
            onClick: saveModelOptions,
          }, modelSaving ? '正在保存…' : '保存模型配置'),
        ),
        modelNotice
          ? h('div', {
              role: 'status',
              'aria-live': 'polite',
              className: `fiam-notice fiam-notice-${modelNotice.includes('保存') || modelNotice.includes('生效') || modelNotice.includes('恢复') ? 'success' : 'warn'}`,
            }, modelNotice)
          : null,
        h('p', { style: { ...muted, marginTop: 12 } }, view.state !== 'ready' ? '下一步：登录企业账号。'
          : gateway.state !== 'configured' || gateway.matchesAccount === false ? '下一步：在上方保存当前账号的个人凭证。'
          : '保存模型精细化配置后本地立即生效。在对话窗口可直接选用各模型；实际可用权限以企业网关授权为准。'),
      );

      return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
        header,
        accountCard,
        gatewayCard,
        modelsCard,
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
        unconfigured: '企业登录尚未设置',
        expired: '登录已过期，请重新登录',
        unreachable: '暂时无法连接登录服务，现有授权保留至到期',
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
        ...(view?.state === 'authenticating' ? {} : { authorizationUrl: null }),
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
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
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
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      if (!state.visible) return null;
      return h('div', {
        className: 'forge-iam-ui',
        style: {
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 900,
          pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8,
          boxSizing: 'border-box', maxWidth: 'calc(100vw - 24px)',
          padding: '6px 14px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l2)',
          color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-elevation-prominent)', font: 'var(--dsw-font-xs-13)',
        },
      },
      interactionStyle(),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { className: 'fiam-badge-dot', style: { background: state.reason === 'gateway' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)' } }),
        state.reason === 'gateway'
          ? (state.gateway === 'owner-mismatch' ? '个人凭证属于其他账号'
            : state.gateway === 'invalid' ? '个人凭证信息需要检查，已保留'
              : '无法使用模型：尚未保存 UAG 个人凭证')
          : (SESSION_LABEL[state.sessionState] ?? '尚未登录企业账号'),
      ),
      state.reason === 'gateway'
        ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, state.gateway === 'owner-mismatch' || state.gateway === 'invalid'
          ? '到“设置 → 企业账号”核对现有记录'
          : '到“设置 → 企业账号”录入 UAG 个人凭证')
        : null,
      state.reason !== 'gateway' && state.view?.canSignIn
        ? h('button', { type: 'button', style: { ...secondaryButton, minHeight: 28, padding: '0 10px' }, onClick: login }, '登录')
        : null,
      state.view?.state === 'authenticating'
        ? h('button', { type: 'button', style: { ...secondaryButton, minHeight: 28, padding: '0 10px' }, onClick: cancelLogin }, '取消')
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
      const savingRef = React.useRef(false);

      const close = async (marker) => {
        if (savingRef.current) return;
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
        let timer = null;
        const marker = readMarker();
        if (marker === 'done' || marker === 'skipped') return () => { live = false; };
        const attempt = () => {
          fetchView()
            .then((view) => {
              if (!live) return;
              setState((current) => ({ ...current, phase: 'ready', view, step: 0, notice: null, open: view.state === 'signed-out', authorizationUrl: null }));
            })
            .catch(() => {
              if (!live) return;
              // A transient failure at first paint must not silently disable
              // onboarding (and its completion marker) for the whole page load.
              setState((current) => ({ ...current, phase: 'ready' }));
              timer = setTimeout(attempt, 3000);
            });
        };
        attempt();
        return () => { live = false; if (timer) clearTimeout(timer); };
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
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const saveCredential = async () => {
        if (savingRef.current) return;
        const value = state.keyValue.trim();
        if (!value) {
          setState((current) => ({ ...current, notice: '请输入 UAG 个人凭证。' }));
          return;
        }
        savingRef.current = true;
        setState((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', {
            key: value,
            baseURL: (state.baseURL ?? state.view?.gatewayCredential?.baseURL ?? state.view?.modelAccess?.baseURL ?? '').trim(),
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
          void getJson('/api/forge-iam/models').then((m) => {
            if (m.ok && m.body?.view) {
              setState((current) => ({ ...current, view: m.body.view }));
            }
          }).catch(() => {});
        } catch {
          setState((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        } finally {
          savingRef.current = false;
        }
      };

      const gatewayState = state.view?.gatewayCredential?.state ?? 'unknown';
      const completionTitle = gatewayState === 'configured'
        ? (state.view?.state === 'ready' ? '准备就绪' : '请先登录企业账号')
        : gatewayState === 'unconfigured'
          ? (state.view?.state === 'ready' ? '登录完成，尚未配置凭据' : '尚未保存 UAG 个人凭证')
          : '请检查凭证状态';
      const completionBody = gatewayState === 'configured'
        ? (state.view?.state === 'ready'
          ? 'UAG 个人凭证已保存。可在“设置 → 企业账号”中查看状态、更换或清除。模型能否使用仍取决于你的权限。'
          : 'UAG 个人凭证已保存。请前往“设置 → 企业账号”登录后继续。')
        : gatewayState === 'unconfigured'
          ? 'UAG 个人凭证尚未保存，模型暂不可用。可稍后前往“设置 → 企业账号”登录并配置凭证。'
          : gatewayState === 'owner-mismatch'
            ? '现有凭证属于其他账号，已为你保留。请前往“设置 → 企业账号”核对。'
            : gatewayState === 'invalid'
              ? '现有凭证信息需要检查，已为你保留。请前往“设置 → 企业账号”核对。'
              : '无法确认凭证是否已保存。请前往“设置 → 企业账号”刷新后查看。';
      const steps = [
        {
          title: '欢迎使用企业版',
          body: '登录企业账号并完成配置后，即可使用已授权的模型和工具。也可以先跳过，稍后在“设置 → 企业账号”中登录。',
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
          title: '添加 UAG 个人凭证',
          body: '使用企业模型还需要 UAG 个人凭证。请在 UAG 控制台为这台设备创建凭证，然后粘贴到下方。',
          primary: '保存并继续',
          onPrimary: saveCredential,
        },
        {
          title: completionTitle,
          body: completionBody,
          primary: '完成',
          // Without a configured credential the model is not usable; record the
          // skip rather than claiming onboarding completed.
          onPrimary: () => close(state.view?.state === 'ready' && gatewayState === 'configured' ? 'done' : 'skipped'),
        },
      ];
      const step = steps[state.step] ?? steps[0];
      const overlay = {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--dsw-alias-bg-mask-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        // shell.overlay is click-through; an interactive surface must opt back
        // into pointer events or every click falls through to the app below.
        pointerEvents: 'auto',
      };
      const card = {
        boxSizing: 'border-box', width: 'min(520px, 100%)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-lg)', padding: 28,
        boxShadow: 'var(--dsw-elevation-panel)', font: 'var(--dsw-font-s-14)',
      };

      return h('div', { className: 'forge-iam-ui', style: overlay, role: 'presentation' }, interactionStyle(),
        h('div', { ref: dialogRef, tabIndex: -1, style: card, role: 'dialog', 'aria-modal': 'true', 'aria-label': step.title },
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-strong-12)' } }, `步骤 ${state.step + 1} / 4`),
          h('div', { 'aria-hidden': 'true', style: { display: 'flex', gap: 6, marginTop: 10, marginBottom: 24 } },
            ...steps.map((_, index) => h('span', { key: index, style: {
              height: 3, flex: 1, borderRadius: 'var(--dsw-radius-xs)',
              background: index <= state.step ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-border-l3)',
            } }))),
          h('div', { 'aria-hidden': 'true', style: { display: 'flex', gap: 6, marginTop: -16, marginBottom: 20, color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-12)' } },
            ...['欢迎', '登录', '凭据', '完成'].map((label, index) => h('span', { key: label, style: { flex: 1, color: index === state.step ? 'var(--dsw-alias-label-primary)' : undefined } }, label))),
          h('h2', { style: { margin: '0 0 10px', font: 'var(--dsw-font-l-20)' } }, step.title),
          h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', maxWidth: '42em' } }, step.body),
          state.step === 3 && state.view?.modelAccess?.models?.length
            ? h('div', { style: { marginTop: 14 } },
                h('div', { style: { fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--dsw-alias-label-primary)' } }, '已连接企业网关可用模型：'),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  ...state.view.modelAccess.models.map((m) => h('span', { key: m.id, className: 'fiam-badge fiam-badge-success' }, m.name || m.id))
                )
              )
            : null,
          state.step === 2
          ? h('div', { style: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
              h('label', { style: fieldLabel },
                h('span', null, '网关地址'),
                h('input', { type: 'url', 'aria-label': '网关地址', autoComplete: 'off',
                  value: state.baseURL ?? state.view?.gatewayCredential?.baseURL ?? state.view?.modelAccess?.baseURL ?? '',
                  placeholder: 'https://gateway.example/v1', disabled: state.saving,
                  onChange: (event) => setState((current) => ({ ...current, baseURL: event.target.value })), style: inputStyle }),
              ),
              h('label', { style: fieldLabel }, 'UAG 个人凭证', h('input', {
                  type: 'password',
                  value: state.keyValue,
                  placeholder: '输入网关提供的个人 Key',
                  'aria-label': 'UAG 个人凭证',
                  autoComplete: 'off',
                  spellCheck: false,
                disabled: state.saving,
                  onChange: (event) => setState((current) => ({ ...current, keyValue: event.target.value })),
                  style: inputStyle,
              })),
              h('label', { style: fieldLabel }, '设备标签（可选）', h('input', {
                  type: 'text',
                  value: state.deviceLabel,
                  placeholder: '设备标签（可选，例如 工作站-01）',
                  'aria-label': '设备标签',
                  maxLength: 64,
                disabled: state.saving,
                  onChange: (event) => setState((current) => ({ ...current, deviceLabel: event.target.value })),
                  style: inputStyle,
              })),
                state.view?.gatewayConsoleUrl
                  ? h('a', { href: state.view.gatewayConsoleUrl, target: '_blank', rel: 'noreferrer' }, '打开 UAG 控制台创建凭据')
                  : null,
                h('div', { style: { color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-12)' } }, '创建时建议开启隐私保护，并设置 90 天有效期。'),
              )
            : null,
          state.notice ? h('p', { role: 'status', 'aria-live': 'polite', style: { margin: '12px 0 0', color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
          state.authorizationUrl ? h('p', null, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录')) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 24 } },
            h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, disabled: state.saving, onClick: step.onPrimary }, state.saving ? '正在保存…' : step.primary),
            state.step < 3
              ? h('button', { type: 'button', style: secondaryButton, disabled: state.saving, onClick: () => {
                if (savingRef.current) return;
                return state.step === 2
                  ? setState((current) => ({ ...current, step: 3, notice: null }))
                  : close('skipped');
              } }, state.step === 2 ? '稍后配置' : '跳过')
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
