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

test('bundle manifest points to its standalone patch layer and declares all R&D members', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-engineering');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(manifest.files.includes('client.js'));
  assert.ok(manifest.files.includes('skills'));
  assert.ok(manifest.files.includes('docs'));
  assert.ok(manifest.files.includes('locale'));
  assert.ok(manifest.files.includes('icon.svg'));
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['@heluo/forge-devops', '@heluo/forge-gitee', '@heluo/forge-policy'],
  );
  assert.equal(manifest.dependencies['@heluo/forge-iam'], undefined);
  assert.equal(manifest.dependencies['@heluo/forge-credentials-keychain'], undefined);
});

test('cordis.patch.yml mounts policy + workbench UI + skill + DevOps + Gitee with zero official row disables and zero isolate', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /id: heluo-policy[\s\S]*name: '@heluo\/forge-policy'/);
  assert.match(patch, /id: heluo-engineering-ui[\s\S]*name: '@heluo\/forge-engineering'/);
  assert.match(patch, /id: heluo-issue-delivery-skill[\s\S]*name: '@heluo\/forge-engineering\/issue-delivery-skill'/);
  assert.match(patch, /id: forge-devops[\s\S]*name: '@heluo\/forge-devops'/);
  assert.match(patch, /id: heluo-gitee[\s\S]*name: '@heluo\/forge-gitee'/);
  assert.doesNotMatch(patch, /heluo-iam/);
  assert.doesNotMatch(patch, /heluo-credentials-keychain/);
  assert.doesNotMatch(patch, /disabled:\s*true/);
  assert.doesNotMatch(patch, /^\s*isolate:/mu);
});

test('every inserted package exists, is private, and resolves within the repo', () => {
  const patch = read('cordis.patch.yml');
  const names = [...patch.matchAll(/^ {6}name: '([^']+)'$/gmu)].map((m) => m[1]);
  assert.equal(names.length, 5);
  for (const name of names) {
    const segments = name.split('/');
    const packageName = segments.slice(0, 2).join('/');
    const dir = join(REPO_ROOT, 'packages', segments[1]);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.private, true);
    assert.ok(manifest.engines?.dsh);
    if (segments.length > 2) {
      const subpath = `./${segments.slice(2).join('/')}`;
      assert.equal(typeof manifest.exports?.[subpath], 'string');
    }
  }
});

test('the engineering policy catalog stays byte-identical to forge-enterprise, devops, and gitee', () => {
  const catalogOf = (text) => {
    const match = text.match(/catalog:\n([\s\S]*?)\n\s+audit:/);
    assert.ok(match, 'missing policy catalog');
    return match[1].trim();
  };
  const engineering = catalogOf(read('cordis.patch.yml'));
  const enterprise = catalogOf(readFileSync(join(REPO_ROOT, 'packages', 'forge-enterprise', 'cordis.patch.yml'), 'utf8'));
  const devops = catalogOf(readFileSync(join(REPO_ROOT, 'packages', 'forge-devops', 'cordis.patch.yml'), 'utf8'));
  const gitee = catalogOf(readFileSync(join(REPO_ROOT, 'packages', 'forge-gitee', 'cordis.patch.yml'), 'utf8'));
  assert.equal(engineering, enterprise);
  assert.equal(engineering, devops);
  assert.equal(engineering, gitee);
});

test('client.js registers the section with a declared child slot, an icon, and no host-side leakage', () => {
  const raw = read('client.js');
  assert.doesNotMatch(raw, /^\s*import\s+.*src\//m);
  assert.doesNotMatch(raw, /DEEPSEEK_API_KEY|DEVOPS_API_KEY|GITEE_TOKEN|dangerouslySetInnerHTML|innerHTML/);

  const { id, exports } = loadClientModule();
  assert.equal(id, '@heluo/forge-engineering');
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
  assert.deepEqual(section.meta.children, { 'heluo.engineering.tab': { kind: 'list', scope: 'root' } });
  assert.equal('slots' in section.meta, false);
  assert.equal('icon' in section.meta, false);
  assert.equal(icon.meta.id, 'forge-engineering');

  assert.deepEqual(effects, [
    'forge-engineering: copy',
    'forge-engineering: section',
    'forge-engineering: icon',
  ]);
});

test('the section renders the child slot through the props face and keeps diagnostics collapsed', () => {
  const { exports } = loadClientModule();

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
  assert.match(serialized, /"needsRender":true/);
  assert.match(serialized, /"id":"devops"/);
  assert.match(serialized, /diagSummary/);
  assert.match(serialized, /"type":"details"/);

  const empty = exports.EngineeringSection({
    t: (key) => key,
    renderSlot: (_slot, _owner, opts = {}) => opts.fallback,
  });
  assert.match(JSON.stringify(empty), /heluo-engineering-empty/);
  assert.doesNotMatch(JSON.stringify(empty), /heluo-engineering-tabs/);

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
