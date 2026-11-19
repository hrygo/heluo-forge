import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import { ERROR_STATUS } from './error-contract.mjs';
import { OAUTH_ERROR_CODES, OidcError } from './oidc.mjs';
import { STATES } from './state.mjs';

const events = new Set([
  'host-start', 'host-stop', 'binding-changed', 'session-state', 'store-sync',
  'renewal-scheduled', 'renewal-fired', 'renewal-blocked', 'renewal-cancelled', 'renewal-resume', 'renewal-failed',
  'refresh-stage', 'refresh-claimed', 'refresh-shared', 'refresh-reused',
  'refresh-retry', 'refresh-failed', 'refresh-committed', 'refresh-adopted',
]);
const codes = [
  ...Object.keys(ERROR_STATUS), 'CRED_LOCK_TIMEOUT', 'CRED_LOCK_LOST', 'CRED_LOCK_RECOVERY_FAILED',
  'CRED_KEY_INVALID', 'CRED_STORE_PERMISSIONS', 'CRED_STORE_READ_ONLY', 'CRED_STORE_UNAVAILABLE',
  'IAM_GRANT_INVALID', 'IAM_GRANT_WRITE_REJECTED', 'IAM_HTTP_ERROR', 'IAM_HTTP_UNAVAILABLE',
  'IAM_DISCOVERY_INVALID', 'IAM_DISCOVERY_ISSUER_MISMATCH', 'IAM_INVALID_RESPONSE', 'IAM_JWKS_INVALID',
  'IAM_JWKS_KEY_NOT_FOUND', 'IAM_TOKEN_RESPONSE_INVALID', 'IAM_ID_TOKEN_ALGORITHM', 'IAM_ID_TOKEN_SUBJECT',
  'IAM_ID_TOKEN_AT_HASH', 'IAM_ID_TOKEN_ISSUED_AT', 'IAM_ID_TOKEN_NOT_BEFORE',
  'exclusive-violation', 'exclusive-check-unavailable',
];
const reasons = [
  'credentials-bound', 'credentials-unbound', 'atomic-store-bound', 'atomic-store-unbound', 'trusted-binding', 'hydration-failed',
  'disposed', 'replaced', 'session-inactive', 'session-changed', 'no-grant', 'refresh-pending',
  'refresh-unusable', 'deadline-unknown', 'deadline-passed', 'deadline-changed', 'retry-after-expiry', 'timer-before-due',
  'credentials-unavailable', 'provider-changed', 'atomic-store-unverified', 'stored-session-changed',
  'grant-invalid', 'grant-missing', 'preflight', 'claim-lock-timeout', 'claim-conflict', 'claim-unconfirmed',
  'rejected', 'rotation-missing', 'rotation-unchanged', 'commit-unconfirmed',
  'peer-pending', 'peer-timeout', 'peer-record-invalid', 'peer-complete', 'local-complete', 'local-pending-timeout',
  'peer-restored', 'request-unsent',
  'access-still-valid', 'store-read-failed', 'pending-window-ended', 'pending-result-unmatched', 'expired-recovery',
  'read-lock-timeout', 'store-read-recovered',
];
const enums = {
  state: STATES, previousState: STATES, reason: reasons, code: codes, causeCode: codes, oauthError: OAUTH_ERROR_CODES,
  authMode: ['public', 'confidential'], trigger: ['timer', 'resume', 'request', 'reconcile', 'model'],
  stage: ['store-read', 'client-auth', 'discovery', 'jwks', 'claim', 'client-auth-recheck', 'token-endpoint',
    'validate-response', 'restore', 'commit', 'wait-for-peer'],
};
const numbers = ['renewalId', 'dueAtMs', 'accessExpiresAtMs', 'refreshExpiresAtMs', 'delayMs', 'lateMs', 'jumpMs', 'elapsedMs', 'timeoutMs'];
const flags = ['issuerPinned', 'credentialsBound', 'atomicStoreBound', 'recovering', 'backoff', 'requestUnsent', 'timedOut'];

export function renewalDeadlines(grant) {
  return { accessExpiresAtMs: Date.parse(grant?.accessExpiresAt), refreshExpiresAtMs: Date.parse(grant?.refreshExpiresAt) };
}

export function renewalErrorFields(cause) {
  try {
    const code = cause?.code;
    const fields = { causeCode: codes.includes(code) ? code : 'IAM_INTERNAL' };
    if (cause instanceof OidcError) {
      const { status, oauthError, requestUnsent, timedOut } = cause.details;
      if (Number.isInteger(status) && status >= 100 && status <= 599) fields.httpStatus = status;
      if (OAUTH_ERROR_CODES.includes(oauthError)) fields.oauthError = oauthError;
      if (requestUnsent === true) fields.requestUnsent = true;
      if (timedOut === true) fields.timedOut = true;
    }
    return fields;
  } catch {
    return { causeCode: 'IAM_INTERNAL' };
  }
}

export function createSessionRenewalLogger({ home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), warn = () => {} } = {}) {
  const directory = join(resolve(home), 'logs');
  const path = join(directory, 'forge-iam-session-renewal.jsonl');
  const hostId = randomUUID();
  let writes = Promise.resolve();
  let warned = false;
  function warnOnce() {
    if (warned) return;
    warned = true;
    try { warn(); } catch { /* diagnostics cannot change the session */ }
  }

  return (event, fields = {}) => {
    if (!events.has(event)) return;
    try {
      const row = { time: new Date().toISOString(), event, hostId, pid: process.pid, pluginVersion: manifest.version };
      for (const [key, allowed] of Object.entries(enums)) {
        if (allowed.includes(fields[key])) row[key] = fields[key];
      }
      for (const key of numbers) {
        if (Number.isSafeInteger(fields[key])) row[key] = fields[key];
      }
      for (const key of flags) {
        if (typeof fields[key] === 'boolean') row[key] = fields[key];
      }
      const { httpStatus } = fields;
      if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) row.httpStatus = httpStatus;
      const line = `${JSON.stringify(row)}\n`;
      // Keep events ordered within this Host and keep log I/O out of renewal and storage locks.
      writes = writes.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
        warned = false;
      }).catch(warnOnce);
    } catch {
      warnOnce();
    }
  };
}
