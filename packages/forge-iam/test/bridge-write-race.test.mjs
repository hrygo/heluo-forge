import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { createIamService } from '../src/service.mjs';

const config = {
  issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'fixture', redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const recordKey = 'heluo-iam/bridge-capability';

async function fixture(t, wrapAdapter) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-bridge-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = createCredentialStore({ directory });
  const first = createKeychainProvider(backend);
  const second = createKeychainProvider(createCredentialStore({ directory }));
  t.after(() => first.close());
  t.after(() => second.close());
  // Ensure the database exists before both providers are used.
  await first.modifyRecord('heluo-iam/test-seed', () => ({ kind: 'grant', payload: { version: 1 } }));
  const actual = createJointStore(backend, namespacePrefixes());
  const adapter = wrapAdapter ? wrapAdapter(actual, second) : actual;
  const service = createIamService(config, {
    credentials: first,
    verifyAtomicStore: (value) => value === first,
    getGatewayAtomicStore: (value) => value === first ? adapter : undefined,
    verifyGatewayAtomicStore: (value, candidate) => value === first && candidate === adapter,
  });
  t.after(() => service.dispose());
  return { first, second, service, adapter };
}

test('a concurrent ref creation is preserved when bridge initialization races it', async (t) => {
  const competing = Buffer.alloc(32, 19).toString('base64url');
  let injected = false;
  let commits = 0;
  const { first, second, service } = await fixture(t, (adapter, other) => ({
    ...adapter,
    async snapshot(scope) {
      const pair = await adapter.snapshot(scope);
      if (!injected && pair.value === undefined) {
        injected = true;
        await other.set(BRIDGE_REF, competing);
      }
      return pair;
    },
    compareAndSwap(...args) { commits++; return adapter.compareAndSwap(...args); },
  }));
  const resolve = first.resolve.bind(first);
  let reads = 0;
  first.resolve = async (ref) => {
    const value = await resolve(ref);
    if (ref === BRIDGE_REF && ++reads === 2) {
      injected = true;
      await second.set(BRIDGE_REF, competing);
    }
    return value;
  };
  await assert.rejects(service.bridgeCapability());
  assert.equal(injected, true);
  assert.equal(commits, 1);
  assert.equal((await second.resolve(BRIDGE_REF)).value, competing);
});

for (const interruption of ['dispose service', 'replace provider']) test(`${interruption} before the actual bridge commit leaves no record or ref`, async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { first, second, adapter } = await fixture(t, (actual) => ({
    ...actual,
    async compareAndSwap(...args) {
      entered();
      await gate;
      return actual.compareAndSwap(...args);
    },
  }));
  let current = first;
  const service = createIamService(config, {
    getCredentials: () => current, verifyAtomicStore: (value) => value === current,
    getGatewayAtomicStore: () => adapter,
    verifyGatewayAtomicStore: (value, candidate) => value === current && candidate === adapter,
  });
  t.after(() => service.dispose());
  const modifyRecord = first.modifyRecord.bind(first);
  first.modifyRecord = (key, mutate) => modifyRecord(key, async (current) => {
    const next = await mutate(current);
    if (key === recordKey) { entered(); await gate; }
    return next;
  });
  const pending = service.bridgeCapability();
  await started;
  if (interruption === 'dispose service') await service.dispose();
  else current = second;
  release();
  await assert.rejects(pending);
  assert.equal((await second.readRecord(recordKey)) === undefined, true);
  assert.equal(await second.resolve(BRIDGE_REF), undefined);
});

test('an unknown post-commit result is not retried or read back', async (t) => {
  let snapshots = 0;
  let commits = 0;
  const { second, service } = await fixture(t, (adapter) => ({
    async snapshot(scope) { snapshots++; return adapter.snapshot(scope); },
    async compareAndSwap(...args) {
      commits++;
      await adapter.compareAndSwap(...args);
      throw new Error('synthetic response lost');
    },
  }));
  await assert.rejects(service.bridgeCapability());
  assert.equal(commits, 1);
  assert.equal(snapshots, 1);
  assert.equal(Boolean(await second.readRecord(recordKey)), true);
  assert.equal(Boolean(await second.resolve(BRIDGE_REF)), true);
});

test('a repeated commit guard is rejected and its transaction rolls back', async (t) => {
  let commits = 0;
  const { second, service } = await fixture(t, (adapter) => ({
    ...adapter,
    compareAndSwap(scope, expected, next, guard) {
      commits++;
      return adapter.compareAndSwap(scope, expected, next, () => { guard(); return guard(); });
    },
  }));
  await assert.rejects(service.bridgeCapability());
  assert.equal(commits, 1);
  assert.equal((await second.readRecord(recordKey)) === undefined, true);
  assert.equal(await second.resolve(BRIDGE_REF), undefined);
});

test('single-record trust alone cannot authorize a bridge joint write', async (t) => {
  const { first, second, adapter } = await fixture(t);
  for (const verifyGatewayAtomicStore of [() => false, () => Promise.resolve(true)]) {
    const service = createIamService(config, {
      credentials: first,
      verifyAtomicStore: (value) => value === first,
      getGatewayAtomicStore: () => adapter,
      verifyGatewayAtomicStore,
    });
    t.after(() => service.dispose());
    await assert.rejects(service.bridgeCapability());
  }
  assert.equal((await second.readRecord(recordKey)) === undefined, true);
  assert.equal(await second.resolve(BRIDGE_REF), undefined);
});
