/**
 * T5 配置页客户端形态（结构性，无浏览器）。
 *
 * 定位：client.js 是**不进 node 模块图**的浏览器侧半——正式渲染需要宿主 shell
 * （`window.__ModuleLoader__` + React + slots + locale），本文件因此只守「页面骨架的契约面」，
 * 把能离线断言的东西全部固化：
 *
 *   1. 装载形态：`__ModuleLoader__.load({id, factory(require)})`、`factory` 只 require('react')、
 *      导出 `apply`/`inject` 与四个展示组件（宿主按 `id` 找模块，写错一个字符页面就静默不出现）；
 *   2. 挂载点：`settings.section` / id `devops` / order 60 / label 走 i18n 键（AC-6 两次点击）；
 *   3. 契约端点与头：GET+POST `/api/forge-devops/cli`、`?refresh=1` 只在 GET、
 *      写操作带 `x-forge-devops-request`、GET 只带 accept（TECHNICAL §3.1）；
 *   4. 文案：zh/en 键集完全一致、占位符一致、en 不含中文；六个字段与五个 origin
 *      与 `src/cli-config.mjs` 的 `CLI_FIELDS`/`CLI_ORIGINS` 逐字对齐（不另立词表）；
 *   5. 交付红线：无原始 HTML 注入、无 console / web storage / cookie、无本机路径字面量、
 *      度量常量集中一处（DESIGN §5.2 的 13/500、34、12/18、12px 0 不得散落组件内）；
 *   6. 请求语义：保存体带 `revision` 与 `fields`、`null` = 清除该键、409 不清空 staged、
 *      错误码读统一错误体的顶层 `code`（不发明 `error.code` 信封）。
 *
 * 不在本文件里断言的（归属其他任务，避免两套检查器互相漂移）：
 *   清单 `dsh.client`/`./client` 导出/发布白名单、README 口径 → `test/delivery-selfcheck.test.mjs`；
 *   真实浏览器渲染、Windows 字号与中文目录宽度 → NOT RUN（DESIGN §9），本文件不假装覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI_FIELDS, CLI_ORIGINS } from '../src/cli-config.mjs';
// P2-1：包装脚本后缀表唯一真源在 cli-discovery（校验侧 import 复用）。
import { WRAPPER_SUFFIXES } from '../src/cli-discovery.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client.js');
const SOURCE = readFileSync(CLIENT_FILE, 'utf8');

/* ------------------------------------------------------------------------- *
 * 装载 harness：假 window + 假 require，把 factory 真正跑起来（不是纯正则）    *
 * ------------------------------------------------------------------------- */

/** 极简 React 替身：只提供 factory 顶层与 hooks 的表面，不渲染。 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    Fragment: 'Fragment',
  };
}

/** 载入 client.js，返回 { id, factory, module }（factory 已调用一次）。 */
function loadClient(React = fakeReact()) {
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
  // client.js 是浏览器 IIFE 形态（无 import/export），用 Function 构造器执行以获得独立作用域。
  new Function('window', 'require', SOURCE)(fakeWindow, require);
  assert.equal(captures.length, 1, '必须恰好调用一次 __ModuleLoader__.load');
  const definition = captures[0];
  const module = definition.factory(require);
  return { id: definition.id, definition, factory: definition.factory, module, React };
}

const CLIENT = loadClient();

/* ------------------------------------------------------------------------- *
 * 1. 装载形态与导出                                                          *
 * ------------------------------------------------------------------------- */

test('装载形态：id 固定 @heluo/forge-devops，factory(require) 只依赖 react', () => {
  assert.equal(CLIENT.id, '@heluo/forge-devops', 'id 必须与 package.json 的包名逐字一致（宿主按 id 找模块）');
  assert.equal(typeof CLIENT.definition.factory, 'function');
  assert.deepEqual(Object.keys(CLIENT.module).sort(), [
    'CandidateList',
    'CliEntryField',
    'DevopsSection',
    'StatusLine',
    'apply',
    'inject',
  ].sort());
  assert.deepEqual(CLIENT.module.inject, ['slots', 'locale'], 'inject 缺一项宿主就不装配客户端半');
  assert.equal(typeof CLIENT.module.apply, 'function');
  for (const name of ['DevopsSection', 'CliEntryField', 'StatusLine', 'CandidateList']) {
    assert.equal(typeof CLIENT.module[name], 'function', `${name} 必须是可渲染的组件函数`);
  }
  // 段控件随「事实来源」一起下线：导出面不允许留一个没人能填的控件（页面收窄到三键）。
  assert.equal(CLIENT.module.SegmentedField, undefined, 'SegmentedField 必须从导出面移除（r5 收窄到三行一列）');
  // 浏览器侧模块不得自带 node 依赖（否则宿主 require 直接抛错，页面白屏）。
  for (const dep of ['node:fs', 'node:path', 'node:os', 'node:child_process', 'node:http']) {
    assert.ok(!SOURCE.includes(dep), `client.js 不得依赖 ${dep}`);
  }
});

/* ------------------------------------------------------------------------- *
 * 2. 分区挂载（apply 真跑一遍，用假 ctx 捕获注册参数）                        *
 * ------------------------------------------------------------------------- */

/**
 * 假 ctx：effect 立即执行并记录；`slots` 模拟宿主「父条目声明槽位 → 子条目 inject 回调」的语义。
 * `declareSlot: false` 复现冷启动最坏时序：本插件 apply 时父条目还没声明该槽位。
 */
function createFakeCtx({ declareSlot = true } = {}) {
  const effects = [];
  const slots = [];
  const locales = [];
  const declared = new Set(declareSlot ? ['settings.section'] : []);
  const waiters = new Map();
  const flush = (name) => {
    if (!declared.has(name)) return;
    const pending = waiters.get(name) ?? [];
    waiters.delete(name);
    for (const callback of pending) callback();
  };
  const ctx = {
    // 与 cordis `_execute` 同语义的 effect 返回值校验：只收 函数(disposer) / null /
    // Promise / 可迭代；普通对象（例如浏览器里的 `<style>` 元素）抛 `Invalid effect`。
    // 离线 Node 无 document 走 null 分支，浏览器分支由下方「Invalid effect 回归」用例补。
    effect: (callback, label) => {
      const value = callback();
      const cordisEffect =
        typeof value === 'function' ||
        value === null || value === undefined ||
        (typeof value === 'object' &&
          ('then' in value || Symbol.iterator in value || Symbol.asyncIterator in value));
      if (!cordisEffect) {
        throw new TypeError(`Invalid effect (${label}): effect 回调返回 ${Object.prototype.toString.call(value)}`);
      }
      effects.push({ label, dispose: value ?? null });
    },
    slots: {
      /** 模拟父条目（settings 壳）晚到的槽位声明。 */
      declare: (name) => {
        declared.add(name);
        flush(name);
      },
      /** 宿主语义：已声明→立即回调；未声明→挂起，声明后补调；返回解绑函数。 */
      inject: (name, callback) => {
        if (!declared.has(name)) {
          const pending = waiters.get(name) ?? [];
          pending.push(callback);
          waiters.set(name, pending);
          return () => {};
        }
        callback();
        return () => {};
      },
      register: (meta, component) => {
        // 宿主实现：槽位未声明时 register 直接抛错——这条假实现刻意保留该语义。
        if (!declared.has(meta.name)) {
          throw new Error(`slot "${meta.name}" is not declared (a parent entry's children table must declare it)`);
        }
        slots.push({ meta, component });
        return () => {};
      },
    },
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
      bind: (namespace) => (key, params) => `${namespace}.${key}${params ? JSON.stringify(params) : ''}`,
    },
  };
  return { ctx, effects, slots, locales, declare: (name) => ctx.slots.declare(name) };
}

function applyToFakeCtx(module, options) {
  const fake = createFakeCtx(options);
  module.apply(fake.ctx);
  return fake;
}

const APPLIED = applyToFakeCtx(CLIENT.module);

test('挂在 settings.section/devops（order 60，label 走 i18n 键）', () => {
  assert.equal(APPLIED.slots.length, 1, '只注册一个分区');
  const [{ meta, component }] = APPLIED.slots;
  assert.equal(meta.name, 'settings.section', 'AC-6：首页→设置→本页 = 两次点击，只能落在 settings.section');
  assert.equal(meta.id, 'devops', 'id 与分区标识同源，改名会让用户的既有书签路径漂移');
  assert.equal(meta.order, 60, 'order 60：排在宿主内建分区之后、调试分区之前');
  assert.equal(meta.locale, 'devops', '声明 locale 命名空间，宿主才会在切换语言时重渲染');
  assert.equal(typeof meta.label, 'function', 'label 必须是函数：语言切换后要重取文案');
  assert.ok(String(meta.label()).length > 0, 'label 不能为空（侧栏会渲染成空白项）');
  assert.equal(component, CLIENT.module.DevopsSection, '渲染的就是本模块的根组件');
  const injected = typeof meta.inject === 'function' ? meta.inject() : meta.inject;
  assert.equal(typeof injected?.t, 'function', '组件通过 inject 拿到绑定命名空间的 t()');
});

test('装配注册双语字典与样式，且 effect 可整体回收', () => {
  assert.equal(APPLIED.locales.length, 1, '只注册一个命名空间');
  const [{ namespace, dictionaries }] = APPLIED.locales;
  assert.equal(namespace, 'devops');
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh']);
  assert.equal(APPLIED.effects.length, 3, '三条 effect：字典、样式、分区注册');
  for (const effect of APPLIED.effects) {
    assert.equal(typeof effect.label, 'string', '每条 effect 都要有可读标签（宿主 hook 列表里能定位）');
  }
  // 官方插件同法：单一全局 style 标签 + plugin-css 去重键，重复挂载不产生第二份样式。
  assert.match(SOURCE, /data-plugin-css=["'`]/u, '样式去重键必须落在 data-plugin-css 上');
  assert.ok(!SOURCE.includes('createTextNode'), '文案一律走 React children，不手工建文本节点');
});

/**
 * 真实浏览器 boot 回归（2026-10-30，P0）：`ensureStyle()` 曾返回 `<style>` DOM 元素，
 * 而 `ctx.effect` 只收 函数(disposer) / null / Promise / 可迭代——cordis `_execute`
 * 抛 `TypeError: Invalid effect` → apply 整条抛错 → entry `failed` → 页面 HARNESS
 * 「web boot: 1 entry did not activate / @heluo/forge-devops: failed」。
 * 离线 Node 无 document 走 `return null` 合法分支，所以旧单测全绿也看不出来；
 * 本用例补上「有 document」的浏览器分支：伪造 document 首挂载，逐条校验 effect 返回值。
 */
test('浏览器分支：有 document 时样式 effect 返回 disposer，不抛 Invalid effect（boot 回归）', () => {
  const created = [];
  const head = { appendChild: (tag) => created.push(tag) };
  const makeTag = () => ({
    tagName: 'STYLE',
    dataset: {},
    textContent: '',
    remove() {
      const index = created.indexOf(this);
      if (index >= 0) created.splice(index, 1);
    },
  });
  const fakeDocument = {
    querySelector: () => null, // 首挂载：无既有 tag
    createElement: makeTag,
    head,
  };
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument;
  let applied;
  try {
    applied = applyToFakeCtx(CLIENT.module); // effect 校验内置在假 ctx 里，非法返回值直接抛
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.equal(created.length, 1, '首挂载必须真的挂上一个样式 tag');
  const styles = applied.effects.find((effect) => effect.label === 'forge-devops: styles');
  assert.ok(styles, '样式 effect 必须注册');
  assert.equal(typeof styles.dispose, 'function', 'effect 返回值必须是 disposer（宿主靠它卸载）');
  styles.dispose();
  assert.equal(created.length, 0, 'effect 卸载后样式 tag 必须被移除');
  // 重复挂载：既有 tag 场景返回 null（同样是合法 effect 值），且不接管别处创建的 tag。
  globalThis.document = {
    querySelector: () => ({ tagName: 'STYLE' }),
    createElement: makeTag,
    head,
  };
  try {
    const again = applyToFakeCtx(CLIENT.module);
    const againStyles = again.effects.find((effect) => effect.label === 'forge-devops: styles');
    assert.equal(againStyles.dispose, null, '既有 tag 不接管：返回 null，卸载时不代其移除');
    assert.equal(created.length, 0, '既有 tag 时不产生第二份样式');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

/**
 * QA D-2（2026-10-29，P1）：`settings.section` 由父条目晚于本插件声明时，裸 `slots.register`
 * 会抛 `slot "settings.section" is not declared`，整片分区消失（浏览器里表现为"配置页不见了"，
 * 离线单测与 dump-config 都看不出来）。永久门禁：行为面（晚声明 → 不抛错 → 声明后补挂）
 * + 静态面（注册只经 `slots.inject`，不回到裸 register）。
 */
test('槽位晚于 apply 声明时不得抛错，声明后分区仍挂上（D-2 行为面）', () => {
  const late = applyToFakeCtx(CLIENT.module, { declareSlot: false });
  assert.equal(late.slots.length, 0, '槽位未声明时不得假装注册成功（那是宿主直接抛错的前一步）');
  late.declare('settings.section');
  assert.equal(late.slots.length, 1, '槽位声明后必须补挂上，否则配置页在冷启动时序下消失');
  assert.equal(late.slots[0].meta.id, 'devops');
  assert.equal(late.slots[0].component, CLIENT.module.DevopsSection);
});

test('分区注册一律经 slots.inject 等声明，禁止裸 register（D-2 静态面）', () => {
  assert.match(
    SOURCE,
    /ctx\.slots\.inject\(\s*'settings\.section'/u,
    '必须用 ctx.slots.inject(\'settings.section\', () => ctx.slots.register(...)) 等父条目声明',
  );
  assert.ok(
    !/ctx\.effect\(\s*\(\)\s*=>\s*ctx\.slots\.register/u.test(SOURCE),
    'effect 里直接 register 会让挂载依赖模块加载顺序（宿主冷启动会抛 not declared）',
  );
  const registers = SOURCE.match(/ctx\.slots\.register\(/gu) ?? [];
  const injectIndex = SOURCE.search(/ctx\.slots\.inject\(\s*'settings\.section'/u);
  const registerIndex = SOURCE.search(/ctx\.slots\.register\(/u);
  assert.equal(registers.length, 1, '分区只注册一次');
  assert.ok(injectIndex >= 0 && injectIndex < registerIndex, 'register 必须写在 inject 的等待回调里');
});

/* ------------------------------------------------------------------------- *
 * 3. 契约端点与请求头（TECHNICAL §3.1）                                      *
 * ------------------------------------------------------------------------- */

test('端点：GET+POST /api/forge-devops/cli，刷新参只在 GET 上', () => {
  assert.ok(SOURCE.includes("'/api/forge-devops/cli'"), '端点必须与 src/http.mjs 的 CLI_API_PREFIX 对齐');
  const fetches = [...SOURCE.matchAll(/fetch\(([^;]{0,120}?),\s*\{/gs)].map((match) => match[1].trim());
  assert.ok(fetches.length > 0, '页面必须至少一处 fetch（读或写）');
  for (const url of fetches) {
    assert.match(url, /CLI_ENDPOINT/u, `所有请求都必须基于同一个端点常量，实际：${url}`);
    assert.ok(!url.includes('http://') && !url.includes('https://'), '只允许同源相对路径，不得外连');
  }
  // 只有「刷新」才带 refresh=1，且必须是 GET（AC-4：工具调用不触发扫描，只有页面刷新会重扫）。
  const refreshUses = [...SOURCE.matchAll(/`\$\{CLI_ENDPOINT\}\?refresh=1`/gu)];
  assert.equal(refreshUses.length, 1, 'refresh=1 只应出现在一处（读路径）');
  assert.match(SOURCE, /method:\s*'POST'/u);
  assert.match(SOURCE, /cache:\s*'no-store'/u, '读请求必须显式 no-store（服务端也设，双保险）');
  // 保存体：revision 栅栏 + fields 增量，null 表示清除该键。
  assert.match(SOURCE, /JSON\.stringify\(\{\s*revision:[^}]*fields\s*\}\)/su, '保存体必须是 { revision, fields }');
  assert.match(SOURCE, /return field === 'timeoutMs' \? Number\(value\) : value;/u, 'timeoutMs 必须按数字提交');
  assert.match(SOURCE, /if \(value === ''\) return null;/u, '空串必须转 null（= 清除该层，回落下一层）');
});

test('写操作带 CSRF 预检头，读带 accept；缺头服务端回 400', () => {
  assert.match(SOURCE, /'x-forge-devops-request':\s*'1'/u, 'POST 必须带 x-forge-devops-request: 1');
  assert.match(SOURCE, /'content-type':\s*'application\/json'/u, 'POST 必须声明 JSON');
  assert.match(SOURCE, /accept:\s*'application\/json'/u, 'GET 至少声明 accept');
  assert.match(SOURCE, /method:\s*'POST',\s*headers:\s*REQUEST_HEADERS/u, 'POST 必须用写头常量，不得临时拼');
});

test('错误码读统一错误体的顶层 code（不发明 error.code 信封）', () => {
  const fnStart = SOURCE.indexOf('function errorCode(');
  assert.ok(fnStart > 0, '错误码必须收在一个 errorCode() helper 里');
  const fnEnd = SOURCE.indexOf('\n    }', fnStart);
  assert.ok(fnEnd > fnStart, 'errorCode 函数体必须能定位');
  const fnBody = SOURCE.slice(fnStart, fnEnd);
  assert.match(fnBody, /body\.code === 'string'/u, 'TECHNICAL §3.1：{ ok:false, code, message, errors? } 是顶层 code');
  assert.match(fnBody, /body\.error\.code === 'string'/u, '旧信封作为兜底留在同一函数内');
  // 信封兜底只允许出现在 errorCode 里：别处再读一次就会有两套错误语义。
  const outside = SOURCE.slice(0, fnStart) + SOURCE.slice(fnEnd);
  assert.equal(outside.match(/\.error\b/gu)?.length ?? 0, 0, '带信封的写法只允许在 errorCode 的兜底分支里读');
  assert.match(SOURCE, /response\.status === 409/u, 'AC-9：revision 冲突必须单独处理');
  assert.match(SOURCE, /response\.status === 422/u, 'AC-9：逐字段非法必须落到对应字段');
});

/* ------------------------------------------------------------------------- *
 * 4. 文案：双语对齐 + 与服务端词表同源                                        *
 * ------------------------------------------------------------------------- */

const DICTS = APPLIED.locales[0].dictionaries;
const zh = DICTS.zh;
const en = DICTS.en;

test('zh/en 键集完全一致、占位符一致（少一条就是界面上出现裸键）', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en 与 zh 必须一一对应');
  const keys = Object.keys(zh);
  // r5 删掉 10 个隐藏键文案后总数从 64 收到 54。这里不靠「总数够大」撑强度：
  // 先断**必含面**（状态/动作/入口/字段/来源/错误/兜底各一组），再断总数不倒退。
  const REQUIRED = [
    'nav',
    'title',
    'intro',
    'status.ready',
    'status.missing',
    'status.unavailable',
    'action.takeOver',
    'action.reset',
    'action.refresh',
    'entry.dop',
    'entry.gh',
    'entry.placeholder',
    'entry.placeholder.reset',
    'entry.hint.discovered',
    'entry.hint.env',
    'entry.hint.config',
    'entry.hint.missing',
    'entry.hint.help',
    'candidates.summary',
    'candidates.current',
    'field.timeoutMs',
    'field.timeoutMs.hint',
    'section.commandline',
    'error.wrapperScript',
    'error.pathLength',
    'error.timeout',
    'error.load',
    'saved',
    'saveFailed',
    'saveFailedStale',
    'unavailable.title',
    'unavailable.envDop',
    'unavailable.envGh',
  ];
  const missing = REQUIRED.filter((key) => !keys.includes(key));
  assert.deepEqual(missing, [], `缺这些关键文案（页面会露出裸键）：${missing.join(', ')}`);
  assert.ok(keys.length >= 54, `文案太少（${keys.length}）：收窄是删隐藏键文案，不是删状态/动作/兜底`);
  const placeholders = (value) => [...String(value).matchAll(/\{([a-zA-Z]+)\}/gu)].map((match) => match[1]).sort();
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} 必须是字符串`);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的中英文占位符不一致（运行时会显示 {xxx}）`);
    assert.ok(String(zh[key]).trim().length > 0, `zh.${key} 不能为空`);
    assert.ok(String(en[key]).trim().length > 0, `en.${key} 不能为空`);
  }
});

test('英文文案不含中文（漏译会混排）', () => {
  const cjk = /[\u4e00-\u9fff]/u;
  const offenders = Object.keys(en).filter((key) => cjk.test(en[key]));
  assert.deepEqual(offenders, [], `en 里出现中文：${offenders.join(', ')}`);
});

test('页面文案零命中旧显示名与隐藏字段词（收窄后不得残留说明）', () => {
  // 页面只问「入口在哪、超时多少」：事实来源改由后端推导，所以页面上不该再出现
  // 服务地址 / gh 组织 / 事实来源 / mock / enterprise / .exe 任何一处（DESIGN §2.3）。
  const forbidden = /dop 服务地址|gh 组织|事实来源|\bmock\b|\benterprise\b|\.exe/u;
  for (const [locale, dict] of [['zh', zh], ['en', en]]) {
    const hits = Object.keys(dict).filter((key) => forbidden.test(dict[key]));
    assert.deepEqual(hits, [], `${locale} 里仍有旧字段/旧显示名文案：${hits.join(', ')}`);
  }
  // 显示名与进入路径同源改名：「企业 DevOps」，中英一处两边都改。
  assert.equal(zh.nav, '企业 DevOps');
  assert.equal(zh.title, zh.nav, 'nav 与 title 必须同句，否则侧栏与页头两个名字');
  assert.equal(en.nav, 'Enterprise DevOps');
  // 隐藏三键的文案整组删除：留着就是给不可见字段写说明。
  for (const key of ['field.dopEndpoint', 'field.dopEndpoint.hint', 'field.ghOwner', 'field.ghOwner.hint', 'field.sourceType', 'field.sourceType.hint', 'error.endpoint', 'error.owner', 'error.source', 'section.connection']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(zh, key), `隐藏键文案 ${key} 必须删除（页面不持有不可见字段）`);
  }
});

test('页面三键收敛，服务端六键词表不动（页面收窄 ≠ 契约放宽）', () => {
  // 页面可编辑面的唯一真源：client.js 的 PAGE_FIELDS。它必须是 CLI_FIELDS 的真子集，
  // 且恰好是 dop 入口 / gh 入口 / 超时三项——多一键就是页面又问了用户判断不了的机器事实。
  const pageDecl = SOURCE.match(/const PAGE_FIELDS = \[([^\]]+)\]/u);
  assert.ok(pageDecl, 'client.js 必须声明 PAGE_FIELDS（页面可编辑面）');
  const pageFields = pageDecl[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean);
  assert.deepEqual(pageFields, ['dopBin', 'ghBin', 'timeoutMs'], '页面只收敛到三键（DESIGN §2.1）');
  for (const field of pageFields) {
    assert.ok(CLI_FIELDS.includes(field), `PAGE_FIELDS 的 ${field} 不在服务端 CLI_FIELDS 里（页面会提交服务端不认的键）`);
  }
  // 文案面：两个路径键用入口卡标题（entry.*，说明按来源状态共用），超时用 field.* 标题 + 说明。
  const labelKeys = { dopBin: 'entry.dop', ghBin: 'entry.gh', timeoutMs: ['field.timeoutMs', 'field.timeoutMs.hint'] };
  for (const field of pageFields) {
    const keys = labelKeys[field];
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `缺文案 ${key}（字段 ${field} 会显示裸键）`);
    }
  }
  // 隐藏三键没有任何表单文案：页面不渲染它们，留着文案只会变成第二份没人校验的字段表。
  for (const field of CLI_FIELDS.filter((item) => !pageFields.includes(item))) {
    for (const key of [`field.${field}`, `field.${field}.hint`]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(zh, key), `隐藏字段 ${field} 不该有文案 ${key}`);
    }
  }
  for (const key of ['entry.hint.discovered', 'entry.hint.env', 'entry.hint.config', 'entry.hint.missing']) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `缺来源状态说明 ${key}`);
  }
  for (const origin of Object.values(CLI_ORIGINS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, `origin.${origin}`), `缺 origin.${origin} 的 Tag 文案`);
  }
  assert.equal(Object.values(CLI_ORIGINS).length, 5, 'origin 枚举只有五个（config/env/discovered/default/missing）');
  // 客户端自己的字段表必须与 cli-config 同序：顺序即契约顺序，两处不一致会让补丁合并错位。
  const declared = SOURCE.match(/const CLI_FIELDS = \[([^\]]+)\]/u);
  assert.ok(declared, 'client.js 必须声明自己的 CLI_FIELDS（与 cli-config 对齐的契约面）');
  const names = declared[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean);
  assert.deepEqual(names, [...CLI_FIELDS], `客户端字段表与 cli-config.CLI_FIELDS 不一致：${names.join(',')}`);
});

test('提示文案零环境变量名、零目录路径（用户不该被要求改系统环境）', () => {
  // 「页面之外不出现机器码」：提示里出现 FORGE_DEVOPS_* 就把用户推回环境变量。
  const hints = Object.keys(zh).filter((key) => key.startsWith('entry.hint.') || key.startsWith('field.') || key === 'intro');
  for (const key of hints) {
    assert.ok(!/FORGE_DEVOPS_/u.test(zh[key]), `${key} 里出现了环境变量名（AC-12 要求 UI 优先）`);
    assert.ok(!/[A-Za-z]:\\|\/usr\/|\/opt\//u.test(zh[key]), `${key} 里出现绝对路径样例（AC-10 回显边界）`);
  }
  // 兜底说明里给环境变量是允许的（那是降级场景），但必须集中在 unavailable.* 一组。
  const envMentions = Object.keys(zh).filter((key) => /FORGE_DEVOPS_/u.test(zh[key]));
  assert.deepEqual(envMentions.sort(), ['unavailable.envDop', 'unavailable.envGh'], '只有写面不可用时的兜底才提环境变量');
  // 包装脚本必须按后缀表拒收，与 cli-config 的 WRAPPER_SUFFIXES 同源语义。
  for (const suffix of WRAPPER_SUFFIXES) {
    assert.ok(suffix.startsWith('.'), `WRAPPER_SUFFIXES 项必须以点开头：${suffix}`);
  }
  assert.match(SOURCE, /const WRAPPER_PATTERN = \/\\\.\(\?:cmd\|bat/, '客户端必须在 blur 时就拒收 .cmd/.bat（而不是等 422）');
});

/* ------------------------------------------------------------------------- *
 * 5. 交付红线                                                                *
 * ------------------------------------------------------------------------- */

test('无原始 HTML 注入、无 console、无 web storage / cookie', () => {
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/u.test(SOURCE), '只用 React children 渲染');
  assert.ok(!/\bconsole\s*\./u.test(SOURCE), '客户端不得打印（路径会被写进宿主控制台）');
  assert.ok(!/\b(?:localStorage|sessionStorage|indexedDB)\b/u.test(SOURCE), '发现结果与路径不得持久化到浏览器');
  assert.ok(!/document\.cookie/u.test(SOURCE), '不得读写 cookie');
  assert.ok(!/\beval\s*\(|new Function\s*\(/u.test(SOURCE), '不得动态求值');
});

test('无本机路径 / 内网地址 / 凭据字面量（AC-10）', () => {
  const offenders = [
    [/[A-Za-z]:\\\\?[\w .-]+/u, 'Windows 盘符路径'],
    [/(?:^|["'`\s])\/(?:Users|home|opt|usr|Volumes)\//u, 'POSIX 绝对路径'],
    [/https?:\/\/(?![\w-]+\/\*)/u, '硬编码服务地址'],
    [/\b(?:token|secret|password|passwd)\s*[:=]\s*['"][^'"]+/iu, '凭据字面量'],
  ].filter(([pattern]) => pattern.test(SOURCE)).map(([, label]) => label);
  assert.deepEqual(offenders, [], `客户端不得内嵌本机信息：${offenders.join('; ')}`);
});

test('度量常量集中一处：DESIGN §5.2 的 13/500、34、12/18、12px 0 不散落组件内', () => {
  const metrics = SOURCE.match(/const METRICS = \{([\s\S]*?)\n    \};/u);
  assert.ok(metrics, '必须有集中的 METRICS 块');
  for (const [name, value] of [['labelSize', '13'], ['labelWeight', '500'], ['inputHeight', '34'], ['hintSize', '12'], ['hintLine', '18'], ['fieldPadY', '12'], ['scalarInputWidth', '220'], ['skeletonRow', '108']]) {
    assert.match(metrics[1], new RegExp(`${name}: ${value}\\b`, 'u'), `METRICS.${name} 必须是 ${value}（DESIGN 度量）`);
  }
  // 数值只能从 METRICS 插值进 CSS：源码里不该再出现这些裸量。
  for (const literal of ['13px', '34px', '18px', '500px', '220px', '108px']) {
    assert.ok(!SOURCE.includes(literal), `源码里出现裸量 ${literal}：度量必须走 METRICS`);
  }
  // 样式只用 --dsw-*/--ds-* token，不写死颜色。
  const colors = [...SOURCE.matchAll(/:\s*(#[0-9a-fA-F]{3,8})\b/gu)].map((match) => match[1]);
  assert.deepEqual(colors, [], `样式不得写死十六进制颜色：${colors.join(',')}（只用 --dsw-* token）`);
  assert.ok(SOURCE.includes('--dsw-alias-label-primary'), '必须复用宿主 token 体系，避免深浅色主题下不可读');
  assert.ok(/\bcolor-mix\(in srgb,var\(--dsw-/u.test(SOURCE), '半透明底必须由 token 派生，不写死 rgba');
});

/* ------------------------------------------------------------------------- *
 * 6. 页面即状态：只读态、覆盖/重置、冲突保留（AC-7 / AC-3 / AC-9）            *
 * ------------------------------------------------------------------------- */

test('只读态可聚焦可复制，覆盖才进编辑态（AC-7）', () => {
  assert.match(SOURCE, /readOnly:\s*!editable/u, '只读态用 readOnly（disabled 无法聚焦复制路径）');
  assert.match(SOURCE, /const editable = locked !== true && !reset && \(owned \|\| editing \|\| origin === 'missing'\)/u,
    '只有「本层已有值 / 用户点了改为手动指定 / 未命中」才可编辑');
  assert.match(SOURCE, /function takeOver\(field\)/u, '必须有「改为手动指定」');
  assert.match(SOURCE, /function resetToAuto\(field\)/u, '必须有「重置为自动发现」');
  assert.match(SOURCE, /setStaged\(\(prev\) => \(\{ \.\.\.prev, \[field\]: null \}\)\)/u, '重置 = staged 置 null（保存时清除该键）');
  assert.match(SOURCE, /预填当前生效值/u, '改为手动指定必须预填当前值，而不是空白框');
});

test('保存按钮只在 dirty 时可用；等值噪声不提交', () => {
  assert.match(SOURCE, /disabled:\s*!dirty \|\| phase === 'saving'/u, '未改动时保存必须禁用');
  assert.match(SOURCE, /function isChanged\(field, value\)/u, '必须判「与用户层现值是否不同」');
  assert.match(SOURCE, /if \(Object\.keys\(fields\)\.length === 0\) return;/u, '无变更时不得发请求');
  assert.match(SOURCE, /const dirty = changed\.length > 0;/u);
});

test('页面行为只遍历 PAGE_FIELDS：焦点/脏判定/提交体/422 都不碰隐藏三键', () => {
  // 收窄的机器证据：四处页面行为一律走三键表。若有一处仍用六键表，
  // 隐藏键就会在保存时被写进 fields（页面根本不该发送它们）。
  const traversals = SOURCE.match(/for \(const field of PAGE_FIELDS\)/gu) ?? [];
  assert.equal(traversals.length, 2, `焦点与提交两处循环都必须走 PAGE_FIELDS（实际 ${traversals.length} 处）`);
  assert.ok(!/for \(const field of CLI_FIELDS\)/u.test(SOURCE), '禁止再用 CLI_FIELDS 驱动页面行为（会带出幽灵字段）');
  assert.match(SOURCE, /PAGE_FIELDS\.filter\(/u, '脏判定只在三键上过滤');
  assert.match(SOURCE, /if \(PAGE_FIELDS\.includes\(field\)\) serverErrors\[field\]/u, '422 只映射页面可见三键');
  // 422 只回隐藏键原因时不能造幽灵字段，必须折进 footer 兜底提示。
  assert.match(SOURCE, /setNotice\(\{ kind: 'failed', text: t\('saveFailed', \{ reason: errorCode\(body\) \?\? 'CLI_CONFIG_INVALID' \}\) \}\)/u);
  // 隐藏三键不得出现在 staged 写入路径上：页面从不 setStaged 它们。
  for (const field of ['dopEndpoint', 'ghOwner', 'sourceType']) {
    assert.ok(!new RegExp(`setStaged\\([^)]*${field}`, 'u').test(SOURCE), `不得为隐藏键 ${field} 写 staged`);
  }
});

test('409 保留 staged 并给刷新入口，422 聚焦首个非法字段（AC-9）', () => {
  assert.match(SOURCE, /保留 staged/u, '冲突时不能清空用户填的内容');
  assert.match(SOURCE, /setNotice\(\{ kind: 'conflict', text: t\('saveFailedStale'\), refresh: true \}\)/u);
  assert.match(SOURCE, /function focusFirst\(map\)/u, '422 后必须把焦点移到第一个非法字段');
  assert.match(SOURCE, /pendingFocus\.current = field/u, '焦点移动走 effect，渲染完成后才拿得到节点');
  assert.match(SOURCE, /onBlur: editable \? onBlur : undefined/u, '入口字段 blur 即校验');
});

test('加载/错误/降级三态都有终态，不会停在骨架（可用性兜底）', () => {
  assert.match(SOURCE, /mode: 'loading'/u);
  assert.match(SOURCE, /mode: 'error'/u);
  assert.match(SOURCE, /const locked = view\.mode !== 'form'/u, '写面缺失时降级只读，而不是关掉整页');
  assert.match(SOURCE, /function UnavailableNote\(props\)/u, '降级必须给出原因与环境变量兜底');
  assert.match(SOURCE, /if \(!mounted\.current\) return;/u, '异步返回后必须检查卸载，避免 setState on unmounted');
});

test('静态形态用例与实现同源：端点/头/词表任一处改动都会先红在这里', () => {
  // 本用例的作用是显式记录「上面所有常量都来自同一份源码」的约束，避免有人给 client.js 复制一份。
  assert.equal(CLIENT.id, '@heluo/forge-devops');
  assert.equal(APPLIED.slots[0].meta.locale, APPLIED.locales[0].namespace, 'slot 的 locale 必须与注册的命名空间同名');
  assert.ok(SOURCE.indexOf("const NS = 'devops'") < SOURCE.indexOf("const CLI_ENDPOINT = '/api/forge-devops/cli'"), '常量块先于使用');
});

/* ========================================================================= *
 * 7. 状态机端到端（真实组件树 + 假 fetch）                                    *
 *                                                                            *
 * 为什么需要这一层：上面的静态断言只能证明「源码里写了什么」，证明不了页面能   *
 * 从 loading 走到 form、点「改为手动指定」后能预填、保存体带 revision、409 后   *
 * 不丢 staged。这里用可驱动 hooks 的极简 React 把 DevopsSection 真跑起来，     *
 * 假 fetch 返回契约响应，一路驱动到终态（已保存 / 冲突 / 降级）。              *
 * ========================================================================= */

/** 可驱动 hooks 的极简 React：createElement + useState/useRef/useEffect（按调用序定位）。 */
function createHookReact() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  return {
    react: {
      createElement: (type, props, ...children) => ({ kind: 'element', type, props: props ?? {}, children: children.flat(Infinity) }),
      Fragment: 'Fragment',
      useState(initial) {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
        const slot = slots[index];
        return [
          slot.value,
          (next) => {
            const value = typeof next === 'function' ? next(slot.value) : next;
            if (Object.is(value, slot.value)) return;
            slot.value = value;
            dirty = true;
          },
        ];
      },
      useRef(initial) {
        const index = cursor++;
        if (!slots[index]) slots[index] = { ref: { current: initial } };
        return slots[index].ref;
      },
      useEffect(fn, deps) {
        const index = cursor++;
        const slot = slots[index] ?? (slots[index] = {});
        slot.fn = fn;
        const same =
          Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length && deps.every((dep, i) => Object.is(dep, slot.deps[i]));
        if (!slot.ran || !same) slot.pending = true;
        slot.deps = deps;
        slot.ran = true;
      },
      __cursor: () => cursor,
    },
    beginRender: () => {
      cursor = 0;
    },
    runEffects: () => {
      for (const slot of slots) {
        if (!slot || !slot.pending) continue;
        slot.pending = false;
        slot.fn();
      }
    },
    isDirty: () => dirty,
    clearDirty: () => {
      dirty = false;
    },
    slotCount: () => slots.length,
  };
}

/** i18n：真实文案（zh），占位符按 t(key, params) 插值；缺键返回 `MISSING:key` 便于定位。 */
const tZh = (key, params) => {
  const template = zh[key];
  if (typeof template !== 'string') return `MISSING:${key}`;
  return template.replace(/\{([a-zA-Z]+)\}/gu, (match, name) => (params && name in params ? String(params[name]) : match));
};

const textOf = (tree) => {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string') return tree;
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  return tree.children.map(textOf).join(' ');
};

const walkTree = (tree, visit) => {
  if (tree === null || typeof tree !== 'object') return;
  if (Array.isArray(tree)) {
    for (const child of tree) walkTree(child, visit);
    return;
  }
  visit(tree);
  for (const child of tree.children) walkTree(child, visit);
};

/** 把 client.js 的根组件跑起来：渲染 → 效果 → 微任务/定时器排空 → 直到不再 setState。 */
function createPage() {
  const harness = createHookReact();
  const client = loadClient(harness.react);
  const focusLog = [];
  let tree = null;

  const expand = (node) => {
    if (node === null || node === undefined || node === false) return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null);
    const { type } = node;
    if (typeof type === 'function') {
      const before = harness.react.__cursor();
      const out = type(node.props);
      // 只有根组件允许持有状态：嵌套组件一旦调 hook，按调用序定位的槽位会错位。
      assert.equal(harness.react.__cursor(), before, `${type.name || '嵌套组件'} 使用了 hook（只允许根组件有状态）`);
      return expand(out);
    }
    if (typeof node.props.ref === 'function') {
      node.props.ref({ focus: () => focusLog.push(String(node.props['data-field'] ?? 'ref')) });
    }
    return { kind: 'element', type, props: node.props, children: node.children.map(expand).filter((child) => child !== null) };
  };

  const drain = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const settle = async () => {
    for (let pass = 0; pass < 60; pass += 1) {
      harness.beginRender();
      tree = expand(client.module.DevopsSection({ t: tZh }));
      harness.runEffects();
      await drain();
      if (!harness.isDirty()) return;
      harness.clearDirty();
    }
    throw new Error('页面状态机未收敛（60 轮仍在 setState）');
  };

  const fire = async (handler, arg) => {
    if (typeof handler !== 'function') throw new Error('目标节点没有该事件处理器');
    const result = handler(arg);
    if (result && typeof result.then === 'function') await result;
    await settle();
  };

  return {
    settle,
    focusLog,
    text: () => textOf(tree),
    findAll: (predicate) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (predicate(node)) hits.push(node);
      });
      return hits;
    },
    byClass: (className) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (String(node.props.className ?? '').split(/\s+/u).includes(className)) hits.push(node);
      });
      return hits;
    },
    buttons: () => {
      const hits = [];
      walkTree(tree, (node) => {
        if (node.type === 'button') hits.push({ node, text: textOf(node).trim() });
      });
      return hits;
    },
    /** 按文案取按钮（DOM 顺序 = ENTRY_FIELDS 顺序，dop 卡在前）。 */
    buttonsByText: (label) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (node.type === 'button' && textOf(node).trim() === label) hits.push(node);
      });
      return hits;
    },
    /** 文案里包含某段（用于「提示 + 折叠箭头」这类复合按钮）。 */
    buttonsIncluding: (fragment) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (node.type === 'button' && textOf(node).includes(fragment)) hits.push(node);
      });
      return hits;
    },
    button: (label) => {
      const hits = (function collect() {
        const found = [];
        walkTree(tree, (node) => {
          if (node.type === 'button' && textOf(node).trim() === label) found.push(node);
        });
        return found;
      })();
      assert.equal(hits.length, 1, `按钮「${label}」应恰好出现一次，实际 ${hits.length} 次`);
      return hits[0];
    },
    inputs: () => {
      const hits = [];
      walkTree(tree, (node) => {
        if ((node.type === 'input' || node.type === 'textarea') && typeof node.props.value === 'string') hits.push(node);
      });
      return hits;
    },
    inputWithValue: (value) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (node.type === 'input' && node.props.value === value) hits.push(node);
      });
      assert.equal(hits.length, 1, `值 ${value} 的输入框应恰好出现一次，实际 ${hits.length} 次`);
      return hits[0];
    },
    /** 生效值在只读态走 placeholder（输入框本身留空 = 不覆盖该层）。 */
    inputWithPlaceholder: (value) => {
      const hits = [];
      walkTree(tree, (node) => {
        if (node.type === 'input' && node.props.placeholder === value) hits.push(node);
      });
      assert.equal(hits.length, 1, `placeholder=${value} 的输入框应恰好出现一次，实际 ${hits.length} 次`);
      return hits[0];
    },
    click: (node) => fire(node.props.onClick),
    change: (node, value) => fire(node.props.onChange, { target: { value } }),
    blur: (node) => fire(node.props.onBlur, { target: { value: node.props.value } }),
  };
}

/** 假 fetch：按顺序发响应，记录每次调用（url + init）。 */
function stubFetch(...responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`未预期的请求：${url}`);
    const status = next.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => next.body ?? null };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const PATH_DOP = 'D:\\tools\\dop.exe';
const PATH_GH = 'D:\\tools\\gh.exe';
const PATH_NEW = 'E:\\corp\\bin\\dop.exe';
const PATH_GH_ALT = 'C:\\Program Files\\GitHub CLI\\gh.exe';

/** 契约快照夹具（CliSnapshot：entries + revision + writable，见 TECHNICAL §3.1）。 */
const snapshotOf = (overrides = {}, revision = 'rev-1') => ({
  revision,
  writable: { ok: true },
  entries: {
    dopBin: { origin: 'discovered', path: PATH_DOP, candidates: [{ path: PATH_DOP }, { path: 'D:\\old\\dop.exe' }] },
    ghBin: { origin: 'discovered', path: PATH_GH, candidates: [] },
    dopEndpoint: { origin: 'missing' },
    ghOwner: { origin: 'missing' },
    sourceType: { origin: 'default', value: 'mock' },
    timeoutMs: { origin: 'default', value: 20000 },
    ...overrides,
  },
});

test('E2E 三行一列：dop 入口 / gh 入口 / 超时，隐藏三键零 DOM、零段控件', async () => {
  const stub = stubFetch({ body: snapshotOf() });
  try {
    const page = createPage();
    await page.settle();

    // ① 三行一列：输入框 id 恰好是 PAGE_FIELDS，顺序即页面顺序。
    const ids = page.inputs().map((node) => node.props.id).sort();
    assert.deepEqual(ids, ['fdv-dopBin', 'fdv-ghBin', 'fdv-timeoutMs'], `页面只渲染三行，实际 ${ids.join(',')}`);
    assert.equal(page.byClass('fdv-card').length, 2, '两个入口卡（dop/gh）');
    assert.equal(page.byClass('fdv-scalar').length, 1, '超时是第三行、页面唯一的标量行');
    assert.equal(page.byClass('fdv-group').length, 1, '只有一个分组标题（「连接与身份」整组已下线）');
    assert.equal(page.byClass('fdv-track').length, 0, '段控件随隐藏键下线（页面没有 .fdv-track）');

    // ② 隐藏三键：连 DOM 都不进——不是灰显、不是折叠（收窄后页面无权展示它们）。
    for (const field of ['dopEndpoint', 'ghOwner', 'sourceType']) {
      assert.equal(page.findAll((node) => String(node.props.id ?? '') === `fdv-${field}`).length, 0, `隐藏键 ${field} 不得进 DOM`);
      assert.equal(page.findAll((node) => String(node.props.id ?? '') === `fdv-${field}-foot`).length, 0, `隐藏键 ${field} 不得留 foot 节点`);
    }
    assert.ok(!page.text().includes('MISSING:'), `页面出现裸键：${page.text().match(/MISSING:[a-zA-Z.]+/gu)?.join(',')}`);

    // ③ 骨架同构：加载完毕的页面里，骨架骨架组/行已全部消失（不会与表单叠罗汉）。
    assert.equal(page.byClass('fdv-skeleton-row').length, 0, '加载完成必须移除三行骨架');
  } finally {
    stub.restore();
  }
});

test('E2E 只读首页 → 改为手动指定（预填）→ 保存提交 {revision, fields}', async () => {
  const stub = stubFetch(
    { body: snapshotOf() },
    { body: { ok: true, snapshot: snapshotOf({ dopBin: { origin: 'config', path: PATH_NEW, candidates: [] } }, 'rev-2') } },
  );
  try {
    const page = createPage();
    await page.settle();

    // ① 装配期只读：一次 GET、无 refresh（AC-4：挂载不触发重扫）、no-store + accept。
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/api/forge-devops/cli', '首屏只读快照，不得带 refresh=1');
    assert.equal(stub.calls[0].init.method ?? 'GET', 'GET');
    assert.equal(stub.calls[0].init.cache, 'no-store');
    assert.equal(stub.calls[0].init.headers.accept, 'application/json');

    // ② 页面即状态：来源 Tag + 命中路径可见，保存禁用，输入端只读但可聚焦复制（AC-7）。
    const text = page.text();
    assert.ok(text.includes(tZh('origin.discovered')), '必须显示「自动发现」来源 Tag');
    assert.ok(!text.includes('MISSING:'), `文案出现裸键：${text.match(/MISSING:[a-zA-Z.]+/gu)?.join(',')}`);
    const readonlyInput = page.inputWithValue(PATH_DOP);
    assert.equal(readonlyInput.props.readOnly, true, '只读态用 readOnly（disabled 无法聚焦复制）');
    assert.equal(page.inputWithValue(PATH_GH).props.readOnly, true, '另一个入口同样是只读展示');
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, true, '未改动时保存必须禁用');

    // ③ 改为手动指定：预填当前生效值并进入编辑态。从「自动发现」切到「配置层」本身就是
    //    一次真实变更（把路径钉住），保存因此在未改字的情况下也可用；等值噪声规则只对
    //    「已在本层写入相同值」生效，见用例 4。
    const takeOvers = page.buttonsByText(tZh('action.takeOver'));
    assert.equal(takeOvers.length, 2, '两个入口卡各有一个「改为手动指定」');
    await page.click(takeOvers[0]);
    const editable = page.inputWithValue(PATH_DOP);
    assert.ok(!editable.props.readOnly, '点「改为手动指定」后该输入端可编辑');
    assert.equal(page.inputWithValue(PATH_GH).props.readOnly, true, '另一张卡仍是只读（逐字段覆盖，不整页切编辑态）');
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, false, '钉住自动发现结果是一次层变更，保存应可用');

    // ④ 改成新路径 → blur 校验通过 → 保存：POST 带 revision 栅栏与字段增量。
    await page.change(editable, PATH_NEW);
    await page.blur(page.inputWithValue(PATH_NEW));
    assert.ok(!page.text().includes(tZh('error.wrapperScript')), '合法 .exe 路径不得报错');
    const save = page.byClass('fdv-primary')[0];
    assert.equal(save.props.disabled, false, '有改动后保存可用');
    await page.click(save);

    assert.equal(stub.calls.length, 2, '一次保存只发一个请求');
    const post = stub.calls[1];
    assert.equal(post.url, '/api/forge-devops/cli');
    assert.equal(post.init.method, 'POST');
    assert.equal(post.init.headers['x-forge-devops-request'], '1', '写操作必须带 CSRF 预检头');
    assert.deepEqual(JSON.parse(post.init.body), { revision: 'rev-1', fields: { dopBin: PATH_NEW } }, '只提交真正变化的键');
    // 保存体键集只能是三键（隐藏键既不渲染也不发送，服务端按六键契约逐字保留它们）。
    const sentFields = Object.keys(JSON.parse(post.init.body).fields);
    assert.ok(sentFields.every((key) => ['dopBin', 'ghBin', 'timeoutMs'].includes(key)), `保存体只允许三键，实际 ${sentFields.join(',')}`);

    // ⑤ 终态：回填服务端新快照，提示已保存，保存键回落禁用。
    assert.ok(page.text().includes(tZh('saved')), '保存后必须给出成功反馈');
    assert.ok(page.inputWithValue(PATH_NEW), '保存后显示服务端回填的新值');
    assert.equal(page.inputWithValue(PATH_NEW).props.readOnly, false, '配置层条目保存后仍可编辑（能再改）');
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, true, '保存完成后回到未改动状态');
  } finally {
    stub.restore();
  }
});

test('E2E 包装脚本 blur 即拒 → 409 保留 staged → 页面刷新才带 refresh=1', async () => {
  const stub = stubFetch({ body: snapshotOf() }, { status: 409, body: { ok: false, code: 'CLI_CONFIG_STALE', message: 'stale' } }, { body: snapshotOf() });
  try {
    const page = createPage();
    await page.settle();
    await page.click(page.buttonsByText(tZh('action.takeOver'))[0]);

    // ① 包装脚本：blur 当场报错，不等到 422（AC-9 的前置拦截）。
    await page.change(page.inputWithValue(PATH_DOP), 'D:\\tools\\dop.cmd');
    await page.blur(page.inputWithValue('D:\\tools\\dop.cmd'));
    assert.ok(page.text().includes(tZh('error.wrapperScript')), '.cmd 必须在 blur 时被拒收');
    await page.click(page.byClass('fdv-primary')[0]);
    assert.equal(stub.calls.length, 1, '本地校验不通过时不得发保存请求');

    // ② 409：冲突提示 + staged 保留 + 保存仍可用（用户填的东西不被清空）。
    await page.change(page.inputWithValue('D:\\tools\\dop.cmd'), PATH_NEW);
    await page.blur(page.inputWithValue(PATH_NEW));
    await page.click(page.byClass('fdv-primary')[0]);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].init.method, 'POST');
    assert.ok(page.text().includes(tZh('saveFailedStale')), '409 必须显示版本冲突文案');
    assert.equal(page.inputWithValue(PATH_NEW).props.value, PATH_NEW, '409 后 staged 必须保留');
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, false, '409 后保存仍可用（改完再存）');

    // ③ 冲突提示里的「刷新」是页面唯一会重扫的动作：GET + refresh=1。
    await page.click(page.button(tZh('action.refresh')));
    assert.equal(stub.calls.length, 3);
    assert.ok(stub.calls[2].url.includes('?refresh=1'), '刷新才允许触发重新扫描（AC-4）');
  } finally {
    stub.restore();
  }
});

test('E2E 未命中原生可填；写面缺失整页降级只读但字段仍可复制', async () => {
  const stub = stubFetch({ body: snapshotOf({ dopBin: { origin: 'missing', candidates: [] }, dopEndpoint: { origin: 'env', value: 'https://dop.corp.example' } }) });
  try {
    const page = createPage();
    await page.settle();
    const text = page.text();
    assert.ok(text.includes(tZh('origin.missing')), '未找到必须有独立来源态，不能显示成配置');
    assert.ok(text.includes(tZh('entry.hint.help', { tool: 'dop' })), '未找到且可填时给「复制文件地址」的一句话指引（AC-5），工具名按字段插值');
    const first = page.inputs()[0];
    assert.ok(!first.props.readOnly, '未命中时直接可填，不要求先点「改为手动指定」（AC-5）');
    assert.equal(first.props.placeholder, tZh('entry.placeholder', { tool: 'dop' }));
    // 指引句按字段插值：dop 卡不得再显示 gh 的名字（r3 的错位在这里钉死）。
    assert.ok(!text.includes('gh 文件右键'), 'dop 入口卡的指引不得提到 gh');
    // 服务端回六个字段，页面恒定渲染三行：隐藏三键连 DOM 都不进（不是灰显、不是折叠）。
    assert.equal(page.inputs().length, 3, `页面只渲染三行，实际 ${page.inputs().length} 个输入框`);
    assert.equal(page.findAll((node) => String(node.props.id ?? '') === 'fdv-dopEndpoint').length, 0, '隐藏键 dopEndpoint 不得有输入框');
    assert.equal(page.findAll((node) => String(node.props.id ?? '') === 'fdv-ghOwner').length, 0, '隐藏键 ghOwner 不得有输入框');
    assert.equal(page.findAll((node) => String(node.props.id ?? '') === 'fdv-sourceType').length, 0, '隐藏键 sourceType 不得有输入框');
    // 超时行未改过时把生效值镜像进 placeholder（留空 = 不覆盖该层）。
    const timeoutInput = page.inputWithPlaceholder('20000');
    assert.equal(timeoutInput.props.readOnly, false, '超时是页面可编辑的一行');
    assert.ok(page.text().includes(tZh('origin.missing')));
  } finally {
    stub.restore();
  }

  const degradedStub = stubFetch({ body: { revision: 'rev-9', writable: { ok: false, reason: 'CLI_CONFIG_UNAVAILABLE' }, entries: snapshotOf({ dopEndpoint: { origin: 'env', value: 'https://dop.corp.example' } }).entries } });
  try {
    const page = createPage();
    await page.settle();
    assert.ok(page.text().includes(tZh('unavailable.title')), '写面缺失必须说明原因，而不是白屏或全页报错');
    assert.ok(page.text().includes(tZh('unavailable.envDop')), '降级时给出环境变量兜底');
    assert.equal(page.byClass('fdv-primary').length, 0, '降级态不渲染保存键（不能给假按钮）');
    assert.equal(page.inputWithValue(PATH_DOP).props.readOnly, true, '降级态字段仍只读可见');
    // 降级时第三行（超时）把生效值镜像进 value（placeholder 不可复制），且用 readOnly 而非 disabled。
    const lockedTimeout = page.inputWithValue('20000');
    assert.equal(lockedTimeout.props.readOnly, true, '降级态标量行只读但可聚焦复制');
    assert.equal(lockedTimeout.props.disabled, undefined, '不得用 disabled（无法聚焦/复制）');
    assert.equal(page.inputs().length, 3, '降级态仍是三行，不会因为只读而多出隐藏字段');
  } finally {
    degradedStub.restore();
  }
});

test('E2E 等值噪声不提交：本层同样的值改回去，保存重新禁用', async () => {
  // candidates 是 [{ path, tier }]（TECHNICAL §2.4），首个即命中项，其余计入「另有 N 个」。
  const stub = stubFetch({
    body: snapshotOf({
      dopBin: { origin: 'config', path: PATH_DOP, tool: 'dop', candidates: [] },
      ghBin: {
        origin: 'discovered',
        path: PATH_GH,
        tool: 'gh',
        candidates: [
          { path: PATH_GH, tier: 'path' },
          { path: PATH_GH_ALT, tier: 'candidate-dirs' },
        ],
      },
    }),
  });
  try {
    const page = createPage();
    await page.settle();
    // 配置层已在编辑态：改动 → 保存可用；改回同一个值 → 保存重新禁用（不发等值写）。
    await page.change(page.inputWithValue(PATH_DOP), PATH_NEW);
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, false, '真的改了才允许保存');
    await page.change(page.inputWithValue(PATH_NEW), PATH_DOP);
    assert.equal(page.byClass('fdv-primary')[0].props.disabled, true, '改回原值 = 无变更，不得提交等值噪声');
    // 多候选：命中首个 + 「另有 N 个候选」可展开（不静默把多份安装吞掉）。
    const more = page.buttonsIncluding('另有 1 个候选');
    assert.equal(more.length, 1, '另有 1 个候选时应给出可展开入口');
    await page.click(more[0]);
    assert.ok(page.text().includes(PATH_GH_ALT), '展开后候选路径可见（企业多份安装不自作主张）');
    assert.ok(page.text().includes(tZh('candidates.current')), '展开后标出当前生效项');
  } finally {
    stub.restore();
  }
});
