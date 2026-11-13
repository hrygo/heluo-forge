import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');

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
  };

  const exports = loaded.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require(${id})`);
  });
  return { id: loaded.id, exports };
}

function applyToFakeClient(exports, overrides = {}) {
  const registered = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: () => (k) => k,
      register: () => () => {},
    },
    slots: {
      inject: (slot, cb) => {
        cb();
        return () => {};
      },
      register: (meta, component) => {
        registered.push({ meta, component });
        return () => {};
      },
    },
    effect: (fn, label) => {
      effects.push(label);
      fn();
    },
    ...overrides,
  };
  exports.apply(ctx);
  return { registered, effects };
}

const read = (relative) => readFileSync(join(PKG_ROOT, relative), 'utf8');

test('bundle manifest points its patch at the universal base layer', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(manifest.files.includes('cordis.patch.engineering.yml'));
  assert.equal(manifest.files.includes('cordis.patch.base.yml'), false);
});

test('cordis.patch.yml is the universal base: official rows disabled, no R&D member, no container row', () => {
  const base = read('cordis.patch.yml');
  assert.match(base, /id: heluo-credentials-keychain/);
  assert.match(base, /id: heluo-policy/);
  assert.match(base, /id: heluo-iam/);
  assert.match(base, /id: deepseek-account[\s\S]*disabled: true/);
  assert.doesNotMatch(base, /forge-devops/);
  assert.doesNotMatch(base, /heluo-gitee/);
  assert.doesNotMatch(base, /heluo-issue-delivery-skill/);
  // The container activates only through the engineering row; a base row would
  // register the section for every general-purpose user.
  assert.doesNotMatch(base, /heluo-engineering-ui/);
});

test('cordis.patch.engineering.yml adds the R&D members and the container row only', () => {
  const engineering = read('cordis.patch.engineering.yml');
  assert.match(engineering, /id: heluo-engineering-ui[\s\S]*name: '@heluo\/forge-enterprise'/);
  assert.match(engineering, /id: heluo-issue-delivery-skill/);
  assert.match(engineering, /id: forge-devops/);
  assert.match(engineering, /id: heluo-gitee/);
  assert.doesNotMatch(engineering, /heluo-policy/);
  assert.doesNotMatch(engineering, /heluo-iam/);
  assert.doesNotMatch(engineering, /disabled: true/);
});

test('the base policy catalog stays byte-identical to the coexist bundles', () => {
  const catalogOf = (text) => {
    const match = text.match(/catalog:\n([\s\S]*?)\n\s+audit:/);
    assert.ok(match, 'missing policy catalog');
    return match[1].trim();
  };
  const base = catalogOf(read('cordis.patch.yml'));
  const devops = catalogOf(readFileSync(join(REPO_ROOT, 'packages', 'forge-devops', 'cordis.patch.yml'), 'utf8'));
  const gitee = catalogOf(readFileSync(join(REPO_ROOT, 'packages', 'forge-gitee', 'cordis.patch.yml'), 'utf8'));
  assert.equal(base, devops);
  assert.equal(base, gitee);
});

test('client.js registers the section with a declared child slot, an icon, and no host-side leakage', () => {
  const raw = read('client.js');
  assert.doesNotMatch(raw, /^\s*import\s+.*src\//m);
  assert.doesNotMatch(raw, /DEEPSEEK_API_KEY|DEVOPS_API_KEY|GITEE_TOKEN|dangerouslySetInnerHTML|innerHTML/);

  const { id, exports } = loadClientModule();
  assert.equal(id, '@heluo/forge-enterprise');
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(exports.SECTION_ID, 'forge-engineering');
  assert.equal(exports.SECTION_ORDER, 30);
  assert.equal(exports.ENGINEERING_TAB_SLOT, 'heluo.engineering.tab');
  assert.equal(exports.ICON_SLOT, 'settings.section.icon');

  const { registered, effects } = applyToFakeClient(exports);
  assert.deepEqual(registered.map((entry) => entry.meta.name), ['settings.section', 'settings.section.icon']);

  const [section, icon] = registered;
  assert.equal(section.meta.id, 'forge-engineering');
  assert.equal(section.meta.order, 30);
  // Child slots are declared in `children`; a `slots` array is factory-only and
  // would leave the slot undeclared, so devops/gitee tabs could never mount.
  assert.deepEqual(section.meta.children, { 'heluo.engineering.tab': { kind: 'list', scope: 'root' } });
  assert.equal('slots' in section.meta, false);
  assert.equal('icon' in section.meta, false);
  assert.equal(icon.meta.id, 'forge-engineering');

  assert.deepEqual(effects, [
    'forge-enterprise: copy',
    'forge-enterprise: engineering section',
    'forge-enterprise: engineering icon',
  ]);
});

test('the section renders the child slot through the props face and keeps diagnostics collapsed', () => {
  const { exports } = loadClientModule();

  // 宿主 renderSlot 返回 `<SlotOutlet>` 元素（不是条目数组），空集走 opts.fallback。
  const outlet = (entries) => ({ needsRender: true, props: { entries } });
  const tree = exports.EngineeringSection({
    t: (key) => key,
    renderSlot: (slot, owner, opts = {}) => {
      assert.equal(slot, 'heluo.engineering.tab');
      assert.deepEqual(owner, {});
      assert.equal(typeof opts.fallback, 'object', '空态必须经 fallback 传入');
      return outlet([{ id: 'devops' }]);
    },
  });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /"needsRender":true/, '子槽位元素必须原样渲染，不再自绘容器');
  assert.match(serialized, /"id":"devops"/);
  assert.match(serialized, /diagSummary/);
  assert.match(serialized, /"type":"details"/);

  const empty = exports.EngineeringSection({
    t: (key) => key,
    renderSlot: (_slot, _owner, opts = {}) => opts.fallback,
  });
  assert.match(JSON.stringify(empty), /heluo-engineering-empty/);
  assert.doesNotMatch(JSON.stringify(empty), /heluo-engineering-tabs/);

  // No props face at all must not throw: the section still renders its chrome.
  const bare = exports.EngineeringSection({ t: (key) => key });
  assert.match(JSON.stringify(bare), /heluo-engineering-empty/);
});

test('the navigation icon is a sized vector that follows the active state', () => {
  const { exports } = loadClientModule();
  const idle = exports.EngineeringIcon({ size: 16, active: false });
  const active = exports.EngineeringIcon({ size: 22, active: true });
  assert.equal(idle.type, 'svg');
  assert.equal(idle.props.width, 16);
  assert.equal(active.props.width, 22);
  assert.equal(active.props.strokeWidth, 1.9);
  assert.notEqual(idle.props.strokeWidth, active.props.strokeWidth);
  assert.equal(idle.props['aria-hidden'], 'true');
});