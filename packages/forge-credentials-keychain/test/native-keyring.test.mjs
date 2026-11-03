import test from 'node:test';
import assert from 'node:assert/strict';
import { KeychainBackendError } from '../src/backend.mjs';
import { createNativeKeyringBackend, WINDOWS_BLOB_LIMIT_BYTES } from '../src/native-keyring.mjs';
import { createKeychainProvider } from '../src/provider.mjs';

/**
 * A synthetic stand-in for the release 2.1.2 module: same synchronous surface,
 * no OS store, no real credentials.
 */
function fakeModule({ initial = new Map(), credentials, failOn, getPasswordValue } = {}) {
  const entries = new Map(initial);
  const created = [];
  class Entry {
    constructor(service, account, options) {
      if (failOn === 'construct') throw new Error('synthetic store unavailable');
      this.service = service;
      this.account = account;
      this.options = options;
      created.push({ service, account, options });
    }
    getPassword() {
      if (failOn === 'get') throw new Error('synthetic store locked');
      if (getPasswordValue !== undefined) return getPasswordValue;
      return entries.has(this.account) ? entries.get(this.account) : null;
    }
    setPassword(value) {
      if (failOn === 'set') throw new Error('synthetic store denied');
      entries.set(this.account, value);
    }
    deletePassword() {
      if (failOn === 'delete') throw new Error('synthetic store denied');
      return entries.delete(this.account);
    }
  }
  const module = { Entry };
  if (credentials !== 'absent') {
    module.findCredentials = (service) => {
      if (failOn === 'list') throw new Error('synthetic store locked');
      const declared = credentials ?? [...entries.entries()].map(([account, password]) => ({ account, password }));
      return declared.filter((item) => item.service === undefined || item.service === service);
    };
  }
  return { module, entries, created };
}

function backendFor(fake, options = {}) {
  return createNativeKeyringBackend({ service: 'heluo-forge-test', load: () => fake.module, platform: 'darwin', ...options });
}

test('an absent entry is undefined, not null or a corrupt record', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  assert.equal(await backend.get('heluo-forge-test/iam/ref/MISSING'), undefined);

  // The provider only treats undefined as "absent"; a forwarded null would make
  // an empty store look like an invalid record.
  const provider = createKeychainProvider(backend, { service: 'heluo-forge-test', accountPrefix: 'iam' });
  assert.equal(await provider.readRecord('heluo-iam/session'), undefined);
  // 枚举默认不支持时，空库也必须显式失败，不能谎报“没有记录”。
  await assert.rejects(provider.listRecords(), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');
});

test('values round-trip as the exact string and deletes are idempotent', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  const key = 'heluo-forge-test/iam/record/heluo-iam/session';
  await backend.set(key, '{"kind":"grant","payload":{"a":1}}');
  assert.equal(await backend.get(key), '{"kind":"grant","payload":{"a":1}}');
  assert.equal(fake.entries.get(key), '{"kind":"grant","payload":{"a":1}}', '不做二次 JSON 序列化');
  await backend.delete(key);
  assert.equal(await backend.get(key), undefined);
  await backend.delete(key);
});

test('empty values are rejected before they reach the store', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  await assert.rejects(backend.set('heluo-forge-test/iam/ref/A', ''), (error) => error.code === 'KEYCHAIN_VALUE_EMPTY');
  assert.equal(fake.entries.size, 0);
});

test('the full backend key is preserved so the provider namespace survives', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  const provider = createKeychainProvider(backend, { service: 'heluo-forge-test', accountPrefix: 'iam' });
  await provider.set('ENTERPRISE_STATIC_KEY', 'synthetic-value');
  assert.deepEqual(
    fake.created.map((item) => item.account),
    ['heluo-forge-test/iam/ref/ENTERPRISE_STATIC_KEY'],
    '通用 service/accountPrefix 前缀必须原样保存，不能缩成 IAM 专用键',
  );
  assert.deepEqual(await provider.resolve('ENTERPRISE_STATIC_KEY'), { value: 'synthetic-value', source: 'keychain' });
});

test('Linux entries are pinned to Secret Service instead of the keyutils fallback', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake, { platform: 'linux' });
  await backend.get('heluo-forge-test/iam/ref/A');
  assert.deepEqual(fake.created[0].options, { linux: { store: 'secret-service' } });
});

test('non-Linux entries pass no options bag', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake, { platform: 'win32' });
  await backend.get('heluo-forge-test/iam/ref/A');
  assert.equal(fake.created[0].options, undefined);
});

test('the backend never advertises read-modify-write atomicity', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  assert.equal(backend.transaction, undefined, '本样机不提供事务，不得让 provider 走原子分支');
  assert.equal(backend.crossProcessLock, undefined);
  const provider = createKeychainProvider(backend, { service: 'heluo-forge-test', accountPrefix: 'iam' });
  assert.equal(provider.durable, true);
  assert.equal(provider.crossProcessLock, false, 'provider 不得自报跨进程锁');
});

test('enumeration is unsupported by default and never reports an empty store', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  await assert.rejects(
    backend.list('heluo-forge-test/iam/record/'),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_LIST_UNSUPPORTED',
  );
});

test('opted-in enumeration filters the prefix and returns accounts only', async () => {
  const credentials = [
    { account: 'heluo-forge-test/iam/record/heluo-iam/session', password: 'synthetic-secret-a' },
    { account: 'heluo-forge-test/iam/record/heluo-iam/gateway-credential', password: 'synthetic-secret-b' },
    { account: 'heluo-forge-test/iam/ref/ENTERPRISE_STATIC_KEY', password: 'synthetic-secret-c' },
    { account: 'other-service/iam/record/x/y', password: 'synthetic-secret-d' },
  ];
  const backend = backendFor(fakeModule({ credentials }), { enumeration: 'find-credentials' });
  const keys = await backend.list('heluo-forge-test/iam/record/');
  assert.deepEqual(keys, [
    'heluo-forge-test/iam/record/heluo-iam/session',
    'heluo-forge-test/iam/record/heluo-iam/gateway-credential',
  ]);
  for (const key of keys) assert.equal(typeof key, 'string');
  assert.equal(JSON.stringify(keys).includes('synthetic-secret'), false, '枚举只返回 account，不返回密码');
});

test('enumeration failures propagate instead of looking like an empty store', async () => {
  const backend = backendFor(fakeModule({ failOn: 'list' }), { enumeration: 'find-credentials' });
  await assert.rejects(backend.list('heluo-forge-test/iam/record/'), /synthetic store locked/u);
});

test('a module without findCredentials reports unsupported rather than empty', async () => {
  const backend = backendFor(fakeModule({ credentials: 'absent' }), { enumeration: 'find-credentials' });
  await assert.rejects(backend.list('heluo-forge-test/iam/record/'), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');
});

test('an entry without a string account is an error, not a silent skip', async () => {
  const backend = backendFor(fakeModule({ credentials: [{ account: 7 }] }), { enumeration: 'find-credentials' });
  await assert.rejects(backend.list('heluo-forge-test/iam/record/'), (error) => error.code === 'KEYCHAIN_OPERATION_FAILED');
});

test('Windows records are bounded by the credential blob limit in UTF-16LE bytes', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake, { platform: 'win32' });
  const key = 'heluo-forge-test/iam/record/heluo-iam/session';

  // 1280 UTF-16 code units == 2560 bytes: exactly at the documented limit.
  const atLimit = 'a'.repeat(1280);
  assert.equal(Buffer.byteLength(atLimit, 'utf16le'), WINDOWS_BLOB_LIMIT_BYTES);
  await backend.set(key, atLimit);
  assert.equal(await backend.get(key), atLimit);

  // One more code unit is 2562 bytes and must be refused without touching the
  // stored value.
  await assert.rejects(
    backend.set(key, 'a'.repeat(1281)),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_VALUE_TOO_LARGE',
  );
  assert.equal(await backend.get(key), atLimit, '拒绝后原值不变');

  // Non-ASCII widens the byte count; 1280 CJK code units are 2560 bytes, and a
  // surrogate pair costs four bytes per code point.
  assert.equal(Buffer.byteLength('中'.repeat(1280), 'utf16le'), WINDOWS_BLOB_LIMIT_BYTES);
  await assert.rejects(
    backend.set(key, '😀'.repeat(641)),
    (error) => error.code === 'KEYCHAIN_VALUE_TOO_LARGE',
  );
});

test('the size error reports bytes only and never the credential', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake, { platform: 'win32' });
  const secret = `synthetic-${'x'.repeat(1400)}`;
  await assert.rejects(backend.set('heluo-forge-test/iam/record/heluo-iam/session', secret), (error) => {
    assert.equal(error.code, 'KEYCHAIN_VALUE_TOO_LARGE');
    assert.match(error.message, /2560/u);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('synthetic-'), false);
    return true;
  });
});

test('an unavailable module fails closed at construction', async () => {
  for (const load of [
    () => { throw new KeychainBackendError('KEYCHAIN_UNAVAILABLE', 'synthetic'); },
    () => undefined,
    () => ({ notEntry: true }),
    () => Promise.resolve({ Entry: class {} }),
  ]) {
    assert.throws(
      () => createNativeKeyringBackend({ service: 'heluo-forge-test', load }),
      (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_UNAVAILABLE',
    );
  }
});

test('an invalid service is refused before any store call', () => {
  for (const service of ['', 'has space', 'a/b']) {
    assert.throws(
      () => createNativeKeyringBackend({ service, load: () => ({ Entry: class {} }) }),
      (error) => error.code === 'KEYCHAIN_SERVICE_INVALID',
    );
  }
});

test('store read failures propagate instead of reading as absent', async () => {
  const backend = backendFor(fakeModule({ failOn: 'get' }));
  await assert.rejects(backend.get('heluo-forge-test/iam/ref/A'), /synthetic store locked/u);
});

test('a non-string value from the native module is an operation failure', async () => {
  const backend = backendFor(fakeModule({ getPasswordValue: 42 }));
  await assert.rejects(backend.get('heluo-forge-test/iam/ref/A'), (error) => error.code === 'KEYCHAIN_OPERATION_FAILED');
});

test('delete failures are never reported as an absent entry', async () => {
  const backend = backendFor(fakeModule({ failOn: 'delete' }));
  await assert.rejects(backend.delete('heluo-forge-test/iam/ref/A'), /synthetic store denied/u);
});

test('opted-in enumeration drives listRecords end to end and never leaks reference values', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake, { enumeration: 'find-credentials' });
  const provider = createKeychainProvider(backend, { service: 'heluo-forge-test', accountPrefix: 'iam' });

  await provider.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant', payload: { sub: 'synthetic' } }));
  await provider.set('ENTERPRISE_STATIC_KEY', 'synthetic-static-key');

  // 枚举只回读记录命名空间下的条目：ref 不是 record，不能出现在结果里。
  assert.deepEqual(await provider.listRecords(), [{ key: 'heluo-iam/session', kind: 'grant' }]);
  const keys = await backend.list('heluo-forge-test/iam/record/');
  assert.deepEqual(keys, ['heluo-forge-test/iam/record/heluo-iam/session']);
  assert.equal(await backend.get('heluo-forge-test/iam/ref/ENTERPRISE_STATIC_KEY'), 'synthetic-static-key');
});

test('an entry without an account is an operation failure instead of being skipped', async () => {
  const backend = backendFor(fakeModule({ credentials: [{ password: 'synthetic' }] }), { enumeration: 'find-credentials' });
  await assert.rejects(
    backend.list('heluo-forge-test/iam/record/'),
    (error) => error.code === 'KEYCHAIN_OPERATION_FAILED',
  );
});

test('an async entry class is preferred so the store round-trip never blocks the host', async () => {
  const events = [];
  class Entry {
    constructor() {
      throw new Error('the synchronous class must not be used when AsyncEntry exists');
    }
  }
  class AsyncEntry {
    constructor(service, account) {
      this.account = account;
    }
    async getPassword() {
      return 'value-from-async';
    }
    async setPassword(value) {
      events.push(`set:${value}`);
    }
    async deletePassword() {
      events.push('delete');
      return true;
    }
  }
  const backend = createNativeKeyringBackend({
    service: 'heluo-forge-test',
    platform: 'darwin',
    load: () => ({ Entry, AsyncEntry }),
  });
  await backend.set('key', 'value');
  assert.equal(await backend.get('key'), 'value-from-async');
  await backend.delete('key');
  assert.deepEqual(events, ['set:value', 'delete']);
});

test('a module that only exports the synchronous class still works', async () => {
  const fake = fakeModule();
  const backend = backendFor(fake);
  await backend.set('key', 'value');
  assert.equal(await backend.get('key'), 'value');
  assert.deepEqual(fake.created.map((item) => item.account), ['key', 'key']);
});

test('enumeration awaits findCredentialsAsync when the module exposes it', async () => {
  const seen = [];
  class Entry {}
  const module = {
    Entry,
    async findCredentialsAsync(service) {
      seen.push(service);
      return [{ account: 'heluo-forge-test/a' }, { account: 'heluo-forge-test/b' }];
    },
  };
  const backend = createNativeKeyringBackend({
    service: 'heluo-forge-test',
    platform: 'darwin',
    load: () => module,
    enumeration: 'find-credentials',
  });
  assert.deepEqual(await backend.list('heluo-forge-test/'), ['heluo-forge-test/a', 'heluo-forge-test/b']);
  assert.deepEqual(seen, ['heluo-forge-test']);
});
