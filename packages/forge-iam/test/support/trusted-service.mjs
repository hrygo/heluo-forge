// Test-only explicit composition. Trust is restricted to the exact fixture
// passed by the test; it neither proves the fixture nor enables any product path.
import { createIamService as createService } from '../../src/service.mjs';

export function createIamService(config, options = {}) {
  let fixture = options.credentials;
  if (fixture === undefined) {
    try { fixture = options.getCredentials?.(); } catch { fixture = undefined; }
  }
  // This isolated fixture has no host. Do not replace an explicit host or a
  // loopback callback provider, including intentionally unavailable ones.
  const redirectUri = config?.redirectUri;
  const fixtureOrigin = redirectUri && config?.callbackPort == null && !Object.hasOwn(options, 'getCallbackOrigin')
    ? { getOrigin: () => new URL(redirectUri).origin }
    : {};
  return createService(config, {
    ...fixtureOrigin,
    ...options,
    verifyAtomicStore: (candidate) => candidate === fixture && fixture !== undefined,
  });
}
