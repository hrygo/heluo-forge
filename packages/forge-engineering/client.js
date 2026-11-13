/**
 * @heluo/forge-engineering — 纯 UI 容器：设置分区「企业研发工具」（order: 30）。
 *
 * 定位与解耦原则（CORP-DSH-DESIGN-018 §3 / CORP-DSH-DESIGN-019 / CORP-DSH-ENG-003 P1）：
 *   1. 本文件只负责注册一级设置分区 `forge-engineering`（order: 30）、声明子槽位
 *      `heluo.engineering.tab`（供 `@heluo/forge-devops` 与 `@heluo/forge-gitee` 注册各自条目）
 *      以及该分区的 `settings.section.icon` 图标。
 *   2. 纯 UI 容器：不 import `src/*.mjs`，不持有业务状态，不读取任何凭据、密钥或环境变量。
 *   3. 子槽位条目按 `order` 纵向排列（宿主只向容器暴露 `renderSlot(key, owner)`，不暴露条目
 *      枚举），底部折叠展示「环境诊断（技术详情）」。
 *   4. 本模块随独立预装包 `@heluo/forge-engineering` 装载，与通用底座 `@heluo/forge-enterprise` 解耦。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-engineering',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'engineering';
    const SECTION_ID = 'forge-engineering';
    const SECTION_ORDER = 30;
    const ENGINEERING_TAB_SLOT = 'heluo.engineering.tab';
    const ICON_SLOT = 'settings.section.icon';

    const zh = {
      nav: '企业研发工具',
      title: '企业研发工具',
      subtitle: '集中管理研发平台（DOP）与代码托管（Gitee）工具连接、环境状态与独立令牌设置。',
      empty: '当前未启用任何研发扩展工具，可在插件市场启用相关研发子模块后使用。',
      diagSummary: '环境诊断（技术详情）',
      diagNote: '各研发工具默认跟随本机 CLI 登录态运行；如需为单工具指定独立 Token，可在对应设置面板中按需展开配置。',
    };

    const en = {
      nav: 'Enterprise Engineering',
      title: 'Enterprise Engineering Tools',
      subtitle: 'Manage DevOps (DOP) and Gitee connections, environment status, and per-tool credentials.',
      empty: 'No engineering extensions are currently active. Enable DevOps or Gitee modules in Plugin Manager to configure them.',
      diagSummary: 'Environment Diagnostics (Technical Details)',
      diagNote: 'Engineering tools reuse your local CLI session by default. Configure an override token inside each tool panel when needed.',
    };

    /** The child slot renders through the component props face; no enumeration exists. */
    function renderTabArea(props, t) {
      const renderSlot = props?.renderSlot;
      const empty = h('p', { className: 'heluo-engineering-empty' }, t('empty'));
      if (typeof renderSlot !== 'function') return empty;
      // `renderSlot` 返回的是 `<SlotOutlet>` 元素，不是条目数组：空集只能靠第三个
      // 参数里的 `fallback` 表达，否则没有子条目时是一片无法解释的空白。
      return renderSlot(ENGINEERING_TAB_SLOT, {}, { fallback: empty });
    }

    function EngineeringSection(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k);
      return h(
        'section',
        { className: 'heluo-engineering-section', 'data-section-id': SECTION_ID },
        h('header', { className: 'heluo-engineering-header' }, h('h2', null, t('title')), h('p', null, t('subtitle'))),
        renderTabArea(props, t),
        h(
          'details',
          { className: 'heluo-engineering-diagnostics' },
          h('summary', null, t('diagSummary')),
          h('p', null, t('diagNote')),
        ),
      );
    }

    /** Settings navigation icon, addressed by the matching section id. */
    function EngineeringIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 16;
      return h(
        'svg',
        {
          className: 'heluo-engineering-icon',
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props?.active === true ? 1.9 : 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2 4.75h4.25M2 8h2.75M2 11.25h4.25' }),
        h('path', { d: 'M12.6 2.6a3.05 3.05 0 0 1 0 4.31l-4.2 4.2-2.83.6.6-2.83 4.2-4.2a3.05 3.05 0 0 1 4.31 0Z' }),
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-engineering: copy');
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: SECTION_ORDER,
                label: () => t('nav'),
                locale: NS,
                // Child slots are declared in the registration's children table;
                // a `slots` array here would be ignored (that option is factory-only).
                children: { [ENGINEERING_TAB_SLOT]: { kind: 'list', scope: 'root' } },
                inject: () => ({ t }),
              },
              EngineeringSection,
            ),
          ),
        'forge-engineering: section',
      );
      ctx.effect(
        () =>
          ctx.slots.inject(ICON_SLOT, () =>
            ctx.slots.register(
              { name: ICON_SLOT, id: SECTION_ID },
              EngineeringIcon,
            ),
          ),
        'forge-engineering: icon',
      );
    }

    const inject = ['slots', 'locale'];

    return {
      apply,
      inject,
      SECTION_ID,
      SECTION_ORDER,
      ENGINEERING_TAB_SLOT,
      ICON_SLOT,
      EngineeringSection,
      EngineeringIcon,
    };
  },
});
