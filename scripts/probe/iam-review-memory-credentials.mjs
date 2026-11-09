// Verification-only in-memory provider. No keychain, environment or file access.
// Keeps the real IAM plugin's atomic-storage gate intact.
import { MemoryCredentials } from '../../packages/forge-iam/test/support/memory-credentials.mjs';

export const name = 'iam-review-memory-credentials';
export function apply(ctx) {
  const credentials = new MemoryCredentials();
  credentials.resolve = async ref => {
    const value = credentials.refs.get(ref);
    return value === undefined ? undefined : { value, source: 'isolated-memory-fixture' };
  };
  credentials.describe = async ref => ({
    configured: credentials.refs.has(ref), source: 'isolated-memory-fixture', writable: true,
  });
  ctx.effect(() => {
    const off = ctx.provide('credentials', credentials);
    return () => { off?.(); credentials.refs.clear(); credentials.records.clear(); };
  });
}
