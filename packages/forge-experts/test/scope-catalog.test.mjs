import assert from 'node:assert/strict';
import test from 'node:test';
import { createScopeManager } from '../src/scope.mjs';
import { createCatalogService } from '../src/catalog.mjs';

const SCOPE_A = {
  instanceId: 'inst-1',
  orgId: 'org-a',
  issuer: 'https://iam.example',
  subject: 'emp-1',
  validUntil: '2026-12-01T00:00:00Z',
};

const SCOPE_B = {
  instanceId: 'inst-1',
  orgId: 'org-b',
  issuer: 'https://iam.example',
  subject: 'emp-2',
  validUntil: '2026-12-01T00:00:00Z',
};

test('scope manager rejects unauthenticated IAM session and advances epoch on identity switch', async () => {
  let session = { state: 'signed-out' };
  let bound = SCOPE_A;
  const changes = [];
  const scope = createScopeManager({
    getIamSession: () => session,
    resolveDelegraScope: () => bound,
    onScopeChanged: (event) => changes.push(event),
  });

  await assert.rejects(() => scope.resolveForRequest(), (err) => err.code === 'EXPERT_UNAUTHENTICATED');

  session = { state: 'ready', issuer: SCOPE_A.issuer, subject: SCOPE_A.subject };
  const first = await scope.resolveForRequest();
  assert.equal(first.orgId, 'org-a');
  const epochA = first.scopeEpoch;

  // Mismatched Delegra subject must be rejected.
  bound = SCOPE_B;
  await assert.rejects(() => scope.resolveForRequest(), (err) => err.code === 'EXPERT_SCOPE_MISMATCH');

  // Switch to emp-2 -> epoch increments, old epoch assertion fails.
  session = { state: 'ready', issuer: SCOPE_B.issuer, subject: SCOPE_B.subject };
  const second = await scope.resolveForRequest();
  assert.equal(second.orgId, 'org-b');
  assert.ok(second.scopeEpoch > epochA);
  assert.throws(() => scope.assertCurrent(epochA, first), (err) => err.code === 'EXPERT_SCOPE_MISMATCH');
  assert.ok(changes.length >= 2);
});

test('stale Delegra verification cannot replace the newer IAM scope or advance its epoch (#484)', async () => {
  const lookupStarted = Promise.withResolvers();
  const releaseOldLookup = Promise.withResolvers();
  const changes = [];
  let subject = SCOPE_A.subject;
  let delayOldLookup = false;
  const scope = createScopeManager({
    getIamSession: () => ({ state: 'ready', issuer: SCOPE_A.issuer, subject }),
    async resolveDelegraScope(session) {
      if (session.subject === SCOPE_B.subject) return SCOPE_B;
      if (delayOldLookup) {
        lookupStarted.resolve();
        await releaseOldLookup.promise;
      }
      return SCOPE_A;
    },
    onScopeChanged: ({ scope: current }) => changes.push(current.subject),
  });
  await scope.resolveForRequest();

  delayOldLookup = true;
  const stale = scope.resolveForRequest();
  await lookupStarted.promise;
  subject = SCOPE_B.subject;
  const current = await scope.resolveForRequest();
  releaseOldLookup.resolve();

  await assert.rejects(stale, { code: 'EXPERT_SCOPE_MISMATCH' });
  assert.doesNotThrow(() => scope.assertCurrent(current.scopeEpoch, current));
  assert.deepEqual(changes, [SCOPE_A.subject, SCOPE_B.subject]);
});

test('catalog separates directory vs callable views, deduplicates in-flight reads, and discards late responses after scope change', async () => {
  let activeSession = { state: 'ready', issuer: SCOPE_A.issuer, subject: SCOPE_A.subject };
  let activeBound = SCOPE_A;
  let fetchCount = 0;
  let releaseDelayed;

  const scope = createScopeManager({
    getIamSession: () => activeSession,
    resolveDelegraScope: () => activeBound,
  });

  const catalog = createCatalogService({
    resolveScope: () => scope.resolveForRequest(),
    assertScopeCurrent: (epoch, s) => scope.assertCurrent(epoch, s),
    async fetchDelegraCatalog({ scope: reqScope, query }) {
      fetchCount += 1;
      if (query === 'delayed') {
        await new Promise((resolve) => { releaseDelayed = resolve; });
      }
      return {
        scope: reqScope,
        catalogVersion: 'cv-1',
        completeness: 'complete',
        items: [
          {
            expertId: 'exp-1',
            displayName: '经营分析专家',
            disambiguation: '财务组',
            summary: { disclosureState: 'available', responsibility: '报表分析' },
            access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'dig-1' },
            availability: { acceptingTasks: 'accepting' },
          },
          {
            expertId: 'exp-2',
            displayName: '经营分析专家',
            disambiguation: '审计组',
            summary: { disclosureState: 'missing' },
            access: { readable: true, callableInOrg: false, callableReason: 'view_only', authContinuityDigest: null },
            availability: { acceptingTasks: 'paused' },
          },
        ],
        page: { nextCursor: null, hasMore: false },
      };
    },
  });

  // Concurrent identical reads coalesce to a single upstream fetch.
  const [dir1, dir2] = await Promise.all([catalog.list({ view: 'directory' }), catalog.list({ view: 'directory' })]);
  assert.equal(fetchCount, 1);
  assert.equal(dir1.items.length, 2);
  assert.equal(dir2.items.length, 2);
  assert.equal(dir1.items[0].disambiguation, '财务组');
  assert.equal(dir1.items[1].summary.disclosureState, 'missing');

  // Callable view excludes view-only expert.
  const callable = await catalog.list({ view: 'callable' });
  assert.equal(callable.items.length, 1);
  assert.equal(callable.items[0].expertId, 'exp-1');

  // Late response arriving after scope switch must be rejected.
  const delayedPromise = catalog.list({ view: 'directory', query: 'delayed' });
  await new Promise((r) => setTimeout(r, 10));
  activeSession = { state: 'ready', issuer: SCOPE_B.issuer, subject: SCOPE_B.subject };
  activeBound = SCOPE_B;
  await scope.resolveForRequest();
  releaseDelayed();
  await assert.rejects(() => delayedPromise, (err) => err.code === 'EXPERT_SCOPE_MISMATCH');
});
