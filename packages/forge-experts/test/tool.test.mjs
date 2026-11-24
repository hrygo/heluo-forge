import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WAITING_USER_NOTICE,
  EXPERT_TOOL_NAMES,
  createExpertToolBridge,
  projectExpertResultEnvelope,
} from '../src/tool.mjs';
import { apply } from '../src/index.mjs';
import { ExpertsError } from '../src/errors.mjs';

function makeBridge({ dispatchEnabled = true, overrides = {} } = {}) {
  const calls = {
    dispatchTask: [],
    getTask: [],
    getTaskResult: [],
    reconcileByRequest: [],
    followupTask: [],
    cancelTask: [],
  };

  const bridge = createExpertToolBridge({
    isDispatchEnabled: () => dispatchEnabled,
    dispatchTask: async (body) => {
      calls.dispatchTask.push(body);
      return {
        taskId: 'task-101',
        requestId: 'req-101',
        status: 'queued',
        originSessionRef: body.sessionId,
      };
    },
    getTask: async (params) => {
      calls.getTask.push(params);
      return { taskId: params.taskId, status: 'running', runId: 'run-1', runGeneration: 1 };
    },
    getTaskResult: async (params) => {
      calls.getTaskResult.push(params);
      return {
        taskId: params.taskId,
        runId: 'run-1',
        runGeneration: 2,
        resultVersion: 3,
        status: 'succeeded',
        summary: 'Expert analysis complete',
        rawResult: 'Full raw expert transcript...',
        sources: [
          { title: 'Authorized Doc', uri: 'https://docs.example.test/a', authorized: true },
          { title: 'Restricted Doc', uri: 'https://docs.example.test/secret', authorized: false },
          { title: 'Untagged Doc', uri: 'https://docs.example.test/untagged' },
          { title: 'Truthy String Flag', uri: 'https://docs.example.test/truthy', authorized: 'true' },
          'https://docs.example.test/bare-string',
        ],
        artifacts: [
          { name: 'report.md', authorized: true },
          { name: 'internal-dump.json', authorized: false },
          { name: 'untagged-artifact.txt' },
          'bare-artifact.txt',
        ],
      };
    },
    reconcileByRequest: async (params) => {
      calls.reconcileByRequest.push(params);
      return { taskId: 'task-101', status: 'queued', correlation: { originSessionRef: 'sess-1', expertId: 'exp-1' } };
    },
    followupTask: async (params) => {
      calls.followupTask.push(params);
      return { taskId: params.taskId, status: 'queued', runGeneration: 2 };
    },
    cancelTask: async (params) => {
      calls.cancelTask.push(params);
      return { taskId: params.taskId, status: 'cancelling' };
    },
    ...overrides,
  });

  return { bridge, calls };
}

test('hallucinated LLM delegate call without selectionToken fails closed with EXPERT_SELECTION_INVALID and zero outbound calls', async () => {
  const { bridge, calls } = makeBridge({ dispatchEnabled: true });

  await assert.rejects(
    () => bridge.delegate({ sessionId: 'sess-1', taskText: 'Analyze Q4 pipeline' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_SELECTION_INVALID',
  );
  await assert.rejects(
    () => bridge.delegate({ selectionToken: '   ', sessionId: 'sess-1', taskText: 'Analyze Q4 pipeline' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_SELECTION_INVALID',
  );
  assert.equal(calls.dispatchTask.length, 0);
});

test('delegate returns explicit acceptance receipt with completed: false', async () => {
  const { bridge, calls } = makeBridge({ dispatchEnabled: true });
  const receipt = await bridge.delegate({
    selectionToken: 'sel-valid-1',
    sessionId: 'sess-1',
    taskText: 'Review architecture draft',
  });

  assert.equal(calls.dispatchTask.length, 1);
  assert.equal(receipt.taskId, 'task-101');
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.completed, false);
});

test('dispatchEnabled: false fails closed on delegate/followup while keeping status/result/reconcile/cancel open (§9.2)', async () => {
  const { bridge, calls } = makeBridge({ dispatchEnabled: false });

  await assert.rejects(
    () => bridge.delegate({ selectionToken: 'sel-1', sessionId: 'sess-1', taskText: 'hi' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_DISPATCH_DISABLED',
  );
  await assert.rejects(
    () => bridge.followup({ taskId: 'task-101', taskText: 'more info' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_DISPATCH_DISABLED',
  );
  assert.equal(calls.dispatchTask.length, 0);
  assert.equal(calls.followupTask.length, 0);

  const status = await bridge.getStatus({ taskId: 'task-101' });
  const result = await bridge.getResult({ taskId: 'task-101' });
  const reconciled = await bridge.reconcile({ requestId: 'req-101' });
  const cancelled = await bridge.cancel({ taskId: 'task-101' });

  assert.equal(status.status, 'running');
  assert.equal(result.taskId, 'task-101');
  assert.equal(reconciled.taskId, 'task-101');
  assert.equal(cancelled.externalActionsNotReverted, true);

  const defs = bridge.getToolDefinitions();
  assert.deepEqual(defs.map((d) => d.name), [
    EXPERT_TOOL_NAMES.STATUS,
    EXPERT_TOOL_NAMES.RESULT,
    EXPERT_TOOL_NAMES.RECONCILE,
    EXPERT_TOOL_NAMES.CANCEL,
  ]);
  for (const def of defs) {
    assert.equal(def.inputSchema?.type, 'object');
    assert.ok(Array.isArray(def.inputSchema?.required) && def.inputSchema.required.length > 0);
  }
});

test('getResult projects #247 synthesis envelope with fail-closed authorized filtering and waiting_user read-only notice', async () => {
  const { bridge } = makeBridge({ dispatchEnabled: true });
  const envelope = await bridge.getResult({ taskId: 'task-101' });

  assert.equal(envelope.rawResultCollapsed, true);
  assert.equal(envelope.synthesizedByMainAssistant, false);
  assert.equal(envelope.waitingUserNotice, null);
  assert.deepEqual(envelope.attribution, {
    role: 'expert',
    taskId: 'task-101',
    runId: 'run-1',
    runGeneration: 2,
    resultVersion: 3,
    status: 'succeeded',
  });
  // Fail-closed: only entries with explicit `authorized === true` survive;
  // untagged objects, non-boolean truthy flags, and bare strings are dropped.
  assert.equal(envelope.sources.length, 1);
  assert.equal(envelope.sources[0].title, 'Authorized Doc');
  assert.equal(envelope.artifacts.length, 1);
  assert.equal(envelope.artifacts[0].name, 'report.md');

  const waiting = projectExpertResultEnvelope({
    taskId: 'task-202',
    runId: 'run-9',
    runGeneration: 1,
    resultVersion: 1,
    status: 'waiting_user',
    summary: 'Need confirmation on target region',
    waitingUserPrompt: 'Please confirm whether to target ap-northeast-1.',
  });
  assert.equal(waiting.rawResultCollapsed, true);
  assert.deepEqual(waiting.waitingUserNotice, {
    readOnly: true,
    message: 'Please confirm whether to target ap-northeast-1.',
  });

  const waitingDefault = projectExpertResultEnvelope({
    taskId: 'task-203',
    status: 'waiting_user',
  });
  assert.deepEqual(waitingDefault.waitingUserNotice, {
    readOnly: true,
    message: DEFAULT_WAITING_USER_NOTICE,
  });
});

test('null/undefined downstream responses map to EXPERT_TASK_NOT_FOUND (404) while malformed non-object payloads remain EXPERT_INTERNAL_ERROR (500)', async () => {
  const { bridge: nullBridge } = makeBridge({
    dispatchEnabled: true,
    overrides: {
      getTask: async () => null,
      getTaskResult: async () => null,
      reconcileByRequest: async () => undefined,
      cancelTask: async () => null,
    },
  });

  await assert.rejects(
    () => nullBridge.getStatus({ taskId: 'task-missing' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_TASK_NOT_FOUND' && err.status === 404,
  );
  await assert.rejects(
    () => nullBridge.getResult({ taskId: 'task-missing' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_TASK_NOT_FOUND' && err.status === 404,
  );
  await assert.rejects(
    () => nullBridge.reconcile({ requestId: 'req-missing' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_TASK_NOT_FOUND' && err.status === 404,
  );
  await assert.rejects(
    () => nullBridge.cancel({ taskId: 'task-missing' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_TASK_NOT_FOUND' && err.status === 404,
  );

  const { bridge: corruptBridge } = makeBridge({
    dispatchEnabled: true,
    overrides: {
      getTaskResult: async () => 'not-an-object',
    },
  });
  await assert.rejects(
    () => corruptBridge.getResult({ taskId: 'task-corrupt' }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_INTERNAL_ERROR' && err.status === 500,
  );
});

test('cancel explicitly reports externalActionsNotReverted: true', async () => {
  const { bridge } = makeBridge({ dispatchEnabled: true });
  const cancelled = await bridge.cancel({ taskId: 'task-101' });
  assert.equal(cancelled.taskId, 'task-101');
  assert.equal(cancelled.status, 'cancelling');
  assert.equal(cancelled.externalActionsNotReverted, true);
});

test('apply() registers restricted expert tools when dispatchEnabled is true and unregisters on ctx.effect teardown', async () => {
  const registered = new Map();
  let effectCleanup = null;
  let routeDisposed = false;

  const ctx = {
    get(serviceName) {
      if (serviceName === 'webServer') {
        return {
          register() {
            return () => {
              routeDisposed = true;
            };
          },
        };
      }
      if (serviceName === 'tools') {
        return {
          register(def) {
            registered.set(def.name, def);
            return () => {
              registered.delete(def.name);
            };
          },
        };
      }
      if (serviceName === 'storageDomain') {
        return {
          async open() {
            const store = new Map();
            return {
              table: () => ({
                get: (k) => store.get(k),
                put: (k, v) => { store.set(k, v); },
              }),
              close: async () => {},
            };
          },
        };
      }
      return undefined;
    },
    provide() {},
    effect(fn) {
      effectCleanup = fn();
    },
    logger: { warn() {} },
  };

  await apply(ctx, { managementEnabled: true, dispatchEnabled: true });
  assert.equal(registered.size, 6);
  assert.ok(registered.has(EXPERT_TOOL_NAMES.DELEGATE));
  assert.ok(registered.has(EXPERT_TOOL_NAMES.RESULT));
  assert.ok(registered.has(EXPERT_TOOL_NAMES.CANCEL));

  await effectCleanup();
  assert.equal(registered.size, 0);
  assert.equal(routeDisposed, true);
});

test('apply() logs warn when tool registry is unavailable and rolls back partial registrations on throw', async () => {
  const warnings = [];
  const ctxMissingRegistry = {
    get(serviceName) {
      if (serviceName === 'webServer') return { register: () => () => {} };
      return undefined;
    },
    provide() {},
    effect() {},
    logger: { warn(msg) { warnings.push(msg); } },
  };
  await apply(ctxMissingRegistry, { managementEnabled: true, dispatchEnabled: true });
  assert.ok(warnings.some((m) => m.includes('tool registry unavailable')));

  const registered = new Set();
  let routeDisposed = false;
  let count = 0;
  const ctxThrowingRegistry = {
    get(serviceName) {
      if (serviceName === 'webServer') {
        return {
          register() {
            return () => { routeDisposed = true; };
          },
        };
      }
      if (serviceName === 'tools') {
        return {
          register(def) {
            count += 1;
            if (count === 3) throw new Error('registry full');
            registered.add(def.name);
            return () => { registered.delete(def.name); };
          },
        };
      }
      return undefined;
    },
    provide() {},
    effect() {},
    logger: { warn() {} },
  };

  await assert.rejects(
    () => apply(ctxThrowingRegistry, { managementEnabled: true, dispatchEnabled: true }),
    /registry full/u,
  );
  assert.equal(registered.size, 0);
  assert.equal(routeDisposed, true);
});

test('apply() does not register tools when dispatchEnabled is false', async () => {
  const registered = [];
  const ctx = {
    get(serviceName) {
      if (serviceName === 'webServer') return { register: () => () => {} };
      if (serviceName === 'tools') {
        return {
          register(def) {
            registered.push(def.name);
            return () => {};
          },
        };
      }
      return undefined;
    },
    provide() {},
    effect() {},
    logger: { warn() {} },
  };

  await apply(ctx, { managementEnabled: true, dispatchEnabled: false });
  assert.deepEqual(registered, []);
});
