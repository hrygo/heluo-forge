/**
 * ReadinessSection 的最小渲染夹具（r16）。
 *
 * 客户端是浏览器 bundle（`window.__ModuleLoader__` + `require('react')`），所以这里用
 * `new Function` 在 Node 里执行源码，再用一个按调用序记账的 hook 运行时驱动组件：
 * 状态放 cells、副作用在 settle 里逐轮执行，直到没有新的 setState 为止。
 *
 * 只为本包服务：不跨包 import（AGENTS §4），也不依赖真实 React 或 DOM。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_CLIENT = fileURLToPath(new URL('../../client.js', import.meta.url));

/** 一个可以手动放行的 Promise（迟到回包用例）。 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function interpolate(template, params) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * 执行 client.js 并拿到模块导出与字典。
 * `FORGE_DEVOPS_CLIENT` 可指向另一份源码（先红后绿时指向 HEAD 副本，不改工作区）。
 */
export function loadClient({ file = process.env.FORGE_DEVOPS_CLIENT || DEFAULT_CLIENT, react } = {}) {
  const source = readFileSync(file, 'utf8');
  const dictionaries = {};
  const sections = [];
  let definition = null;
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  const stubReact = react ?? { createElement: () => null };
  new Function('window', 'require', source)(window, (name) => {
    assert.equal(name, 'react');
    return stubReact;
  });
  assert.ok(definition, 'client.js 必须通过 window.__ModuleLoader__.load 注册');
  const module = definition.factory((name) => {
    assert.equal(name, 'react');
    return stubReact;
  });
  const t = (key, params) => interpolate(dictionaries.devops?.zh?.[key] ?? `MISSING:${key}`, params);
  module.apply({
    locale: {
      bind: () => t,
      register: (namespace, dicts) => {
        dictionaries[namespace] = dicts;
      },
    },
    slots: {
      inject: (_name, register) => register(),
      register: (meta, component) => {
        sections.push({ meta, component });
      },
    },
    effect: (fn) => fn(),
    get: () => null,
  });
  return { definition, module, dictionaries, sections, t };
}

/**
 * 挂载 ReadinessSection。
 * responses 按请求顺序消费：普通对象 / 返回对象的函数 / Promise 均可。
 */
export async function mountReadiness({ responses = [], props = {}, file } = {}) {
  const cells = [];
  const effectsSeen = new Set();
  const pending = [];
  const cleanups = [];
  let cursor = 0;
  let version = 0;
  let tree = null;

  const React = {
    createElement: (type, config, ...children) => ({ type, props: config ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next;
          version += 1;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useEffect(fn) {
      const index = cursor++;
      if (effectsSeen.has(index)) return;
      effectsSeen.add(index);
      pending.push(fn);
    },
  };

  const client = loadClient({ file, react: React });
  const Section = client.module.ReadinessSection;
  const calls = [];
  let index = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const entry = responses[index++];
    assert.ok(entry !== undefined, `意外的第 ${index} 个请求：${url}`);
    const resolved = typeof entry === 'function' ? await entry() : await entry;
    if (resolved && resolved.networkError === true) throw new TypeError('fetch failed');
    return {
      ok: resolved.status >= 200 && resolved.status < 300,
      status: resolved.status,
      json: async () => resolved.body ?? null,
    };
  };

  const render = () => {
    cursor = 0;
    return Section({ t: client.t, ...props });
  };

  const settle = async () => {
    tree = render();
    for (let round = 0; round < 40; round += 1) {
      for (const effect of pending.splice(0)) {
        const cleanup = effect();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      const before = version;
      await new Promise((resolve) => setImmediate(resolve));
      tree = render();
      if (version === before && pending.length === 0) return;
    }
    throw new Error('readiness harness 未能稳定（组件持续 setState）');
  };

  const textOf = (node) => {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return (node.children ?? []).map(textOf).join('');
  };

  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
  };

  const findAll = (label) => {
    const hits = [];
    walk(tree, (node) => {
      if (textOf(node) === label) hits.push(node);
    });
    return hits;
  };

  await settle();

  /** 按 `data-group` 定位两条固定行（identity / tools），组内再按 class 取文本。 */
  const rowNode = (group) => {
    let hit = null;
    walk(tree, (node) => {
      if (hit) return;
      if (typeof node.props?.className === 'string'
        && node.props.className.split(/\s+/u).includes('fdv-row')
        && node.props['data-group'] === group) hit = node;
    });
    assert.ok(hit, `找不到 group=${group} 的行`);
    return hit;
  };

  const inRow = (group, className) => {
    let hit = null;
    walk(rowNode(group), (node) => {
      if (hit) return;
      if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/u).includes(className)) hit = node;
    });
    assert.ok(hit, `group=${group} 内找不到 .${className}`);
    return hit;
  };

  return {
    tree: () => tree,
    text: () => textOf(tree),
    row: (group) => textOf(rowNode(group)),
    rowState: (group) => textOf(inRow(group, 'fdv-row-state')),
    rowDetail: (group) => textOf(inRow(group, 'fdv-details')),
    findAll,
    find: (label) => {
      const hits = findAll(label);
      assert.equal(hits.length, 1, `期望恰好 1 个「${label}」，实际 ${hits.length}`);
      return hits[0];
    },
    click: async (label, index = 0) => {
      const candidates = findAll(label).filter((node) => node.type === 'button' || node.props?.onClick);
      const target = candidates[index];
      assert.ok(target, `找不到可点击的「${label}」#${index}`);
      assert.equal(typeof target.props?.onClick, 'function', `「${label}」没有 onClick`);
      assert.notEqual(target.props.disabled, true, `「${label}」处于禁用态`);
      target.props.onClick();
      await settle();
    },
    buttons: (label) => findAll(label).filter((node) => node.type === 'button'),
    rows: () => {
      const hits = [];
      walk(tree, (node) => {
        if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/u).includes('fdv-row')) {
          hits.push(textOf(node));
        }
      });
      return hits;
    },
    button: (label, index = 0) => {
      const candidates = findAll(label).filter((node) => node.type === 'button');
      assert.equal(candidates.length, 1, `期望恰好 1 个按钮「${label}」，实际 ${candidates.length}`);
      return candidates[index];
    },
    flush: settle,
    calls,
    props,
    unmount: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      globalThis.fetch = originalFetch;
    },
  };
}
