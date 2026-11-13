import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPage } from './support/client-page.mjs';

const ids = ['forge-iam', 'forge-iam-launcher', 'forge-iam-banner', 'forge-iam-onboarding'];
const signedOut = { state: 'signed-out', configured: true, signedIn: false, canSignIn: true, principal: null,
  gatewayCredential: { state: 'unconfigured' }, missing: [], exclusive: 'ok' };
const ready = { ...signedOut, state: 'ready', signedIn: true, canSignIn: false, canSignOut: true,
  principal: 'synthetic-person', gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { state: 'ready', models: [] } };
const other = { ...ready, principal: 'synthetic-other' };
const nodes = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];
const text = (node) => typeof node === 'string' ? node : node?.type === 'style' ? '' : (node?.children ?? []).map(text).join('');
const button = (page, id, label) => nodes(page.render(id)).find((node) => node.type === 'button' && text(node) === label);

function events() {
  const streams = [];
  let active = 0;
  let maxActive = 0;
  let available = true;
  class EventSource {
    constructor(path) {
      assert.equal(path, '/api/forge-iam/events');
      if (!available) throw new Error('synthetic stream unavailable');
      this.closed = false;
      streams.push(this);
      active++;
      maxActive = Math.max(maxActive, active);
    }
    close() { if (!this.closed) { this.closed = true; active--; } }
    emit(view) { this.onmessage?.({ data: JSON.stringify(view) }); }
    emitRaw(data) { this.onmessage?.({ data }); }
    fail() { this.onerror?.(new Error('synthetic stream error')); }
  }
  return { EventSource, streams, setAvailable(value) { available = value; }, get active() { return active; }, get maxActive() { return maxActive; } };
}

async function mountAll(page) {
  for (const id of ids) page.mount(id, id === 'forge-iam-launcher' ? { wide: true } : {});
  await page.settled();
}

test('四个同页组件共享一条 SSE，所有订阅者更新，最后卸载关闭连接', async (t) => {
  const stream = events();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  assert.equal(stream.maxActive, 1, 'all four simultaneously mounted components share one active source');
  assert.equal(stream.active, 1);
  const first = stream.streams.at(-1);
  first.emit(ready);
  assert.match(text(page.render('forge-iam')), /synthetic-person/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-person/);
  assert.equal(page.render('forge-iam-banner'), null);
  assert.match(text(page.render('forge-iam-onboarding')), /准备就绪/);

  page.unmount('forge-iam-onboarding');
  page.unmount('forge-iam-banner');
  assert.equal(first.closed, false, 'remaining subscribers keep the connection');
  first.emit(other);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(page.lateUpdates, 0, 'unmounted subscribers receive no updates');
  page.unmount('forge-iam');
  assert.equal(first.closed, false);
  page.unmount('forge-iam-launcher');
  assert.equal(first.closed, true, 'the last subscriber closes the connection');
  assert.equal(stream.active, 0);
});

test('凭据写入跨越 epoch 时所有组件保留订阅，旧流事件不得覆盖成功', async (t) => {
  const stream = events();
  const pending = Promise.withResolvers();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(ready);
    if (path === '/api/forge-iam/credential') return pending.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  assert.equal(stream.active, 1);
  const field = nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证');
  field.props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  const saved = { ...ready, gatewayCredential: { ...ready.gatewayCredential, baseURL: 'https://next.corp.example/v1' } };
  pending.resolve(Response.json({ view: saved }));
  await saving;
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
  assert.ok(stream.streams.length >= 3);
  for (const old of stream.streams.slice(0, -1)) { old.emit(ready); old.fail(); }
  const gateway = nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '网关地址');
  assert.equal(gateway.props.value, saved.gatewayCredential.baseURL);
  assert.equal(stream.active, 1, 'stale onerror cannot close the new source');
  stream.streams.at(-1).emit(other);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
});

test('共享事件流出错后只有一个轮询，更新所有组件并自动重连', async (t) => {
  const stream = events();
  let view = signedOut;
  let reads = 0;
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') { reads++; return Response.json(view); }
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  const first = stream.streams.at(-1);
  first.fail();
  assert.equal(stream.active, 0);
  assert.equal(page.intervalCount, 1);
  const before = reads;
  view = other;
  await page.tick();
  assert.equal(reads, before + 1, 'fallback reads once for the whole page');
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(page.render('forge-iam-banner'), null);
  assert.match(text(page.render('forge-iam-onboarding')), /准备就绪/);
  assert.equal(stream.active, 1);
  assert.equal(page.intervalCount, 1, 'keep polling until the new stream delivers');
  stream.streams.at(-1).emit(other);
  assert.equal(page.intervalCount, 0);
  first.emit(signedOut);
  first.fail();
  assert.equal(stream.active, 1, 'old stream callbacks cannot affect the replacement');
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
});

test('重连已构造但没有有效首帧时继续共享轮询，首帧后才停止', async (t) => {
  const stream = events();
  let view = signedOut;
  let reads = 0;
  const page = await mountPage(async (path) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    reads++;
    return Response.json(view);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  const old = stream.streams.at(-1);
  old.emit(signedOut);
  old.fail();
  view = ready;
  await page.tick();
  const reconnected = stream.streams.at(-1);
  const sourceCount = stream.streams.length;
  assert.notEqual(reconnected, old);
  assert.equal(page.intervalCount, 1, 'constructing a stream does not prove it is delivering');
  reconnected.emitRaw('not-json');
  reconnected.emit(null);
  reconnected.emit({});
  assert.equal(page.intervalCount, 1, 'invalid frames do not stop fallback');
  const previousReads = reads;
  view = { ...other, gatewayCredential: { state: 'unconfigured' } };
  await page.tick();
  assert.equal(reads, previousReads + 1);
  assert.equal(stream.streams.length, sourceCount + 1, 'one successful read replaces the pending source once');
  assert.equal(reconnected.closed, true);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-banner')), /尚未保存个人访问凭证/);
  assert.match(text(page.render('forge-iam-onboarding')), /synthetic-other/);
  old.emit(signedOut);
  old.fail();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  reconnected.emit(signedOut);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  stream.streams.at(-1).emit(view);
  assert.equal(page.intervalCount, 0);
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
});

test('轮询已广播新账号后，旧首帧不能使组件恢复旧账号或停止轮询', async (t) => {
  const stream = events();
  let view = signedOut;
  const page = await mountPage(async (path) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    return Response.json(view);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).emit(signedOut);
  stream.streams.at(-1).fail();
  view = ready;
  await page.tick();
  const staleSource = stream.streams.at(-1);
  const switched = { ...other, gatewayCredential: { state: 'unconfigured' } };
  view = switched;
  await page.tick();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  // This source's initial ready snapshot was generated before the later GET.
  staleSource.emit(ready);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-banner')), /尚未保存个人访问凭证/);
  assert.match(text(page.render('forge-iam-onboarding')), /synthetic-other/);
  assert.equal(staleSource.closed, true);
  assert.equal(page.intervalCount, 1);
  assert.equal(stream.active, 1);
  const current = stream.streams.at(-1);
  current.emit(switched);
  assert.equal(page.intervalCount, 0);
});

test('首帧持续迟到时每次成功轮询最多重建一次，仍持续更新并在卸载时关闭', async (t) => {
  const stream = events();
  let view = ready;
  let failReads = false;
  const page = await mountPage(async (path) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (failReads) throw new Error('synthetic view failure');
    return Response.json(view);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  let previous = stream.streams.at(-1);
  for (const principal of ['synthetic-a', 'synthetic-b', 'synthetic-c']) {
    const before = stream.streams.length;
    view = { ...ready, principal };
    await page.tick();
    assert.equal(stream.streams.length, before + 1);
    assert.equal(previous.closed, true);
    previous.emit(ready);
    previous.fail();
    assert.match(text(page.render('forge-iam-launcher')), new RegExp(principal));
    assert.equal(page.intervalCount, 1);
    previous = stream.streams.at(-1);
  }
  failReads = true;
  const before = stream.streams.length;
  await page.tick();
  assert.equal(stream.streams.length, before, 'failed reads do not churn the pending stream');
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
  for (const id of ids) page.unmount(id);
  assert.equal(previous.closed, true);
  assert.equal(page.intervalCount, 0);
  previous.emit(ready);
  assert.equal(page.lateUpdates, 0);
});

test('等待首帧的旧轮询不能跨登录屏障回写', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  const login = Promise.withResolvers();
  let defer = false;
  const page = await mountPage(async (path, options) => {
    if (path === '/api/forge-iam/sign-in') return login.promise;
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    return defer && options?.signal ? delayedView.promise : Response.json(signedOut);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  defer = true;
  const oldPoll = page.tick();
  const oldSource = stream.streams.at(-1);
  const signingIn = button(page, 'forge-iam', '登录企业账号').props.onClick();
  const current = stream.streams.at(-1);
  assert.equal(oldSource.closed, true);
  delayedView.resolve(Response.json(ready));
  await oldPoll;
  assert.doesNotMatch(text(page.render('forge-iam-launcher')), /synthetic-person/);
  assert.equal(stream.streams.at(-1), current);
  login.resolve(Response.json({ view: { ...signedOut, state: 'authenticating', canSignIn: false } }));
  await signingIn;
  assert.doesNotMatch(text(page.render('forge-iam')), /synthetic-person/);
  oldSource.emit(ready);
  assert.doesNotMatch(text(page.render('forge-iam-launcher')), /synthetic-person/);
});

test('订阅重建流等待首帧时轮询更新组件，卸载会取消并停止轮询', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let view = ready;
  let defer = false;
  let oldSignal;
  const page = await mountPage(async (path, options) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (defer && options?.signal) { oldSignal = options.signal; return delayedView.promise; }
    return Response.json(view);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  page.mount('forge-iam-launcher', { wide: true });
  await page.settled();
  const old = stream.streams.at(-1);
  old.emit(ready);
  page.mount('forge-iam');
  await page.settled();
  const pendingSource = stream.streams.at(-1);
  assert.equal(old.closed, true);
  assert.equal(page.intervalCount, 1);
  view = other;
  await page.tick();
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  const activeSource = stream.streams.at(-1);
  assert.equal(pendingSource.closed, true);
  defer = true;
  const waiting = page.tick();
  page.unmount('forge-iam');
  page.unmount('forge-iam-launcher');
  assert.equal(page.intervalCount, 0);
  assert.equal(activeSource.closed, true);
  assert.equal(oldSignal?.aborted, true);
  delayedView.resolve(Response.json(signedOut));
  await waiting;
  pendingSource.emit(signedOut);
  old.emit(signedOut);
  assert.equal(page.lateUpdates, 0);
});

test('重连首帧优先于同代在途轮询，迟到 GET 不会覆盖该帧', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let defer = false;
  let pendingReads = 0;
  const page = await mountPage(async (path, options) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (defer && options?.signal) { pendingReads++; return delayedView.promise; }
    return Response.json(ready);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  const old = stream.streams.at(-1);
  old.emit(ready);
  old.fail();
  await page.tick();
  const reconnected = stream.streams.at(-1);
  defer = true;
  const waiting = page.tick();
  assert.equal(pendingReads, 1);
  reconnected.emit(other);
  delayedView.resolve(Response.json(ready));
  await waiting;
  assert.equal(page.intervalCount, 0);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
});

test('等待首帧期间的轮询不能跨新订阅者引起的流重建', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let defer = false;
  const page = await mountPage(async (path, options) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    return defer && options?.signal ? delayedView.promise : Response.json(ready);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  page.mount('forge-iam-launcher', { wide: true });
  await page.settled();
  defer = true;
  const waiting = page.tick();
  const previous = stream.streams.at(-1);
  page.mount('forge-iam');
  assert.equal(previous.closed, true);
  delayedView.resolve(Response.json(signedOut));
  await waiting;
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-person/);
  defer = false;
  await page.tick();
  assert.match(text(page.render('forge-iam')), /synthetic-person/);
  assert.equal(stream.active, 1);
});

test('等待首帧期间保存跨 epoch 丢弃旧轮询，新轮询可同步换号', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  const pendingSave = Promise.withResolvers();
  let view = signedOut;
  let defer = false;
  const page = await mountPage(async (path, options) => {
    if (path === '/api/forge-iam/credential') return pendingSave.promise;
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    return defer && options?.signal ? delayedView.promise : Response.json(view);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).emit(ready);
  for (const id of ids) page.render(id);
  page.unmount('forge-iam-banner');
  view = ready;
  page.mount('forge-iam-banner');
  await page.settled();
  defer = true;
  const oldPoll = page.tick();
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  delayedView.resolve(Response.json(signedOut));
  await oldPoll;
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-person/);
  defer = false;
  view = { ...other, gatewayCredential: { state: 'unconfigured' } };
  const beforeSwitch = stream.streams.length;
  await page.tick();
  assert.equal(stream.streams.length, beforeSwitch + 1, 'the account change already rebuilt the stream');
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-banner')), /尚未保存个人访问凭证/);
  assert.match(text(page.render('forge-iam-onboarding')), /synthetic-other/);
  pendingSave.resolve(Response.json({ view: ready }));
  await saving;
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.equal(stream.maxActive, 1);
});

test('一个组件正在退出时其余订阅者仍可更新', async (t) => {
  const stream = events();
  const pending = Promise.withResolvers();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(ready);
    if (path === '/api/forge-iam/sign-out') return pending.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  const signingOut = button(page, 'forge-iam', '退出').props.onClick();
  assert.equal(stream.active, 1);
  stream.streams.at(-1).emit(other);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.doesNotMatch(text(page.render('forge-iam')), /synthetic-other/);
  pending.resolve(Response.json({ view: signedOut, revocation: 'ok' }));
  await signingOut;
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
});

test('登录与向导关闭推进各自 epoch 后，其余组件仍持续订阅', async (t) => {
  const stream = events();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    if (path === '/api/forge-iam/sign-in') return Response.json({ view: ready });
    if (path === '/api/forge-iam/cancel') return Response.json({ view: signedOut });
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  const beforeLogin = stream.streams.at(-1);
  await button(page, 'forge-iam', '登录企业账号').props.onClick();
  assert.equal(beforeLogin.closed, true);
  stream.streams.at(-1).emit(other);
  assert.match(text(page.render('forge-iam-onboarding')), /准备就绪/);
  const beforeClose = stream.streams.at(-1);
  await button(page, 'forge-iam-onboarding', '完成').props.onClick();
  assert.equal(beforeClose.closed, true);
  assert.equal(page.render('forge-iam-onboarding'), null);
  beforeLogin.emit(signedOut);
  beforeClose.fail();
  stream.streams.at(-1).emit(other);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
});

test('保存期间 SSE 账号切换重建共享流，旧回执不覆盖新账号', async (t) => {
  const stream = events();
  const pending = Promise.withResolvers();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(ready);
    if (path === '/api/forge-iam/credential') return pending.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  const beforeSwitch = stream.streams.at(-1);
  beforeSwitch.emit(other);
  assert.equal(beforeSwitch.closed, true);
  stream.streams.at(-1).emit(other);
  pending.resolve(Response.json({ view: ready }));
  await saving;
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.doesNotMatch(text(page.render('forge-iam')), /网关地址和个人访问凭证已保存|synthetic-person/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(stream.active, 1);
  assert.equal(stream.maxActive, 1);
});

test('有效换号帧触发同步重建时，所有仍挂载的组件收到同一帧', async (t) => {
  const stream = events();
  const pending = Promise.withResolvers();
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    if (path === '/api/forge-iam/credential') return pending.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).emit(ready);
  for (const id of ids) page.render(id);
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  const beforeSwitch = stream.streams.at(-1);
  const switched = { ...other, gatewayCredential: { state: 'unconfigured' } };
  beforeSwitch.emit(switched);
  assert.equal(beforeSwitch.closed, true);
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-banner')), /尚未保存个人访问凭证/);
  assert.match(text(page.render('forge-iam-onboarding')), /synthetic-other/);
  // The replacement source deliberately emits no frame; queued old callbacks
  // and the old save receipt cannot replace the already delivered account.
  beforeSwitch.emit(ready);
  beforeSwitch.fail();
  pending.resolve(Response.json({ view: ready }));
  await saving;
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(stream.active, 1);
});

test('无流时保存推进 epoch，所有组件都丢弃操作前发出的迟到轮询', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  const pendingSave = Promise.withResolvers();
  let defer = false;
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return defer ? delayedView.promise : Response.json(ready);
    if (path === '/api/forge-iam/credential') return pendingSave.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).fail();
  defer = true;
  const oldPoll = page.tick();
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  delayedView.resolve(Response.json(signedOut));
  await oldPoll;
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-person/);
  assert.equal(page.render('forge-iam-banner'), null);
  pendingSave.resolve(Response.json({ view: ready }));
  await saving;
});

test('保存后开始的有效轮询触发同步换号时，所有仍挂载的组件收到该结果', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  const pendingSave = Promise.withResolvers();
  let defer = false;
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return defer ? delayedView.promise : Response.json(signedOut);
    if (path === '/api/forge-iam/credential') return pendingSave.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).emit(ready);
  for (const id of ids) page.render(id);
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  const saving = button(page, 'forge-iam', '保存凭据').props.onClick();
  stream.streams.at(-1).fail();
  defer = true;
  const currentPoll = page.tick();
  delayedView.resolve(Response.json({ ...other, gatewayCredential: { state: 'unconfigured' } }));
  await currentPoll;
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.match(text(page.render('forge-iam-banner')), /尚未保存个人访问凭证/);
  assert.match(text(page.render('forge-iam-onboarding')), /synthetic-other/);
  pendingSave.resolve(Response.json({ view: ready }));
  await saving;
  assert.match(text(page.render('forge-iam')), /synthetic-other/);
});

test('共享轮询使用每个订阅者的 epoch，旧读取不能覆盖保存回执', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let defer = false;
  const saved = { ...ready, gatewayCredential: { ...ready.gatewayCredential, baseURL: 'https://next.corp.example/v1' } };
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return defer ? delayedView.promise : Response.json(ready);
    if (path === '/api/forge-iam/credential') return Response.json({ view: saved });
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).fail();
  defer = true;
  const oldPoll = page.tick();
  nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  await button(page, 'forge-iam', '保存凭据').props.onClick();
  delayedView.resolve(Response.json(ready));
  await oldPoll;
  assert.equal(nodes(page.render('forge-iam')).find((node) => node.props['aria-label'] === '网关地址').props.value, saved.gatewayCredential.baseURL);
  assert.equal(stream.active, 1);
});

test('共享轮询无响应时仍可重连，迟到轮询不能覆盖新流状态', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let defer = false;
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') return defer ? delayedView.promise : Response.json(ready);
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).fail();
  defer = true;
  const waiting = page.tick();
  await page.settled();
  await page.tick();
  assert.equal(stream.active, 1, 'a stuck view read must not prevent stream reconnection');
  stream.streams.at(-1).emit(other);
  delayedView.resolve(Response.json(ready));
  await waiting;
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(stream.active, 1);
});

test('共享轮询读取失败不抹去已知状态，后续断流仍可恢复', async (t) => {
  const stream = events();
  let reject = false;
  let view = ready;
  const page = await mountPage(async (path) => {
    if (path === '/api/forge-iam/view') {
      if (reject) throw new Error('synthetic read failure');
      return Response.json(view);
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.streams.at(-1).fail();
  reject = true;
  await page.tick();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-person/);
  assert.equal(stream.active, 1);
  stream.streams.at(-1).fail();
  reject = false;
  view = other;
  await page.tick();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(stream.active, 1);
});

test('持续断流时挂起的轮询超时并取消，后续轮询恢复且丢弃迟到结果', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let defer = false;
  let reads = 0;
  let oldSignal;
  const page = await mountPage(async (path, options) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (!defer) return Response.json(ready);
    reads++;
    if (reads === 1) { oldSignal = options?.signal; return delayedView.promise; }
    return Response.json(other);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.setAvailable(false);
  stream.streams.at(-1).fail();
  defer = true;
  const oldPoll = page.tick();
  page.advanceTime(10000);
  await page.settled();
  await page.tick();
  assert.equal(reads, 2, 'a stalled read does not permanently block fallback');
  assert.equal(oldSignal?.aborted, true);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  delayedView.resolve(Response.json(signedOut));
  await oldPoll;
  await page.settled();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
});

test('最后卸载取消旧轮询，重新挂载后可继续且不接收旧回执', async (t) => {
  const stream = events();
  const delayedView = Promise.withResolvers();
  let fallback = false;
  let reads = 0;
  let oldSignal;
  const page = await mountPage(async (path, options) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (!fallback) return Response.json(ready);
    if (options?.signal) {
      reads++;
      if (reads === 1) { oldSignal = options.signal; return delayedView.promise; }
    }
    return Response.json(other);
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.setAvailable(false);
  stream.streams.at(-1).fail();
  fallback = true;
  const oldPoll = page.tick();
  for (const id of ids) page.unmount(id);
  assert.equal(oldSignal?.aborted, true);
  page.mount('forge-iam-launcher', { wide: true });
  await page.settled();
  await page.tick();
  assert.equal(reads, 2);
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  delayedView.resolve(Response.json(signedOut));
  await oldPoll;
  await page.settled();
  assert.match(text(page.render('forge-iam-launcher')), /synthetic-other/);
  assert.equal(page.lateUpdates, 0);
});

test('忽略取消的异常读取不会随轮询无限累积', async (t) => {
  const stream = events();
  const never = new Promise(() => {});
  let fallback = false;
  let reads = 0;
  const page = await mountPage(async (path) => {
    if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
    if (!fallback) return Response.json(ready);
    reads++;
    return never;
  }, { eventSource: stream.EventSource });
  t.after(() => page.close());
  await mountAll(page);
  stream.setAvailable(false);
  stream.streams.at(-1).fail();
  fallback = true;
  void page.tick();
  page.advanceTime(10000);
  await page.settled();
  void page.tick();
  page.advanceTime(10000);
  await page.settled();
  for (let i = 0; i < 5; i++) { void page.tick(); page.advanceTime(10000); await page.settled(); }
  assert.equal(reads, 2, 'at most two uncooperative reads remain outstanding');
});

for (const lateResult of ['success', 'failure']) {
  test(`新订阅者收到当前流视图，首次读取迟到${lateResult === 'success' ? '旧值' : '失败'}不能覆盖`, async (t) => {
    const stream = events();
    const delayedView = Promise.withResolvers();
    let reads = 0;
    const page = await mountPage(async (path) => {
      if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
      reads++;
      return reads === 1 ? Response.json(ready) : delayedView.promise;
    }, { eventSource: stream.EventSource });
    t.after(() => page.close());
    page.mount('forge-iam-launcher', { wide: true });
    await page.settled();
    const previous = stream.streams.at(-1);
    previous.emit(ready);
    page.mount('forge-iam');
    assert.equal(previous.closed, true);
    stream.streams.at(-1).emit(ready);
    assert.match(text(page.render('forge-iam')), /synthetic-person/);
    if (lateResult === 'success') delayedView.resolve(Response.json(signedOut));
    else delayedView.reject(new Error('synthetic view failure'));
    await page.settled();
    assert.match(text(page.render('forge-iam')), /synthetic-person/);
    assert.doesNotMatch(text(page.render('forge-iam')), /无法读取登录状态/);
    assert.equal(stream.active, 1);
    assert.equal(stream.maxActive, 1);
  });
}

for (const lateResult of ['success', 'failure']) {
  for (const id of ['forge-iam-launcher', 'forge-iam-banner', 'forge-iam-onboarding']) {
    test(`${id} 的初始读取迟到${lateResult === 'success' ? '旧值' : '失败'}不能覆盖新订阅流`, async (t) => {
      const stream = events();
      const delayedView = Promise.withResolvers();
      let reads = 0;
      const firstView = id === 'forge-iam-onboarding' ? signedOut : ready;
      const page = await mountPage(async (path) => {
        if (path !== '/api/forge-iam/view') throw new Error(`unexpected synthetic request: ${path}`);
        reads++;
        return reads === 1 ? Response.json(firstView) : delayedView.promise;
      }, { eventSource: stream.EventSource });
      t.after(() => page.close());
      page.mount(id === 'forge-iam-launcher' ? 'forge-iam' : 'forge-iam-launcher', { wide: true });
      await page.settled();
      const oldStream = stream.streams.at(-1);
      oldStream.emit(firstView);
      page.mount(id, { wide: true });
      const newStream = stream.streams.at(-1);
      newStream.emit(id === 'forge-iam-onboarding' ? signedOut : other);
      if (lateResult === 'success') delayedView.resolve(Response.json(id === 'forge-iam-onboarding' ? ready : signedOut));
      else delayedView.reject(new Error('synthetic view failure'));
      oldStream.emit(signedOut);
      await page.settled();
      if (id === 'forge-iam-launcher') assert.match(text(page.render(id)), /synthetic-other/);
      else if (id === 'forge-iam-banner') assert.equal(page.render(id), null);
      else {
        assert.match(text(page.render(id)), /欢迎使用企业版/);
        newStream.emit(other);
        assert.match(text(page.render(id)), /synthetic-other/);
      }
      assert.equal(stream.active, 1);
      assert.equal(stream.maxActive, 1);
    });
  }
}
