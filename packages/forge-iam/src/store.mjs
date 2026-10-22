import { parseGrant, validateGrant } from './record.mjs';

export const GRANT_KEY = 'heluo-iam/session';
export const TOKEN_REF = 'ENTERPRISE_ACCESS_TOKEN';

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

/**
 * Host-only adapter around ctx.credentials. It owns only the IAM record key and
 * the mirror ref; it never enumerates or mutates other owners' records.
 *
 * @param {object} credentials
 * @param {{ key?: string, ref?: string }} [options]
 */
export function createGrantStore(credentials, options = {}) {
  assertCredentials(credentials);
  const key = options.key ?? GRANT_KEY;
  const ref = options.ref ?? TOKEN_REF;

  return {
    key,
    ref,

    async read() {
      const record = await credentials.readRecord(key);
      if (record === undefined || record === null) return { ok: true, grant: null };
      if (record.kind !== 'grant') {
        return { ok: false, reason: 'wrong-kind', kind: record.kind };
      }
      const parsed = parseGrant(record.payload);
      if (!parsed.ok) {
        return { ok: false, reason: 'invalid-grant', errors: parsed.errors };
      }
      return { ok: true, grant: parsed.value };
    },

    async write(grant) {
      const validation = validateGrant(grant);
      if (!validation.ok) {
        throw new StoreError('IAM_GRANT_INVALID', 'refusing to store an invalid IAM grant', {
          errors: validation.errors,
        });
      }
      const written = await credentials.modifyRecord(key, async (current) => {
        if (current !== undefined && current !== null && current.kind !== 'grant') {
          throw new StoreError('IAM_RECORD_KIND_MISMATCH', 'existing IAM record is not a grant');
        }
        return { kind: 'grant', payload: validation.value };
      });
      return { ok: true, record: written };
    },

    async clear() {
      const errors = [];
      try {
        await credentials.deleteRecord(key);
      } catch (error) {
        errors.push({ step: 'delete-record', error });
      }
      try {
        await credentials.unset(ref);
      } catch (error) {
        errors.push({ step: 'unset-mirror', error });
      }
      return { ok: errors.length === 0, errors };
    },

    async mirror(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new StoreError('IAM_TOKEN_EMPTY', 'refusing to mirror an empty access token');
      }
      await credentials.set(ref, token);
      return { ok: true };
    },

    async resolveMirror() {
      const resolved = await credentials.resolve(ref);
      return resolved?.value;
    },

    /**
     * Find official-account leftovers without reading or deleting them. The UI
     * decides whether to prompt; this adapter never silently removes data.
     */
    async findLegacyRecords() {
      const entries = await credentials.listRecords();
      return entries
        .filter((entry) => {
          const value = String(entry.key);
          return value.startsWith('deepseek-account/') || value.startsWith('deepseek-account-platform/');
        })
        .map((entry) => String(entry.key));
    },
  };
}