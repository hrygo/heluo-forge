import assert from 'node:assert/strict';
import test from 'node:test';

import { createScopeLedger } from '../src/scope-ticket.mjs';

const base = {
  principal: 'user-a',
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
