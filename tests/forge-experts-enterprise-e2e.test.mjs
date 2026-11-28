import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createIamService } from '../packages/forge-iam/src/service.mjs';
import { createGrantStore } from '../packages/forge-iam/src/store.mjs';
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT_TYPE } from '../packages/forge-iam/src/service-token-exchange.mjs';
import { MemoryCredentials } from '../packages/forge-iam/test/support/memory-credentials.mjs';
import { apply as applyPolicy } from '../packages/forge-policy/src/index.mjs';
import { apply as applyExperts } from '../packages/forge-experts/src/index.mjs';
import { API_PREFIX, REQUEST_HEADER } from '../packages/forge-experts/src/routes.mjs';

function createMemoryStorage() {
  const domains = new Map();
  return {
    domains,
    async open(spec) {
      let tables = domains.get(spec.name);
      if (!tables) {
        tables = new Map();
        domains.set(spec.name, tables);
      }
      return {
        table(tableName) {
          let rows = tables.get(tableName);
          if (!rows) {
            rows = new Map();
            tables.set(tableName, rows);
          }
          const schema = spec.tables?.[tableName]?.valueSchema;
          return {
            get(key) {
              return rows.get(key);
            },
            async put(key, value) {
              const parsed = schema?.parse ? schema.parse(value) : value;
              rows.set(key, parsed);
            },
          };
        },
        async close() {},
      };
    },
  };
}

function createSyntheticCordisHost({ storage, iam }) {
  const services = new Map();
  const routes = [];
  const registeredTools = new Map();
  const preStepHooks = [];
  const toolGuards = [];
  const eventListeners = new Map();
  const effects = [];

  if (iam) services.set('iam', iam);
  services.set('connection', { requestRejection: () => undefined });
  services.set('storageDomain', { open: (spec) => storage.open(spec) });
  services.set('webServer', {
    register(route) {
      routes.push(route);
      return () => {
        const idx = routes.indexOf(route);
        if (idx >= 0) routes.splice(idx, 1);
      };
    },
  });
  services.set('tools', {
    register(def) {
      registeredTools.set(def.name, def);
      return () => registeredTools.delete(def.name);
    },
    guard(fn) {
      toolGuards.push(fn);
      return () => {
        const idx = toolGuards.indexOf(fn);
        if (idx >= 0) toolGuards.splice(idx, 1);
      };
    },
  });
  services.set('agentHooks', {
    registerPreStep(hook) {
      preStepHooks.push(hook);
      return () => {
        const idx = preStepHooks.indexOf(hook);
        if (idx >= 0) preStepHooks.splice(idx, 1);
      };
    },
  });

  const ctx = {
    get: (name) => services.get(name),
    tools: services.get('tools'),
    provide(name, value) {
      services.set(name, value);
      return () => {
        if (services.get(name) === value) services.delete(name);
      };
    },
    on(event, fn) {
      let list = eventListeners.get(event);
      if (!list) {
        list = [];
        eventListeners.set(event, list);
      }
      list.push(fn);
      return () => {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    effect(register) {
      const dispose = register();
      if (typeof dispose === 'function') effects.push(dispose);
    },
    logger: { warn() {} },
  };

  async function invokeHttp({ method = 'GET', path, headers = {}, body = null }) {
    const route = routes.find((r) => path === r.path || path.startsWith(`${r.path}/`));
    assert.ok(route, `expected registered route for ${path}`);
    return new Promise((resolve, reject) => {
      const payload = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
      const req = Readable.from(payload);
      req.method = method;
      req.url = path;
      req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

      const chunks = [];
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headersSent = false;
      res.setHeader = () => {};
      res.write = (chunk) => { chunks.push(String(chunk)); };
      res.end = (chunk = '') => {
        if (chunk) chunks.push(String(chunk));
        res.headersSent = true;
        const text = chunks.join('');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      };

      Promise.resolve(route.handler(req, res)).catch(reject);
    });
  }

  async function disposeAll() {
    for (const fn of effects.splice(0).reverse()) {
      await fn();
    }
  }

  return {
    ctx,
    services,
    routes,
    registeredTools,
    preStepHooks,
    invokeHttp,
    disposeAll,
  };
}

function mutationHeaders() {
  return {
    [REQUEST_HEADER]: '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  };
}

function createMockDelegraBackend({
  delegraResource = 'https://delegra.corp.example/api/v1/employee',
  tokenEndpoint = 'https://delegra.corp.example/oauth/token-exchange',
  issuer = 'https://iam.corp.example',
  subject = 'emp-e2e-1',
  orgId = 'org-alpha',
} = {}) {
  const scope = {
    instanceId: 'delegra-prod-01',
    orgId,
    issuer,
    subject,
    verifiedAt: '2030-01-01T00:00:00.000Z',
    validUntil: '2030-01-01T23:59:59.000Z',
  };
  const exchangedToken = 'delegra-secret-exchanged-token-e2e';
  const exchangeCalls = [];
  const tasksByRequest = new Map();
  const tasksById = new Map();
  let createTaskCalls = 0;
  let nextCreateFailure = null;

  const fetchImpl = async (rawUrl, init = {}) => {
    const url = String(rawUrl);
    if (url === tokenEndpoint) {
      const form = new URLSearchParams(String(init.body ?? ''));
      exchangeCalls.push({
        grantType: form.get('grant_type'),
        audience: form.get('audience'),
        resource: form.get('resource'),
        scope: form.get('scope'),
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: exchangedToken,
            token_type: 'Bearer',
            expires_in: 120,
            issued_token_type: ACCESS_TOKEN_TYPE,
            scope: form.get('scope') ?? 'experts:read',
          };
        },
      };
    }

    // All Delegra employee endpoints must receive the exchanged Bearer token.
    const authHeader = init.headers?.get?.('authorization') ?? init.headers?.authorization ?? '';
    assert.equal(authHeader, `Bearer ${exchangedToken}`, `Delegra call to ${url} must carry RFC 8693 exchanged token`);
    assert.ok(url.startsWith(delegraResource), `URL must stay within pinned resource root: ${url}`);
    const rel = url.slice(delegraResource.length);
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.slice(new URL(delegraResource).pathname.length);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (method === 'GET' && pathname === '/experts' && parsedUrl.searchParams.get('limit') === '1' && !parsedUrl.searchParams.get('view')) {
      return { ok: true, status: 200, async json() { return { scope, items: [], page: { nextCursor: null, hasMore: false } }; } };
    }

    if (method === 'GET' && pathname === '/experts') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scope,
            catalogVersion: 'cv-e2e-1',
            completeness: 'complete',
            coveredScopes: [orgId],
            items: [{
              expertId: 'exp-fin-1',
              displayName: '经营分析专家',
              disambiguation: '财务分析组',
              summary: { disclosureState: 'available', responsibility: '分析季度营收与利润' },
              access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'sha256:cont-e2e-1' },
              availability: { acceptingTasks: 'accepting', reason: null },
            }],
            page: { nextCursor: null, hasMore: false },
          };
        },
      };
    }

    if (method === 'POST' && pathname === '/experts/scope-check') {
      const expertIds = Array.isArray(body?.expertIds) ? body.expertIds : [];
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scope,
            scopeVerified: true,
            validUntil: scope.validUntil,
            results: expertIds.map((expertId) => ({
              expertId,
              callableInScope: expertId === 'exp-fin-1',
              callableReason: expertId === 'exp-fin-1' ? 'granted' : 'not_granted',
              acceptingTasks: 'accepting',
              authContinuityDigest: 'sha256:cont-e2e-1',
            })),
          };
        },
      };
    }

    if (method === 'POST' && pathname === '/expert-tasks') {
      createTaskCalls += 1;
      const taskId = `task-e2e-${createTaskCalls}`;
      const record = {
        scope,
        taskId,
        requestId: body.requestId,
        status: 'accepted',
        acceptedAt: '2030-01-01T00:01:00.000Z',
        runGeneration: 1,
        resultVersion: 0,
        idempotentReplay: false,
      };
      tasksByRequest.set(body.requestId, record);
      tasksById.set(taskId, record);
      const failure = nextCreateFailure;
      nextCreateFailure = null;
      if (failure === 'wire drop') throw new TypeError('simulated wire drop after Delegra commit');
      if (failure === 'internal server error') {
        return {
          ok: false,
          status: 500,
          async json() { return { error: { code: 'EXPERT_INTERNAL_ERROR', message: 'simulated failure after Delegra commit' } }; },
        };
      }
      const receipt = failure === 'unverifiable receipt' ? { ...record, scope: null } : record;
      return { ok: true, status: 201, async json() { return receipt; } };
    }

    if (method === 'GET' && pathname.startsWith('/expert-tasks/by-request/')) {
      const requestId = decodeURIComponent(pathname.slice('/expert-tasks/by-request/'.length));
      const found = tasksByRequest.get(requestId);
      if (!found) return { ok: false, status: 404, async json() { return { error: { code: 'EXPERT_TASK_NOT_FOUND', message: 'not found' } }; } };
      return { ok: true, status: 200, async json() { return found; } };
    }

    if (method === 'GET' && pathname.endsWith('/result') && pathname.startsWith('/expert-tasks/')) {
      const taskId = decodeURIComponent(pathname.slice('/expert-tasks/'.length, -'/result'.length));
      if (!tasksById.has(taskId)) return { ok: false, status: 404, async json() { return { error: { code: 'EXPERT_TASK_NOT_FOUND' } }; } };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scope,
            taskId,
            runId: 'run-e2e-1',
            runGeneration: 1,
            resultVersion: 1,
            status: 'completed',
            summary: 'Q4 营收同比增长 18%',
            rawResult: 'Detailed Q4 ledger breakdown...',
            result: { summary: 'Q4 营收同比增长 18%' },
            sources: [{ id: 'src-1', title: 'Q4 财报', authorized: true }],
            artifacts: [{ id: 'art-1', label: 'q4-brief.pdf', authorized: true }],
          };
        },
      };
    }

    if (method === 'POST' && pathname.endsWith('/cancel') && pathname.startsWith('/expert-tasks/')) {
      const taskId = decodeURIComponent(pathname.slice('/expert-tasks/'.length, -'/cancel'.length));
      if (!tasksById.has(taskId)) return { ok: false, status: 404, async json() { return { error: { code: 'EXPERT_TASK_NOT_FOUND' } }; } };
      return {
        ok: true,
        status: 200,
        async json() {
          return { scope, taskId, cancelRequested: true, status: 'cancelling' };
        },
      };
    }

    if (method === 'GET' && pathname.startsWith('/expert-tasks/')) {
      const taskId = decodeURIComponent(pathname.slice('/expert-tasks/'.length));
      const found = tasksById.get(taskId);
      if (!found) return { ok: false, status: 404, async json() { return { error: { code: 'EXPERT_TASK_NOT_FOUND' } }; } };
      return { ok: true, status: 200, async json() { return { ...found, status: 'completed' }; } };
    }

    throw new Error(`Unhandled mock Delegra route: ${method} ${rel}`);
  };

  return {
    scope,
    exchangedToken,
    exchangeCalls,
    getCreateTaskCalls: () => createTaskCalls,
    setNextCreateFailure: (failure) => { nextCreateFailure = failure; },
    fetchImpl,
  };
}

async function createSignedInIam({ fetchImpl, fixedNow = Date.parse('2030-01-01T00:00:00.000Z') }) {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1,
    sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer: 'https://iam.corp.example',
    subject: 'emp-e2e-1',
    clientId: 'dsh-desktop',
    refreshToken: 'iam-refresh-secret-e2e',
    accessToken: 'iam-subject-secret-e2e',
    accessExpiresAt: '2030-01-01T01:00:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid',
    resource: 'https://gateway.corp.example',
  });

  const iam = createIamService({
    issuer: 'https://iam.corp.example',
    authorizationEndpoint: 'https://iam.corp.example/authorize',
    tokenEndpoint: 'https://iam.corp.example/token',
    jwksUri: 'https://iam.corp.example/jwks',
    clientId: 'dsh-desktop',
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:9/iam/callback',
    tokenExchangeTargets: {
      delegra: {
        endpoint: 'https://delegra.corp.example/oauth/token-exchange',
        audience: 'delegra-prod-01',
        resource: 'https://delegra.corp.example/api/v1/employee',
        maxTtlSeconds: 300,
      },
    },
  }, {
    credentials,
    now: () => fixedNow,
    fetch: fetchImpl,
  });

  const view = await iam.hydrate();
  assert.equal(view.state, 'ready');
  return iam;
}

test('Stage C4-C default-off fail-closed: apply() with default config disables management, tools, and pre-step hooks', async () => {
  const storage = createMemoryStorage();
  const backend = createMockDelegraBackend();
  const iam = await createSignedInIam({ fetchImpl: backend.fetchImpl });
  const host = createSyntheticCordisHost({ storage, iam });

  try {
    await applyExperts(host.ctx); // default config: managementEnabled=false, dispatchEnabled=false
    assert.equal(host.registeredTools.size, 0);
    assert.equal(host.preStepHooks.length, 0);

    const cat = await host.invokeHttp({ path: `${API_PREFIX}/catalog?view=callable` });
    assert.equal(cat.status, 503);
    assert.equal(cat.body.error.code, 'EXPERT_MANAGEMENT_DISABLED');
    assert.equal(backend.exchangeCalls.length, 0);
  } finally {
    await host.disposeAll();
    await iam.dispose();
  }
});

test('Stage C4-C cross-package IAM + Policy + Experts E2E: real forge-policy deny/allow/unload, real RFC 8693 token exchange, pre-step guard, and synthesis envelope', async () => {
  const storage = createMemoryStorage();
  const backend = createMockDelegraBackend();
  const iam = await createSignedInIam({ fetchImpl: backend.fetchImpl });
  const host = createSyntheticCordisHost({ storage, iam });

  try {
    // 1. Mount real @heluo/forge-policy with denyUnknownAction: true -> expert.dispatch must fail closed.
    let disposePolicy = applyPolicy(host.ctx, {
      catalog: [],
      rules: { denyUnknownAction: true },
      audit: { sink: 'memory', buffer: 100 },
    });

    await applyExperts(host.ctx, {
      managementEnabled: true,
      dispatchEnabled: true,
      delegraTarget: 'delegra',
      delegraOrgId: 'org-alpha',
      resolveSessionScope: async (sessionId) => (sessionId === 'sess-e2e-1' ? { delegationScope: 'proj-fin' } : null),
    });

    assert.ok(host.registeredTools.has('forge_experts.delegate'));
    assert.equal(host.preStepHooks.length, 1);

    // Enable expert via HTTP routes (uses real RFC 8693 token exchange via @heluo/forge-iam).
    const cat = await host.invokeHttp({ path: `${API_PREFIX}/catalog?view=callable` });
    assert.equal(cat.status, 200);
    assert.equal(cat.body.items.length, 1);
    const editToken = cat.body.items[0].preference.editToken;

    const enableRes = await host.invokeHttp({
      method: 'PUT',
      path: `${API_PREFIX}/preferences/exp-fin-1`,
      headers: mutationHeaders(),
      body: { enabled: true, editToken },
    });
    assert.equal(enableRes.status, 200);

    const mentionsRes = await host.invokeHttp({ path: `${API_PREFIX}/mentions?sessionId=sess-e2e-1` });
    assert.equal(mentionsRes.status, 200);
    assert.equal(mentionsRes.body.candidates.length, 1);
    const scopeEpoch = mentionsRes.body.scopeEpoch;

    // Prepare selection & attempt dispatch under denyUnknownAction: true -> blocked by real @heluo/forge-policy!
    const sel1 = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-1', scopeEpoch, taskText: 'Analyze Q4 margins', draftVersion: 1 },
    });
    assert.equal(sel1.status, 201);

    const denied = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel1.body.selectionToken, sessionId: 'sess-e2e-1', taskText: 'Analyze Q4 margins', draftVersion: 1 },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'EXPERT_POLICY_DENIED');
    assert.equal(backend.getCreateTaskCalls(), 0, 'real forge-policy deny must block outbound Delegra call');

    // 2. Empty generic @heluo/forge-policy (rules: {}, out-of-scope fallback) MUST ALSO fail closed with 0 Delegra creates.
    disposePolicy();
    disposePolicy = applyPolicy(host.ctx, {
      catalog: [],
      rules: {},
      audit: { sink: 'memory', buffer: 100 },
    });

    const selOutOfScope = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-1', scopeEpoch, taskText: 'Out-of-scope policy check', draftVersion: 1 },
    });
    assert.equal(selOutOfScope.status, 201);
    const deniedOutOfScope = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: selOutOfScope.body.selectionToken, sessionId: 'sess-e2e-1', taskText: 'Out-of-scope policy check', draftVersion: 1 },
    });
    assert.equal(deniedOutOfScope.status, 403);
    assert.equal(deniedOutOfScope.body.error.code, 'EXPERT_POLICY_DENIED');
    assert.equal(backend.getCreateTaskCalls(), 0, 'generic out-of-scope policy fallback must never authorize expert egress');

    // 3. Explicit egress policy authorization -> full prestep + tool bridge + RFC 8693 E2E succeeds.
    // Note: @heluo/forge-policy uses a closed builtin write-action catalog (catalog.mjs:166) where
    // `expert.dispatch` is unregistered and always returns `rule: 'out-of-scope'` (fail-closed above).
    // This PR stays scoped to @heluo/forge-experts without modifying @heluo/forge-policy, so explicit
    // allow + unload fail-closed is exercised via the host `forgePolicy.decideEgress` egress gate.
    disposePolicy();
    disposePolicy = host.ctx.provide('forgePolicy', {
      decideEgress: async () => ({ decision: 'allow', reason: 'explicit-expert-egress-grant' }),
    });

    const sel2 = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-1', scopeEpoch, taskText: 'Analyze Q4 margins', draftVersion: 2 },
    });
    assert.equal(sel2.status, 201);

    const prestep = host.preStepHooks[0];
    const preparedTurn = await prestep.prepareTurn({
      sessionId: 'sess-e2e-1',
      selectionToken: sel2.body.selectionToken,
      taskText: 'Analyze Q4 margins',
      draftVersion: 2,
    });
    assert.equal(preparedTurn.allowed, true);
    assert.equal(preparedTurn.expertBound, true);
    assert.ok(preparedTurn.turnId);

    const allowedCall = prestep.beforeToolCall({
      turnId: preparedTurn.turnId,
      toolName: 'forge_experts.delegate',
      toolInput: { selectionToken: sel2.body.selectionToken, sessionId: 'sess-e2e-1', taskText: 'Analyze Q4 margins', draftVersion: 2 },
    });
    assert.equal(allowedCall.allowed, true);

    const dispatchTool = host.registeredTools.get('forge_experts.delegate');
    const dispatched = await dispatchTool.handler({
      selectionToken: sel2.body.selectionToken,
      sessionId: 'sess-e2e-1',
      taskText: 'Analyze Q4 margins',
      draftVersion: 2,
    });
    assert.equal(dispatched.accepted, true);
    assert.equal(dispatched.completed, false);
    assert.equal(dispatched.taskId, 'task-e2e-1');
    assert.equal(backend.getCreateTaskCalls(), 1);
    assert.ok(backend.exchangeCalls.length >= 3);
    assert.equal(backend.exchangeCalls[0].grantType, TOKEN_EXCHANGE_GRANT_TYPE);
    assert.equal(backend.exchangeCalls[0].scope, 'employee:experts org:org-alpha');

    const finalized = prestep.finalizeTurn({ turnId: preparedTurn.turnId, delegatedTaskId: dispatched.taskId });
    assert.equal(finalized.status, 'delegated');
    assert.equal(finalized.preserveDraft, false);

    // Readback status, result (with #247 synthesis envelope), and cancel via restricted tools.
    const resultTool = host.registeredTools.get('forge_experts.get_result');
    const resultOut = await resultTool.handler({ taskId: 'task-e2e-1' });
    assert.equal(resultOut.taskId, 'task-e2e-1');
    assert.equal(resultOut.status, 'completed');
    assert.equal(resultOut.rawResultCollapsed, true);
    assert.equal(resultOut.attribution.role, 'expert');

    const cancelTool = host.registeredTools.get('forge_experts.cancel');
    const cancelOut = await cancelTool.handler({ taskId: 'task-e2e-1' });
    assert.equal(cancelOut.cancelRequested, true);
    assert.equal(cancelOut.externalActionsNotReverted, true);

    // Zero raw IAM or Delegra tokens leaked into storage or tool responses.
    const serializedAll = JSON.stringify({
      dispatched,
      resultOut,
      cancelOut,
      correlations: [...storage.domains.get('forge_experts_requests').get('correlations').values()],
    });
    assert.ok(!serializedAll.includes('iam-subject-secret-e2e'));
    assert.ok(!serializedAll.includes(backend.exchangedToken));

    // 3. Unloading real @heluo/forge-policy immediately fails closed on next dispatch.
    disposePolicy();
    const sel3 = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-1', scopeEpoch, taskText: 'After policy unload', draftVersion: 3 },
    });
    const afterUnload = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel3.body.selectionToken, sessionId: 'sess-e2e-1', taskText: 'After policy unload', draftVersion: 3 },
    });
    assert.equal(afterUnload.status, 403);
    assert.equal(afterUnload.body.error.code, 'EXPERT_POLICY_DENIED');
    assert.equal(backend.getCreateTaskCalls(), 1, 'unloaded policy must fail closed with zero outbound calls');
  } finally {
    await host.disposeAll();
    await iam.dispose();
  }
});

async function verifyUnknownAcceptanceRecovery(t, failure) {
  const storage = createMemoryStorage();
  const backend = createMockDelegraBackend();
  const iam = await createSignedInIam({ fetchImpl: backend.fetchImpl });
  t.after(() => iam.dispose());
  let requestId;

  // The write commits remotely, but the client cannot verify the acceptance response.
  const host1 = createSyntheticCordisHost({ storage, iam });
  try {
    host1.ctx.provide('forgePolicy', { decideEgress: async () => ({ decision: 'allow' }) });
    await applyExperts(host1.ctx, {
      managementEnabled: true,
      dispatchEnabled: true,
      delegraTarget: 'delegra',
      delegraOrgId: 'org-alpha',
      resolveSessionScope: async () => ({ delegationScope: 'proj-fin' }),
    });

    const cat = await host1.invokeHttp({ path: `${API_PREFIX}/catalog?view=callable` });
    await host1.invokeHttp({
      method: 'PUT',
      path: `${API_PREFIX}/preferences/exp-fin-1`,
      headers: mutationHeaders(),
      body: { enabled: true, editToken: cat.body.items[0].preference.editToken },
    });
    const mentions = await host1.invokeHttp({ path: `${API_PREFIX}/mentions?sessionId=sess-e2e-2` });
    const sel = await host1.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-2', scopeEpoch: mentions.body.scopeEpoch, taskText: 'Request with an unverified acceptance outcome' },
    });

    backend.setNextCreateFailure(failure);
    const unknown = await host1.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel.body.selectionToken, sessionId: 'sess-e2e-2', taskText: 'Request with an unverified acceptance outcome' },
    });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error.code, 'EXPERT_ACCEPTANCE_UNKNOWN');
    requestId = unknown.body.error.details.requestId;
    assert.ok(requestId);
    assert.equal(backend.getCreateTaskCalls(), 1);
  } finally {
    await host1.disposeAll();
  }

  // Phase 2: Restart with dispatchEnabled: false (kill-switch) -> new dispatch blocked, /tasks/reconcile converges with 0 new creates.
  const host2 = createSyntheticCordisHost({ storage, iam });
  try {
    applyPolicy(host2.ctx, { catalog: [], rules: {}, audit: { sink: 'memory', buffer: 100 } });
    await applyExperts(host2.ctx, {
      managementEnabled: true,
      dispatchEnabled: false,
      delegraTarget: 'delegra',
      delegraOrgId: 'org-alpha',
      resolveSessionScope: async () => ({ delegationScope: 'proj-fin' }),
    });

    const blockedSel = await host2.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-2', scopeEpoch: 2, taskText: 'Blocked' },
    });
    assert.equal(blockedSel.status, 404);
    assert.equal(blockedSel.body.error.code, 'EXPERT_DISPATCH_DISABLED');

    const pendingBefore = await host2.invokeHttp({ path: `${API_PREFIX}/tasks/pending` });
    assert.equal(pendingBefore.status, 200);
    assert.equal(pendingBefore.body.items.length, 1);
    assert.equal(pendingBefore.body.items[0].requestId, requestId);
    assert.equal(pendingBefore.body.items[0].status, 'unknown');

    const reconciled = await host2.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks/reconcile`,
      headers: mutationHeaders(),
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.reconciled.length, 1);
    assert.equal(reconciled.body.reconciled[0].taskId, 'task-e2e-1');
    assert.equal(reconciled.body.reconciled[0].requestId, requestId);
    assert.equal(backend.getCreateTaskCalls(), 1, 'reconcile must never create a duplicate task');

    const pendingAfter = await host2.invokeHttp({ path: `${API_PREFIX}/tasks/pending` });
    assert.deepEqual(pendingAfter.body.items, []);
  } finally {
    await host2.disposeAll();
  }
}

for (const failure of ['wire drop', 'internal server error', 'unverifiable receipt']) {
  test(`Stage C4-C ${failure} preserves the request ID for restart reconciliation with dispatch disabled (#247)`, (t) =>
    verifyUnknownAcceptanceRecovery(t, failure));
}

test('Stage C4-C policy.decide unknown verdict string fails closed as EXPERT_POLICY_DENIED (#484)', async () => {
  const storage = createMemoryStorage();
  const backend = createMockDelegraBackend();
  const iam = await createSignedInIam({ fetchImpl: backend.fetchImpl });
  const host = createSyntheticCordisHost({ storage, iam });

  try {
    // Provide a custom policy service returning an unrecognized verdict string ('audit').
    host.ctx.provide('policy', {
      decide: () => ({ action: 'audit', reason: 'unexpected-verdict' }),
    });
    await applyExperts(host.ctx, {
      managementEnabled: true,
      dispatchEnabled: true,
      delegraTarget: 'delegra',
      delegraOrgId: 'org-alpha',
      resolveSessionScope: async () => ({ delegationScope: 'proj-fin' }),
    });

    const cat = await host.invokeHttp({ path: `${API_PREFIX}/catalog?view=callable` });
    await host.invokeHttp({
      method: 'PUT',
      path: `${API_PREFIX}/preferences/exp-fin-1`,
      headers: mutationHeaders(),
      body: { enabled: true, editToken: cat.body.items[0].preference.editToken },
    });
    const mentions = await host.invokeHttp({ path: `${API_PREFIX}/mentions?sessionId=sess-e2e-3` });
    const sel = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-e2e-3', scopeEpoch: mentions.body.scopeEpoch, taskText: 'Unknown verdict test' },
    });
    const res = await host.invokeHttp({
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel.body.selectionToken, sessionId: 'sess-e2e-3', taskText: 'Unknown verdict test' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'EXPERT_POLICY_DENIED');
    assert.equal(backend.getCreateTaskCalls(), 0);
  } finally {
    await host.disposeAll();
    await iam.dispose();
  }
});

test('Stage C4-C contradictory IAM session (state: ready with signedIn: false) fails closed as EXPERT_UNAUTHENTICATED (#484)', async () => {
  const storage = createMemoryStorage();
  const backend = createMockDelegraBackend();
  const contradictoryIam = {
    getSession: () => ({ state: 'ready', status: 'ready', signedIn: false, issuer: 'https://iam.corp.example', subject: 'emp-e2e-1' }),
  };
  const host = createSyntheticCordisHost({ storage, iam: contradictoryIam });

  try {
    await applyExperts(host.ctx, {
      managementEnabled: true,
      dispatchEnabled: true,
      delegraTarget: 'delegra',
      delegraOrgId: 'org-alpha',
    });
    const cat = await host.invokeHttp({ path: `${API_PREFIX}/catalog?view=callable` });
    assert.equal(cat.status, 401);
    assert.equal(cat.body.error.code, 'EXPERT_UNAUTHENTICATED');
  } finally {
    await host.disposeAll();
  }
});
