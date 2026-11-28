/**
 * `@heluo/forge-devops-workbench` 核心运行时与会话状态轴（CORP-DSH-ENG-003 P2）。
 *
 * 职责边界：
 *   1. 唯一持有工作台可写运行状态（config/endpoint/IAM 会话键/profile 缓存/活跃 AbortController/dispose）；
 *   2. 托管统一 IAM Token 解析（无参调用 ctx.iam.getAccessToken()）、DOP/RMP 底层客户端实例生命周期；
 *   3. 暴露 getBootstrap / getRuntimeConfig / updateRuntimeConfig / savePreferences 及受控端口供 domains 消费，
 *      自身绝不反向导入任何业务域模块。
 */
import { isLoopbackUrl, PLACEHOLDER_API_BASE_URL, validateConfig } from './config.mjs';
import { createDopClient } from './dop-client.mjs';
import { ERROR_CODES, toErrorEnvelope, WorkbenchError } from './errors.mjs';
import { createPreferencesStore, DEFAULT_PREFERENCES } from './preferences.mjs';
import { createRmpClient } from './rmp-sso.mjs';

const PROFILE_CACHE_TTL_MS = 60 * 1000;

function extractTokenValue(result) {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    const val = result.token ?? result.accessToken ?? result.value;
    if (typeof val === 'string') return val.trim();
  }
  return '';
}

/**
 * 创建工作台运行时状态管理器。
 *
 * @param {object} options
 */
export function createSessionRuntime(options) {
  const {
    getIam,
    preferencesStore = createPreferencesStore(),
    runtimeConfigStore = null,
    envConfig = null,
    cliBridge = null,
    buildPortalLinks = () => Object.freeze({}),
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger,
  } = options;

  const baseConfig = validateConfig(options.baseConfig ?? options.config);
  const envApiBaseUrl = typeof envConfig?.apiBaseUrl === 'string' ? envConfig.apiBaseUrl.trim() : '';
  const envTimeoutMs = Number.isInteger(envConfig?.requestTimeoutMs) ? envConfig.requestTimeoutMs : undefined;

  let inheritedSource = 'unconfigured';
  let inheritedEnvKey = '';
  let inheritedConfig = baseConfig;
  if (baseConfig.apiBaseUrl) {
    inheritedSource = 'plugin-config';
  } else if (envApiBaseUrl) {
    inheritedSource = 'env';
    inheritedEnvKey = String(envConfig?.matchedEnvKey || '');
    inheritedConfig = validateConfig({
      enabled: baseConfig.enabled,
      apiBaseUrl: envApiBaseUrl,
      requestTimeoutMs: envTimeoutMs ?? baseConfig.requestTimeoutMs,
    });
  } else if (envTimeoutMs !== undefined) {
    inheritedConfig = validateConfig({
      enabled: baseConfig.enabled,
      apiBaseUrl: '',
      requestTimeoutMs: envTimeoutMs,
    });
  }

  const initialOverride = runtimeConfigStore?.readOverride?.() ?? null;
  let config = initialOverride ? validateConfig({ ...inheritedConfig, ...initialOverride }) : inheritedConfig;
  let hasConfigOverride = Boolean(initialOverride);
  let configSource = hasConfigOverride ? 'local-override' : inheritedSource;
  let isLoopbackEndpoint = isLoopbackUrl(config.apiBaseUrl);
  let endpointKind = isLoopbackEndpoint ? 'local-loopback' : 'enterprise';
  let portalLinks = buildPortalLinks(config.apiBaseUrl);

  let lastSessionKey = '';
  let profileCache = null; // { sessionKey, expiresAtMs, profile }
  let disposed = false;

  /** @type {Set<AbortController>} */
  const activeControllers = new Set();
  /** @type {Set<() => void>} */
  const configChangeListeners = new Set();
  /** @type {Set<() => void>} */
  const disposeListeners = new Set();

  function assertActive() {
    if (disposed) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, 'DOP 工作台插件已停用或正在卸载');
    }
    if (!config.enabled || !config.apiBaseUrl) {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'workbench' });
    }
  }

  function resetCachesIfSessionChanged(sessionKey) {
    if (lastSessionKey && lastSessionKey !== sessionKey) {
      profileCache = null;
      rmpClient?.clearCache(lastSessionKey);
    }
    lastSessionKey = sessionKey;
  }

  async function resolveAuthSession({ allowSignedOut = false } = {}) {
    if (!config.enabled || !config.apiBaseUrl) {
      if (allowSignedOut) {
        return { ready: false, reason: ERROR_CODES.CONFIG_MISSING, sessionKey: 'unconfigured' };
      }
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING);
    }

    // 统一认证：仅复用 @heluo/forge-iam 会话
    const iam = typeof getIam === 'function' ? getIam() : null;
    if (!iam || typeof iam.getSession !== 'function' || typeof iam.getAccessToken !== 'function') {
      if (allowSignedOut) {
        return { ready: false, reason: ERROR_CODES.UNAUTHORIZED, sessionKey: 'iam:unavailable' };
      }
      throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED, '未检测到 @heluo/forge-iam 会话服务');
    }

    const session = iam.getSession();
    if (!session || session.signedIn !== true) {
      rmpClient.clearCache();
      profileCache = null;
      if (allowSignedOut) {
        return { ready: false, reason: ERROR_CODES.UNAUTHORIZED, sessionKey: 'iam:signed_out' };
      }
      throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED);
    }

    const subject = String(session.principal?.subject ?? session.subject ?? 'iam-user');
    const sessionKey = `iam:${subject}`;
    resetCachesIfSessionChanged(sessionKey);
    return { ready: true, sessionKey, session };
  }

  async function resolveRawToken() {
    const iam = typeof getIam === 'function' ? getIam() : null;
    if (!iam || typeof iam.getAccessToken !== 'function') {
      throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED);
    }
    // 对齐 @heluo/forge-iam 契约（issue #260 §2）：无参调用 getAccessToken()，由 Host IAM 统一按需刷新
    const tokenResult = await iam.getAccessToken();
    const token = extractTokenValue(tokenResult);
    if (!token) throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED);
    return token;
  }

  let dopClient;
  let rmpClient;

  function applyRuntimeConfig(nextCfg, nextOverride) {
    if (rmpClient) {
      try {
        rmpClient.clearCache();
      } catch {
        // ignore
      }
    }
    profileCache = null;
    for (const listener of configChangeListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
    config = nextCfg;
    hasConfigOverride = Boolean(nextOverride);
    configSource = hasConfigOverride ? 'local-override' : inheritedSource;
    isLoopbackEndpoint = isLoopbackUrl(config.apiBaseUrl);
    endpointKind = isLoopbackEndpoint ? 'local-loopback' : 'enterprise';
    portalLinks = buildPortalLinks(config.apiBaseUrl);
    dopClient = createDopClient({
      apiBaseUrl: config.apiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      getToken: resolveRawToken,
      fetchImpl,
      logger,
    });
    rmpClient = createRmpClient({
      apiBaseUrl: config.apiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      getSsoToken: resolveRawToken,
      fetchImpl,
      now,
      logger,
    });
  }

  applyRuntimeConfig(config, hasConfigOverride);

  function getRuntimeConfig() {
    return {
      ok: true,
      config: {
        enabled: config.enabled,
        apiBaseUrl: config.apiBaseUrl,
        authMode: 'iam',
        requestTimeoutMs: config.requestTimeoutMs,
      },
      placeholderApiBaseUrl: PLACEHOLDER_API_BASE_URL,
      configSource,
      inheritedSource,
      inheritedApiBaseUrl: inheritedConfig.apiBaseUrl,
      inheritedEnvKey,
      hasOverride: hasConfigOverride,
      isLoopbackEndpoint,
      endpointKind,
    };
  }

  async function updateRuntimeConfig(patch = {}) {
    if (disposed) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, 'DOP 工作台插件已停用');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '连接配置请求体必须为对象');
    }
    if (patch.resetToDefault === true) {
      runtimeConfigStore?.clearOverride?.();
      applyRuntimeConfig(inheritedConfig, false);
      return getRuntimeConfig();
    }
    let validated;
    try {
      validated = validateConfig({
        enabled: config.enabled,
        apiBaseUrl: patch.apiBaseUrl !== undefined ? patch.apiBaseUrl : config.apiBaseUrl,
        requestTimeoutMs: patch.requestTimeoutMs !== undefined
          ? Number(patch.requestTimeoutMs)
          : config.requestTimeoutMs,
      });
    } catch (err) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, err.message, { upstream: 'runtime-config' });
    }
    runtimeConfigStore?.writeOverride?.(validated);
    applyRuntimeConfig(validated, true);
    return getRuntimeConfig();
  }

  async function loadCachedProfile(sessionKey, { refresh = false, signal } = {}) {
    if (!refresh && profileCache && profileCache.sessionKey === sessionKey && profileCache.expiresAtMs > now()) {
      return profileCache.profile;
    }
    const profile = await dopClient.getMyProfile({ signal });
    profileCache = {
      sessionKey,
      expiresAtMs: now() + PROFILE_CACHE_TTL_MS,
      profile,
    };
    return profile;
  }

  function trackController() {
    const ac = new AbortController();
    activeControllers.add(ac);
    return {
      controller: ac,
      release() {
        activeControllers.delete(ac);
      },
    };
  }

  async function getBootstrap({ refresh = false } = {}) {
    if (disposed) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, 'DOP 工作台插件已停用');
    }
    const started = now();
    const capabilities = cliBridge?.getCapabilities?.() ?? Object.freeze({
      devopsAvailable: false,
      giteeAvailable: false,
    });
    const authState = await resolveAuthSession({ allowSignedOut: true });

    if (!authState.ready) {
      const prefs = await preferencesStore.get('default').catch(() => DEFAULT_PREFERENCES);
      return {
        ok: true,
        ready: false,
        reason: authState.reason,
        apiBaseUrl: config.apiBaseUrl,
        configSource,
        inheritedEnvKey,
        hasConfigOverride,
        isLoopbackEndpoint,
        endpointKind,
        authMode: 'iam',
        authState: authState.reason === ERROR_CODES.CONFIG_MISSING ? 'unconfigured' : 'signed_out',
        profile: null,
        preferences: prefs,
        capabilities,
      };
    }

    const tracked = trackController();
    let profile = null;
    let profileError = null;
    try {
      profile = await loadCachedProfile(authState.sessionKey, { refresh, signal: tracked.controller.signal });
    } catch (err) {
      const env = toErrorEnvelope(err, { endpointKind });
      profileError = env.error;
    } finally {
      tracked.release();
    }

    const userKey = profile?.loginCode || authState.sessionKey;
    const preferences = await preferencesStore.get(userKey);

    logger?.('workbench.bootstrap.loaded', {
      authMode: 'iam',
      isLoopbackEndpoint,
      durationMs: Math.max(0, now() - started),
    });

    if (!profile && profileError) {
      return {
        ok: true,
        ready: false,
        reason: profileError.code,
        error: profileError,
        apiBaseUrl: config.apiBaseUrl,
        configSource,
        inheritedEnvKey,
        hasConfigOverride,
        isLoopbackEndpoint,
        endpointKind,
        authMode: 'iam',
        authState: profileError.code === ERROR_CODES.UPSTREAM_AUTH_DENIED ? 'denied' : 'degraded',
        profile: null,
        preferences,
        capabilities,
      };
    }

    return {
      ok: true,
      ready: true,
      reason: null,
      apiBaseUrl: config.apiBaseUrl,
      configSource,
      inheritedEnvKey,
      hasConfigOverride,
      isLoopbackEndpoint,
      endpointKind,
      authMode: 'iam',
      authState: 'ready',
      profile,
      preferences,
      capabilities,
    };
  }

  async function savePreferences(patch) {
    if (disposed) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, 'DOP 工作台插件已停用');
    }
    let userKey = 'default';
    try {
      const authState = await resolveAuthSession({ allowSignedOut: true });
      if (authState.ready) {
        if (profileCache?.sessionKey === authState.sessionKey && profileCache.profile?.loginCode) {
          userKey = profileCache.profile.loginCode;
        } else {
          userKey = authState.sessionKey;
        }
      }
    } catch {
      userKey = 'default';
    }
    const saved = await preferencesStore.save(userKey, patch);
    return { ok: true, preferences: saved };
  }

  function onConfigChange(listener) {
    if (typeof listener !== 'function') return () => {};
    configChangeListeners.add(listener);
    return () => configChangeListeners.delete(listener);
  }

  function onDispose(listener) {
    if (typeof listener !== 'function') return () => {};
    disposeListeners.add(listener);
    return () => disposeListeners.delete(listener);
  }

  function dispose() {
    disposed = true;
    for (const ac of activeControllers) {
      ac.abort(new Error('WORKBENCH_DISPOSED'));
    }
    activeControllers.clear();
    for (const listener of disposeListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
    profileCache = null;
    rmpClient.clearCache();
  }

  return Object.freeze({
    get isLoopbackEndpoint() {
      return isLoopbackEndpoint;
    },
    get endpointKind() {
      return endpointKind;
    },
    get portalLinks() {
      return portalLinks;
    },
    get dopClient() {
      return dopClient;
    },
    get rmpClient() {
      return rmpClient;
    },
    get disposed() {
      return disposed;
    },
    preferencesStore,
    runtimeConfigStore,
    assertActive,
    resolveAuthSession,
    loadCachedProfile,
    trackController,
    getBootstrap,
    getRuntimeConfig,
    updateRuntimeConfig,
    savePreferences,
    onConfigChange,
    onDispose,
    dispose,
  });
}
