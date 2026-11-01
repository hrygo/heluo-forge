import { isDeepStrictEqual } from 'node:util';
import { parseGrant, validateGrant } from './record.mjs';

const TOMBSTONE = Object.freeze({ kind: 'grant', payload: Object.freeze({ version: 1, type: 'heluo-iam-session-tombstone' }) });
const isTombstone = (record) => isDeepStrictEqual(record, TOMBSTONE);

export const GRANT_KEY = 'heluo-iam/session';
export const GATEWAY_REF = 'ENTERPRISE_STATIC_KEY';
// The credentials seam defines exactly two record kinds (`api-key`, `grant`);
// a `grant` payload is owner-opaque, so the non-secret metadata uses it rather
// than inventing a third kind that other providers would reject.
export const GATEWAY_RECORD_KEY = 'heluo-iam/gateway-credential';
const GATEWAY_RECORD_KIND = 'grant';
/** V0.3.x releases mirrored the IAM access token here; V1 no longer writes it. */
export const LEGACY_TOKEN_REF = 'ENTERPRISE_ACCESS_TOKEN';

/** UAG personal credentials are `uag-` plus 128 bits of lowercase hex. */
const GATEWAY_VALUE_PATTERN = /^uag-[0-9a-f]{32}$/i;
const GATEWAY_VERSION = 1;

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

function assertCredentials(credentials) {
  for (const method of ['readRecord', 'modifyRecord', 'deleteRecord', 'set', 'unset', 'resolve', 'listRecords']) {
    if (typeof credentials?.[method] !== 'function') {
      throw new StoreError('IAM_CREDENTIALS_UNAVAILABLE', `credentials.${method} is required`);
    }
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Host-only adapter around the IAM grant record. It owns only its own record
 * key and never enumerates or mutates other owners' records.
 *
 * @param {object} credentials
 * @param {{ key?: string }} [options]
 */
export function createGrantStore(credentials, options = {}) {
  assertCredentials(credentials);
  const key = options.key ?? GRANT_KEY;

  function atomicVerified() {
    try {
      if (typeof options.verifyAtomicStore !== 'function') return false;
      const result = options.verifyAtomicStore(credentials);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      return result === true;
    } catch {
      return false;
    }
  }

  async function read() {
    const record = await credentials.readRecord(key);
    if (record === undefined || record === null || isTombstone(record)) return { ok: true, grant: null };
    if (record.kind !== 'grant') {
      return { ok: false, reason: 'wrong-kind', kind: record.kind };
    }
    const parsed = parseGrant(record.payload);
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid-grant', errors: parsed.errors };
    }
    return { ok: true, grant: parsed.value };
  }

  return {
    key,
    read,

    // The optional synchronous guard runs under modifyRecord's lock; only an
    // explicit true permits a write. A thrown error is propagated unchanged.
    async write(grant, { guard } = {}) {
      const validation = validateGrant(grant);
      if (!validation.ok) {
        throw new StoreError('IAM_GRANT_INVALID', 'refusing to store an invalid IAM grant', {
          errors: validation.errors,
        });
      }
      const written = await credentials.modifyRecord(key, async (current) => {
        if (guard !== undefined && (typeof guard !== 'function' || guard() !== true)) {
          throw new StoreError('IAM_GRANT_WRITE_REJECTED', 'grant write guard rejected the write');
        }
        if (current !== undefined && current !== null && current.kind !== 'grant') {
          throw new StoreError('IAM_RECORD_KIND_MISMATCH', 'existing IAM record is not a grant');
        }
        return { kind: 'grant', payload: validation.value };
      });
      return { ok: true, record: written };
    },

    /**
     * Cross-process read-decide-replace for refresh. The mutator runs inside
     * CredentialProvider.modifyRecord's lock; returning undefined leaves the
     * record untouched.
     */
    async mutate(mutator) {
      if (typeof mutator !== 'function') {
        throw new StoreError('IAM_MUTATOR_INVALID', 'mutate requires a function');
      }
      const written = await credentials.modifyRecord(key, async (current) => {
        let grant = null;
        if (current !== undefined && current !== null && !isTombstone(current)) {
          if (current.kind !== 'grant') {
            throw new StoreError('IAM_RECORD_KIND_MISMATCH', 'existing IAM record is not a grant');
          }
          const parsed = parseGrant(current.payload);
          if (!parsed.ok) {
            throw new StoreError('IAM_GRANT_INVALID', 'stored IAM grant is invalid', { errors: parsed.errors });
          }
          grant = parsed.value;
        }
        const next = await mutator(grant);
        if (next === undefined) return undefined;
        const validation = validateGrant(next);
        if (!validation.ok) {
          throw new StoreError('IAM_GRANT_INVALID', 'refusing to store an invalid IAM grant', {
            errors: validation.errors,
          });
        }
        return { kind: 'grant', payload: validation.value };
      });
      return { ok: true, record: written };
    },

    /**
     * Replace the exact sign-out snapshot under the same record lock that
     * selects and revokes it. An unknown result must never trigger a delete.
     */
    async signOutSnapshot(expected, beforeClear) {
      if (!atomicVerified() || typeof beforeClear !== 'function'
        || (expected !== null && !validateGrant(expected).ok)) return { ok: false };
      let called = false;
      let decision;
      let expectedResult;
      try {
        const result = await credentials.modifyRecord(key, async (current) => {
          if (!atomicVerified()) throw new Error('atomic store no longer verified');
          if (called) throw new Error('mutator called more than once');
          called = true;
          if (current == null || isTombstone(current)) {
            decision = expected === null ? 'absent' : 'replaced';
            expectedResult = current;
            return undefined;
          }
          if (current.kind !== 'grant') throw new Error('invalid record');
          const parsed = parseGrant(current.payload);
          if (!parsed.ok) throw new Error('invalid grant');
          if (!isDeepStrictEqual(parsed.value, expected)) {
            decision = 'replaced';
            expectedResult = current;
            return undefined;
          }
          if (parsed.value.refreshOperation?.state === 'pending') {
            decision = 'pending';
            expectedResult = current;
            return undefined;
          }
          await beforeClear(parsed.value);
          if (!atomicVerified()) throw new Error('atomic store no longer verified');
          decision = 'cleared';
          expectedResult = TOMBSTONE;
          return { kind: 'grant', payload: { ...TOMBSTONE.payload } };
        });
        return atomicVerified() && called && decision && isDeepStrictEqual(result, expectedResult)
          ? { ok: true, decision } : { ok: false };
      } catch {
        return { ok: false };
      }
    },

    /** Replace only this callback's identified session under the provider lock. */
    async discardCallbackGrant(expected) {
      const valid = validateGrant(expected);
      if (!valid.ok || !expected.sessionInstanceId || !atomicVerified()) return { ok: false };
      let called = false;
      let decision;
      let expectedResult;
      try {
        const result = await credentials.modifyRecord(key, (current) => {
          if (!atomicVerified()) throw new Error('atomic store no longer verified');
          called = true;
          if (current == null || isTombstone(current)) {
            decision = 'absent';
            expectedResult = current;
            return undefined;
          }
          if (current.kind !== 'grant') throw new Error('invalid record');
          const parsed = parseGrant(current.payload);
          if (!parsed.ok || !parsed.value.sessionInstanceId) throw new Error('unattributable grant');
          if (parsed.value.sessionInstanceId !== expected.sessionInstanceId) {
            decision = 'replaced';
            expectedResult = current;
            return undefined;
          }
          for (const field of ['issuer', 'subject', 'clientId', 'resource', 'obtainedAt']) {
            if (parsed.value[field] !== expected[field]) throw new Error('grant context mismatch');
          }
          decision = 'discarded';
          expectedResult = TOMBSTONE;
          return { kind: 'grant', payload: { ...TOMBSTONE.payload } };
        });
        return atomicVerified() && called && decision && isDeepStrictEqual(result, expectedResult)
          ? { ok: true, decision } : { ok: false };
      } catch {
        return { ok: false };
      }
    },

    async clear() {
      const errors = [];
      try {
        await credentials.deleteRecord(key);
      } catch (error) {
        errors.push({ step: 'delete-record', error });
      }
      return { ok: errors.length === 0, errors };
    },

    /**
     * One-shot cleanup for values written by V0.3.x releases. Signing out no
     * longer derives a model credential, so a leftover access token would only
     * remain as a stale secret (and a bypass if a composition still resolved it).
     */
    async clearLegacyToken() {
      try {
        await credentials.unset(LEGACY_TOKEN_REF);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },

    /**
     * Find official-account leftovers without reading or deleting them. The UI
     * decides whether to prompt; this adapter never silently removes data.
     */
    async findLegacyRecords() {
      const entries = await credentials.listRecords();
      const loginKeys = new Set(['deepseek-account/default', 'deepseek-account-platform/default']);
      return entries
        .map((entry) => String(entry.key))
        .filter((key) => loginKeys.has(key));
    },
  };
}

function parseGatewayCredential(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['gateway credential must be an object'] };
  }
  const errors = [];
  if (payload.version !== GATEWAY_VERSION) errors.push(`gateway credential version must be ${GATEWAY_VERSION}`);
  for (const field of ['ownerSubject', 'enteredAt']) {
    if (!isNonEmptyString(payload[field])) errors.push(`gateway credential ${field} must be a non-empty string`);
  }
  for (const field of ['deviceLabel', 'suggestedExpiry']) {
    if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') {
      errors.push(`gateway credential ${field} must be a string when present`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: payload };
}

/**
 * Gateway personal credential. The secret lives in `ENTERPRISE_STATIC_KEY`
 * because `llm-pi-ai` resolves that reference per request; the non-secret
 * metadata (owner, device, timestamps) lives in a record, because references
 * carry values only.
 *
 * @param {object} credentials
 * @param {{ key?: string, ref?: string }} [options]
 */
export function createGatewayCredentialStore(credentials, options = {}) {
  assertCredentials(credentials);
  const key = options.key ?? GATEWAY_RECORD_KEY;
  const ref = options.ref ?? GATEWAY_REF;

  async function read() {
    const record = await credentials.readRecord(key);
    if (record === undefined || record === null) return { ok: true, credential: null };
    if (record.kind !== GATEWAY_RECORD_KIND) {
      return { ok: false, reason: 'wrong-kind', kind: record.kind };
    }
    const parsed = parseGatewayCredential(record.payload);
    if (!parsed.ok) return { ok: false, reason: 'invalid-credential', errors: parsed.errors };
    return { ok: true, credential: parsed.value };
  }

  return {
    key,
    ref,
    read,

    /**
     * Only this provider's stored value counts: an ambient environment value
     * must not make the account page claim the user configured a credential.
     */
    async resolve() {
      const resolved = await credentials.resolve(ref);
      return resolved && isNonEmptyString(resolved.value)
        ? { value: resolved.value, source: resolved.source ?? null }
        : undefined;
    },

    async save({ value, ownerSubject, deviceLabel, enteredAt, suggestedExpiry }) {
      if (typeof value !== 'string' || !GATEWAY_VALUE_PATTERN.test(value)) {
        throw new StoreError('IAM_GATEWAY_KEY_INVALID', 'gateway credential must be uag- plus 32 hexadecimal digits');
      }
      if (!isNonEmptyString(ownerSubject)) {
        throw new StoreError('IAM_GATEWAY_OWNER_MISSING', 'a gateway credential needs the signed-in subject');
      }
      const payload = {
        version: GATEWAY_VERSION,
        ownerSubject,
        enteredAt,
        ...(deviceLabel ? { deviceLabel } : {}),
        ...(suggestedExpiry ? { suggestedExpiry } : {}),
      };
      // Metadata first: a crash between the two writes leaves a record whose
      // value is missing (visible, harmless) rather than a secret without an
      // owner (usable but invisible in the account page).
      await credentials.modifyRecord(key, async (current) => {
        if (current !== undefined && current !== null && current.kind !== GATEWAY_RECORD_KIND) {
          throw new StoreError('IAM_RECORD_KIND_MISMATCH', 'existing record is not a gateway credential');
        }
        return { kind: GATEWAY_RECORD_KIND, payload };
      });
      try {
        await credentials.set(ref, value);
      } catch (error) {
        await credentials.deleteRecord(key).catch(() => {});
        throw error;
      }
      return { ok: true, credential: payload };
    },

    /** Non-secret storage facts for the account page (source/writability). */
    async describe() {
      if (typeof credentials.describe !== 'function') return { configured: false, writable: false };
      try {
        return await credentials.describe(ref);
      } catch {
        return { configured: false, writable: false };
      }
    },

    async clear() {
      const errors = [];
      try {
        await credentials.unset(ref);
      } catch (error) {
        // The secret may still be present, so keep the metadata that says so.
        errors.push({ step: 'unset-ref', error });
        return { ok: false, errors };
      }
      try {
        await credentials.deleteRecord(key);
      } catch (error) {
        errors.push({ step: 'delete-record', error });
      }
      return { ok: errors.length === 0, errors };
    },
  };
}