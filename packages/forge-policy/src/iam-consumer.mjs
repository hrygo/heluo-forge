import { digestContent } from './egress.mjs';

const messages = Object.freeze({
  INPUT_INVALID: 'IAM consumption input is invalid',
  UNVERIFIED: 'IAM consumption sources are not verified',
  DENIED: 'IAM consumption is denied',
  CHANGED: 'IAM consumption context changed',
  UNKNOWN: 'IAM consumption outcome is unknown; no retry was attempted',
});
const failure = (kind) => Object.assign(new Error(messages[kind]), { code: `IAM_CONSUMPTION_${kind}` });
const object = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');
const scopeFields = ['kind', 'target', 'purpose'];
const witnessFields = ['pin', 'issuer', 'subject'];
const permitFields = ['issuer', 'subject', 'kind', 'target', 'purpose', 'revision'];
const sourceFields = ['iam', 'witnessSource', 'authorizer', 'consumer'];
const executionFields = ['name', 'callId', 'rootCallId', 'token', 'agent'];
function sync(value) {
  if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw 0; }
  return value;
}
function fields(value, keys) {
  if (!object(value) || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) throw 0;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, own(value, key)])));
}
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw 0;
  return descriptor.value;
}
const text = (value) => typeof value === 'string' && value.trim().length > 0;
function scopeCopy(original) {
  const copy = fields(original, scopeFields);
  if (!['tool', 'model'].includes(copy.kind) || !text(copy.target) || !text(copy.purpose)) throw 0;
  return copy;
}
function unchanged(original, copy, keys) {
  const current = fields(original, keys);
  return keys.every((key) => current[key] === copy[key]);
}

// Narrow JSON request copy, not a general schema: no accessors, toJSON, cycles,
// special objects or lossy undefined/function values reach the existing digest.
function inputCopy(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64) throw 0;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw 0;
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw 0;
      return Object.freeze(Array.from({ length: value.length }, (_, i) => inputCopy(own(value, String(i)), ancestors)));
    }
    if (keys.some((key) => typeof key !== 'string')) throw 0;
    return Object.freeze(Object.fromEntries(keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) throw 0;
      return [key, inputCopy(own(value, key), ancestors)];
    })));
  } finally { ancestors.delete(value); }
}
function executionCopy(exec) {
  const copy = Object.fromEntries(executionFields.map((key) => [key, own(exec, key)]));
  if (!text(copy.name) || !text(copy.callId) || !text(copy.rootCallId) || typeof copy.token !== 'symbol' || !object(copy.agent)) throw 0;
  return Object.freeze(copy);
}
function cancelled(signal) {
  return signal !== undefined && (!object(sync(signal)) || sync(signal.aborted) !== false);
}

/** Private source/mock core only. No SDK registration, real IAM or default apply. */
export function createIamConsumer(options = {}) {
  const operations = new WeakMap();
  const attempted = new WeakSet();
  let active = true;

  function sameSources(data, verify = true) {
    if (sync(options.getSources) !== data.getSources || sync(options.verifyConsumerSources) !== data.verifier
      || sync(data.getSources()) !== data.stage || !unchanged(data.stage, data.sources, sourceFields)) return false;
    const { iam, witnessSource, authorizer, consumer } = data.sources;
    const sameMethods = () => sync(witnessSource.capture) === data.capture && sync(witnessSource.isCurrent) === data.witnessCurrent
      && sync(authorizer.read) === data.read && sync(authorizer.isCurrent) === data.permitCurrent;
    if (!sameMethods() || (verify && sync(data.verifier(iam, witnessSource, authorizer, consumer, data.scope)) !== true)) return false;
    return sync(options.getSources) === data.getSources && sync(options.verifyConsumerSources) === data.verifier
      && sync(data.getSources()) === data.stage && unchanged(data.stage, data.sources, sourceFields) && sameMethods();
  }
  function sameInput(data) {
    return executionFields.every((key) => own(data.exec, key) === data.execution[key])
      && own(data.exec, 'arguments') === data.arguments
      && digestContent(inputCopy(own(data.exec, 'arguments'))) === data.digest
      && unchanged(data.originalScope, data.scope, scopeFields)
      && !cancelled(data.originalSignal) && !cancelled(own(data.exec, 'signal'));
  }
  function current(data, needsPermit = true) {
    try {
      if (!active || !sameSources(data) || !sameInput(data)
        || !unchanged(data.witness, data.witnessCopy, witnessFields)
        || sync(data.witnessCurrent.call(data.sources.witnessSource, data.witness)) !== true) return false;
      if (needsPermit && (!unchanged(data.permit, data.permitCopy, permitFields)
        || sync(data.permitCurrent.call(data.sources.authorizer, data.permit)) !== true)) return false;
      // Reentrant tuple verification may revoke authority. Check original
      // currents again afterwards; never acquire replacement witness/permit.
      return active && sameSources(data)
        && sync(data.witnessCurrent.call(data.sources.witnessSource, data.witness)) === true
        && (!needsPermit || sync(data.permitCurrent.call(data.sources.authorizer, data.permit)) === true)
        && sameInput(data) && unchanged(data.witness, data.witnessCopy, witnessFields)
        && (!needsPermit || unchanged(data.permit, data.permitCopy, permitFields)) && active;
    } catch { return false; }
  }

  async function prepare(exec, originalScope) {
    if (!active) throw failure('CHANGED');
    if (!object(exec)) throw failure('INPUT_INVALID');
    if (attempted.has(exec)) throw failure('CHANGED');
    attempted.add(exec);
    let data;
    try {
      const scope = scopeCopy(originalScope);
      const input = inputCopy(own(exec, 'arguments'));
      data = { exec, execution: executionCopy(exec), arguments: own(exec, 'arguments'), input,
        digest: digestContent(input), originalScope, scope, originalSignal: own(exec, 'signal'), phase: 'preparing' };
    } catch { throw failure('INPUT_INVALID'); }
    try { if (cancelled(data.originalSignal)) throw 0; } catch { throw failure('CHANGED'); }
    try {
      data.getSources = sync(options.getSources); data.verifier = sync(options.verifyConsumerSources);
      if (typeof data.getSources !== 'function' || typeof data.verifier !== 'function') throw 0;
      data.stage = sync(data.getSources());
      data.sources = fields(data.stage, sourceFields);
      if (Object.values(data.sources).some((value) => !object(sync(value)))) throw 0;
      data.capture = sync(data.sources.witnessSource.capture); data.witnessCurrent = sync(data.sources.witnessSource.isCurrent);
      data.read = sync(data.sources.authorizer.read); data.permitCurrent = sync(data.sources.authorizer.isCurrent);
      if ([data.capture, data.witnessCurrent, data.read, data.permitCurrent].some((fn) => typeof fn !== 'function') || !sameSources(data)) throw 0;
    } catch { throw failure('UNVERIFIED'); }
    try {
      data.witness = sync(data.capture.call(data.sources.witnessSource));
      data.witnessCopy = fields(data.witness, witnessFields);
      if (!Object.isFrozen(data.witness) || !object(data.witnessCopy.pin) || !Object.isFrozen(data.witnessCopy.pin)
        || !text(data.witnessCopy.issuer) || !text(data.witnessCopy.subject)
        || sync(data.witnessCurrent.call(data.sources.witnessSource, data.witness)) !== true) throw 0;
    } catch { throw failure('DENIED'); }
    if (!current(data, false)) throw failure('CHANGED');
    let permit;
    try { permit = await data.read.call(data.sources.authorizer, data.witness, data.scope); }
    catch {
      if (!current(data, false)) throw failure('CHANGED');
      throw failure('UNVERIFIED');
    }
    if (!current(data, false)) throw failure('CHANGED');
    try {
      data.permit = permit; data.permitCopy = fields(permit, permitFields);
      if (!permitFields.every((key) => text(data.permitCopy[key]))
        || data.permitCopy.issuer !== data.witnessCopy.issuer || data.permitCopy.subject !== data.witnessCopy.subject
        || scopeFields.some((key) => data.permitCopy[key] !== data.scope[key])
        || sync(data.permitCurrent.call(data.sources.authorizer, permit)) !== true) throw 0;
    } catch { throw failure('DENIED'); }
    if (!current(data)) throw failure('CHANGED');
    const operation = Object.freeze({});
    data.phase = 'prepared'; operations.set(operation, data);
    return operation;
  }
  function assertCurrent(operation, exec) {
    const data = operations.get(operation);
    if (!data || data.exec !== exec || !current(data)) {
      operations.delete(operation);
      throw failure('CHANGED');
    }
    return true;
  }
  function release(operation) { operations.delete(operation); }
  function fail(operation, exec) {
    let changed = false;
    try { assertCurrent(operation, exec); } catch { changed = true; }
    const sent = operations.get(operation)?.phase === 'sent';
    release(operation);
    throw failure(changed || !sent ? 'CHANGED' : 'UNKNOWN');
  }
  async function dispatch(operation, exec, send) {
    assertCurrent(operation, exec);
    const data = operations.get(operation);
    if (data.phase !== 'prepared') throw failure('CHANGED');
    if (typeof send !== 'function') throw failure('INPUT_INVALID');
    // Consume synchronously, with no await between final assertion and send.
    data.phase = 'sent';
    try {
      const result = await send(data.input);
      assertCurrent(operation, exec);
      return result;
    } catch { return fail(operation, exec); }
  }
  function finish(operation, exec, result) {
    assertCurrent(operation, exec);
    const sent = operations.get(operation).phase === 'sent';
    release(operation);
    if (!sent) throw failure('CHANGED');
    return result;
  }
  return Object.freeze({ prepare, assertCurrent, dispatch, finish, fail, release,
    dispose() { active = false; } });
}
