import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadClientModule() {
  const code = readFileSync(join(PKG_ROOT, 'client.js'), 'utf8');
  let loaded = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec;
      },
    },
  };
  const fn = new Function('window', code);
  fn(fakeWindow);
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js must call window.__ModuleLoader__.load');

  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(init) {
      const val = typeof init === 'function' ? init() : init;
      return [val, () => {}];
    },
    useEffect() {},
  };

  const exports = loaded.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require(${id})`);
  });
  return { id: loaded.id, exports };
}

test('cordis.patch.base.yml 仅含通用企业底座且不含任何研发域成员', () => {
  const base = readFileSync(join(PKG_ROOT, 'cordis.patch.base.yml'), 'utf8');
  assert.match(base, /id: heluo-credentials-keychain/);
  assert.match(base, /id: heluo-policy/);
  assert.match(base, /id: heluo-iam/);
  assert.match(base, /id: deepseek-account[\s\S]*disabled: true/);
  assert.doesNotMatch(base, /forge-devops/);
  assert.doesNotMatch(base, /heluo-gitee/);
  assert.doesNotMatch(base, /heluo-issue-delivery-skill/);
});

test('cordis.patch.engineering.yml 仅含研发叠加成员且不重复声明策略或 IAM', () => {
  const eng = readFileSync(join(PKG_ROOT, 'cordis.patch.engineering.yml'), 'utf8');
  assert.match(eng, /id: heluo-issue-delivery-skill/);
  assert.match(eng, /id: forge-devops/);
  assert.match(eng, /id: heluo-gitee/);
  assert.doesNotMatch(eng, /heluo-policy/);
  assert.doesNotMatch(eng, /heluo-iam/);
});

test('cordis.patch.base.yml 与 cordis.patch.yml 的 heluo-policy 六条目录逐字一致', () => {
  const extractCatalog = (yml) => {
    const match = yml.match(/catalog:\n([\s\S]*?)\n\s+audit:/);
    assert.ok(match, 'missing policy catalog');
    return match[1].trim();
  };
  const base = readFileSync(join(PKG_ROOT, 'cordis.patch.base.yml'), 'utf8');
  const full = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.equal(extractCatalog(base), extractCatalog(full));
});

test('client.js 注册 forge-engineering (order 30) 与 heluo.engineering.tab 且无 src import 或密钥字符串', () => {
  const raw = readFileSync(join(PKG_ROOT, 'client.js'), 'utf8');
  assert.doesNotMatch(raw, /^\s*import\s+.*src\//m);
  assert.doesNotMatch(raw, /DEEPSEEK_API_KEY|DEVOPS_API_KEY|GITEE_TOKEN|dangerouslySetInnerHTML|innerHTML/);

  const { id, exports } = loadClientModule();
  assert.equal(id, '@heluo/forge-enterprise');
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(exports.SECTION_ID, 'forge-engineering');
  assert.equal(exports.SECTION_ORDER, 30);
  assert.equal(exports.ENGINEERING_TAB_SLOT, 'heluo.engineering.tab');

  const registered = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: () => (k) => k,
      register: () => () => {},
    },
    slots: {
      inject: (_slot, cb) => cb(),
      register: (meta, component) => {
        registered.push({ meta, component });
        return () => {};
      },
    },
    effect: (fn, label) => {
      effects.push(label);
      fn();
    },
  };

  exports.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].meta.name, 'settings.section');
  assert.equal(registered[0].meta.id, 'forge-engineering');
  assert.equal(registered[0].meta.order, 30);
  assert.deepEqual(registered[0].meta.slots, ['heluo.engineering.tab']);

  const tree = exports.EngineeringSection({ t: (k) => k });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /diagSummary/);
});
