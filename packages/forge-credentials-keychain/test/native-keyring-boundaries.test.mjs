import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeKeyringBackend, windowsRuntimeStatus } from '../src/native-keyring.mjs';

/**
 * The fake module mirrors the semantics documented from the upstream sources
 * (keyring-node 2.1.2 reading `windows-native-keyring-store` 1.1.0 and
 * `dbus-secret-service-keyring-store` 1.0.1): the account is the entry user,
 * enumeration is a store-wide scan that the binding filters, and store errors
 * arrive as plain `Error`s with no stable code.
 */
function fakeModule({ found = [], failSet, failGet, failList } = {}) {
  const store = new Map();
  class Entry {
    constructor(service, account) {
      this.service = service;
      this.account = account;
      this.id = `${service}\u0000${account}`;
    }
    async getPassword() {
      if (failGet !== undefined) throw failGet;
      return store.get(this.id) ?? null;
    }
    async setPassword(value) {
      if (failSet !== undefined) throw failSet;
      store.set(this.id, value);
    }
    async deletePassword() {
      return store.delete(this.id);
    }
  }
  return {
    Entry,
    AsyncEntry: Entry,
    async findCredentialsAsync() {
      if (failList !== undefined) throw failList;
      return found;
    },
  };
}

const backend = (options = {}) => createNativeKeyringBackend({ platform: 'win32', service: 'heluo-forge', ...options });

test('enumeration drops accounts that cannot be keys instead of failing the scan', async () => {
  const native = backend({
    platform: 'linux',
    enumeration: 'find-credentials',
    load: () => fakeModule({
      found: [
        { account: 'heluo-forge/iam/ref/A', password: 'one' },
        // Foreign credential whose target merely ends with the service name,
        // and a credential with no usable account name.
        { account: 'other-app.heluo-forge', password: 'two' },
        { account: '', password: 'three' },
        { account: 'heluo-forge/iam/ref/\u0007', password: 'four' },
      ],
    }),
  });
  assert.deepEqual(await native.list('heluo-forge/'), ['heluo-forge/iam/ref/A']);
  assert.deepEqual(await native.listEntries('heluo-forge/'), [{ key: 'heluo-forge/iam/ref/A', value: 'one' }]);
});

test('a store error during enumeration surfaces as KEYCHAIN_OPERATION_FAILED with the platform text', async () => {
  const native = backend({
    enumeration: 'find-credentials',
    load: () => fakeModule({ failList: new Error('Not a valid utf16 blob') }),
  });
  await assert.rejects(
    () => native.list('heluo-forge/'),
    (error) => error.code === 'KEYCHAIN_OPERATION_FAILED'
      && /enumeration failed/u.test(error.message)
      && /Not a valid utf16 blob/u.test(error.message),
  );
});

test('read and write failures are normalized instead of leaking a codeless error', async () => {
  const locked = new Error('Credential store is locked');
  await assert.rejects(
    () => backend({ load: () => fakeModule({ failGet: locked }) }).get('heluo-forge/iam/ref/A'),
    (error) => error.code === 'KEYCHAIN_OPERATION_FAILED' && /read failed/u.test(error.message) && /locked/u.test(error.message),
  );
  await assert.rejects(
    () => backend({ load: () => fakeModule({ failSet: new Error('ERROR_NOT_FOUND') }) }).set('heluo-forge/iam/ref/A', 'value'),
    (error) => error.code === 'KEYCHAIN_OPERATION_FAILED' && /write failed/u.test(error.message),
  );
});

test('keys with control characters are refused before reaching the store', async () => {
  const native = backend({ load: () => fakeModule() });
  await assert.rejects(
    () => native.set('heluo-forge/iam/ref/A\u0000B', 'value'),
    (error) => error.code === 'KEYCHAIN_KEY_INVALID',
  );
});

test('the Windows account limit is enforced in UTF-8 bytes and only on win32', async () => {
  const longKey = 'k'.repeat(514);
  await assert.rejects(
    () => backend({ load: () => fakeModule() }).set(longKey, 'value'),
    (error) => error.code === 'KEYCHAIN_KEY_TOO_LONG' && /514 > 513/u.test(error.message),
  );
  const linux = createNativeKeyringBackend({ platform: 'linux', service: 'heluo-forge', load: () => fakeModule() });
  await linux.set(longKey, 'value');
  assert.equal(await linux.get(longKey), 'value');
});

test('non-string, empty and ill-formed values are refused with distinct codes', async () => {
  const native = backend({ load: () => fakeModule() });
  await assert.rejects(() => native.set('heluo-forge/iam/ref/A', 42), (error) => error.code === 'KEYCHAIN_VALUE_INVALID');
  await assert.rejects(() => native.set('heluo-forge/iam/ref/A', ''), (error) => error.code === 'KEYCHAIN_VALUE_EMPTY');
  await assert.rejects(
    () => native.set('heluo-forge/iam/ref/A', 'ok\uD800tail'),
    (error) => error.code === 'KEYCHAIN_VALUE_INVALID' && /surrogate/u.test(error.message),
  );
});

test('the Windows blob limit counts UTF-16LE bytes, so astral characters cost four', async () => {
  const native = backend({ load: () => fakeModule() });
  const emoji = '\u{1F600}';
  assert.equal(Buffer.byteLength(emoji.repeat(640), 'utf16le'), 2560);
  await native.set('heluo-forge/iam/ref/A', emoji.repeat(640));
  await assert.rejects(
    () => native.set('heluo-forge/iam/ref/A', emoji.repeat(641)),
    (error) => error.code === 'KEYCHAIN_VALUE_TOO_LARGE',
  );
});

test('the Windows runtime probe reports exactly which DLL is missing', () => {
  assert.deepEqual(windowsRuntimeStatus({ systemRoot: 'C:/Windows', exists: () => true }), { ok: true, missing: [] });
  assert.deepEqual(
    windowsRuntimeStatus({ systemRoot: 'C:/Windows', exists: (path) => !path.endsWith('vcruntime140.dll') }),
    { ok: false, missing: ['vcruntime140.dll'] },
  );
  assert.deepEqual(
    windowsRuntimeStatus({ systemRoot: '', exists: () => true }),
    { ok: false, missing: ['vcruntime140.dll'], reason: 'SystemRoot is not set' },
  );
});

test('a Windows host without the C++ runtime fails with an actionable message', { skip: process.platform === 'win32' }, async () => {
  // On a real Windows host SystemRoot is set and the runtime is usually present,
  // so this branch is only deterministic where the check must fail.
  await assert.rejects(
    async () => createNativeKeyringBackend({ platform: 'win32', arch: 'x64', service: 'heluo-forge' }).get('heluo-forge/iam/ref/A'),
    (error) => error.code === 'KEYCHAIN_UNAVAILABLE'
      && /Visual C\+\+ 2015-2022 Redistributable/u.test(error.message)
      && /vcruntime140\.dll/u.test(error.message),
  );
});
