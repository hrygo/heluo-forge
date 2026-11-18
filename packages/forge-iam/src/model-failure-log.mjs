import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SELF_CODES, USER_CODE_BY_INTERNAL } from './gateway-failure.mjs';
import { ERROR_STATUS } from './error-contract.mjs';
import { sanitizeModelTransport } from './model-transport.mjs';

const adapterDetailCodes = {
  missingModule: 'ADAPTER_MODULE_NOT_FOUND',
  typeError: 'ADAPTER_TYPE_ERROR',
  referenceError: 'ADAPTER_REFERENCE_ERROR',
  syntaxError: 'ADAPTER_SYNTAX_ERROR',
  unknown: 'ADAPTER_INITIALIZATION_FAILED',
};
const known = new Set([
  ...SELF_CODES, ...Object.keys(USER_CODE_BY_INTERNAL), ...Object.keys(ERROR_STATUS), ...Object.values(adapterDetailCodes),
  'SERVER', 'TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT',
]);
const stages = new Set(['local', 'adapter-initialization']);
const digest = value => typeof value === 'string' && value.length > 0
  ? createHash('sha256').update(value).digest('hex') : null;

export function adapterInitializationDetailCode(cause) {
  if (cause?.code === 'ERR_MODULE_NOT_FOUND' || cause?.code === 'MODULE_NOT_FOUND') return adapterDetailCodes.missingModule;
  if (cause instanceof TypeError) return adapterDetailCodes.typeError;
  if (cause instanceof ReferenceError) return adapterDetailCodes.referenceError;
  if (cause instanceof SyntaxError) return adapterDetailCodes.syntaxError;
  return adapterDetailCodes.unknown;
}

// The writer only accepts registered codes and fixed messages supplied by the
// runtime. No upstream message, headers or request content cross this boundary.
export function createModelFailureLogger({ home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), warn = () => {} } = {}) {
  const directory = join(resolve(home), 'logs');
  const path = join(directory, 'forge-iam-model-failures.jsonl');
  return ({ detailCode, code, message, stage, request, transport }) => {
    try {
      const safeTransport = sanitizeModelTransport(transport);
      const event = {
        time: new Date().toISOString(),
        detailCode: known.has(detailCode) ? detailCode : null,
        code: known.has(code) ? code : null,
        message: typeof message === 'string' ? message : null,
        stage: stages.has(stage) ? stage : 'unknown',
        providerHash: digest(request?.provider), modelHash: digest(request?.model), sessionHash: digest(request?.sessionId),
        ...(safeTransport ? { transport: safeTransport } : {}),
      };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      try { warn(); } catch { /* diagnostics never change model results */ }
    }
  };
}
