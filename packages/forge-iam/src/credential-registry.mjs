import { validateStorageRef } from '@heluo/forge-credentials-keychain';

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_STORAGE_REFS = new Set([
  'ENTERPRISE_STATIC_KEY',
  'ENTERPRISE_ACCESS_TOKEN',
]);

export class CredentialRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CredentialRegistryError';
    this.code = code;
    this.details = details;
  }
}

function normalizeEnvNames(allowlistedEnvNames, envKey) {
  const result = [];
  const seen = new Set();
  const candidates = Array.isArray(allowlistedEnvNames) ? allowlistedEnvNames : [];
  for (const name of candidates) {
    validateStorageRef(name);
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  if (!seen.has(envKey)) {
    result.push(envKey);
  }
  return Object.freeze(result);
}

/**
 * Domain-agnostic registry of extension credentials hosted on top of IAM's
 * isolated Vault key namespace. Extensions declare their own descriptor and
 * never receive direct Vault handles.
 */
export function createCredentialRegistry() {
  const entries = new Map();

  function registerExtensionCredential(descriptor) {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_INVALID', 'credential descriptor must be an object');
    }
    const {
      extensionId,
      storageRef,
      envKey,
      allowlistedEnvNames,
      detectRiskAndExternal,
    } = descriptor;

    if (typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_INVALID', 'extensionId must match ^[a-z][a-z0-9-]*$');
    }
    try {
      validateStorageRef(storageRef);
      validateStorageRef(envKey);
    } catch (cause) {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_INVALID', cause?.message ?? 'invalid credential reference', {
        extensionId,
        causeCode: cause?.code,
      });
    }
    if (RESERVED_STORAGE_REFS.has(storageRef)) {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_CONFLICT', 'storageRef uses a reserved IAM credential reference', {
        extensionId,
      });
    }
    if (detectRiskAndExternal !== undefined && typeof detectRiskAndExternal !== 'function') {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_INVALID', 'detectRiskAndExternal must be a function');
    }
    if (entries.has(extensionId)) {
      throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_DUPLICATE', `extensionId "${extensionId}" is already registered`, {
        extensionId,
      });
    }
    for (const existing of entries.values()) {
      if (existing.storageRef === storageRef) {
        throw new CredentialRegistryError('IAM_EXT_CREDENTIAL_CONFLICT', 'storageRef is already claimed by another extension', {
          extensionId,
        });
      }
    }

    const normalized = Object.freeze({
      extensionId,
      storageRef,
      envKey,
      allowlistedEnvNames: normalizeEnvNames(allowlistedEnvNames, envKey),
      detectRiskAndExternal: detectRiskAndExternal ?? null,
    });
    entries.set(extensionId, normalized);

    return () => {
      if (entries.get(extensionId) === normalized) {
        entries.delete(extensionId);
      }
    };
  }

  function get(extensionId) {
    return entries.get(extensionId) ?? null;
  }

  function list() {
    return Object.freeze(
      Array.from(entries.values()).sort((a, b) => a.extensionId.localeCompare(b.extensionId)),
    );
  }

  return Object.freeze({
    registerExtensionCredential,
    get,
    list,
  });
}

