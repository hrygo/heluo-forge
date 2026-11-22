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

function makeHost({ managementEnabled = true } = {}) {
  const data = new Map();
  const scope = { instanceId: 'inst-1', orgId: 'org-a', issuer: 'https://iam.example', subject: 'emp-1' };
  return createExpertsHost({
    config: { managementEnabled, dispatchEnabled: false },
    getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject }),
    getConnection: () => ({
      requestRejection({ headers }) {
        return headers?.['x-dsh-auth'] === 'ok' ? undefined : 401;
      },
    }),
    openStorageDomain: async () => ({
      async get(_t, k) { return data.get(k) ?? null; },
      async set(_t, k, v) { data.set(k, v); },
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
          summary: { disclosureState: 'available', responsibility: '代码评审' },
          access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'dig-1' },
          availability: { acceptingTasks: 'accepting' },
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
      callableInOrg: id === 'exp-1',
      authContinuityDigest: id === 'exp-1' ? 'dig-1' : null,
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

  // Unauthenticated connection rejected.
  const unauth = await mockHttp(host.handleRequest, { method: 'GET', url: '/api/forge-experts/catalog?view=directory' });
  assert.equal(unauth.statusCode, 401);

  // SSE stream emits ready frame.
  const sse = await mockHttp(host.handleRequest, {
    method: 'GET',
    url: '/api/forge-experts/events',
    headers: { 'x-dsh-auth': 'ok' },
  });
  assert.equal(sse.statusCode, 200);
  assert.match(sse.body, /"type":"ready"/);

  // Load directory -> exp-1 has editToken, exp-view has null preference.
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

  // View-only expert cannot be updated.
  const forbidden = await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-view',
    headers: { 'x-dsh-auth': 'ok', 'x-forge-experts-request': '1', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(JSON.parse(forbidden.body).error.code, 'EXPERT_CALL_FORBIDDEN');

  // Missing CSRF header rejected.
  const noHeader = await mockHttp(host.handleRequest, {
    method: 'PUT',
    url: '/api/forge-experts/preferences/exp-1',
    headers: { 'x-dsh-auth': 'ok', 'content-type': 'application/json' },
    body: { enabled: true, editToken: exp1.preference.editToken },
  });
  assert.equal(noHeader.statusCode, 403);
  assert.equal(JSON.parse(noHeader.body).error.code, 'EXPERT_REQUEST_HEADER_REQUIRED');

  // Valid PUT succeeds and updates revision.
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
