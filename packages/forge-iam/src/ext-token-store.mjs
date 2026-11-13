import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GATEWAY_RECORD_KEY, GRANT_KEY } from './store.mjs';

const EXT_TOKEN_TYPE = 'heluo-iam-ext-token';
const EXT_TOKEN_VERSION = 1;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEAL_ALGORITHM = 'aes-256-gcm';

export class ExtTokenStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtTokenStoreError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Derive the isolated Vault record key for an extension credential.
 * Uses `<scope>/<id>` grammar (`heluo-iam/ext-token-<id>`) so it stays strictly
 * isolated from `heluo-iam/session` and `heluo-iam/gateway-credential`.
 */
export function extTokenRecordKey(extensionId) {
  if (typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new ExtTokenStoreError('IAM_EXT_CREDENTIAL_INVALID', 'extensionId must match ^[a-z][a-z0-9-]*$');
  }
  const key = `heluo-iam/ext-token-${extensionId}`;
  if (key === GRANT_KEY || key === GATEWAY_RECORD_KEY) {
    throw new ExtTokenStoreError('IAM_EXT_CREDENTIAL_CONFLICT', 'derived record key collides with reserved IAM record');
  }
  return key;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deriveOwnerKey(ownerSubject) {
  return createHash('sha256').update(`heluo-iam-ext-token-v1:${ownerSubject}`).digest();
}

function sealWithOwnerAad(tokenValue, ownerSubject, extensionId) {
  const iv = randomBytes(12);
  const key = deriveOwnerKey(ownerSubject);
  const aad = Buffer.from(`${extensionId}:${ownerSubject}`, 'utf8');
  const cipher = createCipheriv(SEAL_ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(tokenValue, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: EXT_TOKEN_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  });
}

function unsealWithOwnerAad(sealedText, ownerSubject, extensionId) {
  let parsed;
  try {
    parsed = JSON.parse(sealedText);
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== EXT_TOKEN_VERSION
    || typeof parsed.iv !== 'string' || typeof parsed.tag !== 'string' || typeof parsed.ct !== 'string') {
    return null;
  }
  try {
    const key = deriveOwnerKey(ownerSubject);
    const aad = Buffer.from(`${extensionId}:${ownerSubject}`, 'utf8');
    const decipher = createDecipheriv(SEAL_ALGORITHM, key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parsed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

function isKeychainFailure(cause) {
  const code = cause?.code;
  return code === 'CRED_KEY_UNAVAILABLE'
    || code === 'CRED_DECRYPT_FAILED'
    || code === 'CRED_STORE_UNAVAILABLE'
    || code === 'KEYCHAIN_UNAVAILABLE';
}

function assertCredentials(credentials) {
  for (const method of ['readRecord', 'modifyRecord', 'deleteRecord', 'set', 'unset', 'resolve']) {
    if (typeof credentials?.[method] !== 'function') {
      throw new ExtTokenStoreError('KEYCHAIN_UNAVAILABLE', `credentials.${method} is required`);
    }
  }
}

/**
 * Serialized CAS-queued storage for extension tokens bound to `ownerSubject`
 * via both metadata owner checks and AEAD AAD sealing.
 */
export function createExtTokenStore(credentials, options = {}) {
  assertCredentials(credentials);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const queues = new Map();
  const pendingCounts = new Map();

  function enqueue(extensionId, task) {
    pendingCounts.set(extensionId, (pendingCounts.get(extensionId) ?? 0) + 1);
    const prev = queues.get(extensionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      try {
        return await task();
      } finally {
        const nextCount = (pendingCounts.get(extensionId) ?? 1) - 1;
        if (nextCount <= 0) pendingCounts.delete(extensionId);
        else pendingCounts.set(extensionId, nextCount);
      }
    });
    queues.set(extensionId, run);
    // The tail must swallow the rejection: `finally` would hand back a rejected
    // promise nobody observes, and a failed save/clear would then surface as an
    // unhandled rejection and take the host process down.
    run.catch(() => {}).then(() => {
      if (queues.get(extensionId) === run) queues.delete(extensionId);
    });
    return run;
  }

  function isPending(extensionId) {
    return (pendingCounts.get(extensionId) ?? 0) > 0;
  }

  async function read({ extensionId, storageRef, currentSubject }) {
    const recordKey = extTokenRecordKey(extensionId);
    if (isPending(extensionId)) {
      return { state: 'PENDING_WRITE', ownerMismatch: false, updatedAt: null };
    }

    let record;
    try {
      record = await credentials.readRecord(recordKey);
    } catch (cause) {
      if (isKeychainFailure(cause)) {
        return { state: 'KEYCHAIN_UNAVAILABLE', ownerMismatch: false, updatedAt: null };
      }
      throw cause;
    }

    if (record === undefined) {
      return { state: 'UNSET_NO_HOSTED', ownerMismatch: false, updatedAt: null };
    }
    const payload = record?.kind === 'grant' ? record.payload : null;
    if (!payload || payload.type !== EXT_TOKEN_TYPE || payload.version !== EXT_TOKEN_VERSION
      || payload.extensionId !== extensionId || payload.storageRef !== storageRef
      || typeof payload.ownerSubject !== 'string' || payload.ownerSubject.length === 0
      || typeof payload.valueDigest !== 'string') {
      return { state: 'KEYCHAIN_UNAVAILABLE', ownerMismatch: false, updatedAt: null };
    }

    // Signed out is not "someone else's credential": there is no current subject
    // to compare against, and the two states need different user copy.
    if (typeof currentSubject !== 'string' || currentSubject.length === 0) {
      return { state: 'IAM_NOT_SIGNED_IN', ownerMismatch: false, updatedAt: payload.updatedAt ?? null };
    }
    if (payload.ownerSubject !== currentSubject) {
      return {
        state: 'OWNER_MISMATCH',
        ownerMismatch: true,
        updatedAt: payload.updatedAt ?? null,
      };
    }

    let resolved;
    try {
      resolved = await credentials.resolve(storageRef);
    } catch (cause) {
      if (isKeychainFailure(cause)) {
        return { state: 'KEYCHAIN_UNAVAILABLE', ownerMismatch: false, updatedAt: payload.updatedAt ?? null };
      }
      throw cause;
    }

    const sealed = resolved?.value;
    if (typeof sealed !== 'string' || sealed.length === 0) {
      return { state: 'KEYCHAIN_UNAVAILABLE', ownerMismatch: false, updatedAt: payload.updatedAt ?? null };
    }
    const token = unsealWithOwnerAad(sealed, currentSubject, extensionId);
    if (!token || sha256Hex(token) !== payload.valueDigest) {
      return { state: 'KEYCHAIN_UNAVAILABLE', ownerMismatch: false, updatedAt: payload.updatedAt ?? null };
    }

    return {
      state: 'HOSTED_ACTIVE',
      ownerMismatch: false,
      updatedAt: payload.updatedAt ?? null,
      token,
    };
  }

  async function save({ extensionId, storageRef, ownerSubject, token }) {
    const recordKey = extTokenRecordKey(extensionId);
    if (typeof ownerSubject !== 'string' || ownerSubject.length === 0) {
      throw new ExtTokenStoreError('IAM_NOT_SIGNED_IN', 'signed-in ownerSubject is required to host an extension token');
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ExtTokenStoreError('IAM_EXT_TOKEN_INVALID', 'extension token must be a non-empty string');
    }

    return enqueue(extensionId, async () => {
      const sealed = sealWithOwnerAad(token, ownerSubject, extensionId);
      const updatedAt = now();
      const digest = sha256Hex(token);
      // The ciphertext ref and the metadata record are two writes, so a failed
      // metadata write must not leave the new ciphertext behind: restore the
      // previous value (or remove the ref) before rethrowing.
      let previousSealed;
      try {
        previousSealed = (await credentials.resolve(storageRef))?.value;
      } catch {
        previousSealed = undefined;
      }
      const restorePrevious = async () => {
        try {
          if (typeof previousSealed === 'string' && previousSealed.length > 0) {
            await credentials.set(storageRef, previousSealed);
          } else {
            await credentials.unset(storageRef);
          }
        } catch {
          // A failed rollback must not mask the original write error. The record
          // digest check keeps the credential unusable until the user retries.
        }
      };
      try {
        await credentials.set(storageRef, sealed);
        await credentials.modifyRecord(recordKey, () => ({
          kind: 'grant',
          payload: {
            version: EXT_TOKEN_VERSION,
            type: EXT_TOKEN_TYPE,
            extensionId,
            storageRef,
            ownerSubject,
            valueDigest: digest,
            updatedAt,
          },
        }));
      } catch (cause) {
        await restorePrevious();
        if (isKeychainFailure(cause)) {
          throw new ExtTokenStoreError('KEYCHAIN_UNAVAILABLE', 'credential storage is unavailable');
        }
        throw cause;
      }
      return { state: 'HOSTED_ACTIVE', updatedAt };
    });
  }

  async function clear({ extensionId, storageRef }) {
    const recordKey = extTokenRecordKey(extensionId);
    return enqueue(extensionId, async () => {
      try {
        await credentials.deleteRecord(recordKey);
      } catch (cause) {
        if (isKeychainFailure(cause)) {
          throw new ExtTokenStoreError('KEYCHAIN_UNAVAILABLE', 'credential storage is unavailable');
        }
        throw cause;
      }
      // The record is the source of truth: once it is gone `read()` reports
      // UNSET_NO_HOSTED and never looks at the ciphertext again. A failed unset
      // therefore leaves nothing reachable, and reporting the whole clear as
      // failed would tell the person the opposite of what happened.
      try {
        await credentials.unset(storageRef);
      } catch {
        // Dead ciphertext is harmless: the next save overwrites the same ref.
      }
      return { state: 'UNSET_NO_HOSTED', updatedAt: null };
    });
  }

  return Object.freeze({
    read,
    save,
    clear,
    isPending,
  });
}
