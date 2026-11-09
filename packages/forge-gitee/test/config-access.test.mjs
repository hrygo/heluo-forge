/**
 * Gitee 配置面（T1 / TECHNICAL §3.1）：快照三层、revision 栅栏、增量写、零泄漏。
 *
 * 这一组用例回答的是"页面能读到什么、写盘到底写了什么、拒绝时碰没碰磁盘"：
 *   - 无 `configEditor` 时**只读**（不是 500，也不是假装可写）；
 *   - revision = sha256(本机覆盖层) 前 16 位：键序无关、改值即变、别处改过就 409 且 editor 0 次；
 *   - 非法值 422 且写盘 0 次（校验发生在 `editor.edit` 之前）；
 *   - `null`/空串 = 删键回落（AC-6 的可回滚形态）；
 *   - `describe()` 与 `snapshot()` 是两个函数，前者连一个路径字符都不许出现（AC-12）。
 *
 * 全部离线：`configEditor` 是内存假实现，`platform`/`env` 显式注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITEE_ACCESS_REASONS,
  GITEE_CONFIG_KEYS,
  GITEE_ENTRY_ID,
  GITEE_ORIGINS,
  GITEE_PAGE_FIELDS,
  GITEE_PLUGIN,
  REVISION_LENGTH,
  createGiteeAccess,
} from '../src/config-access.mjs';

const ENV = Object.freeze({});
const LINUX = 'linux';
const CLI = '/opt/gitee/gh';
const HOST = 'https://gitee.example';
const REVISION_PATTERN = new RegExp(`^[0-9a-f]{${REVISION_LENGTH}}$`, 'u');

/**
 * 假 `configEditor`：只实现本模块真正用到的三面（`configuration` / `edit` / `documentPath`）。
 * `state.edits` 就是"到底写没写盘"的计数器——AC-6 的 409/422 断言靠它。
 */
function makeEditor({ override = {}, inherited = {}, rows = true } = {}) {
  const entry = { options: { id: GITEE_ENTRY_ID, name: GITEE_ENTRY_ID, config: {} } };
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
    documentPath: '/srv/qa/.dsh/profiles/qa/dsh.patch.yml',
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
      if (state.apply) state.override = { ...next };
    },
  };
  return editor;
}

const makeAccess = (options = {}) =>
  createGiteeAccess({ config: {}, env: ENV, platform: LINUX, ...options });

test('AC-7/AC-12: 无 configEditor 时是只读面（不 500、不假装可写、不出路径）', () => {
  const snapshot = makeAccess().snapshot();

  assert.deepEqual(snapshot.writable, { ok: false, reason: GITEE_ACCESS_REASONS.UNAVAILABLE });
  assert.equal(snapshot.revision, null, '没有可写条目就没有 revision');
  assert.equal(makeAccess().describe().entryId, GITEE_ENTRY_ID);
  assert.deepEqual(Array.from(snapshot.editable), Array.from(GITEE_PAGE_FIELDS), '可写面恒为两个非敏感键');
  assert.deepEqual(snapshot.plugin, { name: GITEE_PLUGIN.name, version: GITEE_PLUGIN.version });

  // 没有任何配置键 → 未配置（不是"通过"）。
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.entries.cliPath.origin, GITEE_ORIGINS.DEFAULT, '内置缺省占 default 槽位');
  assert.equal(snapshot.entries.cliPath.value, 'gh');
  assert.equal(snapshot.entries.host.origin, GITEE_ORIGINS.UNSET);
  assert.equal(snapshot.entries.host.value, null, '未配置的键给 null（页面据此渲染"未配置"）');
  assert.equal(snapshot.entries.timeoutMs.value, 20000);
  assert.deepEqual(Array.from(snapshot.entries.authEnv.value), []);
  assert.equal(snapshot.entries.persistentToken.value, 'warn');
});

test('AC-4: 快照给三层（公共参数 / 本机覆盖 / 最终生效），origin 说生效值来自哪层', () => {
  const editor = makeEditor({ inherited: { cliPath: '/usr/local/bin/gh' }, override: { timeoutMs: 5000 } });
  const snapshot = makeAccess({ configEditor: editor }).snapshot();

  assert.deepEqual(snapshot.writable, { ok: true, documentPath: true }, '文档路径只给布尔位');
  assert.match(snapshot.revision, REVISION_PATTERN);
  assert.equal(snapshot.ready, true, '有认识的键且全部合法 → 已配置');

  const cliPath = snapshot.entries.cliPath;
  assert.equal(cliPath.inherited, '/usr/local/bin/gh', '公共参数层单独一列');
  assert.equal(cliPath.override, null, '本机没有覆盖');
  assert.equal(cliPath.origin, GITEE_ORIGINS.CONFIG, '生效值来自配置层');
  assert.equal(cliPath.value, '/usr/local/bin/gh');
  assert.equal(cliPath.path, '/usr/local/bin/gh');
  assert.deepEqual(
    Array.from(cliPath.overrides).map((item) => item.origin),
    [GITEE_ORIGINS.DEFAULT],
    '公共参数层压过内置缺省：被压的那层要说出来',
  );
  assert.equal(cliPath.overrides[0].value, 'gh');

  const timeout = snapshot.entries.timeoutMs;
  assert.equal(timeout.inherited, null);
  assert.equal(timeout.override, 5000);
  assert.equal(timeout.value, 5000);
  assert.deepEqual(
    Array.from(timeout.overrides).map((item) => item.origin),
    [GITEE_ORIGINS.DEFAULT],
    '本机覆盖压过了内置缺省',
  );
  assert.equal(timeout.overrides[0].value, 20000);
});

test('AC-6: 409 栅栏在 editor.edit 之前判定——revision 过期时一个字节都不写', async () => {
  const editor = makeEditor({ override: { cliPath: CLI } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  // 别处改过：磁盘上的用户层已经不是快照里那一版。
  editor.state.override = { cliPath: `${CLI}-other` };
  const result = await access.save({ revision: snapshot.revision, fields: { timeoutMs: 30000 } });

  assert.equal(result.ok, false);
  assert.equal(result.code, GITEE_ACCESS_REASONS.CONFLICT);
  assert.equal(editor.state.edits, 0, '冲突时 editor 调用 0 次（AC-6）');
  assert.deepEqual(editor.state.override, { cliPath: `${CLI}-other` }, '磁盘内容原样不动');
});

test('AC-6: 非法值 422 且写盘 0 次，错误按字段给', async () => {
  const editor = makeEditor({ override: { cliPath: CLI } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  const result = await access.save({ revision: snapshot.revision, fields: { timeoutMs: 10 } });

  assert.equal(result.ok, false);
  assert.equal(result.code, GITEE_ACCESS_REASONS.INVALID);
  assert.ok(typeof result.errors?.timeoutMs === 'string', '错误按字段名给，不带值');
  assert.equal(editor.state.edits, 0, '校验失败时写盘 0 次');
});

test('AC-6: 未知配置项直接拒绝（不写盘、不静默丢弃）', async () => {
  const editor = makeEditor({ override: { cliPath: CLI } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  const result = await access.save({ revision: snapshot.revision, fields: { gitCwd: '/tmp' } });

  assert.equal(result.ok, false);
  assert.equal(result.code, GITEE_ACCESS_REASONS.INVALID);
  assert.deepEqual(result.errors, { gitCwd: '未知配置项' });
  assert.equal(editor.state.edits, 0);
  assert.deepEqual(GITEE_CONFIG_KEYS, ['cliPath', 'host', 'timeoutMs', 'authEnv', 'persistentToken']);
});

test('AC-6: 等值保存不碰磁盘（噪声保存不该产生一次写）', async () => {
  const editor = makeEditor({ override: { cliPath: CLI, timeoutMs: 20000 } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  const result = await access.save({ revision: snapshot.revision, fields: { cliPath: CLI, timeoutMs: 20000 } });

  assert.equal(result.ok, true);
  assert.equal(editor.state.edits, 0, '内容没变就不写');
  assert.equal(result.snapshot.entries.cliPath.override, CLI);
});

test('AC-6: 增量保存只改提交的键，`null` 表示删键回落（兄弟键原样保留）', async () => {
  const editor = makeEditor({ override: { cliPath: CLI, timeoutMs: 5000 } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  const result = await access.save({ revision: snapshot.revision, fields: { cliPath: null } });

  assert.equal(result.ok, true);
  assert.equal(editor.state.edits, 1);
  assert.deepEqual(editor.state.written, { timeoutMs: 5000 }, '删除键后只剩兄弟键');
  assert.equal(result.snapshot.entries.cliPath.override, null);
  assert.equal(result.snapshot.entries.cliPath.origin, GITEE_ORIGINS.DEFAULT, '回落内置缺省');
  assert.equal(result.snapshot.entries.cliPath.value, 'gh');
  assert.equal(result.snapshot.entries.timeoutMs.value, 5000);
});

test('AC-6: 写后回读不一致 → UNAVAILABLE（不谎报已保存）', async () => {
  const editor = makeEditor({ override: {} });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  editor.state.apply = false; // 写盘成功但回读还是旧内容
  const result = await access.save({ revision: snapshot.revision, fields: { cliPath: CLI } });

  assert.equal(result.ok, false);
  assert.equal(result.code, GITEE_ACCESS_REASONS.UNAVAILABLE);
  assert.equal(editor.state.edits, 1);
});

test('AC-12: describe() 结构上不含任何配置值 / 路径 / 令牌', () => {
  const editor = makeEditor({ override: { cliPath: CLI, host: HOST, authEnv: ['GITEE_TOKEN'] } });
  const described = makeAccess({ configEditor: editor }).describe();

  assert.equal(described.entryId, GITEE_ENTRY_ID);
  assert.equal(described.entries.cliPath.origin, GITEE_ORIGINS.CONFIG);
  assert.equal(described.entries.cliPath.configured, true);
  assert.deepEqual(Object.keys(described.entries.cliPath).sort(), ['configured', 'origin', 'overrides']);

  const text = JSON.stringify(described);
  assert.ok(!text.includes(CLI), 'describe 不得出现路径');
  assert.ok(!text.includes(HOST), 'describe 不得出现 endpoint');
  assert.ok(!text.includes('GITEE_TOKEN'), 'describe 不得出现变量名以外的凭据信息');
  assert.ok(typeof described.text === 'string' && !described.text.includes(CLI), '给人看的那行也是脱敏的');
});

test('AC-6: 兄弟条目注释不归本模块管——只把"要写成什么"交给 editor', async () => {
  const editor = makeEditor({ override: { cliPath: CLI } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  await access.save({ revision: snapshot.revision, fields: { timeoutMs: 30000 } });

  // editor.edit 收到的是 (entry, change)：entry 必须还是本条目，change 的产物是整层用户配置。
  assert.equal(editor.state.entry.options.id, GITEE_ENTRY_ID);
  assert.deepEqual(editor.state.written, { cliPath: CLI, timeoutMs: 30000 });
});

test('AC-6: revision 栅栏与增量写在同一临界区——过预检后别处先写，不得按旧快照覆盖', async () => {
  const editor = makeEditor({ override: { cliPath: CLI, timeoutMs: 5000 } });
  const access = makeAccess({ configEditor: editor });
  const snapshot = access.snapshot();

  // 复现竞态：本请求已通过栅栏，但在拿到编辑器锁之前，另一个保存先落了盘
  // （timeoutMs 5000 → 30000）。旧实现会把基于旧快照的整层写回去，把 30000 改回 5000。
  const edit = editor.edit;
  editor.edit = async (entry, change) => {
    editor.state.override = { cliPath: CLI, timeoutMs: 30000 };
    return edit(entry, change);
  };

  const result = await access.save({
    revision: snapshot.revision,
    fields: { cliPath: '/opt/gitee/bin/gh-race' },
  });

  assert.equal(result.ok, false, '别处先写后，这次保存必须失败');
  assert.equal(result.code, GITEE_ACCESS_REASONS.CONFLICT, '拿到锁内当前层后发现 revision 已变 → 409');
  assert.deepEqual(
    editor.state.override,
    { cliPath: CLI, timeoutMs: 30000 },
    '别处先写的 timeoutMs 必须原样保留，不能被旧快照覆盖',
  );
});
