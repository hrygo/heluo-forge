import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
