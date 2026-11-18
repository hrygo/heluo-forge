import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { BUILTIN_ACTIONS, defaultDecision } from '../src/classify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const design = readFileSync(join(root, 'docs/design/plugins/forge-policy.md'), 'utf8');
const model = readFileSync(join(root, 'docs/design/policy-model.md'), 'utf8');

/**
 * D1（2026-11-16 调整）：动作按类别给出默认决策，写类动作过内容与流程规则，
 * 组织策略只能收紧。本文件把设计 §5.1.1 的分类表变成可复现证据：
 *   1. 表里的每个动作都在策略词表里，默认决策与代码一致（防文档漂移）；
 *   2. 登记但未开放的动作零执行体调用；
 *   3. 写动作缺少身份、命中 HARD 内容规则、越过流程规则时零执行；
 *   4. 一次范围确认覆盖同一任务内的重复写，推送逐次确认；
 *   5. 人工评审留痕恒拒，命令面也不给注册。
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

function fakeHost({ approval, iam = IDENTITY } = {}) {
  const provided = new Map();
  const guards = [];
  const listeners = new Map();
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    get(name) {
      if (name === 'approval') return approval;
      if (name === 'iam') return iam;
      return provided.get(name);
    },
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, guards, provided, listeners };
}

const ACTIONS = [
  'change.read',
  'change.list',
  'gitee.repository.read',
  'gitee.issue.read',
  'gitee.pr.read',
  'gitee.delivery.judge',
  'gitee.issue.write',
  'gitee.pr.write',
  'gitee.review.publish',
  'change.clarification.write',
  'gitee.git.push',
  'gitee.review.record',
];
const TOOL = (action) => `forge_${action.replaceAll('.', '_')}`;
const TOOLS = Object.fromEntries(ACTIONS.map((action) => [TOOL(action), action]));

function mount({ catalog = ACTIONS.map((action) => ({ action, target: targetOf(action), enabled: true })), approval, iam } = {}) {
  const host = fakeHost({ approval, iam });
  apply(host.ctx, { audit: { sink: 'memory', allowNonDurable: true }, catalog, tools: TOOLS });
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

function targetOf(action) {
  if (action === 'change.read' || action === 'change.clarification.write') return 'change';
  if (action === 'change.list') return 'changes';
  if (action === 'gitee.delivery.judge') return 'change';
  if (action === 'gitee.issue.read' || action === 'gitee.issue.write') return 'issue';
  if (action === 'gitee.pr.read' || action === 'gitee.pr.write' || action === 'gitee.review.publish' || action === 'gitee.review.record') return 'pull-request';
  return 'repository';
}

const targetValue = (action) => (targetOf(action) === 'repository' ? 'acme/demo' : targetOf(action) === 'issue' ? 'acme/demo!1' : targetOf(action) === 'pull-request' ? 'acme/demo!2' : 'CHG-1');

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
  assert.match(model, /deny\s*>\s*confirm\s*>\s*allow/u, '判定模型必须写明三态取最严');
});

test('D1: 随包补丁层登记设计表全部动作，四层逐字一致且默认决策与设计一致', () => {
  const layers = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', entry.name, 'cordis.patch.yml'))
    .filter((path) => {
      try {
        return readFileSync(path, 'utf8').includes('id: heluo-policy');
      } catch {
        return false;
      }
    });
  assert.ok(layers.length >= 2, '至少两个 bundle 带策略补丁层');

  const catalogs = layers.map((path) => {
    const text = readFileSync(path, 'utf8');
    const start = text.search(/^ {4}- id: heluo-policy$/mu);
    assert.ok(start >= 0, `${path} 缺 YAML 策略行（注释里的 \`id: heluo-policy\` 不算登记）`);
    const section = text.slice(start).split('audit:')[0];
    const lines = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- { action: '));
    for (const line of lines) {
      assert.match(
        line,
        /^- \{ action: '[^']+', target: '[^']+', enabled: true \}$/u,
        `${path} 的登记行必须只写 action / target / enabled=true（类别与决策由内置词表决定）：${line}`,
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
      if (action === 'git commit') continue; // 本地动作出闸，不是策略动作
      documented.set(action, /^allow/u.test(row.decision) ? 'allow' : /^confirm/u.test(row.decision) ? 'confirm' : 'deny');
    }
  }
  assert.deepEqual(
    [...baseline.actions].sort(),
    [...documented.keys()].sort(),
    '随包目录必须登记设计表的全部动作：未登记的动作一律 unregistered-action 拒绝',
  );
  for (const action of baseline.actions) {
    assert.ok(BUILTIN_ACTIONS.has(action), `补丁层登记了未分类的动作 "${action}"`);
    assert.equal(defaultDecision(action), documented.get(action), `随包目录的 "${action}" 默认决策必须与设计表一致`);
  }
  assert.equal(
    baseline.actions.filter((action) => BUILTIN_ACTIONS.get(action)?.category !== 'read').length,
    6,
    '六条写动作必须随包登记：登记只决定"是否可见"，放行仍由内置分类（allow / confirm / deny）承担',
  );
});

test('D1: 登记但未开放的动作零执行体调用', async () => {
  const host = mount({ catalog: ACTIONS.map((action) => ({ action, target: targetOf(action), enabled: false })) });
  const denied = await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' });
  assert.match(String(denied.reason), /not enabled/u);
  const readDenied = await host.stage('gitee.repository.read', { target: 'acme/demo' });
  assert.match(String(readDenied.reason), /not enabled/u);
});

test('D1: 写动作缺少身份即拒绝，与内容无关', async () => {
  const host = mount({ iam: { getView: () => ({ state: 'signed-out', signedIn: false, principal: null }) } });
  const denied = await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'clean text' });
  assert.match(String(denied.reason), /authenticated identity/u);
});

test('D1: 命中 HARD 内容规则的写动作零执行，摘录已脱敏', async () => {
  const host = mount({ approval: { async request() { return 'allowed-once'; } } });
  const denied = await host.stage('gitee.issue.write', {
    target: 'acme/demo!1',
    changeId: 'CHG-1',
    // 拼出来，避免本文件本身触发仓库的敏感信息扫描。
    body: `token ${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`,
  });
  assert.match(String(denied.reason), /BUILTIN-TOKEN/u);
  assert.equal(JSON.stringify(denied.reason).includes('abcdefghijklmnopqrstuvwx'), false);
});

test('D1: 干净的写动作在一次范围确认后执行，重复写复用票据', async () => {
  const asked = [];
  const approval = { async request(request) { asked.push(request); return 'allowed-once'; } };
  const host = mount({ approval });
  assert.equal((await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' })).reason, undefined);
  assert.equal((await host.stage('gitee.issue.write', { target: 'acme/demo!3', changeId: 'CHG-1', body: 'plain text' })).reason, undefined);
  assert.equal(asked.length, 1, 'same principal + change + repository + action 复用一张票据');
  assert.equal(host.policy.scopeTickets().length, 1);
});

test('D1: 推送逐次确认，第二次推送仍要再问', async () => {
  let asked = 0;
  const approval = { async request() { asked += 1; return 'allowed-once'; } };
  const host = mount({ approval });
  assert.equal((await host.stage('gitee.git.push', { target: 'acme/demo', branch: 'feature/x' })).reason, undefined);
  assert.equal((await host.stage('gitee.git.push', { target: 'acme/demo', branch: 'feature/y' })).reason, undefined);
  assert.equal(asked, 2, '推送默认逐次确认，范围票据不覆盖 push');
});

test('D1: 人工评审留痕恒拒，登记也不改变', async () => {
  const host = mount();
  const denied = await host.stage('gitee.review.record', { target: 'acme/demo!2' });
  assert.match(String(denied.reason), /human-written records/u);
  assert.equal(host.policy.decide({ action: 'gitee.review.record', target: 'acme/demo!2' }).rule, 'human-record-action');
});

test('D1: 流程事实源不可用时记为 unevaluated 而不是拒绝', async () => {
  const host = mount({ approval: { async request() { return 'allowed-once'; } } });
  assert.equal((await host.stage('gitee.issue.write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' })).reason, undefined);
  const record = host.policy.auditRecords().find((item) => item.phase === 'begin');
  assert.deepEqual([...record.unevaluated], ['change-in-progress']);
});
