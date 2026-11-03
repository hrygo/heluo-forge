// Test-only joint gateway capability. No production provider is inferred from
// this fixture: callers explicitly bind its exact credentials + adapter pair.
import { isDeepStrictEqual } from 'node:util';
import { MemoryCredentials } from './memory-credentials.mjs';
import { GATEWAY_RECORD_KEY, GATEWAY_REF } from '../../src/store.mjs';

export function seedLegacyGateway(credentials, { value, ownerSubject, enteredAt,
  deviceLabel, suggestedExpiry } = {}) {
  credentials.refs.set(GATEWAY_REF, value);
  credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: {
    version: 1, ownerSubject, enteredAt,
    ...(deviceLabel ? { deviceLabel } : {}), ...(suggestedExpiry ? { suggestedExpiry } : {}),
  } });
}

export function gatewayAtomicOptions(...fixtures) {
  const pairs = new Map(fixtures.map(({ credentials, adapter }) => [credentials, adapter]));
  return {
    getGatewayAtomicStore: (candidate) => pairs.get(candidate),
    verifyGatewayAtomicStore: (candidate, adapter, scope) => pairs.has(candidate)
      && pairs.get(candidate) === adapter && scope?.recordKey === GATEWAY_RECORD_KEY && scope?.ref === GATEWAY_REF,
  };
}

export function createAtomicGatewayFixture(credentials = new MemoryCredentials()) {
  if (!(credentials.records instanceof Map) || !(credentials.refs instanceof Map)) {
    throw new Error('this fixture requires explicit in-memory record/ref maps');
  }
  const pair = () => structuredClone({
    record: credentials.records.get(GATEWAY_RECORD_KEY), value: credentials.refs.get(GATEWAY_REF),
  });
  const scopeValid = (scope) => scope?.recordKey === GATEWAY_RECORD_KEY && scope?.ref === GATEWAY_REF;
  const adapter = {
    snapshots: 0, attempts: 0, commits: 0,
    afterSnapshot: null, beforeCommit: null, afterCommit: null,
    async snapshot(scope) {
      if (!scopeValid(scope)) throw new Error('unexpected test scope');
      this.snapshots++;
      const captured = pair();
      if (this.afterSnapshot) await this.afterSnapshot(captured);
      return captured;
    },
    async compareAndSwap(scope, expected, next, guard) {
      if (!scopeValid(scope)) throw new Error('unexpected test scope');
      this.attempts++;
      if (this.beforeCommit) await this.beforeCommit(expected, next);
      // One uninterrupted JS turn: comparison, guard and both Map updates. This
      // models a supplied transaction; it is not a new distributed lock library.
      if (!isDeepStrictEqual(pair(), expected)) return { ok: false };
      const permit = guard();
      if (permit && typeof permit.then === 'function') Promise.resolve(permit).catch(() => {});
      if (permit !== true) throw new Error('test transaction guard did not permit');
      credentials.records.set(GATEWAY_RECORD_KEY, structuredClone(next.record));
      if (next.value === undefined) credentials.refs.delete(GATEWAY_REF);
      else credentials.refs.set(GATEWAY_REF, next.value);
      this.commits++;
      const receipt = { ok: true, snapshot: structuredClone(next) };
      if (this.afterCommit) await this.afterCommit(receipt);
      return receipt;
    },
  };
  const fixture = { credentials, adapter, pair };
  return { ...fixture, options: gatewayAtomicOptions(fixture) };
}
