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
 * 假 `ctx`：记录 effect / slot / locale，并**真的模拟槽位声明生命周期**。
 *
 * 宿主语义（`dsh-client-ui-renderer/src/client/registry.ts` 的 `inject`）：
 * 槽位未声明时回调排队；声明后执行；声明塌陷时执行该生命周期的 cleanup；
 * **再次声明时重新执行回调**（每个声明生命周期一份 effect）。因此这里按槽位保存
 * 回调记录并在 `declare` / `undeclare` 之间重跑，`register` 也只在声明存在时接受——
 * 只模拟「一开始就在 / 一开始就没有」会让释放、回退与重挂三条路径永远不被执行。
 */
function fakeContext() {
  const declared = new Set(['settings.section', 'settings.section.icon']);
  /** name -> [{ fn, cleanup }]，按注册顺序执行；塌陷时执行 cleanup，再声明时重跑 fn。 */
  const entries = new Map();
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
        if (!entries.has(name)) entries.set(name, []);
        const record = { fn, cleanup: undefined };
        entries.get(name).push(record);
        if (declared.has(name)) record.cleanup = fn();
        return () => {
          const list = entries.get(name) ?? [];
          const index = list.indexOf(record);
          if (index >= 0) list.splice(index, 1);
          if (typeof record.cleanup === 'function') record.cleanup();
          record.cleanup = undefined;
        };
      },
      register: (options, component) => {
        const name = options?.name;
        // 宿主对未声明槽位直接抛 `slot "<key>" is not declared`（这正是 D-2 回归的形态）。
        if (typeof name !== 'string' || !declared.has(name)) {
          throw new Error(`slot '${String(name)}' is not declared by this entry's children`);
        }
        const entry = {
          name,
          id: options?.id,
          order: options?.order,
          label: options?.label,
          children: options?.children,
          component,
          released: false,
        };
        registrations.push(entry);
        // 宿主返回的是 `ctx.effect` 的 disposer（函数）；这里同样只返回函数。
        return () => {
          entry.released = true;
        };
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
  const runRecord = (record) => {
    if (typeof record.cleanup === 'function') record.cleanup();
    record.cleanup = record.fn();
  };
  /** 声明一个槽位：该槽位的所有回调都进入一个新的声明生命周期（宿主按 epoch 重跑）。 */
  const declare = (name) => {
    if (declared.has(name)) return;
    declared.add(name);
    for (const record of entries.get(name) ?? []) runRecord(record);
  };
  /** 塌陷一个槽位：执行该声明生命周期里所有回调的 cleanup（宿主同步做这件事）。 */
  const undeclare = (name) => {
    if (!declared.has(name)) return;
    declared.delete(name);
    for (const record of entries.get(name) ?? []) {
      if (typeof record.cleanup === 'function') record.cleanup();
      record.cleanup = undefined;
    }
  };
  return { ctx, effects, registrations, locales, warnings, declare, undeclare };
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
  const describe = (runtime) => runtime.registrations
    .filter((entry) => !entry.released)
    .map((entry) => ({
      name: entry.name,
      id: entry.id,
      order: entry.order,
      label: typeof entry.label === 'function' ? entry.label() : undefined,
      children: Object.keys(entry.children ?? {}),
      component: typeof entry.component === 'function' || (entry.component !== null && typeof entry.component === 'object'),
    }));

  /** 跑一个场景，返回该场景的挂载快照。 */
  const run = (scenario) => {
    const runtime = fakeContext();
    const apply = () => {
      try {
        exported.apply(runtime.ctx, {});
      } catch (error) {
        errors.push(`apply threw (${scenario}): ${error.message}`);
      }
    };
    try {
      if (scenario === 'container') runtime.declare('heluo.engineering.tab');
      apply();
      if (scenario === 'late') runtime.declare('heluo.engineering.tab');
      if (scenario === 'collapse') {
        runtime.declare('heluo.engineering.tab');
        // 容器先到场：先走一次 tab 挂载；再让它塌陷，验证独立分区被补回来。
        runtime.undeclare('heluo.engineering.tab');
      }
      if (scenario === 'redeclare') {
        // 容器先到、塌陷、再回来：宿主按声明 epoch 重跑回调，必须回到「只有一个 tab」。
        runtime.declare('heluo.engineering.tab');
        runtime.undeclare('heluo.engineering.tab');
        runtime.declare('heluo.engineering.tab');
      }
    } catch (error) {
      errors.push(`scenario ${scenario} threw: ${error.message}`);
    }
    for (const warning of runtime.warnings) errors.push(`${scenario}: ${warning}`);
    if (runtime.locales.length === 0) errors.push(`${scenario}: apply did not register a locale namespace`);
    return describe(runtime);
  };

  const sectionsOf = (entries) => entries.filter((entry) => entry.name === 'settings.section');
  const tabsOf = (entries) => entries.filter((entry) => entry.name === 'heluo.engineering.tab');
  const isContainerOf = (entries) => entries.some((entry) => entry.children.includes('heluo.engineering.tab'));

  const validateSections = (label, sections) => {
    for (const section of sections) {
      if (typeof section.id !== 'string' || section.id.length === 0) errors.push(`${label}: settings section needs a stable id`);
      if (typeof section.order !== 'number') errors.push(`${label}: settings section ${section.id} needs a numeric order`);
      if (!section.component) errors.push(`${label}: settings section ${section.id} has no component`);
    }
    const orders = sections.map((section) => section.order);
    if (new Set(orders).size !== orders.length) errors.push(`${label}: settings sections must not share an order`);
  };
  const validateTabs = (label, tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'string' || tab.id.length === 0) errors.push(`${label}: container tab needs a stable id`);
      if (typeof tab.order !== 'number') errors.push(`${label}: container tab ${tab.id} needs a numeric order`);
      if (!tab.component) errors.push(`${label}: container tab ${tab.id} has no component`);
    }
    if (tabs.length > 1) errors.push(`${label}: must contribute exactly one container tab (got ${tabs.length})`);
  };
  const checkSlots = (label, entries) => {
    const allowed = new Set(['settings.section', 'settings.section.icon', 'heluo.engineering.tab']);
    for (const entry of entries) {
      if (!allowed.has(entry.name)) errors.push(`${label}: unexpected slot registration ${JSON.stringify(entry.name)}`);
    }
  };

  const standalone = run('standalone');
  const standaloneSections = sectionsOf(standalone);
  if (standaloneSections.length === 0) errors.push('apply did not register a settings section when no container is present');
  validateSections('standalone', standaloneSections);
  checkSlots('standalone', standalone);

  // 容器先到：同一面板必须改成容器子槽位条目，且不再单独占侧栏分区。
  const containerFirst = run('container');
  const containerTabs = tabsOf(containerFirst);
  const isContainer = isContainerOf(containerFirst);
  if (!isContainer && standaloneSections.length > 0 && containerTabs.length === 0) {
    errors.push('container is present but no entry was registered into heluo.engineering.tab');
  }
  if (isContainer && containerTabs.length > 0) errors.push('container must not register into its own child slot');
  validateTabs('container', containerTabs);
  if (sectionsOf(containerFirst).length > 0 && !isContainer) {
    errors.push('container is present but the standalone settings section is still registered');
  }
  checkSlots('container', containerFirst);

  // 容器后到（真实冷启动最坏时序：本插件先 apply，容器后声明）。
  const late = run('late');
  validateTabs('late', tabsOf(late));
  if (!isContainer && tabsOf(late).length === 0) {
    errors.push('container declared after apply but no entry was registered into heluo.engineering.tab');
  }
  if (sectionsOf(late).length > 0 && !isContainer) {
    errors.push('container declared after apply but the standalone settings section was not released (duplicate entry)');
  }
  checkSlots('late', late);

  // 容器运行期塌陷：独立分区必须补回来，否则设置里整块入口消失。
  const collapse = run('collapse');
  validateSections('collapse', sectionsOf(collapse));
  if (!isContainer) {
    if (tabsOf(collapse).length > 0) errors.push('container collapsed but the container tab is still registered');
    if (sectionsOf(collapse).length === 0) {
      errors.push('container collapsed at runtime and no settings section came back (entry disappears until reload)');
    }
  }
  checkSlots('collapse', collapse);

  // 容器塌陷后又回来（声明 epoch 重跑回调）：必须回到「只有一个 tab」。
  const redeclare = run('redeclare');
  if (!isContainer) {
    if (tabsOf(redeclare).length !== 1) {
      errors.push(`container came back after collapse but ${tabsOf(redeclare).length} container tab(s) are registered (want exactly 1)`);
    }
    if (sectionsOf(redeclare).length > 0) {
      errors.push('container came back after collapse but the standalone settings section is still registered');
    }
  }
  checkSlots('redeclare', redeclare);

  const icons = [...new Set([
    ...standalone.filter((entry) => entry.name === 'settings.section.icon').map((entry) => entry.id),
    ...containerFirst.filter((entry) => entry.name === 'settings.section.icon').map((entry) => entry.id),
  ])];
  return {
    file,
    id,
    sections: standaloneSections,
    tabs: containerTabs,
    containerSections: sectionsOf(containerFirst),
    container: isContainer,
    late,
    collapse,
    redeclare,
    icons,
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
    checked: results.map(({ file, id, sections, tabs, containerSections, container, icons, late, collapse, redeclare }) => ({
      file, id, sections, tabs, containerSections, container, icons, late, collapse, redeclare,
    })),
    failed: failed.length,
  }, null, 2));
  if (failed.length > 0) {
    for (const result of failed) for (const message of result.errors) console.error(`${result.file}: ${message}`);
    process.exitCode = 1;
  }
}
