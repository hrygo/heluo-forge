import { randomUUID } from 'node:crypto';
import { constants, writeFileSync } from 'node:fs';
import { appendFile, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import manifest from '../package.json' with { type: 'json' };
import { ERROR_STATUS } from './error-contract.mjs';
import { OAUTH_ERROR_CODES, OAUTH_ERROR_RESPONSE_CLASSES, OidcError } from './oidc.mjs';
import { STATES } from './state.mjs';

const LOG_FILE_NAME = 'forge-iam-session-renewal.jsonl';
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const MAX_PENDING_WRITES = 128;
const LOCK_WAIT_MS = 250;
const LOCK_RETRY_MS = 10;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
const pendingByPath = new Map();

const events = new Set([
  'host-start', 'host-stop', 'binding-changed', 'session-state', 'store-sync',
  'renewal-scheduled', 'renewal-fired', 'renewal-blocked', 'renewal-cancelled', 'renewal-resume', 'renewal-failed',
  'refresh-stage', 'refresh-claimed', 'refresh-shared', 'refresh-reused',
  'refresh-retry', 'refresh-failed', 'refresh-committed', 'refresh-adopted', 'refresh-handed-off',
]);
const codes = [
  ...Object.keys(ERROR_STATUS), 'CRED_LOCK_TIMEOUT', 'CRED_LOCK_LOST', 'CRED_LOCK_RECOVERY_FAILED',
  'CRED_KEY_INVALID', 'CRED_STORE_PERMISSIONS', 'CRED_STORE_READ_ONLY', 'CRED_STORE_UNAVAILABLE',
  'IAM_GRANT_INVALID', 'IAM_GRANT_WRITE_REJECTED', 'IAM_HTTP_ERROR', 'IAM_HTTP_UNAVAILABLE',
  'IAM_DISCOVERY_INVALID', 'IAM_DISCOVERY_ISSUER_MISMATCH', 'IAM_INVALID_RESPONSE', 'IAM_JWKS_INVALID',
  'IAM_JWKS_KEY_NOT_FOUND', 'IAM_TOKEN_RESPONSE_INVALID', 'IAM_ID_TOKEN_ALGORITHM', 'IAM_ID_TOKEN_SUBJECT',
  'IAM_ID_TOKEN_AT_HASH', 'IAM_ID_TOKEN_ISSUED_AT', 'IAM_ID_TOKEN_NOT_BEFORE',
  'IAM_ID_TOKEN_INVALID', 'IAM_ID_TOKEN_SIGNATURE', 'IAM_ID_TOKEN_ISSUER', 'IAM_ID_TOKEN_AUDIENCE',
  'IAM_ID_TOKEN_NONCE', 'IAM_ID_TOKEN_EXPIRED',
  'exclusive-violation', 'exclusive-check-unavailable',
];
const reasons = [
  'credentials-bound', 'credentials-unbound', 'atomic-store-bound', 'atomic-store-unbound', 'trusted-binding', 'hydration-failed',
  'disposed', 'replaced', 'session-inactive', 'session-changed', 'no-grant', 'refresh-pending',
  'refresh-unusable', 'deadline-unknown', 'deadline-passed', 'deadline-changed', 'retry-after-expiry', 'timer-before-due',
  'credentials-unavailable', 'provider-changed', 'atomic-store-unverified', 'stored-session-changed',
  'grant-invalid', 'grant-missing', 'sign-out-pending', 'preflight', 'claim-lock-timeout', 'claim-conflict', 'claim-unconfirmed',
  'rejected', 'rotation-missing', 'rotation-unchanged', 'commit-unconfirmed',
  'peer-pending', 'peer-timeout', 'peer-record-invalid', 'peer-complete', 'local-complete', 'local-pending-timeout',
  'peer-restored', 'request-unsent',
  'access-still-valid', 'store-read-failed', 'pending-window-ended', 'pending-result-unmatched', 'expired-recovery',
  'read-lock-timeout', 'store-read-recovered',
];
const enums = {
  state: STATES, previousState: STATES, reason: reasons, code: codes, causeCode: codes, oauthError: OAUTH_ERROR_CODES,
  oauthErrorResponse: OAUTH_ERROR_RESPONSE_CLASSES, clientAuthMethod: ['none', 'client_secret_basic', 'client_secret_post'],
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
      const { status, oauthError, oauthErrorResponse, requestUnsent, timedOut } = cause.details;
      if (Number.isInteger(status) && status >= 100 && status <= 599) fields.httpStatus = status;
      if (OAUTH_ERROR_CODES.includes(oauthError)) fields.oauthError = oauthError;
      else if (status === 401 && OAUTH_ERROR_RESPONSE_CLASSES.includes(oauthErrorResponse)) {
        fields.oauthErrorResponse = oauthErrorResponse;
      }
      if (requestUnsent === true) fields.requestUnsent = true;
      if (timedOut === true) fields.timedOut = true;
    }
    return fields;
  } catch {
    return { causeCode: 'IAM_INTERNAL' };
  }
}

async function drainWrites(path, pending) {
  while (pending.length) {
    await pending[0]();
    pending.shift();
  }
  pendingByPath.delete(path);
}

async function regularFile(path) {
  const file = await lstat(path).catch((cause) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
  if (file && (!file.isFile() || file.nlink !== 1)) throw new Error('invalid renewal log file type');
  return file;
}

async function withWriteLock(lockPath, write) {
  const { DatabaseSync } = await import('node:sqlite');
  // SQLite can remove an unexpected journal or WAL during open. This
  // coordinator never writes pages, so refuse to touch any such files.
  const [existing, ...companions] = await Promise.all(
    ['', '-journal', '-wal', '-shm'].map((suffix) => regularFile(`${lockPath}${suffix}`)),
  );
  if (companions.some(Boolean)) throw new Error('invalid renewal log coordinator');
  let marker = existing;
  if (!marker) {
    // Publish a private, empty file using an exclusive create. Open and close
    // together to avoid a pending file close releasing SQLite's POSIX locks.
    try { writeFileSync(lockPath, '', { flag: 'wx', mode: 0o600 }); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    marker = await regularFile(lockPath);
  }
  if (!marker || marker.size !== 0) throw new Error('invalid renewal log coordinator');

  // The file is a stable OS locking target. SQLite initializes the empty
  // database in memory and rolls it back on close. Process exit releases the lock.
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    db.exec('PRAGMA journal_mode = MEMORY');
    const deadline = performance.now() + LOCK_WAIT_MS;
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (cause) {
        const primaryCode = cause.errcode & 0xff;
        if (primaryCode !== SQLITE_BUSY && primaryCode !== SQLITE_LOCKED) throw cause;
        const wait = Math.min(LOCK_RETRY_MS, deadline - performance.now());
        if (wait <= 0) throw cause;
        await sleep(wait, undefined, { ref: false });
        if (performance.now() >= deadline) throw cause;
      }
    }
    await write();
  } finally {
    db.close();
  }
}

async function rotateIfNeeded(path, bytes, maxFileBytes) {
  const archive = `${path}.1`;
  const current = await regularFile(path);
  const previous = await regularFile(archive);
  // Logs created before retention was enabled may already exceed the limit.
  if (previous?.size > maxFileBytes) await unlink(archive);
  if (!current) return;
  if (current.size > maxFileBytes) await unlink(path);
  else if (current.size + bytes > maxFileBytes) await rename(path, archive);
}

export function createSessionRenewalLogger({
  home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), warn = () => {},
  maxFileBytes = MAX_LOG_FILE_BYTES, maxPending = MAX_PENDING_WRITES, append = appendFile,
} = {}) {
  const directory = join(resolve(home), 'logs');
  const queuePath = join(directory, LOG_FILE_NAME);
  const hostId = randomUUID();
  let warned = false;
  function warnOnce() {
    if (warned) return;
    warned = true;
    try { void Promise.resolve(warn()).catch(() => {}); } catch { /* diagnostics cannot change the session */ }
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
      const bytes = Buffer.byteLength(line);
      const pending = pendingByPath.get(queuePath) ?? [];
      if (pending.length >= maxPending) return warnOnce();
      if (bytes > maxFileBytes) return warnOnce();
      pending.push(async () => {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          // Resolve directory aliases inside the bounded queue so all writers
          // use the same physical log and coordinator paths.
          const outputDirectory = await realpath(directory);
          if (!(await lstat(outputDirectory)).isDirectory()) throw new Error('invalid renewal log directory');
          const path = join(outputDirectory, LOG_FILE_NAME);
          await withWriteLock(`${path}.lock.sqlite`, async () => {
            await rotateIfNeeded(path, bytes, maxFileBytes);
            await append(path, line, { encoding: 'utf8', flag: APPEND_FLAGS, mode: 0o600 });
          });
          warned = false;
        } catch {
          // Filesystem and rotation failures only affect diagnostics.
          warnOnce();
        }
      });
      // The per-path queue includes the in-flight write. Renewal and Host
      // shutdown do not await its drain.
      if (pending.length === 1) {
        pendingByPath.set(queuePath, pending);
        void drainWrites(queuePath, pending);
      }
    } catch {
      warnOnce();
    }
  };
}
