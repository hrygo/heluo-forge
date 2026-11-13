// Private Host-side observer for the IAM view. This module is exposed only
// through the package's isolated-testing entry: it is not a DSH Remote service,
// does not register a Gateway contribution, and never replaces the HTTP chain.
//
// The management-context verifier is supplied by the trusted test composition.
// It simulates DSH management access; it is not IAM sign-in and cannot be
// satisfied by a DTO, a service property, or an async answer.

import { types } from 'node:util';

const INTERVAL_MS = 2000;
const STATES = Object.freeze(['unconfigured', 'signed-out', 'authenticating', 'ready', 'expired', 'unreachable', 'error']);
const VIEW_KEYS = Object.freeze(['state', 'configured', 'signedIn', 'canSignOut', 'canSignIn', 'missing',
  'error', 'exclusive', 'principal', 'identity', 'accessExpiresAt', 'gatewayCredential', 'gatewayConsoleUrl']);
const CREDENTIAL_KEYS = Object.freeze(['state', 'ownerSubject', 'deviceLabel', 'enteredAt', 'suggestedExpiry',
  'storage', 'matchesAccount']);
// 只读显示投影（issue #160）：仅三个定稿字段，未知键一律拒绝。
const IDENTITY_KEYS = Object.freeze(['user_id', 'user_name', 'work_no']);

export class IamViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IamViewError';
    this.code = code;
  }
}

const invalid = (message) => new IamViewError('IAM_VIEW_INVALID', message);
const unverified = () => new IamViewError('IAM_VIEW_UNVERIFIED', 'the management call could not be verified');
const changed = () => new IamViewError('IAM_VIEW_CHANGED', 'the subscription changed while the read was pending');
const unknown = () => new IamViewError('IAM_VIEW_UNKNOWN', 'the view read failed');

function isProxy(value) {
  return value !== null && typeof value === 'object' && types.isProxy(value);
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isProxy(value)) throw invalid('the view must not be a proxy');
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function dataOf(record, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw invalid('the view is not readable');
  }
  if (descriptor === undefined) throw invalid(`the view is missing ${key}`);
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`the view exposes ${key} as an accessor`);
  return descriptor.value;
}

function optionalDataOf(record, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw invalid('the view is not readable');
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`the view exposes ${key} as an accessor`);
  return { present: true, value: descriptor.value };
}

function stringOrNull(value, key) {
  if (value === null || typeof value === 'string') return value;
  throw invalid(`the view has an invalid ${key}`);
}

function projectCredential(value) {
  if (value === null) return null;
  if (!plainRecord(value)) throw invalid('the view has an invalid gatewayCredential');
  const credential = {};
  const state = dataOf(value, 'state');
  if (typeof state !== 'string' || state.length === 0) throw invalid('the view has an invalid gatewayCredential.state');
  credential.state = state;
  for (const key of CREDENTIAL_KEYS.slice(1)) {
    const field = optionalDataOf(value, key);
    if (!field.present) continue;
    if (key === 'matchesAccount') {
      if (typeof field.value !== 'boolean') throw invalid('the view has an invalid gatewayCredential.matchesAccount');
      credential[key] = field.value;
      continue;
    }
    credential[key] = stringOrNull(field.value, `gatewayCredential.${key}`);
  }
  return Object.freeze(credential);
}

/** Copy only the whitelisted, non-secret fields of a live IamView. */
export function projectView(raw) {
  if (!plainRecord(raw)) throw invalid('the view is not a plain object');
  const state = dataOf(raw, 'state');
  if (typeof state !== 'string' || !STATES.includes(state)) throw invalid('the view has an invalid state');
  const configured = dataOf(raw, 'configured');
  const signedIn = dataOf(raw, 'signedIn');
  const canSignOut = dataOf(raw, 'canSignOut');
  const canSignIn = dataOf(raw, 'canSignIn');
  for (const [key, value] of [['configured', configured], ['signedIn', signedIn], ['canSignOut', canSignOut], ['canSignIn', canSignIn]]) {
    if (typeof value !== 'boolean') throw invalid(`the view has an invalid ${key}`);
  }
  const missing = projectMissing(dataOf(raw, 'missing'));
  const exclusive = dataOf(raw, 'exclusive');
  if (typeof exclusive !== 'string') throw invalid('the view has an invalid exclusive');
  const error = stringOrNull(dataOf(raw, 'error'), 'error');
  const principal = stringOrNull(dataOf(raw, 'principal'), 'principal');
  const identity = projectIdentity(dataOf(raw, 'identity'));
  const accessExpiresAt = stringOrNull(dataOf(raw, 'accessExpiresAt'), 'accessExpiresAt');
  const gatewayConsoleUrl = stringOrNull(dataOf(raw, 'gatewayConsoleUrl'), 'gatewayConsoleUrl');
  const gatewayCredential = projectCredential(dataOf(raw, 'gatewayCredential'));
  return Object.freeze({
    state, configured, signedIn, canSignOut, canSignIn, missing,
    error, exclusive, principal, identity, accessExpiresAt, gatewayCredential, gatewayConsoleUrl,
  });
}

function projectIdentity(value) {
  if (value === null || value === undefined) return null;
  if (!plainRecord(value)) throw invalid('the view has an invalid identity');
  const identity = {};
  for (const key of IDENTITY_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      throw invalid('the view has an invalid identity');
    }
    identity[key] = descriptor.value;
  }
  for (const key of Object.keys(value)) {
    if (!IDENTITY_KEYS.includes(key)) throw invalid('the view has an invalid identity');
  }
  return Object.keys(identity).length === 0 ? null : Object.freeze(identity);
}

function projectMissing(value) {
  if (!Array.isArray(value) || isProxy(value)) throw invalid('the view has an invalid missing list');
  try {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw invalid('the view has an invalid missing list');
      }
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof IamViewError) throw error;
    throw invalid('the view has an invalid missing list');
  }
}

function emptyIterable() {
  return Object.freeze({
    [Symbol.asyncIterator]: () => Object.freeze({
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: (value) => Promise.resolve({ done: true, value }),
    }),
  });
}

function asViewFailure(error) {
  if (error instanceof IamViewError) return error;
  return unknown();
}

/**
 * @param {object} iam actual IAM service instance created by the trusted test
 * @param {{ verifyManagementContext: (context: object, observer: object) => boolean,
 *   clock?: { setInterval: Function, clearInterval: Function } }} options
 */
export function createIamViewObserver(iam, { verifyManagementContext, clock } = {}) {
  for (const name of ['syncFromStore', 'loadGatewayCredential', 'getView', 'watch']) {
    if (typeof iam?.[name] !== 'function') throw invalid(`iam.${name} must be a function`);
  }
  if (typeof verifyManagementContext !== 'function') throw invalid('verifyManagementContext must be a function');
  const timers = clock ?? { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle) };
  if (typeof timers.setInterval !== 'function' || typeof timers.clearInterval !== 'function') {
    throw invalid('clock must provide setInterval and clearInterval');
  }
  if (typeof window !== 'undefined') throw invalid('the view observer is Host-only');

  let group = null;
  let disposed = false;
  let tail = Promise.resolve();

  const observer = {
    observe(context, signal) {
      if (disposed) throw changed();
      if (typeof context !== 'object' || context === null) throw unverified();
      if (signal !== undefined && (typeof signal !== 'object' || signal === null
        || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
        throw invalid('signal must be an AbortSignal');
      }
      verified(context);
      if (signal?.aborted) return emptyIterable();
      const subscription = createSubscription(context, signal);
      if (group === null) group = createGroup();
      group.add(subscription);
      return subscription.iterable;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const current = group;
      group = null;
      if (current) await current.dispose();
    },
  };

  function verified(context) {
    let answer;
    try {
      answer = verifyManagementContext(context, observer);
    } catch {
      throw unverified();
    }
    if (answer && typeof answer.then === 'function') {
      Promise.resolve(answer).catch(() => {});
      throw unverified();
    }
    if (answer !== true) throw unverified();
  }

  function createSubscription(context, signal) {
    const queue = [];
    let waiter = null;
    let done = false;
    let rejection = null;
    let consumer = null;

    const subscription = {
      verifies() {
        if (done) return false;
        try {
          verified(context);
          return true;
        } catch {
          return false;
        }
      },
      push(snapshot) {
        if (done) return;
        if (waiter) {
          const { resolve } = waiter;
          waiter = null;
          resolve({ value: snapshot, done: false });
        } else {
          queue.push(snapshot);
        }
      },
      fail(error) {
        if (done) return;
        done = true;
        queue.length = 0;
        if (waiter) {
          const reject = waiter.reject;
          waiter = null;
          reject(error);
        } else {
          rejection = error;
        }
        subscription.attached?.remove(subscription);
      },
      finish() {
        if (done) return;
        done = true;
        queue.length = 0;
        if (waiter) {
          const resolve = waiter.resolve;
          waiter = null;
          resolve({ done: true, value: undefined });
        }
        subscription.attached?.remove(subscription);
      },
    };

    const iterable = {
      [Symbol.asyncIterator]() {
        if (consumer !== null) throw invalid('one subscription has one consumer');
        consumer = {
          next() {
            if (!subscription.verifies()) subscription.fail(changed());
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (rejection !== null) {
              const error = rejection;
              rejection = null;
              return Promise.reject(error);
            }
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
          return(value) {
            subscription.finish();
            return Promise.resolve({ done: true, value });
          },
        };
        return consumer;
      },
    };
    subscription.iterable = iterable;

    if (signal) {
      const onAbort = () => subscription.finish();
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = subscription.finish;
      const fail = subscription.fail;
      subscription.finish = () => { signal.removeEventListener('abort', onAbort); finish(); };
      subscription.fail = (error) => { signal.removeEventListener('abort', onAbort); fail(error); };
    }
    return subscription;
  }

  function createGroup() {
    const pins = {
      syncFromStore: iam.syncFromStore, loadGatewayCredential: iam.loadGatewayCredential,
      getView: iam.getView, watch: iam.watch,
    };
    const subscribers = new Set();
    let last = null;
    let lastKey = null;
    let flight = null;
    let wake = false;
    let timer = null;
    let controller = null;
    let watchTask = null;
    let closed = false;
    let epoch = 0;

    function stillCurrent() {
      return !closed && iam.syncFromStore === pins.syncFromStore
        && iam.loadGatewayCredential === pins.loadGatewayCredential
        && iam.getView === pins.getView && iam.watch === pins.watch;
    }

    function authorized() {
      if (closed) return false;
      for (const subscription of subscribers) if (subscription.verifies()) return true;
      return false;
    }

    async function readOnce() {
      if (!stillCurrent() || !authorized()) throw changed();
      await pins.syncFromStore.call(iam);
      if (!stillCurrent() || !authorized()) throw changed();
      await pins.loadGatewayCredential.call(iam);
      if (!stillCurrent() || !authorized()) throw changed();
      const raw = pins.getView.call(iam);
      if (!stillCurrent()) throw changed();
      return projectView(raw);
    }

    function publish(snapshot) {
      const key = JSON.stringify(snapshot);
      const emitted = key !== lastKey;
      last = snapshot;
      lastKey = key;
      for (const subscription of [...subscribers]) {
        if (closed) return;
        if (!subscription.verifies()) {
          subscribers.delete(subscription);
          subscription.fail(changed());
          continue;
        }
        if (emitted) subscription.push(snapshot);
      }
      if (subscribers.size === 0) stop();
    }

    function requestRead() {
      if (closed || subscribers.size === 0 || flight !== null) {
        if (flight !== null && !closed) wake = true;
        return;
      }
      const mine = epoch;
      flight = tail = tail.then(async () => {
        if (closed || mine !== epoch) return;
        try {
          const snapshot = await readOnce();
          if (closed || mine !== epoch) return;
          publish(snapshot);
        } catch (error) {
          if (closed || mine !== epoch) return;
          const failure = asViewFailure(error);
          for (const subscription of [...subscribers]) subscription.fail(failure);
          subscribers.clear();
          stop();
        } finally {
          flight = null;
          if (wake && !closed && subscribers.size > 0) {
            wake = false;
            requestRead();
          }
        }
      });
    }

    async function pump() {
      let first = true;
      try {
        for await (const _ignored of pins.watch.call(iam, controller.signal)) {
          if (closed) return;
          // The first value is the watcher's opening snapshot, already read by
          // the initialization cycle; a queued value only wakes a fresh read.
          if (first) { first = false; continue; }
          requestRead();
        }
      } catch {
        // A watcher failure must not erase the last published state; the timer
        // keeps reading. Nothing is replayed from the failed stream.
      }
    }

    function start() {
      timer = timers.setInterval(() => { if (!closed) requestRead(); }, INTERVAL_MS);
      controller = new AbortController();
      watchTask = pump();
    }

    function stop() {
      if (closed) return;
      closed = true;
      epoch += 1;
      wake = false;
      last = null;
      lastKey = null;
      if (timer !== null) { timers.clearInterval(timer); timer = null; }
      const active = controller;
      controller = null;
      active?.abort();
      for (const subscription of [...subscribers]) subscription.finish();
      subscribers.clear();
      if (group === currentGroup) group = null;
    }

    let currentGroup = null;
    const handle = {
      add(subscription) {
        if (closed) { subscription.fail(changed()); return; }
        subscribers.add(subscription);
        subscription.attached = handle;
        if (subscribers.size === 1) start();
        if (last !== null) subscription.push(last);
        else if (flight === null) requestRead();
      },
      remove(subscription) {
        if (!subscribers.delete(subscription)) return;
        if (subscribers.size === 0) stop();
      },
      async dispose() {
        const task = watchTask;
        stop();
        if (task) await task.catch(() => {});
      },
    };
    currentGroup = handle;
    return handle;
  }

  return observer;
}