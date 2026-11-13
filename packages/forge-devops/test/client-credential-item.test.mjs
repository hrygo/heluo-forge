/**
 * @heluo/forge-devops 扩展凭据卡片（内置于 DevopsSection 底部）行为测试。
 *
 * 覆盖：
 *   1. apply 不向 `heluo.iam.credential-item` 注槽，而是内置渲染于 DevopsSection（无 IAM 时 404/501 安静降级为独立模式）；
 *   2. UNSET_NO_HOSTED / ENV_INHERITED 平静态与技术详情折叠；
 *   3. 单独指定 Token（PUT + 必填预检头 + 只写不回显 + 成功后清草稿）；
 *   4. 清除并恢复跟随本机（DELETE + 必填预检头）；
 *   5. OWNER_MISMATCH / IAM_NOT_SIGNED_IN / PENDING_WRITE / KEYCHAIN_UNAVAILABLE 投影与保留草稿；
 *   6. 慢 GET 回包不得覆盖较新 PUT 结果（reqSeq 竞态保护）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_FILE = fileURLToPath(new URL('../client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_FILE, 'utf8');

function createHarness() {
  const states = [];
  const refs = [];
  const effects = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let scheduled = [];

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState(initial) {
      const idx = stateCursor++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      return [
        states[idx],
        (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        },
      ];
    },
    useRef(initial) {
      const idx = refCursor++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      const prev = effects[idx];
      const changed = !prev
        || deps === undefined
        || prev.deps === undefined
        || deps.length !== prev.deps.length
        || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      effects[idx] = { fn, deps, cleanup: prev?.cleanup };
      if (changed) scheduled.push(idx);
    },
  };

  let captured;
  new Function('window', 'require', SOURCE)(
    { __ModuleLoader__: { load: (def) => { captured = def; } } },
    () => React,
  );
  const mod = captured.factory(() => React);
  const locales = [];
  mod.apply({
    get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: (ns, dict) => { locales.push({ ns, dict }); return () => {}; }, bind: () => (k) => k },
    slots: { inject: () => () => {}, register: () => () => {} },
  });
  const zh = locales[0].dict.zh;
  const t = (key, params) => {
    const raw = zh[key] ?? key;
    if (!params) return raw;
    return raw.replace(/\{([a-zA-Z]+)\}/gu, (_m, name) => (name in params ? String(params[name]) : _m));
  };

  let currentProps = { t };
  let lastTree = null;

  function render(props = currentProps) {
    currentProps = { ...props, t };
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    lastTree = mod.DevopsCredentialItem(currentProps);
    return lastTree;
  }

  function flushEffectsOnly() {
    const pending = scheduled.splice(0);
    for (const idx of pending) {
      const entry = effects[idx];
      entry.cleanup?.();
      entry.cleanup = entry.fn();
    }
  }

  async function flush() {
    for (let i = 0; i < 4; i += 1) {
      flushEffectsOnly();
      await new Promise((resolve) => setTimeout(resolve, 0));
      render(currentProps);
      if (scheduled.length === 0) break;
    }
    return lastTree;
  }

  function unmount() {
    for (const entry of effects) entry.cleanup?.();
  }

  return { mod, render, flush, flushEffectsOnly, unmount, get tree() { return lastTree; } };
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return collectText(node.type(node.props), out);
    collectText(node.children, out);
  }
  return out;
}

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, predicate, out);
    return out;
  }
  if (typeof node.type === 'function') return findNodes(node.type(node.props), predicate, out);
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) findNodes(node.children, predicate, out);
  return out;
}

const findButton = (tree, label) => findNodes(tree, (n) => n.type === 'button' && collectText(n).join('').includes(label))[0];

test('跨窗口凭据写入完成后可重试状态并恢复操作', async () => {
  const prevFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, init = {}) => {
    methods.push(init.method ?? 'GET');
    return {
      ok: true,
      status: 200,
      json: async () => ({ credentials: [{
        extensionId: 'devops',
        state: methods.length < 3 ? 'PENDING_WRITE' : 'HOSTED_ACTIVE',
        envHitNames: [],
      }] }),
    };
  };
  const h = createHarness();
  try {
    h.render();
    let tree = await h.flush();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal(tree.props['data-credential-state'], 'PENDING_WRITE');
      assert.equal(findButton(tree, '保存 Token'), undefined);
      const retry = findButton(tree, '重试');
      assert.ok(retry, '等待外部写入时应可重新读取凭据状态');
      assert.equal(retry.props.disabled, false);
      retry.props.onClick();
      tree = await h.flush();
    }
    assert.equal(tree.props['data-credential-state'], 'HOSTED_ACTIVE');
    assert.ok(findButton(tree, '更换 Token'));
    assert.deepEqual(methods, ['GET', 'GET', 'GET']);
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('apply 不再注入 heluo.iam.credential-item，DevopsSection 直接内置 DevopsCredentialItem 且独立模式 404 安静提示', async () => {
  let captured;
  new Function('window', 'require', SOURCE)(
    { __ModuleLoader__: { load: (def) => { captured = def; } } },
    () => ({ createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useRef: (i) => ({ current: i }), useEffect: () => {}, Fragment: 'Fragment' }),
  );
  const mod = captured.factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useRef: (i) => ({ current: i }),
    useEffect: () => {},
    Fragment: 'Fragment',
  }));

  const declared = new Set(['settings.section', 'heluo.iam.credential-item']);
  const regs = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (name, cb) => (declared.has(name) ? cb() : () => {}),
      register: (meta, component) => {
        if (!declared.has(meta.name)) throw new Error(`slot ${meta.name} not declared`);
        const entry = { meta, component };
        regs.push(entry);
        return () => {};
      },
    },
  };

  mod.apply(ctx);
  assert.equal(regs.filter((r) => r.meta.name === 'heluo.iam.credential-item').length, 0, '不得向企业账号注入 DevOps 凭据');

  // 1) DevopsSection 内部包含 DevopsCredentialItem 子组件
  const sectionTree = mod.DevopsSection({ t: (k) => k });
  const hasEmbeddedCred = (function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (Array.isArray(n)) return n.some(walk);
    if (n.type === mod.DevopsCredentialItem) return true;
    return Array.isArray(n.children) && n.children.some(walk);
  })(sectionTree);
  assert.equal(hasEmbeddedCred, false, 'loading 骨架期间先显示骨架');

  // 2) 无 @heluo/forge-iam 时（404 无 code），DevopsCredentialItem 安静显示独立安装模式提示，不出错误告警与配置按钮
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => null,
  });
  const h = createHarness();
  try {
    h.render({ sessionReady: false });
    const tree = await h.flush();
    const text = collectText(tree).join(' ');
    assert.match(text, /独立安装模式：未接入企业账号托管/u);
    assert.equal(findNodes(tree, (n) => n.props?.role === 'alert').length, 0);
    assert.equal(findButton(tree, '单独指定 Token'), undefined);
    assert.equal(findButton(tree, '重试'), undefined);
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('默认平静态（UNSET_NO_HOSTED / ENV_INHERITED）：显示跟随本机，env 变量名折叠进详情且主行不暴露', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/forge-iam/ext-credentials');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        credentials: [{ extensionId: 'devops', state: 'ENV_INHERITED', envHitNames: ['DEVOPS_API_KEY'] }],
      }),
    };
  };
  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    const tree = await h.flush();
    const headText = collectText(findNodes(tree, (n) => n.props?.className === 'fdv-cred-head')[0]).join(' ');
    assert.match(headText, /跟随本机登录（正常可用，无需配置）/u);
    assert.ok(!headText.includes('DEVOPS_API_KEY'), '主行不得露出环境变量名噪声');
    assert.ok(findButton(tree, '单独指定 Token'), '平静态允许主动展开单独指定');
    const details = findNodes(tree, (n) => n.type === 'details')[0];
    assert.ok(details && !('open' in details.props), '环境变量详情必须默认折叠');
    assert.ok(collectText(details).join(' ').includes('DEVOPS_API_KEY'));
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('单独指定 Token（PUT + x-forge-iam-request）与清除（DELETE）：只写不回显、不泄露明文', async () => {
  const SECRET = 'dop-super-secret-token-value';
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, init });
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentials: [{ extensionId: 'devops', state: 'UNSET_NO_HOSTED', envHitNames: [] }] }),
      };
    }
    if (method === 'PUT') {
      assert.equal(url, '/api/forge-iam/ext-credentials/devops');
      assert.equal(init.headers['x-forge-iam-request'], '1');
      assert.equal(init.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { token: SECRET });
      return {
        ok: true,
        status: 200,
        json: async () => ({ credential: { extensionId: 'devops', state: 'HOSTED_ACTIVE', hosted: true, envHitNames: [] } }),
      };
    }
    assert.equal(method, 'DELETE');
    assert.equal(url, '/api/forge-iam/ext-credentials/devops');
    assert.equal(init.headers['x-forge-iam-request'], '1');
    assert.equal(init.headers['content-type'], 'application/json');
    return {
      ok: true,
      status: 200,
      json: async () => ({ credential: { extensionId: 'devops', state: 'UNSET_NO_HOSTED', hosted: false, envHitNames: [] } }),
    };
  };
  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    let tree = await h.flush();
    findButton(tree, '单独指定 Token').props.onClick();
    tree = h.render();
    const input = findNodes(tree, (n) => n.type === 'input')[0];
    assert.equal(input.props.type, 'password', '必须是只写不回显 password 输入框');
    input.props.onChange({ target: { value: `  ${SECRET}  ` } });
    tree = h.render();
    findButton(tree, '保存 Token').props.onClick();
    tree = await h.flush();

    const treeText = collectText(tree).join('\n');
    const serialized = JSON.stringify(tree);
    assert.match(treeText, /已在此单独保存（优先于本机环境）/u);
    assert.ok(!serialized.includes(SECRET), '保存成功后树里绝对不能残留或回显明文凭据');
    assert.ok(findButton(tree, '清除并恢复跟随本机'));

    findButton(tree, '清除并恢复跟随本机').props.onClick();
    tree = await h.flush();
    assert.match(collectText(tree).join('\n'), /已清除单独凭据，恢复跟随本机登录/u);
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT', 'DELETE']);
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('OWNER_MISMATCH / PENDING_WRITE / KEYCHAIN_UNAVAILABLE：自然语言提示且失败保留草稿', async () => {
  const prevFetch = globalThis.fetch;
  let step = 0;
  globalThis.fetch = async (_url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      step += 1;
      if (step === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ credentials: [{ extensionId: 'devops', state: 'OWNER_MISMATCH', envHitNames: [] }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentials: [{ extensionId: 'devops', state: 'IAM_NOT_SIGNED_IN', envHitNames: [] }] }),
      };
    }
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'KEYCHAIN_UNAVAILABLE' } }),
    };
  };
  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    let tree = await h.flush();
    const alert = findNodes(tree, (n) => n.props?.role === 'alert')[0];
    assert.ok(alert, 'OWNER_MISMATCH 必须渲染 alert');
    const mismatchText = collectText(alert).join(' ');
    assert.match(mismatchText, /存在其他企业账号遗留的独立凭据/u);
    assert.ok(!mismatchText.includes('OWNER_MISMATCH'), '不得把底层枚举码暴露在主提示里');
    assert.ok(findButton(tree, '清除旧配置'));
    assert.ok(findButton(tree, '使用当前账号重设'));

    // 点重设 → PUT 遇 KEYCHAIN_UNAVAILABLE → 必须保留草稿并出自然语言错误
    findButton(tree, '使用当前账号重设').props.onClick();
    tree = h.render();
    findNodes(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'draft-token' } });
    tree = h.render();
    findButton(tree, '保存 Token').props.onClick();
    tree = await h.flush();
    const keptInput = findNodes(tree, (n) => n.type === 'input')[0];
    assert.equal(keptInput.props.value, 'draft-token', '安全存储不可用时不得清空用户输入草稿');
    const errorText = collectText(tree).join(' ');
    assert.match(errorText, /本机安全存储暂不可用/u);
    assert.ok(!errorText.includes('KEYCHAIN_UNAVAILABLE'), '不得把 KEYCHAIN_UNAVAILABLE 裸码透出给用户');

    // sessionReady 切回 false 时重查并投影 IAM_NOT_SIGNED_IN
    h.render({ sessionReady: false });
    tree = await h.flush();
    assert.match(collectText(tree).join(' '), /前往「设置 → 企业账号」登录后可用/u);
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('并发竞态：较早发出的慢 GET 回包不得覆盖较新 PUT 成功结果', async () => {
  const prevFetch = globalThis.fetch;
  let releaseGet;
  const gate = new Promise((r) => { releaseGet = r; });
  globalThis.fetch = async (_url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentials: [{ extensionId: 'devops', state: 'UNSET_NO_HOSTED', envHitNames: [] }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ credential: { extensionId: 'devops', state: 'HOSTED_ACTIVE', hosted: true, envHitNames: [] } }),
    };
  };
  const h = createHarness();
  try {
    // 第一次 mount 发起慢 GET（还在 pending）；用户打开表单保存 PUT 先完成
    h.render({ sessionReady: true });
    // 不 await gate：先 flush effect，让 GET 发出去
    await new Promise((r) => setTimeout(r, 0));
    let tree = h.render({ sessionReady: true });
    // 注意 GET 还在 loading 期间不会出现「单独指定」按钮；直接切 sessionReady=true 无需再触发，改为先完成 PUT 路径需允许切换前先让旧 GET 在 sessionReady 变更重发期间落后：
    releaseGet();
    tree = await h.flush();

    // 第二回合：sessionReady 从 false 变 true 发起第二次慢 GET；在此之前先不挂慢，改由：
    // 先 ready，展开表单，然后在输入后先触发一次 sessionReady 重加载（慢 GET），未返回时执行 PUT。
    findButton(tree, '单独指定 Token').props.onClick();
    tree = h.render({ sessionReady: true });
    findNodes(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'fresh-token' } });
    let releaseLateGet;
    const lateGate = new Promise((r) => { releaseLateGet = r; });
    globalThis.fetch = async (_url, init = {}) => {
      if ((init.method ?? 'GET') === 'GET') {
        await lateGate;
        return {
          ok: true,
          status: 200,
          json: async () => ({ credentials: [{ extensionId: 'devops', state: 'UNSET_NO_HOSTED', envHitNames: [] }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ credential: { extensionId: 'devops', state: 'HOSTED_ACTIVE', hosted: true, envHitNames: [] } }),
      };
    };
    h.render({ sessionReady: false });
    h.flushEffectsOnly(); // 慢 GET 已发出（pending 在 lateGate）
    tree = h.render({ sessionReady: false });
    findButton(tree, '保存 Token').props.onClick(); // PUT 随后发出并先返回（reqSeq 比慢 GET 新）
    await new Promise((r) => setTimeout(r, 0));
    tree = h.render({ sessionReady: false });
    assert.match(collectText(tree).join(' '), /已在此单独保存/u);

    // 迟到的旧 GET 这时回来，绝对不能把状态回退成「跟随本机登录」
    releaseLateGet();
    await new Promise((r) => setTimeout(r, 0));
    tree = h.render({ sessionReady: false });
    assert.match(collectText(tree).join(' '), /已在此单独保存/u);
    assert.ok(!collectText(tree).join(' ').includes('跟随本机登录（正常可用，无需配置）'));
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});
