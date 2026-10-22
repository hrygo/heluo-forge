import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../src/backend.mjs';
import { apply, Config, KeychainProviderError, validateConfig } from '../src/index.mjs';

function fakeContext(existing = undefined) {
  const provided = new Map();
  return {
    provided,
    get(name) {
      return name === 'credentials' ? existing : undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
  };
}

test('apply registers credentials with an explicitly allowed ephemeral backend', () => {
  const ctx = fakeContext();
  const backend = createMemoryBackend();
  const dispose = apply(ctx, { backend, allowEphemeral: true });
  assert.equal(typeof ctx.provided.get('credentials')?.resolve, 'function');
  dispose();
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

test('apply fails closed when the platform backend is unavailable', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, {}),
    (error) => error.code === 'KEYCHAIN_UNAVAILABLE',
  );
});

test('apply requires ctx.get to prove no provider is mounted', () => {
  const ctx = { provide() {} };
  assert.throws(
    () => apply(ctx, { backend: createMemoryBackend(), allowEphemeral: true }),
    (error) => error.code === 'KEYCHAIN_CREDENTIALS_CHECK_UNAVAILABLE',
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