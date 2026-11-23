import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { BUILTIN_ACTIONS, CATEGORY, defaultDecision } from '../src/classify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const design = readFileSync(join(root, 'docs/design/plugins/forge-policy.md'), 'utf8');

/**
 * P0 起目录只登记 6 个写动作，只读动作不再进入策略目录（取代事实：旧用例
 * 断言"设计表全部动作都在目录里、只读动作必须登记且 enabled"。现在未登记即
 * 出闸放行、不审计；登记只与写动作一一对应）。本文件把设计 §5.1.1 的分类表
 * 变成可复现证据：
 *   1. 词表仍按设计表分类，默认决策与代码一致（防文档漂移）；
 *   2. 随包补丁层只登记 6 条写动作，四层逐字同序、无 enabled；
 *   3. 全关时写动作通过、只加一条审计；身份缺失仍拒绝；
 *   4. 三个开关（denyHumanRecord / confirmPush / denyUnknownAction）打开后才收紧。
 */
function designRows() {
  const section = design.split('#### 5.1.1')[1]?.split('#### 5.1.2')[0] ?? '';
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const actions = [...cells[0].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    rows.push({ actions, category: cells[1], decision: cells[2] });
  }
  return rows;
}

const IDENTITY = Object.freeze({
  getView() {
    return { state: 'ready', signedIn: true, principal: 'user-a', accessExpiresAt: null };
  },
});

const WRITES = [
  'gitee.issue.write',
  'gitee.pr.write',
  'gitee.review.publish',
  'change.clarification.write',
  'gitee.git.push',
  'gitee.review.record',
];
const CATALOG = WRITES.map((action) => ({ action, target: targetOf(action), category: BUILTIN_ACTIONS.get(action).category }));
const TOOL = (action) => `forge_${action.replaceAll('.', '_')}`;
const TOOLS = Object.fromEntries(WRITES.map((action) => [TOOL(action), action]));

function targetOf(action) {
  if (action === 'change.clarification.write') return 'change';
  if (action === 'gitee.issue.write') return 'issue';
  if (action === 'gitee.pr.write' || action === 'gitee.review.publish' || action === 'gitee.review.record') return 'pull-request';
  return 'repository';
}

const targetValue = (action) => (targetOf(action) === 'repository' ? 'acme/demo' : targetOf(action) === 'issue' ? 'acme/demo!1' : targetOf(action) === 'pull-request' ? 'acme/demo!2' : 'CHG-1');

function fakeHost({ iam = IDENTITY } = {}) {
  const provided = new Map();
  const guards = [];
  const listeners = new Map();
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    get(name) {
      if (name === 'iam') return iam;
      return provided.get(name);
    },
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, guards, provided, listeners };
}

function mount({ catalog = CATALOG, rules, iam } = {}) {
  const host = fakeHost({ iam });
  apply(host.ctx, { audit: { sink: 'memory' }, catalog, rules, tools: TOOLS });
  const pre = host.listeners.get('tools/pre-execute');
  const guard = host.guards[0];
  const stage = async (action, args) => {
    const exec = { name: TOOL(action), arguments: args, callId: `c-${action}`, agent: { id: 'agent-1' }, signal: new AbortController().signal };
    const decision = await pre(exec, () => Promise.resolve({ kind: 'allow' }));
    if (decision.kind === 'deny') return { reason: decision.reason };
    return { reason: guard(exec) };
  };
  return { ...host, stage, policy: host.ctx.get('policy') };
}

test('D1: 设计分类表的每个动作都在策略词表里，且默认决策与代码一致', () => {
  const rows = designRows();
  assert.ok(rows.length >= 7, `设计 §5.1.1 分类表至少 7 行，实际 ${rows.length}`);
  const documented = new Set();
  for (const row of rows) {
    for (const action of row.actions) {
      if (action === 'git commit') continue; // 本地动作出闸，不是策略动作
      documented.add(action);
      assert.ok(BUILTIN_ACTIONS.has(action), `设计表列出的 "${action}" 不在策略词表里——照它登记不会生效`);
      const decision = defaultDecision(action);
      const expected = /^allow/u.test(row.decision) ? 'allow' : /^confirm/u.test(row.decision) ? 'confirm' : 'deny';
      assert.equal(decision, expected, `设计表把 "${action}" 写成 ${row.decision}，代码判定是 ${decision}`);
    }
  }
  assert.deepEqual([...BUILTIN_ACTIONS.keys()].sort(), [...documented].sort(), '策略词表与设计分类表必须一一对应');
});

test('D1: 随包补丁层只登记 6 条写动作，四层逐字同序且无 enabled', () => {
  // 认「登记」而不是认字符串：注释里提到共享策略行不是登记，否则注释措辞会
  // 把不带策略行的 bundle 拉进本用例，用一条缺行断言误报成配置缺陷。
  const POLICY_ROW = /^ {4}- id: heluo-policy$/mu;
  const layers = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', entry.name, 'cordis.patch.yml'))
    .filter((path) => {
      try {
        return POLICY_ROW.test(readFileSync(path, 'utf8'));
      } catch {
        return false;
      }
    });
  assert.ok(layers.length >= 2, '至少两个 bundle 带策略补丁层');

  const catalogs = layers.map((path) => {
    const text = readFileSync(path, 'utf8');
    const start = text.search(POLICY_ROW);
    assert.ok(start >= 0, `${path} 缺 YAML 策略行（注释里的 \`id: heluo-policy\` 不算登记）`);
    const section = text.slice(start).split('audit:')[0];
    const lines = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- { action: '));
    for (const line of lines) {
      assert.match(
        line,
        /^- \{ action: '[^']+', target: '[^']+', category: '(dev-write|review-write|remote-write|human-record)' \}$/u,
        `${path} 的登记行必须只写 action / target / category（类别与默认决策由内置词表决定）：${line}`,
      );
    }
    return { path, actions: lines.map((line) => /action: '([^']+)'/u.exec(line)[1]) };
  });

  const [baseline, ...rest] = catalogs;
  for (const { path, actions } of rest) {
    assert.deepEqual(
      actions,
      baseline.actions,
      `${path} 的目录必须与 ${baseline.path} 逐字同序：loader 按 id 只保留最后一份 config，单边改动会让幸存目录取决于装配顺序`,
    );
  }

  const documented = new Map();
  for (const row of designRows()) {
    for (const action of row.actions) {
      if (action === 'git commit') continue;
      documented.set(action, /^allow/u.test(row.decision) ? 'allow' : /^confirm/u.test(row.decision) ? 'confirm' : 'deny');
    }
  }
  const writes = baseline.actions.filter((action) => BUILTIN_ACTIONS.get(action)?.category !== 'read');
  assert.equal(writes.length, 6, '六条写动作必须随包登记');
  assert.deepEqual([...writes].sort(), WRITES.toSorted(), '随包登记必须与六个写动作一一对应');
  for (const action of writes) {
    assert.equal(CATALOG.find((entry) => entry.action === action).category, BUILTIN_ACTIONS.get(action).category);
    assert.equal(defaultDecision(action), documented.get(action), `随包目录的 "${action}" 默认决策必须与设计表一致`);
  }
  assert.ok(baseline.actions.every((action) => !baseline.actions.includes('gitee.repository.read')), '只读动作不进入目录');
});

test('P0: 全关时写动作直接通过，且一次受控调用只记一条初始记录', async () => {
  const host = mount();
  assert.equal((await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' })).reason, undefined);
  const records = host.policy.auditRecords();
  assert.equal(records.filter((record) => record.phase === 'begin').length, 1);
  assert.equal(records[0].action, 'gitee.issue.write');
  assert.equal(host.policy.decide({ action: 'gitee.issue.write', target: 'acme/demo!1' }).rule, 'registered-write');
});

test('P0: 只读动作不在目录里，出闸放行且不审计', async () => {
  const host = mount();
  const read = await host.stage('gitee.issue.read', { target: 'acme/demo!1' });
  assert.equal(read.reason, undefined);
  assert.deepEqual(host.policy.auditRecords(), []);
  assert.deepEqual([...host.policy.catalog.keys()], WRITES);
});

test('P0: 写动作缺少身份即拒绝，与内容无关', async () => {
  const host = mount({ iam: { getView: () => ({ state: 'signed-out', signedIn: false, principal: null }) } });
  const denied = await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'clean text' });
  assert.match(String(denied.reason), /IAM 身份/u);
  assert.match(String(denied.reason), /设置 → 账号/u);
});

test('P3: 三个语义开关与流程闸都可以单独打开', () => {
  for (const key of ['denyHumanRecord', 'denyUnknownAction', 'protectPaths', 'enforceProcessRules']) {
    const host = mount({ rules: { [key]: true } });
    assert.equal(host.policy.mode(), 'personal', `${key} 打开后插件正常装配`);
    assert.equal(host.policy.auditDegraded(), false);
  }
});
