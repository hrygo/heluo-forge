/**
 * 幂等台账与证据单测（AC-16 / AC-24）。
 *
 * 这里锁住幂等键的**对象身份**：公式用固定向量钉死，任何人改公式（哪怕只是换个分隔符）
 * 都会红。键由变更号、动作、对象类型、规范化目标与归一化标题共同决定——同一变更下
 * "标题相同、动作或目标不同"是两份不同对象，漏掉任一项都会让后一次写命中前一次的
 * `done` 台账并静默返回旧结果（受控写最危险的错误）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_TTL_MS,
  EVIDENCE_FIELDS,
  EVIDENCE_SOURCE_TYPES,
  REPLAY_BLOCKED_STATUSES,
  REUSABLE_STATUSES,
  buildEvidence,
  createGiteeSession,
  idempotencyKey,
} from '../src/gitee-session.mjs';

const HEX16 = /^[0-9a-f]{16}$/u;

test('AC-16 幂等键 = sha256(变更号|动作|对象类型|目标|标题) 前 16 位：固定向量锁死公式', () => {
  // 向量由公式独立算出，不是回读实现得来：一旦有人改动组合顺序、归一化或分隔符，这些
  // 字面量必然对不上。
  const issue = {
    change: 'CHG-2026-001',
    action: 'gitee.issue.write',
    objectType: 'issue',
    target: 'osc/ard/ard-sdk',
    title: '同步变更',
  };
  assert.equal(idempotencyKey(issue), '17b29679778f71d2');
  assert.equal(idempotencyKey({ ...issue, action: 'gitee.pr.write', objectType: 'pull-request' }), 'df414a0441b69ff1');
  assert.match(idempotencyKey(issue), HEX16);
});

test('AC-16/回归：同一变更、同一标题，动作或目标不同必须是不同键（review.publish ≠ review.record）', () => {
  const base = {
    change: 'CHG-2026-001',
    action: 'gitee.review.publish',
    objectType: 'review',
    target: 'osc/ard/ard-sdk#999',
    title: 'CHG-2026-001@aaaaaaa',
  };
  const publishKey = idempotencyKey(base);
  const recordKey = idempotencyKey({ ...base, action: 'gitee.review.record', target: '/work/ard-sdk' });

  assert.equal(publishKey, 'd35fad26e4b20602');
  assert.equal(recordKey, '5ba059a21f8ae2f8');
  assert.notEqual(publishKey, recordKey, '跨对象写共用键会让第二次写误判 reused=true 并静默返回上一次结果');
  // 只换目标、不换动作也必须换键：同一动作写到另一个 PR 是另一份对象。
  assert.notEqual(publishKey, idempotencyKey({ ...base, target: 'osc/ard/ard-sdk#1000' }));
  // 只换动作、不换目标同样换键。
  assert.notEqual(publishKey, idempotencyKey({ ...base, action: 'gitee.issue.write' }));
});

test('AC-16 归一化只判断"是不是同一个对象"：大小写/空白/尾部标点/目标写法同键', () => {
  const base = {
    change: 'CHG-2026-001',
    action: 'gitee.issue.write',
    objectType: 'issue',
    target: 'osc/ard/ard-sdk',
    title: '同步变更',
  };
  const key = idempotencyKey(base);

  // 变更号大小写不敏感（人写 chg-2026-001 与 CHG-2026-001 是同一件事）。
  assert.equal(idempotencyKey({ ...base, change: 'chg-2026-001' }), key);
  // 标题：首尾空白、连续空白折叠、尾部中英文标点都不改变身份。
  assert.equal(idempotencyKey({ ...base, title: '  同步变更   ' }), key);
  assert.equal(idempotencyKey({ ...base, title: '同步变更。' }), key);
  assert.equal(idempotencyKey({ ...base, title: '同步变更！' }), key);

  // 目标：`!12` 与 `#12` 是同一个 PR 的两种工具面写法；尾部斜杠与反斜杠不改变身份。
  assert.equal(idempotencyKey({ ...base, target: 'osc/ard/ard-sdk!12' }), idempotencyKey({ ...base, target: 'osc/ard/ard-sdk#12' }));
  assert.equal(idempotencyKey({ ...base, target: 'osc/ard/ard-sdk/' }), key);
  assert.equal(idempotencyKey({ ...base, target: 'C:\\work\\ard-sdk' }), idempotencyKey({ ...base, target: 'C:/work/ard-sdk' }));

  // 不同对象类型 → 不同键（同一变更下的 Issue 与 PR 必须分别幂等）。
  assert.notEqual(idempotencyKey({ ...base, objectType: 'pull-request' }), key);
  // 不同标题 → 不同键（同一变更下的两个 Issue 是两份东西）。
  assert.notEqual(idempotencyKey({ ...base, title: '回滚变更' }), key);
});

test('AC-16 缺变更号/动作/对象类型/目标/可归一化标题一律抛错：不产出半截键（否则会把不同对象并成一个）', () => {
  const full = {
    change: 'CHG-2026-001',
    action: 'gitee.issue.write',
    objectType: 'issue',
    target: 'osc/ard/ard-sdk',
    title: '同步变更',
  };
  assert.throws(() => idempotencyKey({ ...full, change: undefined }), /变更号/u);
  assert.throws(() => idempotencyKey({ ...full, action: undefined }), /动作/u);
  assert.throws(() => idempotencyKey({ ...full, objectType: undefined }), /对象类型/u);
  assert.throws(() => idempotencyKey({ ...full, target: undefined }), /目标/u);
  assert.throws(() => idempotencyKey({ ...full, title: undefined }), /标题/u);
  assert.throws(() => idempotencyKey({ ...full, target: '   ' }), /目标/u);
  assert.throws(() => idempotencyKey({ ...full, title: ' 。 ' }), /标题/u);
});

test('AC-16 台账：record/lookup/forget/size 齐全，过期条目自动失效（不落盘、不跨进程）', () => {
  let clock = 1_000;
  const session = createGiteeSession({ now: () => clock, ttlMs: 500 });
  assert.equal(DEFAULT_SESSION_TTL_MS > 0, true);

  const entry = session.record({
    key: 'k-1',
    status: 'done',
    action: 'gitee.issue.write',
    target: 'acme/repo',
    objectRef: 'acme/repo#12',
    evidence: { provider: 'gitee', command: 'issueCreate' },
  });
  assert.equal(entry.key, 'k-1');
  assert.equal(entry.at, 1_000);
  assert.equal(session.lookup('k-1')?.objectRef, 'acme/repo#12');
  assert.equal(session.size(), 1);

  // TTL 到点即失效：过期条目不能用来"复用上一次结果"。
  clock = 1_400;
  assert.equal(session.lookup('k-1')?.status, 'done');
  clock = 1_600;
  assert.equal(session.lookup('k-1'), undefined);
  assert.equal(session.size(), 0);

  session.record({ key: 'k-2', status: 'unknown' });
  assert.equal(session.forget('k-2'), true);
  assert.equal(session.forget('k-2'), false);
  assert.equal(session.size(), 0);
});

test('AC-16 台账条目形状固定：缺 key/status 直接抛错，不写半条记录', () => {
  const session = createGiteeSession();
  assert.throws(() => session.record({ status: 'done' }), /幂等键/u);
  assert.throws(() => session.record({ key: 'k' }), /状态/u);
  assert.equal(session.size(), 0);
  // 空键查询返回 undefined，不制造"空键命中"。
  assert.equal(session.lookup('  '), undefined);
});

test('AC-16 状态词表：只有 done 可复用；unknown/pending 阻断重放', () => {
  assert.deepEqual([...REUSABLE_STATUSES], ['done']);
  assert.ok(REPLAY_BLOCKED_STATUSES.includes('unknown'));
  assert.equal(REPLAY_BLOCKED_STATUSES.includes('done'), false);
  assert.equal(REPLAY_BLOCKED_STATUSES.includes('failed'), false, 'failed 是"确定没生效"，必须允许重试');
});

test('AC-24 证据只有白名单六个字段：无令牌、无绝对路径、无自由文本', () => {
  const evidence = buildEvidence({
    command: 'issueCreate',
    at: '2026-10-29T00:00:00.000Z',
    target: 'acme/repo#12',
    sourceType: 'gitee-cli',
  });
  assert.deepEqual(Object.keys(evidence).sort(), [...EVIDENCE_FIELDS].sort());
  assert.equal(evidence.provider, 'gitee');
  assert.equal(evidence.command, 'issueCreate');
  assert.equal(evidence.at, '2026-10-29T00:00:00.000Z');
  assert.equal(evidence.target, 'acme/repo#12');
  assert.equal(evidence.sourceType, 'gitee-cli');
  assert.equal(evidence.hostVersion, null);
  // 证据里不能出现凭据或本机绝对路径（把令牌写进证据等于把令牌写进日志）。
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /token|secret|password/iu);
  assert.doesNotMatch(serialized, /\/(?:Users|home)\//u);
});

test('AC-24 证据的 sourceType 是固定枚举：未联调项不能靠声明"跑过"来表达', () => {
  assert.deepEqual([...EVIDENCE_SOURCE_TYPES], ['gitee-cli', 'policy-only', 'none']);
  assert.throws(() => buildEvidence({ sourceType: 'live-tested' }), /证据来源/u);
  const local = buildEvidence({ target: 'acme/repo' });
  assert.equal(local.sourceType, 'gitee-cli');
  assert.equal(local.command, null);
  assert.match(local.at, /^\d{4}-\d{2}-\d{2}T/u);
});

test('AC-24 证据字段值超长截断并标记省略号（不把整段命令输出塞进证据）', () => {
  const long = 'x'.repeat(900);
  const evidence = buildEvidence({ command: long, target: 'acme/repo' });
  assert.equal(evidence.command.length, 512);
  assert.ok(evidence.command.endsWith('…'));
});
