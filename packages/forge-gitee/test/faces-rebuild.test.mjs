/**
 * 可重建读面（T1 / TECHNICAL §3.3）：保存后立刻生效、刷新是唯一重读路径、路由挂载与降级。
 *
 * 这一组用例是"配置改了到底有没有生效"的机器证据：
 *   - `saveGiteeConfig()` 成功 → `applied.ok === true`，且**下一次工具调用**就用新 `cliPath`
 *     （不需要重启、不需要再点刷新——AC-9）；
 *   - 磁盘被别处改过时，未刷新前读面仍是旧值，`configSnapshot({refresh:true})` 之后才换；
 *   - `webServer` 缺失/注册冲突只影响页面（`route` 状态可见），工具面照常；
 *   - 卸载时路由与工具一起撤干净。
 *
 * 全部离线：宿主是 `helpers/fake-host.mjs` 的最小 ctx，`configEditor` 是内存假实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { GITEE_API_PREFIX, GITEE_CONFIG_ROUTE, GITEE_REQUEST_HEADER } from '../src/http.mjs';
import { GITEE_ENTRY_ID } from '../src/config-access.mjs';
import { GITEE_TOOLS } from '../src/gitee-tools.mjs';
import { createFakeHost, readPatch } from './helpers/fake-host.mjs';

const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const ONE = '/opt/gitee/bin/gh-one';
const TWO = '/opt/gitee/bin/gh-two';
const THREE = '/opt/gitee/bin/gh-three';

/** 假 `configEditor`：三层视图 + `edit` 写回内存。 */
function makeEditor({ override = {}, inherited = {} } = {}) {
  const entry = { options: { id: GITEE_ENTRY_ID, name: GITEE_ENTRY_ID, config: {} } };
  const state = { entry, override: { ...override }, inherited: { ...inherited }, edits: 0 };
  const editor = {
    documentPath: '/srv/qa/.dsh/profiles/qa/dsh.patch.yml',
    state,
    configuration: () => [{ entry: state.entry, inherited: { ...state.inherited }, override: { ...state.override } }],
    async edit(target, change) {
      state.edits += 1;
      state.override = { ...change({ ...state.override }, { ...state.inherited }) };
    },
  };
  return editor;
}

/** 假 `webServer`：只实现本插件用到的 `register({kind,path,handler})`。 */
function makeServer({ conflict = false } = {}) {
  const routes = [];
  const disposed = [];
  return {
    routes,
    disposed,
    register(spec) {
      if (conflict) throw new Error('duplicate route');
      routes.push(spec);
      return () => disposed.push(spec.path);
    },
  };
}

/** 按分发补丁层挂载（策略行 + 插件行），并返回宿主与已注入的可选服务。 */
async function mount({ editor = null, server = null } = {}) {
  const rows = await readPatch(PATCH_FILE);
  const [policyRow, pluginRow] = rows;
  const host = createFakeHost();
  const mountedPolicy = host.mountPolicy({ catalog: policyRow.catalog, audit: policyRow.audit });
  assert.equal(mountedPolicy.ok, true, `策略层挂载失败：${mountedPolicy.error?.message ?? ''}`);
  if (editor !== null) host.ctx.provide('configEditor', editor);
  if (server !== null) host.ctx.provide('webServer', server);
  const mounted = host.mount(apply, pluginRow.config, pluginRow.name);
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  return { host, mounted, service: host.services.get('gitee') };
}

const post = (server, payload) => {
  const route = server.routes[0];
  const res = { status: 0, headers: null, body: '' };
  return Promise.resolve(
    route.handler(
      {
        url: GITEE_CONFIG_ROUTE,
        method: 'POST',
        headers: { [GITEE_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      res,
    ),
  ).then(() => res);
};

test('AC-9: 保存成功即生效——下一次调用就用新 cliPath，无需重启或刷新', async () => {
  const editor = makeEditor({ override: { cliPath: ONE } });
  const { service } = await mount({ editor });

  assert.equal(service.adapter().describe().cliPathName, 'gh-one', '装配期读面用磁盘上的值');

  const saved = await service.saveGiteeConfig({
    revision: service.configSnapshot().revision,
    fields: { cliPath: TWO },
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.applied, { ok: true }, '保存与"已应用"是两个结论，这里两个都成立');
  assert.equal(editor.state.edits, 1);
  assert.equal(service.adapter().describe().cliPathName, 'gh-two', '读面已换页（AC-9）');
  assert.equal(service.configSnapshot().entries.cliPath.value, TWO);
});

test('AC-9: 磁盘被别处改过时，刷新是唯一的重读路径', async () => {
  const editor = makeEditor({ override: { cliPath: TWO } });
  const { service } = await mount({ editor });

  editor.state.override = { cliPath: THREE }; // 另一个进程改了 profile

  assert.equal(service.adapter().describe().cliPathName, 'gh-two', '未刷新前读面不动（不偷偷重读）');

  const refreshed = service.configSnapshot({ refresh: true });
  assert.equal(refreshed.entries.cliPath.value, THREE);
  assert.equal(service.adapter().describe().cliPathName, 'gh-three', '刷新后读面重建');
});

test('AC-9: ?refresh=1 经端点走同一条重建路径', async () => {
  const editor = makeEditor({ override: { cliPath: TWO } });
  const server = makeServer();
  const { service } = await mount({ editor, server });

  editor.state.override = { cliPath: THREE };
  const res = { status: 0, headers: null, body: '' };
  await server.routes[0].handler({ url: `${GITEE_CONFIG_ROUTE}?refresh=1`, method: 'GET' }, res);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).entries.cliPath.value, THREE);
  assert.equal(service.adapter().describe().cliPathName, 'gh-three');
});

test('AC-13/AC-15: 有 webServer 时注册同源端点，状态可见；POST 保存后 applied 透传', async () => {
  const editor = makeEditor({ override: { cliPath: ONE } });
  const server = makeServer();
  const { service } = await mount({ editor, server });

  assert.equal(service.configStatus().route, 'registered');
  assert.equal(server.routes.length, 1);
  assert.equal(server.routes[0].path, GITEE_API_PREFIX);
  assert.equal(server.routes[0].kind, 'prefix');
  assert.equal(typeof server.routes[0].handler, 'function');

  const res = await post(server, { revision: service.configSnapshot().revision, fields: { cliPath: TWO } });

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.applied, { ok: true });
  assert.equal(service.adapter().describe().cliPathName, 'gh-two');
});

test('AC-7: 没有 webServer 只影响页面（route=no-webserver），工具面照常 10 个', async () => {
  const { host, service } = await mount({ editor: makeEditor() });

  assert.equal(service.configStatus().route, 'no-webserver');
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(service.status(), 'ready');
});

test('AC-7: 路由注册冲突可见且不连累工具面', async () => {
  const { host, service } = await mount({ editor: makeEditor(), server: makeServer({ conflict: true }) });

  assert.equal(service.configStatus().route, 'conflict');
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(service.status(), 'ready');
});

test('AC-8: 无 configEditor 时端点仍可读，但写一律 503（不假装可写）', async () => {
  const server = makeServer();
  const { service } = await mount({ server });

  assert.equal(service.configStatus().writable.ok, false);
  const res = await post(server, { revision: '', fields: { cliPath: TWO } });
  assert.equal(res.status, 503);
});

test('卸载：路由与工具一起撤干净', async () => {
  const server = makeServer();
  const { host, mounted } = await mount({ editor: makeEditor(), server });

  mounted.teardown();

  assert.deepEqual(host.toolNames(), []);
  assert.deepEqual(server.disposed, [GITEE_API_PREFIX], '路由 disposer 必须被调用');
});

/* ------------------------------------------------------------------------- *
 * AC-9 / 安全边界：非法配置不得被"回落默认值"洗白                             *
 * ------------------------------------------------------------------------- */

/**
 * 落盘凭据自检用真的 `detectPersistentToken()`（`process.env` + 默认读文件），
 * 所以这里给它一个临时 `GH_CONFIG_DIR`，而不是改探针——探针被改过，测的就不是装配现场了。
 */
function withPersistentTokenFile(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gitee-cred-'));
  // 用明显的占位值：真令牌样例会被仓库的凭据扫描拦下，而探针只判「有没有值」。
  writeFileSync(join(dir, 'hosts.yml'), 'hosts:\n  gitee.com:\n    oauth_token: fixture-placeholder\n');
  const previous = process.env.GH_CONFIG_DIR;
  process.env.GH_CONFIG_DIR = dir;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('AC-9/AC-22: 刷新遇到非法配置 → 关读面并报错，不得把 persistentToken=block 降级成默认值', async () => {
  await withPersistentTokenFile(async () => {
    const editor = makeEditor({ override: { cliPath: ONE, persistentToken: 'block' } });
    const { service } = await mount({ editor });

    // 前提：落盘令牌 + block 策略 → 预检阻断（不调用 CLI 出口）。
    const blocked = service.preflight();
    assert.equal(blocked.ok, false, '有落盘令牌时 block 策略必须先阻断');
    assert.equal(blocked.reason, 'GITEE_PERSISTENT_TOKEN');

    // 覆盖层被别处改成非法值：快照报 GITEE_CONFIG_INVALID，且**不能**拿全默认投影重建读面。
    editor.state.override = { cliPath: ONE, persistentToken: 'block', timeoutMs: 10 };
    assert.throws(
      () => service.configSnapshot({ refresh: true }),
      (error) => error?.code === 'GITEE_REBUILD_FAILED',
      '刷新失败必须抛出可见错误',
    );

    // 读面已关闭：再问一次预检也只能拿到"不可用"，而不是降级后的 ok:true。
    assert.throws(
      () => service.preflight(),
      (error) => error?.code === 'GITEE_REBUILD_FAILED',
      '重建失败后读面必须是 null（fail-closed），不能继续用默认值',
    );
    assert.equal(service.configStatus().reason, 'GITEE_REBUILD_FAILED');
  });
});

test('AC-9/AC-22: 挂载时生效层非法 → 拒绝挂载，不得退回全默认配置', async () => {
  // 与"刷新"同一个洞：非法层让所有字段退化默认值，安全策略随之被悄悄放宽。
  // 挂载期就要失败——宁可不装，也不拿一份没有效力的配置去跑。
  const rows = await readPatch(PATCH_FILE);
  const host = createFakeHost();
  const mountedPolicy = host.mountPolicy({ catalog: rows[0].catalog, audit: rows[0].audit });
  assert.equal(mountedPolicy.ok, true, `策略层挂载失败：${mountedPolicy.error?.message ?? ''}`);
  host.ctx.provide('configEditor', makeEditor({ override: { cliPath: ONE, persistentToken: 'block', timeoutMs: 10 } }));

  const mounted = host.mount(apply, rows[1].config, rows[1].name);

  assert.equal(mounted.ok, false, '生效层非法时挂载必须失败');
  assert.equal(mounted.error?.code, 'GITEE_CONFIG_INVALID', '原因码要说清是配置不合法，而不是宿主不可用');
});
