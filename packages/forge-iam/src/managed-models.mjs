import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { IamError, IAM_GATEWAY_URL_INVALID_MESSAGE } from './errors.mjs';
import { failureCode, gatewayCode, USER_CODE_BY_INTERNAL } from './gateway-failure.mjs';
import { alignHostDefaultModel, HOST_DEFAULT_RESULTS } from './host-default-model.mjs';
import { adapterInitializationDetailCode } from './model-failure-log.mjs';
import { modelFetchOptions, modelPreconnectFault, modelTransportDiagnostic, retryAfterHint, trackModelAttempt } from './model-transport.mjs';
import {
  NO_RETRY_POLICY,
  THINKING_LEVELS,
  REASONING_EFFORT_LEVELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  isModelId,
  MAX_MANUAL_MODELS,
  MAX_MODEL_ID_LENGTH,
  mergeAvailableModels,
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
  isModelId,
  MAX_MANUAL_MODELS,
  MAX_MODEL_ID_LENGTH,
  mergeAvailableModels,
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
  IAM_GATEWAY_URL_INVALID: IAM_GATEWAY_URL_INVALID_MESSAGE,
  ENTERPRISE_MODEL_CATALOG_INVALID: '网关返回的模型列表无法识别，请联系管理员检查网关。',
  IAM_LOGIN_REQUIRED: '企业账号已退出或登录已过期，请重新登录后再使用模型。',
  IAM_GATEWAY_CREDENTIAL_REQUIRED: '请在“设置 → 企业账号”保存当前账号的个人访问凭证。',
  ENTERPRISE_MODEL_NOT_ALLOWED: '此模型未由企业开放，请选择企业提供的模型。',
  ENTERPRISE_MODELS_UNAVAILABLE: '企业模型暂不可用，请联系管理员检查配置。',
  ENTERPRISE_MODEL_SYNC_CANCELLED: '模型目录同步被中断，请重试。',
  IAM_MODEL_CONTEXT_CHANGED: '账号或凭证已变化，请重新选择模型后再试。',
  IAM_GATEWAY_BINDING_CHANGED: '网关地址或账号已变化，请重新选择模型后再试。',
  // The IAM service and the credential store fail before a request is sent;
  // they answer with what the person can do, not with an internal module name.
  ENTERPRISE_IAM_UNAVAILABLE: '企业认证服务暂不可达，请稍后重试。',
  ENTERPRISE_IAM_RENEWAL_UNCONFIRMED: '企业账号续期未确认，请检查登录状态后重试。',
  ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE: '凭据安全存储暂不可用，请检查系统密钥环或联系管理员。',
  ENTERPRISE_CREDENTIAL_INVALID: '提交的扩展令牌或扩展声明不合规，请检查后重试。',
  ENTERPRISE_CREDENTIAL_OWNER_MISMATCH: '该令牌属于另一个企业账号，请重新登录后再操作。',
  ENTERPRISE_CREDENTIAL_PENDING: '上一次保存尚未完成，请稍后重试。',
  ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED: '网关未接受个人访问凭证，请在“设置 → 企业账号”检查或更换凭证。',
  ENTERPRISE_GATEWAY_FORBIDDEN: '当前账号没有此模型的使用权限，请联系管理员。',
  ENTERPRISE_GATEWAY_RATE_LIMIT: '请求过于频繁，请稍后重试。',
  // The model layer reports an exhausted quota (429 quota / model cooldown) as
  // its own code; without a mapping it fell through to "cannot connect".
  ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED: '所选模型的额度已用尽，请更换模型或联系管理员。',
  ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED: '企业身份令牌已失效，请重新登录后再试。',
  ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED: '个人访问凭证已被回收，请联系管理员重新申领。',
  ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED: '个人访问凭证已被暂停，请联系管理员。',
  // issue #199 item 5: a stored value that cannot travel as an HTTP header gets
  // one deterministic local code instead of an undici transport error whose
  // message could carry the raw value. Never a format or prefix check: the
  // credential stays opaque and the gateway owns validity.
  ENTERPRISE_GATEWAY_CREDENTIAL_UNSENDABLE: '保存的网关凭证无法用于发送请求，请重新粘贴网关提供的凭证。',
  ENTERPRISE_GATEWAY_IDENTITY_MISMATCH: '登录身份与凭证绑定账号不一致，请重新登录后重试。',
  ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED: '当前客户端的标识未被企业网关识别，请升级客户端或联系管理员核准。',
  ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED: '所选模型的预算已用尽，请联系管理员或更换模型。',
  ENTERPRISE_GATEWAY_UNAVAILABLE: '暂时无法连接企业模型，请稍后重试。',
  ENTERPRISE_GATEWAY_REQUEST_REJECTED: '网关拒绝了本次请求，请检查网关地址或所选模型是否支持当前参数。',
  ENTERPRISE_REQUEST_UNSUPPORTED: '这次请求的内容无法发送：所选模型可能不支持图片，或图片附件已不可用。之后的请求会自动省略图片，也可以更换支持图片的模型。',
  // Neither rejected nor provably unreachable: say so instead of guessing.
  ENTERPRISE_GATEWAY_CALL_FAILED: '本次请求未完成，请重试；持续失败请联系管理员。',
  ENTERPRISE_MODEL_REASONING_UNSUPPORTED: '所选模型的推理档位不受支持，请重新选择思考级别。',
  IAM_MANUAL_MODEL_INVALID: '模型 ID 不能为空且长度不得超过 200 个字符。',
  IAM_MANUAL_MODEL_LIMIT: '手动添加的模型数量已达上限（最多 100 个）。',
  IAM_MANUAL_MODEL_NOT_FOUND: '未找到指定的手动模型。',
  IAM_MANUAL_MODEL_CONFLICT: '该模型已在当前目录中，请直接启用，无需重复添加。',
});
const error = code => new IamError(code, MESSAGES[code]);
const finish = (code, message = MESSAGES[code]) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } });
const NOT_STREAMABLE_MESSAGE = '该模型不支持流式调用，无法在对话中使用。';

const expires = view => typeof view?.accessExpiresAt === 'number' ? view.accessExpiresAt : Date.parse(view?.accessExpiresAt);
function permit(view) {
  if (view?.state === 'error' && view.error === 'IAM_RENEWAL_UNCONFIRMED') return 'ENTERPRISE_IAM_RENEWAL_UNCONFIRMED';
  if (view?.state !== 'ready' || !view.principal || !Number.isFinite(expires(view)) || expires(view) <= Date.now()) return 'IAM_LOGIN_REQUIRED';
  if (view.gatewayCredential?.state !== 'configured' || view.gatewayCredential.matchesAccount !== true) return 'IAM_GATEWAY_CREDENTIAL_REQUIRED';
  return null;
}
const identity = view => JSON.stringify([view?.principal, view?.gatewayCredential]);
// Who may still stream. A re-saved Key at the same address moves `identity`
// (the catalogue must be rebuilt) but not this: an answer already in progress
// survives it. Losing the account or the credential does abort the answer.
const authorizationId = (view, epoch) => JSON.stringify([view?.principal, view?.gatewayCredential?.state ?? null, epoch]);
// The binding the adapter was built for. The key generation is only the write
// version of the stored credential: re-saving the same key at the same address
// must not count as a context change, while an address or owner change must.
const sameBinding = (bound, next) => bound?.baseURL === next?.baseURL
  && (bound?.subject ?? null) === (next?.subject ?? null);
const BINDING_RECOVERY_MS = 5000;
const MODEL_RENEWAL_WAIT_MS = 5000;
const MODEL_RENEWAL_RECHECK_MS = 4000;
const STREAM_ROTATION_CHECK_LEADS_MS = [1000, 100];
const PRECONNECT_RETRY_DELAY_MS = 200;
const PRECONNECT_RETRY_JITTER_MS = 200;
const REBUILD_ATTEMPT_LIMIT = 3;

/**
 * A stored credential stays opaque (issue #199): no format, charset or length
 * rule at save time, and the gateway owns validity. The one local property the
 * transport does impose is header safety. The transport is fetch/Headers, whose
 * value must be a ByteString and rejects CR/LF, NUL, DEL, other control
 * characters and anything above Latin-1, while TAB and Latin-1 (measured:
 * `clé`, embedded TAB) pass — so the guard mirrors exactly that rule instead
 * of inventing a stricter one. Letting an invalid value reach the transport
 * would surface its error message, which can carry the raw value; intercept it
 * once here with a deterministic, echo-free code.
 */
export const assertSendableCredential = key => {
  if (typeof key === 'string' && /[^\t\x20-\x7e\x80-\xff]/.test(key)) {
    throw error('ENTERPRISE_GATEWAY_CREDENTIAL_UNSENDABLE');
  }
  return key;
};

/**
 * A stored selection maps model id → overrides. An empty object is a real
 * value: it means "enabled, but nothing overridden".
 */
function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next = {};
  for (const [id, option] of Object.entries(value)) {
    if (!isModelId(id)) continue;
    next[id] = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
  }
  return next;
}

const CATALOG_ENTRY_LIMIT = 500;

/**
 * Declared catalogue metadata (issue #202 item 3). The contract fixes the
 * semantics — modality, streaming, context length, max output, compliance
 * level, deployment region — but not the exact JSON field names, so this reads
 * a documented alias set and treats anything else as "not declared". An
 * unusable declaration falls back to the baseline default instead of failing
 * the whole catalogue: metadata is optional, while a missing or duplicate id
 * still fails it (fail closed stays where it belongs).
 */
const CONTEXT_KEYS = Object.freeze(['context_length', 'contextLength', 'context_window', 'contextWindow', 'max_context_tokens', 'maxContextTokens']);
const MAX_OUTPUT_KEYS = Object.freeze(['max_output_tokens', 'maxOutputTokens', 'max_completion_tokens', 'maxCompletionTokens', 'max_tokens', 'maxTokens']);
const MODALITY_KEYS = Object.freeze(['input_modalities', 'inputModalities', 'modalities', 'input']);
const STREAMING_KEYS = Object.freeze(['streaming', 'stream', 'supports_streaming', 'supportsStreaming']);
const COMPLIANCE_LEVEL_KEYS = Object.freeze(['level', 'compliance_level', 'complianceLevel', 'tier']);
const COMPLIANCE_REGION_KEYS = Object.freeze(['region', 'deployment_region', 'deploymentRegion', 'deploy_region', 'deployRegion']);
/** A capacity beyond this is a parse accident, not a real window; treat as undeclared. */
const CAPACITY_CEILING = 100_000_000;
const MODALITIES = Object.freeze(['text', 'image']);
const COMPLIANCE_TEXT_LIMIT = 64;

const pick = (source, keys) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) return source[key];
  }
  return undefined;
};

/**
 * Like `pick`, but skips aliases whose value is unusable, so `{streaming: null,
 * supportsStreaming: false}` still reads as `false` instead of hiding behind the
 * null. When usable aliases disagree the conservative value wins (see
 * `declaredStreaming`).
 */
const pickValid = (source, keys, accept) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (accept(value)) return value;
  }
  return undefined;
};

/** Positive integer capacity, or undefined when the declaration is unusable. */
const usableCapacity = value => typeof value === 'number' && Number.isSafeInteger(value)
  && value > 0 && value <= CAPACITY_CEILING;
const declaredCapacity = (source, keys) => pickValid(source, keys, usableCapacity);

/** Declared input modalities, filtered to the two the runtime understands. */
const declaredModalities = capabilities => {
  const raw = pickValid(capabilities, MODALITY_KEYS, value => Array.isArray(value) && value.length > 0);
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  // A declaration that mixes a known mode with an unknown one says nothing
  // reliable about the model: keeping the known subset would advertise, for
  // example, "image only" for a model that also takes text. The whole
  // declaration falls back to the text baseline instead.
  if (raw.some(value => !MODALITIES.includes(value))) return undefined;
  return [...new Set(raw)];
};

const declaredStreaming = capabilities => {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return undefined;
  const declared = STREAMING_KEYS.filter(key => Object.hasOwn(capabilities, key))
    .map(key => capabilities[key]).filter(value => typeof value === 'boolean');
  if (declared.length === 0) return undefined;
  // Aliases that disagree describe nothing reliable; "cannot stream" is the
  // conservative reading because it only narrows what the caller may offer.
  return declared.every(value => value === declared[0]) ? declared[0] : false;
};

/** Display-only compliance metadata; never an authorization input. */
function declaredCompliance(compliance) {
  if (!compliance || typeof compliance !== 'object' || Array.isArray(compliance)) return undefined;
  const usable = raw => {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    return value.length > 0 && value.length <= COMPLIANCE_TEXT_LIMIT && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
  };
  const read = keys => usable(pickValid(compliance, keys, raw => usable(raw) !== undefined));
  const level = read(COMPLIANCE_LEVEL_KEYS);
  const region = read(COMPLIANCE_REGION_KEYS);
  return level === undefined && region === undefined ? undefined : { ...(level === undefined ? {} : { level }), ...(region === undefined ? {} : { region }) };
}

/**
 * Turn one gateway catalogue entry into the runtime model shape. Declared
 * values win; the 200K/64K/text baselines only fill what the gateway left out.
 */
function catalogEntry(item) {
  const capabilities = item?.capabilities;
  const contextWindow = declaredCapacity(capabilities, CONTEXT_KEYS);
  const maxTokens = declaredCapacity(capabilities, MAX_OUTPUT_KEYS);
  const modalities = declaredModalities(capabilities);
  const streaming = declaredStreaming(capabilities);
  const compliance = declaredCompliance(item?.compliance);
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id,
    contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    input: modalities ?? ['text'],
    inputModalities: modalities ?? ['text'],
    ...(streaming === undefined ? {} : { streaming }),
    ...(compliance === undefined ? {} : { compliance }),
  };
}

/** Bound discovery: no redirects, ambient credentials, arbitrary error body or stale results. */
async function discover(connection, signal, fetcher, headers) {
  const response = await fetcher(`${connection.baseURL}/models`, {
    headers: { ...headers, authorization: `Bearer ${connection.key}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) {
    const failure = error(gatewayCode(response.status));
    const retryAfterMs = retryAfterHint(response.headers?.get?.('retry-after'));
    if (retryAfterMs !== undefined) failure.details = { ...failure.details, retryAfterMs };
    throw failure;
  }
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
  if (!Array.isArray(body?.data)) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
  // The cap is a defensive bound, not a validity rule: extra entries are
  // dropped and reported, while a malformed or duplicate entry still fails the
  // whole catalogue so a truncated-but-broken list never replaces a good one.
  const seen = new Set();
  const discovered = body.data.map(item => {
    if (!isModelId(item?.id) || seen.has(item.id)) throw error('ENTERPRISE_MODEL_CATALOG_INVALID');
    seen.add(item.id);
    // Declared capabilities win (issue #202); the 200K/64K/text baselines only
    // fill what the gateway did not declare.
    return catalogEntry(item);
  });
  // Sort before trimming: the retained subset must not depend on the order the
  // gateway happened to answer in, or an already enabled model could vanish
  // between refreshes once the catalogue exceeds the defensive bound.
  const sorted = discovered.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }));
  const truncated = Math.max(0, sorted.length - CATALOG_ENTRY_LIMIT);
  return { models: truncated > 0 ? sorted.slice(0, CATALOG_ENTRY_LIMIT) : sorted, truncated };
}


/** Gateway outages at start-up (network not up yet) heal without a click; credential or catalogue errors need a person. */
const RETRYABLE = new Set(['ENTERPRISE_GATEWAY_UNAVAILABLE', 'ENTERPRISE_GATEWAY_RATE_LIMIT']);
// Three attempts in total (initial + two retries) for the catalogue, which has
// no side effects and no billing; `Retry-After` replaces the local delay while
// it fits under the ceiling below.
const RETRY_DELAYS = Object.freeze([2000, 5000]);
const MAX_CATALOG_RETRY_AFTER_MS = 60_000;
const safeGet = (host, name) => { try { return host?.[name] ?? host?.get?.(name); } catch { return undefined; } };

/**
 * Own an adapter and the public stream waterfall. Host methods are never
 * replaced; the new-conversation default is observed without writing any Host
 * setting (see host-default-model.mjs).
 */
export function createManagedModelRuntime({ host, iam, config, createAdapter = createNativeGatewayAdapter, resolveAttachments, prepareHeaders, fetch: fetcher = globalThis.fetch, logFailure, diagnoseFailure,
  requestHeaders = async () => (await host.loader.import('@deepseek-ai/dsh-llm')).attributionHeaders(),
  getHostDefaultModel = () => safeGet(host, 'agentDefaultModel'), retryDelays = RETRY_DELAYS, onChange }) {
  if (typeof host.on !== 'function' || typeof host.llm?.registerAdapter !== 'function') {
    const off = host.on?.('llm/stream', request => (async function* () {
      const code = 'ENTERPRISE_MODELS_UNAVAILABLE';
      try { diagnoseFailure?.({ detailCode: code, code, message: MESSAGES[code], stage: 'local', request }); } catch { /* optional diagnostic */ }
      yield finish(code);
    })(), { global: true });
    return {
      ready: Promise.resolve(), refresh: async () => { throw error('ENTERPRISE_MODELS_UNAVAILABLE'); },
      getView: () => ({ managed: true, state: 'error', error: 'ENTERPRISE_MODELS_UNAVAILABLE', models: [] }),
      dispose: async () => { off?.(); }
    };
  }
  const provider = config.defaultProvider;
  // The native transport prefers the session-bound dispatch port. Adapters
  // without that port can resolve the IAM token for the current call.
  const resolveIamToken = typeof iam.getAccessToken === 'function' ? () => iam.getAccessToken() : undefined;
  // `modelOptions` doubles as the enabled set: a key means "this person turned
  // this model on", and its value carries the overrides (possibly none). A
  // discovered model without a key is listed but refused for calls.
  let catalogModels = [];
  // Whether the catalogue has ever been read successfully for this identity and
  // gateway. A successful empty response is knowledge ("the gateway offers no
  // catalogue models"), while a failed request is not; `catalogModels.length`
  // cannot tell the two apart.
  let catalogueRead = false;
  let manualModels = []; let manualTruncated = 0; let rawModels = []; let modelOptions = {}; let models = []; let catalogState = 'unconfigured'; let catalogError = null; let catalogTruncated = 0;
  const syncRawModels = () => { rawModels = mergeAvailableModels(catalogModels, manualModels); };
  // A new login alone does not clear an observed revocation of the same binding.
  let revokedBinding = null;
  let connectionBaseURL;
  let adapterError = null;
  let defaultModelId = null;
  // `selectionSaved` separates "nothing stored yet" (auto-enable the default)
  // from "stored as empty" (this person deliberately enabled no model).
  // `selectionOwner` is the identity whose record the in-memory selection came
  // from: a write must never be composed for one person out of another's state.
  let selectionSaved = false; let selectionError = null; let selectionWriteError = null;
  let selectionLoaded = false; let selectionOwner = null;
  const settingsIdentity = (view) => JSON.stringify([identity(view), iam.getModelAuthorizationEpoch?.() ?? null]);
  const enabled = id => Object.hasOwn(modelOptions, id);
  const streamable = id => rawModels.find(item => item.id === id)?.streaming !== false;
  // One contract code, four causes that must not be conflated (issue #206).
  const DENIED_LOCALLY = Object.freeze({ code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: '该模型在本机未启用，请在设置中启用。' });
  const NOT_IN_CATALOG = Object.freeze({ code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: '企业目录未提供该模型。' });
  const NOT_STREAMABLE = Object.freeze({ code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: NOT_STREAMABLE_MESSAGE });
  const INTERNAL_REFUSAL = Object.freeze({ code: 'IAM_INTERNAL', message: '内部错误，请重试；持续失败请联系管理员。' });
  // The waterfall sees every provider this host may route to: a foreign route
  // there is a policy refusal, not a caller bug.
  const FOREIGN_PROVIDER = Object.freeze({ code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: '企业环境仅允许使用企业模型。' });
  function denialFor(route, model, { guard = false } = {}) {
    if (route !== provider) return guard ? FOREIGN_PROVIDER : INTERNAL_REFUSAL;
    const entry = models.find(item => item.id === model) ?? rawModels.find(item => item.id === model);
    if (!entry) {
      // An enabled manual route this snapshot cannot see (a pending refresh) is
      // not a catalogue decision: keep it callable. Anything else without a
      // catalogue read is a gateway-side failure, not "never offered".
      // Only while the directory is still loading: once it has failed, the
      // failure is what both entries must report, manual route or not.
      if (!catalogError && enabled(model) && manualModels.some(item => item.id === model)) return null;
      if (!catalogueRead) {
        const code = catalogError ?? 'ENTERPRISE_MODELS_UNAVAILABLE';
        return { code, message: MESSAGES[code] ?? MESSAGES.ENTERPRISE_MODELS_UNAVAILABLE };
      }
      return NOT_IN_CATALOG;
    }
    if (entry.streaming === false) return NOT_STREAMABLE;
    if (!enabled(model)) return DENIED_LOCALLY;
    return null;
  }
  const selectableId = id => enabled(id) && streamable(id);
  const callable = model => selectableId(typeof model === 'string' ? model : model.id);
  const enabledModel = (route, model) => route === provider && selectableId(model) ? models.find(item => item.id === model) : undefined;
  const allowed = (route, model) => Boolean(enabledModel(route, model));
  const lifetime = new AbortController();
  let lease = new AbortController(); let version = 0; let last; let lastId; let lastSettingsIdentity; let lastSessionIdentity; let lastAuthorization; let deadline; let timer; let disposed = false; let backend; let flight;
  const activeStreams = new Set();
  let rotationCheck;
  // The catalogue can move ahead of a failed adapter rebuild. Only the
  // unchanged subset installed for this binding is still safe to dispatch.
  let installedModels = new Map();
  // Install state must not depend on display-only metadata: a catalogue refresh
  // that changes only the compliance label, or a rebuild that fails after such a
  // change, must not turn an otherwise callable model into an unusable one.
  const callShape = model => JSON.stringify([model?.id, model?.contextWindow, model?.maxTokens, model?.inputModalities, model?.streaming]);
  const installed = model => Boolean(backend) && installedModels.has(model.id)
    && callShape(installedModels.get(model.id)) === callShape(model);
  const credentialRevoked = () => revokedBinding === lastId;
  // Bounded compensation for a refresh that lost its race to a context change:
  // one rebuild per version, never more than REBUILD_ATTEMPT_LIMIT in a row.
  let rebuildAttempts = 0; let rebuiltVersion = -1;
  let retryAttempt = 0; let retryTimer; let retryAt = null; let syncedAt = null;
  let hostDefault = null; let alignment = null; let alignQueued = false;
  let optionsChain = null;
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
  function clearCatalog(state = 'unconfigured', code = null) {
    catalogModels = []; catalogueRead = false; manualModels = []; manualTruncated = 0;
    rawModels = []; models = []; backend = undefined; installedModels.clear(); connectionBaseURL = undefined; adapterError = null;
    catalogState = state; catalogError = code;
    retryAt = null; syncedAt = null;
  }
  // A transient failure keeps the last catalogue and its adapter: the panel
  // shows the last known list with a stale marker instead of going blank, and
  // a discovery blip does not kill a call that was already prepared.
  function markFailed(code) {
    catalogState = 'error'; catalogError = code;
  }
  function stopRotationCheck() {
    if (!rotationCheck) return;
    clearTimeout(rotationCheck.timer);
    rotationCheck.controller.abort();
    rotationCheck = undefined;
  }
  function expireAuthorization() {
    version++;
    lease.abort();
    stopRotationCheck();
    cancelRetry();
    markFailed('IAM_LOGIN_REQUIRED');
    publish();
  }
  function scheduleRotationCheck() {
    const currentLease = lease;
    if (disposed || currentLease.signal.aborted || !(deadline > Date.now()) || !activeStreams.size) {
      stopRotationCheck();
      return;
    }
    if (rotationCheck?.deadline === deadline && rotationCheck.lease === currentLease) return;
    stopRotationCheck();
    const latestStream = () => [...activeStreams].findLast(item => item.lease === currentLease);
    if (!latestStream()) return;
    const check = { deadline, lease: currentLease, controller: new AbortController(), timer: undefined };
    rotationCheck = check;
    const signal = AbortSignal.any([check.controller.signal, currentLease.signal, lifetime.signal]);
    const current = () => rotationCheck === check && !signal.aborted && Date.now() < check.deadline;
    const schedule = (index) => {
      const remaining = check.deadline - STREAM_ROTATION_CHECK_LEADS_MS[index] - Date.now();
      check.timer = setTimeout(async () => {
        if (!current()) return;
        const entry = latestStream();
        if (!entry) return;
        try {
          if (await entry.session.adoptCommittedRotation(signal)) sample();
        } catch (cause) {
          if (!current()) return;
          const code = failureCode(cause);
          if (code === 'IAM_LOGIN_REQUIRED') {
            // The read may instead belong to a local session already replaced.
            // Only a still-current stream may close this lease.
            try { entry.session.assertCurrent(); } catch { return; }
            expireAuthorization();
            return;
          }
          noteMapped(cause, code);
        }
        if (current() && index + 1 < STREAM_ROTATION_CHECK_LEADS_MS.length) schedule(index + 1);
      }, Math.max(0, Math.min(remaining, 2147483647)));
      check.timer.unref?.();
    };
    schedule(0);
  }
  function watchAcceptedStream(session, streamLease, signal) {
    if (!session?.adoptCommittedRotation || signal.aborted) return;
    const entry = { session, lease: streamLease };
    const stop = () => {
      if (!activeStreams.delete(entry)) return;
      signal.removeEventListener('abort', stop);
      scheduleRotationCheck();
    };
    activeStreams.add(entry);
    signal.addEventListener('abort', stop, { once: true });
    scheduleRotationCheck();
    return stop;
  }
  function sample() {
    if (inSample) return null;
    inSample = true;
    try {
      const view = iam.getView();
      const currentId = identity(view);
      const currentSettingsIdentity = settingsIdentity(view);
      const currentSessionIdentity = iam.getModelSessionIdentity?.();
      const current = `${currentSettingsIdentity}:${iam.getModelAccessEpoch?.() ?? ''}`;
      const currentAuthorization = authorizationId(view, iam.getModelAuthorizationEpoch?.());
      if (lastAuthorization !== currentAuthorization) {
        lastAuthorization = currentAuthorization;
        lease.abort(); lease = new AbortController();
      }
      if (last !== current) {
        const scopeChanged = lastSettingsIdentity !== currentSettingsIdentity;
        const bindingChanged = lastId !== currentId;
        const sessionChanged = lastSessionIdentity !== currentSessionIdentity;
        last = current;
        lastId = currentId;
        lastSettingsIdentity = currentSettingsIdentity;
        lastSessionIdentity = currentSessionIdentity;
        version++;
        if (scopeChanged) { selectionLoaded = false; selectionOwner = null; }
        if (bindingChanged || sessionChanged) {
          cancelRetry(); retryAttempt = 0; hostDefault = null;
          modelOptions = {}; defaultModelId = null; selectionSaved = false; selectionError = null; selectionWriteError = null;
          if (bindingChanged) clearCatalog();
          else {
            // Directory metadata still belongs to this account and gateway.
            // Install a route only after reading the new login's selection.
            manualModels = []; manualTruncated = 0;
            syncRawModels(); models = applyModelOptions(rawModels, modelOptions);
            backend = undefined; installedModels.clear(); adapterError = null;
          }
          publish();
        }
      }
      // A successful same-session IAM refresh changes the deadline, not the
      // gateway configuration. Keep valid prepared calls and update cancellation.
      const nextDeadline = view?.state === 'ready' ? expires(view) : null;
      if (deadline !== nextDeadline) {
        const expired = Number.isFinite(deadline) && !lease.signal.aborted
          && (view?.state === 'expired' || (activeStreams.size > 0 && deadline <= Date.now()));
        deadline = nextDeadline; clearTimeout(timer);
        if (expired) expireAuthorization();
        const remaining = deadline - Date.now();
        if (deadline !== null && remaining > 0) {
          timer = setTimeout(expireAuthorization, Math.min(remaining, 2147483647)); timer.unref?.();
        } else if (deadline !== null && !expired) expireAuthorization();
      }
      scheduleRotationCheck();
      return view;
    } finally {
      inSample = false;
    }
  }
  /** Answered before a stream starts: the call must still belong to this context. */
  function refusal(request, captured) {
    const denied = permit(sample());
    const plain = code => (code ? { code, message: MESSAGES[code] } : null);
    if (disposed) return plain('ENTERPRISE_MODELS_UNAVAILABLE');
    if (denied) return plain(denied);
    if (captured !== undefined && captured !== version) return plain('IAM_MODEL_CONTEXT_CHANGED');
    if (credentialRevoked()) return plain('ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
    // Without an adapter, name the failure every entry sees: adapter
    // initialization first, directory failure second (issue #380). A route that
    // still has a locally built adapter keeps serving (manual routes are
    // independent of the catalogue, see the same-account relogin case).
    if (!backend) return plain(missingBackendCode() ?? 'ENTERPRISE_MODELS_UNAVAILABLE');
    const model = enabledModel(request.provider, request.model);
    if (!model) return denialFor(request.provider, request.model, { guard: true });
    if (!installed(model)) return plain('ENTERPRISE_MODELS_UNAVAILABLE');
    return null;
  }
  /**
   * Answered once a stream is running. Turning a model off, saving a key or
   * switching the selection is a configuration change, not a revocation: the
   * answer already being generated keeps its authorization. Losing the account,
   * the credential or the session is what aborts it.
   */
  function authorizationRefusal(subject) {
    const view = sample();
    const denied = permit(view);
    if (disposed) return 'ENTERPRISE_MODELS_UNAVAILABLE';
    if (denied) return denied;
    if (credentialRevoked()) return 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED';
    if (subject !== undefined && view?.principal !== subject) return 'IAM_LOGIN_REQUIRED';
    return null;
  }
  // A gateway that refuses an image would otherwise poison the whole session:
  // the image rides in every later request, so every later turn fails the same
  // way and no message can be deleted to fix it. The first refusal downgrades
  // that conversation to placeholders, and later requests are composed without
  // image bytes from the start.
  const IMAGE_REFUSALS = new Set(['ENTERPRISE_REQUEST_UNSUPPORTED', 'ENTERPRISE_GATEWAY_REQUEST_REJECTED']);
  const DOWNGRADED_SESSION_LIMIT = 200;
  const imagesRefused = new Set();
  const hasImages = request => Array.isArray(request?.messages) && request.messages.some(message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image' && block.offloaded !== true));
  const withoutImages = request => ({
    ...request,
    messages: request.messages.map(message => (Array.isArray(message?.content)
      ? { ...message, content: message.content.map(block => (block?.type === 'image' && block.offloaded !== true ? { ...block, offloaded: true } : block)) }
      : message)),
  });
  // The memory is per conversation AND per target: switching the same
  // conversation to another model must try its images again, or the recovery
  // path the failure message points at would be dead.
  const refusalKey = request => [request.sessionId, request.provider, request.model].map(value => String(value)).join('\u0000');
  const rememberRefusal = key => {
    imagesRefused.delete(key);
    imagesRefused.add(key);
    while (imagesRefused.size > DOWNGRADED_SESSION_LIMIT) imagesRefused.delete(imagesRefused.values().next().value);
  };
  // Remember a revocation so no later call spends another round trip on it.
  const record = (code, binding = lastId) => {
    if (code === 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED' && binding === lastId) {
      revokedBinding = binding;
      lease.abort(error(code));
    }
    return code;
  };
  // The failure object's shape stays { code, message }: the client renders that
  // shape and its contract types it exactly. The internal code is diagnosis, so
  // it goes to the host log instead of widening what every consumer parses.
  const noteMapped = (cause, code) => {
    const detailCode = cause?.code;
    if (typeof detailCode !== 'string' || detailCode === code) return;
    const safeDetail = Object.hasOwn(USER_CODE_BY_INTERNAL, detailCode) ? detailCode : 'UNRECOGNIZED';
    try { logFailure?.(safeDetail, code); } catch { /* diagnostics never change the answer */ }
  };
  const diagnosed = new WeakSet();
  const reportFailure = (request, cause, code, stage, transport) => {
    try { diagnoseFailure?.({ detailCode: cause?.code ?? code, code, message: MESSAGES[code] ?? MESSAGES.ENTERPRISE_GATEWAY_CALL_FAILED, stage, request, ...(transport ? { transport } : {}) }); } catch { /* diagnostics never change the answer */ }
  };
  const failed = (request, cause, code, stage, transport, message) => {
    reportFailure(request, cause, code, stage, transport);
    const chunk = finish(code, message ?? MESSAGES[code]);
    diagnosed.add(chunk);
    return chunk;
  };
  /**
   * Rebuild the catalogue behind a binding change, waiting no longer than a
   * request would: a stalled recovery must not hang the answer.
   */
  async function rebuildBinding(request) {
    if (process.env.DBG304) console.error('REBUILD');
    let timer;
    const sync = refresh();
    const localReady = flight?.localReady;
    try {
      await Promise.race([
        sync,
        localReady?.then(() => refusal(request) ? sync : undefined) ?? sync,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(error('ENTERPRISE_GATEWAY_UNAVAILABLE')), BINDING_RECOVERY_MS);
          timer.unref?.();
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  // Only the pre-dispatch path may wait for a new AT. The existing resolver
  // owns token rotation, so cancelling this caller leaves the shared flight alone.
  function renewBeforeCall(request, view, session) {
    if (disposed || !session || request.provider !== provider || view?.renewal !== 'available'
      || !view.principal || view.gatewayCredential?.state !== 'configured' || view.gatewayCredential.matchesAccount !== true
      || credentialRevoked() || (view.state !== 'expired' && !(view.state === 'ready' && expires(view) <= Date.now()))) return;
    const deadline = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(request.signal ? [request.signal] : [])]);
    signal.throwIfAborted();
    const expiresAt = performance.now() + MODEL_RENEWAL_WAIT_MS;
    const timeLimit = error('ENTERPRISE_IAM_UNAVAILABLE');
    const timeout = setTimeout(() => deadline.abort(timeLimit), MODEL_RENEWAL_WAIT_MS);
    timeout.unref?.();
    const stopped = Promise.withResolvers();
    const onAbort = () => stopped.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const renew = async () => {
      const completed = session.waitForCompletedRotation?.(signal, MODEL_RENEWAL_RECHECK_MS);
      const renewal = session.renew();
      await (completed ? Promise.race([renewal, completed]) : renewal);
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw timeLimit;
      session.assertCurrent();
      // A cold runtime may have been unable to install the user's saved route.
      if (!permit(sample()) && !backend && !credentialRevoked()) await rebuildBinding(request);
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw timeLimit;
    };
    return Promise.race([renew(), stopped.promise]).finally(() => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      deadline.abort();
    });
  }

  async function* protect(request, dispatch, { captured, redispatch, preparedSubject, preparedSession, observeTransport = false } = {}) {
    const view = sample();
    const session = preparedSession === undefined ? iam.captureModelSession?.() : preparedSession;
    const checkSession = () => {
      request.signal?.throwIfAborted();
      if (session === null) throw error('IAM_LOGIN_REQUIRED');
      session?.assertCurrent();
    };
    try {
      checkSession();
      const renewal = renewBeforeCall(request, view, session);
      if (renewal) { await renewal; checkSession(); }
    } catch (cause) {
      if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
      const mapped = disposed ? 'ENTERPRISE_MODELS_UNAVAILABLE' : failureCode(cause);
      yield failed(request, cause, mapped, 'local');
      return;
    }
    let denial = refusal(request, captured);
    // A prepared call that outlived its selection is re-prepared when it still
    // belongs to this person: the model is still callable, only the context
    // generation moved. A different account is not recoverable by re-preparing.
    if (denial?.code === 'IAM_MODEL_CONTEXT_CHANGED') {
      const moved = preparedSubject !== undefined && iam.getView()?.principal !== preparedSubject;
      if (moved) denial = { code: 'IAM_LOGIN_REQUIRED', message: MESSAGES.IAM_LOGIN_REQUIRED };
      else if (redispatch) {
        try { await redispatch(); checkSession(); captured = version; denial = refusal(request, captured); }
        catch (cause) {
          if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
          const mapped = record(failureCode(cause)); yield failed(request, cause, mapped, 'local'); return;
        }
      }
    }
    if (denial) { if (process.env.DBG304) console.error('DENIAL', JSON.stringify(denial)); yield failed(request, null, denial.code, 'local', undefined, denial.message); return; }
    // Reused by the streaming loop below; the initial refusal above is already
    // settled, so this holds only per-attempt failure codes.
    let code;
    const subject = iam.getView()?.principal;
    const streamLease = renewLease();
    const signal = AbortSignal.any([lifetime.signal, streamLease.signal, ...(request.signal ? [request.signal] : [])]);
    let emitted = false; let retried = false; let downgraded = false; let downgradePending = false;
    let output = false;
    let retryVersion;
    const streamRefusal = () => {
      const denied = authorizationRefusal(subject);
      if (denied) return denied;
      try { session?.assertCurrent(); } catch (cause) { return failureCode(cause); }
      return signal.aborted && !request.signal?.aborted ? 'IAM_LOGIN_REQUIRED' : null;
    };
    const retryTransport = async (attempt, cause, mapped) => {
      if (emitted || retried || signal.aborted || mapped !== 'ENTERPRISE_GATEWAY_UNAVAILABLE' || !modelPreconnectFault(attempt)
        || Boolean(refusal(request, attempt.version))) return false;
      retried = true;
      retryVersion = attempt.version;
      reportFailure(request, cause, mapped, 'unknown', modelTransportDiagnostic(attempt, output, true));
      const delayMs = PRECONNECT_RETRY_DELAY_MS + Math.floor(Math.random() * (PRECONNECT_RETRY_JITTER_MS + 1));
      try { await delay(delayMs, undefined, { signal }); }
      catch (cause) { if (cause?.name !== 'AbortError') throw cause; }
      // The next iteration rechecks cancellation, authorization and the route
      // before asking the SDK for fresh credentials.
      return true;
    };
    const key = refusalKey(request);
    let current = request.sessionId !== undefined && imagesRefused.has(key) && hasImages(request)
      ? withoutImages(request) : request;
    // Only a refusal that could be about the images, before anything reached the
    // person, is worth one placeholder attempt: after a chunk the answer already
    // exists, and a network failure is not the images' fault.
    const downgradeImages = code => {
      if (downgraded || emitted || !IMAGE_REFUSALS.has(code) || !hasImages(current)) return false;
      downgraded = true;
      downgradePending = true;
      current = withoutImages(current);
      try { logFailure?.('IMAGE_REQUEST_REFUSED', code); } catch { /* diagnostics never change the answer */ }
      return true;
    };
    engine: for (;;) {
      let stopWatching;
      const expectedBinding = { baseURL: connectionBaseURL, subject, generation: iam.getView()?.gatewayCredential?.generation };
      const confirmBinding = async () => {
        const current = await iam.resolveGatewayConnection();
        if (!sameBinding(expectedBinding, current) || (expectedBinding.generation ?? null) !== (current.generation ?? null)) {
          throw error('IAM_MODEL_CONTEXT_CHANGED');
        }
      };
      const attempt = observeTransport ? {
        calls: 0, version, binding: lastId,
        withDispatchAccessToken: session?.withDispatchAccessToken && (send => session.withDispatchAccessToken(send, signal, confirmBinding)),
        accept() { this.accepted = true; stopWatching ??= watchAcceptedStream(session, streamLease, signal); },
        revoke() { this.revocation = record('ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED', this.binding); },
        refuse(cause) { this.denied ??= failureCode(cause); },
        check() {
          try {
            checkSession();
            signal.throwIfAborted();
            // Keep the denial object: flattening it loses the message and even
            // leaks `code: true` into the failure that reaches the person.
            const denial = refusal(request, this.version);
            if (denial) { this.denied ??= denial.code; throw error(denial.code); }
          } catch (cause) {
            this.denied ??= streamRefusal() ?? failureCode(cause);
            throw cause;
          }
        },
      } : undefined;
      try {
        checkSession();
        signal.throwIfAborted();
        const retryDenial = refusal(request, retryVersion);
        if (retryDenial) { yield failed(request, null, retryDenial.code, 'local', undefined, retryDenial.message); return; }
        const send = () => dispatch({ ...current, signal });
        for await (const chunk of attempt ? trackModelAttempt(send, attempt) : send()) {
          code = streamRefusal();
          if (code) {
            // An inner wrapper may already have recorded this failure. Still
            // report the current authorization refusal, without logging twice.
            if (diagnosed.has(chunk)) {
              const result = finish(code);
              diagnosed.add(result);
              yield result;
            } else yield failed(request, null, code, 'unknown', modelTransportDiagnostic(attempt, output, false));
            return;
          }
          if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
          if (diagnosed.has(chunk)) { yield chunk; return; }
          const failure = chunk.type === 'finish' && chunk.reason?.kind !== 'aborted' ? chunk.reason?.failure : undefined;
          if (attempt?.revocation || (failure && failureCode(failure) === 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED')) {
            // A confirmed refusal must reach other consumers immediately, even
            // while this accepted response is otherwise pausing its output.
            const revoked = record('ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED', attempt?.binding);
            noteMapped(failure, revoked);
            yield failed(request, failure, revoked, 'unknown', modelTransportDiagnostic(attempt, output, false));
            return;
          }
          if (attempt?.accepted) {
            const renewal = session?.waitForModelOutput?.(signal);
            if (renewal) {
              await renewal;
              if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
              code = streamRefusal();
              if (code) throw error(code);
            }
          }
          // The SDK emits an empty usage chunk before its error even when the
          // socket was never connected. No usage was incurred for this attempt.
          const preconnectFault = modelPreconnectFault(attempt);
          if (chunk.type === 'usage' && preconnectFault) continue;
          if (failure) {
            // The model layer turns an HTTP error into a finish chunk, so the code
            // arrives here without ever passing through the thrown-error branch.
            const mapped = attempt?.denied ?? attempt?.authFailure ?? record(failureCode(failure, preconnectFault), attempt?.binding);
            noteMapped(failure, mapped);
            if (await retryTransport(attempt, failure, mapped)) continue engine;
            if (downgradeImages(mapped)) continue engine;
            yield failed(request, failure, mapped, attempt?.denied ? 'local' : 'unknown', modelTransportDiagnostic(attempt, output, false)); return;
          }
          emitted = true;
          if (chunk.type !== 'usage' && chunk.type !== 'finish') output = true;
          yield chunk;
        }
        code = streamRefusal();
        if (code) { yield failed(request, null, code, 'unknown', modelTransportDiagnostic(attempt, output, false)); return; }
        // Remember the downgrade only after the replacement request succeeds.
        if (downgradePending) rememberRefusal(key);
        return;
      } catch (cause) {
        if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
        const authorization = streamRefusal();
        code = authorization ?? attempt?.denied ?? attempt?.revocation ?? attempt?.authFailure ?? failureCode(cause, modelPreconnectFault(attempt));
        if (!authorization && await retryTransport(attempt, cause, code)) continue engine;
        if (!authorization && downgradeImages(code)) continue engine;
        // Retry only before the first chunk leaves: after emission a second
        // dispatch would deliver the same answer twice. The failure must be the
        // plugin's own binding change (not a mapped user code), and the budget
        // is one attempt.
        if (!authorization && !emitted && !retried && !attempt?.calls && cause?.code === 'IAM_GATEWAY_BINDING_CHANGED') {
          retried = true;
          try {
            await rebuildBinding(request);
            checkSession();
            // A successful directory read can finish without a usable route.
            const reboundDenial = refusal(request);
            if (reboundDenial) { yield failed(request, null, reboundDenial.code, 'local', undefined, reboundDenial.message); return; }
            if (redispatch) await redispatch();
            continue;
          }
          catch (next) {
            if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
            const mapped = record(failureCode(next)); yield failed(request, next, mapped, 'unknown'); return;
          }
        }
        noteMapped(cause, code);
        yield failed(request, cause, record(code, attempt?.binding), attempt?.denied ? 'local' : 'unknown', modelTransportDiagnostic(attempt, output, false));
        return;
      } finally {
        stopWatching?.();
      }
    }
  }
  /**
   * Adopt the stored selection, or remember that nothing was stored yet.
   *
   * `selectionLoaded` records that the read *succeeded*, which is what makes a
   * later write safe: the enabled set and the manual list replace the whole
   * stored record, so writing without a successful read would delete whatever
   * this session could not see.
   */
  async function loadSelection(settings) {
    const owner = settingsIdentity(iam.getView());
    if (typeof iam.readModelSelection !== 'function') {
      selectionSaved = true; selectionLoaded = true; selectionOwner = owner;
      return;
    }
    try {
      const saved = settings ? await settings.readSelection() : await iam.readModelSelection();
      if (settingsIdentity(iam.getView()) !== owner) throw error('IAM_MODEL_CONTEXT_CHANGED');
      selectionError = null;
      selectionLoaded = true; selectionOwner = owner;
      if (!saved || saved.saved !== true) {
        selectionSaved = false; modelOptions = {}; defaultModelId = null;
        manualModels = []; manualTruncated = 0;
        return;
      }
      modelOptions = normalizeSelection(saved.models);
      defaultModelId = typeof saved.defaultModelId === 'string' ? saved.defaultModelId : null;
      manualModels = Array.isArray(saved.manual) ? saved.manual.map((entry) => ({ ...entry })) : [];
      manualTruncated = Number.isInteger(saved.manualTruncated) ? saved.manualTruncated : 0;
      selectionSaved = true;
      return saved.subject;
    } catch (cause) {
      if (settingsIdentity(iam.getView()) !== owner) throw error('IAM_MODEL_CONTEXT_CHANGED');
      if (settings && cause?.code !== 'IAM_MODEL_SELECTION_UNREADABLE') throw cause;
      // A storage read failure must not look like "nothing saved": that would
      // silently re-enable a default the user may have turned off.
      selectionError = cause?.code ?? 'IAM_CREDENTIALS_UNAVAILABLE';
      manualModels = []; manualTruncated = 0;
      selectionSaved = true;
      selectionLoaded = false; selectionOwner = null;
    }
  }

  /**
   * Read the stored selection before composing a write. Refusing here is the
   * safe answer: an unreadable record is not an empty one, and the write would
   * otherwise persist this session's partial view over the person's models.
   */
  async function ensureSelectionLoaded(settings) {
    const activeId = settingsIdentity(iam.getView());
    if (selectionLoaded && selectionOwner === activeId) return;
    await loadSelection(settings);
    if (selectionLoaded && selectionOwner === activeId) {
      syncRawModels();
      return;
    }
    throw error(Object.hasOwn(MESSAGES, selectionError ?? '') ? selectionError : 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE');
  }

  const ownsSelection = (owner) => selectionOwner === owner && settingsIdentity(iam.getView()) === owner;

  /** Best effort: an unwritten selection still applies to this session. */
  async function persistSelection(settings, next) {
    if (!settings && typeof iam.saveModelSelection !== 'function') return true;
    const owner = selectionOwner;
    try {
      if (settings) await settings.saveSelection(next);
      else await iam.saveModelSelection(next);
      if (ownsSelection(owner)) {
        // The durable record is ahead of the local model state until publish.
        selectionLoaded = false;
        selectionWriteError = null;
        selectionSaved = true;
      }
      return true;
    } catch (cause) {
      // A provider without verified write locking is read-only. The local
      // settings can still serve an otherwise valid gateway session.
      if (settings && !['IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_MODEL_SELECTION_UNWRITTEN',
        'IAM_MODEL_SELECTION_INVALID', 'IAM_RECORD_KIND_MISMATCH'].includes(cause?.code)) throw cause;
      if (ownsSelection(owner)) selectionWriteError = cause?.code ?? 'IAM_MODEL_SELECTION_UNWRITTEN';
      return false;
    }
  }

  function publishSelection(owner, persisted) {
    publish();
    if (persisted && ownsSelection(owner)) selectionLoaded = true;
  }

  /**
   * One key resolver for every adapter this runtime builds. It compares the
   * binding the adapter was created for, not the key's write generation: saving
   * a different key at the same address is adopted on the next call, while an
   * address or owner change asks for a rebuild instead of silently reusing the
   * old transport.
   */
  function createKeyResolver(connection) {
    const bound = { baseURL: connection.baseURL, subject: connection.subject ?? null };
    return async () => {
      const before = sample();
      const requestVersion = version;
      if (disposed || permit(before)) throw error('IAM_MODEL_CONTEXT_CHANGED');
      const next = await iam.resolveGatewayConnection();
      const after = sample();
      if (disposed || permit(after) || requestVersion !== version) throw error('IAM_MODEL_CONTEXT_CHANGED');
      // A different owner is a different session, not a transport to rebuild:
      // replaying the call under another principal would cross a subject line.
      if ((bound.subject ?? null) !== (next.subject ?? null)) throw error('IAM_LOGIN_REQUIRED');
      if (!sameBinding(bound, next)) throw new IamError('IAM_GATEWAY_BINDING_CHANGED', MESSAGES.IAM_GATEWAY_BINDING_CHANGED, { retryable: true });
      // The transport rejects header-unsafe values with its own message, which can
      // carry the raw value; intercept once here with a deterministic code.
      return assertSendableCredential(next.key);
    };
  }

  async function refresh(settings) {
    const denied = permit(sample());
    if (disposed || denied) throw error(denied ?? 'ENTERPRISE_MODELS_UNAVAILABLE');
    settings ??= iam.captureModelSettings?.();
    settings?.assertCurrent();
    const scope = lastSettingsIdentity;
    if (flight?.version === version) return flight.promise;
    // Only a running refresh can be a predecessor of a settings write.
    // While writes are pending, leave flight empty and retain the caller's scope.
    while (optionsChain) {
      await optionsChain;
      if (settings) await settings.verify();
      if (disposed || permit(sample()) || scope !== lastSettingsIdentity) throw error('IAM_MODEL_CONTEXT_CHANGED');
      settings?.assertCurrent();
      if (flight?.version === version) return flight.promise;
    }
    let mine = version;
    let directoryFailed = false;
    const localReady = Promise.withResolvers();
    catalogState = 'loading'; catalogError = null;
    const current = () => {
      if (disposed || permit(sample()) || mine !== version) throw error('IAM_MODEL_CONTEXT_CHANGED');
      if (credentialRevoked()) throw error('ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
      settings?.assertCurrent();
    };
    const task = Promise.resolve().then(async () => {
      current();
      catalogState = 'loading'; catalogError = null;
      const connection = await iam.resolveGatewayConnection(); current();
      assertSendableCredential(connection.key); current();
      if (connectionBaseURL !== undefined && connectionBaseURL !== connection.baseURL) clearCatalog('loading');
      connectionBaseURL = connection.baseURL;
      // Publish available models before the directory request. Only a saved
      // selection belonging to the verified connection can seed a local route.
      const selectionSubject = await loadSelection(settings); current();
      syncRawModels();
      const available = applyModelOptions(rawModels, modelOptions);
      let builtLocally = false;
      if (process.env.DBG304) console.error('LOCAL', JSON.stringify({sel: selectionSubject, principal: iam.getView().principal, subject: connection.subject, backend: Boolean(backend), avail: available.map(m=>m.id), inst: [...installedModels.keys()]}));
      if (selectionSubject === iam.getView().principal && selectionSubject === connection.subject
        && available.some(callable) && (!backend || installedModels.size !== available.length || !available.every(installed))) {
        builtLocally = await refreshAdapter(connection, available, current, settings);
      }
      current();
      models = available;
      if (builtLocally) publish();
      localReady.resolve();

      let directory;
      try {
        // The gateway contract scopes the second factor to inference requests.
        const headers = await requestHeaders();
        if (settings) await settings.verify();
        current();
        directory = await discover(connection, AbortSignal.any([lifetime.signal, renewLease().signal]), fetcher, headers);
      } catch (cause) {
        current();
        directoryFailed = true;
        throw cause;
      }
      if (settings) await settings.verify();
      current();
      const nextRawModels = mergeAvailableModels(directory.models, manualModels);
      let nextOptions = modelOptions;
      let nextDefault = defaultModelId;
      let selectionPersisted = false;
      // First run for this person: enable one model so the panel is usable
      // without any configuration. The admin's defaultModel wins when the
      // gateway still offers it, otherwise the first catalogue entry (the
      // catalogue is sorted, so "first" is stable across refreshes).
      if (!selectionSaved && nextRawModels.length > 0) {
        // Judge selectability against the catalogue this refresh just read:
        // `rawModels` still holds the previous snapshot (empty on first run).
        const selectableIn = id => nextRawModels.find(item => item.id === id)?.streaming !== false;
        const chosen = pickDefaultModel(nextRawModels, config.defaultModel, selectableIn);
        if (chosen) {
          nextOptions = { [chosen]: {} };
          nextDefault = chosen;
          selectionPersisted = await persistSelection(settings, { models: nextOptions, defaultModelId: nextDefault, manual: manualModels });
          // Adopt a generation advanced by our own write only while the
          // catalogue and selection still belong to its original scope.
          sample();
          if (scope !== lastSettingsIdentity) throw error('IAM_MODEL_CONTEXT_CHANGED');
          mine = version;
          if (flight?.promise === task) flight.version = mine;
          current();
        }
      } else if (!nextDefault || !callable(nextDefault) || !nextRawModels.some(m => m.id === nextDefault)) {
        nextDefault = nextRawModels.find(m => callable(m))?.id ?? null;
      }
      const entries = applyModelOptions(nextRawModels, nextOptions);
      if (!builtLocally || !isDeepStrictEqual(available, entries)) {
        await refreshAdapter(connection, entries, current, settings);
      }
      current();
      catalogTruncated = directory.truncated;
      catalogModels = directory.models;
      catalogueRead = true;
      rawModels = nextRawModels;
      modelOptions = nextOptions;
      defaultModelId = nextDefault;
      models = entries;
      catalogState = 'ready'; catalogError = null; retryAttempt = 0; rebuildAttempts = 0; rebuiltVersion = -1; cancelRetry();
      syncedAt = Date.now(); publishSelection(scope, selectionPersisted);
      await syncHostDefault(); current();
      return { models: models.map(({ id, name, source, contextWindow, maxTokens, inputModalities, streaming, compliance }) => ({ id, name, source: source ?? 'gateway', contextWindow, maxTokens, inputModalities, ...(streaming === undefined ? {} : { streaming }), ...(compliance === undefined ? {} : { compliance }) })), truncated: catalogTruncated };
    }).catch(cause => {
      // Our own cancellation is not a gateway outage. Telling the person to
      // check the gateway address after we stopped the request ourselves sends
      // them to the wrong place, and scheduling a retry for it would repeat the
      // same cancellation.
      const typedFailure = settings && cause instanceof IamError;
      const code = cause?.name === 'AbortError' ? 'ENTERPRISE_MODEL_SYNC_CANCELLED'
        : typedFailure || Object.hasOwn(MESSAGES, cause?.code ?? '') ? cause.code : 'ENTERPRISE_GATEWAY_UNAVAILABLE';
      if (mine === version && !disposed) {
        markFailed(code);
        if (!directoryFailed) {
          adapterError = code;
          if (!RETRYABLE.has(code)) { backend = undefined; installedModels.clear(); }
        }
        // Advertise the retry time before the frame that carries it.
        scheduleRetry(code, cause?.details?.retryAfterMs);
        publish();
      } else if (!disposed && mine !== version && code === 'IAM_MODEL_CONTEXT_CHANGED') {
        // This refresh was voided by a context change that already happened. The
        // old backend is still installed for the previous version, so the new
        // version would keep failing on a stale adapter; rebuild it once.
        scheduleVersionRebuild();
      }
      throw typedFailure ? cause : error(code);
    }).finally(() => {
      localReady.resolve();
      if (flight?.promise === task) flight = null;
    });
    flight = { scope, version: mine, promise: task, localReady: localReady.promise }; return task;
  }

  /**
   * A refresh that lost its race to a context change is void for the version it
   * started under. Rebuild once for the version that is current now, bounded so
   * a flapping context cannot turn recovery into a rebuild loop.
   */
  function scheduleVersionRebuild() {
    if (disposed || rebuildAttempts >= REBUILD_ATTEMPT_LIMIT) return;
    const target = version;
    if (rebuiltVersion === target) return;
    rebuiltVersion = target; rebuildAttempts += 1;
    const timer = setTimeout(() => {
      if (disposed || version !== target || permit(sample())) return;
      void refresh().catch(() => { });
    }, 0);
    timer.unref?.();
  }

  /** Bounded back-off for transient gateway failures; any context change cancels it. */
  function scheduleRetry(code, retryAfterMs) {
    if (!RETRYABLE.has(code)) return;
    const asked = Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
    let reusedBudget = false;
    if (retryTimer) {
      // A pending retry must not fire earlier than the latest response allows:
      // a manual refresh may learn of a longer wait after a short one was
      // scheduled. Without a new hint the existing plan stands.
      if (asked === undefined) return;
      if (asked > MAX_CATALOG_RETRY_AFTER_MS) { cancelRetry(); return; }
      const remaining = Math.max(0, (retryAt ?? 0) - Date.now());
      if (asked <= remaining) return;
      cancelRetry();
      reusedBudget = true;
    }
    // Budget is checked after the pending-timer handling: the last scheduled
    // retry must still learn about a newer, longer Retry-After.
    if (retryAttempt >= retryDelays.length) return;
    // A wait longer than the ceiling is not shortened silently: the failure
    // stays visible instead of parking the recovery for minutes.
    if (asked !== undefined && asked > MAX_CATALOG_RETRY_AFTER_MS) return;
    const delay = asked ?? retryDelays[retryAttempt];
    if (!reusedBudget) retryAttempt += 1;
    const mine = version;
    retryAt = Date.now() + delay;
    retryTimer = setTimeout(() => {
      retryTimer = undefined; retryAt = null;
      // The countdown ending is itself a visible change: publish it before the
      // next attempt, or the panel keeps a time that has already passed.
      publish();
      // A stale catalogue still has its adapter, and that is exactly when the
      // list matters: keeping the old backend must not cancel its recovery.
      if (disposed || mine !== version || permit(sample())) return;
      void refresh().catch(() => { });
    }, delay);
    retryTimer.unref?.();
  }

  /** Single-flight observation of DSH's new-conversation default. */
  function syncHostDefault() {
    if (alignment) { alignQueued = true; return alignment; }
    const mine = version;
    const task = Promise.resolve().then(() => alignHostDefaultModel({
      service: getHostDefaultModel(), llm: host.llm, provider, target: defaultModelId,
      enterpriseUsable: id => {
        const model = enabledModel(provider, id);
        return Boolean(model && installed(model));
      },
      isCurrent: () => { sample(); return !disposed && mine === version && !permit(iam.getView()); },
    })).catch(() => HOST_DEFAULT_RESULTS.FAILED).then(result => {
      if (!disposed && mine === version) {
        hostDefault = result;
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
        if (disposed || route !== provider || permit(sample()) || credentialRevoked() || !backend) return [];
        // Only enabled models are offered. A model the person has not turned on
        // stays in the account page's catalogue, so the picker cannot offer a
        // model whose calls would be refused.
        return models.filter(model => callable(model) && installed(model)).map(({ id, name, inputModalities, input }) => ({
          provider,
          id,
          name: name || id,
          inputModalities: inputModalities ?? input ?? ['text'],
        }));
      };
      if (key === 'stream') return request => protect(request, options => backend.stream(options), { observeTransport: true });
      if (key === 'prepareCall') return async (route, model, signal) => {
        const view = sample();
        const session = iam.captureModelSession?.();
        const request = { provider: route, model, signal };
        try {
          signal?.throwIfAborted();
          session?.assertCurrent();
          const renewal = renewBeforeCall(request, view, session);
          if (renewal) {
            await renewal;
            signal?.throwIfAborted();
            session.assertCurrent();
          }
        } catch (cause) {
          if (signal?.aborted) throw cause;
          const code = disposed ? 'ENTERPRISE_MODELS_UNAVAILABLE' : failureCode(cause);
          failed(request, cause, code, 'local');
          throw error(code);
        }
        const mine = version;
        const subject = iam.getView()?.principal;
        if (disposed) {
          const cause = error('ENTERPRISE_MODELS_UNAVAILABLE');
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        // A directory or adapter failure is the gateway-side cause the direct
        // entry must report too — but only for this provider, and only while the
        // session itself is still usable; sign-in and revocation stay first.
        const signInBlocked = permit(iam.getView());
        if (route === provider && !signInBlocked && !backend && missingBackendCode()) {
          const cause = error(missingBackendCode());
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        // Even a saved selection after logout reaches an actionable sign-in error.
        if (!permit(iam.getView()) && !allowed(route, model)) {
          // `permit()` may be the real blocker (signed out, revoked); keep its
          // outcome when the model itself is fine, so nothing pretends the
          // catalogue is at fault.
          const denial = denialFor(route, model)
            ?? { code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: MESSAGES.ENTERPRISE_MODEL_NOT_ALLOWED };
          const cause = new IamError(denial.code, denial.message);
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        const prepare = async () => {
          const entry = enabledModel(route, model);
          if (!entry || !installed(entry)) return null;
          return typeof backend.prepareCall === 'function'
            ? await backend.prepareCall(route, model, signal)
            : { model: await backend.resolveModel(route, model, signal), stream: options => backend.stream(options) };
        };
        let prepared;
        try { prepared = await prepare(); } catch (cause) {
          failed({ provider: route, model }, cause, failureCode(cause), 'unknown');
          throw cause;
        }
        return {
          model: prepared?.model ?? { provider: route, id: model, name: model },
          // A binding change inside the answer rebuilds the catalogue; the
          // prepared call must be rebuilt too, or the retry would replay it
          // against the adapter that just failed.
          stream: request => protect(request, options => (prepared ? prepared.stream(options) : backend.stream(options)), {
            captured: mine,
            preparedSubject: subject,
            preparedSession: session,
            redispatch: async () => { prepared = await prepare(); },
            observeTransport: true,
          })
        };
      };
      if (key === 'resolveModel') return async (route, model, signal) => {
        if (disposed) {
          const cause = error('ENTERPRISE_MODELS_UNAVAILABLE');
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        // Same precedence as prepareCall and the stream guard: the shared
        // no-adapter cause wins over the model-level denial, otherwise a
        // directory model would report a different code than the other entries
        // (issue #380 review).
        const signInBlocked = permit(sample());
        if (route === provider && !signInBlocked && !backend && missingBackendCode()) {
          const cause = error(missingBackendCode());
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        if (!permit(sample()) && !allowed(route, model)) {
          // `permit()` may be the real blocker (signed out, revoked); keep its
          // outcome when the model itself is fine, so nothing pretends the
          // catalogue is at fault.
          const denial = denialFor(route, model)
            ?? { code: 'ENTERPRISE_MODEL_NOT_ALLOWED', message: MESSAGES.ENTERPRISE_MODEL_NOT_ALLOWED };
          const cause = new IamError(denial.code, denial.message);
          failed({ provider: route, model }, cause, cause.code, 'local');
          throw cause;
        }
        try {
          const entry = enabledModel(route, model);
          return entry && installed(entry) ? await backend.resolveModel(route, model, signal) : { provider: route, id: model, name: model };
        } catch (cause) {
          failed({ provider: route, model }, cause, failureCode(cause), 'unknown');
          throw cause;
        }
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
  async function buildAdapter(connection, entries) {
    return createAdapter({
      host,
      config: { ...config, managedModels: { baseURL: connection.baseURL, models: entries } },
      // Losing the bound dispatch context must close the native call when
      // the IAM service supports session capture.
      resolveIamToken: createAdapter === createNativeGatewayAdapter && typeof iam.captureModelSession === 'function'
        ? undefined : resolveIamToken,
      resolveKey: createKeyResolver(connection),
      ...resolveAttachments === undefined ? {} : { resolveAttachments },
      ...prepareHeaders === undefined ? {} : { prepareHeaders },
    });
  }
  /**
   * Why nothing can serve a call right now. Adapter-initialization failure is the
   * immediate reason, the directory failure is the next; every entry point and
   * the stream guard resolve this the same way so one request is never described
   * with two different causes (issue #380).
   */
  const missingBackendCode = () => adapterError ?? catalogError;

  function installAdapter(resolved, entries) {
    backend = resolved;
    installedModels = new Map(entries.map(model => [model.id, model]));
    adapterError = null;
  }

  async function refreshAdapter(connection, entries, current, settings) {
    // Only initialization errors belong here. Context and directory failures
    // keep their own paths. The logger receives fixed codes without the cause.
    const resolved = await buildAdapter(connection, entries).catch(cause => {
      const code = 'ENTERPRISE_MODELS_UNAVAILABLE';
      try {
        diagnoseFailure?.({ detailCode: adapterInitializationDetailCode(cause), code, message: MESSAGES[code], stage: 'adapter-initialization' });
      } catch { /* optional diagnostics cannot change the directory result */ }
      return undefined;
    });
    // Adapter construction can yield to a peer that commits a new login.
    if (settings) await settings.verify();
    current();
    if (!resolved) {
      adapterError = 'ENTERPRISE_MODELS_UNAVAILABLE';
      return false;
    }
    installAdapter(resolved, entries);
    return true;
  }

  async function prepareAdapterUpdate(entries, stale) {
    if (entries.length === 0) {
      return () => { backend = undefined; installedModels.clear(); };
    }
    const connection = await iam.resolveGatewayConnection();
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    const resolved = await buildAdapter(connection, entries);
    return () => installAdapter(resolved, entries);
  }

  /** Apply one enabled-set submission for the person who is signed in right now. */
  async function applyOptions(nextOptions, settings) {
    settings?.assertCurrent();
    if (disposed) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    const denied = permit(sample());
    if (denied) throw error(denied);
    const activeId = settingsIdentity(iam.getView());
    // The submitted map is the whole stored record, so it may only be composed
    // after a successful read of what is already there.
    await ensureSelectionLoaded(settings);
    if (disposed) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    // The storage read may outlive this account's local selection.
    if (settingsIdentity(iam.getView()) !== activeId || permit(iam.getView())) throw error('IAM_MODEL_CONTEXT_CHANGED');
    // A successfully read empty catalogue still means "the gateway no longer
    // offers these", so pruning keys off the successful read itself.
    const catalogueKnown = catalogueRead;
    // Nothing is known about this person's models — no catalogue entry and no
    // manual declaration — so every id would look disabled and the write would
    // persist an empty selection over a real one. Refuse that, but never make
    // the gateway catalogue a precondition for saving a manual model: the
    // catalogue is the fallback's reason to exist, not its gate.
    if (rawModels.length === 0 && Object.keys(modelOptions).length === 0) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    const stale = () => { sample(); return disposed || settingsIdentity(iam.getView()) !== activeId || Boolean(permit(iam.getView())); };
    // The submitted map is the enabled set, not just an override list: an
    // empty object enables a model with the catalogue defaults, and dropping
    // a key disables it. Only known models can be enabled.
    const nextMap = normalizeSelection(nextOptions);
    for (const id of Object.keys(nextMap)) {
      if (rawModels.some(item => item.id === id)) continue;
      // With no catalogue in hand every stored catalogue id looks unknown, and
      // deleting it would throw away a model that this session simply cannot
      // see. Keep what this person had enabled; a catalogue that is in hand
      // still prunes the ids the gateway no longer offers.
      if (!catalogueKnown && enabled(id)) continue;
      delete nextMap[id];
    }
    // A model that declares no streaming support cannot be enabled at all:
    // drop it from the submitted set instead of storing a dead option.
    for (const id of Object.keys(nextMap)) if (!streamable(id)) delete nextMap[id];
    const nextDefault = defaultModelId && Object.hasOwn(nextMap, defaultModelId)
      ? defaultModelId : Object.keys(nextMap)[0] ?? null;
    const persisted = await persistSelection(settings, { models: nextMap, defaultModelId: nextDefault, manual: manualModels });
    // Signed out or switched account mid-save: the reset already happened;
    // never let this person's options land in the next person's state.
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    const nextModels = applyModelOptions(rawModels, nextMap);
    let install;
    if (rawModels.length > 0) {
      try {
        install = await prepareAdapterUpdate(nextModels, stale);
      } catch (cause) {
        if (cause?.code === 'IAM_MODEL_CONTEXT_CHANGED') throw cause;
        /* keep existing backend if rebuild fails */
      }
    }
    if (settings) await settings.verify();
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    modelOptions = nextMap;
    defaultModelId = nextDefault;
    models = nextModels;
    install?.();
    publishSelection(activeId, persisted);
    // The enabled set and the user's Host default are separate settings.
    await syncHostDefault();
    return {
      ok: true, persisted,
      defaultModelId,
      enabled: Object.keys(modelOptions),
      models: models.map(({ id, name, source, contextWindow, maxTokens, inputModalities, streaming, compliance }) => ({ id, name, source: source ?? 'gateway', contextWindow, maxTokens, inputModalities, ...(streaming === undefined ? {} : { streaming }), ...(compliance === undefined ? {} : { compliance }) }))
    };
  }

  async function applyManualModel({ action, id }, settings) {
    settings?.assertCurrent();
    if (disposed) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    const denied = permit(sample());
    if (denied) throw error(denied);
    const activeId = settingsIdentity(iam.getView());
    if (action !== 'add' && action !== 'remove') throw error('IAM_MANUAL_MODEL_INVALID');
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!isModelId(cleanId)) throw error('IAM_MANUAL_MODEL_INVALID');
    // Adopt the stored manual list before computing the next one: adding to an
    // unread record persisted a list holding only the new id, which is how one
    // add could erase every manual model saved before it.
    await ensureSelectionLoaded(settings);
    if (disposed) throw error('ENTERPRISE_MODELS_UNAVAILABLE');
    // The read is asynchronous: a sign-out or account switch inside it must not
    // add this person's model to the next person's list.
    if (settingsIdentity(iam.getView()) !== activeId || permit(iam.getView())) throw error('IAM_MODEL_CONTEXT_CHANGED');

    const stale = () => { sample(); return disposed || settingsIdentity(iam.getView()) !== activeId || Boolean(permit(iam.getView())); };

    let removed = false;
    let nextManual;
    let nextOptions = modelOptions;
    if (action === 'add') {
      if (catalogModels.some(item => item.id === cleanId) || manualModels.some(item => item.id === cleanId)) {
        throw error('IAM_MANUAL_MODEL_CONFLICT');
      }
      if (manualModels.length >= MAX_MANUAL_MODELS) {
        throw error('IAM_MANUAL_MODEL_LIMIT');
      }
      // Adding a record is not enabling it: the person still has to turn the
      // model on explicitly, and the Host default must not move on its own.
      nextManual = [...manualModels, { id: cleanId, addedAt: new Date().toISOString() }];
    } else {
      // A manual record must stay removable even after the catalogue starts
      // returning the same id: otherwise it would shadow the gateway entry for
      // good and the person could never clean it up.
      nextManual = manualModels.filter(item => item.id !== cleanId);
      if (nextManual.length === manualModels.length) {
        // 计划 §U3/§6.1：删除不存在的手动条目是幂等成功——不写库、不重建、不换默认值。
        return {
          ok: true,
          persisted: false,
          removed: false,
          defaultModelId,
          enabled: Object.keys(modelOptions),
          models: models.map(({ id: modelId, name, source, contextWindow, maxTokens, inputModalities }) => ({
            id: modelId,
            name,
            source: source ?? 'gateway',
            contextWindow,
            maxTokens,
            inputModalities,
          })),
          manual: manualModels.map(entry => ({ ...entry })),
          manualTruncated,
        };
      }
      removed = true;
      nextOptions = { ...modelOptions };
      delete nextOptions[cleanId];
    }

    const nextRawModels = mergeAvailableModels(catalogModels, nextManual);
    const isEnabled = (model) => Object.hasOwn(nextOptions, model);
    const nextDefault = defaultModelId && isEnabled(defaultModelId) && nextRawModels.some(item => item.id === defaultModelId)
      ? defaultModelId : nextRawModels.find(item => isEnabled(item.id))?.id ?? Object.keys(nextOptions)[0] ?? null;

    const persisted = await persistSelection(settings, { models: nextOptions, defaultModelId: nextDefault, manual: nextManual });
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    const nextModels = applyModelOptions(nextRawModels, nextOptions);
    let install;
    let rebuildError = null;
    try {
      install = await prepareAdapterUpdate(nextModels, stale);
    } catch (cause) {
      if (cause?.code === 'IAM_MODEL_CONTEXT_CHANGED') throw cause;
      rebuildError = cause?.code ?? 'ENTERPRISE_MODELS_UNAVAILABLE';
    }
    if (settings) await settings.verify();
    if (stale()) throw error('IAM_MODEL_CONTEXT_CHANGED');
    modelOptions = nextOptions;
    manualModels = nextManual;
    defaultModelId = nextDefault;
    rawModels = nextRawModels;
    models = nextModels;
    install?.();
    publishSelection(activeId, persisted);
    await syncHostDefault();
    return {
      ok: true,
      persisted,
      removed,
      defaultModelId,
      enabled: Object.keys(modelOptions),
      models: models.map(({ id: modelId, name, source, contextWindow, maxTokens, inputModalities }) => ({
        id: modelId,
        name,
        source: source ?? 'gateway',
        contextWindow,
        maxTokens,
        inputModalities,
      })),
      manual: manualModels.map(entry => ({ ...entry })),
      manualTruncated,
      ...(rebuildError ? { rebuildError } : {}),
    };
  }

  function queueSettings(apply, input, settings) {
    const scope = settingsIdentity(iam.getView());
    const runningRefresh = flight?.scope === scope ? flight.promise : undefined;
    const run = Promise.resolve(optionsChain).then(async () => {
      // A refresh that already started can finish adopting the saved selection.
      // A later refresh waits for this write without creating a flight of its own.
      if (runningRefresh) await runningRefresh.catch(() => {});
      if (settingsIdentity(iam.getView()) !== scope) throw error('IAM_MODEL_CONTEXT_CHANGED');
      return apply(input, settings);
    });
    const pending = run.catch(() => {}).finally(() => {
      if (optionsChain === pending) optionsChain = null;
    });
    optionsChain = pending;
    return run;
  }

  return {
    ready, refresh,
    syncDefaultModel: () => syncHostDefault(),
    updateModelOptions(nextOptions = {}, settings = iam.captureModelSettings?.()) {
      return queueSettings(applyOptions, nextOptions, settings);
    },
    updateManualModel(payload = {}, settings = iam.captureModelSettings?.()) {
      return queueSettings(applyManualModel, payload, settings);
    },
    getModelOptions: () => ({ ...modelOptions }),
    getView: () => {
      if (!inSample && !disposed) sample();
      return {
        managed: true, configured: true,
        state: catalogState, error: catalogError,
        ...(catalogTruncated > 0 ? { catalogTruncated } : {}),
        ...(manualTruncated > 0 ? { manualTruncated } : {}),
        // Freshness: `stale` means the list is the last known catalogue and the
        // gateway could not be reached since; `retryAt` is the next automatic
        // attempt (absent when the failure is not retryable).
        stale: catalogState === 'error' && catalogModels.length > 0,
        retryAt, syncedAt,
        defaultModelId,
        // Fixed code describing the last read-only observation of the Host default.
        hostDefaultModel: hostDefault,
        enabled: Object.keys(modelOptions),
        selectionError: selectionError ?? selectionWriteError,
        models: models.map(({ id, name, source, hasManualEntry, contextWindow, maxTokens, inputModalities, reasoningEfforts, reasoning, streaming, compliance }) => ({
          id,
          name,
          source: source ?? 'gateway',
          ...(hasManualEntry === true ? { hasManualEntry: true } : {}),
          contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          inputModalities: inputModalities ?? ['text'],
          reasoningEfforts: reasoningEfforts ?? null,
          reasoning: Boolean(reasoning),
          // Declared metadata for display only (issue #202 item 4): showing a
          // compliance level or region never grants or denies access here.
          ...(streaming === undefined ? {} : { streaming }),
          ...(compliance === undefined ? {} : { compliance }),
          // A listed model is not necessarily callable; only enabled ones are.
          // Same rule as the native picker and the save path: a model that cannot
          // stream is listed but never enabled or shown as the default.
          enabled: enabled(id) && streamable(id),
          isDefault: defaultModelId === id && callable(id),
        })),
        modelOptions: { ...modelOptions }
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); stopRotationCheck(); cancelRetry(); lifetime.abort(); lease.abort(); offStream?.(); registration?.();
      await observation; catalogModels = []; catalogueRead = false; manualModels = []; manualTruncated = 0; rawModels = []; models = []; backend = undefined; installedModels.clear();
      // A closed runtime has no current failure: stale codes must not outlive it
      // and make another entry report a different cause (issue #380 review).
      catalogError = null; adapterError = null;
    }
  };
}

/** Host-supplied SDK only: an unavailable public import closes this capability. */
export async function createNativeGatewayAdapter({ host, config, resolveKey, resolveIamToken, resolveAttachments, prepareHeaders }) {
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
  // Both provider methods return the SDK's event stream synchronously. Bind
  // the IAM resolver to their fetch options and authorize only at dispatch.
  const identityHeaders = {
    tokenHeader: config.iamTokenHeader,
    consumerHeader: config.consumerTypeHeader,
    consumerType: config.consumerType,
  };
  const fetchOptions = options => modelFetchOptions(options, baseURL, resolveIamToken, identityHeaders);
  const piProvider = {
    id: provider, name: '企业模型', baseUrl: baseURL,
    auth: { apiKey: { name: '企业个人访问凭证', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'enterprise' }) } },
    getModels: () => catalog,
    stream: (model, context, options) => protocol.stream(model, context, fetchOptions(options)),
    streamSimple: (model, context, options) => protocol.streamSimple(model, context, fetchOptions(options))
  };
  // The gateway keeps the socket alive with `: ping` comments every 15s, but the
  // host watchdog counts parsed events and a comment never becomes one: only the
  // first body byte produces `start`. A 60s bound therefore aborted a slow first
  // token while the link was healthy. Match the host default instead.
  // Image budgets stay at the host defaults the bundled `llm-pi-ai` route is
  // tested against: a 10x larger body only ever travels to a gateway whose own
  // limit nobody stated, so an oversized request reads as a rejected call.
  const profiles = new Map([[provider, {
    provider, displayName: '企业模型', piProvider,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
    modelErrors: new Map(), configuredMaxTokens,
    retryPolicy: NO_RETRY_POLICY
  }]]);
  // This provider accepts only the per-request IAM-resolved key, never ambient OAuth or env credentials.
  // The enterprise route builds a second PiAiAdapter of its own, so every seam the
  // bundled llm-pi-ai plugin wires for images and headers has to be wired here as
  // well. Without `resolveAttachments` the adapter refuses every request whose
  // history carries an image — before it is sent — with `UNSUPPORTED_CONTENT`,
  // which leaves the session unable to complete any later request because the
  // image rides in every one of them.
  return new PiAiAdapter({
    profiles: () => profiles, resolveApiKey: resolveKey,
    ...typeof resolveAttachments === 'function' ? { resolveAttachments } : {},
    ...typeof prepareHeaders === 'function' ? { prepareHeaders } : {},
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
