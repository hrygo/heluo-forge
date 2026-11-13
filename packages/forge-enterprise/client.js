/**
 * @heluo/forge-enterprise — 纯 UI 容器：设置分区「企业研发工具」（order: 30）。
 *
 * 定位与解耦原则（CORP-DSH-DESIGN-018 §3 / CORP-DSH-ENG-003 P1）：
 *   1. 本文件只负责注册一级设置分区 `forge-engineering`（order: 30）与声明子槽位
 *      `heluo.engineering.tab`（供 `@heluo/forge-devops` 与 `@heluo/forge-gitee` 注入各自 Tab）。
 *   2. 纯 UI 容器：不 import `src/*.mjs`，不持有业务状态，不读取任何凭据、密钥或环境变量。
 *   3. 面向用户采用渐进式披露：默认展示清晰的工具状态与标签页，折叠展示「环境诊断（技术详情）」。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-enterprise',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'enterprise';
    const SECTION_ID = 'forge-engineering';
    const SECTION_ORDER = 30;
    const ENGINEERING_TAB_SLOT = 'heluo.engineering.tab';

    const zh = {
      nav: '企业研发工具',
      title: '企业研发工具',
      subtitle: '集中管理研发平台（DOP）与代码托管（Gitee）工具连接与环境设置。',
      empty: '当前未启用任何研发扩展工具，可在企业发行包中开启研发工具叠加层后使用。',
      diagSummary: '环境诊断（技术详情）',
      diagNote: '本分区仅聚合已启用的研发扩展设置页；凭据统一由企业账号安全托管，不在此处明文展示。',
    };

    const en = {
      nav: 'Enterprise Engineering',
      title: 'Enterprise Engineering Tools',
      subtitle: 'Manage DevOps (DOP) and Gitee tool connections and environment settings.',
      empty: 'No engineering extensions are currently active. Enable the engineering overlay to configure tools.',
      diagSummary: 'Environment Diagnostics (Technical Details)',
      diagNote: 'This section aggregates active engineering extension tabs. Credentials remain securely managed by Enterprise IAM.',
    };

    function EngineeringSection(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k);
      const SlotOutlet = props?.SlotOutlet ?? null;
      const tabs = Array.isArray(props?.tabs) ? props.tabs : [];

      const [activeTabId, setActiveTabId] = React.useState(() => (tabs[0]?.id ?? null));
      React.useEffect(() => {
        if (tabs.length > 0 && !tabs.some((tab) => tab.id === activeTabId)) {
          setActiveTabId(tabs[0].id);
        }
      }, [tabs, activeTabId]);

      const tabNodes = SlotOutlet
        ? h(SlotOutlet, { name: ENGINEERING_TAB_SLOT, activeId: activeTabId, onSelect: setActiveTabId })
        : tabs.length > 0
          ? h(
              'div',
              { className: 'heluo-engineering-tabs' },
              h(
                'div',
                { role: 'tablist', className: 'heluo-engineering-tablist' },
                tabs.map((tab) =>
                  h(
                    'button',
                    {
                      key: tab.id,
                      type: 'button',
                      role: 'tab',
                      'aria-selected': String(tab.id === activeTabId),
                      onClick: () => setActiveTabId(tab.id),
                    },
                    typeof tab.label === 'function' ? tab.label() : (tab.label ?? tab.id),
                  ),
                ),
              ),
              tabs
                .filter((tab) => tab.id === activeTabId)
                .map((tab) =>
                  h(
                    'div',
                    { key: tab.id, role: 'tabpanel', className: 'heluo-engineering-tabpanel' },
                    typeof tab.render === 'function' ? tab.render() : null,
                  ),
                ),
            )
          : h('p', { className: 'heluo-engineering-empty' }, t('empty'));

      return h(
        'section',
        { className: 'heluo-engineering-section', 'data-section-id': SECTION_ID },
        h('header', { className: 'heluo-engineering-header' }, h('h2', null, t('title')), h('p', null, t('subtitle'))),
        tabNodes,
        h(
          'details',
          { className: 'heluo-engineering-diagnostics' },
          h('summary', null, t('diagSummary')),
          h('p', null, t('diagNote')),
        ),
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-enterprise: copy');
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: SECTION_ORDER,
                label: () => t('nav'),
                icon: 'wrench',
                locale: NS,
                slots: [ENGINEERING_TAB_SLOT],
                inject: () => ({ t }),
              },
              EngineeringSection,
            ),
          ),
        'forge-enterprise: engineering section',
      );
    }

    const inject = ['slots', 'locale'];

    return {
      apply,
      inject,
      SECTION_ID,
      SECTION_ORDER,
      ENGINEERING_TAB_SLOT,
      EngineeringSection,
    };
  },
});
