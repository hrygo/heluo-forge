import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createIamViewObserver } from '../src/isolated-testing.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import {
  READY_VIEW, SIGNED_OUT_VIEW, collectFrames, createFakeIam, createManagementTransport,
  createManualClock, flush, waitFor,
} from './support/iam-view-runtime.mjs';

const frameError = (code) => (error) => error?.code === code;

function open(observer, context, signal) {
  const iterable = observer.observe(context, signal);
  return iterable[Symbol.asyncIterator]();
}

async function realIam(t) {
  const mock = await startMockOidc({ subject: 'OBSERVER1' });
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const marker = Object.freeze({});
  const service = createIamService({
    ...mock.endpoints, clientId: mock.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', httpTimeoutMs: 2000,
  }, {
    getCredentials: () => credentials,
    getCredentialsBindingScope: () => marker,
    verifyAtomicStore: (candidate) => candidate === credentials,
  });
  t.after(() => service.dispose());
  return { service, mock };
}

test('a forged, revoked, or asynchronous management answer reads no service state', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  assert.throws(() => observer.observe(Object.freeze({}), new AbortController().signal), frameError('IAM_VIEW_UNVERIFIED'));
  const live = transport.issue({ observer });
  assert.throws(() => observer.observe({ ...live.context }), frameError('IAM_VIEW_UNVERIFIED'));
  const foreign = createManagementTransport();
  assert.throws(() => observer.observe(foreign.issue({ observer }).context), frameError('IAM_VIEW_UNVERIFIED'));
  live.revoke();
  assert.throws(() => observer.observe(live.context), frameError('IAM_VIEW_UNVERIFIED'));
  const sealed = transport.issue({ observer });
  sealed.revoke();
  assert.equal(Object.isFrozen(sealed.binding), true);
  assert.equal(Object.hasOwn(sealed.binding, 'active'), false);
  assert.throws(() => { sealed.binding.active = true; });
  assert.throws(() => { sealed.binding.invocation = { peer: { principal: sealed.binding.principal } }; });
  assert.throws(() => observer.observe(sealed.context), frameError('IAM_VIEW_UNVERIFIED'));
  assert.equal(transport.verify(sealed.context, observer), false, 'a revoked original must stay dead');
  const reissued = transport.issue({ observer });
  assert.notEqual(reissued.context, live.context);
  assert.throws(() => observer.observe(live.context), frameError('IAM_VIEW_UNVERIFIED'));
  const revoked = transport.issue({ observer });
  revoked.revoke();
  assert.throws(() => observer.observe(revoked.context), frameError('IAM_VIEW_UNVERIFIED'));
  const asynchronous = createIamViewObserver(iam, {
    verifyManagementContext: async () => true, clock,
  });
  t.after(() => asynchronous.dispose());
  assert.throws(() => asynchronous.observe(transport.issue({ observer: asynchronous }).context), frameError('IAM_VIEW_UNVERIFIED'));
  assert.deepEqual(iam.calls, { sync: 0, load: 0, getView: 0, watch: 0 });
});

test('the actual factory serves a signed-out first frame and never projects secrets', async (t) => {
  const { service, mock } = await realIam(t);
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(service, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const grant = transport.issue({ observer });
  const frames = await collectFrames(observer.observe(grant.context), 1);
  assert.equal(frames.length, 1);
  const view = frames[0];
  assert.equal(view.state, 'signed-out');
  assert.equal(view.signedIn, false);
  assert.equal(view.canSignIn, true);
  assert.deepEqual(Object.keys(view).sort(), [
    'accessExpiresAt', 'canSignIn', 'canSignOut', 'configured', 'error', 'exclusive',
    'gatewayConsoleUrl', 'gatewayCredential', 'identity', 'missing', 'principal', 'signedIn', 'state',
  ]);
  assert.equal(view.identity, null, 'a signed-out frame carries no identity');
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.missing));
  assert.deepEqual(Object.keys(view.gatewayCredential), ['state']);
  assert.equal(mock.counts.token, 0);
});

test('hostile view shapes are rejected instead of being coerced', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());

  const secretView = { ...READY_VIEW, token: 'synthetic-token', authorizationUrl: 'https://example.invalid/x',
    attemptId: 'attempt-1', refreshToken: 'synthetic-refresh',
    gatewayCredential: { state: 'configured', value: 'synthetic-key', lastProbeAt: '2026-11-03T00:00:00Z',
      get ref() { throw new Error('an unknown field must never be read'); } } };
  iam.view = secretView;
  const grant = transport.issue({ observer });
  const [frame] = await collectFrames(observer.observe(grant.context), 1);
  const serialized = JSON.stringify(frame);
  for (const secret of ['synthetic-token', 'synthetic-refresh', 'synthetic-ref', 'synthetic-key',
    'attempt-1', 'authorizationUrl', 'lastProbeAt']) {
    assert.equal(serialized.includes(secret), false, `snapshot leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(frame.gatewayCredential), ['state']);
  assert.ok(Object.isFrozen(frame.gatewayCredential));

  for (const invalid of [
    { ...READY_VIEW, get principal() { return 'x'; } },
    { ...READY_VIEW, missing: 'not-an-array' },
    { ...READY_VIEW, state: 42 },
    { ...READY_VIEW, gatewayCredential: ['state'] },
    { ...READY_VIEW, gatewayCredential: { state: 'configured', get deviceLabel() { return 'x'; } } },
    (() => { const view = { ...READY_VIEW }; delete view.exclusive; return view; })(),
    (() => { const list = ['x', 3]; Object.defineProperty(list, 'some', { value: () => false }); return { ...READY_VIEW, missing: list }; })(),
  ]) {
    const scopedIam = createFakeIam();
    scopedIam.view = invalid;
    const scopedClock = createManualClock();
    const scoped = createIamViewObserver(scopedIam, { verifyManagementContext: transport.verify, clock: scopedClock });
    const failing = transport.issue({ observer: scoped });
    await assert.rejects(open(scoped, failing.context).next(), frameError('IAM_VIEW_INVALID'));
    await scoped.dispose();
    assert.equal(scopedClock.size, 0);
  }
  observer.dispose();
  assert.equal(clock.size, 0);

  let traps = 0;
  const proxied = new Proxy({ ...READY_VIEW }, {
    getPrototypeOf(target) { traps += 1; return Reflect.getPrototypeOf(target); },
    getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key) { traps += 1; return Reflect.get(target, key); },
  });
  const proxyIam = createFakeIam();
  proxyIam.view = proxied;
  const proxyClock = createManualClock();
  const proxyObserver = createIamViewObserver(proxyIam, { verifyManagementContext: transport.verify, clock: proxyClock });
  await assert.rejects(open(proxyObserver, transport.issue({ observer: proxyObserver }).context).next(), frameError('IAM_VIEW_INVALID'));
  assert.equal(traps, 0);
  await proxyObserver.dispose();
  assert.equal(proxyClock.size, 0);
});

test('the identity projection whitelist admits only the three confirmed fields', async (t) => {
  const transport = createManagementTransport();

  async function projectOne(view) {
    const iam = createFakeIam();
    iam.view = view;
    const clock = createManualClock();
    const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
    t.after(() => observer.dispose());
    const grant = transport.issue({ observer });
    const [frame] = await collectFrames(observer.observe(grant.context), 1);
    return frame;
  }

  const frame = await projectOne({ ...READY_VIEW,
    identity: { user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan' } });
  assert.deepEqual(frame.identity, { user_id: '10001234', user_name: 'Zhang San', work_no: 'zhangsan' });
  assert.ok(Object.isFrozen(frame.identity));
  assert.deepEqual(Object.keys(frame.identity), ['user_id', 'user_name', 'work_no']);

  const partial = await projectOne({ ...READY_VIEW, identity: { user_id: '10001234' } });
  assert.deepEqual(partial.identity, { user_id: '10001234' });

  for (const invalid of [
    { ...READY_VIEW, identity: { user_id: '10001234', nickname: 'unexpected' } },
    { ...READY_VIEW, identity: { user_id: 42 } },
    { ...READY_VIEW, identity: { user_name: '' } },
    { ...READY_VIEW, identity: { get work_no() { return 'zhangsan'; } } },
    { ...READY_VIEW, identity: 'text' },
    { ...READY_VIEW, identity: ['user_id'] },
    { ...READY_VIEW, identity: { user_id: 'x', ...Object.fromEntries([['toString', ' hostile']]) } },
  ]) {
    const iam = createFakeIam();
    iam.view = invalid;
    const clock = createManualClock();
    const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
    t.after(() => observer.dispose());
    await assert.rejects(open(observer, transport.issue({ observer }).context).next(), frameError('IAM_VIEW_INVALID'),
      `identity shape must be rejected: ${JSON.stringify(Object.keys(invalid.identity === 'text' ? {} : invalid.identity))}`);
    await observer.dispose();
  }
});

test('two subscribers share one flight and the last leaving stops timer and watch', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const first = open(observer, transport.issue({ observer }).context);
  const second = open(observer, transport.issue({ observer }).context);
  const a = await first.next();
  const b = await second.next();
  assert.equal(a.value.state, 'signed-out');
  assert.equal(b.value.state, 'signed-out');
  assert.equal(iam.calls.sync, 1, 'the second subscriber joins the single flight');
  assert.equal(iam.calls.watch, 1);
  assert.equal(clock.size, 1);
  assert.equal(iam.maxActive, 1);

  await second.return();
  assert.equal(clock.size, 1, 'one subscriber keeps the group alive');
  iam.view = READY_VIEW;
  await clock.tick();
  const latest = await first.next();
  assert.equal(latest.value.state, 'ready');
  assert.equal(latest.value.principal, 'synthetic-subject');
  assert.equal(iam.calls.sync, 2);
  assert.equal(iam.maxActive, 1);

  await first.return();
  await flush();
  assert.equal(clock.size, 0);
  await waitFor(() => iam.watchOpen === 0);
});

test('revocation during an in-flight sync stops later reads and frames', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const hold = iam.holdNext();
  const grant = transport.issue({ observer });
  const iterator = open(observer, grant.context);
  const pending = iterator.next();
  await hold.entered;
  grant.revoke();
  hold.release();
  await assert.rejects(pending, frameError('IAM_VIEW_CHANGED'));
  await flush();
  assert.equal(iam.calls.sync, 1);
  assert.equal(iam.calls.load, 0);
  assert.equal(iam.calls.getView, 0);
  assert.equal(clock.size, 0);
  await waitFor(() => iam.watchOpen === 0);

  const replacement = transport.issue({ observer });
  const [frame] = await collectFrames(observer.observe(replacement.context), 1);
  assert.equal(frame.state, 'signed-out');
  assert.equal(iam.calls.getView, 1);
});

test('revocation during the load wait or inside getView never delivers a frame', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());

  const hold = iam.holdNext('load');
  const grant = transport.issue({ observer });
  const pending = open(observer, grant.context).next();
  await hold.entered;
  grant.revoke();
  hold.release();
  await assert.rejects(pending, frameError('IAM_VIEW_CHANGED'));
  await flush();
  assert.equal(iam.calls.getView, 0);
  assert.equal(clock.size, 0);

  const inside = transport.issue({ observer });
  const read = iam.getView;
  iam.getView = () => {
    const value = read();
    inside.revoke();
    return value;
  };
  await assert.rejects(open(observer, inside.context).next(), frameError('IAM_VIEW_CHANGED'));
  iam.getView = read;
  await flush();
  assert.equal(iam.maxActive, 1);
});

test('a restarted group never overlaps the previous group in-flight read', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const hold = iam.holdNext('sync');
  const first = open(observer, transport.issue({ observer }).context);
  void first.next();
  await hold.entered;
  await first.return();
  const second = open(observer, transport.issue({ observer }).context);
  const frame = second.next();
  await flush(12);
  assert.equal(iam.maxActive, 1, 'the new group must wait for the old flight');
  assert.equal(iam.calls.sync, 1);
  hold.release();
  const value = await frame;
  assert.equal(value.value.state, 'signed-out');
  assert.equal(iam.maxActive, 1);
  assert.equal(iam.calls.sync, 2);
  await second.return();
});

test('buffered frames are dropped when a subscription fails or is cancelled', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());

  const grant = transport.issue({ observer });
  const iterator = open(observer, grant.context);
  await iterator.next();
  iam.view = READY_VIEW;
  await clock.tick();
  const reads = iam.calls.sync;
  grant.revoke();
  await clock.tick();
  assert.equal(iam.calls.sync, reads, 'a revoked subscription must not start another read');
  await assert.rejects(iterator.next(), frameError('IAM_VIEW_CHANGED'));

  const controller = new AbortController();
  const cancelled = open(observer, transport.issue({ observer }).context, controller.signal);
  await cancelled.next();
  iam.view = SIGNED_OUT_VIEW;
  await clock.tick();
  controller.abort();
  assert.deepEqual(await cancelled.next(), { done: true, value: undefined });

  const fast = transport.issue({ observer });
  const fastIterator = open(observer, fast.context);
  await fastIterator.next();
  iam.view = READY_VIEW;
  await clock.tick();
  fast.revoke();
  await assert.rejects(fastIterator.next(), frameError('IAM_VIEW_CHANGED'));
});

test('a failed subscription reports its error once and then ends', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const grant = transport.issue({ observer });
  const iterator = open(observer, grant.context);
  await iterator.next();
  const rejected = assert.rejects(iterator.next(), frameError('IAM_VIEW_CHANGED'));
  grant.revoke();
  await clock.tick();
  await rejected;
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('rebinding or cancelling across an await never publishes the stale result', async (t) => {
  const iam = createFakeIam();
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());

  const hold = iam.holdNext();
  const bound = open(observer, transport.issue({ observer }).context);
  const reboundRead = bound.next();
  await hold.entered;
  const replaced = async function reboundSync() { iam.calls.sync += 1; };
  iam.syncFromStore = replaced;
  hold.release();
  await assert.rejects(reboundRead, frameError('IAM_VIEW_CHANGED'));
  assert.equal(iam.calls.getView, 0);
  iam.syncFromStore = createFakeIam().syncFromStore;

  const controller = new AbortController();
  const cancelled = open(observer, transport.issue({ observer }).context, controller.signal);
  const held = iam.holdNext();
  const pending = cancelled.next();
  await held.entered;
  controller.abort();
  held.release();
  const ended = await pending;
  assert.equal(ended.done, true);
  await flush();
  assert.equal(clock.size, 0);
  await waitFor(() => iam.watchOpen === 0);
});

test('a queued watch value never becomes a published snapshot', async (t) => {
  const iam = createFakeIam({ view: SIGNED_OUT_VIEW, watchFrame: { ...READY_VIEW, principal: 'stale-from-watch' } });
  const transport = createManagementTransport();
  const clock = createManualClock();
  const observer = createIamViewObserver(iam, { verifyManagementContext: transport.verify, clock });
  t.after(() => observer.dispose());
  const iterator = open(observer, transport.issue({ observer }).context);
  const first = await iterator.next();
  assert.equal(first.value.state, 'signed-out');
  iam.wake();
  await flush();
  iam.view = READY_VIEW;
  await clock.tick();
  const next = await iterator.next();
  assert.equal(next.value.state, 'ready');
  assert.equal(next.value.principal, 'synthetic-subject');
  assert.notEqual(next.value.principal, 'stale-from-watch');
  await iterator.return();
});

test('the observer refuses an incomplete service instead of inventing a seam', () => {
  assert.throws(() => createIamViewObserver({ getView() {} }, { verifyManagementContext: () => true }),
    frameError('IAM_VIEW_INVALID'));
  assert.throws(() => createIamViewObserver(createFakeIam(), {}), frameError('IAM_VIEW_INVALID'));
});