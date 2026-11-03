// Local SDK-shaped registry; no native profile or request-error recovery plugin.
// Matches SDK immediate llm/stream waterfall + lazy default adapterStream.
const unknown = Object.freeze({ code: 'UNKNOWN', message: 'LLM adapter failed' });
function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw 0;
  return descriptor?.value;
}
// Controlled SDK-compatible subset: only frozen, own data-backed carriers.
// No HarnessError emulation, foreign message getter or cause coercion. All four
// SDK optional facts are validated and detached; other payload fields are lost.
function carriedFailure(cause) {
  try {
    if (!(cause instanceof Error)) return unknown;
    const carried = ownData(cause, 'failure');
    if (!carried || typeof carried !== 'object' || !Object.isFrozen(carried)) return unknown;
    const facts = Object.fromEntries(['code', 'message', 'status', 'providerRetryAfterMs', 'requestId', 'offloadImages']
      .map((key) => [key, ownData(carried, key)]));
    const { code, message, status, providerRetryAfterMs, requestId, offloadImages } = facts;
    if (typeof code !== 'string' || !code.length || typeof message !== 'string' || !message.length || code !== ownData(cause, 'code')
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || !requestId.length))
      || (offloadImages !== undefined && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0))) return unknown;
    return Object.freeze(Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)));
  } catch { return unknown; }
}
const failure = (cause) => ({ type: 'finish', reason: { kind: 'error', failure: carriedFailure(cause) } });
// Local registry-owned errors also use the SDK's accepted carrier, not a
// pretend HarnessError class or a general allowance for ordinary Error.code.
const registryError = (code, message) => Object.assign(new Error(message), { code, failure: Object.freeze({ code, message }) });
const defaultRetry = Object.freeze({ mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 });
const synchronous = (value) => { if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw new Error('async metadata'); } return value; };
export function createModelRuntime() {
  const routes = new Map(), effects = [], calls = { prepare: 0, stream: 0, waterfall: 0, info: 0, retry: 0 };
  const host = { routes, calls };
  const metadata = async (record, config, signal) => {
    calls.prepare++;
    const prepared = await record.adapter.prepareCall(config.provider, config.model, signal);
    if (prepared.model.provider !== config.provider || prepared.model.id !== config.model
      || typeof prepared.model.name !== 'string' || typeof prepared.stream !== 'function') throw new Error('invalid prepared model');
    return prepared;
  };
  async function* dispatch(options, captured) {
    let iterator, completed = false;
    try {
      const record = captured?.record ?? routes.get(options.provider);
      if (!record) throw registryError('NO_ADAPTER', 'unknown provider');
      const prepared = captured?.prepared ?? await metadata(record, options, options.signal);
      const iterable = prepared.stream(options); calls.stream++;
      // Synchronous test instrumentation at SDK dispatch line 2349, not a new
      // native middleware/await slot. Observes actual registered adapter entry.
      host.onAdapterStream?.(iterable);
      iterator = iterable[Symbol.asyncIterator]();
      while (true) {
        const item = await iterator.next();
        if (item.done) { completed = true; return; }
        yield item.value;
      }
    } catch (cause) { completed = true; yield failure(cause); }
    finally { if (!completed) await iterator?.return?.(); }
  }
  const llm = {
    registerAdapter(providers, adapter) {
      if (!providers.length || new Set(providers).size !== providers.length || providers.some((provider) => routes.has(provider))) {
        throw Object.assign(new Error('provider route already registered'), { code: 'DUPLICATE_ADAPTER' });
      }
      const records = providers.map((provider) => {
        calls.info++; const info = synchronous(adapter.providerInfo(provider));
        calls.retry++; const policy = synchronous(adapter.providerRetryPolicy(provider)) ?? defaultRetry;
        if (info.id !== provider || typeof info.name !== 'string') throw new Error('invalid provider info');
        return [provider, { adapter, info, retryPolicy: policy }];
      });
      for (const [provider, record] of records) routes.set(provider, record);
      const dispose = () => { for (const [provider, record] of records) if (routes.get(provider) === record) routes.delete(provider); };
      effects.push(dispose);
      return dispose;
    },
    providerRetryPolicy(provider) { return routes.get(provider)?.retryPolicy ?? defaultRetry; },
    async prepareCall(config, signal) {
      const record = routes.get(config.provider);
      if (!record) throw registryError('NO_ADAPTER', 'unknown provider');
      const prepared = await metadata(record, config, signal);
      let used = false;
      return { config: Object.freeze({ ...config }), retryPolicy: record.retryPolicy, adapterDefaults: Object.freeze({}),
        stream(options) {
          if (used || options.provider !== config.provider || options.model !== config.model) throw new Error('prepared call changed');
          used = true; calls.waterfall++;
          return dispatch(options, { record, prepared });
        },
      };
    },
    stream(options) { calls.waterfall++; return dispatch(options); },
  };
  host.ctx = { llm, effect(callback) { effects.push(callback()); } };
  host.unload = () => { for (const dispose of effects.splice(0).reverse()) dispose?.(); };
  return host;
}
