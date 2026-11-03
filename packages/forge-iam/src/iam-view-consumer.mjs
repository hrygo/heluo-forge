// Private Client-side consumer for one IAM view stream generation. It is
// exposed only through the package's isolated-testing entry; the real Client
// entry keeps its HTTP polling and does not mount this consumer.

const MESSAGES = Object.freeze({
  IAM_VIEW_INVALID: 'the view stream handle is not valid',
  IAM_VIEW_CHANGED: 'the view subscription changed',
  IAM_VIEW_UNKNOWN: 'the view subscription failed',
});

function failure(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.IAM_VIEW_UNKNOWN);
  error.name = 'IamViewError';
  error.code = code;
  return error;
}

function safeFailure(error) {
  const code = error !== null && typeof error === 'object' && error.name === 'IamViewError'
    && typeof error.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error.code : 'IAM_VIEW_UNKNOWN';
  return Object.freeze({ code, message: MESSAGES[code] });
}

function isHandle(value) {
  try {
    return value !== null && typeof value === 'object' && typeof value.then !== 'function'
      && typeof value[Symbol.asyncIterator] === 'function' && typeof value.dispose === 'function';
  } catch {
    return false;
  }
}

function isThenable(value) {
  try {
    return value !== null && typeof value === 'object' && typeof value.then === 'function';
  } catch {
    return false;
  }
}

function safeDispose(handle) {
  try {
    handle?.dispose?.();
  } catch {
    // The rejected handle is foreign; its failure must not escape.
  }
}

// A pathological handle may ignore dispose(). The consumer must still settle:
// it stops accepting first and never waits indefinitely for foreign code.
function settle(task) {
  return Promise.race([task.catch(() => {}), new Promise((resolve) => { setTimeout(resolve, 0); })]);
}

/**
 * @param {{ open: (signal: AbortSignal) => object, accept: (view: object) => void,
 *   onError?: (failure: { code: string, message: string }) => void }} options
 */
export function createIamViewConsumer({ open, accept, onError } = {}) {
  if (typeof open !== 'function' || typeof accept !== 'function') throw failure('IAM_VIEW_INVALID');
  if (onError !== undefined && typeof onError !== 'function') throw failure('IAM_VIEW_INVALID');

  let started = false;
  let disposed = false;
  let generation = 0;
  let current = null;
  let loop = null;

  function report(error) {
    if (typeof onError !== 'function') return;
    try {
      onError(safeFailure(error));
    } catch {
      // A subscriber callback must not break the owned loop or escape.
    }
  }

  function cancelCurrent() {
    const lease = current;
    current = null;
    if (lease === null) return;
    lease.controller.abort();
    try {
      lease.handle.dispose();
    } catch {
      // Disposing an owned handle must not throw into the caller.
    }
  }

  function begin() {
    if (disposed) return;
    const mine = ++generation;
    const controller = new AbortController();
    let handle;
    try {
      handle = open(controller.signal);
    } catch (error) {
      report(error);
      return;
    }
    if (isThenable(handle)) {
      controller.abort();
      Promise.resolve(handle).then((resolved) => safeDispose(resolved), () => {});
      report(failure('IAM_VIEW_INVALID'));
      return;
    }
    if (!isHandle(handle)) {
      controller.abort();
      safeDispose(handle);
      report(failure('IAM_VIEW_INVALID'));
      return;
    }
    const lease = { generation: mine, controller, handle };
    current = lease;
    loop = consume(lease);
  }

  async function consume(lease) {
    const mine = lease.generation;
    try {
      for await (const value of lease.handle) {
        if (disposed || generation !== mine || current !== lease) return;
        accept(value);
      }
    } catch (error) {
      if (disposed || generation !== mine || current !== lease) return;
      report(error);
    }
  }

  return {
    start() {
      if (disposed || started) return;
      started = true;
      begin();
    },

    restart() {
      if (disposed) return;
      if (!started) {
        this.start();
        return;
      }
      cancelCurrent();
      begin();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelCurrent();
      const task = loop;
      loop = null;
      if (task) await settle(task);
    },
  };
}