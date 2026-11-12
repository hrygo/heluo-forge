import { NAMESPACE_PATTERN } from './backend.mjs';

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export class KeychainProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KeychainProviderError';
    this.code = code;
    this.details = details;
  }
}

function assertBackend(backend) {
  for (const method of ['get', 'set', 'delete', 'list']) {
    if (typeof backend?.[method] !== 'function') {
      throw new KeychainProviderError('KEYCHAIN_BACKEND_INVALID', `backend.${method} is required`);
    }
  }
  if (backend.available === false) {
    throw new KeychainProviderError('KEYCHAIN_UNAVAILABLE', backend.reason ?? 'keychain backend is unavailable');
  }
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw new KeychainProviderError('KEYCHAIN_REF_INVALID', 'credential ref must match the environment-variable grammar');
  }
  return ref;
}

function validateRecordKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new KeychainProviderError('KEYCHAIN_KEY_INVALID', 'credential key must be <scope>/<id>');
  }
  return key;
}

function validateNamespacePart(value, name) {
  if (typeof value !== 'string' || !NAMESPACE_PATTERN.test(value)) {
    throw new KeychainProviderError('KEYCHAIN_NAMESPACE_INVALID', `${name} is not a valid keychain namespace part`);
  }
  return value;
}

function decodeRecord(key, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored record ${key} is not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored record ${key} must be an object`);
  }
  if (value.kind === 'grant') {
    if (!('payload' in value)) {
      throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored grant ${key} has no payload`);
    }
    return { kind: 'grant', payload: value.payload };
  }
  if (value.kind === 'api-key') {
    if (value.key !== undefined && (typeof value.key !== 'string' || value.key.length === 0)) {
      throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored api-key ${key} has an empty key`);
    }
    if (value.env !== undefined) {
      if (value.env === null || typeof value.env !== 'object' || Array.isArray(value.env)) {
        throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored api-key ${key} has invalid env`);
      }
      for (const [name, envValue] of Object.entries(value.env)) {
        if (!REF_PATTERN.test(name) || typeof envValue !== 'string') {
          throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored api-key ${key} has invalid env entry`);
        }
      }
    }
    return { kind: 'api-key', ...(value.key === undefined ? {} : { key: value.key }), ...(value.env === undefined ? {} : { env: value.env }) };
  }
  throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', `stored record ${key} has an unknown kind`);
}

function encodeRecord(record) {
  if (record?.kind !== 'grant' && record?.kind !== 'api-key') {
    throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', 'record kind must be grant or api-key');
  }
  try {
    const encoded = JSON.stringify(record);
    return encoded;
  } catch {
    throw new KeychainProviderError('KEYCHAIN_RECORD_INVALID', 'record is not JSON serializable');
  }
}

/**
 * @param {object} backend
 * @param {{ service?: string, accountPrefix?: string, notifyReference?: (ref: string) => void | PromiseLike<void>, notifyRecord?: (key: string) => void | PromiseLike<void> }} [options]
 */
/**
 * Storage namespace shared by the provider and any joint store built on the
 * same backend. Both derive keys here so a joint commit can never address a
 * different namespace than the credential reads it replaces.
 */
export function namespacePrefixes(options = {}) {
  const service = validateNamespacePart(options.service ?? 'heluo-forge', 'service');
  const accountPrefix = validateNamespacePart(options.accountPrefix ?? 'iam', 'accountPrefix');
  const namespace = `${service}/${accountPrefix}`;
  return { namespace, refPrefix: `${namespace}/ref/`, recordPrefix: `${namespace}/record/` };
}

export function createKeychainProvider(backend, options = {}) {
  assertBackend(backend);
  const { namespace, refPrefix, recordPrefix } = namespacePrefixes(options);
  const source = backend.kind === 'memory' ? 'memory' : 'file';
  const locks = new Map();

  // Notifications are best-effort after a successful backend operation. Never
  // surface or log their errors: they may contain credential data.
  function notify(callback) {
    try {
      Promise.resolve(callback()).catch(() => {});
    } catch {
      // A notification cannot change the already committed backend result.
    }
  }

  function withKeyLock(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    return run.finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
  }

  return {
    kind: backend.kind,
    durable: backend.durable === true,
    // A method or self-reported flag is not evidence of cross-process trust.
    // IAM uses the separately registered composition service for that proof.
    crossProcessLock: false,

    async resolve(ref) {
      const value = await backend.get(`${refPrefix}${validateRef(ref)}`);
      return value === undefined || value === '' ? undefined : { value, source };
    },

    async describe(ref) {
      const resolved = await this.resolve(ref);
      return { configured: resolved !== undefined, ...(resolved ? { source } : {}), writable: true };
    },

    async set(ref, value) {
      validateRef(ref);
      if (typeof value !== 'string' || value.length === 0) {
        throw new KeychainProviderError('KEYCHAIN_VALUE_EMPTY', 'refusing to store an empty credential');
      }
      await backend.set(`${refPrefix}${ref}`, value);
      notify(() => options.notifyReference?.(ref));
    },

    async unset(ref) {
      await backend.delete(`${refPrefix}${validateRef(ref)}`);
      notify(() => options.notifyReference?.(ref));
    },

    async readRecord(key) {
      validateRecordKey(key);
      const raw = await backend.get(`${recordPrefix}${key}`);
      return raw === undefined ? undefined : decodeRecord(key, raw);
    },

    async describeRecord(key) {
      const record = await this.readRecord(key);
      return record === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind: record.kind, writable: true };
    },

    async listRecords() {
      // Backends that can hand back key and value together are read once for
      // the whole listing; the per-record fallback exists for stores that can
      // only enumerate names.
      const entries = typeof backend.listEntries === 'function'
        ? await backend.listEntries(recordPrefix)
        : (await backend.list(recordPrefix)).map((key) => ({ key }));
      const records = [];
      let foreign = 0;
      for (const entry of entries) {
        const suffix = String(entry.key ?? '').slice(recordPrefix.length);
        if (!KEY_PATTERN.test(suffix)) {
          // A key under our prefix that is not ours (another owner, a manual
          // edit) must not brick the listing: skip it and report the count.
          foreign += 1;
          continue;
        }
        const record = entry.value === undefined ? await this.readRecord(suffix) : decodeRecord(suffix, entry.value);
        if (record !== undefined) records.push({ key: suffix, kind: record.kind });
      }
      if (foreign > 0) notify(() => options.onForeignKeys?.({ count: foreign }));
      return records;
    },

    async modifyRecord(key, mutate) {
      validateRecordKey(key);
      if (typeof mutate !== 'function') {
        throw new KeychainProviderError('KEYCHAIN_MUTATOR_INVALID', 'modifyRecord requires a mutator');
      }
      return withKeyLock(key, async () => {
        const storageKey = `${recordPrefix}${key}`;
        const apply = async (current) => {
          const next = await mutate(current);
          if (next === undefined) return current;
          // Validate the exact bytes before writing: a rejected record must not
          // become durable and poison the shared credentials seam.
          const encoded = encodeRecord(next);
          const validated = decodeRecord(key, encoded);
          return validated;
        };
        if (typeof backend.transaction === 'function') {
          let changed = false;
          const validated = await backend.transaction(storageKey, async (tx) => {
            const raw = tx.get();
            const current = raw === undefined ? undefined : decodeRecord(key, raw);
            const next = await apply(current);
            if (next !== current) {
              tx.set(JSON.stringify(next));
              changed = true;
            }
            return next;
          });
          if (changed) notify(() => options.notifyRecord?.(key));
          return validated;
        }
        const current = await this.readRecord(key);
        const validated = await apply(current);
        if (validated === current) return current;
        await backend.set(storageKey, JSON.stringify(validated));
        notify(() => options.notifyRecord?.(key));
        return validated;
      });
    },

    async deleteRecord(key) {
      validateRecordKey(key);
      await withKeyLock(key, async () => {
        await backend.delete(`${recordPrefix}${key}`);
        notify(() => options.notifyRecord?.(key));
      });
    },

    async close() {
      await backend.close?.();
    },
  };
}
