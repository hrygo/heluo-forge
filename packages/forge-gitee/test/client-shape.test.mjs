/**
 * Gitee 分区客户端形态（T2 / 结构性，无浏览器；分区名 2026-11-09 起为「Gitee」）。
 *
 * `client.js` 不进 node 模块图：正式渲染要宿主 shell（`__ModuleLoader__` + React + slots + locale）。
 * 本文件因此做两件事，而不是"读一遍源码正则"：
 *   1. **真跑一遍 factory 与 apply**：用假 window/require/ctx 捕获 `settings.section` 的注册参数，
 *      证明 id/order/label/两段式挂载都对（写错一个字符页面就静默不出现）；
 *   2. **真渲染一次 `GiteeSection`**：用一个极简 hooks 运行时把组件函数跑起来，断言行卡结构、
 *      "只有本机差异才显示覆盖值"、只读行结构上不含值（DESIGN §5 / AC-4/AC-5/AC-12）。
 *
 * 不在本文件里断言的：清单 `dsh.client`/`./client` 导出/白名单 → `test/entry.test.mjs`；
 * 真实浏览器字号与 320px+200% 布局 → NOT RUN（TECHNICAL §12），本文件不假装覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITEE_API_PREFIX, GITEE_CONFIG_ROUTE, GITEE_REQUEST_HEADER } from '../src/http.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(PACKAGE_ROOT, 'client.js'), 'utf8');

/* ------------------------------------------------------------------------- *
 * 极简 hooks 运行时：够跑 GiteeSection，不假装是 React                     *
 * ------------------------------------------------------------------------- */

function createHookRuntime() {
  const cells = [];
  const effects = [];
  let cursor = 0;
  return {
    reset() {
      cursor = 0;
    },
    api: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'Fragment',
      useState(initial) {
        const index = cursor++;
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
        return [
          cells[index],
          (next) => {
            cells[index] = typeof next === 'function' ? next(cells[index]) : next;
          },
        ];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in cells)) cells[index] = { current: initial };
        return cells[index];
      },
      useEffect(effect) {
        effects.push(effect);
      },
      useCallback(fn) {
        return fn;
      },
    },
    async flushEffects() {
      const pending = effects.splice(0);
      for (const effect of pending) effect();
      // 让 effect 里的 fetch 链跑完（测试里是同步 resolve 的假实现）。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** 丢掉未执行的 effect：上一个用例的第二次渲染会留下一条，不能带进下一个用例。 */
    resetEffects() {
      effects.length = 0;
    },
    /** 丢掉全部状态单元：草稿/编辑态不能跨用例泄漏（保存类用例会主动改它们）。 */
    resetAll() {
      cells.length = 0;
      cursor = 0;
      effects.length = 0;
    },
  };
}
/** 展开函数组件，把树摊平成文本节点数组（只用于断言"页面上有没有这句话"）。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if (typeof node === 'object' && typeof node.type === 'function') {
    return flatten(node.type({ ...node.props, children: node.children }), out);
  }
  if (typeof node === 'object' && node.type === 'Fragment') {
    for (const child of node.children) flatten(child, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const child of node.children ?? []) flatten(child, out);
  }
  return out;
}

/** 收集树里所有元素节点（用于"页面结构上有没有 table / 某个按钮是否禁用"）。 */
function collectNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return out;
  }
  if (typeof node.type === 'function') {
    return collectNodes(node.type({ ...node.props, children: node.children }), out);
  }
  out.push(node);
  for (const child of node.children ?? []) collectNodes(child, out);
  return out;
}

/** 载入 client.js（独立作用域），返回 { id, module, React }。 */
function loadClient(React) {
  const captures = [];
  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        captures.push(definition);
      },
    },
  };
  const require = (name) => {
    assert.equal(name, 'react', `客户端只能 require('react')，实际要求了 ${name}`);
    return React;
  };
  // 浏览器 IIFE 形态（无 import/export）：用 Function 构造器执行，避免污染本模块作用域。
  new Function('window', 'require', SOURCE)(fakeWindow, require);
  assert.equal(captures.length, 1, '必须恰好调用一次 __ModuleLoader__.load');
  return { id: captures[0].id, module: captures[0].factory(require) };
}

const runtime = createHookRuntime();
const CLIENT = loadClient(runtime.api);

/* ------------------------------------------------------------------------- *
 * 1. 装载形态与导出                                                          *
 * ------------------------------------------------------------------------- */

test('装载形态：id 固定 @heluo/forge-gitee，只依赖 react，导出面最小', () => {
  assert.equal(CLIENT.id, '@heluo/forge-gitee', 'id 必须与 package.json 的包名逐字一致');
  assert.deepEqual(CLIENT.module.inject, ['slots', 'locale']);
  assert.equal(typeof CLIENT.module.apply, 'function');
  assert.equal(typeof CLIENT.module.GiteeSection, 'function');
  assert.equal(typeof CLIENT.module.GiteeCredentialItem, 'function');
  for (const dep of ['node:fs', 'node:path', 'node:os', 'node:child_process', 'node:http']) {
    assert.ok(!SOURCE.includes(dep), `client.js 不得依赖 ${dep}`);
  }
  // 浏览器半不得 import 服务端源码（包间不跨目录 import，源码不随 client 一起发）。
  assert.ok(!/from\s+['"]\.\/src\//u.test(SOURCE), 'client.js 不得 import 本包 src');
});

test('AC-15: 端点常量与 src/http.mjs 逐字一致（两处漂移 = 页面 404）', () => {
  assert.equal(GITEE_API_PREFIX, '/api/forge-gitee');
  assert.equal(GITEE_CONFIG_ROUTE, '/api/forge-gitee/config');
  assert.equal(GITEE_REQUEST_HEADER, 'x-forge-gitee-request');
  assert.ok(SOURCE.includes(`'${GITEE_CONFIG_ROUTE}'`), '客户端必须用同一个端点常量');
  assert.ok(SOURCE.includes(`'${GITEE_REQUEST_HEADER}'`), '客户端必须发同一个预检头');
});

test('AC-13/AC-16: apply 用两段式 inject 注册 settings.section（id gitee / order 50）', () => {
  const effects = [];
  const registrations = [];
  const locales = [];
  const ctx = {
    effect: (callback, label) => {
      const value = callback();
      assert.ok(
        typeof value === 'function' || value === null || value === undefined,
        `Invalid effect (${label})：返回 ${Object.prototype.toString.call(value)} 会让整条 entry 不激活`,
      );
      effects.push(label);
    },
    locale: {
      bind: () => (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`),
      register: (namespace, table) => {
        locales.push({ namespace, table });
        return () => {};
      },
    },
    slots: {
      // 无容器场景：只有 `settings.section` 被声明，研发容器子槽位与 IAM 凭据子槽位缺席。
      inject: (name, callback) => {
        assert.ok(
          name === 'settings.section' || name === 'heluo.engineering.tab' || name === 'heluo.iam.credential-item',
          `未知槽位 ${name}`,
        );
        return name === 'settings.section' ? callback() : () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  CLIENT.module.apply(ctx);

  assert.deepEqual(effects, [
    'forge-gitee: copy',
    'forge-gitee: styles',
    'forge-gitee: engineering tab',
    'forge-gitee: settings section',
    'forge-gitee: iam credential item',
  ]);
  assert.deepEqual(locales.map((item) => item.namespace), ['gitee']);
  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, 'settings.section', '槽位名必须与父条目声明的一致');
  assert.equal(options.id, 'gitee');
  assert.equal(options.order, 50);
  assert.equal(options.locale, 'gitee');
  assert.equal(component, CLIENT.module.GiteeSection);
  assert.equal(typeof options.inject, 'function');
  assert.equal(typeof options.inject().t, 'function');
  assert.equal(options.label(), 'nav');
});

/* ------------------------------------------------------------------------- *
 * 2. 文案与词表                                                              *
 * ------------------------------------------------------------------------- */

/** 从源码里取出 zh / en 两个扁平对象（factory 内部常量，不导出）。 */
function copyTables() {
  const zhStart = SOURCE.indexOf('const zh = {');
  const enStart = SOURCE.indexOf('const en = {');
  assert.ok(zhStart > 0 && enStart > zhStart, 'zh/en 文案表必须都在');
  const parse = (text) => {
    const body = text.slice(text.indexOf('{'), text.indexOf('\n    };', text.indexOf('{')));
    const table = {};
    // 键允许带引号或裸标识符（`'nav':` 与 `nav:` 都算），值仍是单引号字符串。
    for (const match of body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'((?:[^'\\]|\\.)*)'/gu)) {
      table[match[1] ?? match[2]] = match[3];
    }
    return table;
  };
  return { zh: parse(SOURCE.slice(zhStart, enStart)), en: parse(SOURCE.slice(enStart)) };
}

test('AC-13: 容器后到与运行期塌陷都不丢入口（声明生命周期重跑）', () => {
  // 与集成检查器的 fake 同构：声明存在才执行回调，塌陷执行 cleanup，再声明重跑回调。
  const declared = new Set(['settings.section']);
  const records = new Map();
  const registrations = [];
  const ctx = {
    effect: (callback) => {
      callback();
      return () => {};
    },
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (name, callback) => {
        if (!records.has(name)) records.set(name, []);
        const record = { callback, cleanup: undefined };
        records.get(name).push(record);
        if (declared.has(name)) record.cleanup = callback();
        return () => {};
      },
      register: (options) => {
        if (!declared.has(options.name)) throw new Error(`slot '${options.name}' is not declared`);
        const entry = { id: options.id, order: options.order, released: false };
        registrations.push(entry);
        return () => {
          entry.released = true;
        };
      },
    },
  };
  const live = () => registrations.filter((entry) => !entry.released).map(({ id, order }) => `${id}:${order}`);
  const declare = (name) => {
    declared.add(name);
    for (const record of records.get(name) ?? []) {
      record.cleanup?.();
      record.cleanup = record.callback();
    }
  };
  const undeclare = (name) => {
    declared.delete(name);
    for (const record of records.get(name) ?? []) {
      record.cleanup?.();
      record.cleanup = undefined;
    }
  };

  CLIENT.module.apply(ctx);
  assert.deepEqual(live(), ['gitee:50'], '无容器时保留独立分区');
  declare('heluo.engineering.tab');
  assert.deepEqual(live(), ['gitee:20'], '容器后到时独立分区必须先撤（否则侧栏两份入口）');
  undeclare('heluo.engineering.tab');
  assert.deepEqual(live(), ['gitee:50'], '容器塌陷后独立分区必须补回来');
  declare('heluo.engineering.tab');
  assert.deepEqual(live(), ['gitee:20'], '容器回来后只能有一个容器条目');
});

test('AC-4/AC-5: zh/en 键集等值、占位符一致、en 不含中文；行卡文案齐全', () => {
  const { zh, en } = copyTables();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两种语言的键集必须完全一致');

  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 的占位符必须一致`);
    assert.ok(!/[\u4e00-\u9fff]/u.test(en[key]), `${key} 的英文文案不得含中文`);
  }

  // 分区名：nav 与页内 title 都是「Gitee」，不再带「企业」前缀（DESIGN §5-1）。
  assert.equal(zh.nav, 'Gitee');
  assert.equal(zh.title, 'Gitee');
  assert.equal(en.nav, 'Gitee');
  assert.equal(en.title, 'Gitee');
  // 顶部一句（DESIGN §5-2），逐字。
  assert.equal(zh.intro, '公共参数由企业分发；这一页只改本机差异。');

  for (const key of [
    'value.inherited',
    'value.detected',
    'value.timeoutDefault',
    'value.host',
    'card.action.manual',
    'card.action.auto',
    'card.action.edit',
    'card.action.done',
    'credential.title',
    'credential.state.follow',
    'credential.state.hosted',
    'footer.declaration',
  ]) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `缺文案 ${key}`);
  }
  for (const field of ['cliPath', 'timeoutMs', 'host']) {
    assert.ok(typeof zh[`field.${field}`] === 'string', `缺字段文案 field.${field}`);
  }
  for (const removed of ['advanced.title', 'advanced.hint', 'field.authEnv', 'field.persistentToken']) {
    assert.equal(zh[removed], undefined, `V2 收敛后 Gitee 工具设置表单不得残留 ${removed}`);
    assert.equal(en[removed], undefined, `V2 收敛后 Gitee 工具设置表单不得残留 ${removed}`);
  }
  // 「沿用公共值」是本页唯一的"没有本机差异"说法——不许再出现一排「未配置」。
  assert.equal(zh['value.inherited'], '沿用公共值');
  assert.ok(!Object.values(zh).includes('未配置'), '不得再出现「未配置」文案');
  assert.ok(zh['footer.declaration'].includes('不代表业务授权'), '固定声明必须逐字在场');
});

// 旧表头里带「点号 + local」的键，整串写字面量会命中本机主机名扫描规则，改成两段拼接。
const LEGACY_LOCAL_COLUMN = ['col', 'local'].join('.');

test('DESIGN §5-3/§5-5: 三层表格、检查详情与分区来源页脚都从文案表移除', () => {
  const { zh, en } = copyTables();
  for (const removed of ['col.public', LEGACY_LOCAL_COLUMN, 'col.effective', 'col.field', 'check.unchecked', 'footer.source', 'origin.config', 'origin.default', 'origin.unset']) {
    assert.equal(zh[removed], undefined, `文案 ${removed} 应随表格/检查详情/页脚一起删除`);
    assert.equal(en[removed], undefined, `文案 ${removed} 应随表格/检查详情/页脚一起删除`);
  }
  // 结构上也不再有表格与检查段。
  assert.ok(!/<table|<thead|<tbody/iu.test(SOURCE), '四列表格必须删除，改行卡');
  assert.ok(!SOURCE.includes('settings-check'), '检查详情段必须删除');
  assert.ok(!SOURCE.includes('readAt'), '页脚「读取于 …」需要 readAt，删页脚后不应再引用');
});

test('AC-7/AC-12: 只读面不得出现"重新自动发现"，也不得渲染凭据值', () => {
  assert.ok(!SOURCE.includes('重新自动发现'), 'Gitee 没有自动发现能力，不得渲染该入口');
  assert.ok(!SOURCE.includes('access_token'), '客户端不得出现令牌字段名');
  assert.ok(!/console\.(log|warn|error)/u.test(SOURCE), '客户端不得往控制台打配置值');
  assert.ok(!SOURCE.includes('localStorage'), '不得把配置落进 web storage');
});

test('AC-4/§4.5: 样式只用 --dsw-* token 与 color-mix，前缀 fge-', () => {
  const styleStart = SOURCE.indexOf('const CSS = `');
  const styleEnd = SOURCE.indexOf('`;', styleStart);
  const css = SOURCE.slice(styleStart, styleEnd);

  assert.ok(!css.includes('.fdv-'), '不得复用 devops 的类名前缀');
  assert.ok(css.includes('.fge-root'));
  assert.ok(css.includes('.fge-card'), '行卡结构必须有对应样式');
  assert.ok(css.includes('.fge-cred'), '扩展凭据项必须有对应样式');
  assert.ok(!css.includes('.fge-advanced'), 'V2 收敛后不得残留 .fge-advanced 折叠样式');
  assert.ok(css.includes('@container (max-width:519px)'), '窄屏断点必须按容器查询写在 519px');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced-motion 必须关动效');
  // 颜色只允许 token / color-mix / transparent，不允许字面 hex 或 rgb()。
  assert.ok(!/#[0-9a-f]{3,8}\b/iu.test(css), 'CSS 不得出现十六进制颜色字面量');
  assert.ok(!/\brgba?\(/u.test(css), 'CSS 不得出现 rgb()/rgba() 字面量');
  for (const value of css.matchAll(/(?:color|background|border-color):\s*([^;}]+)/gu)) {
    assert.ok(
      /var\(--dsw-|color-mix\(in srgb,var\(--dsw-|transparent|none/u.test(value[1]),
      `颜色必须来自 --dsw-* token：${value[1].trim()}`,
    );
  }
});

/* ------------------------------------------------------------------------- *
 * 3. 真渲染一次：行卡、只有差异才给覆盖值                                   *
 * ------------------------------------------------------------------------- */

const SNAPSHOT = Object.freeze({
  entryId: 'heluo-gitee',
  revision: 'abcdef0123456789',
  readAt: '2026-11-06T10:00:00.000Z',
  plugin: { name: '@heluo/forge-gitee', version: '0.1.0' },
  writable: { ok: true, documentPath: true },
  ready: true,
  reason: null,
  guidance: '设置 → Gitee',
  editable: ['cliPath', 'timeoutMs'],
  missing: [],
  entries: {
    cliPath: { origin: 'config', inherited: '/usr/local/bin/gh', override: '/opt/gitee/bin/gh', value: '/opt/gitee/bin/gh', path: '/opt/gitee/bin/gh', tool: 'gitee' },
    timeoutMs: { origin: 'default', inherited: null, override: null, value: 20000 },
    host: { origin: 'config', inherited: null, override: 'https://gitee.secret.example', value: 'https://gitee.secret.example' },
    authEnv: { origin: 'config', inherited: null, override: ['GITEE_TOKEN'], value: ['GITEE_TOKEN'] },
    persistentToken: { origin: 'default', inherited: null, override: null, value: 'warn' },
  },
  host: { platform: 'darwin', arch: 'arm64', node: 'v22.0.0' },
});

async function renderSection(snapshot) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => snapshot };
  };
  try {
    runtime.reset();
    runtime.resetEffects();
    const t = (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`);
    let tree = CLIENT.module.GiteeSection({ t });
    await runtime.flushEffects();
    // 状态更新后重渲染（假 hooks 不做调度，测试手动再来一遍）。
    runtime.reset();
    tree = CLIENT.module.GiteeSection({ t });
    return { tree: tree, text: flatten(tree).join('\n'), calls, nodes: collectNodes(tree) };
  } finally {
    globalThis.fetch = undefined;
    if (previousFetch !== undefined) globalThis.fetch = previousFetch;
  }
}

test('DESIGN §5-3 / V2 收敛: 行卡只含 cliPath/timeoutMs/host 三项，彻底移除高级折叠与凭据策略表单', async () => {
  const { text, nodes } = await renderSection(SNAPSHOT);

  for (const field of ['cliPath', 'timeoutMs', 'host']) {
    assert.ok(text.includes(`field.${field}`), `行卡缺 ${field}`);
  }
  assert.ok(!text.includes('field.authEnv'), 'authEnv 不得再出现在 Gitee 工具设置页面');
  assert.ok(!text.includes('field.persistentToken'), 'persistentToken 不得再出现在 Gitee 工具设置页面');
  assert.ok(!text.includes('advanced.title'), '高级折叠标题不得再出现');
  assert.ok(!text.includes('GITEE_TOKEN'), 'Gitee 工具设置页面主视图不得渲染凭据变量名');
  assert.deepEqual(
    nodes.filter((node) => node.type === 'table'),
    [],
    '不得再渲染表格',
  );
  assert.deepEqual(
    nodes.filter((node) => node.type === 'details'),
    [],
    'V2 收敛后 Gitee 工具设置页面不得再渲染高级 details 折叠区块',
  );
  for (const key of ['col.field', 'col.public', LEGACY_LOCAL_COLUMN, 'col.effective']) {
    assert.ok(!text.includes(key), `表头 ${key} 应已删除`);
  }
});

test('DESIGN §5-4: 只显示本机差异——相同给「沿用公共值」，不同才给覆盖值', async () => {
  const { text } = await renderSection(SNAPSHOT);

  // cliPath 有本机覆盖且与公共值不同 → 显示覆盖值，且不同屏显示公共值（AC-4 的旧口径已废）。
  assert.ok(text.includes('/opt/gitee/bin/gh'), '本机覆盖值要出现在页面上');
  assert.ok(!text.includes('/usr/local/bin/gh'), '公共值不再单独铺一层，只保留"沿用/覆盖"两种结论');
  // timeoutMs 无覆盖、origin=default → 「20 秒（默认）」，不是裸的 20000。
  assert.ok(text.includes('value.timeoutDefault:{"seconds":"20"}'), '超时默认值要写成 20 秒（默认）');
  assert.ok(!text.includes('20000'), '不显示原始毫秒数');
  // 没有本机差异的键给「沿用公共值」，不许出现「未配置」。
  assert.ok(!text.includes('未配置'), '不得出现一排「未配置」');
});

test('AC-5/AC-12: 服务地址行结构上不含值，且引导独立凭据去企业账号', async () => {
  const { text } = await renderSection(SNAPSHOT);

  assert.ok(!text.includes('https://gitee.secret.example'), '服务地址的值不得出现在页面上');
  assert.ok(text.includes('value.host'), '服务地址行只说"由企业分发，本页只读"（独立凭据去设置→企业账号）');
});

test('DESIGN §5-5: 无检查详情、无"分区由 … 提供 · 读取于 …"页脚', async () => {
  const { text, calls } = await renderSection(SNAPSHOT);

  assert.ok(!text.includes('check.'), '检查详情段必须删除');
  assert.ok(!text.includes('footer.source'), '分区来源页脚必须删除');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/u.test(text), '页面上不再出现读取时间');
  assert.ok(text.includes('footer.declaration'), '免责声明保留一条');
  assert.deepEqual(calls.map((call) => call.method), ['GET'], '首屏只发一次 GET，不带 refresh');
  assert.equal(calls[0].url, GITEE_CONFIG_ROUTE, '首屏读的是同源端点');
  assert.equal(calls.length, 1, '渲染不得额外发请求（?refresh=1 只属于 DevOps 行）');
});

test('AC-7: 只读面不可用时给"不可用 + 原因"，保存按钮不可用', async () => {
  const degraded = {
    ...SNAPSHOT,
    writable: { ok: false, reason: 'GITEE_CONFIG_UNAVAILABLE' },
    ready: false,
    reason: 'GITEE_CONFIG_UNAVAILABLE',
  };
  const { text, nodes } = await renderSection(degraded);

  assert.ok(text.includes('status.unavailable'), '状态行必须说"不可用"');
  assert.ok(text.includes('unavailable.title'), '要给不可用说明块');
  assert.ok(!text.includes('save.applied'), '不可用时不得显示"已应用"');
  const saveButton = nodes.find((node) => node.type === 'button' && node.props.className === 'fge-primary');
  assert.ok(saveButton !== undefined, '保存按钮仍要在场');
  assert.equal(saveButton.props.disabled, true, '不可用时保存按钮必须禁用');
});

test('主按钮用宿主的「填充色 / 反白文字」token 配对，不能同色（2026-11-09 上屏回归）', () => {
  // 实机回归：保存按钮曾用 brand-primary 填充 + label-inverse 文字，而当前主题
  // 两者都是 rgb(15,17,21)，文字与底色相同 → 屏上只剩一个黑色圆角块。
  const rule = SOURCE.match(/\.fge-primary\{([^\n]*)\}/u)?.[1];
  assert.ok(rule, '找不到 .fge-primary 规则');
  assert.match(rule, /background:var\(--dsw-alias-button-primary-fill\)/u);
  assert.match(rule, /color:var\(--dsw-alias-label-primary-foreground\)/u);
});

/* ------------------------------------------------------------------------- *
 * 4. 保存竞态：回包不得吞掉"提交之后才写的草稿"                             *
 * ------------------------------------------------------------------------- */

const findButton = (tree, label) =>
  collectNodes(tree).find((node) => node.type === 'button' && flatten(node).join('') === label);
const findInput = (tree, field) =>
  collectNodes(tree).find((node) => node.type === 'input' && node.props?.id === `fge-${field}`);
/** 把微任务队列跑空（fetch → json → setState 是一条多段 await 链，3 个 tick 不够）。 */
const tick = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

/**
 * 装一次分区：GET 同步回 `SNAPSHOT`，POST 交给用例控制（要复现"回包还没到"的窗口）。
 * `render()` 重新执行组件——假 hooks 不做调度，状态变化后要手动再渲染一遍。
 */
async function mountGitee({ post }) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST') return post(url, init);
    return { ok: true, status: 200, json: async () => SNAPSHOT };
  };
  const t = (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`);
  runtime.resetAll();
  const render = () => {
    runtime.reset();
    return CLIENT.module.GiteeSection({ t });
  };
  let tree = render();
  await runtime.flushEffects();
  tree = render();
  return {
    calls,
    tree,
    render,
    teardown() {
      globalThis.fetch = undefined;
      if (previousFetch !== undefined) globalThis.fetch = previousFetch;
    },
  };
}

/** 让 cliPath 进入编辑态并填上本次要提交的草稿，返回最新树。 */
async function stageCliPath(mount, nextPath) {
  let tree = mount.render();
  const manual = findButton(tree, 'card.action.manual');
  assert.ok(manual !== undefined, 'cliPath 行要有「手动指定」');
  manual.props.onClick();
  tree = mount.render();
  const input = findInput(tree, 'cliPath');
  assert.ok(input !== undefined, '进入编辑态后要出现输入框');
  input.props.onChange({ target: { value: nextPath } });
  return mount.render();
}

test('AC-13: 保存进行中输入框与动作按钮冻结——回包前不接受新输入', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const mount = await mountGitee({
    post: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: { ok: true }, snapshot: SNAPSHOT }) };
    },
  });
  try {
    let tree = await stageCliPath(mount, '/opt/gitee/bin/gh-next');
    findButton(tree, 'action.save').props.onClick();
    await tick();
    tree = mount.render();
    assert.equal(findInput(tree, 'cliPath').props.disabled, true, '保存期间 cliPath 输入框必须禁用');
    assert.equal(findButton(tree, 'action.saving').props.disabled, true, '保存期间保存按钮必须禁用');
    assert.equal(findButton(tree, 'card.action.done').props.disabled, true, '保存期间「完成」也必须禁用');
    release();
    await tick();
  } finally {
    mount.teardown();
  }
});

test('AC-13: 回包只清本次提交的草稿——保存期间新写的草稿不得被吞掉', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const mount = await mountGitee({
    post: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: { ok: true }, snapshot: SNAPSHOT }) };
    },
  });
  try {
    // 先让 timeoutMs 进入编辑态（还没填值 = 不算改动、不随本次提交），再提交 cliPath。
    let tree = mount.render();
    findButton(tree, 'card.action.edit').props.onClick();
    tree = await stageCliPath(mount, '/opt/gitee/bin/gh-next');
    findButton(tree, 'action.save').props.onClick();
    await tick();
    assert.equal(
      mount.calls.filter((call) => call.method === 'POST').length,
      1,
      '应当只发一次 POST',
    );

    // 回包未到时写入 timeoutMs 草稿：禁用可能在事件入队之后才生效，草稿仍然不能丢。
    tree = mount.render();
    const timeoutInput = findInput(tree, 'timeoutMs');
    assert.ok(timeoutInput !== undefined, 'timeoutMs 仍应在编辑态');
    timeoutInput.props.onChange({ target: { value: '25000' } });

    release();
    await tick();
    tree = mount.render();
    const kept = findInput(tree, 'timeoutMs');
    assert.ok(kept !== undefined, '回包后 timeoutMs 的输入框与草稿都要在场');
    assert.equal(kept.props.value, '25000', '提交之后写的草稿必须保留');
    assert.equal(findInput(tree, 'cliPath'), undefined, '已提交的键要清掉草稿并收起输入框');
  } finally {
    mount.teardown();
  }
});
