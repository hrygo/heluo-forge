import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SELF_CODES, USER_CODE_BY_INTERNAL } from './gateway-failure.mjs';
import { ERROR_STATUS } from './error-contract.mjs';

const known = new Set([...SELF_CODES, ...Object.keys(USER_CODE_BY_INTERNAL), ...Object.keys(ERROR_STATUS)]);
const digest = value => typeof value === 'string' && value.length > 0
  ? createHash('sha256').update(value).digest('hex') : null;

// The writer only accepts registered codes and fixed messages supplied by the
// runtime. No upstream message, headers or request content cross this boundary.
export function createModelFailureLogger({ home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), warn = () => {} } = {}) {
  const directory = join(resolve(home), 'logs');
  const path = join(directory, 'forge-iam-model-failures.jsonl');
  return ({ detailCode, code, message, stage, request }) => {
    try {
      const event = {
        time: new Date().toISOString(),
        detailCode: known.has(detailCode) ? detailCode : null,
        code: known.has(code) ? code : null,
        message: typeof message === 'string' ? message : null,
        stage: stage === 'local' ? 'local' : 'unknown',
        providerHash: digest(request?.provider), modelHash: digest(request?.model), sessionHash: digest(request?.sessionId),
      };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      try { warn(); } catch { /* diagnostics never change model results */ }
    }
  };
}
