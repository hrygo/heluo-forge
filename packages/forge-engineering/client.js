/**
 * @heluo/forge-engineering — 纯 UI 容器：设置分区「企业研发工具」（order: 30）。
 *
 * 定位与解耦原则（CORP-DSH-DESIGN-018 §3 / CORP-DSH-DESIGN-019 / CORP-DSH-ENG-003 P1）：
 *   1. 本文件只负责注册一级设置分区 `forge-engineering`（order: 30）、声明子槽位
 *      `heluo.engineering.tab`（供 `@heluo/forge-devops` 与 `@heluo/forge-gitee` 注册各自条目）
 *      以及该分区的 `settings.section.icon` 图标。
 *   2. 纯 UI 容器：不 import `src/*.mjs`，不持有业务状态，不读取任何凭据、密钥或环境变量。
 *   3. 子槽位条目按 `order` 纵向排列（宿主只向容器暴露 `renderSlot(key, owner)`，不暴露条目
 *      枚举），顶部提供使用引导，底部折叠展示「工具配置如何生效」。
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

    const CSS = `
.heluo-engineering-section{box-sizing:border-box;width:100%;max-width:720px;padding:0 0 24px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.heluo-engineering-header{margin:0}
.heluo-engineering-header h2{margin:0;font:var(--dsw-font-m-18);font-weight:600;color:var(--dsw-alias-label-primary)}
.heluo-engineering-header p{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.heluo-engineering-journey{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4)}
.heluo-engineering-step{display:inline-flex;align-items:center;gap:6px;min-width:0}
.heluo-engineering-step-badge{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:var(--dsw-font-xxs-11);font-weight:600;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.heluo-engineering-step-text{font:var(--dsw-font-xxs-12);font-weight:500;color:var(--dsw-alias-label-primary)}
.heluo-engineering-arrow{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxs-12);user-select:none}
.heluo-engineering-slot{display:flex;flex-direction:column;gap:14px;min-width:0}
.heluo-engineering-empty{margin:0;padding:16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);border:0.5px solid var(--dsw-alias-settings-card-stroke);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.heluo-engineering-diagnostics{padding:10px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.heluo-engineering-diagnostics summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--dsw-alias-label-secondary);user-select:none}
.heluo-engineering-diagnostics summary::-webkit-details-marker{display:none}
.heluo-engineering-diagnostics summary:hover{color:var(--dsw-alias-label-primary)}
.heluo-engineering-diagnostics summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.heluo-engineering-diagnostics p{margin:8px 0 0;line-height:1.6;color:var(--dsw-alias-label-secondary)}
@media (max-width:560px){.heluo-engineering-arrow{display:none}}
`;

    const zh = {
      nav: '企业研发工具',
      title: '企业研发工具',
      subtitle: '集中检查研发环境就绪状态，并按需调整本机研发平台与代码托管工具设置。',
      step1Num: '1',
      step1Label: '确认账号与环境就绪',
      step2Num: '2',
      step2Label: '检查工具连接',
      step3Num: '3',
      step3Label: '按需设置独立凭据',
      empty: '当前未启用任何研发扩展工具，可在插件市场启用后使用。',
      diagSummary: '工作方式与常见调整',
      diagNote: '各研发工具默认跟随企业策略与本机登录状态自动运行，通常无需手动配置。仅当需要指定特定工具路径、调整超时时间或单独设置访问凭据时再展开对应项调整。',
    };

    const en = {
      nav: 'Enterprise Engineering',
      title: 'Enterprise Engineering Tools',
      subtitle: 'Check engineering environment readiness and customize local DevOps and Gitee tool settings.',
      step1Num: '1',
      step1Label: 'Verify readiness',
      step2Num: '2',
      step2Label: 'Check tool connections',
      step3Num: '3',
      step3Label: 'Optional credentials',
      empty: 'No engineering extensions are currently active. Enable DevOps or Gitee modules in Plugin Manager to configure them.',
      diagSummary: 'How settings work',
      diagNote: 'Engineering tools follow organization defaults and your existing local sign-in automatically. Adjust tool paths, timeouts, or dedicated credentials below only when needed.',
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

    function renderJourneyBar(t) {
      const steps = [
        [t('step1Num'), t('step1Label')],
        [t('step2Num'), t('step2Label')],
        [t('step3Num'), t('step3Label')],
      ];
      const nodes = [];
      steps.forEach(([num, label], idx) => {
        if (idx > 0) nodes.push(h('span', { className: 'heluo-engineering-arrow', key: `arrow-${idx}`, 'aria-hidden': 'true' }, '→'));
        nodes.push(
          h(
            'div',
            { className: 'heluo-engineering-step', key: `step-${idx}` },
            h('span', { className: 'heluo-engineering-step-badge', 'aria-hidden': 'true' }, num),
            h('span', { className: 'heluo-engineering-step-text' }, label),
          ),
        );
      });
      return h('div', { className: 'heluo-engineering-journey', 'aria-label': t('title') }, nodes);
    }

    function EngineeringSection(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k);
      return h(
        'section',
        { className: 'heluo-engineering-section', 'data-section-id': SECTION_ID },
        h('style', { key: 'style' }, CSS),
        h('header', { className: 'heluo-engineering-header' }, h('h2', null, t('title')), h('p', null, t('subtitle'))),
        renderJourneyBar(t),
        h('div', { className: 'heluo-engineering-slot' }, renderTabArea(props, t)),
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
