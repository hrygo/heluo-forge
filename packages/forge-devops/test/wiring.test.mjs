/**
 * 装配层用例（AC-5 / AC-14 的机器证据）：
 *   - 装配期只做一次三层合并，`ready` 与否都不改工具面（仍是 9 个）；
 *   - 未命中时 fail closed，但原因码不加码（NO_READER），细因/已查类别/页面指引放 detail，
 *     文案里**没有盘符、没有 URL、没有路径**；
 *   - 配置页快照（含路径）与脱敏描述是两个函数，脱敏面永远不含路径；
 *   - `webServer` / `configEditor` / `inject` 都是可选服务：缺失、晚到、前缀冲突都不塌装配。
 *
 * 这些用例只走真实模块（发现用的是注入不了的真 fs/PATH），因此每个用例都把 PATH 换成
 * 一次性的空目录 / 单文件目录：只验证**装配层的接线**，发现规则本身归 `cli-discovery.test.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  apply,
  Config,
  READ_ACTIONS,
  READ_REASONS,
  SERVICE_KEY,
} from '../src/index.mjs';
import { ConfigStandard, ENV_KEYS } from '../src/runtime-config.mjs';
import { CLI_FIELDS, CLI_ORIGINS, CLI_PAGE_HINT, CLI_REASONS } from '../src/cli-config.mjs';
import { CLI_API_PREFIX, CLI_REQUEST_HEADER, CLI_ROUTE_PATH } from '../src/http.mjs';

const EXE = process.platform === 'win32' ? 'dop.exe' : 'dop';

/** FIX-02 挂载合约替身：目录覆盖四个读动作且已开放，admission 直接承认并执行。 */
function admitAllPolicy() {
  return {
    catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
    executeAction: async (ctx, action, exec, operation) => operation(),
  };
}

/** 最小宿主替身：`policy` 必给；其余服务按用例决定在不在，`inject` 只记下来由用例手动点火。 */
function host({ policy = admitAllPolicy(), webServer = null, configEditor = null, withTools = true } = {}) {
  const provided = new Map();
  const toolNames = [];
  const injections = [];
  const ctx = {
    get: (key) => {
      if (key === 'policy') return policy;
      if (key === 'webServer') return webServer;
      if (key === 'configEditor') return configEditor;
      return undefined;
    },
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    inject: (deps, callback) => {
      injections.push({ deps, callback });
      return () => {};
    },
  };
  if (withTools) {
    ctx.tools = {
      register: (definition) => {
        toolNames.push(definition.name);
        return () => {};
      },
    };
  }
  return { ctx, provided, toolNames, injections };
}

/** 假 configEditor：只实现 `configuration()` / `edit()`，`override` 就是"补丁层里已写的值"。 */
function editor({ override = {} } = {}) {
  const state = { override: { ...override }, edits: 0 };
  return {
    state,
    configuration() {
      return [
        {
          entry: { options: { id: 'forge-devops', name: 'forge-devops', config: {} } },
          inherited: {},
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

/** 临时目录：`files` 里的名字写成可直接执行的文件（非 Windows 补执行位）。 */
function tempDir(files = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-devops-wiring-'));
  for (const name of files) {
    const file = path.join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(file, 0o755);
  }
  return dir;
}

/** 进程环境的可控替换：用例结束后原样还原（PATH 两个拼法都改，Windows 上两种都见过）。 */
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

/** 挂载并取服务本体：`apply()` 的返回值是卸载函数（与 forge-policy 一致）。 */
function mount(options = {}) {
  const { ctx, provided, toolNames, injections } = host(options);
  apply(ctx, options.config ?? {});
  return { ctx, provided, toolNames, injections, service: provided.get(SERVICE_KEY) };
}

/** 假 Node 响应：只实现 `writeResponse` 用到的三个成员。 */
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

test('未命中：工具仍是 9 个，read 以 NO_READER 失败并给配置页指引（无盘符/无 URL/无路径）', async () => {
  const empty = tempDir();
  try {
    await withEnv({ PATH: empty, Path: empty }, async () => {
      const { service, toolNames } = mount();
      assert.equal(toolNames.length, 9, 'AC-14：工具面仍是 9 个');
      assert.equal(service.toolNames().length, 9);
      assert.equal(service.status(), 'no-reader', '未命中必须 fail closed');
      assert.equal(service.cliStatus().ready, false);

      await assert.rejects(service.read({ action: 'change.read', target: 'CHG-1' }), (error) => {
        assert.equal(error.code, READ_REASONS.NO_READER, 'AC-14：原因码不加码');
        assert.equal(error.detail.reason, CLI_REASONS.NOT_FOUND);
        assert.equal(error.detail.next, CLI_PAGE_HINT);
        assert.ok(Array.isArray(error.detail.searched) && error.detail.searched.length > 0);
        assert.ok(error.message.includes(CLI_PAGE_HINT), '文案必须指向配置页（AC-5）');
        assert.doesNotMatch(error.message, /[A-Za-z]:\\/u, 'AC-10：文案不得出现盘符');
        assert.doesNotMatch(error.message, /https?:/iu, 'AC-10：文案不得出现 URL');
        assert.equal(error.message.includes(empty), false, 'AC-10：文案不得回显扫描过的目录');
        return true;
      });
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('三层合并：环境变量兜底命中 → 流程可用、origin=env，工具数不变', async () => {
  const dir = tempDir([EXE]);
  try {
    const exe = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir(), [ENV_KEYS.dopBin]: exe }, async () => {
      const { service, toolNames } = mount();
      const status = service.cliStatus();
      assert.equal(status.ready, true, '环境变量层必须能把流程拉起来');
      assert.equal(service.status(), 'ready');
      assert.equal(status.entries.dopBin.origin, CLI_ORIGINS.ENV);
      assert.equal(toolNames.length, 9);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('三层合并：配置层压过环境变量 → origin=config（不静默）', async () => {
  const dir = tempDir([EXE]);
  try {
    const configured = path.join(dir, EXE);
    await withEnv({ PATH: dir, Path: dir, [ENV_KEYS.dopBin]: '/opt/other/dop' }, async () => {
      // 装配期的配置层就是 loader 读到的补丁配置（配置页保存后由 `access` 重新合并成同一层）。
      const { service } = mount({ config: { dopBin: configured } });
      const status = service.cliStatus();
      assert.equal(status.ready, true);
      assert.equal(status.entries.dopBin.origin, CLI_ORIGINS.CONFIG);
      // 被压过的层必须可见（页面挂「覆盖环境变量」Tag 的机器证据）。
      assert.ok(status.entries.dopBin.overrides.includes(CLI_ORIGINS.ENV));
      assert.equal(service.cliSnapshot().entries.dopBin.path, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('零配置：PATH 上发现 → origin=discovered、流程可用', async () => {
  const dir = tempDir([EXE]);
  try {
    await withEnv({ PATH: dir, Path: dir }, async () => {
      const { service, toolNames } = mount();
      const status = service.cliStatus();
      assert.equal(status.ready, true, 'AC-2：装好就能用');
      assert.equal(status.entries.dopBin.origin, CLI_ORIGINS.DISCOVERED);
      assert.equal(service.status(), 'ready');
      assert.equal(toolNames.length, 9, 'AC-14：发现命中与否都不改工具面');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('路径回显边界：快照含路径、脱敏描述不含路径（两个函数，不是同一个开关）', async () => {
  const dir = tempDir([EXE]);
  try {
    const configured = path.join(dir, EXE);
    await withEnv({ PATH: dir, Path: dir }, async () => {
      const { service } = mount({ config: { dopBin: configured } });
      const described = service.cliStatus();
      assert.equal(described.entries.dopBin.configured, true);
      assert.equal(JSON.stringify(described).includes(configured), false, 'AC-10：脱敏面不得含路径');
      assert.equal(JSON.stringify(described).includes(dir), false);
      // 同一份数据里六字段都在，说明是"换了投影"而不是"少了字段"。
      assert.deepEqual(Object.keys(described.entries).sort(), [...CLI_FIELDS].sort());
      assert.equal(service.cliSnapshot().entries.dopBin.path, configured);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保存：revision 栅栏命中时写一次，陈旧 revision 不写盘', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const fake = editor();
      const { service } = mount({ configEditor: fake });
      const before = service.cliSnapshot();
      assert.equal(before.writable.ok, true, '有条目 + 有 edit 才可写');

      const saved = await service.saveCliConfig({ revision: before.revision, fields: { dopBin: target } });
      assert.equal(saved.ok, true);
      assert.equal(saved.snapshot.entries.dopBin.origin, CLI_ORIGINS.CONFIG);
      assert.equal(saved.snapshot.entries.dopBin.path, target);
      assert.notEqual(saved.snapshot.revision, before.revision);
      assert.equal(fake.state.edits, 1);
      assert.equal(service.status(), 'ready', '保存后立刻重新合并，不必重启');

      const stale = await service.saveCliConfig({ revision: before.revision, fields: { ghOwner: 'heluo' } });
      assert.equal(stale.ok, false);
      assert.equal(stale.code, CLI_REASONS.CONFLICT);
      assert.equal(fake.state.edits, 1, 'AC-9：陈旧 revision 不得写盘');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同源端点：webServer 在 → prefix /api/forge-devops，GET 200 + no-store，写要预检头', async () => {
  const dir = tempDir([EXE]);
  try {
    const target = path.join(dir, EXE);
    await withEnv({ PATH: tempDir(), Path: tempDir() }, async () => {
      const routes = [];
      const webServer = {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      };
      const { service } = mount({ webServer, configEditor: editor() });
      assert.equal(routes.length, 1);
      assert.equal(routes[0].kind, 'prefix');
      assert.equal(routes[0].path, CLI_API_PREFIX);
      assert.equal(service.cliStatus().route, 'registered');

      const res = fakeRes();
      await routes[0].handler({ url: CLI_ROUTE_PATH, method: 'GET', headers: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      const snapshot = JSON.parse(res.payload);
      assert.equal(snapshot.writable.ok, true);

      // 缺少预检头 → 400；补上 → 200，且 revision 前进（页面保存走的就是这条路径）。
      const denied = fakeRes();
      await routes[0].handler(
        {
          url: CLI_ROUTE_PATH,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision: snapshot.revision, fields: { dopBin: target } }),
        },
        denied,
      );
      assert.equal(denied.statusCode, 400);

      const accepted = fakeRes();
      await routes[0].handler(
        {
          url: CLI_ROUTE_PATH,
          method: 'POST',
          headers: { 'content-type': 'application/json', [CLI_REQUEST_HEADER]: '1' },
          body: JSON.stringify({ revision: snapshot.revision, fields: { dopBin: target } }),
        },
        accepted,
      );
      assert.equal(accepted.statusCode, 200);
      assert.equal(JSON.parse(accepted.payload).snapshot.entries.dopBin.path, target);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('可选服务：webServer 缺失/晚到/前缀冲突都不塌装配，注册幂等', async () => {
  const empty = tempDir();
  try {
    await withEnv({ PATH: empty, Path: empty }, async () => {
      // 1) 装配时没有 webServer：照常挂载，状态可见。
      const first = mount();
      assert.equal(first.service.cliStatus().route, 'no-webserver');
      assert.equal(first.toolNames.length, 9);
      assert.equal(first.injections.length, 1);
      assert.deepEqual(first.injections[0].deps, ['webServer']);

      // 2) 晚到：注入回调点火一次即注册；再点火不重复注册。
      const routes = [];
      const webServer = { register: (route) => (routes.push(route), () => {}) };
      const late = { get: (key) => (key === 'webServer' ? webServer : undefined) };
      first.injections[0].callback(late);
      assert.equal(routes.length, 1);
      first.injections[0].callback(late);
      assert.equal(routes.length, 1, '注册必须幂等');
      assert.equal(first.service.cliStatus().route, 'registered');

      // 3) 前缀冲突：别的插件已占了同一段 → 不抛，状态记 conflict（页面显示端点不可用）。
      const conflicted = mount({
        webServer: {
          register: () => {
            throw new Error('duplicate prefix');
          },
        },
      });
      assert.equal(conflicted.service.cliStatus().route, 'conflict');
      assert.equal(conflicted.toolNames.length, 9);
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('Config：导出的是 runtime-config 的 standard schema，非法值给 issues 而不是抛错', () => {
  assert.equal(Config, ConfigStandard);
  assert.equal(Config['~standard'].version, 1);
  assert.deepEqual(Config['~standard'].validate({}), { value: {} });

  const bad = Config['~standard'].validate({ timeoutMs: 'abc', nope: 1 });
  assert.ok(Array.isArray(bad.issues) && bad.issues.length >= 2);
  assert.ok(bad.issues.some((issue) => issue.path?.[0] === 'timeoutMs'));
  assert.ok(bad.issues.some((issue) => issue.path?.[0] === 'nope'));
});
