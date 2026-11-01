// Test-only explicit composition. Trust is restricted to the exact fixture
// passed by the test; it neither proves the fixture nor enables any product path.
import { createIamService as createService } from '../../src/service.mjs';

export function createIamService(config, options = {}) {
  let fixture = options.credentials;
  if (fixture === undefined) {
    try { fixture = options.getCredentials?.(); } catch { fixture = undefined; }
  }
  return createService(config, {
    ...options,
    verifyAtomicStore: (candidate) => candidate === fixture && fixture !== undefined,
  });
}
