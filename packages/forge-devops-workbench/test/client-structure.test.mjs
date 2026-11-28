import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PKG_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT_PATH = join(PKG_DIR, 'client.js');

const REQUIRED_ANCHORS = Object.freeze([
  '// §1 Constants & Styles',
  '// §2 Locales & Icons',
  '// §3 Same-Origin HTTP Client',
  '// §4 Host Conversation Draft Bridge',
  '// §5 Progress Boards & Top Bar Components',
  '// §5.5 Shared Modals & Connection Settings',
  '// §6.1 Requirement Domain & Modals',
  '// §6.2 Project Domain (Phase 2 Reserved)',
  '// §6.3 Dev Domain (Phase 2 Reserved)',
  '// §6.4 Efficiency Domain (Phase 2 Reserved)',
  '// §6.5 Testing Domain (Phase 2 Reserved)',
  '// §6.6 Domain View Registry',
  '// §7 Workbench Root & Fallback Drawer',
  '// §8 Cordis Client Registration',
]);

function collectMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMjsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out.sort();
}

function createReactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? null, children };
    },
    useState(init) {
      const val = typeof init === 'function' ? init() : init;
      return [val, () => {}];
    },
    useEffect() {},
    useRef(init) {
      return { current: init };
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
  };
}

function loadClientModule(source) {
  let loaded = null;
  const reactStub = createReactStub();
  const openedUrls = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          loaded = mod;
        },
      },
      open(url, target, features) {
        openedUrls.push({ url, target, features });
      },
    },
    location: { origin: 'http://127.0.0.1:48388' },
    globalThis: undefined,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.ok(loaded, 'window.__ModuleLoader__.load should be invoked');
  assert.equal(loaded.id, '@heluo/forge-devops-workbench');
  const plugin = loaded.factory((dep) => {
    assert.equal(dep, 'react', `unexpected require(${dep})`);
    return reactStub;
  });
  return { plugin, reactStub, openedUrls };
}

function createFakeClientContext({ withSidebarRight = true, withDraftFace = true } = {}) {
  const effects = [];
  const registeredSlots = [];
  const registeredTabs = [];
  const openTabCalls = [];
  const locales = new Map();

  function recordEffect(factory) {
    const disposer = factory();
    effects.push(disposer);
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  }

  const baseCtx = {
    effects,
    registeredSlots,
    registeredTabs,
    openTabCalls,
    slots: {
      inject(_slotName, regFactory) {
        const token = regFactory();
        return () => {
          if (typeof token === 'function') token();
        };
      },
      register(meta, component) {
        const rec = { meta, component, disposed: false };
        registeredSlots.push(rec);
        return () => {
          rec.disposed = true;
        };
      },
    },
    locale: {
      register(ns, bundle) {
        locales.set(ns, bundle);
        return () => locales.delete(ns);
      },
      bind(ns) {
        return (key) => locales.get(ns)?.zh?.[key] ?? key;
      },
    },
    effect: recordEffect,
    inject(deps, cb) {
      if (deps.includes('sidebarRight') && deps.includes('sidebarRightTabs')) {
        if (!withSidebarRight) return () => {};
        const scope = {
          ...baseCtx,
          sidebarRight: {
            openTab(kind) {
              openTabCalls.push(kind);
            },
          },
          sidebarRightTabs: {
            register(def) {
              registeredTabs.push(def);
              return () => {
                def.disposed = true;
              };
            },
          },
        };
        const disposer = cb(scope);
        effects.push(disposer);
        return disposer;
      }
      return () => {};
    },
    ...(withDraftFace
      ? {
        sessionInput: {
          setDraftCalls: [],
          focusCount: 0,
          setDraft(text) {
            this.setDraftCalls.push(text);
          },
          focus() {
            this.focusCount += 1;
          },
          notify() {},
        },
      }
      : {}),
  };

  return baseCtx;
}

test('client.js static guard: single-file, zero mock/squad/auto-send, and structural anchors with mutation test', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8');

  // 零相对 ESM 导入与导出
  assert.equal(/^\s*import\s+/mu.test(source), false);
  assert.equal(/^\s*export\s+/mu.test(source), false);

  // 所有必需结构锚点存在
  const checkAnchors = (code) => {
    for (const anchor of REQUIRED_ANCHORS) {
      assert.equal(code.includes(anchor), true, `Missing structural anchor: ${anchor}`);
    }
  };
  checkAnchors(source);

  // 变异测试：破坏任一锚点必须失败
  const mutated = source.replace('// §4 Host Conversation Draft Bridge', '// broken');
  assert.throws(() => checkAnchors(mutated), /Missing structural anchor/);

  // 绝不允许在客户端调用消息发送接口
  assert.equal(/\.submit\s*\(/u.test(source), false, 'client.js must never call submit()');
  assert.equal(/conversation\.send\s*\(/u.test(source), false, 'client.js must never call conversation.send()');

  // 扫描包内全部源码与清单：严禁内置 Mock、分队开关、或非允许测试文件
  const filesToScan = [
    join(PKG_DIR, 'package.json'),
    join(PKG_DIR, 'cordis.patch.yml'),
    CLIENT_PATH,
    ...collectMjsFiles(join(PKG_DIR, 'src')),
  ];
  for (const file of filesToScan) {
    const content = readFileSync(file, 'utf8');
    const name = basename(file);
    assert.equal(/\/uam\/api\/team\/list|\/uam\/api\/group\/list/u.test(content), false, `Forbidden team/group API in ${file}`);
    assert.equal(/mock-provider/u.test(content), false, `Forbidden mock provider in ${file}`);
    if (name !== 'config.mjs') {
      assert.equal(/allowMock|authMode['"\s:=]+['"]mock['"]/u.test(content), false, `Forbidden mock logic in ${file}`);
    } else {
      assert.equal(/authMode\s*===\s*['"]mock['"]/u.test(content), false, `Forbidden mock branch in ${file}`);
    }
    if (name !== 'config.mjs' && name !== 'preferences.mjs') {
      assert.equal(/\bsquadId\b|\bactiveSquadId\b/u.test(content), false, `Forbidden squad state in ${file}`);
    }
  }
});

test('client.js sandbox execution: mounts right multi-tab when supported and falls back to drawer on baseline host', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const { plugin, openedUrls } = loadClientModule(source);

  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);

  // 场景 A：支持 sidebarRightTabs / sidebarRight
  const ctxA = createFakeClientContext({ withSidebarRight: true, withDraftFace: true });
  const mountedA = plugin.apply(ctxA);

  assert.equal(ctxA.registeredTabs.length, 1);
  assert.equal(ctxA.registeredTabs[0].kind, 'forge-devops-workbench');
  assert.equal(ctxA.registeredTabs[0].id, '@heluo/forge-devops-workbench');

  const slotNamesA = ctxA.registeredSlots.map((s) => s.meta.name);
  assert.ok(slotNamesA.includes('sidebar.footer.action'));
  assert.ok(slotNamesA.includes('shell.overlay'));
  assert.ok(slotNamesA.includes('sidebar.right.pane.tab'));
  assert.ok(slotNamesA.includes('sidebar.right.pane.tab.title'));

  // sidebar.right.pane.tab 的 inject 透传 sessionId
  const paneSlot = ctxA.registeredSlots.find((s) => s.meta.name === 'sidebar.right.pane.tab');
  assert.equal(typeof paneSlot.meta.inject, 'function');
  assert.deepEqual({ ...paneSlot.meta.inject('sess-42') }, { sessionId: 'sess-42' });

  // 触发左侧按钮点击 -> openTab('forge-devops-workbench')
  const entrySlot = ctxA.registeredSlots.find((s) => s.meta.name === 'sidebar.footer.action');
  const entryVdom = entrySlot.component({ wide: true });
  assert.equal(typeof entryVdom.props.onClick, 'function');
  const modeA = entryVdom.props.onClick();
  assert.equal(modeA, 'tab');
  assert.deepEqual(ctxA.openTabCalls, ['forge-devops-workbench']);
  assert.equal(mountedA.drawerStore.isOpen(), false);

  // 草稿写入桥：既兼容直接传入 ctxA，也验证 DSH 原生 conversation.input.for(binding.ctx)
  const bridgeA = plugin.resolveDraftBridge(ctxA, null);
  assert.equal(bridgeA.canWriteDraft, true);
  const writeOut = bridgeA.writeDraft('已确认提示词文本', 'replace');
  assert.equal(writeOut.ok, true);
  assert.deepEqual(ctxA.sessionInput.setDraftCalls, ['已确认提示词文本']);
  assert.equal(ctxA.sessionInput.focusCount, 1);

  const actxToken = { isSessionActx: true };
  let capturedDraft = '已有草稿';
  const dshDraftCalls = [];
  const bridgeDsh = plugin.resolveDraftBridge({
    ctx: ctxA,
    sessionId: 'sess-42',
    sessions: {
      binding(id) {
        assert.equal(id, 'sess-42');
        return { ctx: actxToken };
      },
    },
    conversation: {
      input: {
        for(actx) {
          assert.equal(actx, actxToken);
          return {
            state: { getSnapshot: () => ({ draft: capturedDraft }) },
            setDraft(txt) {
              capturedDraft = txt;
              dshDraftCalls.push(txt);
            },
            focus() {},
            notify() {},
          };
        },
      },
    },
  });
  assert.equal(bridgeDsh.canWriteDraft, true);
  assert.equal(bridgeDsh.writeDraft('追加提示词', 'append').ok, true);
  assert.equal(dshDraftCalls[0], '已有草稿\n\n追加提示词');

  // 外部浏览器弹出外链（允许 http/https，拒绝伪协议与含认证 URL）
  assert.equal(plugin.openExternalUrl('http://127.0.0.1:5610/dop/requirement/REQ-1'), true);
  assert.equal(plugin.openExternalUrl('javascript:alert(1)'), false);
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0].url, 'http://127.0.0.1:5610/dop/requirement/REQ-1');
  assert.equal(openedUrls[0].target, '_blank');
  assert.equal(openedUrls[0].features, 'noopener,noreferrer');

  // 所有 effect 清理必须生效
  for (const disposer of ctxA.effects) {
    if (typeof disposer === 'function') disposer();
  }
  assert.ok(ctxA.registeredSlots.every((s) => s.disposed));

  // 场景 B：基线宿主不支持 sidebarRight
  const ctxB = createFakeClientContext({ withSidebarRight: false, withDraftFace: false });
  const mountedB = plugin.apply(ctxB);
  assert.equal(ctxB.registeredTabs.length, 0);
  const modeB = mountedB.openWorkbench();
  assert.equal(modeB, 'drawer');
  assert.equal(mountedB.drawerStore.isOpen(), true);

  // 场景 C：无草稿桥接口时优雅降级
  const bridgeB = plugin.resolveDraftBridge(ctxB, null);
  assert.equal(bridgeB.canWriteDraft, false);
  assert.deepEqual({ ...bridgeB.writeDraft('abc') }, { ok: false, target: 'unsupported' });
});

test('client.js 还原极简双色轻轨原型样式并严守零原型假数据红线', () => {
  const clientSource = readFileSync(CLIENT_PATH, 'utf8');
  assert.match(clientSource, /function DuotoneIcon\(/);
  for (const iconKey of ['alertTri', 'clock', 'searchDoc', 'inbox', 'clipboard', 'shield', 'gear', 'rocket', 'calendar', 'plane', 'flame', 'refresh', 'radio', 'folderProj', 'filePlus', 'compass', 'codeBox', 'flask', 'checkCircle', 'repeat', 'flag']) {
    assert.ok(clientSource.includes(`'${iconKey}'`), `缺少双色微图标 ${iconKey}`);
  }
  assert.ok(clientSource.includes('heluo-wb-u-212'), '缺少需求进展 2+1+2 U 型流');
  assert.ok(clientSource.includes('heluo-wb-u-414'), '缺少项目进展 4+1+4 U 型流');
  assert.ok(clientSource.includes('heluo-wb-u-rail'), '缺少 SVG U 型导轨');
  assert.ok(clientSource.includes('<polyline') || clientSource.includes("h('polyline'"), '缺少 SVG 流向箭头');
  assert.ok(clientSource.includes('heluo-wb-rail-5') && clientSource.includes('heluo-wb-hbar'), '缺少实施进展 5 列轻轨与故事健康度彩条');
  assert.ok(clientSource.includes('wb-prog-pill-') && clientSource.includes('wb-prog-collapse'), '缺少进展板切换胶囊或折叠开关');
  assert.ok(clientSource.includes('wb-subtab-reqs') && clientSource.includes('wb-subtab-stories'), '缺少需求/用户故事分段子页签');
  assert.ok(clientSource.includes('heluo-wb-todo-capsule') && clientSource.includes('heluo-wb-todo-pop'), '缺少红色待办胶囊或悬浮浮层');
  assert.equal(existsSync(join(PKG_DIR, 'icon.svg')), true, '缺少蓝橙小火箭图标文件 icon.svg');
  assert.equal(existsSync(join(PKG_DIR, 'icon.png')), false, '插件包禁止包含二进制 icon.png');
  assert.equal(readdirSync(PKG_DIR).some((f) => f.toLowerCase().endsWith('.png')), false, '插件包根不得残留 .png 二进制文件');
  assert.match(clientSource, /function WorkbenchIcon\(/, '缺少蓝橙小火箭矢量图标组件 WorkbenchIcon');
  assert.equal(clientSource.includes('data:image/png;base64,'), false, 'client.js 不得内嵌二进制 PNG Data URI');
  assert.ok(clientSource.includes('plugins.bundle.config'), '缺少插件详情页配置插槽');
  assert.ok(clientSource.includes('sidebar.panellist'), '缺少顶部侧栏 sidebar.panellist 插槽');
  assert.ok(clientSource.includes('wb-kpi-req-total'), '缺少需求进展 KPI 点击测试锚点');
  assert.ok(clientSource.includes('wb-connection-settings'), '缺少可视化连接配置表单测试锚点');
  assert.ok(clientSource.includes('wb-cfg-auth-readonly'), '缺少 IAM 只读认证方式说明栏');
  assert.equal(existsSync(join(PKG_DIR, 'docs', 'DETAIL.zh.md')), true, '缺少面向用户的详情文档 DETAIL.zh.md');
  assert.equal(existsSync(join(PKG_DIR, 'docs', 'DETAIL.en.md')), true, '缺少面向用户的英文详情文档 DETAIL.en.md');

  const zhLocale = JSON.parse(readFileSync(join(PKG_DIR, 'locale', 'zh.json'), 'utf8'));
  const enLocale = JSON.parse(readFileSync(join(PKG_DIR, 'locale', 'en.json'), 'utf8'));
  assert.equal(zhLocale.meta?.title, 'DOP 工作台');
  assert.equal(zhLocale.meta?.detail, 'docs/DETAIL.zh.md');
  for (const kw of ['需求', '项目', '研发', '测试', '效能']) {
    assert.ok(zhLocale.meta?.description?.includes(kw), `meta.description 应包含全流程关键词: ${kw}`);
  }
  assert.equal(enLocale.meta?.title, 'DOP Workbench');
  assert.equal(enLocale.meta?.detail, 'docs/DETAIL.en.md');

  // 绝不带入内网/行业真实域名、分队硬编码或静态凭据字段
  for (const match of clientSource.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/gu)) {
    const host = match[1].toLowerCase();
    assert.ok(
      host === '127.0.0.1' || host === 'localhost' || host === 'www.w3.org' || host.endsWith('.example'),
      `client.js 不允许包含非示例域名或内网主机：${host}`,
    );
  }
  for (const forbidden of [
    '智能工程分队',
    'squadId',
    'activeSquadId',
    'credentialRef',
    '静态凭据',
  ]) {
    assert.equal(clientSource.includes(forbidden), false, `禁止包含违禁词或静态凭据字段：${forbidden}`);
  }
});

test('client.js 场景 D（新版 DSH 含 layout 服务）：顶部小火箭唯一入口、插件配置槽及全屏页签切换防误弹抽屉', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const { plugin } = loadClientModule(source);

  const effects = [];
  const registeredSlots = [];
  const registeredTabs = [];
  const openTabCalls = [];
  const selectPanelCalls = [];
  const locales = new Map();
  const panelListeners = new Set();
  const mountedListeners = new Set();

  let activePanelId = 'plugins';
  let mountedSession = null;

  const layoutSvc = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(fn) {
        panelListeners.add(fn);
        return () => panelListeners.delete(fn);
      },
    },
    selectPanel(nextId) {
      if (
        nextId !== null
        && nextId !== 'plugins'
        && !registeredSlots.some((s) => s.meta.name === 'main' && s.meta.key === nextId && !s.disposed)
      ) {
        throw new Error(`layout.selectPanel: main panel "${nextId}" is not registered`);
      }
      selectPanelCalls.push(nextId);
      activePanelId = nextId;
      for (const fn of [...panelListeners]) fn();
    },
  };

  const ctxD = {
    slots: {
      inject(_slotName, regFactory) {
        const token = regFactory();
        return () => {
          if (typeof token === 'function') token();
        };
      },
      register(meta, component) {
        const rec = { meta, component, disposed: false };
        registeredSlots.push(rec);
        return () => {
          rec.disposed = true;
        };
      },
    },
    locale: {
      register(ns, bundle) {
        locales.set(ns, bundle);
        return () => locales.delete(ns);
      },
      bind(ns) {
        return (key) => locales.get(ns)?.zh?.[key] ?? key;
      },
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    inject(deps, cb) {
      if (deps.includes('layout')) {
        const disposer = cb({ layout: layoutSvc });
        effects.push(disposer);
        return disposer;
      }
      if (deps.includes('sidebarRight') && deps.includes('sidebarRightTabs')) {
        const scope = {
          ...ctxD,
          sidebarRight: {
            mounted: {
              getSnapshot: () => mountedSession,
              subscribe(fn) {
                mountedListeners.add(fn);
                return () => mountedListeners.delete(fn);
              },
            },
            openTab(kind) {
              // 模拟全屏插件页时右侧栏尚未重新挂载会抛错
              if (activePanelId !== null || mountedSession === null) {
                throw new Error('sidebarRight not mounted');
              }
              openTabCalls.push(kind);
            },
          },
          sidebarRightTabs: {
            register(def) {
              registeredTabs.push(def);
              return () => {
                def.disposed = true;
              };
            },
          },
        };
        const disposer = cb(scope);
        effects.push(disposer);
        return disposer;
      }
      return () => {};
    },
  };

  const mountedD = plugin.apply(ctxD);

  // 验证注册了顶部 sidebar.panellist (order: 20) 与插件详情页配置插槽，且底部冗余入口被撤销
  const panelSlot = registeredSlots.find((s) => s.meta.name === 'sidebar.panellist' && !s.disposed);
  assert.ok(panelSlot, '新版 DSH 应注册 sidebar.panellist 顶部入口');
  assert.equal(panelSlot.meta.order, 20);
  assert.equal(panelSlot.meta.label(), 'DOP 工作台');

  const activeFooterSlots = registeredSlots.filter((s) => s.meta.name === 'sidebar.footer.action' && !s.disposed);
  assert.equal(activeFooterSlots.length, 0, '具备顶部入口时不得保留底部重复入口');

  const cfgSlot = registeredSlots.find((s) => s.meta.name === 'plugins.bundle.config' && !s.disposed);
  assert.ok(cfgSlot, '应注册 plugins.bundle.config 插件配置槽');
  assert.equal(cfgSlot.meta.key, '@heluo/forge-devops-workbench');

  const mainSlot = registeredSlots.find((s) => s.meta.name === 'main' && s.meta.key === 'forge-devops-workbench' && !s.disposed);
  assert.ok(mainSlot, '应同步注册瞬态 main 槽位以通过 DSH LayoutController.selectPanel 校验');

  // 模拟从「插件」全屏页直接点击左侧「DOP 工作台」入口：
  // 1) 自动 selectPanel(null) 切回对话视图；
  // 2) 不立即误弹抽屉，而是等待 sidebarRight.mounted 通知后成功调用 openTab
  layoutSvc.selectPanel('forge-devops-workbench');
  assert.deepEqual(selectPanelCalls, ['forge-devops-workbench', null]);
  assert.equal(mountedD.drawerStore.isOpen(), false, '等待右侧栏挂载期间不得误弹抽屉');

  mountedSession = 'sess-after-switch';
  for (const fn of [...mountedListeners]) fn();

  assert.deepEqual(openTabCalls, ['forge-devops-workbench']);
  assert.equal(mountedD.drawerStore.isOpen(), false, '右侧多页签挂载后应保持关闭抽屉状态');

  for (const disposer of effects) {
    if (typeof disposer === 'function') disposer();
  }
});
