import { IamError } from './errors.mjs';
import { classifyFailure, gatewayCode } from './gateway-failure.mjs';
import { alignHostDefaultModel, HOST_DEFAULT_RESULTS } from './host-default-model.mjs';
import {
  NO_RETRY_POLICY,
  THINKING_LEVELS,
  REASONING_EFFORT_LEVELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeGatewayBaseURL,
  validateManagedModels,
  parseCapacity,
  formatCapacity,
  buildReasoningEffortRange,
  getReasoningEffortBounds,
  buildThinkingLevelMap,
  applyModelOptions,
  pickDefaultModel,
} from './model-options.mjs';

export {
  NO_RETRY_POLICY,
  THINKING_LEVELS,
  REASONING_EFFORT_LEVELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeGatewayBaseURL,
  validateManagedModels,
  parseCapacity,
  formatCapacity,
  buildReasoningEffortRange,
  getReasoningEffortBounds,
  buildThinkingLevelMap,
  applyModelOptions,
  pickDefaultModel,
};

export const MESSAGES = Object.freeze({
  IAM_GATEWAY_URL_INVALID: '请输入有效的 HTTP 或 HTTPS 网关地址。',
  ENTERPRISE_MODEL_CATALOG_INVALID: '网关返回的模型列表无法识别，请联系管理员检查网关。',
  IAM_LOGIN_REQUIRED: '企业账号已退出或登录已过期，请重新登录后再使用模型。',
  IAM_GATEWAY_CREDENTIAL_REQUIRED: '请在“设置 → 企业账号”保存当前账号的个人访问凭证。',
  ENTERPRISE_MODEL_NOT_ALLOWED: '此模型未由企业开放，请选择企业提供的模型。',
  ENTERPRISE_MODELS_UNAVAILABLE: '企业模型暂不可用，请联系管理员检查配置。',
  ENTERPRISE_MODEL_SYNC_CANCELLED: '模型目录同步被中断，请重试。',
  IAM_MODEL_CONTEXT_CHANGED: '账号或凭证已变化，请重新选择模型后再试。',
  ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED: '网关未接受个人访问凭证，请在“设置 → 企业账号”检查或更换凭证。',
  ENTERPRISE_GATEWAY_FORBIDDEN: '当前账号没有此模型的使用权限，请联系管理员。',
  ENTERPRISE_GATEWAY_RATE_LIMIT: '请求过于频繁，请稍后重试。',
  // The model layer reports an exhausted quota (429 quota / model cooldown) as
  // its own code; without a mapping it fell through to "cannot connect".
  ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED: '所选模型的额度已用尽，请更换模型或联系管理员。',
  ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED: '企业身份令牌已失效，请重新登录后再试。',
  ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED: '个人访问凭证已被回收，请联系管理员重新申领。',
  ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED: '个人访问凭证已被暂停，请联系管理员。',
  ENTERPRISE_GATEWAY_IDENTITY_MISMATCH: '登录身份与凭证绑定账号不一致，请重新登录后重试。',
  ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED: '当前客户端的标识未被企业网关识别，请升级客户端或联系管理员核准。',
  ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED: '所选模型的预算已用尽，请联系管理员或更换模型。',
  ENTERPRISE_GATEWAY_UNAVAILABLE: '暂时无法连接企业模型，请稍后重试。',
  ENTERPRISE_GATEWAY_REQUEST_REJECTED: '网关拒绝了本次请求，请检查网关地址或所选模型是否支持当前参数。',
  // Neither rejected nor provably unreachable: say so instead of guessing.
  ENTERPRISE_GATEWAY_CALL_FAILED: '本次请求未完成，请重试；持续失败请联系管理员。',
  ENTERPRISE_MODEL_REASONING_UNSUPPORTED: '所选模型的推理档位不受支持，请重新选择思考级别。',
});
const error = code => new IamError(code, MESSAGES[code]);
const finish = code => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: MESSAGES[code] } } });

const expires = view => typeof view?.accessExpiresAt === 'number' ? view.accessExpiresAt : Date.parse(view?.accessExpiresAt);
function permit(view) {
  if (view?.state !== 'ready' || !view.principal || !Number.isFinite(expires(view)) || expires(view) <= Date.now()) return 'IAM_LOGIN_REQUIRED';
  if (view.gatewayCredential?.state !== 'configured' || view.gatewayCredential.matchesAccount !== true) return 'IAM_GATEWAY_CREDENTIAL_REQUIRED';
  return null;
}
const identity = view => JSON.stringify([view?.principal, view?.gatewayCredential]);

/**
 * A stored selection maps model id → overrides. An empty object is a real
 * value: it means "enabled, but nothing overridden".
 */
function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next = {};
  for (const [id, option] of Object.entries(value)) {
    if (typeof id !== 'string' || id.length === 0) continue;
    next[id] = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
  }
  return next;
}

/** Bound discovery: no redirects, ambient credentials, arbitrary error body or stale results. */
async function discover(connection, signal, fetcher, headers) {
  const response = await fetcher(`${connection.baseURL}/models`, {
    headers: { ...headers, authorization: `Bearer ${connection.key}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw error(gatewayCode(response.status));
  let text = '';
  if (response.body) {
    const decoder = new TextDecoder(); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 262144) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } else text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw error('ENTERPRISE_MODEL_CATALOG_INVALID'); }
  if (!Array.isArray(body?.data) || body.data.length > 500) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
  const seen = new Set();
  const discovered = body.data.map(item => {
    if (typeof item?.id !== 'string' || !/^[\w./:-]{1,200}$/u.test(item.id) || seen.has(item.id)) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
    seen.add(item.id);
    // Standard /models does not promise capacity or modality metadata; use default capacity baselines.
    return { id: item.id, name: item.id, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, input: ['text'], inputModalities: ['text'] };
  });
  return discovered.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }));
}


/** Gateway outages at start-up (network not up yet) heal without a click; credential or catalogue errors need a person. */
const RETRYABLE = new Set(['ENTERPRISE_GATEWAY_UNAVAILABLE', 'ENTERPRISE_GATEWAY_RATE_LIMIT']);
const RETRY_DELAYS = Object.freeze([2000, 5000, 15000, 30000, 60000]);
const safeGet = (host, name) => { try { return host?.[name] ?? host?.get?.(name); } catch { return undefined; } };

/**
 * Own an adapter and the public stream waterfall. Host methods are never
 * replaced; the only Host setting touched is the new-conversation default
 * model, and only when it provably cannot run (see host-default-model.mjs).
 */
export function createManagedModelRuntime({ host, iam, config, createAdapter = createNativeGatewayAdapter, fetch: fetcher = globalThis.fetch,
  requestHeaders = async () => (await host.loader.import('@deepseek-ai/dsh-llm')).attributionHeaders(),
  getHostDefaultModel = () => safeGet(host, 'agentDefaultModel'), retryDelays = RETRY_DELAYS, onChange }) {
  if (typeof host.on !== 'function' || typeof host.llm?.registerAdapter !== 'function') {
    const off = host.on?.('llm/stream', () => (async function* () { yield finish('ENTERPRISE_MODELS_UNAVAILABLE'); })(), { global: true });
    return {
      ready: Promise.resolve(), refresh: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); },
      getView: () => ({ managed: true, state: 'error', error: 'ENTERPRISE_MODELS_UNAVAILABLE', models: [] }),
      dispose: async () => { off?.(); }
    };
  }
  const provider = config.defaultProvider;
  // The host asks for the key on every call; resolving the IAM token at the
  // same point keeps both factors from one session snapshot.
  const resolveIamToken = typeof iam.getAccessToken === 'function' ? () => iam.getAccessToken() : undefined;
  // `modelOptions` doubles as the enabled set: a key means "this person turned
  // this model on", and its value carries the overrides (possibly none). A
  // discovered model without a key is listed but refused for calls.
  let rawModels = []; let modelOptions = {}; let models = []; let catalogState = 'unconfigured'; let catalogError = null;
  // A gateway-scoped revocation sticks until the identity, address or stored key
  // changes. Erasing the stored key needs the joint atomic adapter and stays
  // fail-closed (ADR-19); this mark only stops replay.
  let revokedCredential = false;
  let defaultModelId = null;
  // `selectionSaved` separates "nothing stored yet" (auto-enable the default)
  // from "stored as empty" (this person deliberately enabled no model).
  let selectionSaved = false; let selectionError = null; let selectionWriteError = null;
  const enabled = id => Object.hasOwn(modelOptions, id);
  const enabledInCatalog = id => models.some(item => item.id === id);
  const allowed = (route, model) => route === provider && enabled(model) && enabledInCatalog(model);
  const lifetime = new AbortController();
  let lease = new AbortController(); let version = 0; let last; let lastId; let deadline; let timer; let disposed = false; let backend; let flight;
  let retryAttempt = 0; let retryTimer; let retryAt = null; let syncedAt = null;
  let hostDefault = null; let alignment = null; let alignQueued = false;
  let optionsChain = Promise.resolve();
  let inSample = false;
  let observedVersion = 0;
  // `host.emit` reaches SDK listeners; `onChange` reaches this plugin's own
  // view subscribers, which the catalogue changes without an IAM transition.
  // Only a real change is forwarded: a repeated failure publishes the same
  // view, and each forwarded frame re-enters the observation loop, so an
  // unconditional callback turns one failing gateway into an endless refresh.
  let published = '';
  const publish = () => {
    host.emit?.('llm/adapters-updated');
    const signature = [catalogState, catalogError ?? '', defaultModelId ?? '', hostDefault ?? '',
      String(retryAt ?? ''),
      Object.keys(modelOptions).sort().join(','),
      models.map(model => `${model.id}:${model.enabled ? 1 : 0}`).join(',')].join('|');
    if (signature === published) return;
    published = signature;
    onChange?.();
  };
  const cancelRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; retryAt = null; };
  // A lease aborted for an identity that is still the current one is a
  // cancelled epoch, not a logout. Every use is gated by permit(), so a session
  // that recovers on the same person must get a live signal back: a cancelled
  // lease left in place fails every later discovery at 0 ms, before any socket
  // opens, and reads as an unreachable gateway even though nothing was sent.
  const renewLease = () => { if (lease.signal.aborted) lease = new AbortController(); return lease; };
  // Every path that drops the backend also drops the catalogue state with it,
  // so the account page can never say "ready" while nothing is callable.
  function clearCatalog(state = 'unconfigured', code = null) {
    rawModels = []; models = []; backend = undefined; catalogState = state; catalogError = code;
    retryAt = null; syncedAt = null;
  }
  // A transient failure keeps the last catalogue and its adapter: the panel
  // shows the last known list with a stale marker instead of going blank, and
  // a discovery blip does not kill a call that was already prepared.
  function markFailed(code) {
    catalogState = 'error'; catalogError = code;
  }
  function sample() {
    if (inSample) return null;
    inSample = true;
    try {
      const view = iam.getView();
      const currentId = identity(view);
      const current = `${currentId}:${iam.getModelAccessEpoch?.() ?? ''}`;
      if (last !== current) {
        const idChanged = lastId !== currentId;
        last = current;
        lastId = currentId;
        version++;
        revokedCredential = false;
        if (idChanged) {
          lease.abort(); lease = new AbortController();
          cancelRetry(); retryAttempt = 0; hostDefault = null;
          clearCatalog();
          modelOptions = {}; defaultModelId = null; selectionSaved = false; selectionError = null; selectionWriteError = null;
          publish();
        }
      }
      // A successful same-session IAM refresh changes the deadline, not the
      // gateway configuration. Keep valid prepared calls and update cancellation.
      const nextDeadline = view?.state === 'ready' ? expires(view) : null;
      if (deadline !== nextDeadline) {
        deadline = nextDeadline; clearTimeout(timer);
        const expire = () => { version++; lease.abort(); cancelRetry(); markFailed('IAM_LOGIN_REQUIRED'); publish(); };
        const remaining = deadline - Date.now();
        if (deadline !== null && remaining > 0) {
          timer = setTimeout(expire, Math.min(remaining, 2147483647)); timer.unref?.();
        } else if (deadline !== null) expire();
      }
      return view;
    } finally {
      inSample = false;
    }
  }
  function refusal(request, captured) {
    const denied = permit(sample());
    if (disposed) return 'ENTERPRISE_MODELS_UNAVAILABLE';
    if (denied) return denied;
    if (captured !== undefined && captured !== version) return 'IAM_MODEL_CONTEXT_CHANGED';
    if (!backend) return catalogError ?? 'ENTERPRISE_MODELS_UNAVAILABLE';
    if (revokedCredential) return 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED';
    if (!allowed(request.provider, request.model)) return 'ENTERPRISE_MODEL_NOT_ALLOWED';
    return null;
  }
  // Remember a revocation so no later call spends another round trip on it.
  const record = code => {
    if (code === 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED') revokedCredential = true;
    return code;
  };
  async function* protect(request, dispatch, captured) {
    let code = refusal(request, captured);
    if (code) { yield finish(code); return; }
    const mine = version;
    const signal = AbortSignal.any([lifetime.signal, renewLease().signal, ...(request.signal ? [request.signal] : [])]);
    try {
      for await (const chunk of dispatch({ ...request, signal })) {
        code = refusal(request, mine);
        if (code) { yield finish(code); return; }
        if (chunk.type === 'finish' && chunk.reason?.failure && chunk.reason.kind !== 'aborted') {
          // The model layer turns an HTTP error into a finish chunk, so the code
          // arrives here without ever passing through the thrown-error branch.
          yield finish(record(classifyFailure(chunk.reason.failure))); return;
        }
        yield chunk;
      }
      code = refusal(request, mine);
      if (code) yield finish(code);
    } catch (cause) {
      code = refusal(request, mine);
      if (!code && request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
      yield finish(record(code ?? classifyFailure(cause)));
    }
  }
  /** Adopt the stored selection, or remember that nothing was stored yet. */
  async function loadSelection() {
    if (typeof iam.readModelSelection !== 'function') { selectionSaved = true; return; }
    try {
      const saved = await iam.readModelSelection();
      selectionError = null;
      if (!saved || saved.saved !== true) { selectionSaved = false; modelOptions = {}; defaultModelId = null; return; }
      modelOptions = normalizeSelection(saved.models);
      defaultModelId = typeof saved.defaultModelId === 'string' ? saved.defaultModelId : null;
      selectionSaved = true;
    } catch (cause) {
      // A storage read failure must not look like "nothing saved": that would
      // silently re-enable a default the user may have turned off.
      selectionError = cause?.code ?? 'IAM_CREDENTIALS_UNAVAILABLE';
      selectionSaved = true;
    }
  }

  /** Best effort: an unwritten selection still applies to this session. */
  async function persistSelection() {
    if (typeof iam.saveModelSelection !== 'function') return true;
    try {
      await iam.saveModelSelection({ models: modelOptions, defaultModelId });
      selectionWriteError = null;
      selectionSaved = true;
      return true;
    } catch (cause) {
      selectionWriteError = cause?.code ?? 'IAM_MODEL_SELECTION_UNWRITTEN';
      return false;
    }
  }

  async function refresh() {
    const denied = permit(sample());
    if (disposed || denied) throw error(denied ?? 'ENTERPRISE_MODELS_UNAVAILABLE');
    if (flight?.version === version) return flight.promise;
    let mine = version;
    catalogState = 'loading'; catalogError = null;
    const current = () => { sample(); if (disposed || mine !== version || permit(iam.getView())) throw error('IAM_MODEL_CONTEXT_CHANGED'); };
    const task = Promise.resolve().then(async () => {
      catalogState = 'loading'; catalogError = null;
      const connection = await iam.resolveGatewayConnection(); current();
      // A revoked credential must not reach the gateway again; the mark clears
      // only when the identity, address or stored key changes.
      if (revokedCredential) throw error('ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
      // Discovery stays single-factor on purpose: the contract scopes the dual
      // header to inference calls. If the gateway ever guards /models with
      // X-IAM-Token too, this is the call site that must grow the same merge.
      const headers = await requestHeaders(); current();
      const found = await discover(connection, AbortSignal.any([lifetime.signal, renewLease().signal]), fetcher, headers); current();
      await loadSelection(); current();
      rawModels = found;
      // First run for this person: enable one model so the panel is usable
      // without any configuration. The admin's defaultModel wins when the
      // gateway still offers it, otherwise the first catalogue entry (the
      // catalogue is sorted, so "first" is stable across refreshes).
      if (!selectionSaved && found.length > 0) {
        const chosen = pickDefaultModel(found, config.defaultModel);
        if (chosen) {
          modelOptions = { [chosen]: {} }; defaultModelId = chosen;
          await persistSelection();
          // That write bumps the selection generation. It is our own change, so
          // adopt it; treating it as foreign aborted the first sync after login
          // and left the catalogue in "loading" until another view arrived.
          sample();
          mine = version;
          if (flight?.promise === task) flight = { version: mine, promise: task };
          current();
        }
      } else if (!defaultModelId || !enabled(defaultModelId) || !found.some(m => m.id === defaultModelId)) {
        defaultModelId = found.find(m => enabled(m.id))?.id ?? Object.keys(modelOptions)[0] ?? null;
      }
      models = applyModelOptions(rawModels, modelOptions);
      const resolved = await createAdapter({
        host, config: { ...config, managedModels: { baseURL: connection.baseURL, models } }, resolveIamToken, resolveKey: async () => {
          const before = sample();
          const requestVersion = version;
          if (disposed || permit(before)) throw error('IAM_MODEL_CONTEXT_CHANGED');
          const next = await iam.resolveGatewayConnection();
          const after = sample();
          if (disposed || permit(after) || requestVersion !== version || next.baseURL !== connection.baseURL || next.generation !== connection.generation) throw error('IAM_MODEL_CONTEXT_CHANGED');
          return next.key;
        }
      }); current();
      backend = resolved; catalogState = 'ready'; catalogError = null; retryAttempt = 0; cancelRetry();
      syncedAt = Date.now(); publish();
      await syncHostDefault(); current();
      return { models: models.map(({ id, name, contextWindow, maxTokens, inputModalities }) => ({ id, name, contextWindow, maxTokens, inputModalities })) };
    }).catch(cause => {
      // Our own cancellation is not a gateway outage. Telling the person to
      // check the gateway address after we stopped the request ourselves sends
      // them to the wrong place, and scheduling a retry for it would repeat the
      // same cancellation.
      const code = cause?.name === 'AbortError' ? 'ENTERPRISE_MODEL_SYNC_CANCELLED'
        : Object.hasOwn(MESSAGES, cause?.code ?? '') ? cause.code : 'ENTERPRISE_GATEWAY_UNAVAILABLE';
      if (mine === version && !disposed) {
        markFailed(code);
        // A failure we will never retry must not leave the old adapter reachable:
        // keep the list for display, but make every call fail fast with this code
        // instead of reaching the gateway once per message.
        if (!RETRYABLE.has(code)) backend = undefined;
        // Advertise the retry time before the frame that carries it.
        scheduleRetry(code);
        publish();
      }
      throw error(code);
    }).finally(() => { if (flight?.promise === task) flight = null; });
    flight = { version: mine, promise: task }; return task;
  }

  /** Bounded back-off for transient gateway failures; any context change cancels it. */
  function scheduleRetry(code) {
    if (!RETRYABLE.has(code) || retryAttempt >= retryDelays.length || retryTimer) return;
    const mine = version;
    retryAt = Date.now() + retryDelays[retryAttempt];
    retryTimer = setTimeout(() => {
      retryTimer = undefined; retryAt = null;
      // The countdown ending is itself a visible change: publish it before the
      // next attempt, or the panel keeps a time that has already passed.
      publish();
      // A stale catalogue still has its adapter, and that is exactly when the
      // list matters: keeping the old backend must not cancel its recovery.
      if (disposed || mine !== version || permit(sample())) return;
      void refresh().catch(() => { });
    }, retryDelays[retryAttempt++]);
    retryTimer.unref?.();
  }

  /** Single-flight alignment of DSH's new-conversation default; reruns once if asked again mid-flight. */
  function syncHostDefault() {
    if (alignment) { alignQueued = true; return alignment; }
    const mine = version;
    const task = Promise.resolve().then(() => alignHostDefaultModel({
      service: getHostDefaultModel(), llm: host.llm, provider, target: defaultModelId,
      enterpriseUsable: id => Boolean(backend) && allowed(provider, id),
      isCurrent: () => { sample(); return !disposed && mine === version && !permit(iam.getView()); },
    })).catch(() => HOST_DEFAULT_RESULTS.FAILED).then(result => {
      if (!disposed && mine === version) {
        hostDefault = result;
        // The client catalogue re-reads the default on this event.
        if (result === HOST_DEFAULT_RESULTS.ALIGNED) publish();
      }
      return result;
    }).finally(() => {
      if (alignment === task) alignment = null;
      if (alignQueued && !disposed) { alignQueued = false; void syncHostDefault(); }
    });
    alignment = task;
    return task;
  }
  const offStream = host.on('llm/stream', (request, next) => protect(request, next), { global: true });
  const adapter = new Proxy({}, {
    get(_target, key) {
      if (key === 'providerInfo') return route => ({ id: route, name: '企业模型' });
      if (key === 'providerRetryPolicy') return () => NO_RETRY_POLICY;
      if (key === 'listModels') return async route => {
        if (disposed || route !== provider || permit(sample()) || !backend) return [];
        // Only enabled models are offered. A model the person has not turned on
        // stays in the account page's catalogue, so the picker cannot offer a
        // model whose calls would be refused.
        return models.filter(item => enabled(item.id)).map(({ id, name, inputModalities, input }) => ({
          provider,
          id,
          name: name || id,
          inputModalities: inputModalities ?? input ?? ['text'],
        }));
      };
      if (key === 'stream') return request => protect(request, options => backend.stream(options));
      if (key === 'prepareCall') return async (route, model, signal) => {
        sample(); const mine = version;
        // Even a saved selection after logout reaches an actionable sign-in error.
        if (!permit(iam.getView()) && !allowed(route, model)) throw error('ENTERPRISE_MODEL_NOT_ALLOWED');
        const prepared = backend
          ? (typeof backend.prepareCall === 'function'
            ? await backend.prepareCall(route, model, signal)
            : { model: await backend.resolveModel(route, model, signal), stream: options => backend.stream(options) })
          : null;
        return {
          model: prepared?.model ?? { provider: route, id: model, name: model },
          stream: request => protect(request, options => (prepared ? prepared.stream(options) : backend.stream(options)), mine)
        };
      };
      if (key === 'resolveModel') return async (route, model, signal) => {
        if (!permit(sample()) && !allowed(route, model)) throw error('ENTERPRISE_MODEL_NOT_ALLOWED');
        return backend ? backend.resolveModel(route, model, signal) : { provider: route, id: model, name: model };
      };
      return typeof backend?.[key] === 'function' ? backend[key].bind(backend) : backend?.[key];
    }
  });
  const registration = host.llm.registerAdapter([provider], adapter);
  const ready = refresh().catch(() => { });
  observedVersion = version;
  const observation = (async () => {
    try {
      for await (const _view of iam.watch(lifetime.signal)) {
        if (disposed) return;
        sample();
        const changed = observedVersion !== version;
        observedVersion = version;
        if ((changed || !backend) && !permit(iam.getView())) void refresh().catch(() => { });
      }
    }
    catch { if (!disposed) { lease.abort(); cancelRetry(); markFailed('ENTERPRISE_MODELS_UNAVAILABLE'); publish(); } }
  })();
  /** Apply one enabled-set submission for the person who is signed in right now. */
  async function applyOptions(nextOptions) {
    if (disposed) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    const denied = permit(sample());
    if (denied) throw error(denied);
    // Before the catalogue exists every id would look "not in the catalogue",
    // so a write here would persist an empty selection over a real one.
    if (models.length === 0 || !backend) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    const activeId = identity(iam.getView());
    const stale = () => { sample(); return disposed || identity(iam.getView()) !== activeId || Boolean(permit(iam.getView())); };
    // The submitted map is the enabled set, not just an override list: an
    // empty object enables a model with the catalogue defaults, and dropping
    // a key disables it. Only catalogue models can be enabled.
    const nextMap = normalizeSelection(nextOptions);
    for (const id of Object.keys(nextMap)) if (!rawModels.some(item => item.id === id)) delete nextMap[id];
    modelOptions = nextMap;
    if (!defaultModelId || !enabled(defaultModelId)) defaultModelId = Object.keys(modelOptions)[0] ?? null;
    const persisted = await persistSelection();
    // Signed out or switched account mid-save: the reset already happened;
    // never let this person's options land in the next person's state.
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    models = applyModelOptions(rawModels, modelOptions);
    if (backend && rawModels.length > 0) {
      try {
        const connection = await iam.resolveGatewayConnection();
        if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
        const resolved = await createAdapter({
          host,
          config: { ...config, managedModels: { baseURL: connection.baseURL, models } },
          resolveIamToken,
          resolveKey: async () => {
            const next = await iam.resolveGatewayConnection();
            if (next.baseURL !== connection.baseURL || next.generation !== connection.generation) throw error('IAM_MODEL_CONTEXT_CHANGED');
            return next.key;
          },
        });
        if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
        backend = resolved;
      } catch (cause) {
        if (cause?.code === 'IAM_MODEL_CONTEXT_CHANGED') throw cause;
        /* keep existing backend if rebuild fails */
      }
    }
    publish();
    // Disabling the model DSH uses for new conversations would strand them.
    await syncHostDefault();
    return {
      ok: true, persisted,
      defaultModelId,
      enabled: Object.keys(modelOptions),
      models: models.map(({ id, name, contextWindow, maxTokens, inputModalities }) => ({ id, name, contextWindow, maxTokens, inputModalities }))
    };
  }

  return {
    ready, refresh,
    syncDefaultModel: () => syncHostDefault(),
    updateModelOptions(nextOptions = {}) {
      // Serialise saves: two quick clicks must not interleave their writes.
      const run = optionsChain.then(() => applyOptions(nextOptions));
      optionsChain = run.catch(() => { });
      return run;
    },
    getModelOptions: () => ({ ...modelOptions }),
    getView: () => {
      if (!inSample && !disposed) sample();
      return {
        managed: true, configured: true,
        state: catalogState, error: catalogError,
        // Freshness: `stale` means the list is the last known catalogue and the
        // gateway could not be reached since; `retryAt` is the next automatic
        // attempt (absent when the failure is not retryable).
        stale: catalogState === 'error' && models.length > 0,
        retryAt, syncedAt,
        defaultModelId,
        // Fixed code describing the last alignment of DSH's new-conversation default.
        hostDefaultModel: hostDefault,
        enabled: Object.keys(modelOptions),
        selectionError: selectionError ?? selectionWriteError,
        models: models.map(({ id, name, contextWindow, maxTokens, inputModalities, reasoningEfforts, reasoning }) => ({
          id,
          name,
          contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          inputModalities: inputModalities ?? ['text'],
          reasoningEfforts: reasoningEfforts ?? null,
          reasoning: Boolean(reasoning),
          // A listed model is not necessarily callable; only enabled ones are.
          enabled: enabled(id),
          isDefault: defaultModelId === id,
        })),
        modelOptions: { ...modelOptions }
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); cancelRetry(); lifetime.abort(); lease.abort(); offStream?.(); registration?.();
      await observation; rawModels = []; models = []; backend = undefined;
    }
  };
}

/** Host-supplied SDK only: an unavailable public import closes this capability. */
export async function createNativeGatewayAdapter({ host, config, resolveKey, resolveIamToken }) {
  const load = specifier => host.loader.import(specifier);
  const [{ PiAiAdapter }, { openAICompletionsApi }] = await Promise.all([
    load('@deepseek-ai/dsh-llm-pi-ai'), load('@earendil-works/pi-ai/api/openai-completions.lazy'),
  ]);
  const { baseURL, models } = config.managedModels; const provider = config.defaultProvider;
  const protocol = openAICompletionsApi();
  const catalog = models.map(({ id, name, contextWindow, maxTokens, input, inputModalities, reasoning, reasoningEfforts, thinkingLevelMap, compat }) => {
    const resolvedThinkingMap = thinkingLevelMap ?? buildThinkingLevelMap(reasoningEfforts);
    const bounds = getReasoningEffortBounds(reasoningEfforts ?? resolvedThinkingMap);
    const defaultEffort = bounds.enabled && bounds.levels.length > 0 ? bounds.levels[0] : undefined;
    const isReasoning = Boolean(reasoning || resolvedThinkingMap);
    return {
      id, name: name || id, contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      provider, api: 'openai-completions', baseUrl: baseURL,
      reasoning: isReasoning,
      ...(resolvedThinkingMap ? { thinkingLevelMap: resolvedThinkingMap } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      input: inputModalities ?? input ?? ['text'],
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        ...(compat || {}),
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
  const configuredMaxTokens = new Map();
  for (const m of models) {
    if (m.hasCustomMaxTokens && typeof m.maxTokens === 'number' && m.maxTokens > 0) {
      configuredMaxTokens.set(m.id, m.maxTokens);
    }
  }
  // pi-ai reads `options.headers` synchronously while building a request, so an
  // async token lookup inside `stream` would arrive after the headers are
  // consumed. The host asks for the key on every call, which gives exactly one
  // resolution per request; the token resolved there is reused by the headers
  // below. A parallel call may therefore see the newer token, which is still
  // valid: rotation never invalidates the previous token while it is unexpired.
  let iamToken = null;
  const resolveApiKey = async (...args) => {
    const key = await resolveKey(...args);
    if (typeof resolveIamToken === 'function') iamToken = await resolveIamToken();
    return key;
  };
  const withIamHeaders = (options) => {
    if (typeof iamToken !== 'string' || iamToken.length === 0) return options;
    return { ...options, headers: { ...(options?.headers ?? {}), 'X-IAM-Token': iamToken, 'X-Consumer-Type': 'personal' } };
  };
  const piProvider = {
    id: provider, name: '企业模型', baseUrl: baseURL,
    auth: { apiKey: { name: '企业个人访问凭证', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'enterprise' }) } },
    getModels: () => catalog,
    stream: (model, context, options) => protocol.stream(model, context, withIamHeaders(options)),
    streamSimple: (model, context, options) => protocol.streamSimple(model, context, withIamHeaders(options))
  };
  // The gateway keeps the socket alive with `: ping` comments every 15s, but the
  // host watchdog counts parsed events and a comment never becomes one: only the
  // first body byte produces `start`. A 60s bound therefore aborted a slow first
  // token while the link was healthy. Match the host default instead.
  const profiles = new Map([[provider, {
    provider, displayName: '企业模型', piProvider,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 10 * 1024 * 1024, requestImagePixelBudget: 4096 * 4096, requestImageMaxBytes: 10 * 1024 * 1024,
    modelErrors: new Map(), configuredMaxTokens,
    retryPolicy: NO_RETRY_POLICY
  }]]);
  // This provider accepts only the per-request IAM-resolved key, never ambient OAuth or env credentials.
  return new PiAiAdapter({
    profiles: () => profiles, resolveApiKey,
    auth: {
      credentials: {
        read: async () => undefined,
        get: async () => undefined,
        list: async () => [],
        write: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); },
        set: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); },
        modify: async () => undefined,
        delete: async () => { },
      },
      authContext: { env: async () => undefined, fileExists: async () => false },
    }
  });
}
