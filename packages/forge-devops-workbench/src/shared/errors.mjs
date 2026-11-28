/**
 * DOP 工作台错误定义与标准化错误信封（对齐 CORP-DSH-TOOLS-002 §3.5）。
 */

export const ERROR_CODES = Object.freeze({
  CONFIG_MISSING: 'CONFIG_MISSING',
  UNAUTHORIZED: 'UNAUTHORIZED',
  UPSTREAM_AUTH_DENIED: 'UPSTREAM_AUTH_DENIED',
  RMP_SSO_EXCHANGE_FAILED: 'RMP_SSO_EXCHANGE_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  UNAVAILABLE: 'UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_SCHEMA_DRIFT: 'UPSTREAM_SCHEMA_DRIFT',
  CONFLICT_BUSY: 'CONFLICT_BUSY',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  REQUEST_HEADER_REQUIRED: 'REQUEST_HEADER_REQUIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const SAFE_MESSAGES = Object.freeze({
  [ERROR_CODES.CONFIG_MISSING]: '未配置 DOP 服务地址 apiBaseUrl，请填写地址或设置 HELUO_DOP_BASE_URL 后重试',
  [ERROR_CODES.UNAUTHORIZED]: '尚未登录企业账号或 IAM 会话已过期，请登录后重试',
  [ERROR_CODES.UPSTREAM_AUTH_DENIED]: 'DOP 认证凭据已失效（HTTP 403），请前往企业账号重新登录后重试',
  [ERROR_CODES.RMP_SSO_EXCHANGE_FAILED]: 'RMP 单点换票失败或令牌已失效，请重新登录后重试',
  [ERROR_CODES.FORBIDDEN]: '当前账号无权访问该资源或操作被策略拒绝',
  [ERROR_CODES.UNAVAILABLE]: 'DOP 平台服务暂时不可用或请求超时，请稍后重试',
  [ERROR_CODES.RATE_LIMITED]: 'DOP 平台请求过于频繁，请稍后再试',
  [ERROR_CODES.UPSTREAM_SCHEMA_DRIFT]: '上游响应格式异常（可能被平台鉴权页面拦截或结构变更）',
  [ERROR_CODES.CONFLICT_BUSY]: '存在更新的刷新请求，当前旧请求已取消',
  [ERROR_CODES.BAD_REQUEST]: '请求参数不合法',
  [ERROR_CODES.NOT_FOUND]: '请求的接口路径或资源不存在',
  [ERROR_CODES.METHOD_NOT_ALLOWED]: '不支持的 HTTP 请求方法',
  [ERROR_CODES.REQUEST_HEADER_REQUIRED]: '缺少必需的同源请求标识头',
  [ERROR_CODES.INTERNAL_ERROR]: 'DOP 工作台内部处理失败',
});

export const HTTP_STATUS_BY_CODE = Object.freeze({
  [ERROR_CODES.CONFIG_MISSING]: 503,
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.UPSTREAM_AUTH_DENIED]: 403,
  [ERROR_CODES.RMP_SSO_EXCHANGE_FAILED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.UNAVAILABLE]: 503,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.UPSTREAM_SCHEMA_DRIFT]: 502,
  [ERROR_CODES.CONFLICT_BUSY]: 409,
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.METHOD_NOT_ALLOWED]: 405,
  [ERROR_CODES.REQUEST_HEADER_REQUIRED]: 403,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
});

/**
 * 工作台可控业务/传输错误。
 */
export class WorkbenchError extends Error {
  /**
   * @param {string} code 标准错误码
   * @param {string} [message] 面向用户的安全描述（禁止含 Token 或宿主机路径）
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    const resolvedCode = Object.values(ERROR_CODES).includes(code) ? code : ERROR_CODES.INTERNAL_ERROR;
    const safeMsg = typeof message === 'string' && message.trim() !== ''
      ? message
      : (SAFE_MESSAGES[resolvedCode] ?? SAFE_MESSAGES[ERROR_CODES.INTERNAL_ERROR]);
    super(safeMsg);
    this.name = 'WorkbenchError';
    this.code = resolvedCode;
    this.httpStatus = Number.isInteger(details.httpStatus)
      ? details.httpStatus
      : (HTTP_STATUS_BY_CODE[resolvedCode] ?? 500);
    this.retryable = Boolean(details.retryable);
    this.upstream = typeof details.upstream === 'string' && details.upstream !== '' ? details.upstream : 'workbench';
    this.retryAfterSec = Number.isFinite(details.retryAfterSec) ? details.retryAfterSec : null;
    this.requestId = typeof details.requestId === 'string' ? details.requestId : '';
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/**
 * 将任意异常收敛为无路径/无凭据泄漏的统一错误信封。
 *
 * @param {unknown} err
 * @param {{ endpointKind?: string, requestId?: string, partialData?: unknown }} [options]
 */
export function toErrorEnvelope(err, options = {}) {
  const endpointKind = typeof options.endpointKind === 'string' && options.endpointKind !== ''
    ? options.endpointKind
    : 'enterprise';
  const fallbackRequestId = typeof options.requestId === 'string' ? options.requestId : '';
  const partialData = options.partialData === undefined ? null : options.partialData;

  if (err instanceof WorkbenchError) {
    const errorObj = {
      code: err.code,
      message: SAFE_MESSAGES[err.code] && err.message ? err.message : SAFE_MESSAGES[ERROR_CODES.INTERNAL_ERROR],
      retryable: err.retryable,
      upstream: err.upstream,
      httpStatus: err.httpStatus,
      requestId: err.requestId || fallbackRequestId,
    };
    if (err.retryAfterSec !== null) errorObj.retryAfterSec = err.retryAfterSec;
    return { ok: false, endpointKind, error: errorObj, partialData };
  }

  return {
    ok: false,
    endpointKind,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: SAFE_MESSAGES[ERROR_CODES.INTERNAL_ERROR],
      retryable: false,
      upstream: 'workbench',
      httpStatus: 500,
      requestId: fallbackRequestId,
    },
    partialData,
  };
}
