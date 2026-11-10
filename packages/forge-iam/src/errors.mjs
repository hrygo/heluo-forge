export const IAM_GATEWAY_URL_INVALID_MESSAGE = '请输入有效的 HTTP 或 HTTPS 网关地址。';

export class IamError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IamError';
    this.code = code;
    this.details = details;
  }
}
