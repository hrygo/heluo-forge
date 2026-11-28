import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createExpertsHost } from '../src/index.mjs';
import { EDIT_TOKEN_HEADER } from '../src/routes.mjs';

function mockHttp(handler, { method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    let bodyFlushed = false;
    const flushBody = () => {
      if (bodyFlushed || body === null) return;
      if (!listeners.has('data') || !listeners.has('end')) return;
      bodyFlushed = true;
      queueMicrotask(() => {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
        listeners.get('end')?.();
      });
    };
    const req = {
      method,
      url,
      headers,
      on(event, fn) {
        listeners.set(event, fn);
        flushBody();
      },
    };
    const resHeaders = {};
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      write(chunk) { chunks.push(String(chunk)); },
      end(chunk = '') {
        this.headersSent = true;
        if (chunk) chunks.push(String(chunk));
        resolve({ statusCode: res.statusCode, headers: resHeaders, body: chunks.join('') });
      },
    };
    Promise.resolve(handler(req, res))
      .then(() => {
        if (method === 'GET' && url.includes('/events') && res.statusCode === 200) {
          resolve({ statusCode: res.statusCode, headers: resHeaders, body: chunks.join(''), close: () => listeners.get('close')?.() });
        }
      })
      .catch(reject);
  });
}

function makeHost({
  managementEnabled = true, isolatedMentionsPreviewEnabled = false, dispatchEnabled = false,
  sessionScopes = null, checkDelegraSessionScope = null, readIamOrg, beforeResolveDelegraScope,
} = {}) {
  const data = new Map();
  const scope = { instanceId: 'inst-1', orgId: 'org-a', issuer: 'https://iam.example', subject: 'emp-1', validUntil: '2027-01-01T00:00:00Z' };
  const scopesMap = sessionScopes ?? new Map([['sess-1', 'proj-a']]);

  return createExpertsHost({
    config: { managementEnabled, isolatedMentionsPreviewEnabled, dispatchEnabled },
    getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject, orgId: readIamOrg?.() }),
    getConnection: () => ({
      requestRejection({ headers }) {
        return headers?.['x-dsh-auth'] === 'ok' ? undefined : 401;
      },
    }),
    // Mirrors `storageDomain.open(spec) -> Domain` with `domain.table(name) -> KvTable`
    // (get/put), i.e. the shape the DSH host actually hands a plugin.
    openStorageDomain: async () => ({
      table: () => ({
        get: (k) => data.get(k),
        put: async (k, v) => { data.set(k, v); },
      }),
      async close() {},
    }),
    async resolveDelegraScope() {
      await beforeResolveDelegraScope?.();
      return scope;
    },
    fetchDelegraCatalog: async ({ scope: s }) => ({
      scope: s,
      catalogVersion: 'cv-1',
      completeness: 'complete',
      items: [
        {
          expertId: 'exp-1',
          displayName: '研发助手',
          disambiguation: '后端架构组',
          summary: { disclosureState: 'available', responsibility: '代码评审' },
          access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'dig-1' },
          availability: { acceptingTasks: 'accepting' },
        },
        {
          expertId: 'exp-paused',
          displayName: '研发助手',
          disambiguation: '前端测试组',
          summary: { disclosureState: 'available', responsibility: 'UI 回归' },
          access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'dig-2' },
          availability: { acceptingTasks: 'paused' },
        },
        {
          expertId: 'exp-view',
          displayName: '只读专家',
          summary: { disclosureState: 'restricted' },
          access: { readable: true, callableInOrg: false, callableReason: 'view_only', authContinuityDigest: null },
          availability: { acceptingTasks: 'accepting' },
        },
      ],
      page: { nextCursor: null, hasMore: false },
    }),
    verifyOrgCallable: async (_s, id) => ({
      callableInOrg: id === 'exp-1' || id === 'exp-paused',
      authContinuityDigest: id === 'exp-1' ? 'dig-1' : id === 'exp-paused' ? 'dig-2' : null,
    }),
    resolveSessionScope: async (sessionId) => {
      const ds = scopesMap.get(sessionId);
      return ds ? { delegationScope: ds } : null;
    },
    checkDelegraSessionScope: checkDelegraSessionScope ?? (async ({ delegationScope, expertIds }) => ({
      scopeVerified: true,
      validUntil: '2027-01-01T00:00:00Z',
      results: expertIds.map((id) => ({
        expertId: id,
        callableInScope: delegationScope === 'proj-a',
        acceptingTasks: id === 'exp-paused' ? 'paused' : 'accepting',
        authContinuityDigest: id === 'exp-1' ? 'dig-1' : 'dig-2',
      })),
    })),
  });
}

async function openExpertEventStream(host) {
  const request = Object.assign(new EventEmitter(), {
    method: 'GET', url: '/api/forge-experts/events', headers: { 'x-dsh-auth': 'ok' },
  });
  const frames = [];
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    write(chunk) { frames.push(JSON.parse(chunk.slice(6))); },
    end(chunk) {
      this.writableEnded = true;
      if (chunk) this.body = JSON.parse(chunk);
    },
  };
  await host.handleRequest(request, response);
  return { frames, response, close: () => request.emit('close') };
}

async function prepareExpertTurn(host, scopeEpoch, draftVersion = 1) {
  const draft = { sessionId: 'sess-1', taskText: 'Synthetic draft for recovery', draftVersion, reuseRefs: ['ref-review'] };
  const selection = await mockHttp(host.handleRequest, {
    method: 'POST', url: '/api/forge-experts/selections',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { ...draft, expertId: 'exp-1', scopeEpoch },
  });
  assert.equal(selection.statusCode, 201);
  const pick = JSON.parse(selection.body);
  const turn = await host.prestep.prepareTurn({ ...draft, selectionToken: pick.selectionToken });
  assert.equal(turn.allowed, true);
  return { ...turn, draftRecoveryId: pick.draftRecoveryId };
}

function recentExpertTurns(host) {
  return mockHttp(host.handleRequest, {
    method: 'GET', url: '/api/forge-experts/turns/finalized', headers: { 'x-dsh-auth': 'ok' },
  });
}

test('SSE ready distinguishes a new Host at the same scope epoch and identifies same-Host reconnects (#484)', async (t) => {
  const originalHost = makeHost();
  const restartedHost = makeHost();
  await originalHost.open();
  t.after(() => originalHost.close());
  await restartedHost.open();
  t.after(() => restartedHost.close());

  const original = await openExpertEventStream(originalHost);
  const [firstReady] = original.frames;
  original.close();
  const reconnected = await openExpertEventStream(originalHost);
  const [reconnectReady] = reconnected.frames;
  const restarted = await openExpertEventStream(restartedHost);
  const [restartReady] = restarted.frames;

  assert.equal(firstReady.type, 'ready');
  assert.equal(restartReady.scopeEpoch, firstReady.scopeEpoch);
  assert.equal(typeof firstReady.hostInstanceId, 'string');
  assert.ok(firstReady.hostInstanceId);
  assert.equal(reconnectReady.hostInstanceId, firstReady.hostInstanceId);
  assert.equal(typeof restartReady.hostInstanceId, 'string');
  assert.notEqual(restartReady.hostInstanceId, firstReady.hostInstanceId);
});

test('turn recovery stays within its epoch when one employee changes IAM organization with the same Delegra scope', async (t) => {
  let iamOrg = 'iam-org-before';
  const host = makeHost({ dispatchEnabled: true, readIamOrg: () => iamOrg });
  await host.open();
  t.after(() => host.close());
  const oldStream = await openExpertEventStream(host);
  const [{ scopeEpoch: oldEpoch }] = oldStream.frames;
  const oldTurn = await prepareExpertTurn(host, oldEpoch);

  iamOrg = 'iam-org-after';
  const newStream = await openExpertEventStream(host);
  const [{ scopeEpoch: newEpoch }] = newStream.frames;
  assert.ok(newEpoch > oldEpoch);
  const oldResult = host.prestep.finalizeTurn({ turnId: oldTurn.turnId });
  assert.equal(oldResult.preserveDraft, true);
  assert.equal(oldResult.draft.taskText, 'Synthetic draft for recovery');
  await new Promise(setImmediate);

  assert.ok(oldStream.frames.some((event) => event.type === 'scope-changed' && event.scopeEpoch === newEpoch));
  assert.equal(oldStream.frames.some((event) => event.type === 'turn-finalized'), false);
  assert.equal(newStream.frames.some((event) => event.type === 'turn-finalized'), false);
  assert.equal(oldStream.response.writableEnded, true);
  const afterSwitch = await recentExpertTurns(host);
  assert.equal(afterSwitch.statusCode, 200);
  assert.deepEqual(JSON.parse(afterSwitch.body), { scopeEpoch: newEpoch, items: [] });

  const current = await prepareExpertTurn(host, newEpoch, 2);
  host.prestep.finalizeTurn({ turnId: current.turnId });
  await new Promise(setImmediate);
  const [published] = newStream.frames.filter((event) => event.type === 'turn-finalized');
  assert.equal(published.scopeEpoch, newEpoch);
  assert.equal(published.draftRecoveryId, current.draftRecoveryId);
  assert.equal(published.status, 'model_did_not_delegate');
  for (const privateField of ['draft', 'taskText', 'reuseRefs', 'selectionToken']) {
    assert.equal(Object.hasOwn(published, privateField), false);
  }
  newStream.close();
  const reconnected = await openExpertEventStream(host);
  assert.equal(reconnected.frames[0].scopeEpoch, newEpoch);
  const { type, ...item } = published;
  const recent = await recentExpertTurns(host);
  assert.deepEqual(JSON.parse(recent.body), { scopeEpoch: newEpoch, items: [item] });
});

test('turn recovery SSE rechecks live IAM before publishing without another scoped request', async (t) => {
  let iamOrg = 'iam-org-before';
  const host = makeHost({ dispatchEnabled: true, readIamOrg: () => iamOrg });
  await host.open();
  t.after(() => host.close());
  const stream = await openExpertEventStream(host);
  const [{ scopeEpoch }] = stream.frames;
  const turn = await prepareExpertTurn(host, scopeEpoch);

  iamOrg = 'iam-org-after';
  const result = host.prestep.finalizeTurn({ turnId: turn.turnId });
  assert.equal(result.preserveDraft, true);
  await new Promise(setImmediate);

  assert.equal(host.scope.getSnapshot().scopeEpoch, scopeEpoch);
  assert.equal(stream.frames.some((event) => event.type === 'turn-finalized'), false);
});

for (const useStream of [false, true]) {
  test(`turn recovery ${useStream ? 'SSE registration' : 'HTTP read'} rechecks live IAM when organization changes during scope resolution`, async (t) => {
    let iamOrg = 'iam-org-before';
    let pauseScope = false;
    const scopeReadStarted = Promise.withResolvers();
    const resumeScope = Promise.withResolvers();
    const host = makeHost({
      dispatchEnabled: true,
      readIamOrg: () => iamOrg,
      async beforeResolveDelegraScope() {
        if (!pauseScope) return;
        scopeReadStarted.resolve();
        await resumeScope.promise;
      },
    });
    await host.open();
    t.after(async () => { resumeScope.resolve(); await host.close(); });
    const stream = await openExpertEventStream(host);
    const [{ scopeEpoch }] = stream.frames;
    const turn = await prepareExpertTurn(host, scopeEpoch);
    host.prestep.finalizeTurn({ turnId: turn.turnId });
    await new Promise(setImmediate);
    assert.equal(stream.frames.some((event) => event.type === 'turn-finalized'), true);

    pauseScope = true;
    const pending = useStream ? openExpertEventStream(host) : recentExpertTurns(host);
    await scopeReadStarted.promise;
    iamOrg = 'iam-org-after';
    resumeScope.resolve();

    const stale = await pending;
    const response = useStream ? stale.response : stale;
    assert.equal(response.statusCode, 409);
    const body = useStream ? response.body : JSON.parse(response.body);
    assert.equal(body.error.code, 'EXPERT_SCOPE_MISMATCH');
    assert.equal(Object.hasOwn(body, 'items'), false);
    if (useStream) {
      assert.deepEqual(stale.frames, []);
      assert.equal(host.routes.clientCount(), 1, 'only the previously established stream remains registered');
    }
  });
}

test('management disabled by default returns 503 EXPERT_MANAGEMENT_DISABLED', async () => {
  const host = makeHost({ managementEnabled: false });
  const res = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/catalog?view=callable',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error.code, 'EXPERT_MANAGEMENT_DISABLED');
});

test('routes enforce connection auth, CSRF header, view-only rejection, malformed expertId 422, PUT persistence, header settlement readback, and SSE invalidation', async () => {
  const host = makeHost({ managementEnabled: true });
  await host.open();

  const unauth = await mockHttp(host.handleRequest, { method: 'GET', url: '/api/forge-experts/catalog?view=directory' });
  assert.equal(unauth.statusCode, 401);

  // Malformed percent encoding and encoded slash must return 422 EXPERT_REQUEST_INVALID, not 500.
  const badEncoding = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/preferences/%ZZ',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(badEncoding.statusCode, 422);
  assert.equal(JSON.parse(badEncoding.body).error.code, 'EXPERT_REQUEST_INVALID');

  const encodedSlash = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/preferences/exp%2F1',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(encodedSlash.statusCode, 422);
  assert.equal(JSON.parse(encodedSlash.body).error.code, 'EXPERT_REQUEST_INVALID');

  const sse = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/events',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(sse.statusCode, 200);
  assert.match(sse.body, /"type":"ready"/);

  const dir = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/catalog?view=directory',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(dir.statusCode, 200);
  const parsedDir = JSON.parse(dir.body);
  const exp1 = parsedDir.items.find((i) => i.expertId === 'exp-1');
  assert.equal(exp1.preference.enabled, false);
  assert.ok(exp1.preference.editToken);

  const forbidden = await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-view',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(JSON.parse(forbidden.body).error.code, 'EXPERT_CALL_FORBIDDEN');

  const noHeader = await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });
  assert.equal(noHeader.statusCode, 403);
  assert.equal(JSON.parse(noHeader.body).error.code, 'EXPERT_REQUEST_HEADER_REQUIRED');

  const put = await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });
  assert.equal(put.statusCode, 200);
  const saved = JSON.parse(put.body);
  assert.equal(saved.enabled, true);
  assert.equal(saved.revision, 1);

  // Settlement reconciliation reads editToken from header rather than URL query string.
  const settled = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', [EDIT_TOKEN_HEADER]: exp1.preference.editToken },
  });
  assert.equal(settled.statusCode, 200);
  assert.equal(JSON.parse(settled.body).settlement, 'saved');

  sse.close?.();
  await host.close();
  assert.equal(host.routes.clientCount(), 0);
});

test('mentions route stays closed by default and enforces three-way intersection plus A -> B -> A version progression when isolated preview is enabled', async () => {
  // Default config: mentions disabled even when managementEnabled is true.
  const closedHost = makeHost({ managementEnabled: true, isolatedMentionsPreviewEnabled: false });
  await closedHost.open();
  const closedRes = await mockHttp(closedHost.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-1',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(closedRes.statusCode, 404, 'a closed projection is 404, not a retryable 503');
  assert.equal(JSON.parse(closedRes.body).error.code, 'EXPERT_MENTIONS_DISABLED');
  await closedHost.close();

  // Isolated preview enabled.
  const sessionScopes = new Map([['sess-1', 'proj-a']]);
  const host = makeHost({ managementEnabled: true, isolatedMentionsPreviewEnabled: true, sessionScopes });
  await host.open();

  // Missing sessionId -> 422; unknown session scope -> 409 EXPERT_SCOPE_UNVERIFIED.
  const noSess = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(noSess.statusCode, 422);

  const unknownSess = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-unknown',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(unknownSess.statusCode, 409);
  assert.equal(JSON.parse(unknownSess.body).error.code, 'EXPERT_SCOPE_UNVERIFIED');

  // Enable both exp-1 (accepting) and exp-paused (paused).
  const dir = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/catalog?view=callable',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  const exp1 = dir.items.find((i) => i.expertId === 'exp-1');
  const expPaused = dir.items.find((i) => i.expertId === 'exp-paused');

  const put1 = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  })).body);
  await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-paused',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: expPaused.preference.editToken },
  });

  // Project A: only exp-1 passes (callableInScope && accepting && enabled); exp-paused excluded.
  const projA1 = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-1',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  assert.equal(projA1.candidates.length, 1);
  assert.equal(projA1.candidates[0].expertId, 'exp-1');
  assert.equal(projA1.candidates[0].disambiguation, '后端架构组');

  // Switch sess-1 to Project B -> empty candidates, viewVersion increments, personal preference stays enabled.
  sessionScopes.set('sess-1', 'proj-b');
  const projB = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-1',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  assert.equal(projB.candidates.length, 0);
  assert.ok(projB.viewVersion > projA1.viewVersion);

  // Switch sess-1 back to Project A (A -> B -> A) -> exp-1 returns with strictly higher viewVersion.
  sessionScopes.set('sess-1', 'proj-a');
  const projA2 = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-1',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  assert.equal(projA2.candidates.length, 1);
  assert.ok(projA2.viewVersion > projB.viewVersion);

  // Disable exp-1 -> immediately leaves mentions candidates.
  await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: false, editToken: put1.editToken },
  });
  const afterDisable = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-1',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  assert.equal(afterDisable.candidates.length, 0);

  await host.close();
});

test('concurrent mentions queries isolate per-session scope transitions while still honoring global invalidation', async () => {
  const sessionScopes = new Map([
    ['sess-a', 'proj-a'],
    ['sess-b', 'proj-a'],
  ]);
  let releaseSessA;
  let blockNextProjA = false;

  const host = makeHost({
    managementEnabled: true,
    isolatedMentionsPreviewEnabled: true,
    sessionScopes,
    checkDelegraSessionScope: async ({ delegationScope, expertIds }) => {
      if (blockNextProjA && delegationScope === 'proj-a') {
        blockNextProjA = false;
        await new Promise((resolve) => { releaseSessA = resolve; });
      }
      return {
        scopeVerified: true,
        validUntil: '2027-01-01T00:00:00Z',
        results: expertIds.map((id) => ({
          expertId: id,
          callableInScope: delegationScope === 'proj-a',
          acceptingTasks: 'accepting',
          authContinuityDigest: 'dig-1',
        })),
      };
    },
  });
  await host.open();

  const dir = JSON.parse((await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/catalog?view=callable',
    headers: { 'x-dsh-auth': 'ok' },
  })).body);
  const exp1 = dir.items.find((i) => i.expertId === 'exp-1');
  await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });

  // Prime sess-b on proj-a so switching sess-b to proj-b advances sess-b's version.
  const primeB = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-b',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(primeB.statusCode, 200);

  // Start slow query for sess-a, then switch sess-b to proj-b concurrently.
  blockNextProjA = true;
  const inflightA = mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-a',
    headers: { 'x-dsh-auth': 'ok' },
  });
  sessionScopes.set('sess-b', 'proj-b');
  const resB = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-b',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(resB.statusCode, 200);
  assert.equal(JSON.parse(resB.body).candidates.length, 0);

  releaseSessA();
  const resA = await inflightA;
  assert.equal(resA.statusCode, 200, 'unrelated session scope transition must not invalidate sess-a');
  assert.equal(JSON.parse(resA.body).candidates.length, 1);

  // Global invalidation while sess-a is in-flight must still reject with 409 EXPERT_SCOPE_MISMATCH.
  blockNextProjA = true;
  const inflightA2 = mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/mentions?sessionId=sess-a',
    headers: { 'x-dsh-auth': 'ok' },
  });
  // Wait one microtask so inflightA2 enters checkDelegraSessionScope.
  await new Promise((resolve) => setTimeout(resolve, 10));
  host.mentions.invalidate(1, null);
  releaseSessA();
  const resA2 = await inflightA2;
  assert.equal(resA2.statusCode, 409);
  assert.equal(JSON.parse(resA2.body).error.code, 'EXPERT_SCOPE_MISMATCH');

  await host.close();
});
