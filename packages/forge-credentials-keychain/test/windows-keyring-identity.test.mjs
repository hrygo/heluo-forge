import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeKeyringBackend } from '../src/native-keyring.mjs';

/** Model Windows target names as case-insensitive while keeping account metadata. */
function windowsStore() {
  const records = new Map();
  const canonical = (target) => target.toLowerCase();
  class Entry {
    constructor(service, account) {
      this.target = `${account}.${service}`;
      this.account = account;
    }

    static withTarget(target, service, account) {
      const entry = new Entry(service, account);
      entry.target = target;
      // The real 2.1.2 Windows builder writes an empty placeholder here,
      // even when constructing an entry merely to read or delete it.
      records.set(canonical(target), { target, account, password: '' });
      return entry;
    }

    async getPassword() {
      return records.get(canonical(this.target))?.password ?? null;
    }

    async setPassword(password) {
      const id = canonical(this.target);
      const account = records.get(id)?.account ?? this.account;
      records.set(id, { target: this.target, account, password });
    }

    async deletePassword() {
      return records.delete(canonical(this.target));
    }
  }

  return {
    Entry,
    AsyncEntry: Entry,
    records,
    async findCredentialsAsync(service, filter) {
      return [...records.values()]
        .filter(({ target }) => {
          const lower = target.toLowerCase();
          if (filter === undefined) return lower.endsWith(`.${service.toLowerCase()}`);
          if (filter.endsWith('*')) return lower.startsWith(filter.slice(0, -1).toLowerCase());
          return lower === filter.toLowerCase();
        })
        .map(({ account, password }) => ({ account, password }));
    },
  };
}

function createBackend(store, service = 'heluo-forge') {
  return createNativeKeyringBackend({
    service,
    platform: 'win32',
    arch: 'arm64',
    enumeration: 'find-credentials',
    load: () => store,
  });
}

test('Windows keys differing only by case remain independently readable, enumerable and removable', async () => {
  const store = windowsStore();
  const backend = createBackend(store);
  const upper = 'heluo-forge/iam/ref/Alpha';
  const lower = 'heluo-forge/iam/ref/alpha';

  await backend.set(upper, 'synthetic-upper');
  await backend.set(lower, 'synthetic-lower');
  assert.equal(await backend.get(upper), 'synthetic-upper');
  assert.equal(await backend.get(lower), 'synthetic-lower');
  assert.deepEqual(
    (await backend.listEntries('heluo-forge/iam/ref/')).sort((a, b) => a.key.localeCompare(b.key)),
    [{ key: upper, value: 'synthetic-upper' }, { key: lower, value: 'synthetic-lower' }]
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
  await backend.delete(lower);
  assert.equal(await backend.get(lower), undefined);
  assert.equal(await backend.get(upper), 'synthetic-upper');
  await backend.delete(upper);
  await backend.delete(upper);
  assert.equal(await backend.get(upper), undefined);
});

test('Windows service names differing only by case do not share a target', async () => {
  const store = windowsStore();
  const upper = createBackend(store, 'Forge.A');
  const lower = createBackend(store, 'forge.a');
  const key = 'namespace/key';
  await upper.set(key, 'synthetic-upper');
  await lower.set(key, 'synthetic-lower');
  assert.equal(await upper.get(key), 'synthetic-upper');
  assert.equal(await lower.get(key), 'synthetic-lower');
  assert.deepEqual(await upper.list(key), [key]);
  assert.deepEqual(await lower.list(key), [key]);
});

test('Windows legacy records are preserved and never mistaken for new-format data', async () => {
  const store = windowsStore();
  const key = 'heluo-forge/iam/ref/Alpha';
  const legacy = new store.Entry('heluo-forge', key);
  await legacy.setPassword('synthetic-legacy');
  const backend = createBackend(store);

  for (const run of [
    () => backend.get(key),
    () => backend.get(key.toLowerCase()),
    () => backend.set(key, 'synthetic-new'),
    () => backend.delete(key),
    () => backend.list('heluo-forge/iam/ref/'),
  ]) {
    await assert.rejects(run, (error) => {
      assert.equal(error.code, 'KEYCHAIN_LEGACY_RECORD');
      assert.equal(error.message.includes('synthetic-legacy'), false);
      return true;
    });
  }
  assert.equal(await legacy.getPassword(), 'synthetic-legacy');
  assert.equal(store.records.size, 1);
});

test('Windows reads and deletes of an absent key never create a credential', async () => {
  const store = windowsStore();
  const backend = createBackend(store);
  assert.equal(await backend.get('namespace/absent'), undefined);
  await backend.delete('namespace/absent');
  assert.deepEqual(await backend.list('namespace/'), []);
  assert.equal(store.records.size, 0);
});

test('a case-insensitive Windows prefix cannot silently hide a legacy record', async () => {
  const store = windowsStore();
  const legacy = new store.Entry('heluo-forge', 'namespace/Alpha');
  await legacy.setPassword('synthetic-legacy');
  await assert.rejects(() => createBackend(store).list('namespace/alpha'), (error) => error.code === 'KEYCHAIN_LEGACY_RECORD');
  assert.equal(await legacy.getPassword(), 'synthetic-legacy');
});

test('a legacy record that appears beside a new record blocks access without modifying either', async () => {
  const store = windowsStore();
  const key = 'namespace/Alpha';
  const backend = createBackend(store);
  await backend.set(key, 'synthetic-new');
  const legacy = new store.Entry('heluo-forge', key);
  await legacy.setPassword('synthetic-legacy');
  for (const run of [() => backend.get(key), () => backend.set(key, 'changed'), () => backend.delete(key)]) {
    await assert.rejects(run, (error) => error.code === 'KEYCHAIN_LEGACY_RECORD');
  }
  assert.equal(await legacy.getPassword(), 'synthetic-legacy');
  assert.deepEqual([...store.records.values()].map(({ password }) => password).sort(), ['synthetic-legacy', 'synthetic-new']);
});

test('a different service with the same account does not contaminate listing', async () => {
  const store = windowsStore();
  const backend = createBackend(store);
  const key = 'namespace/key';
  await backend.set(key, 'synthetic-owned');
  await new store.Entry('foreign-service', key).setPassword('synthetic-foreign');
  assert.deepEqual(await backend.listEntries('namespace/'), [{ key, value: 'synthetic-owned' }]);
  assert.equal(await new store.Entry('foreign-service', key).getPassword(), 'synthetic-foreign');
});

test('Windows listing reads its own target and refuses invalid account metadata', async () => {
  for (const replace of [
    () => [{ account: '', password: 'synthetic' }],
    () => [{ password: 'synthetic' }],
  ]) {
    const store = windowsStore();
    const backend = createBackend(store);
    await backend.set('namespace/key', 'synthetic-value');
    const list = store.findCredentialsAsync;
    store.findCredentialsAsync = async (service, filter) => {
      const found = await list(service, filter);
      return filter === undefined ? found : replace(found);
    };
    await assert.rejects(() => backend.list('namespace/'), (error) => error.code === 'KEYCHAIN_OPERATION_FAILED');
    assert.equal(await backend.get('namespace/key'), 'synthetic-value');
  }
});

test('Windows does not require the unsafe explicit-target factory', async () => {
  const store = windowsStore();
  store.Entry.withTarget = undefined;
  const backend = createBackend(store);
  await backend.set('namespace/key', 'synthetic-value');
  assert.equal(await backend.get('namespace/key'), 'synthetic-value');
});

test('Windows refuses an enumeration prefix containing a wildcard', async () => {
  const backend = createBackend(windowsStore());
  await assert.rejects(() => backend.list('namespace/*'), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');
});

test('Windows rejects malformed Unicode keys instead of mapping different keys to the same target', async () => {
  const backend = createBackend(windowsStore());
  await assert.rejects(() => backend.set('key/\ud800', 'synthetic-value'), (error) => error.code === 'KEYCHAIN_KEY_INVALID');
});

test('Windows ARM64 missing-runtime diagnostic names ARM64', { skip: process.platform === 'win32' }, () => {
  assert.throws(
    () => createNativeKeyringBackend({ platform: 'win32', arch: 'arm64', service: 'heluo-forge' }),
    (error) => error.code === 'KEYCHAIN_UNAVAILABLE'
      && /Redistributable \(arm64\)/u.test(error.message)
      && /vcruntime140\.dll/u.test(error.message),
  );
});
