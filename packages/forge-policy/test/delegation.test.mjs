import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeDelegation, createDelegation, PolicyDelegationError, resumeDelegation, revokeDelegation } from '../src/delegation.mjs';
import { compileCatalog } from '../src/catalog.mjs';

const catalog = compileCatalog([
  { action: 'change.read', kind: 'read', target: 'change', enabled: true },
  { action: 'repository.read', kind: 'read', target: 'repository', enabled: true },
  { action: 'issue.create_or_update', kind: 'write', target: 'issue', enabled: true },
  { action: 'issue.close', kind: 'write', target: 'issue' },
]);

const facts = {
  id: 'dlg-1',
  source: 'host',
  principal: 'user-a',
  changeId: 'C-2026-1',
  repositories: ['repo-a'],
  actions: ['change.read', 'issue.create_or_update'],
  revisions: { change: 'rev-1' },
  ttlMs: 3_600_000,
  now: 1_000,
};

const request = { principal: 'user-a', changeId: 'C-2026-1', repository: 'repo-a', action: 'change.read', revisions: { change: 'rev-1' } };

test('a host delegation allows in-scope actions and denies everything else', () => {
  const grant = createDelegation(facts);
  assert.equal(authorizeDelegation({ grant, request, catalog, now: 2_000 }).action, 'allow');
  const cases = [
    [{ ...request, action: 'repository.read' }, 'delegation-action-out-of-scope'],
    [{ ...request, action: 'issue.close' }, 'delegation-action-disabled'],
    [{ ...request, action: 'story.read' }, 'delegation-action-unregistered'],
    [{ ...request, principal: 'user-b' }, 'delegation-principal-mismatch'],
    [{ ...request, changeId: 'C-2026-2' }, 'delegation-change-mismatch'],
    [{ ...request, repository: 'repo-b' }, 'delegation-repository-out-of-scope'],
    [{ ...request, revisions: { change: 'rev-2' } }, 'delegation-revision-drift'],
    [request, 'delegation-expired', 4_000_000],
  ];
  for (const [candidate, rule, now] of cases) {
    const decision = authorizeDelegation({ grant, request: candidate, catalog, now: now ?? 2_000 });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.rule, rule);
  }
});

test('a model-supplied or missing delegation cannot authorize anything', () => {
  assert.throws(
    () => createDelegation({ ...facts, source: 'model' }),
    (error) => error instanceof PolicyDelegationError && error.code === 'POLICY_DELEGATION_UNTRUSTED_SOURCE',
  );
  assert.equal(authorizeDelegation({ request, catalog }).rule, 'delegation-missing');
  assert.equal(
    authorizeDelegation({ grant: { ...createDelegation(facts), source: 'model' }, request, catalog }).rule,
    'delegation-untrusted-source',
  );
});

test('a revoked delegation stops authorizing immediately', () => {
  const grant = createDelegation(facts);
  const revoked = revokeDelegation(grant, { reason: 'user cancelled', now: 2_000 });
  assert.equal(authorizeDelegation({ grant, request, catalog, now: 2_500 }).action, 'allow', 'the original object is unchanged');
  const decision = authorizeDelegation({ grant: revoked, request, catalog, now: 2_500 });
  assert.equal(decision.rule, 'delegation-revoked');
  assert.throws(() => revokeDelegation(undefined), (error) => error.code === 'POLICY_DELEGATION_MISSING');
});

test('an incomplete delegation is refused at creation', () => {
  const invalid = [
    [{ ...facts, id: '' }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, repositories: [] }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, actions: [] }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, ttlMs: 0 }, 'POLICY_DELEGATION_INVALID'],
    [{ ...facts, principal: '' }, 'POLICY_DELEGATION_INVALID'],
  ];
  for (const [input, code] of invalid) {
    assert.throws(() => createDelegation(input), (error) => error.code === code);
  }
});

const hostResume = { source: 'host', principal: 'user-a', changeId: 'C-2026-1' };

test('resume re-verifies identity and can only keep or narrow the scope', () => {
  const grant = createDelegation(facts);
  assert.equal(grant.actions.length, 2);

  const same = resumeDelegation({ grant, resume: hostResume, now: 2_000 });
  assert.equal(same.action, 'allow');
  assert.equal(same.rule, 'delegation-resumed');
  assert.deepEqual([...same.grant.actions], [...grant.actions], '缺省继承同等范围');
  assert.equal(same.scopeReduced, false);
  assert.equal(same.grant.expiresAt, grant.expiresAt, '承接不得顺带续期');

  const narrowed = resumeDelegation({ grant, resume: { ...hostResume, actions: ['change.read'] }, now: 2_000 });
  assert.equal(narrowed.action, 'allow');
  assert.equal(narrowed.scopeReduced, true);
  assert.deepEqual([...narrowed.grant.actions], ['change.read']);

  const widened = resumeDelegation({ grant, resume: { ...hostResume, actions: ['change.read', 'issue.close'] }, now: 2_000 });
  assert.equal(widened.action, 'deny');
  assert.equal(widened.rule, 'delegation-resume-scope-widened');
  assert.deepEqual(widened.details.widened, ['issue.close']);
});

test('a resumed grant is enforced downstream with exactly its narrowed scope', () => {
  const grant = createDelegation(facts);
  const narrowed = resumeDelegation({ grant, resume: { ...hostResume, actions: ['change.read'] }, now: 2_000 });
  const allowed = authorizeDelegation({ grant: narrowed.grant, request, catalog, now: 2_500 });
  assert.equal(allowed.action, 'allow');
  const dropped = authorizeDelegation({ grant: narrowed.grant, request: { ...request, action: 'issue.create_or_update' }, catalog, now: 2_500 });
  assert.equal(dropped.action, 'deny');
  assert.equal(dropped.rule, 'delegation-action-out-of-scope');
});

test('a chat, temporary-map or model snapshot cannot restore write authorization', () => {
  const grant = createDelegation(facts);
  for (const source of ['chat', 'summary', 'temporary-map', 'model', undefined]) {
    const decision = resumeDelegation({ grant, resume: { ...hostResume, source }, now: 2_000 });
    assert.equal(decision.action, 'deny', `source=${String(source)} 应拒绝`);
    assert.equal(decision.rule, 'delegation-resume-untrusted-source', `source=${String(source)}`);
  }
});

test('resume refuses identity, change, repository and revision drift', () => {
  const grant = createDelegation(facts);
  const cases = [
    [{ ...hostResume, principal: 'user-b' }, 'delegation-resume-principal-changed'],
    [{ ...hostResume, changeId: 'C-2026-2' }, 'delegation-resume-change-mismatch'],
    [{ ...hostResume, repository: 'repo-b' }, 'delegation-resume-repository-out-of-scope'],
    [{ ...hostResume, revisions: { change: 'rev-2' } }, 'delegation-resume-revision-drift'],
    [{ ...hostResume, revisions: { story: 'rev-1' } }, 'delegation-resume-unverifiable'],
  ];
  for (const [resume, rule] of cases) {
    const decision = resumeDelegation({ grant, resume, now: 2_000 });
    assert.equal(decision.action, 'deny', JSON.stringify(resume));
    assert.equal(decision.rule, rule);
  }
});

test('resume fails closed on revoked, expired and unverifiable input', () => {
  const grant = createDelegation(facts);
  assert.equal(resumeDelegation({}, ).rule, 'delegation-missing');
  assert.equal(resumeDelegation({ grant: { ...grant, source: 'model' }, resume: hostResume, now: 2_000 }).rule, 'delegation-untrusted-source');
  assert.equal(resumeDelegation({ grant: revokeDelegation(grant, { now: 1_500 }), resume: hostResume, now: 2_000 }).rule, 'delegation-revoked');
  assert.equal(resumeDelegation({ grant, resume: hostResume, now: 9_000_000 }).rule, 'delegation-expired');
  assert.equal(resumeDelegation({ grant, resume: null, now: 2_000 }).rule, 'delegation-resume-unverifiable');
  assert.equal(resumeDelegation({ grant, resume: { ...hostResume, principal: undefined }, now: 2_000 }).rule, 'delegation-resume-unverifiable');
  assert.equal(resumeDelegation({ grant, resume: { ...hostResume, changeId: '' }, now: 2_000 }).rule, 'delegation-resume-unverifiable');
  assert.equal(resumeDelegation({ grant, resume: { ...hostResume, kind: 'impersonate' }, now: 2_000 }).rule, 'delegation-resume-unknown-kind');
  assert.equal(resumeDelegation({ grant, resume: { ...hostResume, actions: 'change.read' }, now: 2_000 }).rule, 'delegation-resume-unverifiable');
});

test('fork and subagent resumes record the host-attested origin', () => {
  const grant = createDelegation(facts);
  const forked = resumeDelegation({ grant, resume: { ...hostResume, kind: 'fork' }, now: 2_000 });
  assert.equal(forked.action, 'allow');
  assert.equal(forked.grant.resumeKind, 'fork');
  assert.equal(forked.grant.forkedFrom, grant.id);

  const unproven = resumeDelegation({ grant, resume: { ...hostResume, kind: 'subagent' }, now: 2_000 });
  assert.equal(unproven.rule, 'delegation-resume-unverifiable');
  const subagent = resumeDelegation({
    grant,
    resume: { ...hostResume, kind: 'subagent', agentId: 'agent-7', actions: ['change.read'] },
    now: 2_000,
  });
  assert.equal(subagent.action, 'allow');
  assert.equal(subagent.grant.resumeKind, 'subagent');
  assert.equal(subagent.grant.delegatedTo, 'agent-7');
  assert.deepEqual([...subagent.grant.actions], ['change.read']);
});
