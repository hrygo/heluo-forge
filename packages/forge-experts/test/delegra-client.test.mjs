import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_VERIFY_PAGES,
  computeFollowupPayloadDigest,
  computeTaskPayloadDigest,
  createDelegraClient,
} from '../src/delegra-client.mjs';
import { apply } from '../src/index.mjs';

const BASE_URL = 'https://delegra.corp.example';
const BASE_SCOPE = Object.freeze({
  instanceId: 'delegra-prod-cn-01',
  orgId: 'org_01',
  issuer: 'https://iam.corp.example',
  subject: 'emp_10086',
  verifiedAt: '2026-11-23T08:00:00Z',
  validUntil: '2026-11-23T08:05:00Z',
});

function jsonResponse(status, body, assertOpen = null) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    async text() {
      assertOpen?.();
      return serialized;
    },
    async json() {
      assertOpen?.();
      return body;
    },
  };
}

function createOpaqueHandleFactory(handler) {
  let activeHandles = 0;
  let totalHandles = 0;
  const requests = [];

  async function exchangeCredential(params) {
    activeHandles += 1;
    totalHandles += 1;
    let consumed = false;
    let disposed = false;

    const assertOpen = () => {
      assert.equal(disposed, false, 'handle must not be disposed before response body is read');
    };

    return Object.freeze({
      resource: BASE_URL,
      async fetch(url, init) {
        assert.equal(consumed, false, 'opaque handle must be single-use');
        assert.equal(disposed, false, 'disposed handle must not be used');
        consumed = true;
        requests.push({ params, url, init });
        const res = await handler(url, init, params);
        return {
          status: res.status,
          async text() {
            assertOpen();
            return res.text();
          },
          async json() {
            assertOpen();
            return res.json();
          },
        };
      },
      async dispose() {
        if (!disposed) {
          disposed = true;
          activeHandles -= 1;
        }
      },
    });
  }

  return {
    exchangeCredential,
    requests,
    get activeHandles() { return activeHandles; },
    get totalHandles() { return totalHandles; },
  };
}

function createMemoryStorageDomain() {
  const tables = new Map();
  return {
    async open(spec) {
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map());
          const store = tables.get(name);
          const schema = spec.tables[name]?.valueSchema;
          return {
            get(key) { return store.get(key); },
            async put(key, value) {
              const parsed = schema ? schema.parse(value) : value;
              store.set(key, parsed);
            },
          };
        },
        async close() {},
      };
    },
  };
}

test('end-to-end catalog, scope resolution, verifyOrgCallable, and scope-check consume single-use opaque handles with zero active handle leak', async () => {
  const factory = createOpaqueHandleFactory((url, init) => {
    const parsedUrl = new URL(url);
    assert.equal(init.redirect, 'manual', 'client must disable automatic redirects');

    if (parsedUrl.pathname === '/api/v1/employee/experts' && init.method === 'GET') {
      const view = parsedUrl.searchParams.get('view');
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        catalogVersion: 'cv_20261123_01',
        completeness: 'complete',
        coveredScopes: ['org_01'],
        items: [
          {
            expertId: 'exp_finance',
            displayName: '经营分析专家',
            disambiguation: '财务分析组',
            summary: {
              disclosureState: 'available',
              responsibility: '月度经营报表分析',
              capabilities: ['指标拆解'],
              toolScope: ['bi-report:read'],
              updatedAt: '2026-11-23T07:00:00Z',
            },
            access: {
              readable: true,
              callableInOrg: true,
              callableReason: 'granted',
              authContinuityDigest: 'sha256:digest_a',
            },
            availability: { acceptingTasks: 'accepting', reason: null },
          },
        ],
        page: { nextCursor: null, hasMore: false },
        echoView: view,
      });
    }

    if (parsedUrl.pathname === '/api/v1/employee/experts/scope-check' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        orgId: 'org_01',
        delegationScope: 'proj_alpha',
        expertIds: ['exp_finance'],
      });
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        scopeVerified: true,
        results: [
          {
            expertId: 'exp_finance',
            callableInScope: true,
            callableReason: 'granted',
            acceptingTasks: 'accepting',
            authContinuityDigest: 'sha256:digest_a',
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${init.method} ${url}`);
  });

  const client = createDelegraClient({
    exchangeCredential: factory.exchangeCredential,
    target: 'delegra',
    orgId: 'org_01',
  });

  const scope = await client.resolveDelegraScope({ issuer: BASE_SCOPE.issuer, subject: BASE_SCOPE.subject });
  assert.equal(scope.instanceId, 'delegra-prod-cn-01');
  assert.equal(scope.orgId, 'org_01');

  const catalog = await client.fetchDelegraCatalog({ scope, view: 'directory', limit: 20 });
  assert.equal(catalog.completeness, 'complete');
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].expertId, 'exp_finance');

  const auth = await client.verifyOrgCallable(scope, 'exp_finance');
  assert.deepEqual(auth, { callableInOrg: true, authContinuityDigest: 'sha256:digest_a' });

  const scopeCheck = await client.checkDelegraSessionScope({
    scope,
    delegationScope: 'proj_alpha',
    expertIds: ['exp_finance'],
  });
  assert.equal(scopeCheck.scopeVerified, true);
  assert.equal(scopeCheck.validUntil, BASE_SCOPE.validUntil);
  assert.equal(scopeCheck.results.length, 1);

  assert.equal(factory.activeHandles, 0, 'every opaque handle must be disposed');
  assert.equal(factory.totalHandles, 4);
});

test('atomic task creation, idempotent replay, digest conflict, transport-unknown reconciliation, followup, and cancel obey CORP-DSH-EXPERT-001 §7', async () => {
  const tasksByReq = new Map();
  let simulateTransportDrop = false;
  let capturedFollowupDigest = null;

  const factory = createOpaqueHandleFactory((url, init) => {
    const parsedUrl = new URL(url);

    if (parsedUrl.pathname === '/api/v1/employee/expert-tasks' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (simulateTransportDrop) {
        throw new Error('ECONNRESET');
      }
      const existing = tasksByReq.get(body.requestId);
      if (existing) {
        if (existing.payloadDigest !== body.payloadDigest) {
          return jsonResponse(409, {
            error: { code: 'EXPERT_IDEMPOTENCY_CONFLICT', message: 'Digest mismatch', retryable: false },
          });
        }
        return jsonResponse(200, { ...existing.receipt, idempotentReplay: true });
      }
      const receipt = {
        scope: BASE_SCOPE,
        taskId: `task_${tasksByReq.size + 1}`,
        requestId: body.requestId,
        status: 'accepted',
        acceptedAt: '2026-11-23T08:01:00Z',
        runGeneration: 1,
        resultVersion: 0,
        idempotentReplay: false,
      };
      tasksByReq.set(body.requestId, { payloadDigest: body.payloadDigest, receipt });
      return jsonResponse(201, receipt);
    }

    if (parsedUrl.pathname.startsWith('/api/v1/employee/expert-tasks/by-request/') && init.method === 'GET') {
      const reqId = decodeURIComponent(parsedUrl.pathname.split('/').pop());
      const found = tasksByReq.get(reqId);
      if (!found) {
        return jsonResponse(404, { error: { code: 'EXPERT_TASK_NOT_FOUND', message: 'Not found', retryable: false } });
      }
      return jsonResponse(200, found.receipt);
    }

    if (parsedUrl.pathname === '/api/v1/employee/expert-tasks/task_1' && init.method === 'GET') {
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        taskId: 'task_1',
        status: 'completed',
        runId: 'run_99',
        runGeneration: 1,
        resultVersion: 2,
      });
    }

    if (parsedUrl.pathname === '/api/v1/employee/expert-tasks/task_1/result' && init.method === 'GET') {
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        taskId: 'task_1',
        runId: 'run_99',
        runGeneration: 1,
        resultVersion: 2,
        status: 'completed',
        result: { summary: 'Q4 营收同比增长 18%' },
        sources: ['bi-report:2026-q4'],
        artifacts: [],
      });
    }

    if (parsedUrl.pathname === '/api/v1/employee/expert-tasks/task_1/followups' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      capturedFollowupDigest = body.payloadDigest;
      return jsonResponse(201, {
        scope: BASE_SCOPE,
        taskId: 'task_1',
        requestId: body.requestId,
        status: 'queued',
        runGeneration: 2,
      });
    }

    if (parsedUrl.pathname === '/api/v1/employee/expert-tasks/task_1/cancel' && init.method === 'POST') {
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        taskId: 'task_1',
        cancelRequested: true,
        status: 'running',
      });
    }

    throw new Error(`Unexpected request: ${init.method} ${url}`);
  });

  const client = createDelegraClient({ exchangeCredential: factory.exchangeCredential });
  const digest = computeTaskPayloadDigest({
    expertId: 'exp_finance',
    delegationScope: 'proj_alpha',
    taskText: '分析 Q4 营收',
  });

  const created = await client.createTask({
    scope: BASE_SCOPE,
    expertId: 'exp_finance',
    delegationScope: 'proj_alpha',
    requestId: 'req-uuid-001',
    originSessionRef: 'sess_1',
    taskText: '分析 Q4 营收',
    payloadDigest: digest,
  });
  assert.equal(created.taskId, 'task_1');
  assert.equal(created.idempotentReplay, false);

  const replayed = await client.createTask({
    scope: BASE_SCOPE,
    expertId: 'exp_finance',
    delegationScope: 'proj_alpha',
    requestId: 'req-uuid-001',
    originSessionRef: 'sess_1',
    taskText: '分析 Q4 营收',
    payloadDigest: digest,
  });
  assert.equal(replayed.taskId, 'task_1');
  assert.equal(replayed.idempotentReplay, true);

  await assert.rejects(
    () => client.createTask({
      scope: BASE_SCOPE,
      expertId: 'exp_finance',
      delegationScope: 'proj_alpha',
      requestId: 'req-uuid-001',
      taskText: '修改后的文本',
    }),
    (err) => err.code === 'EXPERT_IDEMPOTENCY_CONFLICT' && err.status === 409,
  );

  simulateTransportDrop = true;
  await assert.rejects(
    () => client.createTask({
      scope: BASE_SCOPE,
      expertId: 'exp_finance',
      delegationScope: 'proj_alpha',
      requestId: 'req-uuid-001',
      taskText: '分析 Q4 营收',
    }),
    (err) => err.code === 'EXPERT_ACCEPTANCE_UNKNOWN' && err.status === 503 && err.retryable === true,
  );
  simulateTransportDrop = false;

  const reconciled = await client.getTaskByRequest({ scope: BASE_SCOPE, requestId: 'req-uuid-001' });
  assert.equal(reconciled.taskId, 'task_1');

  const taskState = await client.getTask({ scope: BASE_SCOPE, taskId: 'task_1' });
  assert.equal(taskState.status, 'completed');

  const taskResult = await client.getTaskResult({ scope: BASE_SCOPE, taskId: 'task_1' });
  assert.equal(taskResult.resultVersion, 2);

  const expectedFollowupDigest = computeFollowupPayloadDigest({
    taskId: 'task_1',
    taskText: '补充华东区明细',
  });
  assert.notEqual(
    expectedFollowupDigest,
    computeTaskPayloadDigest({ expertId: 'task_1', delegationScope: BASE_SCOPE.orgId, taskText: '补充华东区明细' }),
  );
  const followup = await client.createFollowup({
    scope: BASE_SCOPE,
    taskId: 'task_1',
    requestId: 'req-followup-001',
    taskText: '补充华东区明细',
  });
  assert.equal(followup.runGeneration, 2);
  assert.equal(capturedFollowupDigest, expectedFollowupDigest);

  const cancelled = await client.cancelTask({ scope: BASE_SCOPE, taskId: 'task_1' });
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(factory.activeHandles, 0);
});

test('Delegra receipt classification preserves uncertainty only for task submissions (#484)', async (t) => {
  const requestId = 'req-receipt-001';
  const task = { scope: BASE_SCOPE, requestId, taskText: 'Synthetic task' };
  const receipt = {
    taskId: 'task_1', requestId, status: 'accepted', acceptedAt: '2026-11-23T08:01:00Z',
  };
  const unknown = { code: 'EXPERT_ACCEPTANCE_UNKNOWN', status: 503, retryable: true };
  const mismatch = { code: 'EXPERT_SCOPE_MISMATCH', status: 409, retryable: false };
  const cases = [
    ['typed internal error', jsonResponse(500, {
      error: { code: 'EXPERT_INTERNAL_ERROR', requestTraceId: 'trace-receipt' },
    }), { ...unknown, details: { requestTraceId: 'trace-receipt' } }, {
      code: 'EXPERT_INTERNAL_ERROR', status: 500, retryable: true, details: { requestTraceId: 'trace-receipt' },
    }],
    ['unclassified gateway error', jsonResponse(502, { error: { code: 'BAD_GATEWAY' } }), unknown,
      { code: 'EXPERT_INTERNAL_ERROR', status: 500, retryable: false }],
    ['missing receipt scope', jsonResponse(201, receipt), unknown, mismatch],
    ['mismatched receipt scope', jsonResponse(200, { ...receipt, scope: { ...BASE_SCOPE, subject: 'emp_OTHER' } }),
      unknown, mismatch],
    ...[
      [403, 'EXPERT_CALL_FORBIDDEN', false],
      [422, 'EXPERT_REQUEST_INVALID', false],
      [503, 'EXPERT_ISOLATION_UNVERIFIED', true],
    ].map(([status, code, retryable]) => {
      const error = { status, code, retryable };
      return [code, jsonResponse(status, { error: { code } }), error, error];
    }),
  ];
  const operations = [
    ['create', 'POST', '', (client) => client.createTask({ ...task, expertId: 'exp_finance', delegationScope: 'proj_alpha' })],
    ['followup', 'POST', '/task_1/followups', (client) => client.createFollowup({ ...task, taskId: 'task_1' })],
    ['readback', 'GET', `/by-request/${requestId}`, (client) => client.getTaskByRequest({ scope: BASE_SCOPE, requestId })],
  ];

  for (const [name, response, writeError, readError] of cases) {
    for (const [operation, method, path, run] of operations) {
      await t.test(`${operation} with ${name}`, async () => {
        const factory = createOpaqueHandleFactory(() => response);
        const client = createDelegraClient({ exchangeCredential: factory.exchangeCredential });
        await assert.rejects(() => run(client), method === 'POST' ? writeError : readError);
        assert.equal(factory.requests.length, 1);
        const [{ url, init }] = factory.requests;
        assert.equal(new URL(url).pathname, `/api/v1/employee/expert-tasks${path}`);
        assert.equal(init.method, method);
        if (method === 'POST') assert.equal(JSON.parse(init.body).requestId, requestId);
        assert.equal(factory.activeHandles, 0);
      });
    }
  }
});

test('fail-closed boundaries: scope envelope mismatch, 3xx redirect, stale cursor, rate-limit retryable, pagination cap, oversized scope-check, and IAM auth errors', async () => {
  let mode = 'mismatch';
  let pageSeq = 0;
  const factory = createOpaqueHandleFactory((url) => {
    if (mode === 'mismatch') {
      return jsonResponse(200, {
        scope: { ...BASE_SCOPE, subject: 'emp_OTHER' },
        items: [],
      });
    }
    if (mode === 'redirect') {
      return jsonResponse(302, undefined);
    }
    if (mode === 'stale-cursor') {
      return jsonResponse(409, {
        error: { code: 'EXPERT_CURSOR_STALE', message: 'Cursor expired', retryable: false },
      });
    }
    if (mode === 'rate-limited') {
      return jsonResponse(429, {
        error: { code: 'EXPERT_RATE_LIMITED', message: 'Slow down', retryable: false },
      });
    }
    if (mode === 'infinite-pages') {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('query'), 'exp_missing', 'targeted pagination must preserve query across pages');
      pageSeq += 1;
      return jsonResponse(200, {
        scope: BASE_SCOPE,
        catalogVersion: 'cv_1',
        completeness: 'truncated',
        coveredScopes: ['org_01'],
        items: [],
        page: { nextCursor: `cur_${pageSeq}`, hasMore: true },
      });
    }
    return jsonResponse(500, { error: { code: 'UNKNOWN_UPSTREAM_CODE', message: 'boom' } });
  });

  const client = createDelegraClient({ exchangeCredential: factory.exchangeCredential });

  await assert.rejects(
    () => client.fetchDelegraCatalog({ scope: BASE_SCOPE, view: 'directory' }),
    (err) => err.code === 'EXPERT_SCOPE_MISMATCH' && err.status === 409,
  );

  mode = 'redirect';
  await assert.rejects(
    () => client.fetchDelegraCatalog({ scope: BASE_SCOPE, view: 'directory' }),
    (err) => err.code === 'EXPERT_DIRECTORY_UNAVAILABLE' && err.status === 503,
  );

  mode = 'stale-cursor';
  await assert.rejects(
    () => client.fetchDelegraCatalog({ scope: BASE_SCOPE, view: 'directory', cursor: 'old_cur' }),
    (err) => err.code === 'EXPERT_CURSOR_STALE' && err.status === 409 && err.retryable === true,
  );

  mode = 'rate-limited';
  await assert.rejects(
    () => client.fetchDelegraCatalog({ scope: BASE_SCOPE, view: 'directory' }),
    (err) => err.code === 'EXPERT_RATE_LIMITED' && err.status === 429 && err.retryable === true,
  );

  mode = 'infinite-pages';
  await assert.rejects(
    () => client.verifyOrgCallable(BASE_SCOPE, 'exp_missing'),
    (err) => err.code === 'EXPERT_DIRECTORY_UNAVAILABLE' && err.status === 503 && err.retryable === true,
  );
  assert.equal(pageSeq, MAX_VERIFY_PAGES);

  await assert.rejects(
    () => client.checkDelegraSessionScope({
      scope: BASE_SCOPE,
      delegationScope: 'proj_alpha',
      expertIds: Array.from({ length: 101 }, (_, i) => `exp_${i}`),
    }),
    (err) => err.code === 'EXPERT_REQUEST_TOO_LARGE' && err.status === 413,
  );

  assert.equal(factory.activeHandles, 0);

  for (const [iamCode, expectedCode] of [
    ['IAM_NOT_SIGNED_IN', 'EXPERT_UNAUTHENTICATED'],
    ['IAM_TOKEN_REVOKED', 'EXPERT_AUTH_REVOKED'],
    ['IAM_ORG_FORBIDDEN', 'EXPERT_ORG_FORBIDDEN'],
    ['IAM_EXCHANGE_FAILED', 'EXPERT_DIRECTORY_UNAVAILABLE'],
  ]) {
    const failingClient = createDelegraClient({
      async exchangeCredential() {
        const err = new Error(iamCode);
        err.code = iamCode;
        throw err;
      },
    });
    await assert.rejects(
      () => failingClient.fetchDelegraCatalog({ scope: BASE_SCOPE, view: 'directory' }),
      (err) => err.code === expectedCode,
    );
  }
});

test('apply() wires iam.exchangeAudienceCredential through createDelegraClient into /api/forge-experts/catalog', async () => {
  const factory = createOpaqueHandleFactory((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/v1/employee/experts');
    return jsonResponse(200, {
      scope: BASE_SCOPE,
      catalogVersion: 'cv_1',
      completeness: 'complete',
      coveredScopes: ['org_01'],
      items: [
        {
          expertId: 'exp_wired',
          displayName: '接线验证专家',
          summary: { disclosureState: 'available', responsibility: '端到端验证', capabilities: [], toolScope: [] },
          access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'sha256:w1' },
          availability: { acceptingTasks: 'accepting', reason: null },
        },
      ],
      page: { nextCursor: null, hasMore: false },
    });
  });

  let registeredRoute = null;
  let providedHost = null;
  const cleanups = [];
  const ctx = {
    get(serviceName) {
      if (serviceName === 'iam') {
        return {
          getSession: () => ({ state: 'ready', issuer: BASE_SCOPE.issuer, subject: BASE_SCOPE.subject }),
          exchangeAudienceCredential: factory.exchangeCredential,
        };
      }
      if (serviceName === 'connection') {
        return { requestRejection: ({ headers }) => (headers?.['x-dsh-auth'] === 'ok' ? undefined : 401) };
      }
      if (serviceName === 'storageDomain') {
        return createMemoryStorageDomain();
      }
      if (serviceName === 'webServer') {
        return {
          register(route) {
            registeredRoute = route;
            return () => { registeredRoute = null; };
          },
        };
      }
      return undefined;
    },
    provide(name, value) {
      if (name === 'forgeExperts') providedHost = value;
    },
    effect(fn) {
      cleanups.push(fn());
    },
  };

  await apply(ctx, {
    managementEnabled: true,
    delegraTarget: 'delegra',
    delegraOrgId: 'org_01',
  });

  assert.ok(registeredRoute, 'webServer route should be registered');
  assert.ok(providedHost?.delegraClient, 'delegraClient should be wired into host');

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      write(chunk) { chunks.push(String(chunk)); },
      end(chunk = '') {
        this.headersSent = true;
        if (chunk) chunks.push(String(chunk));
        resolve({ statusCode: res.statusCode, body: JSON.parse(chunks.join('')) });
      },
    };
    Promise.resolve(registeredRoute.handler({
      method: 'GET',
      url: '/api/forge-experts/catalog?view=directory',
      headers: { 'x-dsh-auth': 'ok' },
      on() {},
    }, res)).catch(reject);
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].expertId, 'exp_wired');
  assert.equal(factory.activeHandles, 0);

  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') await cleanup();
  }
});
