window.__ModuleLoader__.load({
  id: '@heluo/forge-iam',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ONBOARDING_KEY = 'forge-iam.onboarding.v1';

    const STATUS = {
      unconfigured: 'IAM 未配置',
      'signed-out': '未登录',
      authenticating: '登录中',
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
        // Storage may be unavailable in a hardened profile; the modal still
        // works for this session and does not fall back to a file.
      }
    }

    async function fetchView() {
      const response = await fetch('/api/forge-iam/view');
      const view = await readJson(response);
      if (!response.ok) throw new Error(view?.error?.code ?? 'IAM_VIEW_FAILED');
      return view;
    }

    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, error: null, notice: null });

      const load = React.useCallback(async () => {
        try {
          setState({ phase: 'ready', view: await fetchView(), error: null, notice: null });
        } catch (error) {
          setState({ phase: 'error', view: null, error: error.message, notice: null });
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const act = async (path) => {
        setState((current) => ({ ...current, notice: null }));
        try {
          const response = await fetch(path, { method: 'POST' });
          const body = await readJson(response);
          if (!response.ok) {
            const code = body?.error?.code ?? 'IAM_REQUEST_FAILED';
            setState((current) => ({
              ...current,
              notice: code === 'IAM_NOT_IMPLEMENTED' ? '登录链路尚未接入 IAM 契约，当前不会伪造登录。' : `操作失败：${code}`,
            }));
            return;
          }
          setState({ phase: 'ready', view: body, error: null, notice: null });
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
      const exclusive = view.exclusive === 'exclusive-violation'
        ? h('div', { style: { color: '#b42318', marginTop: 4 } }, '官方登录服务仍挂载，企业登录不可用；请修正企业组合包。')
        : null;
      const notice = state.notice ? h('div', { style: { marginTop: 8, color: '#8a5a00' } }, state.notice) : null;

      return h('div', { style: box }, header,
        h('div', null, label),
        missing,
        principal,
        expiry,
        exclusive,
        notice,
        h('div', null,
          h('button', { style: button, onClick: load }, '刷新'),
          view.canSignIn ? h('button', { style: button, onClick: () => act('/api/forge-iam/sign-in') }, '登录企业账号') : null,
          view.signedIn ? h('button', { style: button, onClick: () => act('/api/forge-iam/sign-out') }, '退出') : null,
        ),
        h('div', { style: { ...muted, marginTop: 8 } }, '页面只显示非敏感状态；令牌不会进入 UI 或日志。'),
      );
    }

    function Launcher({ openSettings, wide } = {}) {
      const style = {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0,
        background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '6px 8px',
        textAlign: 'left', fontSize: 'inherit',
      };
      return h('button', { type: 'button', style, onClick: () => openSettings?.() },
        h('span', { 'aria-hidden': true }, '●'),
        wide === false ? null : h('span', null, '企业账号'),
      );
    }

    function SignedOutBanner() {
      const [state, setState] = React.useState({ visible: false, notice: null });

      React.useEffect(() => {
        let live = true;
        fetchView()
          .then((view) => {
            if (live) setState((current) => ({ ...current, visible: view.state === 'signed-out' }));
          })
          .catch(() => {});
        return () => { live = false; };
      }, []);

      const login = async () => {
        try {
          const response = await fetch('/api/forge-iam/sign-in', { method: 'POST' });
          const body = await readJson(response);
          if (!response.ok) {
            const code = body?.error?.code ?? 'IAM_REQUEST_FAILED';
            setState((current) => ({
              ...current,
              notice: code === 'IAM_NOT_IMPLEMENTED' ? '登录链路待接入 IAM 契约' : `登录失败：${code}`,
            }));
            return;
          }
          setState((current) => ({ ...current, visible: false, notice: null }));
        } catch {
          setState((current) => ({ ...current, notice: 'Host 不可达' }));
        }
      };

      if (!state.visible) return null;
      return h('div', {
        style: {
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 900,
          pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 12px', borderRadius: 999, background: 'var(--dsh-surface, #fff)',
          color: 'var(--dsh-text, #111)', boxShadow: '0 6px 24px rgba(0,0,0,0.18)', fontSize: '0.9em',
        },
      },
      h('span', null, '未登录企业 IAM'),
      h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: login }, '登录'),
      state.notice ? h('span', { style: { color: '#8a5a00' } }, state.notice) : null,
      );
    }

    function Onboarding() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, step: 0, notice: null, open: false });

      const close = (marker) => {
        if (marker) writeMarker(marker);
        setState((current) => ({ ...current, open: false }));
      };

      React.useEffect(() => {
        let live = true;
        const marker = readMarker();
        if (marker === 'done' || marker === 'skipped') return () => { live = false; };
        fetchView()
          .then((view) => {
            if (!live) return;
            setState({ phase: 'ready', view, step: 0, notice: null, open: view.state === 'signed-out' });
          })
          .catch(() => {
            if (live) setState((current) => ({ ...current, phase: 'ready', open: false }));
          });
        return () => { live = false; };
      }, []);

      if (!state.open) return null;

      const startLogin = async () => {
        try {
          const response = await fetch('/api/forge-iam/sign-in', { method: 'POST' });
          const body = await readJson(response);
          if (!response.ok) {
            const code = body?.error?.code ?? 'IAM_REQUEST_FAILED';
            setState((current) => ({
              ...current,
              notice: code === 'IAM_NOT_IMPLEMENTED' ? '登录链路尚未接入 IAM 契约；请先完成 IAM 对接。' : `登录失败：${code}`,
            }));
            return;
          }
          setState((current) => ({ ...current, view: body, step: 2, notice: null }));
        } catch {
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
          body: '企业模型已就绪。可以在设置中查看账户状态或退出。',
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
      };
      const card = {
        width: 'min(520px, 100%)', background: 'var(--dsh-surface, #fff)', color: 'var(--dsh-text, #111)',
        borderRadius: 12, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', lineHeight: 1.6,
      };
      const button = { marginRight: 8, marginTop: 16, padding: '6px 14px', cursor: 'pointer' };

      return h('div', { style: overlay, role: 'presentation' },
        h('div', { style: card, role: 'dialog', 'aria-modal': 'true', 'aria-label': step.title },
          h('div', { style: { opacity: 0.6, fontSize: '0.85em' } }, `步骤 ${state.step + 1} / 4`),
          h('h2', { style: { margin: '8px 0 12px', fontSize: '1.25em' } }, step.title),
          h('p', { style: { margin: 0 } }, step.body),
          state.notice ? h('p', { style: { color: '#8a5a00' } }, state.notice) : null,
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
        ctx.slots.inject('settings.launcher', () => ctx.slots.register({
          name: 'settings.launcher',
        }, Launcher));
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