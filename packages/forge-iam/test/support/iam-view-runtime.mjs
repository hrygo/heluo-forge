// Test-only scaffolding for the private IAM view observer. Nothing here is a
// runtime API: no module imports this except the isolated subscription tests.

export const SIGNED_OUT_VIEW = Object.freeze({
  state: 'signed-out', configured: true, signedIn: false, canSignOut: false, canSignIn: true,
  missing: Object.freeze([]), error: null, exclusive: 'ok', principal: null,
  accessExpiresAt: null, gatewayCredential: Object.freeze({ state: 'unconfigured' }), gatewayConsoleUrl: null,
});

export const READY_VIEW = Object.freeze({
  ...SIGNED_OUT_VIEW, state: 'ready', signedIn: true, canSignOut: true, canSignIn: false,
  principal: 'synthetic-subject', gatewayCredential: Object.freeze({ state: 'configured', deviceLabel: 'fixture machine' }),
});

// A stale snapshot a watch notification must never be published as-is.
export const STALE_VIEW = Object.freeze({ ...READY_VIEW, principal: 'stale-from-watch' });

export async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition was not reached in time');
    await flush(1);
  }
}

export function createManualClock() {
  let next = 1;
  const timers = new Map();
  const stats = { scheduled: 0, cleared: 0, ticks: 0 };
  const clock = {
    stats,
    setInterval(callback, milliseconds) {
      if (milliseconds !== 2000) throw new Error(`unexpected interval ${String(milliseconds)}`);
      const id = next; next += 1; timers.set(id, callback); stats.scheduled += 1; return id;
    },
    clearInterval(id) { if (timers.delete(id)) stats.cleared += 1; },
    get size() { return timers.size; },
    async tick() {
      stats.ticks += 1;
      for (const callback of [...timers.values()]) callback();
      await flush();
    },
  };
  return clock;
}

/**
 * Private management transport: it issues opaque context objects and answers
 * only for the original object, its observer, and while the grant is active.
 * Serves as the mock stand-in for DSH management access, never as production.
 */
export function createManagementTransport() {
  const hostMarker = Object.freeze({ host: 'synthetic-management-host' });
  const bindings = new WeakMap();
  const stats = { issued: 0, revoked: 0, checks: 0 };
  let sequence = 0;
  function issue({ observer, principal } = {}) {
    sequence += 1;
    const peer = Object.freeze({ id: `peer-${String(sequence)}`, ctx: Object.freeze({}) });
    const subject = Object.freeze({ kind: 'person', subject: principal ?? `person-${String(sequence)}` });
    const invocation = Object.freeze({ service: 'iam-view', peer: Object.freeze({ ...peer, principal: subject }), signal: Object.freeze({}) });
    const context = Object.freeze({});
    const binding = { observer, invocation, peer, principal: subject, marker: hostMarker, context, active: true };
    bindings.set(context, binding);
    stats.issued += 1;
    const sealed = Object.freeze({ principal: subject, peer, invocation });
    return {
      context,
      binding: sealed,
      revoke() { if (binding.active) { binding.active = false; stats.revoked += 1; } },
    };
  }
  function verify(context, observer) {
    stats.checks += 1;
    const binding = typeof context === 'object' && context !== null ? bindings.get(context) : undefined;
    return binding !== undefined && binding.active === true && binding.observer === observer
      && binding.marker === hostMarker && binding.context === context
      && Object.isFrozen(binding.principal) && binding.invocation.peer.principal === binding.principal;
  }
  return { issue, verify, stats };
}

export function createFakeIam({ view = SIGNED_OUT_VIEW, watchFrame = STALE_VIEW } = {}) {
  const wakers = new Set();
  const holds = [];
  const iam = {
    view,
    watchFrame,
    calls: { sync: 0, load: 0, getView: 0, watch: 0 },
    active: 0,
    maxActive: 0,
    watchOpen: 0,
    holdNext(kind = 'any') {
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      holds.push({ kind, entered: entered.resolve, wait: released.promise });
      return { entered: entered.promise, release: released.resolve };
    },
    wake() { for (const resolve of [...wakers]) resolve(); wakers.clear(); },
    async syncFromStore() {
      iam.calls.sync += 1;
      await enter(iam, holds, 'sync');
    },
    async loadGatewayCredential() {
      iam.calls.load += 1;
      await enter(iam, holds, 'load');
    },
    getView() { iam.calls.getView += 1; return iam.view; },
    async *watch(signal) {
      iam.calls.watch += 1;
      iam.watchOpen += 1;
      const onAbort = () => iam.wake();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        yield iam.watchFrame;
        for (;;) {
          if (signal?.aborted) return;
          await new Promise((resolve) => { wakers.add(resolve); if (signal?.aborted) { wakers.delete(resolve); resolve(); } });
          if (signal?.aborted) return;
          yield iam.watchFrame;
        }
      } finally {
        iam.watchOpen -= 1;
        signal?.removeEventListener('abort', onAbort);
        iam.wake();
      }
    },
  };
  return iam;
}

async function enter(iam, holds, kind) {
  iam.active += 1;
  iam.maxActive = Math.max(iam.maxActive, iam.active);
  try {
    const index = holds.findIndex((candidate) => candidate.kind === 'any' || candidate.kind === kind);
    const hold = index === -1 ? undefined : holds.splice(index, 1)[0];
    if (hold) { hold.entered(); await hold.wait; }
  } finally {
    iam.active -= 1;
  }
}

/** A generated stream handle: one consumer, one physical generation, dispose cancels. */
export function createManualHandle({ name = 'view' } = {}) {
  const stats = { opened: 0, disposed: 0, iterated: 0 };
  let consumed = false;
  let disposed = false;
  const queue = [];
  let waiter = null;
  const handle = {
    id: name,
    stats,
    push(value) {
      if (disposed) return;
      if (waiter) { const resolve = waiter; waiter = null; resolve({ value, done: false }); } else queue.push(value);
    },
    end() {
      disposed = true;
      if (waiter) { const resolve = waiter; waiter = null; resolve({ done: true, value: undefined }); }
    },
    fail(error) { handle._error = error; handle.end(); },
    dispose() {
      if (disposed) { return; }
      disposed = true; stats.disposed += 1;
      if (waiter) { const resolve = waiter; waiter = null; resolve({ done: true, value: undefined }); }
    },
    get disposed() { return disposed; },
    [Symbol.asyncIterator]() {
      if (consumed) throw new Error('handle already has one consumer');
      consumed = true; stats.iterated += 1;
      return {
        next() {
          if (handle._error) { const error = handle._error; handle._error = null; return Promise.reject(error); }
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (disposed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => { waiter = resolve; });
        },
        return(value) { handle.dispose(); return Promise.resolve({ done: true, value }); },
      };
    },
  };
  stats.opened += 1;
  return handle;
}

export async function collectFrames(iterable, count) {
  const frames = [];
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (frames.length < count) {
      const next = await iterator.next();
      if (next.done) break;
      frames.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return frames;
}