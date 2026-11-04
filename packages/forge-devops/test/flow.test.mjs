import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDevopsFlow } from '../src/flow.mjs';
import { apply, FLOW_KEY, READ_ACTIONS, READ_REASONS, SERVICE_KEY } from '../src/index.mjs';
import { CLI_PAGE_HINT, CLI_REASONS } from '../src/cli-config.mjs';
import { CLI_ROUTE_PATH } from '../src/http.mjs';
import { ENV_KEYS } from '../src/runtime-config.mjs';

/**
 * 流程组合根（D-1 / r10）：`apply` 装配的正是这个工厂。这里用假 `execFile` 走一遍
 * 「配置 → runner → dop 适配器 → 只读面 → 上下文卡」，全程不 spawn 真实 CLI。
 *
 * r10 起本包没有写端口（`issueWrite` / `prWrite` 与 `gh` 侧适配器一并删除）：
 * 仓库 / Issue / PR 事实由 `@heluo/forge-gitee` 回答，`change_context` 只给 `unknown` +
 * `REPO_FACTS_EXTERNAL` + 下一步。因此这里既断言"写端口不存在"，也断言卡片不再猜仓库。
 */

const CHANGE = {
  id: 'ARD123456',
  title: '积分商城改造',
  status: 'in_progress',
  type: 'requirement',
  owner: 'hosea',
  description: '积分商城支持兑换券',
  acceptance_criteria: ['兑换券可抵扣', '失败可重试'],
  created_at: '2026-10-20T00:00:00Z',
  sub_systems: [{ code: 'points-mall', name: '积分商城' }],
  user_stories: [{ id: 'US-10001', title: '兑换券抵扣', release_info: { release_num: 'R20261020001' } }],
};

const CONFIG = Object.freeze({
  dopBin: '/opt/fake/dop',
  dopEndpoint: 'https://dop.example.invalid',
  sourceType: 'mock',
  timeoutMs: 20000,
});

/** 假 `execFile`：按固定 argv 形状回放，记录每次调用；回调式与 cli-runner 的兼容路径一致。 */
function fakeCli() {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    const payload = joined.startsWith('change view ') ? JSON.stringify(CHANGE) : 'null';
    process.nextTick(() => callback(null, `${payload}\n`, ''));
  };
  return { calls, execFile };
}

const now = () => '2026-10-28T12:00:00.000Z';

test('配置齐全时 startFromChange 产出卡：只取 dop 一条事实，承建仓库段是外部指引', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready', 'dop 事实齐全即可推进：仓库事实外部化不再把卡打成 blocked');
  assert.equal(result.changeId, 'ARD123456');
  assert.equal(result.context.change.changeId, 'ARD123456');
  assert.equal(result.context.change.releaseInfo.value.releaseNum, 'R20261020001', '排期取 release_info 首个非空');
  assert.equal(result.building.status, 'unknown');
  assert.equal(result.building.reason, 'REPO_FACTS_EXTERNAL');
  assert.equal(result.building.selected, null);
  assert.deepEqual(result.building.candidates, []);
  assert.deepEqual(result.unknowns, [], '仓库事实不算"读失败"，它是别人的事实');
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(' ')),
    ['change view'],
    '取数只走固定 argv：一条变更，不再有仓库 / 关联对象扫描',
  );
  assert.match(result.text, /上下文卡/u);
  assert.match(result.text, /REPO_FACTS_EXTERNAL/u);
  assert.match(result.text, /forge_gitee_repository_read/u);
});

test('未配置运行时环境：产出 blocked 卡、未知项点名 CONFIG_MISSING，且零子进程调用', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ env: {}, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true, '流程面仍可达：不抛异常，把原因写进卡里');
  assert.equal(result.status, 'blocked');
  assert.equal(result.context.change, null);
  assert.equal(result.config.dopBin, false, '只报"配没配"，不回显路径或 endpoint');
  assert.deepEqual(result.unknowns.map((item) => item.field), ['dop.change.view']);
  assert.ok(result.unknowns.every((item) => item.reason === 'CONFIG_MISSING'));
  assert.equal(calls.length, 0, '未配置时不得发起任何子进程（AC-22）');
});

test('写端口已随模块删除：flow 只暴露读面与聚合读，不再有跨平台写入口', async () => {
  const { execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  assert.equal(typeof flow.startFromChange, 'function');
  assert.equal(typeof flow.context, 'function');
  assert.equal(flow.issueWrite, undefined, 'Issue 写在 forge-gitee');
  assert.equal(flow.prWrite, undefined, 'PR 写在 forge-gitee');
  assert.equal(flow.reader !== null && typeof flow.reader.read === 'function', true);
});

test('非法变更号早退：不取数、不绑定', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  for (const input of [undefined, '', '两个 号', 'x']) {
    const result = await flow.startFromChange({ changeId: input });
    assert.equal(result.ok, false, `${String(input)} 应被拒绝`);
    assert.equal(result.reason, 'MISSING_OR_INVALID');
  }
  assert.equal(calls.length, 0);
  assert.equal(flow.describe().configured, true);
});

/* ------------------------------------------------------------------------------------------------
 * r9 / M2：刷新重建读面（AC-6 / AC-7 / AC-8 / AC-9 / AC-10）
 *
 * 这一组走**装配层**（`apply` + 真 `cli-access` + 真 `execFile`）：刷新是"发现 → 重建读面 →
 * 用同一份结果出响应"的三段式，只有把三段接起来才能证明。分级断言各自通过也可能是断的——
 * 比如"只重扫不重建"：响应里已是新路径，下一次工具调用却仍按旧 argv spawn。
 * PATH 换成一次性目录；`dop` 用 POSIX shell 桩记录真实 spawn 的 `$0 $*`（Windows 跳过）。
 * ---------------------------------------------------------------------------------------------- */

const EXE = process.platform === 'win32' ? 'dop.exe' : 'dop';
const READ_CHANGE = Object.freeze({ action: 'change.read', target: 'ARD123456' });

/** 只读门禁替身：目录覆盖本包的读动作且已开放，admission 直接承认并执行。 */
const readPolicy = () => ({
  catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
  executeAction: async (ctx, action, exec, operation) => operation(),
});

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'forge-devops-refresh-'));

/** `dop` 桩：每次真实 spawn 追加一行 `$0 $*`，再回放一条变更 JSON（退出码 0）。 */
function writeShim(dir, logPath) {
  const file = path.join(dir, EXE);
  const payload = JSON.stringify({ id: 'ARD123456', status: 'in_progress', title: '刷新用例' });
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${logPath}'\nprintf '%s\\n' '${payload}'\n`,
    'utf8',
  );
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

const spawnLog = (logPath) => {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
};

/**
 * 进程环境替换：清掉四个 CLI 键并换 PATH（两个拼法都换），结束后原样还原。
 * 必须 `await run()`：同步的 try/finally 会在第一个 await 处就还原环境，后续刷新又会读到旧 PATH。
 */
async function withEnv(overrides, run) {
  const names = [...Object.values(ENV_KEYS), 'PATH', 'Path'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of Object.values(ENV_KEYS)) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

/**
 * 最小宿主 + 挂载。`flags.failFlowProvide` 用来在**重建提交点**注入故障：
 * `buildFlow()` 需要真实环境异常才抛，而"提交时抛错"走的正是同一条 catch（`refreshSnapshot`）。
 */
function mount({ webServer = null, config = {} } = {}) {
  const provided = new Map();
  const routes = [];
  const flags = { failFlowProvide: false };
  const ctx = {
    get: (key) => {
      if (key === 'policy') return readPolicy();
      if (key === 'webServer') return webServer;
      return undefined;
    },
    provide: (key, value) => {
      if (flags.failFlowProvide === true && key === FLOW_KEY) throw new Error('重建阶段故障（用例注入）');
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    inject: () => () => {},
  };
  apply(ctx, config);
  return { provided, routes, flags, service: provided.get(SERVICE_KEY) };
}

const webHost = () => {
  const routes = [];
  return { routes, webServer: { register: (route) => (routes.push(route), () => {}) } };
};

test('刷新单点：改名后一次刷新即重建读面，响应与下一次 spawn 都用新路径（AC-6/7①/8）', { skip: process.platform === 'win32' }, async () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const logPath = path.join(tempDir(), 'calls.log');
  writeShim(dirA, logPath);
  try {
    await withEnv({ PATH: dirA, Path: dirA }, async () => {
      const { provided, service } = mount();
      assert.equal(service.status(), 'ready');
      assert.equal(service.cliSnapshot().entries.dopBin.path, path.join(dirA, EXE));

      const first = await service.read(READ_CHANGE);
      assert.equal(first.status, 'succeeded');
      assert.deepEqual(spawnLog(logPath), [`${path.join(dirA, EXE)} change view ARD123456 --json`]);

      // 改名/移动：旧目录里没有 dop 了，新目录里有——刷新必须既重扫又重建。
      const beforeFlow = provided.get(FLOW_KEY);
      renameSync(path.join(dirA, EXE), path.join(dirB, EXE));
      await withEnv({ PATH: dirB, Path: dirB }, async () => {
        const refreshed = service.cliSnapshot({ refresh: true });
        assert.equal(refreshed.entries.dopBin.path, path.join(dirB, EXE), '响应即新路径');
        assert.equal(refreshed.ready, true);
        assert.notEqual(provided.get(FLOW_KEY), beforeFlow, '重建先于响应：对外提供的协作者已换新实例');
        assert.equal(spawnLog(logPath).length, 1, 'AC-9：刷新只读目录，不 spawn');

        const second = await service.read(READ_CHANGE);
        assert.equal(second.status, 'succeeded');
        assert.equal(
          spawnLog(logPath).at(-1),
          `${path.join(dirB, EXE)} change view ARD123456 --json`,
          'AC-7①：下一次 execFile 的 argv[0] 就是新路径',
        );

        // AC-9 幂等：同一份磁盘内容再刷新一次，页面 revision 不跳（unchanged 面 steady）。
        const again = service.cliSnapshot({ refresh: true });
        assert.equal(again.revision, refreshed.revision);
        assert.equal(again.entries.dopBin.path, path.join(dirB, EXE));
        assert.equal(spawnLog(logPath).length, 2, '刷新本身永远不产生子进程');
      });
    });
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('刷新后不可发现：读面 ready:false，read 以 NO_READER 失败且不按旧路径 spawn（AC-7②/AC-10）', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const logPath = path.join(tempDir(), 'calls.log');
  const exe = writeShim(dir, logPath);
  try {
    await withEnv({ PATH: dir, Path: dir }, async () => {
      const { service } = mount();
      assert.equal(service.status(), 'ready');
      await service.read(READ_CHANGE);
      const before = spawnLog(logPath).length;

      rmSync(exe);
      const refreshed = service.cliSnapshot({ refresh: true });
      assert.equal(refreshed.ready, false, '刷新后再没有可用命令行');
      assert.equal(refreshed.entries.dopBin.path, null);

      await assert.rejects(service.read(READ_CHANGE), (error) => {
        assert.equal(error.code, READ_REASONS.NO_READER, '原因码不加码（工具信封与既有用例一致）');
        assert.equal(error.detail.reason, CLI_REASONS.NOT_FOUND);
        assert.equal(error.detail.next, CLI_PAGE_HINT);
        return true;
      });
      assert.equal(spawnLog(logPath).length, before, '绝不再按旧路径 spawn 一次');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重建抛错：结构化 500 + 明确降级，与下一次工具调用同结论，故障消失后自动恢复（AC-10）', async () => {
  const empty = tempDir();
  try {
    await withEnv({ PATH: empty, Path: empty }, async () => {
      const { routes, webServer } = webHost();
      const { provided, flags, service } = mount({ webServer });
      assert.equal(routes.length, 1, 'route 已注册：页面走的就是它');

      flags.failFlowProvide = true;
      assert.throws(() => service.cliSnapshot({ refresh: true }), (error) => {
        assert.equal(error.code, CLI_REASONS.REBUILD_FAILED);
        assert.equal(error.detail.reason, CLI_REASONS.REBUILD_FAILED);
        assert.equal(error.detail.next, CLI_PAGE_HINT);
        assert.equal(error.message.includes(empty), false, '文案不得回显被扫描的目录');
        return true;
      });

      // 降级态：读面明确不可用，且与工具结论一致（不保留"上次看起来还行"的旧引用）。
      assert.equal(provided.has(FLOW_KEY), false, '降级时撤掉流程引用');
      assert.equal(service.status(), 'no-reader');
      const status = service.cliStatus();
      assert.equal(status.ready, false);
      assert.equal(status.reason, CLI_REASONS.REBUILD_FAILED);
      assert.equal(status.guidance.includes(CLI_PAGE_HINT), true);

      await assert.rejects(service.read(READ_CHANGE), (error) => {
        assert.equal(error.code, READ_REASONS.NO_READER);
        assert.equal(error.detail.reason, CLI_REASONS.REBUILD_FAILED);
        assert.equal(error.detail.next, CLI_PAGE_HINT);
        return true;
      });
      // 聚合读与只读面同结论：流程不可用时显式拒绝，而不是返回半张卡。
      await assert.rejects(service.context({ target: 'ARD123456' }), (error) => {
        assert.equal(error.code, 'FLOW_UNAVAILABLE', '聚合读显式不可用且零调用');
        return true;
      });

      const res = fakeRes();
      await routes[0].handler({ url: `${CLI_ROUTE_PATH}?refresh=1`, method: 'GET', headers: {} }, res);
      assert.equal(res.statusCode, 500);
      const payload = JSON.parse(res.payload);
      assert.equal(payload.code, 'CLI_SNAPSHOT_FAILED');
      assert.deepEqual(payload.detail, { reason: CLI_REASONS.REBUILD_FAILED, next: CLI_PAGE_HINT });
      assert.equal(res.payload.includes(empty), false, '500 响应里零路径');

      // 故障消失：同一条刷新路径可恢复，不把降级态写死。
      flags.failFlowProvide = false;
      service.cliSnapshot({ refresh: true });
      assert.equal(provided.has(FLOW_KEY), true, '恢复后重新提供协作者');
      assert.notEqual(service.cliStatus().reason, CLI_REASONS.REBUILD_FAILED);
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
