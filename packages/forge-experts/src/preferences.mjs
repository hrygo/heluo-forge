/**
 * Sole writer of personal expert enable/disable preferences in DSH storageDomain (P2 / P6 / P7).
 * Enforces SHA-256 scoped keys, strict record schema validation, serial write ordering,
 * short-lived editToken settlement, revocation reset, and fail-closed degradation on unknown outcomes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ExpertsError } from './errors.mjs';

export const STORAGE_DOMAIN_NAME = 'forge_experts';
export const STORAGE_DOMAIN_VERSION = 1;
export const PREFERENCES_TABLE = 'preferences';

/**
 * DSH `storageDomain.open` takes a DomainSpec whose `tables` is a record of
 * table name -> { valueSchema }. The runtime record validator is passed as
 * `valueSchema.parse`, which the domain facility calls on every read and write.
 */
function parseRecord(value) {
  const parsed = PreferenceRecordSchema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(`Invalid preference record: ${parsed.error}`);
    error.code = 'invalid-record';
    throw error;
  }
  return parsed.data;
}

export const PREFERENCES_DOMAIN_SPEC = Object.freeze({
  name: STORAGE_DOMAIN_NAME,
  version: STORAGE_DOMAIN_VERSION,
  tables: Object.freeze({
    [PREFERENCES_TABLE]: Object.freeze({ valueSchema: Object.freeze({ parse: parseRecord }) }),
  }),
});
const DEFAULT_EDIT_TOKEN_TTL_MS = 5 * 60 * 1000;

export function derivePreferenceKey({ instanceId, orgId, issuer, subject, expertId }) {
  return createHash('sha256')
    .update(JSON.stringify([instanceId, orgId, issuer, subject, expertId]))
    .digest('hex');
}

export const PreferenceRecordSchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Record must be a plain object' };
    }
    const allowedKeys = new Set(['schemaVersion', 'enabled', 'revision', 'authContinuityDigest', 'updatedAt']);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (value.schemaVersion !== 1) return { success: false, error: 'Unsupported schemaVersion' };
    if (typeof value.enabled !== 'boolean') return { success: false, error: 'enabled must be boolean' };
    if (!Number.isInteger(value.revision) || value.revision < 0) return { success: false, error: 'revision must be non-negative integer' };
    if (typeof value.authContinuityDigest !== 'string' || value.authContinuityDigest.trim().length === 0) {
      return { success: false, error: 'authContinuityDigest must be non-empty string' };
    }
    if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
      return { success: false, error: 'updatedAt must be ISO datetime string' };
    }
    return {
      success: true,
      data: Object.freeze({
        schemaVersion: 1,
        enabled: value.enabled,
        revision: value.revision,
        authContinuityDigest: value.authContinuityDigest,
        updatedAt: value.updatedAt,
      }),
    };
  },
});

export const PreferencePutBodySchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Body must be a plain object' };
    }
    const allowedKeys = new Set(['enabled', 'editToken']);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (typeof value.enabled !== 'boolean') return { success: false, error: 'enabled must be boolean' };
    if (typeof value.editToken !== 'string' || value.editToken.length < 16 || value.editToken.length > 256) {
      return { success: false, error: 'editToken must be 16..256 chars' };
    }
    return { success: true, data: Object.freeze({ enabled: value.enabled, editToken: value.editToken }) };
  },
});

export function createPreferencesStore(ports) {
  if (!ports || typeof ports.openStorageDomain !== 'function' || typeof ports.getScopeSnapshot !== 'function' || typeof ports.assertScopeCurrent !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'preferences store requires storageDomain and scope ports');
  }

  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const editTokenTtlMs = typeof ports.editTokenTtlMs === 'number' && ports.editTokenTtlMs > 0
    ? ports.editTokenTtlMs
    : DEFAULT_EDIT_TOKEN_TTL_MS;

  let domainHandle = null;
  let table = null;
  let closed = false;
  let degraded = false;
  let degradedReason = null;
  let viewVersion = 1;
  let writeChain = Promise.resolve();

  const pendingKeys = new Set();
  const editTokens = new Map();
  const settlements = new Map();
  const knownEnabledByScope = new Map();

  function scopeIndexKey(scope) {
    return JSON.stringify([scope.instanceId, scope.orgId, scope.issuer, scope.subject]);
  }

  function trackEnabled(scope, expertId, enabled) {
    const key = scopeIndexKey(scope);
    let set = knownEnabledByScope.get(key);
    if (!set) {
      set = new Set();
      knownEnabledByScope.set(key, set);
    }
    if (enabled) set.add(expertId);
    else set.delete(expertId);
  }

  function enqueue(task) {
    const next = writeChain.then(task, task);
    writeChain = next.then(() => {}, () => {});
    return next;
  }

  async function open() {
    if (domainHandle && !closed) return;
    closed = false;
    try {
      domainHandle = await ports.openStorageDomain(PREFERENCES_DOMAIN_SPEC);
      table = domainHandle.table(PREFERENCES_TABLE);
      degraded = false;
      degradedReason = null;
    } catch {
      domainHandle = null;
      table = null;
      degraded = true;
      degradedReason = 'storage_open_failed';
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage domain is unavailable', { retryable: true });
    }
  }

  async function close() {
    // Reject new reads/writes immediately while draining already-queued writes
    // before the domain handle is closed.
    closed = true;
    await writeChain.catch(() => {});
    editTokens.clear();
    settlements.clear();
    pendingKeys.clear();
    knownEnabledByScope.clear();
    if (domainHandle) {
      const closing = domainHandle;
      domainHandle = null;
      table = null;
      await closing.close?.();
    }
  }

  function invalidateScope(scopeEpoch) {
    for (const [token, meta] of editTokens.entries()) {
      if (meta.scopeEpoch !== scopeEpoch) editTokens.delete(token);
    }
    for (const [token, settled] of settlements.entries()) {
      if (settled.scopeEpoch !== scopeEpoch && settled.status !== 'pending') {
        settlements.delete(token);
      }
    }
    knownEnabledByScope.clear();
    viewVersion += 1;
  }

  async function readValidatedRecord(key) {
    if (closed || !table || degraded) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage is unavailable', { retryable: true });
    }
    let raw;
    try {
      raw = table.get(key);
    } catch {
      degraded = true;
      degradedReason = 'storage_read_failed';
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Failed to read preference record', { retryable: true });
    }
    if (raw === undefined || raw === null) return null;
    const parsed = PreferenceRecordSchema.safeParse(raw);
    if (!parsed.success) {
      degraded = true;
      degradedReason = `schema_mismatch:${parsed.error}`;
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Stored preference format is unrecognized; existing data preserved');
    }
    return parsed.data;
  }

  function effectiveState(record, currentAuthContinuityDigest) {
    if (!record) return { enabled: false, revision: 0, continuous: true };
    if (!currentAuthContinuityDigest || record.authContinuityDigest !== currentAuthContinuityDigest) {
      return { enabled: false, revision: record.revision, continuous: false };
    }
    return { enabled: record.enabled, revision: record.revision, continuous: true };
  }

  function pruneEditTokens() {
    const at = now();
    for (const [token, meta] of editTokens.entries()) {
      if (at < meta.expiresAt) continue;
      const settled = settlements.get(token);
      if (!meta.used || (settled && settled.status !== 'pending')) {
        editTokens.delete(token);
      }
    }
    for (const [token, settled] of settlements.entries()) {
      if (settled.status === 'pending') continue;
      if (at - (settled.settledAt ?? at) >= editTokenTtlMs) {
        settlements.delete(token);
      }
    }
  }

  function issueEditToken({ scope, scopeEpoch, expertId, authContinuityDigest, revision }) {
    if (!authContinuityDigest) return null;
    pruneEditTokens();
    const token = randomBytes(24).toString('hex');
    const expiresAt = now() + editTokenTtlMs;
    editTokens.set(token, {
      token,
      scope,
      scopeEpoch,
      expertId,
      authContinuityDigest,
      revision,
      expiresAt,
      used: false,
      targetEnabled: null,
    });
    return Object.freeze({ editToken: token, expiresAt: new Date(expiresAt).toISOString() });
  }

  async function get({ scope, scopeEpoch, expertId, authContinuityDigest }) {
    if (closed) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage is closing', { retryable: true });
    }
    const key = derivePreferenceKey({ ...scope, expertId });
    if (pendingKeys.has(key)) {
      return Object.freeze({ expertId, pending: true, viewVersion });
    }
    const record = await readValidatedRecord(key);
    const state = effectiveState(record, authContinuityDigest);
    trackEnabled(scope, expertId, state.enabled);
    const issued = authContinuityDigest
      ? issueEditToken({ scope, scopeEpoch, expertId, authContinuityDigest, revision: state.revision })
      : null;
    return Object.freeze({
      expertId,
      pending: false,
      enabled: state.enabled,
      revision: state.revision,
      viewVersion,
      ...(issued ? { editToken: issued.editToken, editTokenExpiresAt: issued.expiresAt } : {}),
    });
  }

  async function getEditSettlement({ scope, scopeEpoch, expertId, editToken, authContinuityDigest }) {
    if (closed) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage is closing', { retryable: true });
    }
    const settled = settlements.get(editToken);
    if (settled && settled.expertId === expertId && settled.scopeEpoch === scopeEpoch) {
      if (settled.status === 'pending') {
        return Object.freeze({ expertId, pending: true, settlement: 'pending', viewVersion });
      }
      const current = await get({ scope, scopeEpoch, expertId, authContinuityDigest });
      return Object.freeze({ ...current, settlement: settled.status });
    }
    const tokenMeta = editTokens.get(editToken);
    if (tokenMeta && tokenMeta.expertId === expertId && tokenMeta.scopeEpoch === scopeEpoch) {
      if (now() < tokenMeta.expiresAt) {
        return Object.freeze({ expertId, pending: true, settlement: 'pending', viewVersion });
      }
      editTokens.delete(editToken);
      const current = await get({ scope, scopeEpoch, expertId, authContinuityDigest });
      return Object.freeze({ ...current, settlement: 'not_executed' });
    }
    const current = await get({ scope, scopeEpoch, expertId, authContinuityDigest });
    return Object.freeze({ ...current, settlement: 'not_executed' });
  }

  async function setEnabled({ scope, scopeEpoch, expertId, enabled, editToken }) {
    if (closed || degraded || !table) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage is unavailable', { retryable: true });
    }
    const tokenMeta = editTokens.get(editToken);
    if (!tokenMeta || tokenMeta.expertId !== expertId) {
      const prev = settlements.get(editToken);
      if (prev && prev.expertId === expertId && prev.scopeEpoch === scopeEpoch) {
        if (prev.targetEnabled !== enabled) {
          throw new ExpertsError('EXPERT_REVISION_CONFLICT', 'Edit token already bound to a different target value');
        }
        if (prev.status === 'pending') {
          return Object.freeze({ status: 'pending', expertId, pending: true, viewVersion });
        }
        if (prev.status === 'saved') {
          return Object.freeze({ status: 'confirmed', expertId, enabled: prev.enabled, revision: prev.revision, viewVersion });
        }
      }
      throw new ExpertsError('EXPERT_EDIT_TOKEN_INVALID', 'Edit token is invalid or unrecognized');
    }
    if (tokenMeta.scopeEpoch !== scopeEpoch) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Edit token belongs to an older scope');
    }
    if (now() >= tokenMeta.expiresAt) {
      editTokens.delete(editToken);
      throw new ExpertsError('EXPERT_EDIT_TOKEN_EXPIRED', 'Edit token has expired');
    }
    if (tokenMeta.used) {
      if (tokenMeta.targetEnabled !== enabled) {
        throw new ExpertsError('EXPERT_REVISION_CONFLICT', 'Duplicate edit token requested a different target value');
      }
      const prev = settlements.get(editToken);
      if (prev?.status === 'pending') {
        return Object.freeze({ status: 'pending', expertId, pending: true, viewVersion });
      }
      if (prev?.status === 'saved') {
        return Object.freeze({ status: 'confirmed', expertId, enabled: prev.enabled, revision: prev.revision, viewVersion });
      }
      throw new ExpertsError('EXPERT_EDIT_TOKEN_INVALID', 'Edit token has already been settled');
    }

    tokenMeta.used = true;
    tokenMeta.targetEnabled = enabled;
    settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'pending', settledAt: now() });

    const key = derivePreferenceKey({ ...scope, expertId });
    // Mark before enqueueing: a second reader arriving while the write waits in
    // the queue must see "pending", never the previous confirmed value.
    pendingKeys.add(key);
    return enqueue(async () => {
      try {
        ports.assertScopeCurrent(scopeEpoch, scope);
        if (degraded || !table) {
          throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference storage is unavailable', { retryable: true });
        }
        const auth = await ports.verifyOrgCallable(scope, expertId);
        ports.assertScopeCurrent(scopeEpoch, scope);
        if (!auth?.callableInOrg || !auth.authContinuityDigest) {
          settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'not_executed', settledAt: now() });
          throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Employee no longer has org-level callable permission for this expert');
        }
        if (auth.authContinuityDigest !== tokenMeta.authContinuityDigest) {
          settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'not_executed', settledAt: now() });
          throw new ExpertsError('EXPERT_REVISION_CONFLICT', 'Authorization continuity changed; refresh before updating');
        }

        const existing = await readValidatedRecord(key);
        const current = effectiveState(existing, auth.authContinuityDigest);
        if (current.revision !== tokenMeta.revision) {
          settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'not_executed', settledAt: now() });
          throw new ExpertsError('EXPERT_REVISION_CONFLICT', 'Preference revision is stale');
        }

        if (current.continuous && current.enabled === enabled) {
          settlements.set(editToken, {
            expertId,
            scopeEpoch,
            targetEnabled: enabled,
            status: 'saved',
            enabled: current.enabled,
            revision: current.revision,
            settledAt: now(),
          });
          const nextToken = issueEditToken({ scope, scopeEpoch, expertId, authContinuityDigest: auth.authContinuityDigest, revision: current.revision });
          return Object.freeze({
            status: 'confirmed',
            expertId,
            enabled: current.enabled,
            revision: current.revision,
            viewVersion,
            editToken: nextToken.editToken,
          });
        }

        const nextRecord = {
          schemaVersion: 1,
          enabled,
          revision: current.revision + 1,
          authContinuityDigest: auth.authContinuityDigest,
          updatedAt: new Date(now()).toISOString(),
        };
        const validated = PreferenceRecordSchema.safeParse(nextRecord);
        if (!validated.success) {
          throw new ExpertsError('EXPERT_INTERNAL_ERROR', `Invalid record payload: ${validated.error}`);
        }

        try {
          await table.put(key, validated.data);
        } catch (error) {
          if (error?.outcome === 'unknown' || error?.code === 'EXPERT_PREF_SAVE_UNKNOWN') {
            degraded = true;
            degradedReason = 'write_outcome_unknown';
            settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'pending', settledAt: now() });
            throw new ExpertsError('EXPERT_PREF_SAVE_UNKNOWN', 'Preference save outcome is unknown; read back to reconcile', { retryable: true });
          }
          settlements.set(editToken, { expertId, scopeEpoch, targetEnabled: enabled, status: 'not_executed', settledAt: now() });
          throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Preference write failed before confirmation', { retryable: true });
        }

        ports.assertScopeCurrent(scopeEpoch, scope);
        trackEnabled(scope, expertId, validated.data.enabled);
        viewVersion += 1;
        settlements.set(editToken, {
          expertId,
          scopeEpoch,
          targetEnabled: enabled,
          status: 'saved',
          enabled: validated.data.enabled,
          revision: validated.data.revision,
          settledAt: now(),
        });
        ports.onPreferenceChanged?.({ scopeEpoch, expertId, viewVersion });
        const nextToken = issueEditToken({
          scope,
          scopeEpoch,
          expertId,
          authContinuityDigest: auth.authContinuityDigest,
          revision: validated.data.revision,
        });
        return Object.freeze({
          status: 'confirmed',
          expertId,
          enabled: validated.data.enabled,
          revision: validated.data.revision,
          viewVersion,
          editToken: nextToken.editToken,
        });
      } finally {
        pendingKeys.delete(key);
      }
    });
  }

  async function reconcileRevocation({ scope, scopeEpoch, expertId, callableInOrg, authContinuityDigest }) {
    if (callableInOrg && authContinuityDigest) return { invalidated: false };
    for (const [token, meta] of editTokens.entries()) {
      if (meta.expertId === expertId && meta.scopeEpoch === scopeEpoch) editTokens.delete(token);
    }
    if (closed || !table || degraded) return { invalidated: true };
    const key = derivePreferenceKey({ ...scope, expertId });
    return enqueue(async () => {
      if (closed || !table || degraded) return { invalidated: true };
      const existing = await readValidatedRecord(key).catch((error) => {
        if (error?.code === 'EXPERT_STORAGE_UNAVAILABLE') return null;
        throw error;
      });
      if (!existing || existing.enabled === false) return { invalidated: false };
      const resetRecord = {
        schemaVersion: 1,
        enabled: false,
        revision: existing.revision + 1,
        authContinuityDigest: `revoked:${existing.revision + 1}`,
        updatedAt: new Date(now()).toISOString(),
      };
      try {
        await table.put(key, resetRecord);
      } catch (error) {
        degraded = true;
        degradedReason = error?.outcome === 'unknown' || error?.code === 'EXPERT_PREF_SAVE_UNKNOWN'
          ? 'revocation_write_outcome_unknown'
          : 'revocation_write_failed';
        trackEnabled(scope, expertId, false);
        viewVersion += 1;
        ports.onPreferenceChanged?.({ scopeEpoch, expertId, viewVersion });
        return { invalidated: true, degraded: true };
      }
      trackEnabled(scope, expertId, false);
      viewVersion += 1;
      ports.onPreferenceChanged?.({ scopeEpoch, expertId, viewVersion });
      return { invalidated: true, revision: resetRecord.revision };
    });
  }

  function isPending({ scope, expertId }) {
    return pendingKeys.has(derivePreferenceKey({ ...scope, expertId }));
  }

  async function listConfirmedEnabled({ scope, expertIds = null }) {
    if (closed || !table || degraded) return [];
    const ids = Array.isArray(expertIds) ? expertIds : [...(knownEnabledByScope.get(scopeIndexKey(scope)) ?? [])];
    const results = [];
    for (const expertId of ids) {
      const key = derivePreferenceKey({ ...scope, expertId });
      if (pendingKeys.has(key)) continue;
      const record = await readValidatedRecord(key).catch(() => null);
      if (record && record.enabled === true) {
        results.push(Object.freeze({
          expertId,
          revision: record.revision,
          authContinuityDigest: record.authContinuityDigest,
        }));
      }
    }
    return results;
  }

  return Object.freeze({
    open,
    close,
    get,
    getEditSettlement,
    setEnabled,
    reconcileRevocation,
    invalidateScope,
    isPending,
    listConfirmedEnabled,
    isDegraded: () => degraded,
    getDegradedReason: () => degradedReason,
    getViewVersion: () => viewVersion,
  });
}
