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
export function createExtTokensService({ registry, store, getCurrentSubject, getSessionRef, getProcessEnv = () => process.env }) {
  if (!registry || !store || typeof getCurrentSubject !== 'function') {
    throw new ExtTokenStoreError('IAM_INTERNAL', 'registry, store, and getCurrentSubject are required');
  }

  /**
   * 会话引用：subject + 一个标识「这是哪一次会话」的 epoch。
   *
   * 只认缓存里的 `ready` 不够：解析令牌是异步的，读存储期间用户可能已经登出。
   * 调用方给出 epoch 时，本服务在读出令牌前后各取一次快照；两次不一致就当作
   * 已登出，绝不把登出会话的令牌交给子进程。没给 epoch 的旧调用按 subject 比较。
   */
  function readSessionRef() {
    if (typeof getSessionRef === 'function') {
      const ref = getSessionRef();
      if (ref && typeof ref === 'object' && typeof ref.subject === 'string' && ref.subject.length > 0) {
        return { subject: ref.subject, epoch: typeof ref.epoch === 'string' ? ref.epoch : ref.subject };
      }
      return null;
    }
    const subject = getCurrentSubject();
    return typeof subject === 'string' && subject.length > 0 ? { subject, epoch: subject } : null;
  }

  function sameSession(before, after) {
    return Boolean(before) && Boolean(after) && before.subject === after.subject && before.epoch === after.epoch;
  }

  function requireSession() {
    const ref = readSessionRef();
    if (!ref) {
      throw new ExtTokenStoreError('IAM_NOT_SIGNED_IN', 'sign in to enterprise IAM before using hosted extension tokens');
    }
    return ref;
  }

  function assertSessionUnchanged(before) {
    if (!sameSession(before, readSessionRef())) {
      throw new ExtTokenStoreError('IAM_NOT_SIGNED_IN', 'the IAM session ended while the extension credential was in flight');
    }
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
      signedOut: effectiveState === 'IAM_NOT_SIGNED_IN',
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
    const session = requireSession();
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
    const session = requireSession();
    await store.clear({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
    });
    return projectOne(descriptor);
  }

  async function resolveChildEnv({ extensionId, baseEnv = undefined, processEnv = getProcessEnv() ?? {} }) {
    const descriptor = requireDescriptor(extensionId);
    const session = readSessionRef();
    const stored = await store.read({
      extensionId: descriptor.extensionId,
      storageRef: descriptor.storageRef,
      currentSubject: session?.subject ?? null,
    });

    // 读存储期间登出/换账号：这次解析的结论不能当真，按未登录拒绝。
    assertSessionUnchanged(session);

    if (stored.state === 'OWNER_MISMATCH') {
      throw new ExtTokenStoreError(
        'OWNER_MISMATCH',
        'hosted extension token belongs to a different enterprise account',
        { extensionId },
      );
    }
    if (stored.state === 'IAM_NOT_SIGNED_IN') {
      throw new ExtTokenStoreError(
        'IAM_NOT_SIGNED_IN',
        'sign in to enterprise IAM before resolving a hosted extension token',
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

/**
 * 宿主窄端口 `CredentialBroker`：消费方扩展按契约注册描述符，并按次取得子进程环境。
 *
 * 与 `createExtTokensService` 的差别只有一处：子进程解析的失败态必须返回
 * `{ ok: false, code }` 而不是抛异常——消费方的 runner 见到 `ok: false` 会 fail closed
 * 且零 spawn；抛异常则会先被当成普通错误，可能被上层当成「工具没装」重试。
 */
export function createCredentialBroker({ extTokens, registry }) {
  if (!extTokens || typeof extTokens.resolveChildEnv !== 'function') {
    throw new ExtTokenStoreError('IAM_INTERNAL', 'extTokens service is required');
  }
  if (!registry || typeof registry.registerExtensionCredential !== 'function') {
    throw new ExtTokenStoreError('IAM_INTERNAL', 'credential registry is required');
  }
  const FAIL_CLOSED_CODES = new Set([
    'OWNER_MISMATCH',
    'IAM_NOT_SIGNED_IN',
    'KEYCHAIN_UNAVAILABLE',
    'PENDING_WRITE',
    'IAM_EXT_CREDENTIAL_NOT_FOUND',
    'IAM_EXT_CREDENTIAL_INVALID',
  ]);
  const registerDescriptor = (descriptor) => registry.registerExtensionCredential(descriptor);
  return Object.freeze({
    registerDescriptor,
    register: registerDescriptor,
    listProjectedStatuses: () => extTokens.listProjectedStatuses(),
    saveToken: (input) => extTokens.saveToken(input),
    clearToken: (input) => extTokens.clearToken(input),
    async resolveChildEnv(input) {
      try {
        return await extTokens.resolveChildEnv(input);
      } catch (error) {
        if (FAIL_CLOSED_CODES.has(error?.code)) return { ok: false, code: error.code, env: {} };
        throw error;
      }
    },
  });
}
