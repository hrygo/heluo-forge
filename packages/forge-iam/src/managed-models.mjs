import { IamError } from './errors.mjs';

const MESSAGES = Object.freeze({
  IAM_GATEWAY_URL_INVALID: '请输入有效的 HTTPS 网关地址。本机测试可使用已获允许的 HTTP 地址。',
  ENTERPRISE_MODEL_CATALOG_INVALID: '网关返回的模型列表无法识别，请联系管理员检查网关。',
  IAM_LOGIN_REQUIRED: '企业账号已退出或登录已过期，请重新登录后再使用模型。',
  IAM_GATEWAY_CREDENTIAL_REQUIRED: '请在“设置 → 企业账号”保存当前账号的 UAG 个人凭证。',
  ENTERPRISE_MODEL_NOT_ALLOWED: '此模型未由企业开放，请选择企业提供的模型。',
  ENTERPRISE_MODELS_UNAVAILABLE: '企业模型暂不可用，请联系管理员检查配置。',
  IAM_MODEL_CONTEXT_CHANGED: '账号或凭证已变化，请重新选择模型后再试。',
  ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED: '网关未接受个人凭证，请在“设置 → 企业账号”检查或更换凭证。',
  ENTERPRISE_GATEWAY_FORBIDDEN: '当前账号没有此模型的使用权限，请联系管理员。',
  ENTERPRISE_GATEWAY_RATE_LIMIT: '请求过于频繁，请稍后重试。',
  ENTERPRISE_GATEWAY_UNAVAILABLE: '暂时无法连接企业模型，请稍后重试。',
});
const error = code => new IamError(code, MESSAGES[code]);
const finish = code => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: MESSAGES[code] } } });

/** Canonical OpenAI-compatible root, validated before storing or sending credentials. */
export function normalizeGatewayBaseURL(input, allowInsecureHttp = false) {
  let url;
  try { url = new URL(input); } catch { throw error('IAM_GATEWAY_URL_INVALID'); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureHttp
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw error('IAM_GATEWAY_URL_INVALID');
  const pathname = url.pathname.replace(/\/+$/u, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.href.replace(/\/$/u, '');
}

export function validateManagedModels(input, allowInsecureHttp = false) {
  if (input === undefined || input === null) return { value: null };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'baseURL')) throw error('IAM_GATEWAY_URL_INVALID');
    return { value: { baseURL: normalizeGatewayBaseURL(input.baseURL, allowInsecureHttp) } };
  } catch { return { issues: [{ path: ['managedModels'], message: 'managedModels accepts a safe baseURL only; models are discovered from /v1/models' }] }; }
}
const expires = view => typeof view?.accessExpiresAt === 'number' ? view.accessExpiresAt : Date.parse(view?.accessExpiresAt);
function permit(view) {
  if (view?.state !== 'ready' || !view.principal || !Number.isFinite(expires(view)) || expires(view) <= Date.now()) return 'IAM_LOGIN_REQUIRED';
  if (view.gatewayCredential?.state !== 'configured' || view.gatewayCredential.matchesAccount !== true) return 'IAM_GATEWAY_CREDENTIAL_REQUIRED';
  return null;
}
const identity = view => JSON.stringify([view?.state, view?.principal, view?.gatewayCredential]);

/** Bound discovery: no redirects, ambient credentials, arbitrary error body or stale results. */
async function discover(connection, signal, fetcher, headers) {
  const response = await fetcher(`${connection.baseURL}/models`, {
    headers: { ...headers, authorization: `Bearer ${connection.key}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw error(response.status === 401 ? 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'
    : response.status === 403 ? 'ENTERPRISE_GATEWAY_FORBIDDEN' : 'ENTERPRISE_GATEWAY_UNAVAILABLE');
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
  return body.data.map(item => {
    if (typeof item?.id !== 'string' || !/^[\w./:-]{1,200}$/u.test(item.id) || seen.has(item.id)) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
    seen.add(item.id);
    // Standard /models does not promise capacity or modality metadata.
    return { id: item.id, name: item.id, contextWindow: 32768, maxTokens: 4096 };
  });
}

/** Own an adapter and the public stream waterfall; never replace Host methods or settings. */
export function createManagedModelRuntime({ host, iam, config, createAdapter = createNativeGatewayAdapter, fetch: fetcher = globalThis.fetch,
  requestHeaders = async () => (await host.loader.import('@deepseek-ai/dsh-llm')).attributionHeaders() }) {
  if (typeof host.on !== 'function' || typeof host.llm?.registerAdapter !== 'function') {
    const off = host.on?.('llm/stream', () => (async function* () { yield finish('ENTERPRISE_MODELS_UNAVAILABLE'); })(), { global: true });
    return { ready: Promise.resolve(), refresh: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); },
      getView: () => ({ managed: true, state: 'error', error: 'ENTERPRISE_MODELS_UNAVAILABLE', models: [] }),
      dispose: async () => { off?.(); } };
  }
  const provider = config.defaultProvider;
  let models = []; let catalogState = 'unconfigured'; let catalogError = null;
  const allowed = (route, model) => route === provider && models.some(item => item.id === model);
  const lifetime = new AbortController();
  let lease = new AbortController(); let version = 0; let last; let deadline; let timer; let disposed = false; let backend; let flight;
  const publish = () => { host.emit?.('llm/adapters-updated'); };
  function sample() {
    const view = iam.getView(); const current = `${identity(view)}:${iam.getModelAccessEpoch?.() ?? ''}`;
    if (last !== current) {
      last = current; version++; lease.abort(); lease = new AbortController();
      models = []; backend = undefined; catalogState = 'unconfigured'; catalogError = null;
      publish();
    }
    // A successful same-session IAM refresh changes the deadline, not the
    // gateway configuration. Keep valid prepared calls and update cancellation.
    const nextDeadline = view?.state === 'ready' ? expires(view) : null;
    if (deadline !== nextDeadline) {
      deadline = nextDeadline; clearTimeout(timer);
      const expire = () => { version++; lease.abort(); models = []; backend = undefined; publish(); };
      const remaining = deadline - Date.now();
      if (deadline !== null && remaining > 0) {
        timer = setTimeout(expire, Math.min(remaining, 2147483647)); timer.unref?.();
      } else if (deadline !== null) expire();
    }
    return view;
  }
  function refusal(request, captured) {
    const denied = permit(sample());
    if (disposed) return 'ENTERPRISE_MODELS_UNAVAILABLE';
    if (denied) return denied;
    if (captured !== undefined && captured !== version) return 'IAM_MODEL_CONTEXT_CHANGED';
    if (!backend) return catalogError ?? 'ENTERPRISE_MODELS_UNAVAILABLE';
    if (!allowed(request.provider, request.model)) return 'ENTERPRISE_MODEL_NOT_ALLOWED';
    return null;
  }
  async function* protect(request, dispatch, captured) {
    let code = refusal(request, captured);
    if (code) { yield finish(code); return; }
    const mine = version;
    const signal = AbortSignal.any([lifetime.signal, lease.signal, ...(request.signal ? [request.signal] : [])]);
    try {
      for await (const chunk of dispatch({ ...request, signal })) {
        code = refusal(request, mine);
        if (code) { yield finish(code); return; }
        if (chunk.type === 'finish' && chunk.reason?.failure && chunk.reason.kind !== 'aborted') {
          const code = chunk.reason.failure.code;
          yield finish(code === 'AUTH' ? 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'
            : code === 'PERMISSION' || code === 'FORBIDDEN' ? 'ENTERPRISE_GATEWAY_FORBIDDEN'
            : code === 'RATE_LIMIT' ? 'ENTERPRISE_GATEWAY_RATE_LIMIT'
            : Object.hasOwn(MESSAGES, code ?? '') ? code : 'ENTERPRISE_GATEWAY_UNAVAILABLE'); return;
        }
        yield chunk;
      }
      code = refusal(request, mine);
      if (code) yield finish(code);
    } catch (cause) {
      code = refusal(request, mine);
      if (!code && request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
      yield finish(code ?? (Object.hasOwn(MESSAGES, cause?.code ?? '') ? cause.code
        : cause?.code === 'AUTH' ? 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'
        : cause?.code === 'PERMISSION' || cause?.status === 403 ? 'ENTERPRISE_GATEWAY_FORBIDDEN' : 'ENTERPRISE_GATEWAY_UNAVAILABLE'));
    }
  }
  async function refresh() {
    const denied = permit(sample());
    if (disposed || denied) throw error(denied ?? 'ENTERPRISE_MODELS_UNAVAILABLE');
    if (flight?.version === version) return flight.promise;
    const mine = version;
    const current = () => { sample(); if (disposed || mine !== version || permit(iam.getView())) throw error('IAM_MODEL_CONTEXT_CHANGED'); };
    const task = Promise.resolve().then(async () => {
      catalogState = 'loading'; catalogError = null;
      const connection = await iam.resolveGatewayConnection(); current();
      const headers = await requestHeaders(); current();
      const found = await discover(connection, AbortSignal.any([lifetime.signal, lease.signal]), fetcher, headers); current();
      const resolved = await createAdapter({ host, config: { ...config, managedModels: { baseURL: connection.baseURL, models: found } }, resolveKey: async () => {
        current();
        const next = await iam.resolveGatewayConnection(); current();
        if (next.baseURL !== connection.baseURL || next.generation !== connection.generation) throw error('IAM_MODEL_CONTEXT_CHANGED');
        return next.key;
      } }); current();
      models = found; backend = resolved; catalogState = 'ready'; catalogError = null; publish();
      return { models: found.map(({ id, name }) => ({ id, name })) };
    }).catch(cause => {
      if (mine === version && !disposed) {
        models = []; backend = undefined; catalogState = 'error';
        catalogError = Object.hasOwn(MESSAGES, cause?.code ?? '') ? cause.code : 'ENTERPRISE_GATEWAY_UNAVAILABLE'; publish();
      }
      throw error(Object.hasOwn(MESSAGES, cause?.code ?? '') ? cause.code : 'ENTERPRISE_GATEWAY_UNAVAILABLE');
    }).finally(() => { if (flight?.promise === task) flight = null; });
    flight = { version: mine, promise: task }; return task;
  }
  const offStream = host.on('llm/stream', (request, next) => protect(request, next), { global: true });
  const adapter = new Proxy({}, { get(_target, key) {
    if (key === 'providerInfo') return route => ({ id: route, name: '企业模型' });
    if (key === 'providerRetryPolicy') return () => ({ mode: 'normal', maxRetries: 0 });
    if (key === 'listModels') return async route => {
      if (disposed || route !== provider || permit(sample()) || !backend) return [];
      return models.map(({ id, name }) => ({ provider, id, name, inputModalities: ['text'] }));
    };
    if (key === 'stream') return request => protect(request, options => backend.stream(options));
    if (key === 'prepareCall') return async (route, model, signal) => {
      sample(); const mine = version;
      // Even a saved selection after logout reaches an actionable sign-in error.
      if (!permit(iam.getView()) && !allowed(route, model)) throw error('ENTERPRISE_MODEL_NOT_ALLOWED');
      const prepared = backend ? await backend.prepareCall(route, model, signal) : null;
      return { model: prepared?.model ?? { provider: route, id: model, name: model },
        stream: request => protect(request, options => prepared.stream(options), mine) };
    };
    if (key === 'resolveModel') return async (route, model, signal) => {
      if (!permit(sample()) && !allowed(route, model)) throw error('ENTERPRISE_MODEL_NOT_ALLOWED');
      return backend ? backend.resolveModel(route, model, signal) : { provider: route, id: model, name: model };
    };
    return typeof backend?.[key] === 'function' ? backend[key].bind(backend) : backend?.[key];
  } });
  const registration = host.llm.registerAdapter([provider], adapter);
  const ready = refresh().catch(() => {});
  const observation = (async () => {
    try { for await (const _view of iam.watch(lifetime.signal)) {
      if (disposed) return;
      const before = version; sample();
      if ((before !== version || !backend) && !permit(iam.getView())) void refresh().catch(() => {});
    } }
    catch { if (!disposed) { lease.abort(); models = []; backend = undefined; publish(); } }
  })();
  return { ready, refresh, getView: () => ({ managed: true, configured: true,
    state: catalogState, error: catalogError, models: models.map(({ id, name }) => ({ id, name })) }),
    async dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); lifetime.abort(); lease.abort(); offStream?.(); registration?.();
      await observation; models = []; backend = undefined;
    } };
}

/** Host-supplied SDK only: an unavailable public import closes this capability. */
export async function createNativeGatewayAdapter({ host, config, resolveKey }) {
  const load = specifier => host.loader.import(specifier);
  const [{ PiAiAdapter }, { openAICompletionsApi }] = await Promise.all([
    load('@deepseek-ai/dsh-llm-pi-ai'), load('@earendil-works/pi-ai/api/openai-completions.lazy'),
  ]);
  const { baseURL, models } = config.managedModels; const provider = config.defaultProvider;
  const protocol = openAICompletionsApi();
  const catalog = models.map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens,
    provider, api: 'openai-completions', baseUrl: baseURL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const piProvider = { id: provider, name: '企业模型', baseUrl: baseURL,
    auth: { apiKey: { name: '企业个人凭证', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'enterprise' }) } },
    getModels: () => catalog, stream: (...args) => protocol.stream(...args), streamSimple: (...args) => protocol.streamSimple(...args) };
  const profiles = new Map([[provider, { provider, displayName: '企业模型', piProvider,
    streamIdleTimeoutMs: 60000, maxRequestImageBytes: 1, requestImagePixelBudget: 1, requestImageMaxBytes: 1,
    modelErrors: new Map(), configuredMaxTokens: new Map(models.map(m => [m.id, m.maxTokens])),
    retryPolicy: { mode: 'normal', maxRetries: 0 } }]]);
  // This provider accepts only the per-request IAM-resolved key, never ambient OAuth or env credentials.
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: resolveKey,
    auth: { credentials: { get: async () => undefined, list: async () => [], set: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); }, delete: async () => {} },
      authContext: { env: () => undefined } } });
}
