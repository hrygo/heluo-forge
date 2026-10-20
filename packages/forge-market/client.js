window.__ModuleLoader__.load({
  id: '@heluo/forge-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 该 slot 会以 summary 与 page 两种视图各调用一次：摘要只渲染一行。
    function Panel({ view } = {}) {
      const [state, setState] = React.useState({ status: 'loading', entries: [], source: '' });

      React.useEffect(() => {
        let live = true;
        fetch('/api/forge-market/catalog')
          .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
            if (!live) return;
            if (!ok) return setState({ status: 'error', entries: [], source: '', error: body?.error ?? 'unavailable' });
            setState({ status: 'ready', entries: body.entries ?? [], source: body.source ?? 'service', stale: body.stale === true });
          })
          .catch(() => {
            if (live) setState({ status: 'error', entries: [], source: '', error: 'network' });
          });
        return () => {
          live = false;
        };
      }, []);

      const title = h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '企业插件市场');

      if (view === 'summary') {
        const line = state.status === 'ready'
          ? `企业插件市场 · ${state.entries.length} 个条目`
          : state.status === 'error' ? '企业插件市场 · 服务不可达' : '企业插件市场 · 加载中';
        return h('div', { style: { opacity: 0.75 } }, line);
      }

      if (state.status === 'loading') return h('div', null, title, h('div', { style: { opacity: 0.7 } }, '正在加载…'));
      if (state.status === 'error') return h('div', null, title, h('div', { style: { opacity: 0.7 } }, '市场服务不可达，稍后重试。'));

      const rows = state.entries.map((entry) =>
        h('li', { key: entry.name, style: { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.2)' } },
          h('div', { style: { fontWeight: 500 } }, entry.title || entry.name),
          h('div', { style: { opacity: 0.7, fontSize: '0.9em' } },
            entry.name + ' · ' + entry.version + ' · ★ ' + entry.stars + ' · 下载 ' + entry.downloads),
          entry.summary ? h('div', { style: { opacity: 0.8, fontSize: '0.9em' } }, entry.summary) : null,
        ),
      );

      return h('div', null, title,
        state.source === 'cache' ? h('div', { style: { opacity: 0.7, marginBottom: 6 } }, '服务不可达，显示缓存列表。') : null,
        h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, rows),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 文档说按包名派发，但当前页面里 dsh-market 的 key 是 dshmarket（与其包名
        // 不同形），无法确认真实比对规则。两种写法各注册一次，只有被派发的那次渲染。
        const keys = ['@heluo/forge-market', 'heluoforgemarket'];
        ctx.slots.inject('plugins.bundle.config', () => {
          const offs = keys.map((key) => ctx.slots.register({ name: 'plugins.bundle.config', key }, Panel));
          // 注入回调要返回单个清理函数；返回数组会让注册无法释放。
          return () => offs.forEach((off) => (typeof off === 'function' ? off() : undefined));
        });
      },
    };
  },
});
