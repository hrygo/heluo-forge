/**
 * `@heluo/forge-skill-nacos` 客户端半边：三视图主面板 + 设置页 + 侧栏入口。
 *
 * 视图（PRD §6）：浏览（搜索/筛选/卡片）、已安装（行式管理/作用域转换）、
 * 回收站（恢复/永久删除）。详情抽屉含版本单选与安装确认。
 * 注册：main 槽（keyed 主面板）、sidebar.panellist（侧栏图标行）、
 * settings.section（设置弹窗页）。
 *
 * 模块外壳与 `@heluo/forge-iam/client.js`、`@heluo/forge-gitee/client.js` 同形
 * （`__ModuleLoader__.load` + `require('react')`）：单文件、不 import `src/*.mjs`、
 * 不进 Node 模块图、无构建环节（DSH 插件高阶规范·浏览器侧）。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-skill-nacos',
  factory(require) {
    const React = require('react');


    const h = React.createElement;
    const NS = 'skillNacos';
    const API = '/api/heluo/forge-skill-nacos';
    const PANEL_ID = 'skill-nacos';
    const PANEL_ORDER = 3;
    const STYLE_ID = 'fsn-panel-style-v2';

    /* ── 国际化 ─────────────────────────────────────────── */
    const DICT = {
      zh: {
        'title': '企业技能市场', 'desc': '从企业 Nacos 发现并安装技能；启用后进入会话技能目录。',
        'tab.browse': '浏览', 'tab.installed': '已安装', 'tab.trash': '回收站', 'tab.settings': '源设置',
        'settings.desc': '选择要连接的 Nacos 环境（切换后立即生效，不需要重启）。',
        'settings.environment': '环境',
        'settings.saved': '已切换，目录缓存已清空',
        'settings.noEnvironments': '管理员未配置多环境（cordis.yml 的 environments 字段），当前使用默认连接。',
        'settings.ns': '命名空间',
        'search.placeholder': '搜索技能名称 / 描述…', 'refresh': '刷新',
        'install': '安装', 'enable': '启用', 'disable': '停用', 'uninstall': '卸载',
        'upgrade': '更版', 'restore': '恢复', 'purge': '永久删除',
        'toProject': '转项目', 'toUser': '转全局', 'detail': '详情', 'close': '关闭',
        'badge.none': '未安装', 'badge.on': '已启用', 'badge.off': '已停用', 'badge.update': '可更版',
        'badge.delisted': '远程下线', 'badge.stale': '目录过期',
        'scope.user': '全局', 'scope.project': '项目',
        'label.source': '源', 'label.ns': '命名空间', 'label.mode': '模式', 'label.cache': '缓存',
        'label.version': '版本', 'label.scope': '作用域', 'label.status': '状态', 'label.remote': '远程',
        'label.time': '卸载时间', 'label.sha': 'SHA',
        'state.loading': '加载中…', 'state.empty': '目录为空：确认源配置与凭据，或点击刷新。',
        'state.emptyInstalled': '尚未安装任何企业技能。',
        'state.emptyTrash': '回收站为空。卸载的技能在此保留 30 天，可随时恢复。',
        'msg.ok': '操作完成', 'msg.confirmUninstall': '卸载后技能从目录消失，文件保留在回收站可恢复。确认卸载？',
        'msg.confirmPurge': '永久删除不可恢复。确认删除？',
        'detail.desc': '描述', 'detail.versions': '版本（单选 · 安装固定精确版本）',
        'detail.source': '来源与完整性', 'detail.security': '安全说明',
        'detail.installConfirm': '安装确认', 'detail.installBtn': '安装并启用',
        'err.network': '面板后端不可达',
      },
      en: {
        'title': 'Enterprise Skills', 'desc': 'Discover and install skills from the enterprise Nacos registry.',
        'tab.browse': 'Browse', 'tab.installed': 'Installed', 'tab.trash': 'Trash', 'tab.settings': 'Source',
        'settings.desc': 'Select the Nacos environment to connect to (effective immediately, no restart needed).',
        'settings.environment': 'Environment',
        'settings.saved': 'Switched, catalog cache cleared',
        'settings.noEnvironments': 'No multi-environment configured (cordis.yml environments field); using default connection.',
        'settings.ns': 'Namespace',
        'search.placeholder': 'Search skill name / description…', 'refresh': 'Refresh',
        'install': 'Install', 'enable': 'Enable', 'disable': 'Disable', 'uninstall': 'Uninstall',
        'upgrade': 'Upgrade', 'restore': 'Restore', 'purge': 'Delete Permanently',
        'toProject': 'To Project', 'toUser': 'To Global', 'detail': 'Details', 'close': 'Close',
        'badge.none': 'Not Installed', 'badge.on': 'Enabled', 'badge.off': 'Disabled', 'badge.update': 'Update Available',
        'badge.delisted': 'Delisted', 'badge.stale': 'Stale',
        'scope.user': 'Global', 'scope.project': 'Project',
        'label.source': 'Source', 'label.ns': 'Namespace', 'label.mode': 'Mode', 'label.cache': 'Cache',
        'label.version': 'Version', 'label.scope': 'Scope', 'label.status': 'Status', 'label.remote': 'Remote',
        'label.time': 'Uninstalled', 'label.sha': 'SHA',
        'state.loading': 'Loading…', 'state.empty': 'Catalog is empty. Check source config or refresh.',
        'state.emptyInstalled': 'No enterprise skills installed yet.',
        'state.emptyTrash': 'Trash is empty. Uninstalled skills are kept for 30 days.',
        'msg.ok': 'Done', 'msg.confirmUninstall': 'Skill disappears from catalogs; files kept in trash for restore. Confirm?',
        'msg.confirmPurge': 'Permanent deletion cannot be undone. Confirm?',
        'detail.desc': 'Description', 'detail.versions': 'Versions (single · pinned to precise version)',
        'detail.source': 'Source & Integrity', 'detail.security': 'Security Notes',
        'detail.installConfirm': 'Install Confirmation', 'detail.installBtn': 'Install & Enable',
        'err.network': 'Panel backend unreachable',
      },
    };

    /* ── 工具 ────────────────────────────────────────────── */
    function api(path, body) {
      const url = resolveUrl(path);
      const init = body === undefined
        ? { headers: { Accept: 'application/json' } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) };
      return fetch(url, init).then(async (response) => {
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload?.ok !== true) { const e = new Error(payload?.error ?? 'unknown'); e.code = payload?.code; throw e; }
        return payload.result;
      });
    }
    function resolveUrl(path) {
      if (typeof document === 'undefined') return path;
      try { const base = new URL(document.baseURI); if (!base.pathname.endsWith('/')) base.pathname += '/'; return new URL(path.slice(1), base).href; }
      catch { return path; }
    }
    function fmtDate(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString(); } catch { return iso; } }

    /* ── 样式（对齐 PRD 设计语言；宿主 CSS 变量保主题一致） ── */
    const CSS = `
    #${STYLE_ID}{all:initial}
    .fsn-root{--fsn-gap:12px;--fsn-c1:#1a1a1a;--fsn-c2:#666;--fsn-c3:#999;--fsn-bd:#d0d0d0;--fsn-pri:#2563eb;--fsn-bg:#fff;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary,var(--fsn-c1));font-family:inherit}
    .fsn-header{padding:20px clamp(20px,4vw,48px) 0;display:flex;flex-direction:column;gap:4px}
    .fsn-title{font-size:18px;font-weight:600}
    .fsn-desc{font-size:12px;color:var(--dsw-alias-label-secondary,var(--fsn-c2))}
    .fsn-status{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--fsn-c3))}
    .fsn-status b{font-weight:500;color:var(--dsw-alias-label-primary,var(--fsn-c1))}
    .fsn-tabs{display:flex;gap:0;padding:0 clamp(20px,4vw,48px);border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
    .fsn-tab{padding:8px 16px;font-size:13px;border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,var(--fsn-c2));border-bottom:2px solid transparent}
    .fsn-tab[data-active="true"]{color:var(--dsw-alias-primary,var(--fsn-pri));border-bottom-color:var(--dsw-alias-primary,var(--fsn-pri));font-weight:500}
    .fsn-tab-count{display:inline-flex;margin-left:4px;padding:1px 6px;font-size:10px;border-radius:8px;background:rgba(128,128,128,.15)}
    .fsn-body{flex:1;min-height:0;overflow-y:auto;padding:16px clamp(20px,4vw,48px) 32px}
    .fsn-body-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:var(--fsn-gap)}
    .fsn-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .fsn-input{flex:1;min-width:200px;padding:7px 12px;font-size:13px;color:var(--dsw-alias-label-primary,var(--fsn-c1));background:var(--dsw-alias-fill-input,transparent);border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:6px;outline:none}
    .fsn-input:focus{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
    .fsn-chip{padding:4px 12px;font-size:12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));background:transparent;color:var(--dsw-alias-label-secondary,var(--fsn-c2));cursor:pointer}
    .fsn-chip[data-active="true"]{border-color:var(--dsw-alias-primary,var(--fsn-pri));color:var(--dsw-alias-primary,var(--fsn-pri));font-weight:500}
    .fsn-btn{padding:5px 14px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));background:transparent;color:var(--dsw-alias-label-primary,var(--fsn-c1));cursor:pointer;white-space:nowrap}
    .fsn-btn:hover{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
    .fsn-btn:disabled{opacity:.45;cursor:default}
    .fsn-btn-primary{border-color:transparent;background:var(--dsw-alias-primary,#2563eb);color:#fff}
    .fsn-btn-primary:hover{background:var(--dsw-alias-primary-hover,#1d4ed8)}
    .fsn-btn-danger{border-color:transparent;background:var(--dsw-alias-danger,#e5484d);color:#fff}
    .fsn-card{display:flex;gap:14px;align-items:flex-start;padding:14px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:10px;cursor:pointer;transition:border-color .15s}
    .fsn-card:hover{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
    .fsn-card-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
    .fsn-card-title{font-weight:600;font-size:14px}
    .fsn-card-desc{font-size:12px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .fsn-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--fsn-c3))}
    .fsn-card-actions{display:flex;gap:6px;flex:none;align-items:center}
    .fsn-badge{display:inline-flex;padding:2px 10px;font-size:11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));color:var(--dsw-alias-label-secondary,var(--fsn-c2));white-space:nowrap}
    .fsn-badge[data-tone="on"]{border-color:transparent;background:rgba(63,177,90,.12);color:#3f9e56}
    .fsn-badge[data-tone="off"]{background:rgba(128,128,128,.1);color:var(--dsw-alias-label-secondary,var(--fsn-c2))}
    .fsn-badge[data-tone="warn"]{border-color:transparent;background:rgba(240,180,41,.14);color:#b8860b}
    .fsn-badge[data-tone="danger"]{border-color:transparent;background:rgba(229,72,77,.1);color:#e5484d}
    .fsn-badge[data-tone="info"]{border-color:transparent;background:rgba(59,130,246,.1);color:#3b82f6}
    .fsn-table{width:100%;border-collapse:collapse;font-size:13px}
    .fsn-table th{text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
    .fsn-table td{padding:10px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,var(--fsn-bd)))}
    .fsn-empty{padding:40px 20px;text-align:center;color:var(--dsw-alias-label-secondary,var(--fsn-c2));font-size:13px}
    .fsn-msg{padding:10px 14px;border-radius:8px;font-size:12px}
    .fsn-msg-ok{background:rgba(63,177,90,.1);color:#3f9e56}
    .fsn-msg-err{background:rgba(229,72,77,.08);color:#e5484d}
    .fsn-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:200;display:flex;justify-content:flex-end}
    .fsn-drawer{width:min(480px,90vw);height:100%;background:var(--dsw-alias-bg-primary,#fff);border-left:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.1)}
    .fsn-drawer-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
    .fsn-drawer-title{font-size:16px;font-weight:600}
    .fsn-drawer-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px}
    .fsn-drawer-foot{padding:14px 20px;border-top:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));display:flex;justify-content:flex-end;gap:10px}
    .fsn-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
    .fsn-version{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:8px;cursor:pointer}
    .fsn-version[data-selected="true"]{border-color:var(--dsw-alias-primary,var(--fsn-pri));background:rgba(59,130,246,.04)}
    .fsn-radio{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:50%;flex:none;position:relative}
    .fsn-radio[data-checked="true"]{border-color:var(--dsw-alias-primary)}
    .fsn-radio[data-checked="true"]::after{content:'';position:absolute;inset:2px;border-radius:50%;background:var(--dsw-alias-primary)}
    .fsn-confirm{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:210;background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:12px;padding:24px;min-width:320px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.15)}
    .fsn-confirm h4{margin:0 0 12px;font-size:15px}
    .fsn-confirm p{margin:0 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));line-height:1.5}
    .fsn-confirm-actions{display:flex;justify-content:flex-end;gap:10px}
    .fsn-icon{flex:none;display:flex;align-items:center;justify-content:center}
    `;

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    /* ── 侧栏图标 ────────────────────────────────────────── */
    function SidebarIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h4A1.5 1.5 0 0 1 9 3.5V5H7.5A2.5 2.5 0 0 0 5 7.5V9H3.5A1.5 1.5 0 0 1 2 7.5v-4Z' }),
        h('path', { d: 'M6.5 7A1.5 1.5 0 0 1 8 5.5h4A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 12V7Z' }));
    }

    /* ── 徽章 ───────────────────────────────────────────── */
    function Badge({ tone = '', children }) {
      return h('span', { className: 'fsn-badge', ...(tone ? { 'data-tone': tone } : {}) }, children);
    }

    /* ── 确认弹窗 ────────────────────────────────────────── */
    function ConfirmDialog({ title, body, t, onConfirm, onCancel }) {
      if (!title) return null;
      return h('div', { className: 'fsn-confirm' },
        h('h4', null, title),
        h('p', null, body),
        h('div', { className: 'fsn-confirm-actions' },
          h('button', { className: 'fsn-btn', onClick: onCancel }, t('close')),
          h('button', { className: 'fsn-btn fsn-btn-primary', onClick: onConfirm }, title)));
    }

    /* ── 详情抽屉 ────────────────────────────────────────── */
    function DetailDrawer({ skill, local, t, onClose, onInstall }) {
      const [selectedVersion, setSelectedVersion] = React.useState(undefined);
      const [showConfirm, setShowConfirm] = React.useState(false);
      if (!skill) return null;

      const meta = skill.meta ?? skill;
      const versions = (meta.versions ?? []).filter((v) => v.status === 'online' || v.status === '' || v.status === 'published');
      const current = selectedVersion ?? (local?.version ?? (versions.length > 0 ? versions[versions.length - 1].version : undefined));
      const isInstalled = local !== null && local !== undefined;
      const isCurrent = isInstalled && local.version === current;

      const versionRows = versions.map((v) => {
        const selected = v.version === current;
        const statusLabel = v.version === local?.version
          ? ` · ${t('label.status')}: ${local.enabled ? t('badge.on') : t('badge.off')}` : '';
        return h('div', {
          key: v.version, className: 'fsn-version', 'data-selected': selected,
          onClick: () => setSelectedVersion(v.version),
        },
          h('span', { className: 'fsn-radio', 'data-checked': selected }),
          h('span', { style: { flex: 1 } }, h('b', null, v.version), statusLabel),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))' } }, v.status || 'online'));
      });

      const section = (title, ...children) =>
        h('div', null, h('div', { className: 'fsn-section-title' }, title), ...children);

      const head = h('div', { className: 'fsn-drawer-head', key: 'head' },
        h('span', { className: 'fsn-drawer-title' }, meta.name ?? t('detail')),
        h('button', { className: 'fsn-btn', onClick: onClose, 'aria-label': t('close') }, '×'));

      const body = h('div', { className: 'fsn-drawer-body', key: 'body' },
        section(t('detail.desc'),
          h('p', { style: { margin: '4px 0 0', fontSize: 13, lineHeight: 1.5 } }, meta.description ?? '')),
        section(t('detail.versions'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } }, ...versionRows)),
        section(t('detail.source'),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))', marginTop: 4, lineHeight: 1.6 } },
            `Namespace: ${meta.namespaceId ?? 'public'}`,
            h('br'), `${t('label.version')}: ${current ?? '—'}`,
            local?.contentSha256
              ? h('span', null, h('br'), `${t('label.sha')}: ${local.contentSha256.slice(0, 8)}…`)
              : null)),
        section(t('detail.security'),
          h('p', { style: { margin: '4px 0 0', fontSize: 11, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))', lineHeight: 1.5 } },
            '安装不执行包内脚本、不授工具权限、不安装依赖；同名本地技能冲突时拒绝。')));

      const foot = h('div', { className: 'fsn-drawer-foot', key: 'foot' },
        h('button', { className: 'fsn-btn', onClick: onClose }, t('close')),
        !isCurrent
          ? h('button', {
              className: 'fsn-btn fsn-btn-primary', onClick: () => setShowConfirm(true),
            }, isInstalled ? `${t('upgrade')} ${current}` : `${t('install')} ${current}`)
          : null);

      return h(React.Fragment, null,
        h('div', { className: 'fsn-overlay', onClick: onClose },
          h('div', { className: 'fsn-drawer', onClick: (e) => e.stopPropagation() }, head, body, foot)),
        showConfirm
          ? h(ConfirmDialog, {
              title: t('detail.installConfirm'), t,
              body: `${meta.name}@${current} · ${t('detail.installBtn')}`,
              onConfirm: () => { setShowConfirm(false); onInstall(meta.name, current); },
              onCancel: () => setShowConfirm(false),
            })
          : null);
    }

    /* ── 浏览视图 ────────────────────────────────────────── */
    function BrowseView({ t, catalog, installed, loading, keyword, setKeyword, onRefresh, onDetail, onAction, busy }) {
      const [filter, setFilter] = React.useState('all');
      const allItems = catalog?.items ?? [];
      const items = allItems.filter((item) => {
        const local = installed.find((r) => r.name === item.name);
        if (filter === 'installed') return local !== undefined;
        if (filter === 'update') return local !== undefined && item.latestVersion !== local.version;
        return true;
      });
      const countInstalled = allItems.filter((i) => installed.some((r) => r.name === i.name)).length;
      const countUpdate = allItems.filter((i) => {
        const l = installed.find((r) => r.name === i.name);
        return l && i.latestVersion && i.latestVersion !== l.version;
      }).length;

      const toolbar = h('div', { className: 'fsn-toolbar' },
        h('input', { className: 'fsn-input', value: keyword, placeholder: t('search.placeholder'),
          onChange: (e) => setKeyword(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') onRefresh(); } }),
        h('button', { className: 'fsn-chip', 'data-active': filter === 'all', onClick: () => setFilter('all') }, `${t('tab.browse')} ${catalog?.total ?? 0}`),
        h('button', { className: 'fsn-chip', 'data-active': filter === 'installed', onClick: () => setFilter('installed') }, `${t('badge.on')} ${countInstalled}`),
        h('button', { className: 'fsn-chip', 'data-active': filter === 'update', onClick: () => setFilter('update') }, `${t('badge.update')} ${countUpdate}`),
        h('button', { className: 'fsn-btn', disabled: busy, onClick: onRefresh }, t('refresh')));

      const staleMsg = catalog?.stale
        ? h('div', { className: 'fsn-msg fsn-msg-err' }, t('badge.stale'))
        : null;

      const cards = items.map((item) => {
        // Browse Tab 的本地状态直接用 catalog 响应自带的 installed 字段——与列表数据
        // 来自同一 API 响应，不可能与服务器端状态不同步（消除 installed 数组异步到达
        // 导致的跨 Tab 不一致）
        const local = item.installed !== null && item.installed !== undefined
          ? { name: item.name, ...item.installed }
          : undefined;
        const version = local?.version ?? item.latestVersion ?? '';
        const hasUpdate = local && item.latestVersion && item.latestVersion !== local.version;

        let badge;
        let actionBtn;
        if (!local) {
          badge = h('span', { key: 'bdg', className: 'fsn-badge', 'data-tone': 'off' }, t('badge.none'));
          actionBtn = h('button', {
            key: 'act', className: 'fsn-btn fsn-btn-primary', disabled: busy,
            onClick: () => onAction({ op: 'install', name: item.name, ...(version ? { version } : {}) }),
          }, t('install'));
        } else if (hasUpdate) {
          badge = h('span', { key: 'bdg', className: 'fsn-badge', 'data-tone': 'warn' }, `${t('badge.update')} ${item.latestVersion}`);
          actionBtn = h('button', {
            key: 'act', className: 'fsn-btn fsn-btn-primary', disabled: busy,
            onClick: () => onAction({ op: 'upgrade', name: item.name, version: item.latestVersion }),
          }, t('upgrade'));
        } else if (local.enabled) {
          badge = h('span', { key: 'bdg', className: 'fsn-badge', 'data-tone': 'on' }, t('badge.on'));
          actionBtn = h('button', {
            key: 'act', className: 'fsn-btn', disabled: busy,
            onClick: () => onAction({ op: 'disable', name: item.name }),
          }, t('disable'));
        } else {
          badge = h('span', { key: 'bdg', className: 'fsn-badge', 'data-tone': 'off' }, t('badge.off'));
          actionBtn = h('button', {
            key: 'act', className: 'fsn-btn fsn-btn-primary', disabled: busy,
            onClick: () => onAction({ op: 'enable', name: item.name }),
          }, t('enable'));
        }

        return h('div', { key: item.name, className: 'fsn-card', onClick: () => onDetail(item.name) },
          h('div', { className: 'fsn-card-main' },
            h('div', { className: 'fsn-card-title' }, item.name),
            h('div', { className: 'fsn-card-desc' }, item.description || ''),
            h('div', { className: 'fsn-card-meta' }, `${t('label.version')}: ${version || '—'}`)),
          h('div', { className: 'fsn-card-actions', onClick: (e) => e.stopPropagation() }, badge, actionBtn));
      });

      return h(React.Fragment, null,
        toolbar, staleMsg,
        loading
          ? h('div', { className: 'fsn-empty' }, t('state.loading'))
          : items.length === 0
            ? h('div', { className: 'fsn-empty' }, t('state.empty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, ...cards));
    }

    /* ── 已安装视图 ──────────────────────────────────────── */
    function InstalledView({ t, installed, catalog, onDetail, onAction, busy }) {
      const [confirm, setConfirm] = React.useState(undefined);
      if (installed.length === 0) return h('div', { className: 'fsn-empty' }, t('state.emptyInstalled'));

      const rows = installed.map((r) => {
        const isProject = r.scope?.kind === 'project';
        const scopeLabel = isProject ? `${t('scope.project')} · ${(r.scope.root ?? '').split('/').pop()}` : t('scope.user');
        const catalogItem = (catalog?.items ?? []).find((i) => i.name === r.name);
        const latestVersion = catalogItem?.latestVersion;
        const hasUpdate = latestVersion && latestVersion !== r.version;
        const actionBtn = (label, action) => h('button', {
          className: 'fsn-btn', disabled: busy, onClick: () => onAction(action),
        }, label);

        const remoteCell = !catalogItem
          ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))' } }, t('badge.delisted'))
          : hasUpdate
            ? Badge({ tone: 'warn' }, `${t('badge.update')} ${latestVersion}`)
            : Badge({ tone: 'off' }, t('label.version') + ' ✓');

        return h('tr', { key: r.name },
          h('td', null,
            h('div', { style: { fontWeight: 600, cursor: 'pointer' }, onClick: () => onDetail(r.name) }, r.name)),
          h('td', null, r.version),
          h('td', null, Badge({ tone: isProject ? 'info' : 'off' }, scopeLabel)),
          h('td', null, Badge({ tone: r.enabled ? 'on' : 'off' }, r.enabled ? t('badge.on') : t('badge.off'))),
          h('td', null, remoteCell),
          h('td', { style: { textAlign: 'right' } },
            h('div', { style: { display: 'flex', gap: 4, justifyContent: 'flex-end' } },
              hasUpdate ? actionBtn(t('upgrade'), { op: 'upgrade', name: r.name, version: latestVersion }) : null,
              actionBtn(r.enabled ? t('disable') : t('enable'), { op: r.enabled ? 'disable' : 'enable', name: r.name }),
              actionBtn(isProject ? t('toUser') : t('toProject'), { op: 'scope', name: r.name, to: isProject ? 'user' : 'project' }),
              h('button', { className: 'fsn-btn', disabled: busy, onClick: () => setConfirm(r.name) }, t('uninstall')))));
      });

      const table = h('table', { className: 'fsn-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('detail')), h('th', null, t('label.version')), h('th', null, t('label.scope')),
          h('th', null, t('label.status')), h('th', null, t('label.remote')),
          h('th', { style: { textAlign: 'right' } }, '操作'))),
        h('tbody', null, ...rows));

      const dialog = confirm !== undefined
        ? h(ConfirmDialog, {
            title: t('uninstall'), t,
            body: t('msg.confirmUninstall'),
            onConfirm: () => { const name = confirm; setConfirm(undefined); onAction({ op: 'uninstall', name }); },
            onCancel: () => setConfirm(undefined),
          })
        : null;

      return h(React.Fragment, null, table, dialog);
    }

    /* ── 回收站视图 ──────────────────────────────────────── */
    function TrashView({ t, trash, onAction, busy }) {
      const [confirmPurge, setConfirmPurge] = React.useState(undefined);
      if (trash.length === 0) return h('div', { className: 'fsn-empty' }, t('state.emptyTrash'));

      const rows = trash.map((entry) => h('tr', { key: entry.id ?? entry.name },
        h('td', { style: { fontWeight: 600 } }, entry.name),
        h('td', null, entry.version),
        h('td', null, fmtDate(entry.trashedAt)),
        h('td', { style: { fontFamily: 'monospace', fontSize: 11 } }, `${String(entry.skillMdSha256 ?? '').slice(0, 8)}…`),
        h('td', { style: { textAlign: 'right' } },
          h('div', { style: { display: 'flex', gap: 4, justifyContent: 'flex-end' } },
            h('button', { className: 'fsn-btn fsn-btn-primary', disabled: busy,
              onClick: () => onAction({ op: 'restore', name: entry.name }) }, t('restore')),
            h('button', { className: 'fsn-btn fsn-btn-danger', disabled: busy,
              onClick: () => setConfirmPurge(entry.name) }, t('purge'))))));

      const table = h('table', { className: 'fsn-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('detail')), h('th', null, t('label.version')),
          h('th', null, t('label.time')), h('th', null, t('label.sha')),
          h('th', { style: { textAlign: 'right' } }, '操作'))),
        h('tbody', null, ...rows));

      const dialog = confirmPurge !== undefined
        ? h(ConfirmDialog, {
            title: t('purge'), t,
            body: t('msg.confirmPurge'),
            onConfirm: () => { const name = confirmPurge; setConfirmPurge(undefined); onAction({ op: 'purge', name }); },
            onCancel: () => setConfirmPurge(undefined),
          })
        : null;

      return h(React.Fragment, null, table, dialog);
    }

    /* ── 源设置视图（环境切换） ─────────────────────────── */
    function SettingsView({ t, onSaved, busy }) {
      const [settings, setSettings] = React.useState(undefined);
      const [activeEnv, setActiveEnv] = React.useState(undefined);
      const [msg, setMsg] = React.useState(undefined);

      const load = React.useCallback(() => {
        api(`${API}/settings`).then((r) => {
          setSettings(r);
          setActiveEnv(r.effective?.activeEnvironmentId ?? r.environments?.[0]?.id ?? '');
        }).catch((e) => setMsg({ kind: 'err', text: e.message }));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const switchEnv = async (envId) => {
        setActiveEnv(envId);
        setMsg(undefined);
        try {
          await api(`${API}/settings`, { method: 'POST', body: JSON.stringify({ activeEnvironmentId: envId }) });
          setMsg({ kind: 'ok', text: t('settings.saved') });
          onSaved();
        } catch (e) {
          setMsg({ kind: 'err', text: `${e.code ?? ''} ${e.message}` });
        }
      };

      if (settings === undefined) return h('div', { className: 'fsn-empty' }, t('state.loading'));

      const envs = settings.environments ?? [];
      const current = envs.find((e) => e.id === activeEnv);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))' } }, t('settings.desc')),
        envs.length > 0 ? h(React.Fragment, null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary,var(--fsn-c2))' } }, t('settings.environment')),
            h('select', {
              className: 'fsn-input', value: activeEnv,
              onChange: (e) => switchEnv(e.target.value),
            },
              ...envs.map((env) => h('option', { key: env.id, value: env.id },
                `${env.label} (${env.namespaceId})`)))),
          current !== undefined ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,var(--fsn-c3))' } },
            `ID: ${current.id} · ${t('settings.ns')}: ${current.namespaceId}`) : null,
          msg ? h('div', { className: `fsn-msg ${msg.kind === 'ok' ? 'fsn-msg-ok' : 'fsn-msg-err'}` }, msg.text) : null)
        : h('div', { className: 'fsn-empty' }, t('settings.noEnvironments')));
    }

    /* ── 主面板（四视图 + 抽屉 + 弹窗） ─────────────────── */
    function MainPanel({ t }) {
      ensureStyle();
      const [tab, setTab] = React.useState('browse');
      const [keyword, setKeyword] = React.useState('');
      const [status, setStatus] = React.useState(undefined);
      const [catalog, setCatalog] = React.useState(undefined);
      const [installed, setInstalled] = React.useState([]);
      const [trash, setTrash] = React.useState([]);
      const [detailName, setDetailName] = React.useState(undefined);
      const [detailSkill, setDetailSkill] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(undefined);

      const loadAll = React.useCallback(async (kw) => {
        setBusy(true);
        try {
          const [s, c, i] = await Promise.all([
            api(`${API}/status`),
            api(`${API}/catalog?page=1&pageSize=50${kw ? `&keyword=${encodeURIComponent(kw)}` : ''}`),
            api(`${API}/installed`),
          ]);
          setStatus(s); setCatalog(c); setInstalled(i.items ?? []);
          api(`${API}/trash`).then((r) => setTrash(r.items ?? [])).catch(() => setTrash([]));
        } catch (error) {
          setMessage({ kind: 'err', text: `${error.code ?? ''} ${error.message}` });
        } finally { setBusy(false); }
      }, []);
      React.useEffect(() => { void loadAll(''); }, [loadAll]);
      // 切 Tab 时刷新数据，保证三个视图一致
      React.useEffect(() => { void loadAll(keyword); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

      const openDetail = async (name) => {
        setDetailName(name);
        try { setDetailSkill(await api(`${API}/skill?name=${encodeURIComponent(name)}`)); }
        catch { setDetailSkill(undefined); }
      };

      const act = async (body, note) => {
        setBusy(true); setMessage(undefined);
        try {
          await api(`${API}/action`, body);
          setMessage({ kind: 'ok', text: `${note ?? body.op} · ${t('msg.ok')}` });
          await loadAll(keyword);
          if (detailName) { try { setDetailSkill(await api(`${API}/skill?name=${encodeURIComponent(detailName)}`)); } catch {} }
        } catch (error) {
          setMessage({ kind: 'err', text: `${error.code ?? ''} ${error.message}` });
        } finally { setBusy(false); }
      };

      return h('div', { className: 'fsn-root' },
        h('div', { className: 'fsn-header' },
          h('div', { className: 'fsn-title' }, t('title')),
          h('div', { className: 'fsn-desc' }, t('desc')),
          status !== undefined ? h('div', { className: 'fsn-status' },
            h('span', null, `${t('label.source')}: `, h('b', null, status.endpoint ?? '')),
            h('span', null, `${t('label.ns')}: `, h('b', null, status.namespaceId ?? '')),
            h('span', null, `${t('label.mode')}: `, h('b', null, status.catalogMode ?? ''))) : null),
        h('div', { className: 'fsn-tabs' },
          h('button', { className: 'fsn-tab', 'data-active': tab === 'browse', onClick: () => setTab('browse') }, t('tab.browse'), h('span', { className: 'fsn-tab-count' }, String(catalog?.total ?? 0))),
          h('button', { className: 'fsn-tab', 'data-active': tab === 'installed', onClick: () => setTab('installed') }, t('tab.installed'), h('span', { className: 'fsn-tab-count' }, String(installed.length))),
          h('button', { className: 'fsn-tab', 'data-active': tab === 'trash', onClick: () => setTab('trash') }, t('tab.trash'), h('span', { className: 'fsn-tab-count' }, String(trash.length))),
          h('button', { className: 'fsn-tab', 'data-active': tab === 'settings', onClick: () => setTab('settings') }, t('tab.settings'))),
        h('div', { className: 'fsn-body' },
          h('div', { className: 'fsn-body-inner' },
            message !== undefined ? h('div', { className: `fsn-msg ${message.kind === 'ok' ? 'fsn-msg-ok' : 'fsn-msg-err'}` }, message.text) : null,
            tab === 'browse' ? h(BrowseView, { t, catalog, installed, loading: busy && catalog === undefined, keyword, setKeyword, onRefresh: () => loadAll(keyword), onDetail: openDetail, onAction: act, busy })
            : tab === 'installed' ? h(InstalledView, { t, installed, catalog, onDetail: openDetail, onAction: act, busy })
            : tab === 'settings' ? h(SettingsView, { t, busy, onSaved: () => loadAll(keyword) })
            : h(TrashView, { t, trash, onAction: act, busy }))),
        detailName !== undefined ? h(DetailDrawer, {
          skill: detailSkill, local: installed.find((r) => r.name === detailName) ?? null, t,
          onClose: () => { setDetailName(undefined); setDetailSkill(undefined); },
          onInstall: (name, version) => {
            const isUpgrade = installed.some((r) => r.name === name);
            act({ op: isUpgrade ? 'upgrade' : 'install', name, version });
            setDetailName(undefined);
          },
        }) : null);
    }

    /* ── 设置页入口（弹窗内） ────────────────────────────── */
    function SettingsSection({ t }) {
      ensureStyle();
      return h('div', { style: { padding: '8px 0' } }, h(MainPanel, { t }));
    }

    /* ── 插件注册 ────────────────────────────────────────── */
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const t = typeof ctx?.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => key;
      ctx.effect(() => ctx.locale.register(NS, DICT));

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 30, label: () => t('title'), icon: 'skill', locale: NS },
        (props) => h(SettingsSection, { t, ...(props ?? {}) }),
      )));

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
        () => h(MainPanel, { t }),
      )));

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('title'), locale: NS },
        (ownerProps) => h(SidebarIcon, { size: ownerProps?.size ?? 16 }),
      )));
    }

    return { apply, inject, DICT };
  },
});
