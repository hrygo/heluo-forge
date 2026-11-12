import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilities, createRegisteredBackend } from '../src/backend-registry.mjs';
import { apply, openCredentialReader } from '../src/index.mjs';
import { createMemoryBackend } from '../src/backend.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

function ownDirectory(t, directory) {
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(directory, { recursive: true, force: true });
  });
  return (cleanup) => cleanups.push(cleanup);
}

function context() {
  const provided = new Map();
  return { provided, get: (name) => provided.get(name),
    provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
    effect(fn) { return fn(); } };
}

// The test changes only the isolated registry; the real Host and reader are
// copied unchanged. This synthetic SQLite wrapper selects a separate directory
// so selecting the old default cannot accidentally satisfy the test.
async function withSyntheticDefault(t, provenCapabilities, { omitJointMethods = false, selectedName = 'synthetic' } = {}) {
  const root = await outsideRepositoryTmpAsync('forge-registry-synthetic-');
  const own = ownDirectory(t, root);
  const src = join(root, 'src');
  await cp(new URL('../src/', import.meta.url), src, { recursive: true });
  const registryPath = join(src, 'backend-registry.mjs');
  const registry = await readFile(registryPath, 'utf8');
  const defaultSelection = /^const DEFAULT_BACKEND = ['"][^'"]+['"];$/gm;
  const registrations = 'const BACKENDS = Object.freeze({\n';
  assert.equal([...registry.matchAll(defaultSelection)].length, 1, 'one default selection in registry');
  assert.equal(registry.split(registrations).length, 2, 'one registration table');
  const synthetic = `  synthetic: Object.freeze({
    create: (options) => {
      syntheticCalls.push(options.readOnly === true);
      const store = createCredentialStore({ ...options, directory: join(options.directory, 'synthetic') });
      return { ...store,
        ${omitJointMethods ? 'snapshot: undefined, compareAndSwap: undefined,' : ''}
        capabilities: () => ({ crossProcessLock: true, jointAtomic: true }),
      };
    },
    capabilities: Object.freeze(${JSON.stringify(provenCapabilities)}),
  }),
`;
  await writeFile(registryPath, `import { join } from 'node:path';\nexport const syntheticCalls = [];\n${registry
    .replace(defaultSelection, `const DEFAULT_BACKEND = ${JSON.stringify(selectedName)};`)
    .replace(registrations, registrations + synthetic)}`);
  const api = await import(pathToFileURL(join(src, 'index.mjs')).href);
  const { syntheticCalls } = await import(pathToFileURL(registryPath).href);
  return { ...api, root, own, syntheticCalls };
}

test('a second registered default is selected by both Host and reader with its proven capabilities', async (t) => {
  const isolated = await withSyntheticDefault(t, { crossProcessLock: true, jointAtomic: true });
  const directory = join(isolated.root, 'data');
  const ctx = context();
  const dispose = isolated.apply(ctx, { storeDirectory: directory });
  isolated.own(dispose);
  const provider = ctx.provided.get('credentials');
  const trust = ctx.provided.get('iam-atomic-store');
  assert.equal(trust.verify(provider), true);
  assert.equal(trust.verify({}), false);
  await provider.set('TEST', 'synthetic');
  assert.deepEqual(await trust.adapter().snapshot({ recordKey: 'gateway/config', ref: 'TEST' }), {
    record: undefined, value: 'synthetic',
  });
  assert.equal(existsSync(join(directory, 'synthetic', 'credentials.sqlite')), true);
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
  const reader = await isolated.openCredentialReader({ directory });
  isolated.own(() => reader.close());
  assert.equal((await reader.resolve('TEST')).value, 'synthetic');
  assert.deepEqual(isolated.syntheticCalls, [false, true]);
});

for (const proven of [
  { crossProcessLock: false, jointAtomic: true },
  { crossProcessLock: true, jointAtomic: false },
]) {
  test(`registered backend without ${proven.crossProcessLock ? 'joint atomicity' : 'cross-process lock'} receives no trust even if it self-reports both`, async (t) => {
    const isolated = await withSyntheticDefault(t, proven);
    const directory = join(isolated.root, 'data');
    const ctx = context();
    const dispose = isolated.apply(ctx, { storeDirectory: directory });
    isolated.own(dispose);
    assert.equal(ctx.provided.has('iam-atomic-store'), false);
    await ctx.provided.get('credentials').set('TEST', 'synthetic');
    const reader = await isolated.openCredentialReader({ directory });
    isolated.own(() => reader.close());
    assert.equal((await reader.resolve('TEST')).value, 'synthetic');
  });
}

test('missing joint backend methods do not produce a trusted adapter', async (t) => {
  const isolated = await withSyntheticDefault(t, { crossProcessLock: true, jointAtomic: true }, { omitJointMethods: true });
  const ctx = context();
  const dispose = isolated.apply(ctx, { storeDirectory: join(isolated.root, 'data') });
  isolated.own(dispose);
  assert.equal(ctx.provided.has('iam-atomic-store'), false);
  await ctx.provided.get('credentials').set('TEST', 'synthetic');
});

test('an unregistered default fails before Host or reader publishes a provider', async (t) => {
  const isolated = await withSyntheticDefault(t, { crossProcessLock: true, jointAtomic: true }, { selectedName: 'unknown' });
  const directory = join(isolated.root, 'data');
  const ctx = context();
  assert.throws(() => isolated.apply(ctx, { storeDirectory: directory }), { code: 'CRED_BACKEND_UNREGISTERED' });
  assert.equal(ctx.provided.size, 0);
  await assert.rejects(isolated.openCredentialReader({ directory }), { code: 'CRED_BACKEND_UNREGISTERED' });
  assert.equal(existsSync(directory), false);
});

test('registry exposes only immutable tested sqlite capabilities', async (t) => {
  assert.deepEqual(capabilities('sqlite'), { crossProcessLock: true, jointAtomic: true });
  assert.equal(Object.isFrozen(capabilities('sqlite')), true);
  for (const name of ['memory', 'bogus', '__proto__', 'constructor']) {
    assert.throws(() => capabilities(name), { code: 'CRED_BACKEND_UNREGISTERED' });
    assert.throws(() => createRegisteredBackend(name, {}), { code: 'CRED_BACKEND_UNREGISTERED' });
  }
  const root = await outsideRepositoryTmpAsync('forge-registry-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const backend = createRegisteredBackend('sqlite', { directory });
  own(() => backend.close());
  const key = 'heluo-forge/iam/ref/TEST';
  await backend.set(key, 'synthetic');
  assert.equal(await backend.get(key), 'synthetic');
});

test('host grants trust only to registered sqlite, not an injected capability impostor', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-registry-host-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const builtin = context();
  const dispose = apply(builtin, { storeDirectory: directory });
  own(dispose);
  const provider = builtin.provided.get('credentials');
  assert.equal(builtin.provided.get('iam-atomic-store').verify(provider), true);
  await provider.set('TEST', 'synthetic');
  const reader = await openCredentialReader({ directory });
  own(() => reader.close());
  assert.equal((await reader.resolve('TEST')).value, 'synthetic');
  const injected = context();
  const backend = Object.assign(createMemoryBackend(), {
    durable: true, capabilities: () => ({ crossProcessLock: true, jointAtomic: true }),
    transaction: async () => {}, snapshot: async () => ({}), compareAndSwap: async () => ({ ok: true }),
  });
  const close = apply(injected, { backend, allowEphemeral: true });
  own(close);
  assert.equal(injected.provided.has('iam-atomic-store'), false);
});

test('registered sqlite serializes writes across live processes', { timeout: 10000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const root = await outsideRepositoryTmpAsync('forge-registry-lock-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const backend = createRegisteredBackend('sqlite', { directory, lockTimeoutMs: 3000 });
  own(() => backend.close());
  const key = 'heluo-forge/iam/ref/TEST';
  await backend.set(key, 'initial');
  let release;
  let entered;
  const held = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = backend.transaction(key, async (tx) => { entered(); await gate; tx.set('first'); });
  const firstResult = first.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  own(async () => { release(); const result = await firstResult; if (!result.ok) throw result.error; });
  await held;
  const registry = new URL('../src/backend-registry.mjs', import.meta.url).href;
  const code = `import { createRegisteredBackend } from ${JSON.stringify(registry)};
const store = createRegisteredBackend('sqlite', { directory: process.argv[1], lockTimeoutMs: 3000 });
process.send('trying'); await store.set(${JSON.stringify(key)}, 'second'); process.send('committed'); await store.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const childClosed = once(child, 'close').then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  own(async () => {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await childClosed;
    if (!result.ok) throw result.error;
  });
  assert.equal((await once(child, 'message', { signal: AbortSignal.timeout(3000) }))[0], 'trying');
  let committed = false;
  child.on('message', (message) => { if (message === 'committed') committed = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(committed, false);
  assert.equal(await backend.get(key), 'initial');
  const exited = once(child, 'exit');
  release();
  await first;
  const [codeResult] = await exited;
  assert.equal(codeResult, 0);
  assert.equal(committed, true);
  assert.equal(await backend.get(key), 'second');
});
