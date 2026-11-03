import { createIamConsumer } from './iam-consumer.mjs';

const messages = Object.freeze({ INPUT_INVALID: 'IAM consumption input is invalid', UNVERIFIED: 'IAM consumption sources are not verified',
  DENIED: 'IAM consumption is denied', CHANGED: 'IAM consumption context changed', UNKNOWN: 'IAM consumption outcome is unknown; no retry was attempted' });
function error(kind) {
  const code = `IAM_CONSUMPTION_${kind}`, message = `${code}: ${messages[kind]}`;
  return Object.assign(new Error(message), { code, failure: Object.freeze({ code, message }) });
}
function safe(cause) {
  let code; try { code = Object.getOwnPropertyDescriptor(cause, 'code')?.value; } catch { /* never inspect foreign getters */ }
  const kind = typeof code === 'string' && code.startsWith('IAM_CONSUMPTION_') ? code.slice(16) : '';
  return error(Object.hasOwn(messages, kind) ? kind : 'UNKNOWN');
}
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const requestKeys = ['provider', 'model', 'messages', 'reasoningEffort', 'system', 'tools', 'toolHistory',
  'temperature', 'maxTokens', 'stop', 'signal', 'sessionId', 'purpose'];
const retryPolicy = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: Object.freeze([]),
  initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 });
function fields(value, array = false) {
  if (!value || typeof value !== 'object' || (!array && Array.isArray(value))) throw error('INPUT_INVALID');
  return Object.fromEntries(Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) throw error('INPUT_INVALID');
    return [key, descriptor.value];
  }));
}
// Narrow data-only chunk copy: getters, opaque objects and cycles are never
// yielded for a consumer to evaluate outside our fixed-error boundary.
function chunkCopy(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 64) throw error('UNKNOWN');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('UNKNOWN');
  seen.add(value);
  try {
    let raw;
    try { raw = fields(value, array); } catch { throw error('UNKNOWN'); }
    if (array) {
      if (Object.keys(raw).length !== value.length + 1) throw error('UNKNOWN');
      return Object.freeze(Array.from({ length: value.length }, (_, i) => {
        if (!Object.hasOwn(raw, String(i))) throw error('UNKNOWN'); return chunkCopy(raw[i], seen);
      }));
    }
    return Object.freeze(Object.fromEntries(Object.entries(raw).filter(([, item]) => item !== undefined).map(([key, item]) => [key, chunkCopy(item, seen)])));
  } finally { seen.delete(value); }
}

/** One owner-controlled synthetic route, not a production provider or retry framework. */
export function installIamConsumerModel(ctx, owner) {
  const provider = owner.provider, model = owner.model, send = owner.send, beforeSend = owner.beforeSend;
  const scope = Object.freeze(fields(owner.scope));
  if (!text(provider) || !text(model) || typeof send !== 'function' || (beforeSend !== undefined && typeof beforeSend !== 'function')
    || Object.keys(scope).sort().join(',') !== 'kind,purpose,target' || scope.kind !== 'model'
    || scope.target !== `${provider}/${model}` || !text(scope.purpose)) throw error('INPUT_INVALID');
  if (typeof ctx.llm?.registerAdapter !== 'function' || typeof ctx.effect !== 'function') throw error('UNVERIFIED');
  let active = true, sequence = 0;
  const reader = owner.getSources;
  const core = createIamConsumer({
    getSources() { return owner.getSources === reader && typeof reader === 'function' ? reader(adapter) : undefined; },
    get verifyConsumerSources() { return owner.verifyConsumerSources; },
  });
  function route(p, m = model) {
    if (!active) throw error('CHANGED');
    if (p !== provider || m !== model) throw error('INPUT_INVALID');
  }
  function requestFields(input) {
    const raw = fields(input);
    if (Object.keys(raw).some((key) => !requestKeys.includes(key)) || !Array.isArray(raw.messages)
      || (raw.purpose !== undefined && !['compaction', 'session-title'].includes(raw.purpose))) throw error('INPUT_INVALID');
    route(raw.provider, raw.model);
    return raw;
  }
  function stream(input) {
    const cancel = new AbortController();
    const state = { closed: false };
    let original, frame, operation, ready, iterator, iteratorClosed = false, completed = false;
    let signal;
    const fused = (value) => AbortSignal.any(value === undefined ? [cancel.signal] : [value, cancel.signal]);
    const release = () => { if (operation) core.release(operation); };
    // This frame is this actual owned stream invocation. None of its metadata is
    // a GenerateOptions/SDK agent field or evidence of a person's permission.
    try {
      original = requestFields(input); signal = original.signal;
      const id = `iam-owned-model-${++sequence}`;
      frame = { name: scope.target, callId: id, rootCallId: id, token: Symbol('owned-model-execution'),
        agent: state, signal: fused(signal),
        arguments: Object.fromEntries(Object.entries(original).filter(([key, value]) => key !== 'signal' && value !== undefined)) };
      // Deliberately starts before returning the iterable, not at first next().
      // Both rejection arms are handled even when the consumer never iterates.
      ready = core.prepare(frame, scope).then((prepared) => {
        operation = prepared; if (state.closed) release();
      }, (cause) => { state.failure = safe(cause); });
    } catch (cause) { state.failure = safe(cause); ready = Promise.resolve(); }
    function current() {
      if (!active || state.closed) throw error('CHANGED');
      let raw;
      try { raw = requestFields(input); } catch { throw error('CHANGED'); }
      const keys = Object.keys(original).filter((key) => key !== 'signal');
      if (Object.keys(raw).filter((key) => key !== 'signal').length !== keys.length
        || keys.some((key) => raw[key] !== original[key])) throw error('CHANGED');
      if (raw.signal !== signal) { signal = raw.signal; frame.signal = fused(signal); }
      core.assertCurrent(operation, frame);
    }
    async function waiting(callback) {
      let result;
      try { result = await callback(); } catch (cause) { current(); throw safe(cause); }
      current(); return result;
    }
    async function close() {
      if (!iterator || iteratorClosed || completed) return;
      iteratorClosed = true;
      try { await iterator.return?.(); }
      catch (cause) {
        if (!state.closed) current();
        throw safe(cause);
      }
      if (!state.closed) current();
    }
    async function* run() {
      let terminal;
      try {
        await ready;
        if (state.failure) throw state.failure;
        current();
        if (beforeSend) await waiting(() => beforeSend());
        current();
        const source = await core.dispatch(operation, frame, (bound) => send(Object.freeze({
          ...bound, provider, model, signal: frame.signal,
        })));
        current();
        if (typeof source?.[Symbol.asyncIterator] !== 'function') throw error('UNKNOWN');
        iterator = source[Symbol.asyncIterator](); current();
        while (true) {
          current(); const item = await waiting(() => iterator.next());
          if (!item || typeof item !== 'object') throw error('UNKNOWN');
          if (item.done) {
            completed = true;
            if (!terminal) throw error('UNKNOWN');
            core.finish(operation, frame, terminal);
            yield terminal;
            return;
          }
          const chunk = chunkCopy(item.value); current();
          if (!['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'].includes(chunk.type) || terminal) throw error('UNKNOWN');
          if (chunk.type === 'finish') {
            if (['error', 'aborted'].includes(chunk.reason?.kind)) throw error('UNKNOWN');
            if (!['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind)) throw error('UNKNOWN');
            // Adopt a normal terminal only after the iterator completes under
            // this original operation, never while a final done await is stale.
            terminal = chunk;
          } else yield chunk;
        }
      } catch (cause) {
        let failure = safe(cause);
        try { await close(); } catch (cleanup) { if (failure.code !== 'IAM_CONSUMPTION_CHANGED') failure = safe(cleanup); }
        if (iterator && failure.code === 'IAM_CONSUMPTION_UNKNOWN') {
          try { core.fail(operation, frame); } catch (outcome) { failure = safe(outcome); }
        }
        state.closed = true; release();
        yield Object.freeze({ type: 'finish', reason: Object.freeze({ kind: cancel.signal.aborted || frame?.signal.aborted ? 'aborted' : 'error',
          failure: Object.freeze({ code: failure.code, message: failure.message }) }) });
      } finally {
        try { await close(); } finally { state.closed = true; release(); }
      }
    }
    const generator = run();
    const stop = () => { state.closed = true; cancel.abort(); release(); };
    return Object.freeze({
      [Symbol.asyncIterator]() { return this; },
      next: () => generator.next(),
      return() { stop(); return generator.return(); },
      throw() { stop(); return generator.throw(error('CHANGED')).catch((cause) => { throw safe(cause); }); },
    });
  }
  const info = Object.freeze({ provider, id: model, name: 'Synthetic IAM model', inputModalities: Object.freeze(['text']) });
  const adapter = Object.freeze({
    providerInfo(p) { route(p); return { id: provider, name: 'Synthetic IAM provider' }; },
    providerRetryPolicy(p) { route(p); return retryPolicy; },
    async prepareCall(p, m, signal) {
      route(p, m); if (signal?.aborted) throw error('CHANGED');
      return Object.freeze({ model: info, stream });
    },
    stream,
  });
  let unregister;
  const dispose = () => { if (!active) return; active = false; core.dispose(); unregister?.(); };
  try { unregister = ctx.llm.registerAdapter([provider], adapter); ctx.effect(() => dispose); }
  catch { dispose(); throw error('UNVERIFIED'); }
  return Object.freeze({ adapter, dispose });
}
