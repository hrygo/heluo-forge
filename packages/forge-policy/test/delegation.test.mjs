import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERSONA,
  agentKindOf,
  confirmDelegatedCopy,
  delegationCopy,
  delegationSummary,
  personaOf,
} from '../src/delegation.mjs';

const subagent = (extra = {}) => ({ kind: 'agent', session: { header: { origin: 'subagent', ...extra } }, ...extra });

test('the persona is decided by the host origin, never by parentSession', () => {
  assert.equal(personaOf(undefined), PERSONA.HOST, 'no agent means the host called directly');
  assert.equal(personaOf(null), PERSONA.HOST);
  assert.equal(personaOf({ kind: 'agent' }), PERSONA.ROOT);
  assert.equal(personaOf(subagent()), PERSONA.CHILD);
  assert.equal(personaOf({ session: { header: { origin: 'main' } } }), PERSONA.ROOT);
  // 历史普通 fork 也带 parentSession，宿主升级指南明说它不能当判据。
  assert.equal(personaOf({ session: { header: { parentSession: 'session-1' } } }), PERSONA.ROOT);
  assert.equal(personaOf({ session: { header: { parentSession: 'session-1', origin: 'subagent' } } }), PERSONA.CHILD);
  for (const kind of ['child', 'subagent', 'sub-agent', 'worker', 'teammate']) {
    assert.equal(personaOf({ kind }), PERSONA.CHILD, `legacy kind ${kind} is a child`);
  }
  for (const origin of ['child', 'subagent']) {
    assert.equal(personaOf({ origin }), PERSONA.CHILD, `legacy origin ${origin} is a child`);
  }
  assert.equal(personaOf({ kind: 'root' }), PERSONA.ROOT);
  assert.equal(personaOf({ kind: 'host' }), PERSONA.ROOT, 'a host-looking stub is still a live session');
  assert.equal(personaOf('agent'), PERSONA.ROOT, 'a non-object agent is not trusted as a child');
  assert.equal(personaOf(['subagent']), PERSONA.ROOT);
  assert.equal(Object.isFrozen(PERSONA), true);
});

test('the audit agent kind keeps the P0 string and normalises the rest', () => {
  assert.equal(agentKindOf(undefined), 'host');
  assert.equal(agentKindOf({}), 'host');
  assert.equal(agentKindOf({ agent: { kind: 'agent' } }), 'agent', 'a string kind passes through');
  assert.equal(agentKindOf({ agent: { kind: '  ' } }), 'root', 'a blank kind falls back to the persona');
  assert.equal(agentKindOf({ agent: subagent() }), 'child');
  assert.equal(agentKindOf({ agent: { session: { header: { origin: 'subagent' } } } }), 'child');
  assert.equal(agentKindOf({ agent: { kind: 'child' } }), 'child');
  assert.equal(agentKindOf({ agent: 'root' }), 'root');
});

test('delegation refusal copy names the action and points back to the main session', () => {
  const copy = delegationCopy('gitee.issue.write');
  assert.match(copy, /gitee\.issue\.write/u);
  assert.match(copy, /子代理/u);
  assert.match(copy, /主会话/u);
  // 明确的负面目标：不提示换工具、拆参数或绕过。
  assert.doesNotMatch(copy, /换一个工具|拆成|重试子代理|改用/u);
  assert.doesNotMatch(copy, /[A-Za-z]:[\\/]|\/Users\/|\/tmp\//u);

  const confirmCopy = confirmDelegatedCopy('gitee.git.push');
  assert.match(confirmCopy, /gitee\.git\.push/u);
  assert.match(confirmCopy, /主会话/u);
  assert.match(confirmCopy, /未执行/u);

  const summary = delegationSummary('gitee.review.publish');
  assert.match(summary, /gitee\.review\.publish/u);
  assert.match(summary, /子代理/u);
  assert.doesNotMatch(summary, /https?:\/\//u);
});
