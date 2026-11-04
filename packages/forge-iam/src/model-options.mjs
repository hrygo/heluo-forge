import { IamError } from './errors.mjs';

export const NO_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
});

export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
const CAPACITY_SCALE = { k: 1000, m: 1000000 };

/** Canonical OpenAI-compatible root, validated before storing or sending credentials. */
export function normalizeGatewayBaseURL(input, _allowInsecureHttp = false) {
  let url;
  try { url = new URL(input); } catch { throw new IamError('IAM_GATEWAY_URL_INVALID', '请输入有效的 HTTP 或 HTTPS 网关地址。'); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new IamError('IAM_GATEWAY_URL_INVALID', '请输入有效的 HTTP 或 HTTPS 网关地址。');
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.href.replace(/\/$/u, '');
}

export function validateManagedModels(input, allowInsecureHttp = false) {
  if (input === undefined || input === null) return { value: null };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'baseURL')) {
      throw new IamError('IAM_GATEWAY_URL_INVALID', '请输入有效的 HTTP 或 HTTPS 网关地址。');
    }
    return { value: { baseURL: normalizeGatewayBaseURL(input.baseURL, allowInsecureHttp) } };
  } catch {
    return { issues: [{ path: ['managedModels'], message: 'managedModels accepts a safe baseURL only; models are discovered from /v1/models' }] };
  }
}

/**
 * Which model to enable when this person has never chosen one.
 *
 * The admin-configured `defaultModel` wins while the gateway still advertises
 * it; otherwise the first catalogue entry is taken. The catalogue is sorted, so
 * "first" is stable across refreshes instead of depending on response order.
 */
export function pickDefaultModel(models, preferred) {
  if (!Array.isArray(models)) return undefined;
  const ids = models.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return undefined;
  const wanted = typeof preferred === 'string' ? preferred.trim() : '';
  if (wanted && ids.includes(wanted)) return wanted;
  return ids[0];
}

/** Parse numeric capacity with optional K / M suffix. */
export function parseCapacity(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? Math.round(text) : undefined;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (!match) return undefined;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
  const scaled = Number(match[1]) * scale;
  return Number.isFinite(scaled) && scaled > 0 ? Math.round(scaled) : undefined;
}

/** Format numeric capacity to compact K / M representation. */
export function formatCapacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`;
  return String(value);
}

/** Build pi-ai thinkingLevelMap where disabled levels are explicitly null. */
export function buildThinkingLevelMap(reasoningEfforts) {
  if (!reasoningEfforts || typeof reasoningEfforts !== 'object' || Array.isArray(reasoningEfforts)) return undefined;
  const map = {};
  let hasEnabled = false;
  for (const level of THINKING_LEVELS) {
    const val = reasoningEfforts[level];
    if (typeof val === 'string' && val.trim()) {
      map[level] = val.trim();
      if (level !== 'off') hasEnabled = true;
    } else {
      map[level] = null;
    }
  }
  return hasEnabled ? map : undefined;
}

/** Overlay fine-grained user options onto discovered gateway models. */
export function applyModelOptions(rawModels, options = {}) {
  if (!Array.isArray(rawModels)) return [];
  return rawModels.map(item => {
    const opt = options?.[item.id] || {};
    const parsedContext = parseCapacity(opt.contextWindow);
    const parsedMaxTokens = parseCapacity(opt.maxTokens);
    const contextWindow = parsedContext ?? item.contextWindow ?? 32768;
    const maxTokens = parsedMaxTokens ?? item.maxTokens ?? 4096;
    const hasCustomMaxTokens = parsedMaxTokens !== undefined;
    const name = typeof opt.name === 'string' && opt.name.trim() ? opt.name.trim() : (item.name || item.id);
    const input = Array.isArray(opt.inputModalities) && opt.inputModalities.length > 0
      ? opt.inputModalities.filter(m => m === 'text' || m === 'image')
      : (Array.isArray(opt.input) && opt.input.length > 0 ? opt.input.filter(m => m === 'text' || m === 'image') : (item.input ?? ['text']));
    const inputModalities = input.length > 0 ? input : ['text'];
    const rawEfforts = opt.reasoningEfforts && typeof opt.reasoningEfforts === 'object' && !Array.isArray(opt.reasoningEfforts)
      ? opt.reasoningEfforts : (item.reasoningEfforts ?? null);
    const thinkingLevelMap = buildThinkingLevelMap(rawEfforts);
    const reasoningEfforts = thinkingLevelMap ? rawEfforts : null;
    const reasoning = Boolean(thinkingLevelMap || opt.reasoning || item.reasoning);
    return {
      ...item,
      id: item.id,
      name,
      contextWindow,
      maxTokens,
      hasCustomMaxTokens,
      input: inputModalities,
      inputModalities,
      reasoning,
      reasoningEfforts,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  });
}
