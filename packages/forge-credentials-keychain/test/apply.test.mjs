import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { outsideRepositoryTmp } from './support/tmp.mjs';
import { createMemoryBackend } from '../src/backend.mjs';
import { apply, Config, KeychainProviderError, nativeAddonPath, validateConfig } from '../src/index.mjs';

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

test('a plaintext file backend without explicit approval is refused', () => {
  const ctx = fakeContext();
  const filePath = join(outsideRepositoryTmp('forge-insecure-'), 'credentials.json');
  assert.throws(
    () => apply(ctx, { filePath }),
    (error) => {
      assert.equal(error.code, 'KEYCHAIN_INSECURE_FILE_REFUSED');
      assert.match(error.message, /allowInsecureFile=true/u);
      assert.equal(ctx.provided.has('credentials'), false);
      return true;
    },
  );
});

test('apply fails closed when the platform backend is unavailable', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, {}),
    (error) => {
      // Hosts with a staged addon stop at the unvetted gate; hosts without one
      // stop at the unavailable backend. Neither may mount anything.
      assert.ok(error.code === 'KEYCHAIN_UNAVAILABLE' || error.code === 'KEYCHAIN_UNVETTED_ADAPTER_REFUSED', error.code);
      return true;
    },
  );
});

test('the unavailable error names the reason and the development override', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, {}),
    (error) => {
      // Default composition never mounts a backend. On a platform with a staged
      // addon the failure is the unvetted gate; everywhere else it is the
      // unavailable backend. Both must be distinguishable from "misconfigured"
      // and both must name their own escape hatch.
      if (error.code === 'KEYCHAIN_UNVETTED_ADAPTER_REFUSED') {
        assert.match(error.message, /allowUnvettedPlatformAdapter/u);
        return true;
      }
      assert.equal(error.code, 'KEYCHAIN_UNAVAILABLE');
      assert.match(error.message, /(not implemented on this platform|staged addon for [a-z0-9-]+ is missing)/u);
      // The operator must be able to find the non-production escape hatch.
      assert.match(error.message, /fails closed/u);
      assert.match(error.message, /filePath/u);
      assert.match(error.message, /allowInsecureFile/u);
      return true;
    },
  );
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

test('the normalized config is accepted by a second validation and by apply', () => {
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
  dispose();
});

test('an explicit empty filePath means "no file backend" instead of an error', () => {
  const ok = validateConfig({ filePath: '' });
  assert.ok('value' in ok);
  assert.equal(ok.value.filePath, '');
  const bad = validateConfig({ filePath: 42 });
  assert.ok('issues' in bad);
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

test('an explicitly allowed plaintext file backend is announced as non-production', async () => {
  const warnings = [];
  const ctx = fakeContext();
  ctx.logger = { warn: (message) => warnings.push(message) };
  const filePath = join(outsideRepositoryTmp('forge-keychain-notice-'), 'credentials.json');
  const dispose = apply(ctx, { filePath, allowInsecureFile: true });
  await dispose();

  assert.equal(warnings.length, 1, '非生产后端必须留下恰好一条启动提示');
  assert.match(warnings[0], /非生产/u);
  assert.match(warnings[0], /明文文件/u);
  assert.equal(warnings[0].includes(filePath), false, '提示不得包含本地绝对路径');
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

test('a reviewed durable backend stays silent and a failing logger cannot block the mount', async () => {
  const silent = fakeContext();
  let calls = 0;
  silent.logger = { warn: () => { calls += 1; } };
  const durable = { ...createMemoryBackend(), durable: true };
  const reviewed = apply(silent, { backend: durable });
  await reviewed();
  assert.equal(calls, 0, '持久且已审核的后端不产生非生产提示');

  const throwing = fakeContext();
  throwing.logger = { warn: () => { throw new Error('synthetic-logger'); } };
  const filePath = join(outsideRepositoryTmp('forge-keychain-notice-'), 'credentials.json');
  const dispose = apply(throwing, { filePath, allowInsecureFile: true });
  assert.equal(typeof throwing.provided.get('credentials')?.resolve, 'function');
  await dispose();
});

test('native-keyring is accepted by config but still requires the unvetted opt-in', () => {
  assert.deepEqual(validateConfig({ platformAdapter: 'native-keyring' }).value.platformAdapter, 'native-keyring');
  assert.ok('issues' in validateConfig({ platformAdapter: 'native-keyring-unpinned' }), '未知适配器名必须被拒绝');
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { platformAdapter: 'native-keyring' }),
    (error) => error instanceof KeychainProviderError && error.code === 'KEYCHAIN_UNVETTED_ADAPTER_REFUSED',
  );
  assert.equal(ctx.provided.size, 0);
});

const hostAddon = nativeAddonPath(process.platform, process.arch);
test('an allowed native adapter without the module fails closed instead of writing a file', {
  // On a host whose own triple is staged the module is present and the mount
  // succeeds; the missing-addon path is covered on CI and other hosts.
  skip: hostAddon !== undefined && existsSync(hostAddon) && 'this host has a staged addon',
}, () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { platformAdapter: 'native-keyring', allowUnvettedPlatformAdapter: true }),
    (error) => error instanceof KeychainProviderError && error.code === 'KEYCHAIN_UNAVAILABLE',
  );
  assert.equal(ctx.provided.size, 0);
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

test('a plaintext document inside a git work tree is refused at mount', async () => {
  const repository = outsideRepositoryTmp('forge-keychain-repo-');
  mkdirSync(join(repository, '.git'));
  const inside = join(repository, 'credentials.json');
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { filePath: inside, allowInsecureFile: true }),
    (error) => error.code === 'KEYCHAIN_FILE_INSIDE_REPOSITORY',
  );
  assert.equal(ctx.provided.has('credentials'), false);

  // A neighbouring directory is not part of the work tree and stays usable.
  const outside = outsideRepositoryTmp('forge-keychain-outside-');
  const okContext = fakeContext();
  const dispose = apply(okContext, { filePath: join(outside, 'credentials.json'), allowInsecureFile: true });
  assert.equal(okContext.provided.has('credentials'), true);
  await dispose();
});
