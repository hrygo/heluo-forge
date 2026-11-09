import { normalizeGatewayBaseURL } from './model-options.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
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

const GATEWAY_VERSION = 2;
const GATEWAY_LEGACY_VERSION = 1;
const WRITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const valueDigest = (value) => createHash('sha256').update(value).digest('hex');
const gatewayTombstone = () => ({
  kind: GATEWAY_RECORD_KIND, payload: {
    version: GATEWAY_VERSION, type: 'heluo-iam-gateway-tombstone', writeOperationId: randomUUID(),
  }
});
const isGatewayTombstone = (record) => record?.kind === GATEWAY_RECORD_KIND
  && Object.keys(record).length === 2 && record.payload?.version === GATEWAY_VERSION
  && record.payload.type === 'heluo-iam-gateway-tombstone'
  && Object.keys(record.payload).length === 3 && typeof record.payload.writeOperationId === 'string'
  && WRITE_ID_PATTERN.test(record.payload.writeOperationId);

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
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => { });
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
    async mutate(mutator, { guard } = {}) {
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
        // Recheck after the async mutator, before returning a commit candidate.
        if (guard !== undefined && (typeof guard !== 'function' || guard() !== true)) {
          throw new StoreError('IAM_GRANT_WRITE_REJECTED', 'grant write guard rejected the write');
        }
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
      const snapshot = valid.value;
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
          if (parsed.value.sessionInstanceId !== snapshot.sessionInstanceId) {
            decision = 'replaced';
            expectedResult = current;
            return undefined;
          }
          for (const field of ['version', 'issuer', 'subject', 'clientId', 'resource', 'obtainedAt']) {
            if (parsed.value[field] !== snapshot[field]) throw new Error('grant context mismatch');
          }
          if (!isDeepStrictEqual(parsed.value.authContext, snapshot.authContext)) throw new Error('grant authentication context mismatch');
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
  if (![GATEWAY_LEGACY_VERSION, GATEWAY_VERSION].includes(payload.version)) errors.push('unsupported gateway credential version');
  for (const field of ['ownerSubject', 'enteredAt']) {
    if (!isNonEmptyString(payload[field])) errors.push(`gateway credential ${field} must be a non-empty string`);
  }
  for (const field of ['deviceLabel', 'suggestedExpiry', 'baseURL']) {
    if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') {
      errors.push(`gateway credential ${field} must be a string when present`);
    }
  }
  if (payload.baseURL !== undefined) {
    try { if (normalizeGatewayBaseURL(payload.baseURL, true) !== payload.baseURL) errors.push('invalid gateway address'); }
    catch { errors.push('invalid gateway address'); }
  }
  if (payload.version === GATEWAY_VERSION) {
    if (typeof payload.writeOperationId !== 'string' || !WRITE_ID_PATTERN.test(payload.writeOperationId)) errors.push('invalid gateway write generation');
    if (typeof payload.valueDigest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.valueDigest)) errors.push('invalid gateway value binding');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: payload };
}

/**
 * Host-only gateway storage. The SDK has no joint ref/record transaction, so
 * mutations require a separate composition-vouched private adapter. No default
 * adapter exists and no sequence of SDK writes is used as a fallback.
 *
 * The adapter supplies detached stored pairs (never environment fallbacks):
 * snapshot(scope) -> { record, value }; compareAndSwap(scope, expected, next,
 * guard) -> { ok: false } or { ok: true, snapshot: committedPair }. Full compare,
 * exactly one synchronous guard and both writes share one atomic commit.
 * This contract is not an existing credentials Service method.
 */
export function createGatewayCredentialStore(credentials, options = {}) {
  assertCredentials(credentials);
  const key = options.key ?? GATEWAY_RECORD_KEY;
  const ref = options.ref ?? GATEWAY_REF;
  const scope = Object.freeze({ recordKey: key, ref });
  const unknown = () => new StoreError('IAM_GATEWAY_WRITE_UNKNOWN', 'gateway mutation outcome is unconfirmed');
  const readOnly = () => new StoreError('IAM_GATEWAY_LEGACY_READ_ONLY', 'gateway data is read-only and is not migrated automatically');
  const changed = () => new StoreError('IAM_GATEWAY_CHANGED', 'gateway snapshot changed; no automatic retry is performed');

  function rejectAsync(value) {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => { });
      return true;
    }
    return false;
  }

  function requireAtomic() {
    try {
      if (typeof options.getGatewayAtomicStore !== 'function' || typeof options.verifyGatewayAtomicStore !== 'function') throw new Error('missing');
      const adapter = options.getGatewayAtomicStore(credentials);
      if (rejectAsync(adapter)) throw new Error('async adapter');
      const verified = options.verifyGatewayAtomicStore(credentials, adapter, scope);
      if (rejectAsync(verified) || verified !== true) throw new Error('unverified');
      if (typeof adapter?.snapshot !== 'function' || typeof adapter?.compareAndSwap !== 'function') throw new Error('invalid');
      return adapter;
    } catch {
      throw new StoreError('IAM_GATEWAY_ATOMIC_UNVERIFIED', 'joint gateway storage atomicity is not verified');
    }
  }

  async function snapshot(adapter) {
    try {
      const pair = await adapter.snapshot(scope);
      if (!pair || typeof pair !== 'object' || !Object.hasOwn(pair, 'record') || !Object.hasOwn(pair, 'value')
        || (pair.value !== undefined && typeof pair.value !== 'string')) throw new Error('invalid');
      return structuredClone({ record: pair.record, value: pair.value });
    } catch { throw unknown(); }
  }

  function assertMutable(pair) {
    if (pair.record === undefined && pair.value === undefined) return;
    if (isGatewayTombstone(pair.record) && pair.value === undefined) return;
    if (pair.record?.kind !== GATEWAY_RECORD_KIND) throw readOnly();
    const parsed = parseGatewayCredential(pair.record.payload);
    if (!parsed.ok || parsed.value.version !== GATEWAY_VERSION
      || !isNonEmptyString(pair.value)
      || parsed.value.valueDigest !== valueDigest(pair.value)) throw readOnly();
  }

  async function commit(adapter, expected, next, guard) {
    // Keep the comparison baselines private. Adapter argument normalization or
    // retained references must not redefine the original snapshot or intent.
    let requestedExpected;
    let requestedNext;
    try {
      requestedExpected = structuredClone(expected);
      requestedNext = structuredClone(next);
    } catch { throw unknown(); }
    let calls = 0;
    let permitted = false;
    let guardFailure;
    let hasGuardFailure = false;
    const admit = () => {
      try {
        if (++calls !== 1) throw unknown();
        if (requireAtomic() !== adapter) throw new StoreError('IAM_GATEWAY_ATOMIC_UNVERIFIED', 'gateway atomic adapter changed');
        const result = guard === undefined ? true : typeof guard === 'function' ? guard() : false;
        if (rejectAsync(result) || result !== true) throw changed();
        let argumentsMatch;
        try {
          argumentsMatch = isDeepStrictEqual(requestedExpected, expected) && isDeepStrictEqual(requestedNext, next);
        } catch { throw unknown(); }
        if (!argumentsMatch) throw unknown();
        permitted = true;
        return true;
      } catch (error) {
        hasGuardFailure = true;
        guardFailure = error instanceof Error ? error : changed();
        throw guardFailure;
      }
    };
    let receipt;
    try { receipt = await adapter.compareAndSwap(scope, requestedExpected, requestedNext, admit); }
    catch (error) {
      // The trusted transaction propagates this exact pre-commit rejection.
      // Other exceptions may have occurred after commit: never compensate.
      if (hasGuardFailure && error === guardFailure) throw error;
      throw unknown();
    }
    let receiptOk;
    let matches;
    try {
      receiptOk = receipt?.ok;
      matches = receiptOk === true && isDeepStrictEqual(receipt.snapshot, next);
    } catch { throw unknown(); }
    if (receiptOk === false && calls === 0) throw changed();
    if (receiptOk !== true || calls !== 1 || !permitted || hasGuardFailure || !matches) throw unknown();
    try { if (requireAtomic() !== adapter) throw unknown(); } catch { throw unknown(); }
  }

  async function read() {
    const record = await credentials.readRecord(key);
    if (record === undefined || record === null || isGatewayTombstone(record)) return { ok: true, credential: null };
    if (record.kind !== GATEWAY_RECORD_KIND) return { ok: false, reason: 'wrong-kind', kind: record.kind };
    const parsed = parseGatewayCredential(record.payload);
    if (!parsed.ok) return { ok: false, reason: 'invalid-credential', errors: parsed.errors };
    return { ok: true, credential: parsed.value };
  }

  return {
    key, ref, read,
    async resolve(credential) {
      const resolved = await credentials.resolve(ref);
      if (credential?.version === GATEWAY_VERSION && (!isNonEmptyString(resolved?.value)
        || valueDigest(resolved.value) !== credential.valueDigest)) return { invalid: true };
      return resolved && isNonEmptyString(resolved.value)
        ? { value: resolved.value, source: resolved.source ?? null } : undefined;
    },
    async save({ value, ownerSubject, deviceLabel, enteredAt, suggestedExpiry, baseURL }, { guard } = {}) {
      if (!isNonEmptyString(value)) {
        throw new StoreError('IAM_GATEWAY_KEY_INVALID', 'gateway credential must be a non-empty string');
      }
      if (!isNonEmptyString(ownerSubject)) throw new StoreError('IAM_GATEWAY_OWNER_MISSING', 'a gateway credential needs the signed-in subject');
      const payload = {
        version: GATEWAY_VERSION, ownerSubject, enteredAt,
        writeOperationId: randomUUID(), valueDigest: valueDigest(value),
        ...(deviceLabel ? { deviceLabel } : {}), ...(suggestedExpiry ? { suggestedExpiry } : {}),
        ...(baseURL ? { baseURL } : {}),
      };
      if (!parseGatewayCredential(payload).ok) throw new StoreError('IAM_REQUEST_INVALID', 'gateway metadata is invalid');
      const adapter = requireAtomic();
      const expected = await snapshot(adapter);
      assertMutable(expected);
      await commit(adapter, expected, { record: { kind: GATEWAY_RECORD_KIND, payload }, value }, guard);
      return { ok: true, credential: payload };
    },
    /** Underlying storage facts, not permission for gateway business writes. */
    async describe() {
      if (typeof credentials.describe !== 'function') return { configured: false, writable: false };
      try { return await credentials.describe(ref); }
      catch { return { configured: false, writable: false }; }
    },
    async clear({ guard } = {}) {
      const adapter = requireAtomic();
      const expected = await snapshot(adapter);
      assertMutable(expected);
      // Even an empty clear advances the generation, fencing older snapshots.
      await commit(adapter, expected, { record: gatewayTombstone(), value: undefined }, guard);
      return { ok: true };
    },
  };
}

export const MODEL_SELECTION_KEY = 'heluo-iam/model-selection';
const MODEL_SELECTION_VERSION = 1;
const MODEL_SELECTION_TYPE = 'heluo-iam-model-selection';
const MODEL_ID_PATTERN = /^[\w./:-]{1,200}$/u;
const MAX_SELECTED_MODELS = 200;
const THINKING_LEVEL_KEYS = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Keep only the override fields the runtime understands, dropping junk. */
function sanitizeModelOption(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const next = {};
  if (typeof input.name === 'string' && input.name.trim() && input.name.length <= 200) next.name = input.name.trim();
  for (const field of ['contextWindow', 'maxTokens']) {
    const value = input[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) next[field] = Math.round(value);
    else if (typeof value === 'string' && value.trim() && value.length <= 32) next[field] = value.trim();
  }
  if (Array.isArray(input.inputModalities)) {
    const modes = input.inputModalities.filter(mode => mode === 'text' || mode === 'image');
    if (modes.length > 0) next.inputModalities = [...new Set(modes)];
  }
  if (input.reasoningEfforts && typeof input.reasoningEfforts === 'object' && !Array.isArray(input.reasoningEfforts)) {
    const efforts = {};
    for (const [level, wire] of Object.entries(input.reasoningEfforts)) {
      if (!THINKING_LEVEL_KEYS.has(level)) continue;
      if (wire === null) efforts[level] = null;
      else if (typeof wire === 'string' && wire.trim() && wire.length <= 64) efforts[level] = wire.trim();
    }
    if (Object.keys(efforts).length > 0) next.reasoningEfforts = efforts;
  }
  return next;
}

/** A selection is valid only as a whole; a malformed one is ignored, never migrated. */
function parseModelSelection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.version !== MODEL_SELECTION_VERSION || payload.type !== MODEL_SELECTION_TYPE) return null;
  if (typeof payload.subject !== 'string' || payload.subject.length === 0) return null;
  const source = payload.models;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const ids = Object.keys(source);
  if (ids.length > MAX_SELECTED_MODELS) return null;
  const models = {};
  for (const id of ids) {
    if (!MODEL_ID_PATTERN.test(id)) return null;
    if (!source[id] || typeof source[id] !== 'object' || Array.isArray(source[id])) return null;
    models[id] = sanitizeModelOption(source[id]);
  }
  const defaultModelId = typeof payload.defaultModelId === 'string' && Object.hasOwn(models, payload.defaultModelId)
    ? payload.defaultModelId : null;
  return { subject: payload.subject, models, defaultModelId };
}

/**
 * Durable model selection: which catalogue models this person enabled, with
 * the per-model overrides they saved.
 *
 * Unlike the gateway credential this holds no secret, so it uses the plain
 * provider lock instead of the joint atomic transaction: last confirmed write
 * wins, and a failed write never blocks model calls. The record is scoped to
 * one subject; a record belonging to someone else is left untouched and simply
 * ignored, so signing in as another person never inherits their choices.
 */
export function createModelSelectionStore(credentials, options = {}) {
  assertCredentials(credentials);
  const key = options.key ?? MODEL_SELECTION_KEY;

  async function read() {
    let record;
    try { record = await credentials.readRecord(key); }
    catch (error) { return { ok: false, selection: null, error }; }
    if (record === undefined || record === null) return { ok: true, selection: null };
    // Never rewrite or delete a record this owner does not recognise.
    if (record.kind !== 'grant') return { ok: false, selection: null, error: new StoreError('IAM_MODEL_SELECTION_FOREIGN', 'stored record is not an IAM model selection') };
    const selection = parseModelSelection(record.payload);
    if (!selection) return { ok: false, selection: null, error: new StoreError('IAM_MODEL_SELECTION_INVALID', 'stored model selection is invalid') };
    return { ok: true, selection };
  }

  async function save({ subject, models, defaultModelId } = {}) {
    const selection = parseModelSelection({
      version: MODEL_SELECTION_VERSION, type: MODEL_SELECTION_TYPE, subject,
      models, defaultModelId: defaultModelId ?? null,
    });
    if (!selection) throw new StoreError('IAM_MODEL_SELECTION_INVALID', 'refusing to store an invalid model selection');
    let written;
    try {
      written = await credentials.modifyRecord(key, async (current) => {
        if (current !== undefined && current !== null && current.kind !== 'grant') {
          throw new StoreError('IAM_RECORD_KIND_MISMATCH', 'existing IAM record is not a grant');
        }
        return {
          kind: 'grant', payload: {
            version: MODEL_SELECTION_VERSION, type: MODEL_SELECTION_TYPE,
            subject: selection.subject, models: selection.models,
            defaultModelId: selection.defaultModelId, updatedAt: new Date().toISOString(),
          }
        };
      });
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('IAM_MODEL_SELECTION_UNWRITTEN', 'model selection was not stored', { cause: error?.code });
    }
    if (written === undefined || written === null) throw new StoreError('IAM_MODEL_SELECTION_UNWRITTEN', 'model selection was not stored');
    return { ok: true, selection };
  }

  async function clear() {
    try {
      const record = await credentials.readRecord(key);
      if (record === undefined || record === null) return { ok: true };
      if (record.kind !== 'grant') return { ok: false };
      await credentials.deleteRecord(key);
      return { ok: true };
    } catch { return { ok: false }; }
  }

  return { key, read, save, clear };
}
