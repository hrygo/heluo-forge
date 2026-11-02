import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDevopsFlow } from '../src/flow.mjs';
import { FLOW_ACTIONS } from '../src/tools.mjs';
import { apply, FLOW_KEY, FLOW_REASONS, READ_ACTIONS, READ_REASONS, SERVICE_KEY } from '../src/index.mjs';
import { CLI_PAGE_HINT, CLI_REASONS } from '../src/cli-config.mjs';
import { CLI_ROUTE_PATH } from '../src/http.mjs';
import { ENV_KEYS } from '../src/runtime-config.mjs';

/**
 * 流程组合根（D-1）：`apply` 装配的正是这个工厂。这里用假 `execFile` 走一遍
 * 「配置 → runner → dop/gh → 承建判定 → 上下文卡」与写动作前置，全程不 spawn 真实 CLI。
 *
 * 后面两组用例专测 r6 的**三段仓库**（`org/group/repo`，企业 Gitee 命名空间）：
 * 承建判定与评论目标都保留完整路径，同组兄弟仓库 / 另一命名空间 / 折叠成两段都必须拒绝。
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

const REPO = { name: 'points-mall', nameWithOwner: 'acme/points-mall', description: '积分商城', url: 'https://example.invalid/acme/points-mall' };

const CONFIG = Object.freeze({
  dopBin: '/opt/fake/dop',
  dopEndpoint: 'https://dop.example.invalid',
  ghBin: 'gh',
  ghOwner: 'acme',
  sourceType: 'mock',
  timeoutMs: 20000,
});

/** 假 `execFile`：按固定 argv 形状回放，记录每次调用；回调式与 cli-runner 的兼容路径一致。 */
function fakeCli() {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    let payload = 'null';
    if (joined.startsWith('change view ')) payload = JSON.stringify(CHANGE);
    else if (joined.startsWith('repo list ')) payload = JSON.stringify([REPO]);
    else if (joined.startsWith('issue list ')) payload = '[]';
    else if (joined.startsWith('pr list ')) payload = '[]';
    process.nextTick(() => callback(null, `${payload}\n`, ''));
  };
  return { calls, execFile };
}

const policyStub = {
  catalog: new Map(),
  executeAction: async () => {
    throw new Error('本用例不应走到门禁');
  },
};

const now = () => '2026-10-28T12:00:00.000Z';

test('配置齐全时 startFromChange 产出 ready 上下文卡：dop/gh 各一次、承建判定不猜', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.changeId, 'ARD123456');
  assert.equal(result.context.change.changeId, 'ARD123456');
  assert.equal(result.context.change.releaseInfo.value.releaseNum, 'R20261020001', '排期取 release_info 首个非空');
  assert.equal(result.building.status, 'resolved');
  assert.equal(result.building.selected, 'acme/points-mall');
  assert.deepEqual(result.unknowns, []);
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(' ')),
    ['change view', 'repo list', 'issue list', 'pr list'],
    '取数只走固定 argv：一条变更、一次仓库清单、两轮关联对象',
  );
  assert.match(result.text, /上下文卡/u);
  assert.match(result.text, /acme\/points-mall/u);
});

test('未配置运行时环境：产出 blocked 卡、未知项点名 CONFIG_MISSING，且零子进程调用', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ env: {}, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true, '流程面仍可达：不抛异常，把原因写进卡里');
  assert.equal(result.status, 'blocked');
  assert.equal(result.context.change, null);
  assert.equal(result.config.dopBin, false, '只报"配没配"，不回显路径或 endpoint');
  assert.deepEqual(result.unknowns.map((item) => item.field), ['dop.change.view', 'gh.repository.list']);
  assert.ok(result.unknowns.every((item) => item.reason === 'CONFIG_MISSING'));
  assert.equal(calls.length, 0, '未配置时不得发起任何子进程（AC-22）');
});

test('写动作前置：未绑定变更号、无门禁、无配置都在子进程之前 denied', async () => {
  const { calls, execFile } = fakeCli();
  const unbound = createDevopsFlow({ config: CONFIG, policy: policyStub, execFile, now });
  const missing = await unbound.issueWrite({ op: 'create', target: 'acme/points-mall', title: '[ARD123456] 实现' });
  assert.equal(missing.status, 'denied');
  assert.equal(missing.reason, 'MISSING_CHANGE_ID');

  const noPolicy = createDevopsFlow({ config: CONFIG, execFile, now });
  await noPolicy.startFromChange({ changeId: 'ARD123456' });
  const ungated = await noPolicy.prWrite({ op: 'create', target: 'acme/points-mall', head: 'feat/x', base: 'main', title: '[ARD123456] 实现' });
  assert.equal(ungated.status, 'denied');
  assert.equal(ungated.reason, 'POLICY_REQUIRED');

  const unconfigured = createDevopsFlow({ env: {}, policy: policyStub, execFile, now });
  await unconfigured.startFromChange({ changeId: 'ARD123456' });
  const nowhere = await unconfigured.issueWrite({ op: 'comment', target: 'acme/points-mall#12', body: '审查意见' });
  assert.equal(nowhere.status, 'denied');
  assert.equal(nowhere.reason, 'CONFIG_MISSING');
  assert.equal(nowhere.calls, 0);
  assert.equal(calls.length, 4, '只有第一次配置齐全的取数发生调用，写动作全部零下游');
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

/* -------------------------------------------------------------------------------------------------
 * 三段仓库（`org/group/repo`）：承建判定、评论目标与门禁核对都按**完整路径**比对。
 * 夹具是 mock（离线 argv 回放），不是企业实测。
 * ----------------------------------------------------------------------------------------------- */

const CHANGE3 = {
  id: 'ARD654321',
  title: '三段命名空间仓库改造',
  status: 'in_progress',
  type: 'requirement',
  owner: 'hosea',
  description: 'org/group/repo 形态下的写路径核对',
  acceptance_criteria: ['评论可写入', '不一致必须拒绝'],
  created_at: '2026-10-20T00:00:00Z',
  sub_systems: [{ code: 'demo', name: '演示' }],
  user_stories: [{ id: 'US-20002', title: '评论核对', release_info: { release_num: 'R20261030002' } }],
};

const REPO3 = {
  name: 'demo',
  nameWithOwner: 'acme/group/demo',
  description: '演示仓库',
  url: 'https://example.invalid/acme/group/demo',
};

const PR3 = {
  number: 12,
  title: 'feat: 演示',
  state: 'OPEN',
  url: 'https://example.invalid/acme/group/demo/pull/12',
  updatedAt: '2026-10-29T00:00:00Z',
  headRefName: 'feat/x',
  baseRefName: 'main',
  isDraft: false,
  mergedAt: null,
};

const COMMENT_URL = 'https://example.invalid/acme/group/demo/pull/12#issuecomment-9001';

/**
 * 假 `execFile`（三段仓库版）：比 `fakeCli` 多一条 `pr view` / `pr comment` 通道——
 * 评论写下去之后回读能看到自己，写动作才能真正走到 `done`，而不是停在"查重/回读失败"。
 */
function fakeCliWithPr() {
  const calls = [];
  const posted = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    let payload = 'null';
    if (joined.startsWith('change view ')) payload = JSON.stringify(CHANGE3);
    else if (joined.startsWith('repo list ')) payload = JSON.stringify([REPO3]);
    else if (joined.startsWith('issue list ')) payload = '[]';
    else if (joined.startsWith('pr list ')) payload = '[]';
    else if (joined.startsWith('pr view ')) payload = JSON.stringify({ ...PR3, comments: [...posted] });
    else if (joined.startsWith('pr comment ')) {
      const body = args[args.indexOf('--body') + 1] ?? '';
      posted.push({ id: '9001', body, url: COMMENT_URL, author: { login: 'reviewer' }, createdAt: '2026-10-30T08:00:00Z' });
      payload = COMMENT_URL;
    }
    process.nextTick(() => callback(null, `${payload}\n`, ''));
  };
  return { calls, execFile, posted };
}

/** 放行门禁桩：只记录"门禁看到了什么"，然后照常执行下游（不改动被审计的判定）。 */
function passingGuard() {
  const seen = [];
  return {
    seen,
    execute: async (request, operation) => {
      seen.push({ action: request.action, target: request.target, arguments: request.arguments });
      return { status: 'done', value: await operation() };
    },
  };
}

test('三段仓库的 PR 评论：完整路径与承建仓库一致时放行，且目标一字不改地走到命令面', async () => {
  const { calls, execFile, posted } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  const bound = await flow.startFromChange({ changeId: 'ARD654321' });
  assert.equal(bound.building.status, 'resolved');
  assert.equal(bound.building.selected, 'acme/group/demo', '三段仓库保留完整命名空间，不折成两段');

  const before = calls.length;
  const result = await flow.prWrite({
    op: 'comment',
    target: 'acme/group/demo!12',
    commit: 'a1b2c3d4',
    body: '审查意见：三段命名空间下门禁与写路径一致',
    confirm: { repo: 'acme/group/demo', object: 'acme/group/demo!12' },
  });

  assert.equal(result.status, 'done', '三段评论目标与承建仓库是同一个仓库，不应被判不一致');
  assert.equal(result.target, 'acme/group/demo!12', '目标原样回报/下传，不折段');
  assert.equal(result.reused, false);
  assert.deepEqual(result.readback, { target: 'acme/group/demo!12', commit: 'a1b2c3d4', commentId: '9001', ok: true });
  assert.equal(guard.seen.length, 1, '写动作恰好过一次门禁');
  assert.equal(guard.seen[0].action, FLOW_ACTIONS.PR_COMMENT);
  assert.equal(guard.seen[0].target, 'acme/group/demo!12');
  assert.deepEqual(guard.seen[0].arguments, { repo: 'acme/group/demo', commit: 'a1b2c3d4' });
  assert.deepEqual(
    calls.slice(before).map((call) => call.args.slice(0, 2).join(' ')),
    ['pr view', 'pr comment', 'pr view'],
    '查重、写入、回读各一次，位置参数都是完整的三段目标',
  );
  assert.equal(posted.length, 1);
});

test('三段仓库的 PR 评论：同组兄弟仓库、另一命名空间、折叠成两段都必须拒绝', async () => {
  const { calls, execFile } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  await flow.startFromChange({ changeId: 'ARD654321' });
  const before = calls.length;

  // `acme/group/other` 与前两段相同、最后一段不同；`group/demo` 是"承建仓库被截成两段"后才会相等的形态。
  for (const target of ['acme/group/other!12', 'acme/other/demo!12', 'group/demo!12']) {
    const result = await flow.prWrite({
      op: 'comment',
      target,
      commit: 'a1b2c3d4',
      body: '审查意见',
      confirm: { repo: target.slice(0, target.indexOf('!')), object: target },
    });
    assert.equal(result.status, 'denied', `${target} 不在承建仓库，必须拒绝`);
    assert.equal(result.reason, 'REPO_NOT_SELECTED', `${target} 的拒绝原因必须是仓库不一致`);
    assert.equal(result.calls, 0);
    assert.equal(result.target, target, '拒绝时目标原样回报，便于人工核对');
  }

  assert.equal(guard.seen.length, 0, '仓库不一致时门禁一次都不该被调用');
  assert.equal(calls.length, before, '不一致判定发生在任何子进程之前');
});

test('评论目标解析不出仓库时不冒充「仓库不一致」：交给权威校验回 MISSING_TARGET，仍然零写入', async () => {
  const { calls, execFile } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  await flow.startFromChange({ changeId: 'ARD654321' });
  const before = calls.length;

  const link = 'https://example.invalid/acme/group/demo/pull/12';
  const result = await flow.prWrite({
    op: 'comment',
    target: link,
    commit: 'a1b2c3d4',
    body: '审查意见',
    confirm: { repo: 'acme/group/demo', object: link },
  });

  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'MISSING_TARGET', '原因码应指向目标语法，而不是"写到了候选之外"');
  assert.equal(result.calls, 0);
  assert.equal(guard.seen.length, 0);
  assert.equal(calls.length, before);
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

/** 只读门禁替身：目录覆盖四个只读动作且已开放，admission 直接承认并执行。 */
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
 * 进程环境替换：清掉六个 CLI 键并换 PATH（两个拼法都换），结束后原样还原。
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
      await assert.rejects(
        service.issueWrite({ op: 'create', target: 'acme/demo', title: '[ARD123456] x', body: 'x', confirm: { repo: 'acme/demo', object: 'acme/demo' } }),
        (error) => {
          assert.equal(error.code, FLOW_REASONS.UNAVAILABLE, '写动作显式不可用且零调用');
          return true;
        },
      );

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
