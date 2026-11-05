import { IamError } from './errors.mjs';

export const NO_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
});

export const THINKING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
export const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const DEFAULT_MAX_TOKENS = 64000;

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

/**
 * Build a contiguous reasoningEfforts map from lower and upper bounds
 * across ['off', 'low', 'medium', 'high', 'xhigh', 'max'].
 * Automatically normalizes reversed bounds so lower <= upper always holds.
 */
export function buildReasoningEffortRange(lowerBound, upperBound = lowerBound) {
  const normLower = typeof lowerBound === 'string' ? lowerBound.trim().toLowerCase() : '';
  const normUpper = typeof upperBound === 'string' ? upperBound.trim().toLowerCase() : normLower;
  const startIdx = THINKING_LEVELS.indexOf(normLower);
  const endIdx = THINKING_LEVELS.indexOf(normUpper);
  if (startIdx < 0 && endIdx < 0) return undefined;
  const resolvedStart = startIdx >= 0 ? startIdx : endIdx;
  const resolvedEnd = endIdx >= 0 ? endIdx : startIdx;
  const minIdx = Math.min(resolvedStart, resolvedEnd);
  const maxIdx = Math.max(resolvedStart, resolvedEnd);
  if (maxIdx === 0) return undefined;
  const result = { off: minIdx === 0 ? 'off' : null };
  for (let i = Math.max(1, minIdx); i <= maxIdx; i += 1) {
    const level = THINKING_LEVELS[i];
    result[level] = level;
  }
  return result;
}

/**
 * Inspect a reasoningEfforts configuration and return its active lower/upper bounds.
 */
export function getReasoningEffortBounds(reasoningEfforts) {
  if (!reasoningEfforts || typeof reasoningEfforts !== 'object' || Array.isArray(reasoningEfforts)) {
    return { enabled: false, lower: 'off', upper: 'off', levels: [] };
  }
  const boundLower = reasoningEfforts.lower ?? reasoningEfforts.min;
  const boundUpper = reasoningEfforts.upper ?? reasoningEfforts.max;
  const source = (typeof boundLower === 'string' || typeof boundUpper === 'string')
    ? (buildReasoningEffortRange(boundLower, boundUpper) ?? {})
    : reasoningEfforts;
  const activeLevels = REASONING_EFFORT_LEVELS.filter(level => {
    const val = source[level];
    return typeof val === 'string' && val.trim().length > 0;
  });
  if (activeLevels.length === 0) {
    return { enabled: false, lower: 'off', upper: 'off', levels: [] };
  }
  const hasOff = typeof source.off === 'string' && source.off.trim().length > 0;
  const levels = hasOff ? ['off', ...activeLevels] : activeLevels;
  return {
    enabled: true,
    lower: levels[0],
    upper: levels[levels.length - 1],
    levels,
  };
}

/** Build pi-ai thinkingLevelMap where disabled levels are explicitly null. */
export function buildThinkingLevelMap(reasoningEfforts) {
  if (!reasoningEfforts || typeof reasoningEfforts !== 'object' || Array.isArray(reasoningEfforts)) return undefined;
  const boundLower = reasoningEfforts.lower ?? reasoningEfforts.min;
  const boundUpper = reasoningEfforts.upper ?? reasoningEfforts.max;
  const normalizedEfforts = (typeof boundLower === 'string' || typeof boundUpper === 'string')
    ? (buildReasoningEffortRange(boundLower, boundUpper) ?? {})
    : reasoningEfforts;
  const map = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  let hasEnabled = false;
  for (const level of THINKING_LEVELS) {
    const val = normalizedEfforts[level];
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
    const contextWindow = parsedContext ?? item.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = parsedMaxTokens ?? item.maxTokens ?? DEFAULT_MAX_TOKENS;
    const hasCustomMaxTokens = parsedMaxTokens !== undefined;
    const name = typeof opt.name === 'string' && opt.name.trim() ? opt.name.trim() : (item.name || item.id);
    const input = Array.isArray(opt.inputModalities) && opt.inputModalities.length > 0
      ? opt.inputModalities.filter(m => m === 'text' || m === 'image')
      : (Array.isArray(opt.input) && opt.input.length > 0 ? opt.input.filter(m => m === 'text' || m === 'image') : (item.input ?? ['text']));
    const inputModalities = input.length > 0 ? input : ['text'];
    const hasExplicitEfforts = Boolean(opt.reasoningEfforts && typeof opt.reasoningEfforts === 'object' && !Array.isArray(opt.reasoningEfforts));
    const rawEfforts = hasExplicitEfforts
      ? opt.reasoningEfforts : (item.reasoningEfforts ?? buildReasoningEffortRange('off', 'high'));
    const thinkingLevelMap = buildThinkingLevelMap(rawEfforts);
    const normalizedEfforts = thinkingLevelMap
      ? ((typeof (rawEfforts?.lower ?? rawEfforts?.min) === 'string' || typeof (rawEfforts?.upper ?? rawEfforts?.max) === 'string')
        ? buildReasoningEffortRange(rawEfforts.lower ?? rawEfforts.min, rawEfforts.upper ?? rawEfforts.max)
        : rawEfforts)
      : null;
    const reasoningEfforts = normalizedEfforts;
    const reasoning = Boolean(thinkingLevelMap || (!hasExplicitEfforts && (opt.reasoning || item.reasoning)));
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
