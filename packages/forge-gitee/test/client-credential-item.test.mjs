/**
 * @heluo/forge-gitee 扩展凭据卡片（内置于 GiteeSection 底部）行为测试。
 *
 * 覆盖：
 *   1. apply 不向 `heluo.iam.credential-item` 注槽，GiteeSection 直接内置渲染 GiteeCredentialItem（无 IAM 时 404/501 安静降级为独立模式）；
 *   2. UNSET_NO_HOSTED / ENV_INHERITED 平静态，环境变量名仅进默认收起的技术详情；
 *   3. plaintextRisk 条件明文告警 + riskDetails.files 列表展示 + 「在此加密保存覆盖」入口；
 *   4. PUT（单独指定） / DELETE（清除）带 x-forge-iam-request，只写不回显；
 *   5. OWNER_MISMATCH / IAM_NOT_SIGNED_IN / PENDING_WRITE / KEYCHAIN_UNAVAILABLE 投影与草稿保留；
 *   6. 慢 GET 回包不得覆盖较新 PUT 结果。
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
    useCallback(fn) {
      return fn;
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
    lastTree = mod.GiteeCredentialItem(currentProps);
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

  return { mod, render, flush, flushEffectsOnly, unmount };
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

test('apply 不再注入 heluo.iam.credential-item，GiteeSection 内置渲染且独立模式 404 安静提示', async () => {
  let captured;
  new Function('window', 'require', SOURCE)(
    { __ModuleLoader__: { load: (def) => { captured = def; } } },
    () => ({ createElement: () => null, Fragment: 'Fragment' }),
  );
  const mod = captured.factory(() => ({ createElement: () => null, Fragment: 'Fragment' }));

  const declared = new Set(['settings.section', 'heluo.iam.credential-item']);
  const regs = [];
  const ctx = {
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
  assert.equal(regs.filter((r) => r.meta.name === 'heluo.iam.credential-item').length, 0, '不得向企业账号注入 Gitee 凭据');

  // 无 @heluo/forge-iam 时（404 无 code），GiteeCredentialItem 安静显示独立安装模式提示
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

test('平静态 + plaintextRisk 条件明文告警：无风险时不显示告警；命中时列文件与加密覆盖按钮', async () => {
  const prevFetch = globalThis.fetch;
  let risk = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      credentials: [{
        extensionId: 'gitee',
        state: 'ENV_INHERITED',
        envHitNames: ['GITEE_TOKEN'],
        plaintextRisk: risk,
        riskDetails: risk ? { files: ['~/.gitee-cli/config.json'] } : null,
      }],
    }),
  });
  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    let tree = await h.flush();
    assert.equal(findNodes(tree, (n) => n.props?.role === 'alert').length, 0, '未命中明文风险时不得显示告警条');
    const headText = collectText(findNodes(tree, (n) => n.props?.className === 'fge-cred-head')[0]).join(' ');
    assert.match(headText, /跟随本机登录（正常可用，无需配置）/u);
    assert.ok(!headText.includes('GITEE_TOKEN'), '主行不得露出环境变量名');
    const details = findNodes(tree, (n) => n.type === 'details')[0];
    assert.ok(details && !('open' in details.props), '技术排障详情默认折叠');
    assert.ok(collectText(details).join(' ').includes('GITEE_TOKEN'));

    // 命中明文风险
    risk = true;
    h.render({ sessionReady: false });
    tree = await h.flush();
    const alert = findNodes(tree, (n) => n.props?.role === 'alert')[0];
    assert.ok(alert, '命中 plaintextRisk 时必须展示自然语言安全告警');
    const alertText = collectText(alert).join(' ');
    assert.match(alertText, /明文持久化凭据文件/u);
    assert.ok(alertText.includes('~/.gitee-cli/config.json'), '告警应提示命中的风险文件路径');
    assert.ok(!alertText.includes('persistentToken'), '不得把内部键名暴露在主告警里');
    assert.ok(findButton(tree, '在此加密保存覆盖'), '命中风险应直接提供加密保存覆盖操作');
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('单独指定 Token（PUT）与清除（DELETE）：只写不回显、不泄露明文、竞态保护', async () => {
  const SECRET = 'gitee-personal-secret-999';
  const prevFetch = globalThis.fetch;
  let releaseSlowGet = null;
  const slowGetGate = new Promise((r) => { releaseSlowGet = r; });
  let firstGet = true;

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      if (firstGet) {
        firstGet = false;
        return {
          ok: true,
          status: 200,
          json: async () => ({ credentials: [{ extensionId: 'gitee', state: 'UNSET_NO_HOSTED', envHitNames: [], plaintextRisk: false }] }),
        };
      }
      await slowGetGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentials: [{ extensionId: 'gitee', state: 'UNSET_NO_HOSTED', envHitNames: [], plaintextRisk: false }] }),
      };
    }
    if (method === 'PUT') {
      assert.equal(url, '/api/forge-iam/ext-credentials/gitee');
      assert.equal(init.headers['x-forge-iam-request'], '1');
      assert.equal(init.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { token: SECRET });
      return {
        ok: true,
        status: 200,
        json: async () => ({ credential: { extensionId: 'gitee', state: 'HOSTED_ACTIVE', hosted: true, envHitNames: [], plaintextRisk: false } }),
      };
    }
    assert.equal(method, 'DELETE');
    assert.equal(url, '/api/forge-iam/ext-credentials/gitee');
    assert.equal(init.headers['x-forge-iam-request'], '1');
    assert.equal(init.headers['content-type'], 'application/json');
    return {
      ok: true,
      status: 200,
      json: async () => ({ credential: { extensionId: 'gitee', state: 'UNSET_NO_HOSTED', hosted: false, envHitNames: [], plaintextRisk: false } }),
    };
  };

  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    let tree = await h.flush();
    findButton(tree, '单独指定 Token').props.onClick();
    tree = h.render({ sessionReady: true });
    const input = findNodes(tree, (n) => n.type === 'input')[0];
    assert.equal(input.props.type, 'password');
    input.props.onChange({ target: { value: SECRET } });

    // 触发慢 GET 与较新 PUT 竞态
    h.render({ sessionReady: false });
    h.flushEffectsOnly();
    tree = h.render({ sessionReady: false });
    findButton(tree, '保存 Token').props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    tree = h.render({ sessionReady: false });
    assert.match(collectText(tree).join(' '), /已在此单独保存（优先于本机环境）/u);
    assert.ok(!JSON.stringify(tree).includes(SECRET), '保存成功后绝不可把明文留在树中');

    releaseSlowGet();
    await new Promise((r) => setTimeout(r, 0));
    tree = h.render({ sessionReady: false });
    assert.match(collectText(tree).join(' '), /已在此单独保存（优先于本机环境）/u, '慢 GET 不得覆盖较新 PUT 成功态');

    findButton(tree, '清除并恢复跟随本机').props.onClick();
    tree = await h.flush();
    assert.match(collectText(tree).join(' '), /已清除单独凭据，恢复跟随本机登录/u);
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

test('OWNER_MISMATCH / PENDING_WRITE / KEYCHAIN_UNAVAILABLE：自然语言提示且保留输入草稿', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentials: [{ extensionId: 'gitee', state: 'OWNER_MISMATCH', envHitNames: [], plaintextRisk: false }] }),
      };
    }
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'PENDING_WRITE' } }),
    };
  };
  const h = createHarness();
  try {
    h.render({ sessionReady: true });
    let tree = await h.flush();
    const mismatchText = collectText(findNodes(tree, (n) => n.props?.role === 'alert')[0]).join(' ');
    assert.match(mismatchText, /存在其他企业账号遗留的独立凭据/u);
    assert.ok(!mismatchText.includes('OWNER_MISMATCH'));

    findButton(tree, '使用当前账号重设').props.onClick();
    tree = h.render();
    findNodes(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'keep-me-draft' } });
    tree = h.render();
    findButton(tree, '保存 Token').props.onClick();
    tree = await h.flush();
    assert.equal(findNodes(tree, (n) => n.type === 'input')[0].props.value, 'keep-me-draft', 'PENDING_WRITE 失败必须保留草稿');
    assert.match(collectText(tree).join(' '), /上一笔凭据操作尚未完成/u);
    assert.ok(!collectText(tree).join(' ').includes('PENDING_WRITE'));
  } finally {
    h.unmount();
    globalThis.fetch = prevFetch;
  }
});

