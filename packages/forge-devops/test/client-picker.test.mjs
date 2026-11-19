/**
 * 新会话变更选择器的客户端半（r19）：模板填空、插入语义、清单读取与首屏结构。
 *
 * 这里只钉**离线可判定**的契约：
 *   - 模板与产品口径逐字一致，变更号里的 `$&`/`$1` 不会被当成替换模式；
 *   - 选中即用模板**整体替换**草稿（`setDraft`），连续切换不叠加；缺整段写入面才退回位点插入；
 *   - 读清单的失败一律收敛成原因词，不把服务端中文消息或异常文本搬上屏；
 *   - 首屏收起，按钮可点开（真实宿主槽位渲染与实机外观见设计 §10 的手工项）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadClient } from './support/readiness-harness.mjs';

const { module: CLIENT } = loadClient({ react: renderReact() });

/** 默认模板：来自客户端常量（与宿主 `DEFAULT_PROMPT_TEMPLATE` 由 prompt-template 用例静态比对）。 */
const TEMPLATE = CLIENT.DEFAULT_PROMPT_TEMPLATE;

/** 渲染夹具：记录 element 树，hook 一律给初值（本文件不驱动状态迁移）。 */
function renderReact() {
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
}

/* ------------------------------------------------------------------ *
 * 1. 模板                                                             *
 * ------------------------------------------------------------------ */

test('模板填空：与产品口径逐字一致，只替换变更号', () => {
  const fill = (code) => TEMPLATE.split('{code}').join(code);
  const prompt = CLIENT.buildChangePrompt('ARD384859');
  assert.equal(prompt, fill('ARD384859'));
  assert.equal(CLIENT.buildChangePrompt('  MST302881  '), fill('MST302881'), '编号两端空白剪掉');
  assert.equal(CLIENT.buildChangePrompt(null), fill(''), '空编号只留空白位置，不抛');
  assert.equal(CLIENT.buildChangePrompt('X', '自定义 {code} 模板'), '自定义 X 模板', '传入模板优先于默认值');
});

test('模板填空：变更号里的替换模式字符原样保留', () => {
  const fill = (code) => TEMPLATE.split('{code}').join(code);
  assert.equal(CLIENT.buildChangePrompt('A$&B'), fill('A$&B'));
  assert.equal(CLIENT.buildChangePrompt('$1$2'), fill('$1$2'));
});

/* ------------------------------------------------------------------ *
 * 2. 插入语义                                                         *
 * ------------------------------------------------------------------ */

test('整体替换：走 setDraft 覆盖整段草稿，不在光标处追加', () => {
  const calls = [];
  let text = '用户已经写了一半的内容';
  const actions = {
    setDraft: (next) => {
      calls.push(['setDraft', next]);
      text = next;
    },
    persistDraft: () => calls.push('persist'),
    captureInsertion: () => calls.push('capture'),
    insertText: () => calls.push('insert'),
  };
  assert.deepEqual(CLIENT.insertPrompt(actions, '模板A'), { ok: true });
  assert.equal(text, '模板A', '整段替换：旧草稿不留在编辑器里');
  assert.deepEqual(calls, [['setDraft', '模板A'], 'persist'], '只用整段写入面，不追加');
});

test('整体替换：连续切换多次只保留最后一次模板，不叠加', () => {
  let text = '';
  const actions = { setDraft: (next) => { text = next; } };
  CLIENT.insertPrompt(actions, '模板A');
  CLIENT.insertPrompt(actions, '模板B');
  CLIENT.insertPrompt(actions, '模板C');
  assert.equal(text, '模板C');
  assert.equal((text.match(/模板/g) ?? []).length, 1, '编辑器里不允许出现两份模板');
});

test('整体替换：host 抛错 → locked；没有整段写入面时退回位点插入', () => {
  const throwing = { setDraft: () => { throw new Error('editor locked'); } };
  assert.deepEqual(CLIENT.insertPrompt(throwing, 'X'), { ok: false, reason: 'locked' });

  let attempt = 0;
  const spans = [];
  const fallback = {
    captureInsertion: () => {
      attempt += 1;
      const span = { start: attempt, end: attempt, draftRev: attempt };
      spans.push(span);
      return span;
    },
    insertText: (_text, span) => span.draftRev === 2,
  };
  assert.deepEqual(CLIENT.insertPrompt(fallback, 'X'), { ok: true });
  assert.equal(attempt, 2);
  assert.notDeepEqual(spans[0], spans[1], '退回路径也只在位点写，不复用过期 span');
});

test('插入：缺能力 → no-composer；位点路径两次都被拒或抛错 → locked', () => {
  assert.deepEqual(CLIENT.insertPrompt(undefined, 'X'), { ok: false, reason: 'no-composer' });
  assert.deepEqual(CLIENT.insertPrompt({}, 'X'), { ok: false, reason: 'no-composer' });
  assert.deepEqual(CLIENT.insertPrompt({ captureInsertion: () => null }, 'X'), { ok: false, reason: 'no-composer' });
  const rejected = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => false,
  };
  assert.deepEqual(CLIENT.insertPrompt(rejected, 'X'), { ok: false, reason: 'locked' });
  const throwing = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => { throw new Error('editor locked'); },
  };
  assert.deepEqual(CLIENT.insertPrompt(throwing, 'X'), { ok: false, reason: 'locked' });
});

/* ------------------------------------------------------------------ *
 * 3. 读清单                                                           *
 * ------------------------------------------------------------------ */

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('读清单：同源只读请求，投影成 {id, summary}', async () => {
  const seen = [];
  const result = await CLIENT.fetchChangeList({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, {
        ok: true,
        items: [
          { id: 'ARD384859', summary: '企业级sdd工具开发' },
          { id: 'A2', summary: '   ' },
          { id: '', summary: '缺编号' },
        ],
        count: 1,
        total: 3,
        truncated: false,
      });
    },
  });
  assert.deepEqual(result.items, [{ id: 'ARD384859', summary: '企业级sdd工具开发' }]);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(seen[0].url, '/api/forge-devops/changes');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.credentials, 'same-origin');
  assert.equal(seen[0].init.cache, 'no-store');
});

test('读清单：失败收敛成原因词，不外溢服务端消息或异常文本', async () => {
  const unavailable = await CLIENT.fetchChangeList({
    fetchImpl: async () => jsonResponse(503, { ok: false, code: 'PICKER_UNAVAILABLE', message: '/opt/homebrew/bin/dop' }),
  });
  assert.deepEqual(unavailable, { ok: false, code: 'unavailable' });

  const failed = await CLIENT.fetchChangeList({ fetchImpl: async () => jsonResponse(500, { ok: false }) });
  assert.deepEqual(failed, { ok: false, code: 'failed', status: 500 });

  const malformed = await CLIENT.fetchChangeList({ fetchImpl: async () => jsonResponse(200, { items: [] }) });
  assert.deepEqual(malformed, { ok: false, code: 'malformed' });

  const unreachable = await CLIENT.fetchChangeList({
    fetchImpl: async () => {
      throw new Error('ENOTFOUND corp.example');
    },
  });
  assert.deepEqual(unreachable, { ok: false, code: 'unreachable' });
});

/* ------------------------------------------------------------------ *
 * 4. 首屏结构                                                         *
 * ------------------------------------------------------------------ */

test('首屏：收起态只渲染一个触发按钮，不提前拉清单', () => {
  const tree = CLIENT.ChangePicker({ t: (key) => key, inputActions: undefined });
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'fdv-picker');
  const [trigger, panel] = tree.children;
  assert.equal(trigger.props['aria-haspopup'], 'listbox');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(panel, null, '未展开时不渲染面板（也不发请求）');
  assert.ok(trigger.children.length >= 1, '按钮必须有可见文案');
  assert.equal(trigger.children[0].props.className, 'fdv-picker-label', '文案节点挂加粗样式（与宿主选择器同级字重）');
});

/* ------------------------------------------------------------------ *
 * 5. 横向贴靠与箭头                                                  *
 * ------------------------------------------------------------------ */

test('横向贴靠：位移 = 容器左缘 − 模式按钮右缘 − 工具栏行 gap', () => {
  assert.equal(CLIENT.pickerRowShift(500, 120), 378, '默认 gap 2px，贴到模式按钮右侧');
  assert.equal(CLIENT.pickerRowShift(500, 120, 8), 372, 'gap 可替换');
  assert.equal(CLIENT.pickerRowShift(120, 118), 0, '容器本来就贴边时不位移');
  assert.equal(CLIENT.pickerRowShift(100, 300), 0, '容器在按钮左侧（窄屏换行）时退回 0');
  assert.equal(CLIENT.pickerRowShift(Number.NaN, 120), 0, '几何值缺失时退回 0');
  assert.equal(CLIENT.pickerRowShift(500, undefined), 0, '右缘缺失时退回 0');
});

test('箭头：与宿主选择器同一条 chevron 路径，且不再渲染文字箭头', () => {
  assert.equal(
    CLIENT.PICKER_CHEVRON_PATH,
    'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
    '路径必须与宿主工作区/模式选择器的 chevron 逐字一致',
  );
  const tree = CLIENT.ChangePicker({ t: (key) => key, inputActions: undefined });
  const [trigger] = tree.children;
  const svg = trigger.children.find((child) => child !== null && child !== undefined && child.type === 'svg');
  assert.ok(svg, '触发按钮里必须是矢量箭头');
  assert.equal(svg.props.viewBox, '0 0 16 16');
  assert.equal(svg.props.width, 14);
  assert.equal(svg.props.fill, 'none');
  assert.equal(svg.props['aria-hidden'], 'true');
  const path = svg.children[0];
  assert.equal(path.type, 'path');
  assert.equal(path.props.d, CLIENT.PICKER_CHEVRON_PATH);
  assert.equal(path.props.stroke, 'currentColor');
  assert.equal(
    JSON.stringify(tree).includes('▾'),
    false,
    '不再用文字符号当箭头（与会话栏两个官方选择器的字形不一致）',
  );
});

test('横向锚点：跳过宿主 display:contents 槽位壳，取模式选择器右缘', () => {
  const boxed = (left, right, top = 0) => ({ getBoundingClientRect: () => ({ left, right, top, width: right - left, height: 16 }) });
  const shell = (children = [], siblings = []) => ({
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 }),
    firstElementChild: children[0] ?? null,
    nextElementSibling: null,
    children,
  });

  // elementBox：零盒返回 null，有盒返回矩形。
  assert.equal(CLIENT.elementBox({ getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 }) }), null);
  assert.equal(CLIENT.elementBox({ getBoundingClientRect: () => ({ left: 5, right: 9, top: 0, width: 4, height: 2 }) }).right, 9);
  assert.equal(CLIENT.elementBox(null), null);

  // hostEdgeRight：紧邻的兄弟是 display:contents 壳时下钻到它的子元素（官方模式选择器就是这样挂上来的）。
  const seat = boxed(593, 699);
  const presetShell = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 }), firstElementChild: seat };
  const holder = { previousElementSibling: presetShell };
  assert.equal(CLIENT.hostEdgeRight(holder), 699);

  // 壳里还没挂上子元素时退回到更前面的兄弟（工作区选择器），不返回 null。
  const presetsEmpty = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 }), firstElementChild: null };
  const chip = boxed(464, 589);
  const holder2 = { previousElementSibling: presetsEmpty };
  presetsEmpty.previousElementSibling = chip;
  assert.equal(CLIENT.hostEdgeRight(holder2), 589);

  // anchorHolder：从组件往上，跳过所有零盒壳，停在第一个有盒的祖先。
  const heroOptions = boxed(1144, 1203);
  const slotShell = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0, height: 0 }), parentElement: heroOptions };
  const picker = { parentElement: slotShell };
  assert.equal(CLIENT.anchorHolder(picker), heroOptions);
  assert.equal(CLIENT.anchorHolder(null), null);
  assert.ok(shell !== undefined, '夹具只为说明结构');
});
