#!/usr/bin/env node
/**
 * 浏览器半的"能不能装进 Loader"检查（TECHNICAL §9/§10）。
 *
 * 浏览器半不经过打包器：DSH Web 外壳直接取 `client.js`，用 `window.__ModuleLoader__`
 * 把它注册进页面。所以这里的检查要真的**执行**这个文件——在 node 里造一个最小
 * 模块运行时（`window.__ModuleLoader__` + `require('react')` + 假 `ctx`），
 * 而不是用正则匹配文本：文本对了但 `factory` 抛错、`apply` 注册错 slot、
 * effect 返回了元素而不是 disposer，装到页面上都只会得到一片空白。
 *
 * 用法：node scripts/check-client-module.mjs packages/forge-gitee/client.js [...]
 * 退出码：全部通过 0；任一文件失败 1（stderr 给原因，stdout 给 JSON 摘要）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const ID_PATTERN = /^@heluo\/forge-[a-z0-9-]+$/u;
const REQUIRED_INJECT = ['slots', 'locale'];

/** 最小 React：只提供浏览器半用到的导出；渲染由各包自己的用例覆盖。 */
function fakeReact() {
  const passthrough = (value) => value;
  const base = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol.for('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useReducer: (reducer, initial) => [initial, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    memo: passthrough,
    forwardRef: passthrough,
  };
  return new Proxy(base, { get: (target, key) => (key in target ? target[key] : () => {}) });
}

/**
 * 假 `ctx`：记录 effect / slot / locale。`container` 决定研发容器子槽位是否存在：
 * 为真时 `heluo.engineering.tab` 视为已声明（`inject` 立刻回调），为假时视为缺席
 * （`inject` 不回调，与真实宿主"槽位尚未声明"的时序一致）。
 */
function fakeContext({ container = false } = {}) {
  const effects = [];
  const registrations = [];
  const locales = [];
  const warnings = [];
  const ctx = {
    effect: (fn) => {
      const disposer = fn();
      // Loader 只接受"disposer 或空"：返回元素/对象会让整条 entry 抛 `Invalid effect`。
      if (disposer !== undefined && disposer !== null && typeof disposer !== 'function') {
        warnings.push('effect returned a non-disposer value');
      }
      effects.push({ disposer });
      return () => {};
    },
    get: () => undefined,
    provide: () => () => {},
    on: () => () => {},
    inject: (_names, fn) => {
      fn(ctx);
      return () => {};
    },
    slots: {
      inject: (name, fn) => {
        if (name === 'heluo.engineering.tab' && !container) {
          // 容器缺席：槽位永远不出现，回调不执行。
          return () => {};
        }
        const dispose = fn();
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      register: (options, component) => {
        registrations.push({
          name: options?.name,
          id: options?.id,
          order: options?.order,
          label: options?.label,
          children: options?.children,
          component,
        });
        return () => {};
      },
    },
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
      bind: (namespace) => {
        const table = locales.find((entry) => entry.namespace === namespace)?.dictionaries;
        const zh = table?.zh ?? {};
        const t = (key, params) => {
          const template = zh[key] ?? key;
          if (params === undefined) return template;
          return String(template).replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
        };
        return t;
      },
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };
  return { ctx, effects, registrations, locales, warnings };
}

function checkOne(file) {
  const errors = [];
  const path = resolve(file);
  const source = readFileSync(path, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('network disabled in module check')),
  };
  try {
    runInNewContext(source, sandbox, { filename: path });
  } catch (error) {
    errors.push(`module threw while loading: ${error.message}`);
    return { file, id: null, errors };
  }
  if (captured === null) {
    errors.push('did not call window.__ModuleLoader__.load({ id, factory })');
    return { file, id: null, errors };
  }
  const { id, factory } = captured;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`loader id ${JSON.stringify(id)} must match @heluo/forge-*`);
  if (typeof factory !== 'function') {
    errors.push('loader definition has no factory function');
    return { file, id, errors };
  }
  const react = fakeReact();
  const require = (name) => {
    if (name === 'react') return react;
    throw new Error(`browser half must not require(${JSON.stringify(name)})`);
  };
  let exported;
  try {
    exported = factory(require);
  } catch (error) {
    errors.push(`factory threw: ${error.message}`);
    return { file, id, errors };
  }
  if (exported === null || typeof exported !== 'object') {
    errors.push('factory must return the module object');
    return { file, id, errors };
  }
  if (typeof exported.apply !== 'function') errors.push('module must export apply(ctx)');
  if (!Array.isArray(exported.inject)) errors.push('module must export inject as an array');
  else {
    for (const name of REQUIRED_INJECT) {
      if (!exported.inject.includes(name)) errors.push(`inject must declare ${name}`);
    }
  }
  const describe = (runtime) => runtime.registrations.map((entry) => ({
    name: entry.name,
    id: entry.id,
    order: entry.order,
    label: typeof entry.label === 'function' ? entry.label() : undefined,
    children: Object.keys(entry.children ?? {}),
    component: typeof entry.component === 'function' || (entry.component !== null && typeof entry.component === 'object'),
  }));
  const run = (container) => {
    const runtime = fakeContext({ container });
    if (typeof exported.apply === 'function') {
      try {
        exported.apply(runtime.ctx, {});
      } catch (error) {
        errors.push(`apply threw (${container ? 'container' : 'standalone'}): ${error.message}`);
      }
    }
    for (const warning of runtime.warnings) errors.push(warning);
    if (runtime.locales.length === 0) errors.push('apply did not register a locale namespace');
    return describe(runtime);
  };

  // 单包安装（无容器）：必须有一个独立 settings.section 入口。图标注册单独收集，
  // 不参与分区校验。
  const standaloneAll = run(false);
  const standalone = standaloneAll.filter((entry) => entry.name === 'settings.section');
  const standaloneIcons = standaloneAll.filter((entry) => entry.name === 'settings.section.icon').map((entry) => entry.id);
  if (standalone.length === 0) errors.push('apply did not register a settings section when no container is present');
  for (const section of standalone) {
    if (section.name !== 'settings.section') errors.push(`slot registration must be two-stage on settings.section (got ${JSON.stringify(section.name)})`);
    if (typeof section.id !== 'string' || section.id.length === 0) errors.push('settings section needs a stable id');
    if (typeof section.order !== 'number') errors.push(`settings section ${section.id} needs a numeric order`);
    if (!section.component) errors.push(`settings section ${section.id} has no component`);
  }
  const standaloneOrders = standalone.map((section) => section.order);
  if (new Set(standaloneOrders).size !== standaloneOrders.length) errors.push('settings sections must not share an order');

  // 装有研发容器：同一面板必须改成容器子槽位条目，且不再单独占侧栏分区。
  const mounted = run(true);
  const tabs = mounted.filter((entry) => entry.name === 'heluo.engineering.tab');
  const containerSections = mounted.filter((entry) => entry.name === 'settings.section');
  // 容器自身声明子槽位（`children`），因此不该被要求再往子槽位注册条目。
  const isContainer = mounted.some((entry) => entry.children.includes('heluo.engineering.tab'));
  if (tabs.length === 0 && standalone.length > 0 && !isContainer) {
    errors.push('container is present but no entry was registered into heluo.engineering.tab');
  }
  if (isContainer && tabs.length > 0) errors.push('container must not register into its own child slot');
  for (const tab of tabs) {
    if (typeof tab.id !== 'string' || tab.id.length === 0) errors.push('container tab needs a stable id');
    if (typeof tab.order !== 'number') errors.push(`container tab ${tab.id} needs a numeric order`);
    if (!tab.component) errors.push(`container tab ${tab.id} has no component`);
  }
  const otherSlots = mounted.filter(
    (entry) => entry.name !== 'heluo.engineering.tab' && entry.name !== 'settings.section' && entry.name !== 'settings.section.icon',
  );
  for (const entry of otherSlots) errors.push(`unexpected slot registration ${JSON.stringify(entry.name)}`);
  return {
    file,
    id,
    sections: standalone,
    tabs,
    containerSections,
    container: isContainer,
    icons: [...new Set([
      ...standaloneIcons,
      ...mounted.filter((entry) => entry.name === 'settings.section.icon').map((entry) => entry.id),
    ])],
    errors,
  };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/check-client-module.mjs <client.js> [...]');
  process.exitCode = 2;
} else {
  const results = files.map((file) => {
    try {
      return checkOne(file);
    } catch (error) {
      return { file, id: null, errors: [error.message] };
    }
  });
  const failed = results.filter((result) => result.errors.length > 0);
  console.log(JSON.stringify({
    checked: results.map(({ file, id, sections, tabs, containerSections, container, icons }) => ({
      file, id, sections, tabs, containerSections, container, icons,
    })),
    failed: failed.length,
  }, null, 2));
  if (failed.length > 0) {
    for (const result of failed) for (const message of result.errors) console.error(`${result.file}: ${message}`);
    process.exitCode = 1;
  }
}
