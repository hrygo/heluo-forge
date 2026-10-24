import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * D1（责任方 2026-10-24 决定"受控写白名单"）：策略设计 §5.1.1 的登记表在目录里
 * **全部默认关闭**。本文件把登记表变成可复现证据：每一条都以合法的 `target` 调用，
 * 仍然被 `action-disabled` 拦下且执行体零调用；把 `enabled` 翻成 `true` 才放行，
 * 证明拒绝来自"未批准"，不是别的原因。
 */
const REGISTER = [
  { action: 'change.clarification.write', kind: 'write', target: 'change' },
  { action: 'change.progress.write', kind: 'write', target: 'change' },
  { action: 'issue.create_or_update', kind: 'write', target: 'issue' },
  { action: 'branch.create', kind: 'write', target: 'repository' },
  { action: 'commit.record', kind: 'write', target: 'repository' },
  { action: 'pr.create_or_update', kind: 'write', target: 'pull-request' },
  { action: 'review.ai.publish', kind: 'write', target: 'pull-request' },
  { action: 'review.human.record', kind: 'confirm', target: 'pull-request' },
  { action: 'issue.close', kind: 'write', target: 'issue' },
  // 受控能力按类别登记；真实工具的实参名不是 `target`（见最后一个用例）。
  { action: 'shell.exec', kind: 'write', target: 'command' },
  { action: 'http.egress', kind: 'write', target: 'url' },
  { action: 'code.run', kind: 'write', target: 'code' },
];

const toolName = (action) => `forge_${action.replaceAll('.', '_')}`;
const CATALOG = REGISTER.map((entry) => ({ ...entry, enabled: false }));
const TOOLS = Object.fromEntries(REGISTER.map((entry) => [toolName(entry.action), entry.action]));
const CATEGORIES = { bash: 'shell.exec', pwsh: 'shell.exec' };

function fakeHost() {
  const provided = new Map();
  const guards = [];
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: () => () => {},
    get: (name) => provided.get(name),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, guards, provided };
}

function mount(catalog = CATALOG) {
  const host = fakeHost();
  apply(host.ctx, { audit: { sink: 'memory', allowNonDurable: true }, catalog, tools: TOOLS, categories: CATEGORIES });
  return host;
}

test('D1: 每一条登记的写/确认动作默认都被拒绝，且执行体零调用', () => {
  const host = mount();
  const guard = host.guards[0];
  let bodyCalls = 0;
  const denials = [];
  for (const entry of REGISTER) {
    const reason = guard({ name: toolName(entry.action), arguments: { target: 'X-1' }, callId: `c-${entry.action}` });
    if (reason === undefined) bodyCalls += 1;
    else denials.push([entry.action, String(reason)]);
  }
  assert.equal(bodyCalls, 0, '未批准的写动作一个都不许进入执行体');
  assert.equal(denials.length, REGISTER.length);
  for (const [action, reason] of denials) {
    assert.match(reason, /not enabled/u, `${action} 应因未开放被拒绝，实际：${reason}`);
  }
});

test('D1: 拒绝来自"未批准"——只把 enabled 翻成 true，同一调用即放行', () => {
  const enabled = CATALOG.map((entry) => (entry.action === 'issue.close' ? { ...entry, enabled: true } : entry));
  const host = mount(enabled);
  const reason = host.guards[0]({ name: toolName('issue.close'), arguments: { target: 'I-1' }, callId: 'c1' });
  assert.equal(reason, undefined, '一旦该动作被批准开放，门禁就不再拦它（否则上面的拒绝证明不了什么）');
});

test('D1: 策略服务把登记表里的动作全部列为已知动作', () => {
  const { provided } = mount();
  const actions = provided.get('policy').actions();
  assert.deepEqual([...actions].sort(), REGISTER.map((entry) => entry.action).sort());
});

test('D1: 设计正文 §5.1.1 的登记表与这里的目录逐条一致（防漂移）', () => {
  const design = readFileSync(join(root, 'docs/design/plugins/forge-policy.md'), 'utf8');
  const section = design.split('#### 5.1.1')[1]?.split('### 5.2')[0] ?? '';
  assert.ok(section.length > 0, '未能定位 §5.1.1 登记表');
  const listed = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const match of firstCell.matchAll(/`([a-z][a-z_]*(?:\.[a-z_]+)+)`/gu)) listed.add(match[1]);
  }
  assert.deepEqual([...listed].sort(), REGISTER.map((entry) => entry.action).sort(), '设计登记表与目录必须一一对应');
});

test('D1: 真实受控能力的实参名不是 target——按设计登记为关闭，且不声称已被门禁覆盖', () => {
  const host = mount();
  const guard = host.guards[0];
  // bash 走 `command`：门禁只读 `arguments.target`，因此这里必然拒绝（同期实测的目录缺口），
  // 而不是"看起来放行实则未受控"。缺口记在 #21，不在本测试里假装已解决。
  const reason = guard({ name: 'bash', arguments: { command: 'ls' }, callId: 'c-bash' });
  assert.notEqual(reason, undefined, 'bash 作为已声明类别不得被静默放行');
  assert.match(String(reason), /target|not enabled|not registered/u);
});
