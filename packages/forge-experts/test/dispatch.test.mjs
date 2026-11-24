import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createExpertsHost } from '../src/index.mjs';
import { API_PREFIX, REQUEST_HEADER } from '../src/routes.mjs';
import { ExpertsError } from '../src/errors.mjs';

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

function invokeRoute(host, { method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
    const req = Readable.from(payload);
    req.method = method;
    req.url = path;
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    const resHeaders = {};
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (k, v) => { resHeaders[k.toLowerCase()] = v; };
    res.write = (chunk) => { chunks.push(String(chunk)); };
    res.end = (chunk = '') => {
      if (chunk) chunks.push(String(chunk));
      res.headersSent = true;
      const text = chunks.join('');
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      resolve({ status: res.statusCode, headers: resHeaders, body: parsed });
    };

    host.handleRequest(req, res).catch(reject);
  });
}

function mutationHeaders() {
  return {
    [REQUEST_HEADER]: '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  };
}

function makeHarness({ dispatchEnabled = true, storage = createMemoryStorage(), evaluatePolicy } = {}) {
  const scope = {
    instanceId: 'delegra-prod-01',
    orgId: 'org-alpha',
    issuer: 'https://iam.corp.example',
    subject: 'emp-1001',
    verifiedAt: '2026-11-24T00:00:00Z',
    validUntil: '2026-11-24T23:59:59Z',
  };
  let acceptingTasks = 'accepting';
  let callableInScope = true;
  let createCalls = 0;
  let createBehavior = 'accept';
  let nextRequestSeq = 0;
  const tasksByRequest = new Map();
  const tasksById = new Map();

  const host = createExpertsHost({
    config: { managementEnabled: true, dispatchEnabled },
    getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject, orgId: scope.orgId }),
    getConnection: () => ({ requestRejection: () => undefined }),
    openStorageDomain: (spec) => storage.open(spec),
    resolveDelegraScope: async () => scope,
    fetchDelegraCatalog: async () => ({
      scope,
      catalogVersion: 'cv-1',
      completeness: 'complete',
      coveredScopes: [scope.orgId],
      items: [{
        expertId: 'exp-fin-1',
        displayName: '经营分析专家',
        disambiguation: '财务分析组',
        summary: { disclosureState: 'available', responsibility: '分析经营报表' },
        access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'sha256:cont-1' },
        availability: { acceptingTasks, reason: null },
      }],
      page: { nextCursor: null, hasMore: false },
    }),
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'sha256:cont-1' }),
    resolveSessionScope: async (sessionId) => (sessionId === 'sess-1' ? { delegationScope: 'proj-fin' } : null),
    checkDelegraSessionScope: async ({ expertIds }) => ({
      scope,
      scopeVerified: true,
      validUntil: scope.validUntil,
      results: expertIds.map((expertId) => ({
        expertId,
        callableInScope,
        callableReason: callableInScope ? 'granted' : 'revoked',
        acceptingTasks,
        authContinuityDigest: 'sha256:cont-1',
      })),
    }),
    evaluatePolicy,
    generateRequestId: () => `req-000${++nextRequestSeq}`,
    createDelegraTask: async (params) => {
      createCalls += 1;
      if (createBehavior === 'unknown') {
        // Simulate server committed the task, but response was lost on the wire.
        const committed = {
          scope,
          taskId: 'task-lost-1',
          requestId: params.requestId,
          status: 'accepted',
          acceptedAt: '2026-11-24T00:01:00Z',
          runGeneration: 1,
          resultVersion: 0,
          idempotentReplay: false,
        };
        tasksByRequest.set(params.requestId, committed);
        tasksById.set(committed.taskId, committed);
        throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', 'Wire dropped after commit', { status: 503, retryable: true });
      }
      const receipt = {
        scope,
        taskId: `task-${createCalls}`,
        requestId: params.requestId,
        status: 'accepted',
        acceptedAt: '2026-11-24T00:01:00Z',
        runGeneration: 1,
        resultVersion: 0,
        idempotentReplay: false,
      };
      tasksByRequest.set(params.requestId, receipt);
      tasksById.set(receipt.taskId, receipt);
      return receipt;
    },
    getDelegraTaskByRequest: async ({ requestId }) => {
      const found = tasksByRequest.get(requestId);
      if (!found) throw new ExpertsError('EXPERT_TASK_NOT_FOUND', 'Not found');
      return found;
    },
    getDelegraTask: async ({ taskId }) => {
      const found = tasksById.get(taskId);
      if (!found) throw new ExpertsError('EXPERT_TASK_NOT_FOUND', 'Not found');
      return found;
    },
    getDelegraTaskResult: async ({ taskId }) => {
      const found = tasksById.get(taskId);
      if (!found) throw new ExpertsError('EXPERT_TASK_NOT_FOUND', 'Not found');
      return {
        scope,
        taskId,
        runId: 'run-1',
        runGeneration: 1,
        resultVersion: 1,
        status: 'completed',
        result: { summary: 'Q4 revenue grew 18%' },
        sources: ['bi-report:q4'],
        artifacts: [],
      };
    },
    createDelegraFollowup: async ({ taskId, requestId }) => ({
      scope,
      taskId,
      requestId,
      status: 'queued',
      runGeneration: 2,
    }),
    cancelDelegraTask: async ({ taskId }) => ({
      scope,
      taskId,
      cancelRequested: true,
      status: 'running',
    }),
  });

  return {
    host,
    storage,
    setAccepting: (value) => { acceptingTasks = value; },
    setCallableInScope: (value) => { callableInScope = value; },
    setCreateBehavior: (value) => { createBehavior = value; },
    getCreateCalls: () => createCalls,
    async enableExpert() {
      const cat = await invokeRoute(host, { path: `${API_PREFIX}/catalog?view=callable` });
      const editToken = cat.body.items[0].preference.editToken;
      const put = await invokeRoute(host, {
        method: 'PUT',
        path: `${API_PREFIX}/preferences/exp-fin-1`,
        headers: mutationHeaders(),
        body: { enabled: true, editToken },
      });
      assert.equal(put.status, 200);
      return put.body.editToken;
    },
  };
}

test('end-to-end dispatch route flow: prepare, dispatch, readback, result, followup, cancel, and minimal #247 correlation persistence', async () => {
  const h = makeHarness({ dispatchEnabled: true });
  await h.host.open();
  try {
    await h.enableExpert();

    // CSRF header is enforced on POST /selections and POST /tasks.
    const noHeader = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Analyze Q4' },
    });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, 'EXPERT_REQUEST_HEADER_REQUIRED');

    const prepared = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Analyze Q4 margins', draftVersion: 1 },
    });
    assert.equal(prepared.status, 201);
    assert.ok(prepared.body.selectionToken);

    const dispatched = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: {
        selectionToken: prepared.body.selectionToken,
        sessionId: 'sess-1',
        taskText: 'Analyze Q4 margins',
        draftVersion: 1,
      },
    });
    assert.equal(dispatched.status, 201);
    assert.equal(dispatched.body.taskId, 'task-1');
    assert.equal(dispatched.body.requestId, 'req-0001');

    // Verify #247 persisted correlation stores zero raw taskText and zero tokens.
    const corrTable = h.storage.domains.get('forge_experts_requests').get('correlations');
    const savedRecords = [...corrTable.values()];
    assert.equal(savedRecords.length, 1);
    assert.equal(savedRecords[0].requestId, 'req-0001');
    assert.equal(savedRecords[0].taskId, 'task-1');
    assert.equal(savedRecords[0].status, 'accepted');
    assert.equal('taskText' in savedRecords[0], false);

    // Authoritative status, result, followup, and cancel routes succeed.
    const taskRes = await invokeRoute(h.host, { path: `${API_PREFIX}/tasks/task-1` });
    assert.equal(taskRes.status, 200);
    assert.equal(taskRes.body.taskId, 'task-1');

    const resultRes = await invokeRoute(h.host, { path: `${API_PREFIX}/tasks/task-1/result` });
    assert.equal(resultRes.status, 200);
    assert.equal(resultRes.body.resultVersion, 1);

    const followupRes = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks/task-1/followups`,
      headers: mutationHeaders(),
      body: { taskText: 'Break down by region' },
    });
    assert.equal(followupRes.status, 201);
    assert.equal(followupRes.body.runGeneration, 2);

    const cancelRes = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks/task-1/cancel`,
      headers: mutationHeaders(),
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.cancelRequested, true);
  } finally {
    await h.host.close();
  }
});

test('Forge Policy deny/confirm, paused expert, and concurrent disable block outbound delivery with zero Delegra tasks', async () => {
  let policyDecision = { decision: 'deny', reason: 'C4 restricted content' };
  const h = makeHarness({
    dispatchEnabled: true,
    evaluatePolicy: async () => policyDecision,
  });
  await h.host.open();
  try {
    const nextEditToken = await h.enableExpert();

    // 1. Policy deny -> 403 EXPERT_POLICY_DENIED, zero outbound calls.
    const sel1 = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Restricted payload' },
    });
    const denied = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel1.body.selectionToken, sessionId: 'sess-1', taskText: 'Restricted payload' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'EXPERT_POLICY_DENIED');
    assert.equal(h.getCreateCalls(), 0);

    // 2. Policy confirm -> 409 EXPERT_POLICY_CONFIRMATION_REQUIRED, zero outbound calls.
    policyDecision = { decision: 'confirm', confirmationScope: 'expert.dispatch', reason: 'Confirm external send' };
    const sel2 = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Needs confirmation' },
    });
    const confirmReq = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel2.body.selectionToken, sessionId: 'sess-1', taskText: 'Needs confirmation' },
    });
    assert.equal(confirmReq.status, 409);
    assert.equal(confirmReq.body.error.code, 'EXPERT_POLICY_CONFIRMATION_REQUIRED');
    assert.equal(confirmReq.body.error.details.confirmationScope, 'expert.dispatch');
    assert.equal(h.getCreateCalls(), 0);

    // 3. Paused expert -> 409 EXPERT_NOT_ACCEPTING, zero outbound calls.
    policyDecision = { decision: 'allow' };
    h.setAccepting('paused');
    const sel3 = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Paused expert task' },
    });
    const pausedRes = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel3.body.selectionToken, sessionId: 'sess-1', taskText: 'Paused expert task' },
    });
    assert.equal(pausedRes.status, 409);
    assert.equal(pausedRes.body.error.code, 'EXPERT_NOT_ACCEPTING');
    assert.equal(h.getCreateCalls(), 0);

    // 4. Disable expert -> invalidates pending selection & blocks dispatch with zero outbound calls.
    h.setAccepting('accepting');
    const sel4 = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Before disable' },
    });
    const disableRes = await invokeRoute(h.host, {
      method: 'PUT',
      path: `${API_PREFIX}/preferences/exp-fin-1`,
      headers: mutationHeaders(),
      body: { enabled: false, editToken: nextEditToken },
    });
    assert.equal(disableRes.status, 200);
    const afterDisable = await invokeRoute(h.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel4.body.selectionToken, sessionId: 'sess-1', taskText: 'Before disable' },
    });
    assert.equal(afterDisable.status, 409);
    assert.equal(afterDisable.body.error.code, 'EXPERT_SELECTION_INVALID');
    assert.equal(h.getCreateCalls(), 0);
  } finally {
    await h.host.close();
  }
});

test('unknown acceptance persists requestId and reconciles via by-request even after dispatchEnabled is turned off (§9.2)', async () => {
  const sharedStorage = createMemoryStorage();
  const h1 = makeHarness({ dispatchEnabled: true, storage: sharedStorage });
  await h1.host.open();
  let lostRequestId;
  try {
    await h1.enableExpert();
    h1.setCreateBehavior('unknown');
    const sel = await invokeRoute(h1.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Lost receipt task' },
    });
    const unknown = await invokeRoute(h1.host, {
      method: 'POST',
      path: `${API_PREFIX}/tasks`,
      headers: mutationHeaders(),
      body: { selectionToken: sel.body.selectionToken, sessionId: 'sess-1', taskText: 'Lost receipt task' },
    });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error.code, 'EXPERT_ACCEPTANCE_UNKNOWN');
    lostRequestId = unknown.body.error.details.requestId;
    assert.equal(lostRequestId, 'req-0001');
  } finally {
    await h1.host.close();
  }

  // Reopen with dispatchEnabled: false (rollback / kill-switch per §9.2):
  // new dispatches are closed (404), but authoritative by-request reconciliation still works.
  const h2 = makeHarness({ dispatchEnabled: false, storage: sharedStorage });
  await h2.host.open();
  try {
    const blocked = await invokeRoute(h2.host, {
      method: 'POST',
      path: `${API_PREFIX}/selections`,
      headers: mutationHeaders(),
      body: { expertId: 'exp-fin-1', sessionId: 'sess-1', scopeEpoch: 2, taskText: 'Should be blocked' },
    });
    assert.equal(blocked.status, 404);
    assert.equal(blocked.body.error.code, 'EXPERT_DISPATCH_DISABLED');

    const corrTable = sharedStorage.domains.get('forge_experts_requests').get('correlations');
    const persisted = [...corrTable.values()].find((r) => r.requestId === lostRequestId);
    assert.equal(persisted.status, 'unknown');
  } finally {
    await h2.host.close();
  }
});
