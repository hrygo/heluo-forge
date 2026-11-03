import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

const signedOut = { state: 'signed-out', configured: true, signedIn: false, canSignIn: true, canSignOut: true, error: null, missing: [], exclusive: 'ok' };
const authenticating = { ...signedOut, state: 'authenticating', canSignIn: false };
const url = 'https://iam.corp.example/authorize?state=synthetic-private-state&code_challenge=synthetic-challenge';
const secret = 'synthetic-private-do-not-export';
const deferred = () => Promise.withResolvers();
const settle = () => new Promise(setImmediate);
const nodes = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];

async function fixture(t, { view = signedOut, navigator, fetchView, write = async () => {}, loginView = authenticating } = {}) {
  const requests = [];
  const writes = [];
  const panel = await mountPanel(async (path) => {
    requests.push(path);
    if (path === '/api/forge-iam/view') return fetchView ? fetchView() : Response.json(view);
    if (path === '/api/forge-iam/sign-in') return Response.json({ view: loginView, authorizationUrl: url });
    if (path === '/api/forge-iam/cancel' || path === '/api/forge-iam/sign-out') return Response.json({ view: signedOut });
    throw new Error('unexpected synthetic request');
  }, { navigator: navigator ?? { clipboard: { writeText: (text) => { writes.push(text); return write(text); } } } });
  t.after(() => panel.close());
  const button = (name) => { const b = panel.findButton(panel.render(), name); assert.ok(b, `missing ${name}`); return b; };
  return { ...panel, panel, writes, requests, button, login: () => button('登录企业账号').props.onClick() };
}

test('link copy is an explicit button action and writes the exact saved URL once without HTTP', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.writes, []);
  assert.equal(f.panel.findButton(f.render(), '复制登录链接'), undefined);
  await f.login();
  const b = f.button('复制登录链接');
  assert.equal(b.props.type, 'button');
  const before = f.requests.length;
  await b.props.onClick();
  assert.deepEqual(f.writes, [url]);
  assert.equal(f.requests.length, before);
  assert.match(f.text(f.render()), /链接已复制/);
  assert.match(f.text(f.render()), /请勿转发/);
});

test('diagnostic is a fixed scalar projection and excludes all private fields and input drafts', async (t) => {
  const f = await fixture(t, { view: { ...signedOut, state: 'error', error: 'IAM_GRANT_CONTEXT_MISMATCH',
    principal: secret, issuer: secret, clientId: secret, resource: secret, accessExpiresAt: secret,
    authorizationUrl: secret, accessToken: secret, refreshToken: secret, idToken: secret,
    gatewayConsoleUrl: secret, missing: [secret, secret], gatewayCredential: { state: 'configured', deviceLabel: secret, ownerSubject: secret, storage: secret }, extra: secret } });
  const input = nodes(f.render()).find((node) => node.props['aria-label'] === 'UAG 个人凭证');
  input.props.onChange({ target: { value: secret } });
  const before = f.requests.length;
  assert.equal(f.button('复制脱敏诊断').props.type, 'button');
  await f.button('复制脱敏诊断').props.onClick();
  assert.equal(f.requests.length, before);
  assert.equal(f.writes.length, 1);
  assert.doesNotMatch(f.writes[0], /synthetic-private|https:|principal|accessToken|deviceLabel|authorizationUrl/);
  assert.deepEqual(JSON.parse(f.writes[0]), { format: 'forge-iam-diagnostic', version: 1, pagePhase: 'ready', iamState: 'error', configured: true, signedIn: false, exclusive: 'ok', gatewayState: 'configured', errorCode: 'IAM_GRANT_CONTEXT_MISMATCH', missingConfigCount: 2 });
  assert.match(f.text(f.render()), /页面快照/);
  assert.ok(nodes(f.render()).some((node) => node.props.role === 'status'));
});

for (const phase of ['loading', 'error']) {
  test(`${phase} can copy an honest unknown diagnostic without a new request`, async (t) => {
    const gate = deferred();
    const f = await fixture(t, { fetchView: () => phase === 'loading' ? gate.promise : Promise.reject(new Error(secret)) });
    await f.button('复制脱敏诊断').props.onClick();
    const data = JSON.parse(f.writes[0]);
    assert.equal(data.pagePhase, phase);
    assert.equal(data.iamState, 'unknown');
    assert.equal(data.configured, null);
    assert.equal(data.signedIn, null);
    assert.doesNotMatch(f.writes[0], /synthetic-private/);
    assert.equal(f.requests.length, 1);
    if (phase === 'loading') { gate.resolve(Response.json(signedOut)); await settle(); }
  });
}

test('unexpected strings and non-boolean values do not escape diagnostic enums', async (t) => {
  const f = await fixture(t, { view: { ...signedOut, state: 'toString', configured: secret, signedIn: 1, exclusive: {}, error: `IAM_${secret}`, missing: secret, gatewayCredential: { state: '__proto__' } } });
  await f.button('复制脱敏诊断').props.onClick();
  const data = JSON.parse(f.writes[0]);
  assert.equal(data.iamState, 'unknown');
  assert.equal(data.gatewayState, 'unknown');
  assert.equal(data.errorCode, 'unknown');
  assert.equal(data.exclusive, 'unknown');
  assert.equal(data.configured, null);
  assert.equal(data.signedIn, null);
  assert.equal(data.missingConfigCount, null);
  assert.doesNotMatch(f.writes[0], /synthetic-private|toString|__proto__/);
});

for (const failure of ['missing', 'throw', 'reject', 'unconfirmed']) {
  test(`clipboard ${failure} is generic, keeps the link and does not retry`, async (t) => {
    const f = await fixture(t, { navigator: failure === 'missing' ? {} : undefined, write: () => {
      if (failure === 'throw') throw new Error(secret);
      if (failure === 'reject') return Promise.reject(new Error(secret));
      return undefined;
    } });
    await f.login();
    const before = f.requests.length;
    await f.button('复制登录链接').props.onClick();
    await settle();
    assert.match(f.text(f.render()), /未确认复制/);
    assert.doesNotMatch(f.text(f.render()), /synthetic-private-do-not-export|链接已复制/);
    assert.ok(nodes(f.render()).some((node) => node.type === 'a' && node.props.href === url));
    assert.equal(f.writes.length, failure === 'missing' ? 0 : 1);
    assert.equal(f.requests.length, before);
  });
}

test('pending copy synchronously rejects duplicate handlers without blocking sign-out', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { write: () => gate.promise });
  await f.login();
  const b = f.button('复制登录链接');
  const pending = b.props.onClick();
  await b.props.onClick();
  await f.button('复制脱敏诊断').props.onClick();
  assert.equal(f.writes.length, 1);
  assert.equal(f.button('复制登录链接').props.disabled, true);
  await f.button('退出').props.onClick();
  gate.resolve(); await pending;
  assert.doesNotMatch(f.text(f.render()), /已复制/);
});

for (const action of ['退出', '取消登录', 'unmount']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`late ${outcome} after ${action} cannot publish a clipboard notice`, async (t) => {
      const gate = deferred();
      const f = await fixture(t, { write: () => gate.promise });
      await f.login();
      const pending = f.button('复制登录链接').props.onClick();
      if (action === 'unmount') f.close();
      else await f.button(action).props.onClick();
      gate[outcome](outcome === 'reject' ? new Error(secret) : undefined);
      await pending;
      assert.doesNotMatch(f.text(f.render()), /已复制|未确认复制/);
      assert.equal(f.panel.lateUpdates, 0);
    });
  }
}

test('poll invalidates a link before render, suppresses its late acknowledgement and stale handler', async (t) => {
  const gate = deferred(); let current = signedOut;
  const f = await fixture(t, { fetchView: async () => Response.json(current), write: () => gate.promise });
  await f.login(); current = authenticating;
  const old = f.button('复制登录链接');
  const pending = old.props.onClick();
  current = signedOut;
  await f.tick(); // Deliberately no render before the browser completes.
  gate.resolve(); await pending;
  await old.props.onClick();
  assert.equal(f.writes.length, 1);
  assert.doesNotMatch(f.text(f.render()), /链接已复制|未确认复制/);
  assert.equal(f.panel.findButton(f.render(), '复制登录链接'), undefined);
});

test('new explicit login invalidates an older diagnostic acknowledgement', async (t) => {
  const gate = deferred(); const f = await fixture(t, { write: () => gate.promise });
  const pending = f.button('复制脱敏诊断').props.onClick();
  await f.login(); gate.resolve(); await pending;
  assert.doesNotMatch(f.text(f.render()), /诊断已复制/);
});

test('local gateway recording does not claim live model integration', async (t) => {
  const f = await fixture(t, { view: { ...signedOut, gatewayCredential: { state: 'configured' } } });
  assert.match(f.text(f.render()), /保存状态不证明模型调用已接通/);
  assert.doesNotMatch(f.text(f.render()), /模型调用使用该凭据|Key 不会进入 UI/);
});

test('a URL returned with a non-authenticating view is not offered for copy', async (t) => {
  const f = await fixture(t, { loginView: signedOut });
  await f.login();
  assert.equal(f.panel.findButton(f.render(), '复制登录链接'), undefined);
  assert.deepEqual(f.writes, []);
});

test('clipboard accessor failures do not escape private exception contents', async (t) => {
  const navigator = { get clipboard() { throw new Error(secret); } };
  const f = await fixture(t, { navigator });
  await f.button('复制脱敏诊断').props.onClick();
  assert.match(f.text(f.render()), /未确认复制/);
  assert.doesNotMatch(f.text(f.render()), /synthetic-private/);
  assert.deepEqual(f.writes, []);
});

for (const outcome of ['success', 'failure']) {
  test(`manual refresh ${outcome} invalidates a pending link copy before render`, async (t) => {
    let reads = 0; const gate = deferred();
    const f = await fixture(t, { write: () => gate.promise, fetchView: async () => {
      if (++reads === 1 || outcome === 'success') return Response.json(signedOut);
      return Response.json({ error: { code: 'IAM_VIEW_FAILED' } }, { status: 503 });
    } });
    await f.login();
    const old = f.button('复制登录链接');
    const pending = old.props.onClick();
    await f.button('刷新').props.onClick();
    gate.resolve(); await pending;
    await old.props.onClick();
    assert.equal(f.writes.length, 1);
    assert.doesNotMatch(f.text(f.render()), /已复制|未确认复制/);
  });
}

test('only an explicit second click retries after a browser rejection', async (t) => {
  let calls = 0;
  const f = await fixture(t, { write: () => ++calls === 1 ? Promise.reject(new Error(secret)) : Promise.resolve() });
  await f.button('复制脱敏诊断').props.onClick();
  await settle();
  assert.equal(calls, 1);
  assert.match(f.text(f.render()), /未确认复制/);
  await f.button('复制脱敏诊断').props.onClick();
  assert.equal(calls, 2);
  assert.match(f.text(f.render()), /诊断已复制/);
});

test('native clipboard receiver is retained and clipboard is never read', async (t) => {
  const values = [];
  const clipboard = {
    readText() { throw new Error('clipboard must not be read'); },
    writeText(text) { assert.equal(this, clipboard); values.push(text); return Promise.resolve(); },
  };
  const f = await fixture(t, { navigator: { clipboard } });
  await f.button('复制脱敏诊断').props.onClick();
  assert.equal(values.length, 1);
  assert.equal(JSON.parse(values[0]).format, 'forge-iam-diagnostic');
});

test('an arbitrary exclusive reason is reduced to a constant, not exported', async (t) => {
  const f = await fixture(t, { view: { ...signedOut, exclusive: secret } });
  await f.button('复制脱敏诊断').props.onClick();
  assert.equal(JSON.parse(f.writes[0]).exclusive, 'not-ok');
  assert.doesNotMatch(f.writes[0], /synthetic-private/);
});
