import { ExtTokenStoreError } from './ext-token-store.mjs';

function filterAllowlistedEnv(allowlistedEnvNames, baseEnv, processEnv, excludedKey = null) {
  const result = {};
  for (const name of allowlistedEnvNames) {
    if (name === excludedKey) continue;
    const fromBase = baseEnv && typeof baseEnv === 'object' ? baseEnv[name] : undefined;
    const fromProcess = processEnv && typeof processEnv === 'object' ? processEnv[name] : undefined;
    const value = typeof fromBase === 'string' && fromBase.length > 0
      ? fromBase
      : (typeof fromProcess === 'string' && fromProcess.length > 0 ? fromProcess : undefined);
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function safeDetectRisk(descriptor, processEnv) {
  let detected = null;
  if (typeof descriptor.detectRiskAndExternal === 'function') {
    try {
      detected = descriptor.detectRiskAndExternal({ processEnv }) ?? null;
    } catch {
      detected = null;
    }
  }
  const envHitNames = Array.isArray(detected?.envHitNames)
    ? detected.envHitNames.filter((name) => typeof name === 'string' && descriptor.allowlistedEnvNames.includes(name))
    : descriptor.allowlistedEnvNames.filter((name) => typeof processEnv?.[name] === 'string' && processEnv[name].length > 0);
  const plaintextRisk = Boolean(detected?.plaintextRisk);
  const riskDetails = detected?.riskDetails && typeof detected.riskDetails === 'object' && !Array.isArray(detected.riskDetails)
    ? { ...detected.riskDetails }
    : null;
  return { envHitNames, plaintextRisk, riskDetails };
}

/**
 * Domain-agnostic service facade coordinating the extension credential registry,
 * owner-bound encrypted storage, sanitized status projections, and child-process
 * env resolution.
 */
export function createExtTokensService({ registry, store, getCurrentSubject, getProcessEnv = () => process.env }) {
  if (!registry || !store || typeof getCurrentSubject !== 'function') {
    throw new ExtTokenStoreError('IAM_INTERNAL', 'registry, store, and getCurrentSubject are required');
  }

  function requireDescriptor(extensionId) {
    const descriptor = registry.get(extensionId);
    if (!descriptor) {
      throw new ExtTokenStoreError('IAM_EXT_CREDENTIAL_NOT_FOUND', `extension "${extensionId}" is not registered`, {
        extensionId,
      });
    }
    return descriptor;
  }

  async function projectOne(descriptor) {
    const processEnv = getProcessEnv() ?? {};
    const currentSubject = getCurrentSubject() ?? null;
    const stored = await store.read({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
      currentSubject,
    });
    const risk = safeDetectRisk(descriptor, processEnv);

    let effectiveState = stored.state;
    if (stored.state === 'UNSET_NO_HOSTED' && risk.envHitNames.length > 0) {
      effectiveState = 'ENV_INHERITED';
    }

    return Object.freeze({
      extensionId: descriptor.extensionId,
      envKey: descriptor.envKey,
      state: effectiveState,
      hosted: effectiveState === 'HOSTED_ACTIVE',
      ownerMismatch: effectiveState === 'OWNER_MISMATCH',
      envInherited: effectiveState === 'ENV_INHERITED',
      pending: effectiveState === 'PENDING_WRITE',
      keychainUnavailable: effectiveState === 'KEYCHAIN_UNAVAILABLE',
      envHitNames: Object.freeze([...risk.envHitNames]),
      plaintextRisk: risk.plaintextRisk,
      riskDetails: risk.riskDetails,
      updatedAt: stored.updatedAt ?? null,
    });
  }

  async function listProjectedStatuses() {
    const descriptors = registry.list();
    return Object.freeze(await Promise.all(descriptors.map((descriptor) => projectOne(descriptor))));
  }

  async function saveToken({ extensionId, token }) {
    const descriptor = requireDescriptor(extensionId);
    const currentSubject = getCurrentSubject();
    if (typeof currentSubject !== 'string' || currentSubject.length === 0) {
      throw new ExtTokenStoreError('IAM_NOT_SIGNED_IN', 'sign in to enterprise IAM before saving an extension token', {
        extensionId,
      });
    }
    await store.save({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
      ownerSubject: currentSubject,
      token,
    });
    return projectOne(descriptor);
  }

  async function clearToken({ extensionId }) {
    const descriptor = requireDescriptor(extensionId);
    await store.clear({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
    });
    return projectOne(descriptor);
  }

  async function resolveChildEnv({ extensionId, baseEnv = undefined, processEnv = getProcessEnv() ?? {} }) {
    const descriptor = requireDescriptor(extensionId);
    const currentSubject = getCurrentSubject() ?? null;
    const stored = await store.read({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
      currentSubject,
    });

    if (stored.state === 'OWNER_MISMATCH') {
      throw new ExtTokenStoreError(
        'OWNER_MISMATCH',
        'hosted extension token belongs to a different enterprise account',
        { extensionId },
      );
    }
    if (stored.state === 'KEYCHAIN_UNAVAILABLE') {
      throw new ExtTokenStoreError('KEYCHAIN_UNAVAILABLE', 'hosted extension token could not be decrypted', {
        extensionId,
      });
    }
    if (stored.state === 'PENDING_WRITE') {
      throw new ExtTokenStoreError('PENDING_WRITE', 'hosted extension token write is still in progress', {
        extensionId,
      });
    }

    if (stored.state === 'HOSTED_ACTIVE') {
      const env = filterAllowlistedEnv(descriptor.allowlistedEnvNames, baseEnv, processEnv, descriptor.envKey);
      env[descriptor.envKey] = stored.token;
      return { state: 'HOSTED_ACTIVE', env };
    }

    const env = filterAllowlistedEnv(descriptor.allowlistedEnvNames, baseEnv, processEnv);
    const hasEnvHit = descriptor.allowlistedEnvNames.some((name) => typeof env[name] === 'string' && env[name].length > 0);
    return {
      state: hasEnvHit ? 'ENV_INHERITED' : 'UNSET_NO_HOSTED',
      env,
    };
  }

  return Object.freeze({
    listProjectedStatuses,
    saveToken,
    clearToken,
    resolveChildEnv,
  });
}

