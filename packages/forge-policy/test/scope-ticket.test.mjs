import assert from 'node:assert/strict';
import test from 'node:test';

import { createScopeLedger } from '../src/scope-ticket.mjs';

const base = {
  principal: 'user-a',
  session: 'session-1',
  changeId: 'CHG-1',
  action: 'gitee.issue.write',
  repository: 'acme/demo',
};

test('同范围同版本的票据复用，不重复打扰人', () => {
  const ledger = createScopeLedger();
  const first = ledger.issue({ ...base, revisions: { repository: 'rev-1' } });
  const again = ledger.issue({ ...base, revisions: { repository: 'rev-1' } });
  assert.equal(again.id, first.id);
  assert.equal(ledger.list().length, 1);
});

test('同范围换版本时换新票据，旧票据被撤销而不是继续复用', () => {
  const ledger = createScopeLedger();
  const first = ledger.issue({ ...base, revisions: { repository: 'rev-1' } });
  const second = ledger.issue({ ...base, revisions: { repository: 'rev-2' } });
  assert.notEqual(second.id, first.id, '旧票据的绑定版本已不适用，不能复用');
  assert.equal(second.revisions.repository, 'rev-2');
  const [old] = ledger.list().filter((ticket) => ticket.id === first.id);
  assert.equal(old.revokedAt !== undefined, true);
  const verified = ledger.verify({ ...base, revisions: { repository: 'rev-2' } });
  assert.equal(verified.ok, true);
  assert.equal(verified.ticketId, second.id);
});

test('撤销后不再放行，也不接受空版本冒充已绑定版本', () => {
  const ledger = createScopeLedger();
  const ticket = ledger.issue({ ...base, revisions: { repository: 'rev-1' } });
  assert.equal(ledger.verify({ ...base, revisions: { repository: 'rev-1' } }).ok, true);
  assert.equal(ledger.verify({ ...base, revisions: {} }).ok, false);
  ledger.revoke(ticket.id);
  assert.equal(ledger.verify({ ...base, revisions: { repository: 'rev-1' } }).ok, false);
});

test('同一身份换一个会话要重新确认：票据不跨会话复用', () => {
  const ledger = createScopeLedger();
  const first = ledger.issue({ ...base, revisions: { repository: 'rev-1' } });
  assert.equal(ledger.verify({ ...base, revisions: { repository: 'rev-1' } }).ok, true);
  const other = ledger.verify({
    ...base,
    session: 'session-2',
    revisions: { repository: 'rev-1' },
  });
  assert.equal(other.ok, false, '会话变了，旧确认不能顶替新会话的范围');
  assert.equal(other.reason, 'no confirmed task scope covers gitee.issue.write on acme/demo');
  assert.equal(ledger.issue({ ...base, session: 'session-2', revisions: { repository: 'rev-1' } }).id !== first.id, true);
});

test('没有可信会话身份时既不建票据也不放行', () => {
  const ledger = createScopeLedger();
  assert.throws(() => ledger.issue({ ...base, session: undefined, revisions: {} }), /session is required/u);
  const unknown = ledger.verify({ ...base, session: undefined, revisions: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'the task scope needs a trusted session');
});
