import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { outsideRepositoryTmp } from './support/tmp.mjs';
import { createMemoryBackend, createUnavailableBackend } from '../src/backend.mjs';
import { apply, Config, KeychainProviderError, validateConfig } from '../src/index.mjs';

function fakeContext(existing = undefined, events = undefined) {
  const provided = new Map();
  const effects = [];
  return {
    provided,
    effects,
    events,
    get(name) {
      return name === 'credentials' ? existing : undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    async unload() {
      for (const dispose of effects.splice(0).reverse()) {
        if (typeof dispose === 'function') await dispose();
        else await dispose?.dispose?.();
      }
    },
  };
}

test('apply registers credentials with an explicitly allowed ephemeral backend', async () => {
  const ctx = fakeContext();
  const backend = createMemoryBackend();
  const dispose = apply(ctx, { backend, allowEphemeral: true });
  assert.equal(typeof ctx.provided.get('credentials')?.resolve, 'function');
  assert.equal(ctx.effects.length, 1);
  await dispose();
  assert.equal(ctx.provided.has('credentials'), false);
});

test('apply refuses an ephemeral backend unless explicitly allowed', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { backend: createMemoryBackend() }),
    (error) => error instanceof KeychainProviderError && error.code === 'KEYCHAIN_EPHEMERAL_REFUSED',
  );
  assert.equal(ctx.provided.size, 0);
});

test('apply refuses to replace an existing credentials provider', () => {
  const ctx = fakeContext({ resolve: async () => undefined });
  assert.throws(
    () => apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true }),
    (error) => error.code === 'KEYCHAIN_CREDENTIALS_CONFLICT',
  );
});

test('unavailable backend refuses to mount without exposing a provider', () => {
  const ctx = fakeContext();
  assert.throws(() => apply(ctx, { backend: createUnavailableBackend('synthetic unavailable'), allowEphemeral: true }),
    (error) => error.code === 'KEYCHAIN_UNAVAILABLE');
  assert.equal(ctx.provided.size, 0);
});

test('apply requires ctx.get to prove no provider is mounted', () => {
  const ctx = { provide() {}, effect(callback) { return callback(); } };
  assert.throws(
    () => apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true }),
    (error) => error.code === 'KEYCHAIN_CREDENTIALS_CHECK_UNAVAILABLE',
  );
});

test('apply requires ctx.effect to own the provider lifecycle', () => {
  const ctx = { get() {}, provide() { return () => {}; } };
  assert.throws(
    () => apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true }),
    (error) => error.code === 'KEYCHAIN_HOST_UNAVAILABLE',
  );
});

test('invalid config is rejected synchronously', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { allowEphemeral: 'yes' }),
    (error) => error.code === 'KEYCHAIN_CONFIG_INVALID',
  );
});

test('the standard-schema adapter validates the same fields', () => {
  const adapter = Config['~standard'];
  assert.equal(adapter.version, 1);
  const ok = validateConfig({ service: 'heluo-forge', accountPrefix: 'iam' });
  assert.ok('value' in ok);
  assert.equal(ok.value.allowEphemeral, false);
  const bad = adapter.validate({ service: '' });
  assert.ok('issues' in bad);
});

test('the normalized config is accepted by a second validation and by apply', async () => {
  // Cordis validates through Config first and hands result.value to apply, so
  // normalization must be idempotent or the framework path rejects itself.
  const first = Config['~standard'].validate({ backend: createMemoryBackend(), allowEphemeral: true });
  assert.ok('value' in first);
  const second = Config['~standard'].validate(first.value);
  assert.ok('value' in second);
  assert.deepEqual(second.value, first.value);
  const ctx = fakeContext();
  const dispose = apply(ctx, first.value);
  assert.equal(typeof ctx.provided.get('credentials')?.resolve, 'function');
  await dispose();
});

test('unload runs the framework-owned teardown for a plain function plugin', async () => {
  const ctx = fakeContext();
  let closes = 0;
  const backend = { ...createMemoryBackend(), async close() { closes += 1; } };
  // Cordis executes a plain function plugin with `new`; only the effect runs.
  const discarded = new apply(ctx, { backend, allowEphemeral: true });
  assert.equal(typeof discarded, 'function');
  assert.equal(ctx.provided.has('credentials'), true);
  assert.equal(closes, 0);

  await ctx.unload();

  assert.equal(ctx.provided.has('credentials'), false);
  assert.equal(closes, 1);
});

test('credential listeners are isolated from each other and from the write', async () => {
  const calls = [];
  const events = {
    dispatch(_mode, [event, subject]) {
      assert.equal(event, 'credentials/reference-updated');
      return [
        () => { calls.push('throwing'); throw new Error('synthetic-sync'); },
        () => { calls.push(`healthy:${subject}`); },
        async () => { calls.push('async-throwing'); throw new Error('synthetic-async'); },
      ];
    },
  };
  const ctx = fakeContext(undefined, events);
  const unhandled = [];
  const capture = (error) => unhandled.push(error.message);
  process.on('unhandledRejection', capture);
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  const provider = ctx.provided.get('credentials');
  await provider.set('SYNTHETIC_REF', 'synthetic');
  await new Promise(setImmediate);
  process.off('unhandledRejection', capture);
  await dispose();

  assert.deepEqual(calls, ['throwing', 'healthy:SYNTHETIC_REF', 'async-throwing']);
  assert.deepEqual(unhandled, []);
});

test('record listeners are isolated too and the committed write still lands', async () => {
  const calls = [];
  const events = {
    dispatch(_mode, [event, subject]) {
      assert.equal(event, 'credentials/record-updated');
      return [
        () => { throw new Error('synthetic-yes'); },
        () => { calls.push(subject); },
      ];
    },
  };
  const ctx = fakeContext(undefined, events);
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  const provider = ctx.provided.get('credentials');
  await provider.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant', payload: { a: 1 } }));
  await dispose();

  assert.deepEqual(calls, ['heluo-iam/session']);
});

test('listener failures log neither credentials nor changed references or records', async (t) => {
  const secret = 'synthetic-listener-secret';
  const reference = 'SYNTHETIC_PRIVATE_REF';
  const record = 'synthetic/private-record';
  const calls = [];
  const warnings = [];
  const ctx = fakeContext(undefined, {
    dispatch(_mode, [event, subject]) {
      return [
        () => { throw new Error(`synchronous ${secret}`); },
        async () => { throw new Error(`asynchronous ${secret}`); },
        () => { calls.push([event, subject]); },
      ];
    },
  });
  ctx.logger = { warn: (...args) => warnings.push(args) };
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  t.after(dispose);
  warnings.length = 0;
  const provider = ctx.provided.get('credentials');

  await provider.set(reference, secret);
  await provider.modifyRecord(record, () => ({ kind: 'grant', payload: { token: secret } }));
  await new Promise(setImmediate);

  assert.equal((await provider.resolve(reference)).value, secret);
  assert.deepEqual(await provider.readRecord(record), { kind: 'grant', payload: { token: secret } });
  assert.deepEqual(calls, [
    ['credentials/reference-updated', reference],
    ['credentials/record-updated', record],
  ]);
  assert.equal(warnings.length, 4);
  for (const args of warnings) {
    assert.equal(args.length, 1, 'raw exceptions must not reach the logger');
    assert.equal(typeof args[0], 'string');
    for (const privateValue of [secret, reference, record]) {
      assert.equal(args[0].includes(privateValue), false);
    }
  }
});

for (const failurePath of ['dispatch', 'emit', 'emit-async', 'emit-array']) {
  test(`${failurePath} failures do not log exception contents or references`, async (t) => {
    const reference = 'SYNTHETIC_PRIVATE_REF';
    const secret = 'synthetic-dispatch-secret';
    const warnings = [];
    const fail = () => {
      if (failurePath === 'dispatch' || failurePath === 'emit') throw new Error(secret);
      const rejected = Promise.reject(new Error(secret));
      return failurePath === 'emit-array' ? [undefined, rejected] : rejected;
    };
    const ctx = fakeContext(undefined, failurePath === 'dispatch' ? { dispatch: fail } : undefined);
    if (failurePath !== 'dispatch') ctx.emit = fail;
    ctx.logger = { warn: (...args) => warnings.push(args) };
    const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
    t.after(dispose);
    warnings.length = 0;
    const provider = ctx.provided.get('credentials');

    await provider.set(reference, secret);
    await new Promise(setImmediate);

    assert.equal((await provider.resolve(reference)).value, secret);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].length, 1, 'raw exceptions must not reach the logger');
    assert.equal(typeof warnings[0][0], 'string');
    assert.equal(warnings[0][0].includes(secret), false);
    assert.equal(warnings[0][0].includes(reference), false);
  });
}

test('a failing listener and logger cannot turn a committed write into a failure', async (t) => {
  const ctx = fakeContext(undefined, { dispatch: () => [() => { throw new Error('synthetic-listener'); }] });
  ctx.logger = { warn: () => { throw new Error('synthetic-logger'); } };
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  t.after(dispose);
  const provider = ctx.provided.get('credentials');

  await provider.set('SYNTHETIC_REF', 'synthetic-value');

  assert.equal((await provider.resolve('SYNTHETIC_REF')).value, 'synthetic-value');
});

test('an ephemeral in-memory backend is announced as non-durable', async () => {
  const warnings = [];
  const ctx = fakeContext();
  ctx.logger = { warn: (message) => warnings.push(message) };
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  await dispose();
  assert.equal(warnings.length, 1, '临时后端必须留下恰好一条启动提示');
  assert.match(warnings[0], /内存/u);
  assert.match(warnings[0], /失效/u);
});

test('a failing logger cannot block an ephemeral mount', async () => {
  const ctx = fakeContext();
  ctx.logger = { warn: () => { throw new Error('synthetic-logger'); } };
  const dispose = apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true });
  assert.equal(typeof ctx.provided.get('credentials')?.resolve, 'function');
  await dispose();
});

test('a backend that fails to close is still unprovided', async () => {
  const ctx = fakeContext();
  const backend = {
    ...createMemoryBackend(),
    async close() {
      throw new Error('synthetic close failure');
    },
  };
  const dispose = apply(ctx, { backend, allowEphemeral: true });
  assert.equal(ctx.provided.has('credentials'), true);
  await assert.rejects(dispose(), /synthetic close failure/u);
  assert.equal(ctx.provided.has('credentials'), false, '关闭失败也必须解除凭据提供方');
});

test('a storage directory inside a git work tree is refused at mount', async (t) => {
  const repository = outsideRepositoryTmp('forge-keychain-repo-');
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(repository, '.git'));
  const ctx = fakeContext();
  assert.throws(() => apply(ctx, { storeDirectory: join(repository, 'credentials') }),
    (error) => error.code === 'KEYCHAIN_FILE_INSIDE_REPOSITORY');
  assert.equal(ctx.provided.size, 0);
});

test('storeDirectory is validated and carried into the platform backend', () => {
  assert.equal(validateConfig({}).value.storeDirectory, '');
  assert.equal(validateConfig({ storeDirectory: '/tmp/heluo-uat' }).value.storeDirectory, '/tmp/heluo-uat');
  const invalid = validateConfig({ storeDirectory: 42 });
  assert.ok(invalid.issues.some((issue) => issue.path[0] === 'storeDirectory'));
});
