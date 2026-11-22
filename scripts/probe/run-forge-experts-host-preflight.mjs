#!/usr/bin/env node
/**
 * #246 建包前宿主预检探针（docs/design/plugins/forge-experts.md §5.1–§5.2）。
 *
 * 在独立临时工作区生成仅供取证的 `@heluo/forge-experts` Host + Client 夹具，
 * 经 `scripts/build-enterprise-bundle.mjs --root` 走同一构建器产出独立 tarball，
 * 再在隔离的 `DSH_HOME` 中验证目标终端（web / desktop）的包体闭包、profile 补丁装配、
 * 同源路由与 SSE、Client 单 bundle 槽位注册、`storageDomain` 重启回读及单 Host 写入归属。
 *
 * 环境变量：
 *   DSH_BIN               目标 DSH CLI 路径（默认 `dsh`）
 *   FORGE_EXPERTS_TARGET  目标终端：`web`（默认）或 `desktop`
 *   DSH_APP               `FORGE_EXPERTS_TARGET=desktop` 时的桌面发行物路径
 *   FORGE_EXPERTS_PROFILE 目标 profile 覆盖（默认与 target 一致）
 *   DSH_NODE_MODULES      可选：显式指定已安装 DSH SDK 的 node_modules 目录
 *
 * 退出码：
 *   0  全部必要预检项 PASS
 *   1  至少一项预检项 FAIL
 *   2  目标启动器、终端或前置证据缺失（BLOCKED / NOT RUN）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditReleaseClosure, execNpm, parsePatchLayer } from '../lib/bundle-rules.mjs';
import { resolveDshProbeHost } from '../lib/dsh-probe-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const builderScript = resolve(repo, 'scripts/build-enterprise-bundle.mjs');
const targetVersion = readFileSync(join(repo, '.dsh-version'), 'utf8').trim();

const VALID_TARGETS = new Set(['web', 'desktop']);
const target = (process.env.FORGE_EXPERTS_TARGET ?? 'web').trim().toLowerCase();
const dshBin = process.env.DSH_BIN ?? 'dsh';
const dshApp = process.env.DSH_APP ?? '';
const profile = process.env.FORGE_EXPERTS_PROFILE ?? target;

const workDir = mkdtempSync(join(tmpdir(), 'forge-experts-preflight-'));
const fixtureRoot = join(workDir, 'fixture-workspace');
const artifactDir = join(workDir, 'artifacts');
const installDir = join(workDir, 'installed-profile');
const dshHome = join(workDir, 'dsh-home');
const storageRoot = join(workDir, 'storage-root');
const evidencePath = join(workDir, 'forge-experts-host-preflight.json');

const isolatedEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  npm_config_cache: join(workDir, 'npm-cache'),
  npm_config_userconfig: join(workDir, 'empty-npmrc'),
  npm_config_registry: 'http://127.0.0.1:9',
};
delete isolatedEnv.DSH_PROFILE;
delete isolatedEnv.DSH_PROFILE_DIR;

const evidence = {
  probe: 'forge-experts-host-preflight',
  issue: '#246',
  startedAt: new Date().toISOString(),
  scope: 'pre-package synthetic Host + Client fixture via build-enterprise-bundle --root; NOT real Delegra enterprise auth evidence',
  env: {
    target,
    profile,
    dshBin,
    dshApp: dshApp || null,
    targetVersion,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  },
  artifact: null,
  checks: [],
};

function record(id, status, detail = {}) {
  evidence.checks.push({ id, status, detail });
  const tag = status.padEnd(7, ' ');
  console.log(`${tag} ${id}${status === 'PASS' ? '' : ` ${JSON.stringify(detail)}`}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeFixtureWorkspace() {
  const pkgDir = join(fixtureRoot, 'packages', 'forge-experts');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  mkdirSync(join(pkgDir, 'locale'), { recursive: true });

  const manifest = {
    name: '@heluo/forge-experts',
    version: '0.0.0-preflight.1',
    private: true,
    type: 'module',
    icon: './icon.svg',
    description: 'Preflight fixture for Forge Experts DSH host verification (#246)',
    engines: { dsh: `>=${targetVersion}` },
    main: './src/index.mjs',
    exports: {
      '.': './src/index.mjs',
      './package.json': './package.json',
      './client': './client.js',
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
    },
    files: ['src', 'client.js', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md'],
    peerDependencies: { react: '>=18' },
    peerDependenciesMeta: { react: { optional: true } },
    dsh: {
      client: { platform: 'web', immediately: true, inject: [] },
      bundle: { patch: './cordis.patch.yml' },
    },
  };

  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(pkgDir, 'cordis.patch.yml'),
    [
      '# Preflight-only patch layer for @heluo/forge-experts (#246).',
      '- insert:',
      '    - id: forge-experts-preflight',
      "      name: '@heluo/forge-experts'",
      '      config: {}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(pkgDir, 'locale', 'en.json'),
    `${JSON.stringify({ meta: { title: 'Expert Agents (Preflight)', description: 'Host preflight fixture' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(pkgDir, 'locale', 'zh.json'),
    `${JSON.stringify({ meta: { title: '专家智能体（预检）', description: '宿主预检夹具' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(pkgDir, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/></svg>\n',
  );
  writeFileSync(
    join(pkgDir, 'README.md'),
    '# @heluo/forge-experts (preflight fixture)\n\nTemporary preflight artifact generated by `scripts/probe/run-forge-experts-host-preflight.mjs`.\n',
  );

  // Host module: probes webServer, connection, storageDomain, SSE, and clean disposal.
  const hostSource = `import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'forge-experts-preflight';
export const inject = {
  optional: ['webServer', 'connection', 'storageDomain', 'iam'],
};

const API_PREFIX = '/api/forge-experts-preflight';
const REQUEST_HEADER = 'x-forge-experts-preflight';

function prefKey({ instanceId, orgId, issuer, subject, expertId }) {
  return createHash('sha256')
    .update(JSON.stringify([instanceId, orgId, issuer, subject, expertId]))
    .digest('hex');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createFallbackJsonStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'forge_experts_v1.json');
  const readAll = () => {
    if (!existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    source: 'fallback-atomic-json',
    file,
    async get(key) { return readAll()[key] ?? null; },
    async set(key, value) {
      const next = { ...readAll(), [key]: value };
      const tmp = join(dir, \`.forge_experts_v1.\${process.pid}.\${Date.now()}.tmp\`);
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, file);
      return value;
    },
    async close() {},
  };
}

export async function apply(ctx, config = {}) {
  const scopeEpoch = 1;
  let viewVersion = 1;
  const sseClients = new Set();
  const storageDir = config.storageDir ?? process.env.FORGE_EXPERTS_PREFLIGHT_STORAGE_DIR ?? null;

  let store = null;
  let storageKind = 'none';
  const hostStorage = typeof ctx.get === 'function' ? ctx.get('storageDomain') : ctx.storageDomain;
  if (hostStorage && typeof hostStorage.open === 'function') {
    const handle = await hostStorage.open({
      name: 'forge_experts',
      version: 1,
      tables: ['preferences'],
    });
    storageKind = 'host-storageDomain';
    store = {
      source: 'host-storageDomain',
      async get(key) { return (await handle.get?.('preferences', key)) ?? null; },
      async set(key, value) {
        await handle.set?.('preferences', key, value);
        return value;
      },
      async close() { await handle.close?.(); },
    };
  } else if (storageDir) {
    store = createFallbackJsonStore(storageDir);
    storageKind = store.source;
  }

  const broadcast = (event) => {
    const frame = \`data: \${JSON.stringify(event)}\\n\\n\`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  };

  const checkConnection = (req) => {
    const conn = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
    if (!conn || typeof conn.requestRejection !== 'function') return undefined;
    return conn.requestRejection({ headers: req?.headers ?? {} });
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(API_PREFIX)) return false;

    const rejected = checkConnection(req);
    if (rejected) {
      sendJson(res, rejected, { error: { code: 'EXPERT_UNAUTHENTICATED' } });
      return true;
    }

    if (url.pathname === \`\${API_PREFIX}/health\` && req.method === 'GET') {
      sendJson(res, 200, { ok: true, scopeEpoch, viewVersion, storageKind });
      return true;
    }

    if (url.pathname === \`\${API_PREFIX}/events\` && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      sseClients.add(res);
      res.write(\`data: \${JSON.stringify({ type: 'ready', scopeEpoch, viewVersion })}\\n\\n\`);
      req.on?.('close', () => sseClients.delete(res));
      return true;
    }

    if (url.pathname.startsWith(\`\${API_PREFIX}/preferences/\`)) {
      const expertId = decodeURIComponent(url.pathname.slice(\`\${API_PREFIX}/preferences/\`.length));
      const key = prefKey({
        instanceId: 'preflight-instance',
        orgId: 'preflight-org',
        issuer: 'https://iam.preflight.example',
        subject: 'preflight-user',
        expertId,
      });
      if (req.method === 'GET') {
        const record = store ? await store.get(key) : null;
        sendJson(res, 200, {
          expertId,
          enabled: record?.enabled ?? false,
          revision: record?.revision ?? 0,
          viewVersion,
          storageKind,
        });
        return true;
      }
      if (req.method === 'PUT') {
        if (req.headers?.[REQUEST_HEADER] !== '1') {
          sendJson(res, 403, { error: { code: 'EXPERT_REQUEST_HEADER_REQUIRED' } });
          return true;
        }
        if (!store) {
          sendJson(res, 503, { error: { code: 'EXPERT_STORAGE_UNAVAILABLE' } });
          return true;
        }
        const body = await readJsonBody(req);
        const current = await store.get(key);
        const next = {
          enabled: Boolean(body?.enabled),
          revision: (current?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        await store.set(key, next);
        viewVersion += 1;
        broadcast({ type: 'preference-updated', expertId, scopeEpoch, viewVersion });
        sendJson(res, 200, { expertId, ...next, viewVersion, storageKind });
        return true;
      }
    }

    sendJson(res, 404, { error: { code: 'EXPERT_NOT_FOUND' } });
    return true;
  };

  let unregisterRoute = null;
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  if (webServer && typeof webServer.register === 'function') {
    unregisterRoute = webServer.register(API_PREFIX, handler);
  }

  const service = {
    name,
    storageKind,
    handleRequest: handler,
    getState: () => ({ scopeEpoch, viewVersion, storageKind, sseClientCount: sseClients.size }),
  };
  ctx.provide?.('forgeExpertsPreflight', service);

  ctx.on?.('dispose', async () => {
    if (typeof unregisterRoute === 'function') unregisterRoute();
    for (const res of sseClients) {
      try { res.end(); } catch { /* closing */ }
    }
    sseClients.clear();
    if (store) await store.close();
  });
}
`;
  writeFileSync(join(pkgDir, 'src', 'index.mjs'), hostSource);

  // Client single bundle (P1): registers settings.section and optional inputTriggers source.
  const clientSource = `window.__ModuleLoader__.load({
  id: '@heluo/forge-experts',
  factory(require) {
    // §1 包装与常量
    const React = require('react');
    const h = React.createElement;
    const SECTION_ID = 'forge-experts-preflight';

    // §2 视图
    function ExpertsPreflightPanel() {
      return h('div', { 'data-testid': 'forge-experts-preflight-panel' }, 'Forge Experts Preflight');
    }

    // §3 出口
    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: 25,
            label: () => '专家智能体',
          }, ExpertsPreflightPanel));
          if (typeof disposeSection === 'function') disposers.push(disposeSection);
        }
        const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers;
        if (triggers && typeof triggers.registerSource === 'function') {
          const disposeTrigger = triggers.registerSource({
            id: 'forge-experts-preflight-mentions',
            trigger: '@',
            label: '专家智能体',
            query: async () => [],
          });
          if (typeof disposeTrigger === 'function') disposers.push(disposeTrigger);
        }
        ctx.on?.('dispose', () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* best effort */ }
          }
        });
      },
    };
  },
});
`;
  writeFileSync(join(pkgDir, 'client.js'), clientSource);
}

function buildPreflightTarball() {
  mkdirSync(artifactDir, { recursive: true });
  const run = spawnSync(
    process.execPath,
    [builderScript, '--root', fixtureRoot, '--entry', '@heluo/forge-experts', artifactDir],
    { cwd: repo, env: isolatedEnv, encoding: 'utf8' },
  );
  if (run.status !== 0) {
    record('build-standalone-tarball', 'FAIL', {
      exitCode: run.status,
      stderr: (run.stderr ?? '').trim(),
      stdout: (run.stdout ?? '').trim(),
    });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error) {
    record('build-standalone-tarball', 'FAIL', { error: `invalid builder JSON: ${error.message}` });
    return null;
  }
  const hasManifest = existsSync(parsed.manifest);
  const hasSums = existsSync(parsed.sums);
  const hasTarball = existsSync(parsed.tarball);
  const ok = hasManifest && hasSums && hasTarball && sha256File(parsed.tarball) === parsed.sha256;
  evidence.artifact = {
    tarball: parsed.tarball,
    sha256: parsed.sha256,
    version: parsed.version,
    files: parsed.files,
    manifest: parsed.manifest,
    sums: parsed.sums,
  };
  record('build-standalone-tarball', ok ? 'PASS' : 'FAIL', {
    version: parsed.version,
    files: parsed.files,
    sha256: parsed.sha256,
    hasManifest,
    hasSums,
  });
  return ok ? parsed : null;
}

function installTarballOffline(built) {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'package.json'), '{"name":"forge-experts-preflight-profile","private":true}\n');
  writeFileSync(join(workDir, 'empty-npmrc'), '');
  try {
    execNpm(
      ['--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', 'install', built.tarball],
      { cwd: installDir, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    record('offline-tarball-install', 'FAIL', { error: error.message });
    return null;
  }
  const installedPkgDir = join(installDir, 'node_modules', '@heluo', 'forge-experts');
  const closureErrors = auditReleaseClosure(installedPkgDir, { allowInstalledBinLinks: true });
  const ok = existsSync(join(installedPkgDir, 'package.json')) && closureErrors.length === 0;
  record('offline-tarball-install', ok ? 'PASS' : 'FAIL', {
    installed: existsSync(installedPkgDir),
    closureErrors,
  });
  return ok ? installedPkgDir : null;
}

async function verifyClientSingleBundleContract(installedPkgDir) {
  const clientPath = join(installedPkgDir, 'client.js');
  const source = readFileSync(clientPath, 'utf8');
  const importsSrc = /\bimport\s+.*src\//u.test(source) || /require\(['"]\.\/src\//u.test(source);
  let loadedDef = null;
  const slotsRegistered = [];
  const triggersRegistered = [];
  let triggerDisposed = false;
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(def) { loadedDef = def; },
      },
    };
    const runner = new Function(source);
    runner();
    const exported = loadedDef?.factory((dep) => {
      if (dep === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
      throw new Error(`unexpected client require: ${dep}`);
    });
    const disposeHandlers = [];
    const fakeCtx = {
      slots: {
        inject(slotName, fn) {
          fn();
          return () => {};
        },
        register(meta, component) {
          slotsRegistered.push({ ...meta, hasComponent: typeof component === 'function' });
          return () => {};
        },
      },
      inputTriggers: {
        registerSource(spec) {
          triggersRegistered.push(spec);
          return () => { triggerDisposed = true; };
        },
      },
      on(event, fn) {
        if (event === 'dispose') disposeHandlers.push(fn);
      },
    };
    exported?.apply?.(fakeCtx);
    for (const fn of disposeHandlers) fn();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  const ok = !importsSrc
    && loadedDef?.id === '@heluo/forge-experts'
    && slotsRegistered.some((item) => item.name === 'settings.section' && item.id === 'forge-experts-preflight')
    && triggersRegistered.some((item) => item.trigger === '@' && item.id === 'forge-experts-preflight-mentions')
    && triggerDisposed;
  record('client-bundle-slot-and-trigger-contract', ok ? 'PASS' : 'FAIL', {
    importsSrc,
    moduleId: loadedDef?.id ?? null,
    slots: slotsRegistered.map((item) => ({ name: item.name, id: item.id })),
    triggers: triggersRegistered.map((item) => ({ id: item.id, trigger: item.trigger })),
    triggerDisposed,
  });
}

function invokeMockHttp(handler, { method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHandlers = new Map();
    const req = {
      method,
      url,
      headers,
      on(event, fn) { reqHandlers.set(event, fn); },
    };
    const resHeaders = {};
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      write(chunk) { chunks.push(String(chunk)); },
      end(chunk = '') {
        if (chunk) chunks.push(String(chunk));
        resolve({ statusCode: res.statusCode, headers: resHeaders, body: chunks.join('') });
      },
    };
    Promise.resolve(handler(req, res))
      .then(() => {
        if (method === 'GET' && url.endsWith('/events')) {
          resolve({ statusCode: res.statusCode, headers: resHeaders, body: chunks.join(''), close: () => reqHandlers.get('close')?.() });
        }
      })
      .catch(reject);
    if (body !== null) {
      queueMicrotask(() => {
        reqHandlers.get('data')?.(Buffer.from(JSON.stringify(body)));
        reqHandlers.get('end')?.();
      });
    }
  });
}

async function verifyTargetHostActivation(installedPkgDir, hostLocation) {
  const hostRequire = createRequire(pathToFileURL(hostLocation.anchor));
  const load = (name) => import(pathToFileURL(hostRequire.resolve(name)).href);

  // 1. Check SDK package resolution sources (storageDomain / zod / cordis)
  const resolvedSources = {};
  for (const pkgName of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-storage-domain', 'zod']) {
    try {
      resolvedSources[pkgName] = relative(dirname(hostLocation.anchor), hostRequire.resolve(pkgName));
    } catch {
      resolvedSources[pkgName] = null;
    }
  }
  const hasCoreSdk = Boolean(resolvedSources['@deepseek-ai/cordis'] && resolvedSources['@deepseek-ai/cordis-plugin-loader'] && resolvedSources['@deepseek-ai/dsh-app-boot']);
  record('host-sdk-export-resolution', hasCoreSdk ? 'PASS' : 'BLOCKED', {
    sdkLayout: hostLocation.kind,
    resolvedSources,
  });
  if (!hasCoreSdk) {
    record('host-runtime-routes-sse-and-storage-restart', 'NOT RUN', { reason: 'core DSH SDK exports unavailable' });
    return;
  }

  const [{ Context }, { default: Loader }, { PluginPackages, createRuntimeResolution }] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/cordis-plugin-loader'),
    load('@deepseek-ai/dsh-app-boot'),
  ]);

  const installedRealPath = realpathSync(installedPkgDir);
  const patch = parsePatchLayer(readFileSync(join(installedRealPath, 'cordis.patch.yml'), 'utf8'));
  const pkgRequire = createRequire(pathToFileURL(join(installedRealPath, 'package.json')));
  const entryPath = pkgRequire.resolve('@heluo/forge-experts');
  const escaped = relative(installedRealPath, entryPath).startsWith('..') || isAbsolute(relative(installedRealPath, entryPath));

  // Shared in-process storage domain adapter backed by atomic JSON in storageRoot to verify restart persistence.
  const openHostOnce = async (label, { rejectAuth = false } = {}) => {
    const ctx = new Context();
    const registeredRoutes = new Map();
    const resolution = await createRuntimeResolution({
      installAnchor: hostRequire.resolve('@deepseek-ai/dsh/package.json'),
      home: dshHome,
      profile: {
        dir: installDir,
        layers: [{ packageName: '@heluo/forge-experts', packageDir: installedRealPath }],
        skippedBundles: [],
      },
    });
    await ctx.plugin(PluginPackages, { resolution }).await();
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(installedRealPath, 'cordis.patch.yml')).href }).await();
    ctx.provide('webServer', {
      register(prefix, fn) {
        registeredRoutes.set(prefix, fn);
        return () => registeredRoutes.delete(prefix);
      },
    });
    ctx.provide('connection', {
      requestRejection({ headers }) {
        if (rejectAuth || headers?.['x-dsh-test-auth'] !== 'ok') return 401;
        return undefined;
      },
    });

    const ids = [];
    for (const row of patch.inserted) {
      ids.push(await ctx.loader.create({
        id: row.id,
        name: row.name,
        config: { ...(row.config ?? {}), storageDir: storageRoot },
      }));
    }
    await ctx.loader.await();
    const service = ctx.get('forgeExpertsPreflight');
    return { ctx, ids, service, registeredRoutes, label };
  };

  let host1;
  let host2;
  try {
    host1 = await openHostOnce('boot-1');
    const handler = host1.registeredRoutes.get('/api/forge-experts-preflight');
    const unauth = await invokeMockHttp(handler, { method: 'GET', url: '/api/forge-experts-preflight/health' });
    const health = await invokeMockHttp(handler, { method: 'GET', url: '/api/forge-experts-preflight/health', headers: { 'x-dsh-test-auth': 'ok' } });
    const sse = await invokeMockHttp(handler, { method: 'GET', url: '/api/forge-experts-preflight/events', headers: { 'x-dsh-test-auth': 'ok' } });
    const putNoHeader = await invokeMockHttp(handler, {
      method: 'PUT',
      url: '/api/forge-experts-preflight/preferences/exp-001',
      headers: { 'x-dsh-test-auth': 'ok' },
      body: { enabled: true },
    });
    const putOk = await invokeMockHttp(handler, {
      method: 'PUT',
      url: '/api/forge-experts-preflight/preferences/exp-001',
      headers: { 'x-dsh-test-auth': 'ok', 'x-forge-experts-preflight': '1' },
      body: { enabled: true },
    });
    sse.close?.();

    // Unload host1 cleanly and confirm routes are unregistered.
    for (const id of host1.ids.reverse()) host1.ctx.loader.remove(id);
    await host1.ctx.loader.await();
    const unloadedCleanly = host1.registeredRoutes.size === 0 && host1.ctx.get('forgeExpertsPreflight') === undefined;
    await host1.ctx.fiber.dispose();
    host1 = null;

    // Boot fresh host2 pointing to the exact same storageRoot to prove restart readback.
    host2 = await openHostOnce('boot-2');
    const handler2 = host2.registeredRoutes.get('/api/forge-experts-preflight');
    const readback = await invokeMockHttp(handler2, {
      method: 'GET',
      url: '/api/forge-experts-preflight/preferences/exp-001',
      headers: { 'x-dsh-test-auth': 'ok' },
    });
    const parsedPut = JSON.parse(putOk.body);
    const parsedReadback = JSON.parse(readback.body);
    const ok = !escaped
      && unauth.statusCode === 401
      && health.statusCode === 200
      && sse.statusCode === 200
      && sse.body.includes('"type":"ready"')
      && putNoHeader.statusCode === 403
      && putOk.statusCode === 200
      && parsedPut.enabled === true
      && parsedPut.revision === 1
      && unloadedCleanly
      && readback.statusCode === 200
      && parsedReadback.enabled === true
      && parsedReadback.revision === 1;

    record('host-runtime-routes-sse-and-storage-restart', ok ? 'PASS' : 'FAIL', {
      unauthStatus: unauth.statusCode,
      healthStatus: health.statusCode,
      sseReadyFrame: sse.body.includes('"type":"ready"'),
      putNoHeaderStatus: putNoHeader.statusCode,
      putRevision: parsedPut.revision,
      unloadedCleanly,
      restartReadback: { enabled: parsedReadback.enabled, revision: parsedReadback.revision },
    });
  } catch (error) {
    record('host-runtime-routes-sse-and-storage-restart', 'FAIL', { error: error.message });
  } finally {
    if (host1) await host1.ctx.fiber.dispose().catch(() => {});
    if (host2) await host2.ctx.fiber.dispose().catch(() => {});
  }
}

function readGitStatus() {
  try {
    return { ok: true, output: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function main() {
  const statusAtStart = readGitStatus();

  if (!VALID_TARGETS.has(target)) {
    record('target-selection', 'FAIL', { target, expected: [...VALID_TARGETS] });
    return;
  }
  record('target-selection', 'PASS', { target, profile });

  if (target === 'desktop' && (!dshApp || !existsSync(dshApp))) {
    record('desktop-app-present', 'BLOCKED', {
      reason: 'FORGE_EXPERTS_TARGET=desktop requires DSH_APP pointing to an existing desktop distribution',
      dshApp: dshApp || null,
    });
  } else if (target === 'desktop') {
    record('desktop-app-present', 'PASS', { dshApp });
  }

  // Step 1: Generate isolated fixture workspace & build standalone tarball via real builder (--root)
  writeFixtureWorkspace();
  const built = buildPreflightTarball();
  if (!built) return;

  // Step 2: Clean offline install & release closure audit
  const installedPkgDir = installTarballOffline(built);
  if (!installedPkgDir) return;

  // Step 3: Verify Client single bundle contract (settings.section + inputTriggers.registerSource)
  await verifyClientSingleBundleContract(installedPkgDir);

  // Step 4: Locate target DSH CLI & verify profile dump-config composition
  const versionRun = spawnSync(dshBin, ['--version'], { env: isolatedEnv, encoding: 'utf8' });
  if (versionRun.error || versionRun.status !== 0) {
    record('dsh-cli-available', 'BLOCKED', {
      dshBin,
      error: versionRun.error?.message ?? (versionRun.stderr ?? '').trim(),
      hint: 'Supply DSH_BIN=/path/to/dsh (0.2.1-rc.3) to execute target host probes',
    });
    record('target-profile-dump-config', 'NOT RUN', { reason: 'DSH CLI unavailable' });
    record('host-sdk-export-resolution', 'NOT RUN', { reason: 'DSH CLI unavailable' });
    record('host-runtime-routes-sse-and-storage-restart', 'NOT RUN', { reason: 'DSH CLI unavailable' });
    return;
  }

  const dshVersion = (versionRun.stdout ?? '').trim();
  evidence.env.dshVersion = dshVersion;
  record('dsh-cli-available', 'PASS', {
    dshVersion,
    matchesTargetVersion: dshVersion.includes(targetVersion),
  });

  // Check if Electron re-entry is required for macOS desktop ASAR layout
  let hostLocation = null;
  try {
    hostLocation = resolveDshProbeHost({ dsh: dshBin, modules: process.env.DSH_NODE_MODULES });
    if (hostLocation.runtime !== null && realpathSync(process.execPath) !== hostLocation.runtime) {
      const child = spawnSync(
        hostLocation.runtime,
        ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' },
      );
      process.exit(child.status ?? 2);
    }
  } catch (error) {
    record('host-sdk-export-resolution', 'BLOCKED', { error: error.message });
  }

  // Dump target profile config with installed patch layer to inspect host services
  const patchPath = join(installedPkgDir, 'cordis.patch.yml');
  const dumpRun = spawnSync(dshBin, ['--profile', profile, '--patch', patchPath, '--dump-config'], {
    env: isolatedEnv,
    encoding: 'utf8',
  });
  const dumpStdout = String(dumpRun.stdout ?? '');
  const hasPreflightRow = dumpStdout.includes('forge-experts-preflight');
  const observedHostServices = {
    storageDomain: /storage-domain|storageDomain/u.test(dumpStdout),
    storageJson: /storage-json/u.test(dumpStdout),
    webServer: /web-server|webServer/u.test(dumpStdout),
    uiSettings: /ui-settings/u.test(dumpStdout),
    uiInputTrigger: /ui-input-trigger/u.test(dumpStdout),
  };
  record('target-profile-dump-config', dumpRun.status === 0 && hasPreflightRow ? 'PASS' : 'FAIL', {
    profile,
    exitCode: dumpRun.status,
    hasPreflightRow,
    observedHostServices,
    stderr: (dumpRun.stderr ?? '').trim().slice(0, 400) || undefined,
  });

  // Step 5: Real Cordis/Loader activation + route/SSE/storage restart readback
  if (hostLocation) {
    await verifyTargetHostActivation(installedPkgDir, hostLocation);
  } else {
    record('host-runtime-routes-sse-and-storage-restart', 'NOT RUN', { reason: 'host SDK location unresolved' });
  }

  // Step 6: Confirm repository working tree remained untouched
  if (statusAtStart.ok) {
    const statusAtEnd = readGitStatus();
    record('repository-working-tree-untouched', statusAtEnd.ok && statusAtStart.output === statusAtEnd.output ? 'PASS' : 'FAIL');
  } else {
    record('repository-working-tree-untouched', 'NOT RUN', { reason: 'git status unavailable in current worktree environment' });
  }
}

try {
  await main();
} catch (error) {
  record('preflight-exception', 'FAIL', { error: error?.stack ?? String(error) });
} finally {
  evidence.finishedAt = new Date().toISOString();
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, 'NOT RUN': 0 };
  for (const check of evidence.checks) {
    counts[check.status] = (counts[check.status] ?? 0) + 1;
  }
  evidence.summary = counts;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `preflight: PASS=${counts.PASS} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED} NOT_RUN=${counts['NOT RUN']}`,
  );
  console.log(`preflight: evidence ${evidencePath}`);
  if (counts.FAIL > 0) process.exitCode = 1;
  else if (counts.BLOCKED > 0 || counts['NOT RUN'] > 0) process.exitCode = 2;
  else process.exitCode = 0;
}
