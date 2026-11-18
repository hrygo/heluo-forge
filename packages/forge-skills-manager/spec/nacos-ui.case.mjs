import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { clientModule } from './fixtures/client-module.mjs';

const { createNacosUI, nacosLocales, SkillDocument, skillDocumentUrl, defaultDestination, destinationPayload, destinationReady } = clientModule;
const h = React.createElement;
const skillVersion = '1.0.0';
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = node => typeof node === 'string' ? node : !node || node.type === 'style' ? '' : Array.isArray(node) ? node.map(text).join('') : text(node.children);
const translate = (key, params = {}) => (nacosLocales.zh[key] || ({ 'btn.detail': '查看详情', 'btn.refresh': '刷新', 'btn.close': '关闭', 'btn.cancel': '取消' })[key] || key)
  .replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('Host JSX 适配保留 key、ref、children 并通过宿主公开接口创建元素', () => {
  const ref = React.createRef();
  const props = { children: ['one', 'two'], ref, title: 'document' };
  const element = clientModule.jsxs('div', props, 'item');
  assert.equal(element.key, 'item'); assert.equal(element.ref, ref);
  assert.deepEqual(element.props.children, ['one', 'two']);
  assert.deepEqual(props, { children: ['one', 'two'], ref, title: 'document' });
  assert.equal(renderToStaticMarkup(clientModule.jsx(clientModule.Fragment, { children: element })), '<div title="document">onetwo</div>');
});

test('卡片显示真实命名空间及下载次数，缺失不补零，保留服务端顺序', async t => {
  const ui = await harness(t);
  assert.ok(ui.body().includes('按下载次数排序'));
  assert.ok(ui.body().includes('22 次下载'));
  const namespace = ui.renderer.root.findByProps({ className: 'dssm-nacos-namespace' });
  assert.equal(namespace.props.title, '命名空间：public');
  assert.equal(namespace.props['aria-label'], '命名空间：public');
  assert.ok(ui.renderer.root.findByProps({ className: 'dssm-nacos-downloads' }).props.title.includes('不代表安装人数'));
  ui.data.items = [
    { ...ui.data.items[0], name: 'zero-skill', namespaceId: 'namespace-' + 'long'.repeat(24), downloadCount: 0 },
    { ...ui.data.items[0], name: 'popular-skill', downloadCount: 12345 },
    { name: 'missing-count', version: '1', description: 'No count' },
  ];
  await ui.click('刷新');
  assert.deepEqual(ui.renderer.root.findAllByType('h4').map(node => text(node)), ['zero-skill', 'popular-skill', 'missing-count']);
  const counters = ui.renderer.root.findAllByProps({ className: 'dssm-nacos-downloads' });
  assert.equal(counters.length, 2);
  assert.equal(text(counters[0]), '0 次下载');
  assert.equal(text(counters[1]), (12345).toLocaleString() + ' 次下载');
  assert.equal(ui.renderer.root.findAllByProps({ className: 'dssm-nacos-namespace' })[0].props.title, '命名空间：' + ui.data.items[0].namespaceId);
  assert.equal(ui.renderer.root.findAllByType('button').filter(node => text(node) === '查看详情').length, 3);
});

async function harness(t, initial = {}) {
  const calls = [], lists = [], details = [], installs = [], navigated = [];
  const options = { holdList: false, holdDetail: false, holdInstall: false, failRefresh: false, failDetail: false, failList: false, ignoreAbort: false, failTransport: false, rejectInstall: false, outcome: { state: 'pending' }, ...initial };
  const data = { configured: true, items: [{ name: 'example-skill', description: 'Example', version: '1.0.0', namespaceId: 'public', downloadCount: 22 }], page: 1, total: 1, pageSize: 20 };
  let active = true, refreshed = 0, renderer;
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path.startsWith('/nacos/list?')) {
      if (options.holdList) { const pending = deferred(); lists.push(pending); return pending.promise; }
      if (options.failList) throw { code: 'error.nacos.unavailable' };
      return { ...structuredClone(data), page: Number(new URL('http://localhost' + path).searchParams.get('page')) };
    }
    if (path === '/nacos/detail') {
      if (options.holdDetail) { const pending = deferred(); details.push(pending); return pending.promise; }
      if (options.failDetail) throw { code: 'error.nacos.notFound' };
      return { ...JSON.parse(init.body), name: JSON.parse(init.body).skillName, description: 'Example', body: '# Instructions\n\nUse carefully.', files: ['SKILL.md', 'assets/binary.dat'], digest: 'a'.repeat(64) };
    }
    if (path === '/workspaces') return { items: [{ name: 'Project', path: '/project', available: true, registeredPaths: ['/project'], skillCount: 0 }] };
    if (path === '/state') return { roots: [{ key: 'dsh', path: '/workspace/skills', mutable: true }] };
    if (path.startsWith('/nacos/install-status?')) return options.outcome;
    if (path === '/nacos/install') {
      if (options.rejectInstall) throw clientModule.normalizeApiFailure({ code: 'error.nacos.notFound', outcome: 'rejected' });
      if (options.failTransport) throw new TypeError('fetch failed after commit');
      if (options.holdInstall) {
        const pending = deferred(); installs.push(pending);
        if (!options.ignoreAbort) init.signal.addEventListener('abort', () => pending.reject({ code: 'error.nacos.cancelled' }), { once: true });
        return pending.promise;
      }
      return { name: JSON.parse(init.body).skillName, root: '/workspace/skills' };
    }
    throw new Error('Unexpected API: ' + path);
  };
  function Button({ variant: _variant, size: _size, icon, children, ...props }) { return h('button', props, icon, children); }
  function Modal({ title, children, footer, onClose }) { return h('section', { role: 'dialog' }, h('h2', null, title), h('button', { 'aria-label': '关闭详情', onClick: onClose }), children, footer); }
  function SourceSelect({ value, options, onChange, label, disabled }) { return h('select', { 'aria-label': label, value, disabled, onChange: event => onChange(event.target.value) }, options.map(option => h('option', { key: option.value, value: option.value, disabled: option.disabled }, option.label))); }
  const useUI = createNacosUI({ react: React, Modal, Input: 'input', Button, SourceSelect,
    destination: { defaultDestination, destinationPayload, destinationReady }, api, headers: { 'x-dsh-skills-manager': '1' }, translateError: (_t, error) => { const details = clientModule.failureDetails(error); return details.code ? translate(details.code) : details.message; } });
  function App() { return useUI({ active, t: translate, onInstalled: async () => { refreshed++; if (options.failRefresh) throw new Error('Synthetic refresh failure'); }, onNavigate: value => navigated.push(value) }).content; }
  const flush = async () => { await act(async () => { await tick(); }); };
  async function event(fn) { act(fn); await flush(); }
  await act(async () => { renderer = TestRenderer.create(h(App)); await tick(); });
  t.after(() => { act(() => renderer.unmount()); });
  const button = label => renderer.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label);
  const body = () => text(renderer.toJSON());
  return { options, data, calls, lists, details, installs, navigated, renderer, flush, event, button, body,
    click: label => event(() => { const node = button(label); assert.ok(node, `Button missing: ${label}`); assert.ok(!node.props.disabled, `Button disabled: ${label}`); node.props.onClick?.(); }),
    async search(value) { await event(() => renderer.root.findByType('input').props.onChange({ target: { value } })); await event(() => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })); },
    async stop() { active = false; await event(() => renderer.update(h(App))); },
    async remount() { await event(() => renderer.update(h(App, { key: 'remounted' }))); },
    get refreshed() { return refreshed; },
  };
}

test('发现仅请求 Nacos，详情渲染说明和资源且下载后可前往全局技能', async t => {
  const ui = await harness(t);
  assert.ok(ui.body().includes('本页 1 项'));
  assert.equal(ui.renderer.root.findAllByType('nav').length, 0);
  await ui.click('查看详情');
  assert.equal(ui.renderer.root.findAllByType('h1')[0].children[0], 'Instructions');
  assert.ok(ui.body().includes('完整资源（2 个文件）'));
  assert.equal(ui.renderer.root.findAllByType('select').length, 0);
  await ui.click('下载到本地');
  const { operationId, ...selection } = JSON.parse(ui.calls.find(call => call.path === '/nacos/install').init.body);
  assert.match(operationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(selection, { skillName: 'example-skill', version: skillVersion, root: 'dsh' });
  assert.equal(ui.refreshed, 1); assert.ok(ui.body().includes('当前为禁用状态'));
  await ui.click('前往全局技能');
  assert.deepEqual(ui.navigated, [{ name: 'example-skill', scope: 'user', workspace: '' }]);
  assert.ok(ui.calls.every(call => call.path.startsWith('/nacos/') || ['/state', '/workspaces'].includes(call.path)));
});

test('项目下载只传登记路径，成功定位不丢失所选项目', async t => {
  const ui = await harness(t); await ui.click('查看详情'); await ui.click('项目技能');
  assert.equal(ui.button('下载到本地').props.disabled, true);
  await ui.event(() => ui.renderer.root.findByType('select').props.onChange({ target: { value: '/project' } }));
  await ui.click('下载到本地'); await ui.click('前往项目技能');
  const { operationId, ...selection } = JSON.parse(ui.calls.find(call => call.path === '/nacos/install').init.body);
  assert.match(operationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(selection, { skillName: 'example-skill', version: '1.0.0', workspace: '/project' });
  assert.deepEqual(ui.navigated, [{ name: 'example-skill', scope: 'workspace', workspace: '/project' }]);
});

test('刷新保留卡片且详情加载独立，不冻结列表操作', async t => {
  const ui = await harness(t); ui.options.holdList = true; await ui.click('刷新');
  assert.ok(ui.body().includes('example-skill')); assert.ok(ui.body().includes('暂时显示上次结果'));
  ui.options.holdDetail = true; await ui.click('查看详情');
  assert.ok(ui.body().includes('正在读取技能说明')); assert.equal(ui.button('查看详情').props.disabled, false);
  assert.equal(ui.calls.filter(call => call.path === '/nacos/detail').length, 1);
});

test('名称搜索、翻页、刷新和清空使用一致的已提交条件', async t => {
  const ui = await harness(t); ui.data.total = 60;
  await ui.search('report'); await ui.click('下一页');
  assert.ok(ui.calls.at(-1).path.includes('q=report&page=2'));
  await ui.click('刷新'); assert.ok(ui.calls.at(-1).path.includes('q=report&page=2'));
  await ui.click('清空搜索'); assert.ok(ui.calls.at(-1).path.endsWith('q=&page=1'));
  assert.equal(ui.renderer.root.findByType('input').props.value, '');
});

test('过期查询即使忽略 AbortSignal 也不能覆盖新结果或页码', async t => {
  const ui = await harness(t); ui.options.holdList = true;
  await ui.search('old'); await ui.search('new');
  ui.lists[1].resolve({ ...ui.data, items: [{ name: 'new-skill', version: '1', description: 'New' }] }); await ui.flush();
  ui.lists[0].resolve({ ...ui.data, items: [{ name: 'stale-skill', version: '1', description: 'Old' }] }); await ui.flush();
  assert.ok(ui.body().includes('new-skill')); assert.ok(!ui.body().includes('stale-skill')); assert.ok(ui.body().includes('名称包含“new”'));
});

test('详情失败提供重试，关闭后的迟到详情不能替换新技能', async t => {
  const ui = await harness(t); ui.options.failDetail = true; await ui.click('查看详情');
  assert.ok(ui.body().includes('版本已不可用')); assert.equal(ui.button('下载到本地').props.disabled, true);
  ui.options.failDetail = false; await ui.click('重试'); assert.equal(ui.button('下载到本地').props.disabled, false);
  await ui.click('关闭详情'); ui.options.holdDetail = true; await ui.click('查看详情'); await ui.click('关闭详情');
  ui.data.items = [{ name: 'other-skill', version: '2', description: 'Other' }]; await ui.click('刷新'); await ui.click('查看详情');
  ui.details[1].resolve({ ...ui.data.items[0], body: '# Current detail', files: [], digest: 'b'.repeat(64) }); await ui.flush();
  ui.details[0].resolve({ name: 'example-skill', version: '1', body: '# Stale detail', files: [], digest: 'a'.repeat(64) }); await ui.flush();
  assert.ok(ui.body().includes('Current detail')); assert.ok(!ui.body().includes('Stale detail'));
});

test('同一轮事件重复点击仅发送一次下载', async t => {
  const ui = await harness(t); await ui.click('查看详情'); ui.options.holdInstall = true;
  const install = ui.button('下载到本地').props.onClick;
  await ui.event(() => { install(); install(); });
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
  ui.installs[0].resolve({ name: 'example-skill', root: '/workspace/skills' }); await ui.flush();
  assert.equal(ui.refreshed, 1);
});

test('下载成功后的本地刷新失败保留成功事实与导航，不重复安装', async t => {
  const ui = await harness(t); ui.options.failRefresh = true; await ui.click('查看详情'); await ui.click('下载到本地');
  assert.ok(ui.body().includes('勿重复下载')); assert.ok(ui.button('前往全局技能'));
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
});

for (const ignoreAbort of [false, true]) test(`取消后不显示成功或自动重试（transport ignores abort=${ignoreAbort}）`, async t => {
  const ui = await harness(t); await ui.click('查看详情'); ui.options.holdInstall = true; ui.options.ignoreAbort = ignoreAbort;
  await ui.click('下载到本地'); await ui.click('取消');
  if (ignoreAbort) { ui.installs[0].resolve({ name: 'example-skill', root: '/workspace/skills' }); await ui.flush(); }
  assert.equal(ui.refreshed, 0); assert.ok(ui.body().includes('确认是否已完成本地写入'));
  assert.ok(!ui.button('前往全局技能')); assert.equal(ui.button('下载到本地').props.disabled, true);
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
});

test('离开发现页会取消下载，迟到成功不会触发刷新或成功提示', async t => {
  const ui = await harness(t); await ui.click('查看详情'); ui.options.holdInstall = true; ui.options.ignoreAbort = true;
  await ui.click('下载到本地'); const request = ui.calls.find(call => call.path === '/nacos/install'); await ui.stop();
  assert.equal(request.init.signal.aborted, true); ui.installs[0].resolve({ name: 'example-skill' }); await ui.flush(); assert.equal(ui.refreshed, 0);
});

test('未配置、连接失败、无匹配与被过滤的空页分别呈现，空页仍可翻页', async t => {
  const ui = await harness(t); ui.data.configured = false; ui.data.items = []; await ui.click('刷新'); assert.ok(ui.body().includes('尚未配置'));
  ui.data.configured = true; ui.options.failList = true; await ui.click('重试'); assert.ok(ui.body().includes('连接失败'));
  ui.options.failList = false; ui.data.total = 0; await ui.search('missing'); assert.ok(ui.body().includes('没有找到匹配'));
  ui.data.total = 60; await ui.click('清空搜索'); assert.ok(ui.body().includes('本页暂无可下载')); assert.ok(ui.body().includes('本页 0 项'));
  assert.ok(!ui.body().includes('60')); assert.equal(ui.button('下一页').props.disabled, false);
});

test('响应丢失后重开详情和组件重挂载仍禁止重发，Host 成功回执才能完成', async t => {
  const ui = await harness(t, { failTransport: true });
  await ui.click('查看详情'); await ui.click('下载到本地');
  assert.equal(ui.button('下载到本地').props.disabled, true);
  await ui.click('关闭详情'); await ui.click('查看详情');
  assert.equal(ui.button('下载到本地').props.disabled, true);
  await ui.remount(); await ui.click('查看详情');
  assert.equal(ui.button('下载到本地').props.disabled, true);
  await ui.click('核对下载结果');
  assert.equal(ui.refreshed, 0);
  assert.equal(ui.button('下载到本地').props.disabled, true);
  ui.options.outcome = { state: 'succeeded', result: { name: 'example-skill', root: '/workspace/skills' } };
  await ui.click('核对下载结果');
  assert.equal(ui.refreshed, 1);
  assert.ok(ui.body().includes('已确认 example-skill 已下载'));
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
});

test('只有 Host 确认拒绝后才恢复下载按钮', async t => {
  const ui = await harness(t, { failTransport: true });
  await ui.click('查看详情'); await ui.click('下载到本地');
  ui.options.outcome = { state: 'rejected', code: 'error.nacos.notFound', error: 'not found' };
  await ui.click('核对下载结果');
  assert.equal(ui.button('下载到本地').props.disabled, false);
  assert.ok(ui.body().includes('版本已不可用'));
});

test('无效回执保持待确认，不能解锁下载或报告成功', async t => {
  const ui = await harness(t, { failTransport: true });
  await ui.click('查看详情'); await ui.click('下载到本地');
  for (const outcome of [null, {}, { state: 'unknown' }, { state: 'succeeded' }, { state: 'rejected' }]) {
    ui.options.outcome = outcome;
    await ui.click('核对下载结果');
    assert.equal(ui.button('下载到本地').props.disabled, true);
    assert.equal(ui.refreshed, 0);
  }
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
});

test('核对成功后刷新失败不把历史禁用状态当作当前状态', async t => {
  const ui = await harness(t, { failTransport: true, failRefresh: true });
  await ui.click('查看详情'); await ui.click('下载到本地');
  ui.options.outcome = { state: 'succeeded', result: { name: 'example-skill', root: '/workspace/skills' } };
  await ui.click('核对下载结果');
  assert.ok(ui.body().includes('查看当前启用状态'));
  assert.ok(!ui.body().includes('保持禁用'));
  assert.ok(ui.button('前往全局技能'));
});

test('Host 明确拒绝的响应无需等待不存在的安装回执', async t => {
  const ui = await harness(t, { rejectInstall: true });
  await ui.click('查看详情'); await ui.click('下载到本地');
  assert.equal(ui.button('下载到本地').props.disabled, false);
  assert.ok(ui.body().includes('版本已不可用'));
  assert.equal(ui.calls.filter(call => call.path === '/nacos/install').length, 1);
});

test('首次加载显示骨架，首个连接失败有明确重试入口', async t => {
  const loading = await harness(t, { holdList: true });
  assert.equal(loading.renderer.root.findAll(node => node.props.className?.includes('dssm-nacos-skeleton')).length, 3);
  const failed = await harness(t, { failList: true });
  assert.ok(failed.body().includes('暂时无法读取')); failed.options.failList = false;
  await failed.click('重试'); assert.ok(failed.body().includes('example-skill'));
});

test('列表刷新失败保留上次卡片和计数，可独立重试', async t => {
  const ui = await harness(t); ui.options.failList = true; await ui.click('刷新');
  assert.ok(ui.body().includes('example-skill')); assert.ok(ui.body().includes('本页 1 项')); assert.ok(ui.body().includes('连接失败'));
  ui.options.failList = false; await ui.click('重试'); assert.ok(!ui.body().includes('连接失败'));
});

test('Markdown 渲染标题、列表、代码与表格，禁止 HTML、图片和危险链接', () => {
  const html = renderToStaticMarkup(h(SkillDocument, { body: '# Title\n\n- Item\n\n```js\nconst x = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>window.attack=1</script>\n\n<img src="https://corp.example/track">\n\n![track](https://corp.example/track)\n\n[x](javascript:alert%281%29) [local](file:///example) [safe](https://corp.example/help)' }));
  for (const tag of ['<h1>', '<ul>', '<pre>', '<table>']) assert.ok(html.includes(tag), tag);
  assert.doesNotMatch(html, /<script|<img|window\.attack|href="(?:javascript|file):/);
  assert.match(html, /href="https:\/\/corp\.example\/help" target="_blank" rel="noopener noreferrer"/);
  for (const value of ['javascript:alert(1)', 'file:///example', '//corp.example/x', 'data:text/html,x']) assert.equal(skillDocumentUrl(value), undefined);
  const authenticated = new URL('https://corp.example/');
  authenticated.username = 'svc-ci'; authenticated.password = 'synthetic';
  assert.equal(skillDocumentUrl(authenticated.href), undefined);
});

test('实际客户端接入独立详情和导航端口，中文英文词条一致', async () => {
  const source = await readFile(new URL('../src/client.ts', import.meta.url), 'utf8');
  assert.match(source, /useRepositoryUI = createNacosUI/); assert.match(source, /onNavigate: function \(target\)/);
  assert.deepEqual(Object.keys(nacosLocales.zh).sort(), Object.keys(nacosLocales.en).sort());
});
