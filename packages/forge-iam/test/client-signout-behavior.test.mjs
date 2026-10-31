import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const ready = { state: 'ready', configured: true, signedIn: true, canSignIn: false, canSignOut: true, principal: 'synthetic-user', error: null };
const failed = { state: 'error', configured: true, signedIn: false, canSignIn: true, canSignOut: false, principal: null, error: 'IAM_CREDENTIALS_CLEAR_FAILED' };
const signedOut = { ...failed, state: 'signed-out', error: null };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountPanel(fetch) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const cells = [];
  const effects = [];
  const cleanups = [];
  const timers = new Map();
  const locations = [];
  let cursor = 0;
  let nextTimer = 0;
  let Panel;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) {
      const index = cursor++;
      if (!(index in cells)) { cells[index] = true; effects.push(fn); }
    },
  };
  const window = {
    __ModuleLoader__: { load(definition) {
      const plugin = definition.factory((name) => {
        assert.equal(name, 'react');
        return React;
      });
      plugin.apply({ slots: {
        inject(_name, register) { register(); },
        register(options, component) { if (options.name === 'settings.section') Panel = component; },
      } });
    } },
    location: { assign: (url) => locations.push(url) },
  };
  runInNewContext(source, {
    window, fetch,
    setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  assert.ok(Panel);
  const render = () => { cursor = 0; return Panel(); };
  render();
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  await new Promise(setImmediate);
  const text = (node) => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '';
  const findButton = (node, label) => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'button' && text(node) === label) return node;
    for (const child of node.children ?? []) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return undefined;
  };
  return {
    render, text, findButton, locations,
    tick() { assert.equal(timers.size, 1); return [...timers.values()][0](); },
    close() { for (const cleanup of cleanups) cleanup(); assert.equal(timers.size, 0); },
  };
}

test('a poll during sign-out cannot restore ready or start a duplicate sign-out', async (t) => {
  const post = deferred();
  let posts = 0;
  const panel = await mountPanel(async (url) => {
    if (url === '/api/forge-iam/view') return Response.json({ ...ready, gatewayCredential: { state: 'configured' } });
    assert.equal(url, '/api/forge-iam/sign-out');
    posts++;
    return post.promise;
  });
  t.after(() => { post.resolve(Response.json({ view: failed }, { status: 503 })); panel.close(); });
  let tree = panel.render();
  assert.match(panel.text(tree), /UAG 个人凭证：已配置/);
  const button = panel.findButton(tree, '退出');
  assert.ok(button);
  const first = button.props.onClick();
  await button.props.onClick();
  assert.equal(posts, 1);
  await panel.tick();
  tree = panel.render();
  assert.doesNotMatch(panel.text(tree), /已登录|synthetic-user/);
  assert.match(panel.text(tree), /UAG 个人凭证：状态未知/);
  assert.doesNotMatch(panel.text(tree), /UAG 个人凭证：未配置/);
  assert.equal(panel.findButton(tree, '刷新').props.disabled, true);
  assert.equal(panel.findButton(tree, '保存凭据').props.disabled, true);
  post.resolve(Response.json({ view: failed, error: { code: 'IAM_CREDENTIALS_CLEAR_FAILED' } }, { status: 503 }));
  await first;
  tree = panel.render();
  assert.doesNotMatch(panel.text(tree), /已登录|synthetic-user/);
  assert.match(panel.text(tree), /本地凭据清理失败/);
  assert.equal(panel.text(tree).split('本地凭据清理失败').length - 1, 1);
});

test('an earlier manual refresh cannot overwrite a completed sign-out', async (t) => {
  const oldRead = deferred();
  let reads = 0;
  const panel = await mountPanel(async (url) => {
    if (url === '/api/forge-iam/view') return ++reads === 1 ? Response.json(ready) : oldRead.promise;
    assert.equal(url, '/api/forge-iam/sign-out');
    return Response.json({ view: signedOut, logoutUrl: null, revocation: 'ok' });
  });
  t.after(() => { oldRead.resolve(Response.json(ready)); panel.close(); });
  const tree = panel.render();
  const refresh = panel.findButton(tree, '刷新').props.onClick();
  await panel.findButton(tree, '退出').props.onClick();
  oldRead.resolve(Response.json(ready));
  await refresh;
  assert.doesNotMatch(panel.text(panel.render()), /已登录|synthetic-user/);
});

test('a credential operation begun before sign-out cannot revive the old view', async (t) => {
  const credential = deferred();
  const initial = { ...ready, gatewayCredential: { state: 'configured' } };
  const panel = await mountPanel(async (url, init) => {
    if (url === '/api/forge-iam/view') return Response.json(initial);
    if (url === '/api/forge-iam/credential') { assert.equal(init.method, 'DELETE'); return credential.promise; }
    assert.equal(url, '/api/forge-iam/sign-out');
    return Response.json({ view: signedOut, logoutUrl: null, revocation: 'ok' });
  });
  t.after(() => { credential.resolve(Response.json({ view: initial })); panel.close(); });
  const tree = panel.render();
  const clearing = panel.findButton(tree, '清除凭据').props.onClick();
  await panel.findButton(tree, '退出').props.onClick();
  credential.resolve(Response.json({ view: initial }));
  await clearing;
  assert.doesNotMatch(panel.text(panel.render()), /已登录|synthetic-user/);
});

test('a sign-in response begun before sign-out cannot revive an old attempt', async (t) => {
  const login = deferred();
  const initial = { ...ready, state: 'expired', canSignIn: true };
  const panel = await mountPanel(async (url) => {
    if (url === '/api/forge-iam/view') return Response.json(initial);
    if (url === '/api/forge-iam/sign-in') return login.promise;
    assert.equal(url, '/api/forge-iam/sign-out');
    return Response.json({ view: signedOut, logoutUrl: null, revocation: 'ok' });
  });
  t.after(() => { login.resolve(Response.json({ view: initial })); panel.close(); });
  const tree = panel.render();
  const signingIn = panel.findButton(tree, '登录企业账号').props.onClick();
  await panel.findButton(tree, '退出').props.onClick();
  login.resolve(Response.json({ view: { ...initial, state: 'authenticating' }, authorizationUrl: 'https://iam.example/authorize' }));
  await signingIn;
  const text = panel.text(panel.render());
  assert.doesNotMatch(text, /等待浏览器登录|synthetic-user|浏览器未打开/);
});

test('a failed remote revocation remains visible after local sign-out', async (t) => {
  const panel = await mountPanel(async (url) => {
    if (url === '/api/forge-iam/view') return Response.json(ready);
    return Response.json({ view: { ...signedOut, error: 'IAM_REVOCATION_FAILED' }, revocation: 'failed', logoutUrl: null });
  });
  t.after(() => panel.close());
  await panel.findButton(panel.render(), '退出').props.onClick();
  const text = panel.text(panel.render());
  assert.match(text, /本地已退出，但服务端撤销未确认/);
  assert.equal(text.split('本地已退出，但服务端撤销未确认').length - 1, 1);
  assert.doesNotMatch(text, /synthetic-user/);
});

for (const outcome of ['503', '503-no-view', '403', 'network', 'success']) {
  test(`sign-out ${outcome} never allows an older poll to revive the prior view`, async (t) => {
    const poll = deferred();
    let reads = 0;
    const panel = await mountPanel(async (url, init) => {
      if (url === '/api/forge-iam/view') {
        if (++reads === 1) return Response.json(ready);
        return poll.promise;
      }
      assert.equal(url, '/api/forge-iam/sign-out');
      assert.equal(init.method, 'POST');
      if (outcome === 'network') throw new Error('synthetic network failure');
      if (outcome === '503') return Response.json({ view: failed, revocation: 'unknown', error: { code: 'IAM_CREDENTIALS_CLEAR_FAILED' } }, { status: 503 });
      if (outcome === '503-no-view') return Response.json({ error: { code: 'IAM_CREDENTIALS_CLEAR_FAILED' } }, { status: 503 });
      if (outcome === '403') return Response.json({ error: { code: 'IAM_UNAUTHENTICATED' } }, { status: 403 });
      return Response.json({ view: signedOut, logoutUrl: null, revocation: 'ok' });
    });
    t.after(() => { poll.resolve(Response.json(ready)); panel.close(); });
    let tree = panel.render();
    assert.match(panel.text(tree), /已登录/);
    assert.match(panel.text(tree), /synthetic-user/);
    const inFlight = panel.tick();
    const button = panel.findButton(tree, '退出');
    assert.ok(button);
    await button.props.onClick();
    tree = panel.render();
    assert.doesNotMatch(panel.text(tree), /已登录|synthetic-user/);
    assert.equal(panel.findButton(tree, '退出'), undefined);
    if (outcome === '503') assert.match(panel.text(tree), /本地凭据清理失败/);
    if (outcome === 'network') assert.match(panel.text(tree), /Host 不可达/);
    assert.equal(panel.locations.length, 0);
    poll.resolve(Response.json(ready));
    await inFlight;
    tree = panel.render();
    assert.doesNotMatch(panel.text(tree), /已登录|synthetic-user/);
    assert.equal(panel.findButton(tree, '退出'), undefined);
  });
}
