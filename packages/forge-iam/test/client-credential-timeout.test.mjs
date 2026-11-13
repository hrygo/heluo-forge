import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

const account = {
  state: 'ready', configured: true, signedIn: true, canSignIn: false, canSignOut: true,
  principal: 'synthetic-person', missing: [], exclusive: 'ok',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { state: 'ready', models: [] },
};
const signedOut = { state: 'signed-out', canSignIn: true, signedIn: false, principal: null, gatewayCredential: { state: 'unknown' } };
const onboardingReady = { ...account, gatewayCredential: { state: 'unconfigured' } };
const saved = { ...account, gatewayCredential: { ...account.gatewayCredential, baseURL: 'https://next.corp.example/v1' } };
const nodes = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];
const visibleText = (node) => typeof node === 'string' ? node : node?.type === 'style' ? '' : (node?.children ?? []).map(visibleText).join('');
const flush = () => new Promise(setImmediate);

async function fixture(t, kind, save, { cancel } = {}) {
  let view = kind === 'onboarding' ? signedOut : account;
  let writes = 0;
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/sign-in') { view = onboardingReady; return Response.json({ view }); }
    if (path === '/api/forge-iam/sign-out') { view = signedOut; return Response.json({ view, revocation: 'ok' }); }
    if (path === '/api/forge-iam/cancel') return cancel ? cancel() : Response.json({ view });
    if (path === '/api/forge-iam/credential') { writes++; return save(); }
    if (path === '/api/forge-iam/models') return Response.json({ view: saved });
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { componentId: kind === 'onboarding' ? 'forge-iam-onboarding' : 'forge-iam' });
  t.after(() => panel.close());
  const button = (label) => panel.findButton(panel.render(), label);
  if (kind === 'onboarding') {
    button('开始').props.onClick();
    await button('登录').props.onClick();
  }
  const input = () => nodes(panel.render()).find((node) => node.props['aria-label'] === '个人访问凭证');
  input().props.onChange({ target: { value: 'synthetic-credential' } });
  return {
    panel, button, input,
    save: () => button(kind === 'onboarding' ? '保存并继续' : '保存凭据').props.onClick(),
    text: () => visibleText(panel.render()),
    setView: (next) => { view = next; },
    writes: () => writes,
  };
}

for (const kind of ['settings', 'onboarding']) {
  for (const stalled of ['request', 'body']) {
    test(`${kind}: ${stalled} 超时后结果未知，迟到成功和刷新不会变成成功回执`, async (t) => {
      const deferred = Promise.withResolvers();
      const f = await fixture(t, kind, () => stalled === 'request'
        ? deferred.promise
        : { ok: true, status: 200, json: () => deferred.promise });
      const originalClick = f.button(kind === 'onboarding' ? '保存并继续' : '保存凭据').props.onClick;
      const originalClear = kind === 'settings' ? f.button('清除凭据').props.onClick : null;
      const saving = originalClick();
      let settled = false;
      void saving.then(() => { settled = true; });
      await flush();
      f.panel.advanceTime(60000);
      await flush();
      assert.equal(settled, true, 'the complete request, including the body, must have a deadline');
      assert.match(f.text(), /保存结果未确认/);
      assert.doesNotMatch(f.text(), /正在处理…|正在保存…|网关地址和个人访问凭证已保存|准备就绪/);
      assert.equal(f.writes(), 1);
      assert.equal(f.input().props.value, '', 'do not retain a submitted secret in the form');
      await originalClick();
      await originalClear?.();
      assert.equal(f.writes(), 1, 'an unresolved write cannot be resubmitted from an old callback');
      assert.equal(f.button(kind === 'onboarding' ? '保存并继续' : '保存凭据').props.disabled, true);

      f.setView(saved);
      await f.panel.tick();
      assert.match(f.text(), /保存结果未确认/, 'a configured view cannot attribute this write');
      if (kind === 'settings') assert.doesNotMatch(f.text(), /个人访问凭证：已保存/);
      else {
        f.button('稍后配置').props.onClick();
        assert.doesNotMatch(f.text(), /准备就绪|个人访问凭证已保存|刷新后查看/);
      }

      deferred.resolve(stalled === 'request' ? Response.json({ view: saved }) : { view: saved });
      await flush();
      assert.equal(f.writes(), 1, 'the client must never retry the write automatically');
      assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存|准备就绪/);
    });
  }

  for (const [name, save] of [
    ['network error', async () => { throw new TypeError('synthetic network failure'); }],
    ['unknown server error', () => Response.json({ error: { code: 'IAM_GATEWAY_WRITE_UNKNOWN' } }, { status: 503 })],
    ['post-commit lifecycle error', () => Response.json({ error: { code: 'IAM_CREDENTIALS_UNAVAILABLE' } }, { status: 503 })],
    ['malformed success', () => Response.json({})],
    ['unparseable success', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('truncated synthetic JSON'); } })],
  ]) {
    test(`${kind}: ${name} 不得猜测写入失败或成功`, async (t) => {
      const f = await fixture(t, kind, save);
      await f.save();
      assert.match(f.text(), /保存结果未确认/);
      assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存|准备就绪|请稍后重试/);
      assert.equal(f.writes(), 1);
    });
  }

  test(`${kind}: 明确的提交前拒绝保留具体错误`, async (t) => {
    const f = await fixture(t, kind, () => Response.json({ error: { code: 'IAM_GATEWAY_URL_INVALID' } }, { status: 400 }));
    await f.save();
    assert.match(f.text(), /请输入有效的 HTTP 或 HTTPS 网关地址/);
    assert.doesNotMatch(f.text(), /保存结果未确认/);
    assert.equal(f.writes(), 1);
  });
}

test('设置页同一渲染帧内双击仅发送一次写入', async (t) => {
  const deferred = Promise.withResolvers();
  const f = await fixture(t, 'settings', () => deferred.promise);
  const click = f.button('保存凭据').props.onClick;
  const first = click();
  const second = click();
  assert.equal(f.writes(), 1);
  deferred.resolve(Response.json({ view: saved }));
  await Promise.all([first, second]);
});

for (const change of ['sign-out', 'account change']) {
  test(`设置页保存时 ${change}，旧成功回执不能复活或覆盖新会话`, async (t) => {
    const deferred = Promise.withResolvers();
    const f = await fixture(t, 'settings', () => deferred.promise);
    const saving = f.save();
    if (change === 'sign-out') await f.button('退出').props.onClick();
    else {
      f.setView({ ...account, principal: 'synthetic-other' });
      await f.panel.tick();
    }
    deferred.resolve(Response.json({ view: saved }));
    await saving;
    assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存|synthetic-person/);
    if (change === 'account change') assert.match(f.text(), /synthetic-other/);
  });
}

test('向导保存期间登录失效，旧成功回执不能跳过登录或刷新模型', async (t) => {
  const deferred = Promise.withResolvers();
  const f = await fixture(t, 'onboarding', () => deferred.promise);
  const saving = f.save();
  f.setView(signedOut);
  await f.panel.tick();
  assert.match(f.text(), /登录企业账号/);
  deferred.resolve(Response.json({ view: saved }));
  await saving;
  assert.match(f.text(), /登录企业账号/);
  assert.doesNotMatch(f.text(), /准备就绪|个人访问凭证已保存/);
});

test('设置页保存期间会话过期，旧成功回执不能恢复已登录状态', async (t) => {
  const deferred = Promise.withResolvers();
  const f = await fixture(t, 'settings', () => deferred.promise);
  const saving = f.save();
  f.setView({ ...account, state: 'expired', signedIn: false, canSignIn: true, canSignOut: false, principal: null });
  await f.panel.tick();
  deferred.resolve(Response.json({ view: saved }));
  await saving;
  assert.match(f.text(), /授权已过期/);
  assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存|synthetic-person/);
  assert.equal(f.input().props.value, '');
});

for (const [state, label] of [['error', /需要处理/], ['unreachable', /暂时无法连接登录服务/]]) {
  test(`设置页保存期间会话进入 ${state}，旧成功不能覆盖当前状态`, async (t) => {
    const deferred = Promise.withResolvers();
    const f = await fixture(t, 'settings', () => deferred.promise);
    const saving = f.save();
    f.setView({ ...account, state, signedIn: false, canSignIn: true, canSignOut: false, principal: null,
      error: state === 'error' ? 'IAM_CREDENTIALS_UNAVAILABLE' : null });
    await f.panel.tick();
    deferred.resolve(Response.json({ view: saved }));
    await saving;
    assert.match(f.text(), label);
    assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存|synthetic-person/);
    assert.equal(f.input().props.value, '');
  });

  test(`设置页保存期间会话进入 ${state}，明确失败回执仍可见`, async (t) => {
    const deferred = Promise.withResolvers();
    const f = await fixture(t, 'settings', () => deferred.promise);
    const saving = f.save();
    f.setView({ ...account, state, signedIn: false, canSignIn: true, canSignOut: false, principal: null });
    await f.panel.tick();
    deferred.resolve(Response.json({ error: { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' } }, { status: 503 }));
    await saving;
    assert.match(f.text(), /暂时无法安全地保存或清除凭证，请联系管理员/);
    assert.doesNotMatch(f.text(), /网关地址和个人访问凭证已保存/);
  });
}

test('设置页保存途中开始登录后超时，提交的凭据草稿仍会清空', async (t) => {
  const deferred = Promise.withResolvers();
  const f = await fixture(t, 'settings', () => deferred.promise);
  f.setView({ ...account, canSignIn: true });
  await f.panel.tick();
  const saving = f.save();
  await f.button('登录企业账号').props.onClick();
  f.panel.advanceTime(60000);
  await saving;
  assert.match(f.text(), /保存结果未确认/);
  assert.equal(f.input().props.value, '');
});

test('关闭向导等待 cancel 结果后才释放界面', async (t) => {
  const cancel = Promise.withResolvers();
  const f = await fixture(t, 'onboarding', () => Response.json({ view: saved }), { cancel: () => cancel.promise });
  f.button('稍后配置').props.onClick();
  const closing = f.button('完成').props.onClick();
  assert.match(f.text(), /登录完成，尚未配置凭据/, 'the overlay remains while cancel is in flight');
  cancel.resolve(Response.json({ view: signedOut }));
  await closing;
  assert.equal(f.panel.render(), null);
});

test('向导关闭为单飞，关闭期间不能登录，结束后设置页可开始新登录', async (t) => {
  const cancellations = [];
  let signIns = 0;
  let view = signedOut;
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/cancel') {
      const pending = Promise.withResolvers();
      cancellations.push(pending);
      return pending.promise;
    }
    if (path === '/api/forge-iam/sign-in') { signIns++; view = account; return Response.json({ view }); }
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { componentId: 'forge-iam-onboarding' });
  t.after(() => {
    for (const pending of cancellations) pending.resolve(Response.json({ view: signedOut }));
    panel.close();
  });
  const button = (label) => panel.findButton(panel.render(), label);
  button('开始').props.onClick();
  const oldSkip = button('跳过').props.onClick;
  const oldLogin = button('登录').props.onClick;
  const closing = oldSkip();
  const duplicate = oldSkip();
  assert.equal(cancellations.length, 1, 'two close events must send only one cancel');
  assert.equal(button('跳过').props.disabled, true);
  assert.equal(button('登录').props.disabled, true);
  await oldLogin();
  assert.equal(signIns, 0, 'a stale login callback must not start login during close');

  cancellations[0].resolve(Response.json({ view: signedOut }));
  await Promise.all([closing, duplicate]);
  assert.equal(panel.render(), null);
  view = { ...account, state: 'expired', canSignIn: true, canSignOut: false };
  await panel.switchComponent('forge-iam');
  await button('登录企业账号').props.onClick();
  assert.equal(signIns, 1);
  assert.match(visibleText(panel.render()), /synthetic-person/);
  await oldSkip();
  assert.equal(cancellations.length, 1, 'the old close cannot cancel a later settings login');
});

test('向导关闭期间迟到的登录响应不能重新推进向导', async (t) => {
  const login = Promise.withResolvers();
  const cancel = Promise.withResolvers();
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    if (path === '/api/forge-iam/sign-in') return login.promise;
    if (path === '/api/forge-iam/cancel') return cancel.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { componentId: 'forge-iam-onboarding' });
  t.after(() => panel.close());
  const button = (label) => panel.findButton(panel.render(), label);
  button('开始').props.onClick();
  const signing = button('登录').props.onClick();
  const closing = button('跳过').props.onClick();
  login.resolve(Response.json({ view: onboardingReady }));
  await signing;
  assert.equal(button('登录').props.disabled, true);
  assert.doesNotMatch(visibleText(panel.render()), /添加个人访问凭证/);
  cancel.resolve(Response.json({ view: signedOut }));
  await closing;
  assert.equal(panel.render(), null);
});

test('向导超时后切到设置页仍保留未知态，不能再次保存或清除', async (t) => {
  const deferred = Promise.withResolvers();
  const f = await fixture(t, 'onboarding', () => deferred.promise);
  const saving = f.save();
  f.panel.advanceTime(60000);
  await saving;
  f.setView(account);
  await f.panel.switchComponent('forge-iam');
  assert.match(f.text(), /保存结果未确认/);
  assert.equal(f.button('保存凭据').props.disabled, true);
  await f.button('保存凭据').props.onClick();
  assert.equal(f.writes(), 1);
});

test('向导保存后获取模型期间换号，旧账号模型响应不能覆盖新账号', async (t) => {
  const models = Promise.withResolvers();
  let view = signedOut;
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/sign-in') { view = onboardingReady; return Response.json({ view }); }
    if (path === '/api/forge-iam/credential') return Response.json({ view: saved });
    if (path === '/api/forge-iam/models') return models.promise;
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { componentId: 'forge-iam-onboarding' });
  t.after(() => panel.close());
  const button = (name) => panel.findButton(panel.render(), name);
  button('开始').props.onClick();
  await button('登录').props.onClick();
  nodes(panel.render()).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
  await button('保存并继续').props.onClick();
  view = { ...saved, principal: 'synthetic-other' };
  await panel.tick();
  models.resolve(Response.json({ view: saved }));
  await flush();
  assert.match(visibleText(panel.render()), /synthetic-other/);
  assert.doesNotMatch(visibleText(panel.render()), /synthetic-person/);
});

for (const kind of ['settings', 'onboarding']) {
  test(`${kind}: 保存前开始的旧轮询不能覆盖已确认的成功视图`, async (t) => {
    const oldRead = Promise.withResolvers();
    let reads = 0;
    const panel = await mountPanel(async (path) => {
      if (path === '/api/forge-iam/view') return reads++ === 0 ? Response.json(kind === 'onboarding' ? signedOut : account) : oldRead.promise;
      if (path === '/api/forge-iam/sign-in') return Response.json({ view: onboardingReady });
      if (path === '/api/forge-iam/credential') return Response.json({ view: saved });
      if (path === '/api/forge-iam/models') return new Promise(() => {});
      throw new Error(`unexpected synthetic request: ${path}`);
    }, { componentId: kind === 'onboarding' ? 'forge-iam-onboarding' : 'forge-iam' });
    t.after(() => panel.close());
    const button = (name) => panel.findButton(panel.render(), name);
    if (kind === 'onboarding') { button('开始').props.onClick(); await button('登录').props.onClick(); }
    nodes(panel.render()).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
    const polling = panel.tick();
    await button(kind === 'onboarding' ? '保存并继续' : '保存凭据').props.onClick();
    oldRead.resolve(Response.json(kind === 'onboarding' ? onboardingReady : account));
    await polling;
    const tree = panel.render();
    if (kind === 'onboarding') assert.match(visibleText(tree), /准备就绪/);
    else assert.equal(nodes(tree).find((node) => node.props['aria-label'] === '网关地址').props.value, saved.gatewayCredential.baseURL);
  });
}

for (const kind of ['settings', 'onboarding']) {
  test(`${kind}: 保存前的 SSE 帧不能覆盖成功视图，重建的事件流仍观察换号`, async (t) => {
    const streams = [];
    class FakeEventSource {
      constructor() { this.closed = false; streams.push(this); }
      close() { this.closed = true; }
      emit(view) { this.onmessage?.({ data: JSON.stringify(view) }); }
    }
    const deferred = Promise.withResolvers();
    const panel = await mountPanel(async (path) => {
      if (path === '/api/forge-iam/view') return Response.json(kind === 'onboarding' ? signedOut : account);
      if (path === '/api/forge-iam/sign-in') return Response.json({ view: onboardingReady });
      if (path === '/api/forge-iam/credential') return deferred.promise;
      if (path === '/api/forge-iam/models') return new Promise(() => {});
      throw new Error(`unexpected synthetic request: ${path}`);
    }, { componentId: kind === 'onboarding' ? 'forge-iam-onboarding' : 'forge-iam', eventSource: FakeEventSource });
    t.after(() => panel.close());
    const button = (name) => panel.findButton(panel.render(), name);
    if (kind === 'onboarding') { button('开始').props.onClick(); await button('登录').props.onClick(); }
    nodes(panel.render()).find((node) => node.props['aria-label'] === '个人访问凭证').props.onChange({ target: { value: 'synthetic-credential' } });
    const original = streams[0];
    const saving = button(kind === 'onboarding' ? '保存并继续' : '保存凭据').props.onClick();
    deferred.resolve(Response.json({ view: saved }));
    await saving;
    assert.equal(original.closed, true);
    assert.ok(streams.length >= 3, 'both start and completion must fence prior streams');
    for (const old of streams.slice(0, -1)) old.emit(kind === 'onboarding' ? onboardingReady : account);
    let tree = panel.render();
    if (kind === 'onboarding') assert.match(visibleText(tree), /准备就绪/);
    else assert.equal(nodes(tree).find((node) => node.props['aria-label'] === '网关地址').props.value, saved.gatewayCredential.baseURL);
    streams.at(-1).emit({ ...saved, principal: 'synthetic-other' });
    tree = panel.render();
    assert.match(visibleText(tree), /synthetic-other/, 'the replacement stream still observes account changes');
  });
}
