import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpertsHost } from '../src/index.mjs';

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

function makeHost({ managementEnabled = true, isolatedMentionsPreviewEnabled = false, sessionScopes = null } = {}) {
  const data = new Map();
  const scope = { instanceId: 'inst-1', orgId: 'org-a', issuer: 'https://iam.example', subject: 'emp-1', validUntil: '2027-01-01T00:00:00Z' };
  const scopesMap = sessionScopes ?? new Map([['sess-1', 'proj-a']]);

  return createExpertsHost({
    config: { managementEnabled, isolatedMentionsPreviewEnabled, dispatchEnabled: false },
    getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject }),
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
    resolveDelegraScope: async () => scope,
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
    checkDelegraSessionScope: async ({ delegationScope, expertIds }) => ({
      scopeVerified: true,
      validUntil: '2027-01-01T00:00:00Z',
      results: expertIds.map((id) => ({
        expertId: id,
        callableInScope: delegationScope === 'proj-a',
        acceptingTasks: id === 'exp-paused' ? 'paused' : 'accepting',
        authContinuityDigest: id === 'exp-1' ? 'dig-1' : 'dig-2',
      })),
    }),
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

test('routes enforce connection auth, CSRF header, view-only rejection, PUT persistence, and SSE invalidation', async () => {
  const host = makeHost({ managementEnabled: true });
  await host.open();

  const unauth = await mockHttp(host.handleRequest, { method: 'GET', url: '/api/forge-experts/catalog?view=directory' });
  assert.equal(unauth.statusCode, 401);

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
