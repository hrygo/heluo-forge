/**
 * T3 host 适配（AC-4 / AC-8 / AC-9 / AC-10 / AC-15）：快照、刷新、revision 栅栏、保存五步。
 *
 * 这些用例是"页面能读到什么、写盘到底写了什么"的机器证据：
 *   - 装配期一次发现，之后只有 `refresh` 会重扫（工具调用、保存都不扫——AC-4 的结构性事实）；
 *   - revision = sha256(用户层) 前 16 位：键序无关、改值即变，别处改过就 409 且**一个字节都不写**；
 *   - 等值键不写、全空走删除路径（AC-15 的可回滚形态）；
 *   - `describe()` 与 `snapshot()` 是两个函数，前者连一个路径字符都不许出现（AC-10）。
 *
 * 全部离线：`fs` 与 `configEditor` 都是内存假实现，`platform` 显式注入 win32。
 * 真机（宿主 rc.3 / 企业 profile 是否允许写）属 NOT RUN，不在此文件断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_FIELDS, CLI_REASONS } from '../src/cli-config.mjs';
import { DEFAULT_ENTRY_ID, REVISION_LENGTH, createCliAccess } from '../src/cli-access.mjs';
import { ENV_KEYS } from '../src/runtime-config.mjs';

const WIN = 'win32';
const TOOLS = 'C:\\tools';
const CORP = 'C:\\company';
const LATE = 'C:\\z-tools';
const DOP = `${TOOLS}\\dop.exe`;
const GH = `${TOOLS}\\gh.exe`;
const DOP_CMD = `${TOOLS}\\dop.cmd`;
const DOP_CONF = `${CORP}\\dop.exe`;
const LATE_DOP = `${LATE}\\dop.exe`;
const ENDPOINT = 'https://dop.corp.example/api';
const REVISION_PATTERN = new RegExp(`^[0-9a-f]{${REVISION_LENGTH}}$`, 'u');

const enoent = (target) => {
  const error = new Error(`ENOENT: ${target}`);
  error.code = 'ENOENT';
  return error;
};

/**
 * 注入式假 fs：`dirs` = 目录 → 条目名，`files` = 完整路径 → `{ mode }`。
 * `calls.readdir` 就是"发现扫了几个目录"的计数器——AC-4 的断言靠它。
 */
function makeFs({ dirs = {}, files = {} } = {}) {
  const world = {
    dirs: { ...dirs },
    files: { ...files },
    calls: { readdir: 0, stat: 0 },
    addDir(dir, names) {
      world.dirs[dir] = names;
    },
    addFile(target) {
      world.files[target] = { mode: 0o755 };
    },
    dropFile(target) {
      delete world.files[target];
    },
    statSync(target) {
      world.calls.stat += 1;
      const hit = world.files[target];
      if (hit === undefined) throw enoent(target);
      return { isFile: () => true, mode: hit.mode };
    },
    readdirSync(dir) {
      world.calls.readdir += 1;
      const names = world.dirs[dir];
      if (names === undefined) throw enoent(dir);
      return [...names];
    },
  };
  return world;
}

const baseFs = () =>
  makeFs({
    dirs: { [TOOLS]: ['dop.exe', 'gh.exe', 'dop.cmd'] },
    files: { [DOP]: {}, [GH]: {}, [DOP_CMD]: {}, [DOP_CONF]: {} },
  });

/**
 * 假 `configEditor`：只实现本模块真正用到的那三面（`configuration` / `edit` / `documentPath`）。
 * `state.written` 记录传给 `edit` 的 `change()` 到底算出什么——"写了什么、没写什么"的断言靠它。
 */
function makeEditor({ override = {}, inherited = {}, rows = true } = {}) {
  const entry = { options: { id: DEFAULT_ENTRY_ID, name: DEFAULT_ENTRY_ID, config: {} } };
  const state = {
    entry,
    override: { ...override },
    inherited: { ...inherited },
    edits: 0,
    written: undefined,
    failWith: null,
    apply: true,
  };
  const editor = {
    documentPath: 'C:\\profile\\dsh.patch.yml',
    state,
    configuration() {
      if (rows !== true) return [];
      return [{ entry: state.entry, inherited: { ...state.inherited }, override: { ...state.override } }];
    },
    async edit(target, change) {
      state.edits += 1;
      if (state.failWith !== null) throw state.failWith;
      const next = change({ ...state.override }, { ...state.inherited });
      state.written = { ...next };
      // 真实 config-editor：`next` 与继承层深等时删掉整段 `config`（落到"未配置"），否则写入。
      if (state.apply) state.override = { ...next };
    },
  };
  return editor;
}

const noopClock = () => 0;

const makeAccess = (options = {}) =>
  createCliAccess({
    config: {},
    env: { Path: TOOLS },
    platform: WIN,
    fs: baseFs(),
    now: noopClock,
    configEditor: makeEditor(),
    ...options,
  });

test('装配期快照：零配置即 ready，路径来自自动发现，revision 是 16 位十六进制', () => {
  const access = makeAccess();
  const snapshot = access.snapshot();

  assert.equal(snapshot.ready, true, 'PATH 里有 dop.exe 就该 ready（AC-1）');
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.entries.dopBin.origin, 'discovered', 'origin 必须是发现层（AC-3）');
  assert.equal(snapshot.entries.dopBin.path, DOP);
  assert.deepEqual(snapshot.entries.dopBin.candidates, [{ path: DOP, tier: 'PATH' }, { path: DOP_CMD, tier: 'PATH' }], '候选按结构给页面，原生 .exe 在首位');
  assert.deepEqual(snapshot.entries.dopBin.rejected, [], 'r8 起发现不再拒收任何形态：键保留、恒为空（AC-3）');
  assert.equal(snapshot.entries.ghBin.path, GH);
  assert.equal(snapshot.entries.dopEndpoint.origin, 'missing', 'endpoint 不做发现（PRD 非目标）');
  assert.equal(snapshot.entries.dopEndpoint.value, null);
  // 推导（AC-7）：dop 与 gh 都由自动发现解析到可执行文件 → 企业实测；推导结果仍占 default 槽位。
  assert.equal(snapshot.entries.sourceType.value, 'enterprise');
  assert.equal(snapshot.entries.sourceType.origin, 'default', '基线缺省不是第四层，但它要说清楚');
  assert.deepEqual(Array.from(snapshot.entries.sourceType.overrides), [], '推导不压任何层');
  assert.equal(snapshot.entries.timeoutMs.value, 20000);
  assert.match(snapshot.revision, REVISION_PATTERN, 'revision = sha256 前 16 位（§2.5）');
  assert.deepEqual(snapshot.writable, { ok: true, documentPath: true });
  assert.equal(snapshot.host.platform, WIN);
  assert.ok(snapshot.guidance.includes('自动发现'), '指引用类别词，不用环境变量名（AC-5）');
});

test('事实来源推导经快照到装配层：双入口就绪才 enterprise、只有 dop 回落 mock（AC-7/AC-8）', () => {
  const both = makeAccess().snapshot();
  assert.equal(both.entries.sourceType.value, 'enterprise', 'dop 与 gh 都在 PATH 上 → 企业实测');
  assert.equal(both.entries.sourceType.origin, 'default', '推导占用既有 default 槽位，词表不新增');

  // 只有 dop：gh 停在基线缺省 `gh`，宁可少标也不把 mock 结论写成企业实测
  const onlyDopFs = makeFs({ dirs: { [TOOLS]: ['dop.exe'] }, files: { [DOP]: {} } });
  const onlyDop = makeAccess({ fs: onlyDopFs }).snapshot();
  assert.equal(onlyDop.ready, true, 'dop 就绪时页面照常可用，不因少标来源而 degraded');
  assert.equal(onlyDop.entries.ghBin.origin, 'default');
  assert.equal(onlyDop.entries.ghBin.path, 'gh');
  assert.equal(onlyDop.entries.sourceType.value, 'mock', '只有 dop 不许标成 enterprise');

  // 显式声明压过推导：配置层 sourceType 直接生效，origin 不再是 default
  const declared = makeAccess({ config: { sourceType: 'mock' } }).snapshot();
  assert.equal(declared.entries.sourceType.origin, 'config');
  assert.equal(declared.entries.sourceType.value, 'mock');
});

test('未命中 fail closed：原因码是类别词，指引指向配置页且不含路径与环境变量名（AC-5）', () => {
  const access = makeAccess({ fs: makeFs({ dirs: {} }), env: {} });
  const snapshot = access.snapshot();

  assert.equal(snapshot.ready, false, '找不到就 fail closed，不猜');
  assert.equal(snapshot.reason, CLI_REASONS.NOT_FOUND);
  assert.equal(snapshot.entries.dopBin.origin, 'missing');
  assert.equal(snapshot.entries.ghBin.path, 'gh', 'gh 仍有默认名兜底');
  assert.equal(snapshot.entries.ghBin.origin, 'default');
  assert.ok(snapshot.guidance.includes('设置 → 企业 DevOps'), '指引把人带到配置页');
  assert.ok(snapshot.guidance.includes('PATH'), '说清楚去哪儿找过');
  assert.equal(/[A-Za-z]:\\/u.test(snapshot.guidance), false, '不得回显盘符路径');
  assert.equal(snapshot.guidance.includes('FORGE_DEVOPS'), false, '不再让用户去配环境变量（AG-3）');
});

test('快照只读内存：普通读取不重扫，refresh 才重新发现并看得见新装的 CLI（AC-4）', () => {
  const fs = baseFs();
  const access = makeAccess({ fs, env: { Path: `${TOOLS};${LATE}` } });
  const scannedAtBoot = fs.calls.readdir;
  assert.ok(scannedAtBoot > 0, '装配期必须已经发现过一次');

  access.snapshot();
  access.snapshot();
  assert.equal(fs.calls.readdir, scannedAtBoot, '页面重挂载不得触发扫描');

  fs.addDir(LATE, ['dop.exe']);
  fs.addFile(LATE_DOP);
  const refreshed = access.snapshot({ refresh: true });
  assert.ok(fs.calls.readdir > scannedAtBoot, 'refresh=1 是唯一的重扫动作');
  assert.ok(
    refreshed.entries.dopBin.candidates.some((item) => item.path === LATE_DOP),
    '刷新后要看得见新装的 CLI',
  );
  assert.equal(refreshed.entries.dopBin.path, DOP, '仍是首个候选（同层级内按路径序，PATH 序不改变结论）');
});

test('刷新会重读用户层：别处改了配置，刷新后 origin 变 config 且说明覆盖关系', () => {
  const editor = makeEditor({ override: {} });
  const access = makeAccess({ configEditor: editor, env: { Path: TOOLS, [ENV_KEYS.dopBin]: DOP } });
  assert.equal(access.snapshot().entries.dopBin.origin, 'env');

  editor.state.override = { dopBin: DOP_CONF };
  const refreshed = access.snapshot({ refresh: true });

  assert.equal(refreshed.entries.dopBin.origin, 'config');
  assert.equal(refreshed.entries.dopBin.path, DOP_CONF);
  assert.ok(refreshed.entries.dopBin.overrides.includes('env'), '压过环境变量必须能说清楚（不静默）');
});

test('revision：键序无关、改值即变、无写面为 null', () => {
  const stable = makeEditor({ override: { dopBin: DOP_CONF, sourceType: 'enterprise' } });
  const reordered = makeEditor({ override: { sourceType: 'enterprise', dopBin: DOP_CONF } });
  const first = makeAccess({ configEditor: stable });
  const second = makeAccess({ configEditor: reordered });

  assert.equal(first.revision(), second.revision(), '同一组键换个顺序写进 YAML 不算冲突');
  assert.match(first.revision(), REVISION_PATTERN);

  const before = first.revision();
  stable.state.override = { ...stable.state.override, timeoutMs: 30000 };
  assert.notEqual(first.revision(), before, '内容变了 revision 必须变（栅栏才有意义）');

  const readOnly = makeAccess({ configEditor: null });
  assert.equal(readOnly.revision(), null, '没有写面就没有 revision，别编一个');
});

test('读面不因写面缺失而关闭：无 configEditor 时快照照常返回，只把 writable 降级（AC-8）', () => {
  const readOnly = makeAccess({ configEditor: null });
  const snapshot = readOnly.snapshot();

  assert.equal(snapshot.ready, true, '只读也要能看到当前生效的是哪一层');
  assert.equal(snapshot.entries.dopBin.origin, 'discovered');
  assert.deepEqual(snapshot.writable, {
    ok: false,
    reason: CLI_REASONS.UNAVAILABLE,
    documentPath: false,
  });
  assert.equal(snapshot.revision, null);
});

test('发现跑不起来时退化为配置/环境变量，不让整条装配崩掉', () => {
  const access = makeAccess({ fs: {}, config: { dopBin: DOP_CONF } });
  const snapshot = access.snapshot();

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.entries.dopBin.origin, 'config');
  assert.equal(snapshot.entries.dopBin.path, DOP_CONF);
  assert.deepEqual(snapshot.entries.dopBin.candidates, [], '没扫到就没有候选，不编造');
});

test('保存第一步：revision 不符 → 409 语义且一个字节都不写（AC-9）', async () => {
  const editor = makeEditor({ override: { dopBin: DOP_CONF } });
  const access = makeAccess({ configEditor: editor });

  const stale = await access.save({ revision: 'deadbeefdeadbeef', fields: { dopBin: DOP } });

  assert.equal(stale.ok, false);
  assert.equal(stale.code, CLI_REASONS.CONFLICT);
  assert.equal(editor.state.edits, 0, '冲突时绝不调 configEditor.edit');
  assert.deepEqual(editor.state.override, { dopBin: DOP_CONF });
  assert.match(stale.message, /刷新/u, '提示要给出下一步（刷新），而不是让用户猜');
});

test('保存第二步：无写面 / 无条目 → 503 语义（不是 409，别把用户引向不存在的原因）', async () => {
  const readOnly = makeAccess({ configEditor: null });
  const noEditor = await readOnly.save({ revision: '', fields: { dopBin: DOP } });
  assert.equal(noEditor.code, CLI_REASONS.UNAVAILABLE);

  const missingEntry = makeAccess({ configEditor: makeEditor({ rows: false }) });
  const noEntry = await missingEntry.save({ revision: '', fields: { dopBin: DOP } });
  assert.equal(noEntry.code, CLI_REASONS.UNAVAILABLE);
  assert.equal(missingEntry.revision(), null);
});

test('保存第三步：非法值逐字段报错、一个字段都不写（AC-9）', async () => {
  const editor = makeEditor({ override: {} });
  const access = makeAccess({ configEditor: editor });

  const result = await access.save({
    revision: access.revision(),
    fields: {
      // r8 AC-1：`.cmd` 现在存得下（后缀不再是保存门槛），所以这里用"不存在"这条持久理由，
      // 校验仍必须逐字段报错且一个字段都不写。
      dopBin: `${TOOLS}\\absent-dop.exe`,
      timeoutMs: 999999,
      sourceType: 'nonsense',
      mystery: 'x',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CLI_REASONS.INVALID);
  for (const field of ['dopBin', 'timeoutMs', 'sourceType', 'mystery']) {
    assert.equal(typeof result.errors[field], 'string', `${field} 必须有自己的错误消息`);
  }
  assert.equal(editor.state.edits, 0, '校验失败不碰磁盘');
});

test('保存成功：只写变化的键、写后回读、重新合并但不重扫发现（AC-4 / AC-8 / AC-15）', async () => {
  const fs = baseFs();
  const editor = makeEditor({ override: {} });
  const access = makeAccess({ fs, configEditor: editor });
  const scannedBefore = fs.calls.readdir;
  const revisionBefore = access.revision();

  const result = await access.save({ revision: revisionBefore, fields: { dopBin: DOP_CONF } });

  assert.equal(result.ok, true);
  assert.equal(editor.state.edits, 1);
  assert.deepEqual(editor.state.written, { dopBin: DOP_CONF }, '只写用户真正指定的那个键');
  assert.equal(result.snapshot.entries.dopBin.origin, 'config');
  assert.equal(result.snapshot.entries.dopBin.path, DOP_CONF);
  assert.notEqual(result.snapshot.revision, revisionBefore, '写后回读给出新的栅栏值');
  assert.equal(result.snapshot.entries.ghBin.origin, 'discovered', '没动的字段仍由发现层供给');
  assert.equal(fs.calls.readdir, scannedBefore, '保存不得触发重新发现');
});

test('等值键不写：全等时直接回快照，不调 edit（AC-15 等值噪声）', async () => {
  const editor = makeEditor({ override: { dopBin: DOP_CONF } });
  const access = makeAccess({ configEditor: editor });

  const result = await access.save({ revision: access.revision(), fields: { dopBin: DOP_CONF } });

  assert.equal(result.ok, true);
  assert.equal(editor.state.edits, 0, '一模一样的配置不该产生一次写盘');
  assert.equal(result.snapshot.entries.dopBin.path, DOP_CONF);
});

test('全空 → 删除路径：next 与继承层相同，config-editor 据此删掉整段 config（AC-15 回滚）', async () => {
  const editor = makeEditor({ override: { dopBin: DOP_CONF, sourceType: 'enterprise' } });
  const access = makeAccess({ configEditor: editor });

  const result = await access.save({
    revision: access.revision(),
    fields: { dopBin: null, sourceType: null },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(editor.state.written, {}, '清空 = 从用户层删键');
  assert.deepEqual(editor.state.written, editor.state.inherited, '与继承层深等才会走删除路径');
  assert.equal(result.snapshot.entries.dopBin.origin, 'discovered', '回落后由下一层接管');
  assert.equal(result.snapshot.entries.sourceType.origin, 'default');
});

test('写盘失败分类：条目被替换 = 409 语义，其余 = 503 语义（错误消息不含路径）', async () => {
  const editor = makeEditor({ override: {} });
  const access = makeAccess({ configEditor: editor });
  const revision = access.revision();

  editor.state.failWith = new Error('Configuration entry changed during reload');
  const replaced = await access.save({ revision, fields: { dopBin: DOP_CONF } });
  assert.equal(replaced.code, CLI_REASONS.CONFLICT);

  editor.state.failWith = new Error(`EACCES: permission denied, open '${DOP_CONF}'`);
  const denied = await access.save({ revision, fields: { dopBin: DOP_CONF } });
  assert.equal(denied.code, CLI_REASONS.UNAVAILABLE);
  assert.equal(
    JSON.stringify(denied).includes(DOP_CONF),
    false,
    'AC-10：错误消息不许把宿主抛出的路径原样带出去',
  );
});

test('写后回读不一致 → 503 语义（成功了才敢说"已保存"）', async () => {
  const editor = makeEditor({ override: {} });
  editor.state.apply = false; // 假装 config-editor 写了但没生效
  const access = makeAccess({ configEditor: editor });

  const result = await access.save({ revision: access.revision(), fields: { dopBin: DOP_CONF } });

  assert.equal(result.ok, false);
  assert.equal(result.code, CLI_REASONS.UNAVAILABLE);
  assert.match(result.message, /回读/u);
});

test('describe() 脱敏：路径与 endpoint 零命中，快照与描述是两个函数（AC-10）', () => {
  const editor = makeEditor({ override: { dopBin: DOP_CONF, dopEndpoint: ENDPOINT } });
  // 装配期 config 就是 loader 组合后的用户层（profile 补丁已生效），这里传同一份才符合真实语义。
  const config = { dopBin: DOP_CONF, dopEndpoint: ENDPOINT };
  const access = makeAccess({ config, configEditor: editor });

  const described = access.describe();
  const text = JSON.stringify(described);

  assert.equal(text.includes(DOP_CONF), false, '路径只能出现在快照里');
  assert.equal(text.includes(CORP), false);
  assert.equal(text.includes(ENDPOINT), false);
  assert.equal(/[A-Za-z]:\\\\/u.test(text), false, '连盘符形态都不许出现');
  assert.deepEqual(described.searched, ['config', 'env', 'PATH', 'candidate-dirs']);
  assert.equal(described.entries.dopBin.origin, 'config');
  assert.equal(described.entries.dopBin.configured, true, '脱敏只保留"有没有值"这一个布尔');
  assert.ok(access.snapshot().entries.dopBin.path === DOP_CONF, '快照仍要能回显路径（两函数分工）');
});

test('快照覆盖六个字段且不含悬空键：字段表与 CLI_FIELDS 同源', () => {
  const snapshot = makeAccess().snapshot();
  assert.deepEqual(Object.keys(snapshot.entries), [...CLI_FIELDS]);
  for (const field of CLI_FIELDS) {
    assert.equal(typeof snapshot.entries[field].origin, 'string', `${field} 必须给出 origin`);
  }
});
