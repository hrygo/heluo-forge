/**
 * r15 §3.4：保存与应用是两个结论（AC-8）。
 *
 * 页面要能同时说清"写进文件了没有"和"运行时用上了没有"。本用例守三件事：
 *   1. 写成功且读面重建成功 → `applied: { ok: true }`；
 *   2. 写成功但读面重建失败 → **仍然 `ok: true`**（已保存），另给
 *      `applied: { ok: false, reason: REBUILD_FAILED }`（未应用），且读面明确降级；
 *   3. 同源 POST 原样透传 `applied`，GET 快照带 `plugin` 与 `editable`（页脚与可写面不靠猜）。
 *
 * 这里只走真实模块：发现层用一次性空 PATH，编辑器用内存替身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, DEVOPS_PLUGIN, FLOW_KEY, READ_ACTIONS, READER_KEY, SERVICE_KEY } from '../src/index.mjs';
import { ENV_KEYS } from '../src/runtime-config.mjs';
import { CLI_REASONS } from '../src/cli-config.mjs';
import { CLI_API_PREFIX, CLI_REQUEST_HEADER } from '../src/http.mjs';

const EXE = process.platform === 'win32' ? 'dop.exe' : 'dop';

function admitAllPolicy() {
  return {
    catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
    executeAction: async (ctx, action, exec, operation) => operation(),
  };
}

/** 假 configEditor：内存里维护 inherited/override 两层，`edit()` 记一次写。 */
function editor({ override = {}, inherited = {} } = {}) {
  const state = { override: { ...override }, inherited: { ...inherited }, edits: 0 };
  return {
    state,
    configuration() {
      return [
        {
          entry: { options: { id: 'forge-devops', name: 'forge-devops', config: {} } },
          inherited: { ...state.inherited },
          override: { ...state.override },
        },
      ];
    },
    async edit(_target, change) {
      state.edits += 1;
      state.override = { ...change({ ...state.override }, {}) };
    },
  };
}

function host({ webServer = null, configEditor = null, providers = {} } = {}) {
  const provided = new Map();
  const state = { failNextProvide: false };
  const ctx = {
    get: (key) => {
      if (Object.hasOwn(providers, key)) return providers[key];
      if (key === 'policy') return admitAllPolicy();
      if (key === 'webServer') return webServer;
      if (key === 'configEditor') return configEditor;
      return undefined;
    },
    provide: (key, value) => {
      if (state.failNextProvide) {
        state.failNextProvide = false;
        throw new Error('provide failed (simulated)');
      }
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    inject: () => () => {},
    tools: { register: () => () => {} },
  };
  return { ctx, provided, state };
}

function tempDir(files = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-devops-applied-'));
  for (const name of files) {
    const file = path.join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(file, 0o755);
  }
  return dir;
}

function withEnv(overrides, run) {
  const names = [...Object.values(ENV_KEYS), 'PATH', 'Path'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of Object.values(ENV_KEYS)) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: 0,
    headers,
    payload: '',
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.payload = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    },
  };
}

function mount(options) {
  const { ctx, provided, state } = host(options);
  apply(ctx, {});
  return { service: provided.get(SERVICE_KEY), hostState: state };
}

test('写成功 + 重建成功：applied.ok = true，快照带 plugin 与 editable', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const fake = editor();
      const { service } = mount({ configEditor: fake });
      const before = service.cliSnapshot();
      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });
      assert.equal(saved.ok, true);
      assert.deepEqual(saved.applied, { ok: true }, '写成功且读面已重建');
      assert.equal(saved.snapshot.plugin.name, DEVOPS_PLUGIN.name, '快照必须投影本包身份');
      assert.match(saved.snapshot.plugin.version, /^\d+\.\d+\.\d+/u, '版本来自本包 package.json');
      assert.deepEqual(saved.snapshot.editable, ['dopBin', 'timeoutMs'], '页面可写面只有两键');
      assert.equal(service.status(), 'ready', '保存后立刻生效');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写成功但重建失败：仍报已保存，另给 applied.ok=false + REBUILD_FAILED，读面降级', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      // 重建阶段抛错（模拟：重建时宿主 provide 失败 / 读面重建本身失败）。
      const fake = editor();
      const { service, hostState } = mount({ configEditor: fake });
      const before = service.cliSnapshot();
      hostState.failNextProvide = true;
      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });

      assert.equal(saved.ok, true, '写盘成功就是成功：不能因为重建失败把"已保存"抹掉');
      assert.equal(fake.state.edits, 1, '只写一次');
      assert.deepEqual(saved.applied, { ok: false, reason: CLI_REASONS.REBUILD_FAILED });
      assert.equal(service.status(), 'no-reader', '读面必须可见地降级，不能还报 ready');
      const status = service.cliStatus();
      assert.equal(status.ready, false);
      assert.equal(status.reason, CLI_REASONS.REBUILD_FAILED, '页面拿到的原因码与下一次工具调用同结论');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同源端点：GET 快照带 plugin/editable，POST 原样透传 applied', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      let route = null;
      const webServer = {
        register: (options) => {
          route = options;
          return () => {
            route = null;
          };
        },
      };
      const fake = editor();
      const { service } = mount({ webServer, configEditor: fake });
      assert.ok(route, 'webServer 在就必须挂上配置端点');
      assert.equal(route.path, CLI_API_PREFIX);
      assert.equal(route.kind, 'prefix');

      // GET：页面页脚需要的两件事都在快照里，不用自己猜。
      const getRes = fakeRes();
      await route.handler({ method: 'GET', url: `${CLI_API_PREFIX}/cli`, headers: {}, query: {} }, getRes);
      assert.equal(getRes.statusCode, 200);
      const readBody = JSON.parse(getRes.payload);
      assert.equal(readBody.plugin.name, DEVOPS_PLUGIN.name);
      assert.deepEqual(readBody.editable, ['dopBin', 'timeoutMs']);

      // POST：applied 由 service 给，路由只透传。
      const postRes = fakeRes();
      await route.handler(
        {
          method: 'POST',
          url: `${CLI_API_PREFIX}/cli`,
          headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
          body: JSON.stringify({ revision: readBody.revision, fields: { dopBin: target } }),
        },
        postRes,
      );
      assert.equal(postRes.statusCode, 200);
      const savedBody = JSON.parse(postRes.payload);
      assert.equal(savedBody.ok, true);
      assert.deepEqual(savedBody.applied, { ok: true }, 'POST 必须把 applied 原样交给页面');
      assert.equal(savedBody.snapshot.entries.dopBin.origin, 'config');
      assert.equal(service.status(), 'ready');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 三态（PR #215 review）：`applied` 只答"运行时用上了没有"，三种情况必须分开。
 *   - 已应用：运行面确由本次配置重建（无宿主注入）；
 *   - 无法确认：宿主注入了流程/读面，包内不重建它，不能替宿主宣布"已生效"；
 *   - 合法不可用：用户清除了最后一个入口，运行时按新配置变成"没有 CLI"，不是重建故障。
 */
test('宿主注入流程：写成功但 applied 明确 unverified，不降级宿主的读面', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const injectedFlow = {
        startFromChange: async () => ({ status: 'ready' }),
        describe: () => ({ configured: true, sourceType: 'enterprise' }),
        reader: { read: async () => ({ status: 'succeeded' }) },
      };
      const fake = editor();
      const { service } = mount({ configEditor: fake, providers: { [FLOW_KEY]: injectedFlow } });
      const before = service.cliSnapshot();
      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });

      assert.equal(saved.ok, true, '写盘成功就是成功');
      assert.equal(fake.state.edits, 1);
      assert.deepEqual(saved.applied, { ok: false, reason: CLI_REASONS.APPLY_UNVERIFIED }, '宿主流程是否用上新值不可知');
      assert.equal(saved.snapshot.entries.dopBin.path, target, '配置面确实换成了新值');
      // 宿主的读面仍归宿主：不能因为"无法确认"把它降级成 no-reader。
      assert.equal(service.status(), 'ready');
      assert.equal(service.cliStatus().ready, true);
      assert.notEqual(service.cliStatus().reason, CLI_REASONS.REBUILD_FAILED);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主注入只读适配器：包内流程重建了，但读面归属宿主，applied 仍是 unverified', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const injectedReader = { read: async () => ({ status: 'succeeded' }) };
      const fake = editor();
      const { service } = mount({ configEditor: fake, providers: { [READER_KEY]: injectedReader } });
      const before = service.cliSnapshot();
      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });

      assert.equal(saved.ok, true);
      assert.deepEqual(saved.applied, { ok: false, reason: CLI_REASONS.APPLY_UNVERIFIED });
      assert.equal(service.status(), 'ready', '注入的读面照旧工作');
      assert.equal(service.cliStatus().reason, null, '配置本身是就绪的，不装成故障');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('清除最后一个入口：合法不可用，applied 报已应用（active=false），不报重建失败', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const fake = editor({ override: { dopBin: target } });
      const { service } = mount({ configEditor: fake });
      // 装配期只读 loader 配置；页面行的两层要等一次刷新/保存才会重新合并（真实路径同此）。
      service.rediscover();
      assert.equal(service.cliStatus().ready, true, '刷新后 dop 入口是就绪的');

      const before = service.cliSnapshot();
      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: null } });

      assert.equal(saved.ok, true);
      assert.deepEqual(saved.applied, { ok: true, active: false }, '清除生效了：运行时现在明确"没有 CLI"');
      assert.equal(saved.snapshot.ready, false);
      assert.equal(saved.snapshot.entries.dopBin.path, null);
      assert.equal(service.status(), 'no-reader', '读面确实不可用（合法）');
      const status = service.cliStatus();
      assert.equal(status.ready, false);
      assert.equal(status.reason, CLI_REASONS.NOT_FOUND, '原因应是"没配置"，不是"重建失败"');
      // 就绪视图按同一份快照算：没有入口 → 来源 fixture、结论 incomplete（不是 fail）。
      assert.equal(saved.snapshot.readiness.sourceType, 'fixture');
      assert.equal(saved.snapshot.readiness.verdict, 'incomplete');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('继承层配置非法：保存成功但未应用，如实报 CLI_CONFIG_INVALID，不降级成重建失败', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const fake = editor({ inherited: { dopEndpoint: 'not-a-url' } });
      const { service } = mount({ configEditor: fake });
      const before = service.cliSnapshot();
      assert.equal(before.ready, false);

      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });

      assert.equal(saved.ok, true);
      assert.deepEqual(saved.applied, { ok: false, reason: CLI_REASONS.INVALID });
      assert.equal(service.status(), 'no-reader');
      assert.equal(service.cliStatus().reason, CLI_REASONS.INVALID, '页面看到的是真原因');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
