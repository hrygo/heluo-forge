import { fetchJson, loadMetadata, randomToken, verifyIdToken } from './oidc.mjs';
import { fetchUserInfo, projectUserInfo } from './userinfo.mjs';
import {
  assertClientAuthCurrent,
  assertGrantAuthBinding,
  clientAuthContext,
  clientAuthDescriptor,
  grantAuthPin,
  prepareClientAuthentication,
} from './client-auth.mjs';
import { IamError } from './errors.mjs';
import { parseHttpUrl, parseRedirectUri } from './http-url.mjs';
import { addSeconds, grantIdentity, ID_TOKEN_CLOCK_SKEW_SECONDS, safeMessage } from './service-helpers.mjs';

const METADATA_TTL_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;

/**
 * Grants, the protocol caches that produce them, and the identity enrichment
 * layered on top.
 *
 * A grant is only valid inside the context that minted it, so the weak owner
 * map lives here next to the code that binds and checks it: `own`, `ownerOf`
 * and `had` are the only ways to associate a grant with a store, and
 * `assertGrantContext` is the only reader that decides whether it still holds.
 */
export function createServiceGrant(env) {
  const { config, options, now, fetchImpl, profileFields, state, provider, getAuthEpoch } = env;

  let metadataCache = null;
  let jwksCache = null;
  let identityProfile;
  // A weak association prevents a discarded cached grant retaining its provider.
  const grantOwners = new WeakMap();

  async function prepareAuthentication(issuer, target, credentials, { grant: targetGrant, expected = state.sessionAuthentication, guard } = {}) {
    if (config.authMode !== 'confidential') return undefined;
    const current = () => {
      if (guard) guard();
      if (state.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      state.assertExclusive();
      if (provider.ensure() !== target || provider.storeCredentials !== credentials) {
        throw new IamError('IAM_CLIENT_AUTH_CHANGED', safeMessage('IAM_CLIENT_AUTH_CHANGED'));
      }
      if (guard) guard();
      return true;
    };
    current();
    const operation = await prepareClientAuthentication(config, options, { issuer, credentials,
      expectedPin: grantAuthPin(targetGrant) ?? expected?.pin, expectedProvenance: expected?.provenance, guard: current });
    assertClientAuthCurrent(operation);
    return operation;
  }

  function rememberAuthentication(operation, grant) {
    if (operation) state.sessionAuthentication = Object.freeze({ ...clientAuthDescriptor(operation), identity: grantIdentity(grant), credentials: provider.storeCredentials });
  }

  async function metadata() {
    const current = now();
    if (metadataCache && current - metadataCache.loadedAt < METADATA_TTL_MS) {
      return metadataCache.value;
    }
    const value = await loadMetadata(config, {
      fetchImpl,
      timeoutMs: config.httpTimeoutMs,
    });
    metadataCache = { value, loadedAt: current };
    return value;
  }

  async function loadIdentityProfile(grant) {
    if (Object.keys(profileFields).length === 0) return;
    identityProfile = undefined;
    const epoch = getAuthEpoch();
    try {
      const meta = metadataCache?.value ?? await metadata();
      const endpoint = meta?.userInfoEndpoint;
      if (!endpoint) return;
      const raw = await fetchUserInfo({
        userInfoEndpoint: endpoint,
        accessToken: grant.accessToken,
        fetchImpl,
        timeoutMs: Math.min(config.httpTimeoutMs, 5000),
      });
      if (state.disposed || getAuthEpoch() !== epoch || state.lastGrant !== grant) return;
      const profile = projectUserInfo(raw, profileFields);
      identityProfile = profile ? Object.freeze({ identity: grantIdentity(grant), profile }) : undefined;
    } catch {
      // UserInfo is enrichment only: login stays successful without it.
      identityProfile = undefined;
    }
  }

  async function jwks(uri) {
    const current = now();
    if (jwksCache && jwksCache.uri === uri && current - jwksCache.loadedAt < JWKS_TTL_MS) {
      return jwksCache.value;
    }
    const value = await fetchJson(uri, { fetchImpl, timeoutMs: config.httpTimeoutMs });
    jwksCache = { uri, value, loadedAt: current };
    return value;
  }

  async function verifyWithJwks(token, { uri, issuer, clientId, nonce, accessToken, guard }) {
    const options = {
      issuer,
      clientId,
      accessToken,
      skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS,
      now: now(),
      ...(nonce === undefined ? {} : { nonce }),
    };
    try {
      const keys = await jwks(uri);
      if (guard) guard();
      return verifyIdToken(token, { ...options, jwks: keys });
    } catch (cause) {
      if (guard) guard();
      if (cause?.code !== 'IAM_JWKS_KEY_NOT_FOUND') throw cause;
      jwksCache = null;
      const keys = await jwks(uri);
      if (guard) guard();
      return verifyIdToken(token, { ...options, jwks: keys });
    }
  }

  function assertGrantBinding(grant) {
    if (!grant) return;
    assertGrantAuthBinding(config, grant);
    const wrongClient = grant.clientId !== config.clientId;
    // V1 login carries no gateway audience; only compare when one is configured
    // so grants stored before the split keep working.
    const wrongResource = Boolean(config.gatewayResource) && grant.resource !== config.gatewayResource;
    if (wrongClient || wrongResource) {
      throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
    }
  }

  function assertGrantContext(grant, expectedIssuer) {
    if (!grant) return;
    assertGrantBinding(grant);
    if (!expectedIssuer || grant.issuer !== expectedIssuer) {
      throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
    }
  }

  function redirectUri() {
    // With a loopback listener the origin is published only after the bind, and
    // a sign-in binds before asking for the URL. An empty value here means the
    // listener is not up, so there is no address to send the browser to.
    const redirect = config.redirectUri ? parseRedirectUri(config.redirectUri, config.redirectPath) : undefined;
    if (redirect?.error) throw new IamError('IAM_CONFIG_INVALID', redirect.error);
    const useLoopback = typeof config.callbackPort === 'number';
    let live;
    try {
      live = useLoopback ? options.getCallbackOrigin?.() : options.getOrigin?.();
    } catch {
      live = undefined;
    }
    const origin = parseHttpUrl(live);
    if (!origin) {
      throw new IamError('IAM_CALLBACK_UNAVAILABLE', safeMessage('IAM_CALLBACK_UNAVAILABLE'));
    }
    if (redirect) {
      if (redirect.url.origin !== origin.origin) {
        const message = useLoopback
          ? 'redirectUri must equal the live loopback callback origin'
          : 'redirectUri origin must equal the live web server origin';
        throw new IamError('IAM_CONFIG_INVALID', message);
      }
      return redirect.url.href;
    }
    return new URL(config.redirectPath, origin).href;
  }

  function grantFromToken(previous, token, issuer, obtainedAt) {
    const refreshToken = token.refreshToken ?? previous?.refreshToken;
    if (!refreshToken) {
      throw new IamError('IAM_REFRESH_TOKEN_MISSING', safeMessage('IAM_REFRESH_TOKEN_MISSING'));
    }
    return {
      version: previous?.version ?? 1,
      ...(previous?.authContext ? { authContext: { ...previous.authContext } } : {}),
      issuer,
      subject: previous?.subject ?? null,
      clientId: config.clientId,
      refreshToken,
      scope: token.scope ?? previous?.scope ?? config.scopes.join(' '),
      ...(config.gatewayResource ? { resource: config.gatewayResource } : {}),
      obtainedAt: previous?.obtainedAt ?? obtainedAt,
      sessionInstanceId: previous.sessionInstanceId,
      accessToken: token.accessToken,
      accessExpiresAt: addSeconds(now(), token.expiresIn),
      // A rotated refresh token has its own lifetime. If the response omits it,
      // the old token's deadline says nothing about the new one.
      ...(token.refreshExpiresIn ? { refreshExpiresAt: addSeconds(now(), token.refreshExpiresIn) } : {}),
      ...(token.idToken ? { idToken: token.idToken } : previous?.idToken ? { idToken: previous.idToken } : {}),
    };
  }

  async function buildGrant(token, claims, meta, obtainedAt, authentication) {
    if (!token.refreshToken) {
      throw new IamError('IAM_REFRESH_TOKEN_MISSING', safeMessage('IAM_REFRESH_TOKEN_MISSING'));
    }
    return {
      version: authentication ? 2 : 1,
      ...(authentication ? { authContext: clientAuthContext(authentication.pin) } : {}),
      issuer: meta.issuer,
      subject: claims.sub,
      sessionInstanceId: randomToken(32),
      clientId: config.clientId,
      refreshToken: token.refreshToken,
      scope: token.scope ?? config.scopes.join(' '),
      ...(config.gatewayResource ? { resource: config.gatewayResource } : {}),
      obtainedAt,
      accessToken: token.accessToken,
      accessExpiresAt: addSeconds(now(), token.expiresIn),
      ...(token.refreshExpiresIn ? { refreshExpiresAt: addSeconds(now(), token.refreshExpiresIn) } : {}),
      ...(config.logoutMode === 'rp' && token.idToken ? { idToken: token.idToken } : {}),
    };
  }
  return {
    get identityProfile() { return identityProfile; },
    own(grant, target) { grantOwners.set(grant, target); },
    ownerOf(grant) { return grantOwners.get(grant); },
    had(grant) { return grantOwners.has(grant); },
    clearProfile() { identityProfile = undefined; },
    cachedIssuer() { return metadataCache?.value?.issuer ?? ''; },
    get metadataCache() { return metadataCache?.value ?? null; },
    prepareAuthentication,
    rememberAuthentication,
    metadata,
    jwks,
    verifyWithJwks,
    grantFromToken,
    buildGrant,
    assertGrantBinding,
    assertGrantContext,
    redirectUri,
    loadIdentityProfile,
  };
}
