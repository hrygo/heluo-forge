import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createIamViewConsumer, createIamViewObserver } from '../src/isolated-testing.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { authorization } from './support/client-auth-service.mjs';
import {
  createManagementTransport, createManualClock, createManualHandle, flush, waitFor,
} from './support/iam-view-runtime.mjs';

// A handle whose dispose() does not end iteration: only the consumer's own
// generation guard can keep a late frame out of accept().
function lateHandle() {
  const queue = [];
  let waiter = null;
  let closed = false;
  return {
    disposeCalls: 0,
    push(value) { if (waiter) { const resolve = waiter; waiter = null; resolve({ value, done: false }); } else queue.push(value); },
    dispose() { this.disposeCalls += 1; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => { waiter = resolve; });
        },
        return(value) { closed = true; return Promise.resolve({ done: true, value }); },
      };
    },
  };
}

test('a frame from the previous stream generation is never accepted', async (t) => {
  const stale = lateHandle();
  const fresh = lateHandle();
  const accepted = [];
  let opened = 0;
  const consumer = createIamViewConsumer({
    open: () => (opened += 1) === 1 ? stale : fresh,
    accept: (view) => accepted.push(view),
  });
  t.after(() => consumer.dispose());
  consumer.start();
  stale.push({ state: 'old' });
  await waitFor(() => accepted.length === 1);
  consumer.restart();
  assert.equal(stale.disposeCalls, 1);
  stale.push({ state: 'old-late' });
  fresh.push({ state: 'new' });
  await waitFor(() => accepted.length === 2);
  await flush();
  assert.deepEqual(accepted.map((view) => view.state), ['old', 'new']);
});

test('start is idempotent and an asynchronous open is rejected as an invalid handle', async (t) => {
  const accepted = [];
  const openCalls = [];
  const errors = [];
  const handle = createManualHandle();
  const consumer = createIamViewConsumer({
    open: () => { openCalls.push(1); return Promise.resolve(handle); },
    accept: (view) => accepted.push(view),
    onError: (failure) => errors.push(failure),
  });
  t.after(() => consumer.dispose());
  consumer.start();
  consumer.start();
  await waitFor(() => errors.length === 1);
  assert.equal(errors[0].code, 'IAM_VIEW_INVALID');
  assert.equal(openCalls.length, 1);
  assert.deepEqual(accepted, []);

  const broken = createIamViewConsumer({ open() { throw new Error('synthetic dial failure'); }, accept() {}, onError: (failure) => errors.push(failure) });
  t.after(() => broken.dispose());
  broken.start();
  await waitFor(() => errors.length === 2);
  assert.equal(errors[1].code, 'IAM_VIEW_UNKNOWN');
  assert.equal(JSON.stringify(errors).includes('synthetic dial failure'), false);
});

test('a thenable returned by open is rejected and its late handle is disposed', async (t) => {
  const handle = createManualHandle();
  const errors = [];
  const consumer = createIamViewConsumer({ open: () => Promise.resolve(handle), accept() {}, onError: (failure) => errors.push(failure) });
  t.after(() => consumer.dispose());
  consumer.start();
  await waitFor(() => errors.length === 1);
  await flush(6);
  assert.equal(errors[0].code, 'IAM_VIEW_INVALID');
  assert.equal(handle.stats.disposed, 1);

  const rejected = [];
  const broken = createIamViewConsumer({ open: () => Promise.reject(new Error('late open failure')), accept() {}, onError: (failure) => rejected.push(failure) });
  t.after(() => broken.dispose());
  broken.start();
  await waitFor(() => rejected.length === 1);
  assert.equal(rejected[0].code, 'IAM_VIEW_INVALID');

  const trapped = [];
  const hostile = createIamViewConsumer({
    open: () => ({ get then() { throw new Error('a hostile getter must not escape'); } }),
    accept() {},
    onError: (failure) => trapped.push(failure),
  });
  t.after(() => hostile.dispose());
  hostile.start();
  await waitFor(() => trapped.length === 1);
  assert.equal(trapped[0].code, 'IAM_VIEW_INVALID');
  assert.equal(JSON.stringify(trapped).includes('hostile getter'), false);
});

test('restart cancels the old handle and ignores its late failure', async (t) => {
  const first = createManualHandle({ name: 'first' });
  const second = createManualHandle({ name: 'second' });
  const accepted = [];
  const errors = [];
  let handed = 0;
  const consumer = createIamViewConsumer({
    open: () => (handed += 1) === 1 ? first : second,
    accept: (view) => accepted.push(view),
    onError: (failure) => errors.push(failure),
  });
  t.after(() => consumer.dispose());
  consumer.start();
  first.push({ state: 'first' });
  await waitFor(() => accepted.length === 1);
  consumer.restart();
  assert.equal(first.stats.disposed, 1);
  first.fail(new Error('late carrier failure'));
  second.push({ state: 'second' });
  await waitFor(() => accepted.length === 2);
  await flush();
  assert.deepEqual(errors, []);
  assert.deepEqual(accepted.map((view) => view.state), ['first', 'second']);
});

test('dispose ends the owned loop, cancels the handle, and accepts nothing more', async (t) => {
  const handle = createManualHandle();
  const accepted = [];
  const consumer = createIamViewConsumer({ open: () => handle, accept: (view) => accepted.push(view) });
  consumer.start();
  handle.push({ state: 'only' });
  await waitFor(() => accepted.length === 1);
  await consumer.dispose();
  assert.equal(handle.stats.disposed, 1);
  handle.push({ state: 'late' });
  await flush();
  assert.equal(accepted.length, 1);
  await consumer.dispose();
});

function createMount() {
  const stats = { mounted: 0, unmounted: 0, opened: 0 };
  let host = null;
  return {
    stats,
    openHandles: () => host?.handles.size ?? 0,
    async $mount({ package: name, descriptors } = {}) {
      if (host) throw new Error('already mounted');
      if (typeof name !== 'string' || !Array.isArray(descriptors) || descriptors.length === 0) throw new Error('invalid contribution');
      await new Promise((resolve) => setTimeout(resolve, 1));
      host = { name, descriptors, closed: false, handles: new Set() };
      stats.mounted += 1;
      return async () => {
        if (host === null || host.closed) return;
        host.closed = true;
        for (const handle of host.handles) handle.dispose();
        host = null; stats.unmounted += 1;
      };
    },
    $stream(factory) {
      if (!host || host.closed) throw new Error('no mounted contribution');
      const iterator = factory()[Symbol.asyncIterator]();
      const handle = {
        dispose() { if (!handle.disposed) { handle.disposed = true; host?.handles.delete(handle); iterator.return?.(); } },
        disposed: false,
        [Symbol.asyncIterator]() { return iterator; },
      };
      host.handles.add(handle); stats.opened += 1;
      return handle;
    },
  };
}

test('an asynchronous mount plus the actual factory and mock IdP delivers the ready view', async (t) => {
  const mock = await startMockOidc({ subject: 'JOINT1' });
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const marker = Object.freeze({});
  const service = createIamService({
    ...mock.endpoints, clientId: mock.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', httpTimeoutMs: 2000,
  }, {
    getCredentials: () => credentials,
    getCredentialsBindingScope: () => marker,
    getOrigin: () => 'http://127.0.0.1:4567',
    verifyAtomicStore: (candidate) => candidate === credentials,
  });
  t.after(() => service.dispose());
  const clock = createManualClock();
  const transport = createManagementTransport();
  const observer = createIamViewObserver(service, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const mount = createMount();
  const unmount = await mount.$mount({ package: '@heluo/forge-iam', descriptors: [{ namespace: 'iam', method: 'sync', mode: 'stream' }] });
  t.after(() => unmount());
  const grant = transport.issue({ observer });
  const accepted = [];
  const consumer = createIamViewConsumer({
    open: (signal) => mount.$stream(() => observer.observe(grant.context, signal)),
    accept: (view) => accepted.push(view),
  });
  t.after(() => consumer.dispose());
  consumer.start();
  await waitFor(() => accepted.length === 1);
  assert.equal(accepted[0].state, 'signed-out');
  const callback = await authorization(service);
  const result = await service.handleCallback(callback);
  assert.equal(result.state, 'ready');
  await clock.tick();
  await waitFor(() => accepted.at(-1)?.state === 'ready');
  assert.equal(accepted.at(-1).principal, 'JOINT1');
  assert.equal(accepted.at(-1).signedIn, true);
  assert.equal(mount.stats.mounted, 1);
  assert.equal(mount.stats.opened, 1);
  await unmount();
  assert.equal(mount.stats.unmounted, 1);
  await waitFor(() => clock.size === 0);
  assert.equal(mount.openHandles(), 0);
  await waitFor(() => service.getView().state === 'ready');
});
test('notifyView pushes a frame for a catalogue-only change', async t => {
  const credentials = new MemoryCredentials();
  let catalog = { managed: true, state: 'loading', models: [] };
  const service = createIamService({
    issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
    authorizationEndpoint: 'https://iam.corp.example/authorize',
    tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  }, { credentials, getManagedModelRuntime: () => ({ getView: () => catalog }) });
  t.after(() => service.dispose());
  const controller = new AbortController();
  const frames = [];
  const pump = (async () => { for await (const view of service.watch(controller.signal)) frames.push(view); })();
  await waitFor(() => frames.length === 1);
  // Only the managed catalogue moved here: no IAM transition precedes this call.
  catalog = { managed: true, state: 'ready', models: [{ id: 'corp-chat' }] };
  service.notifyView();
  await waitFor(() => frames.length === 2);
  // A freshly evaluated snapshot reaches subscribers instead of the stale one.
  assert.notStrictEqual(frames[1], frames[0]);
  assert.equal(frames[1].modelAccess.models.length, 0);
  controller.abort();
  await pump.catch(() => { });
});
