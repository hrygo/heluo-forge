import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPlatformBackend, nativeAddonPath, nativeTargetFor, resolvePlatformBackend } from '../src/index.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = join(packageRoot, 'vendor');
const checksums = JSON.parse(readFileSync(join(nativeRoot, 'CHECKSUMS.json'), 'utf8'));

const store = new Map();

class FakeEntry {
  constructor(service, key) {
    this.id = `${service}\u0000${key}`;
  }
  async getPassword() {
    return store.get(this.id) ?? null;
  }
  async setPassword(value) {
    store.set(this.id, value);
  }
  async deletePassword() {
    return store.delete(this.id);
  }
}

const fakeLoad = () => ({ Entry: FakeEntry, AsyncEntry: FakeEntry });

test('platform-arch maps to a delivery triple, and only those', () => {
  assert.equal(nativeTargetFor('win32', 'x64'), 'win32-x64-msvc');
  assert.equal(nativeTargetFor('win32', 'arm64'), 'win32-arm64-msvc');
  assert.equal(nativeTargetFor('linux', 'x64'), 'linux-x64-gnu');
  assert.equal(nativeTargetFor('linux', 'arm64'), 'linux-arm64-gnu');
  assert.equal(nativeTargetFor('darwin', 'arm64'), 'darwin-arm64');
  // Not delivery targets: never a triple, never a silent downgrade.
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'ia32'], ['linux', 'ia32'], ['freebsd', 'x64']]) {
    assert.equal(nativeTargetFor(platform, arch), undefined, `${platform}-${arch} must stay unmapped`);
    assert.equal(nativeAddonPath(platform, arch), undefined);
  }
});

test('a staged addon resolves to this package, not to node_modules', () => {
  const addon = nativeAddonPath('win32', 'x64');
  assert.ok(addon.endsWith(join('vendor', 'win32-x64-msvc', 'keyring.node')), addon);
  assert.ok(addon.startsWith(packageRoot), 'the addon must live inside the installed package');
  assert.doesNotMatch(addon, /node_modules/u);
});

test('an unmapped platform-arch still gets the unavailable backend', () => {
  const backend = resolvePlatformBackend({ platform: 'darwin', arch: 'x64' });
  assert.equal(backend.available, false);
  assert.match(backend.reason, /not implemented for darwin-x64|fails closed/u);
  // Even where this host has a staged addon, an explicit pair never borrows it.
  assert.equal(resolvePlatformBackend({ platform: 'linux', arch: 'ia32' }).available, false);
});

test('a supported platform selects the native backend, unvetted until evidence lands', () => {
  const backend = resolvePlatformBackend({ platform: 'win32', arch: 'x64', load: fakeLoad, service: 'heluo-forge-test' });
  assert.equal(backend.kind, 'native-keyring');
  assert.equal(backend.available, true);
  assert.equal(backend.durable, true);
  // Release gate: the adapter is not vetted until target-machine evidence exists.
  assert.equal(backend.unvetted, true);
  assert.equal(backend.production, false);
  assert.equal(backend.enumeration, 'unsupported');

  const vetted = resolvePlatformBackend({ platform: 'linux', arch: 'arm64', load: fakeLoad, service: 'heluo-forge-test', vetted: true });
  assert.equal(vetted.unvetted, false);
  assert.equal(vetted.production, true);
});

test('the native backend reaches the injected store end to end', async () => {
  const backend = resolvePlatformBackend({ platform: 'linux', arch: 'x64', load: fakeLoad, service: 'heluo-forge-test' });
  await backend.set('iam/token', 'synthetic-value');
  assert.equal(await backend.get('iam/token'), 'synthetic-value');
  await backend.delete('iam/token');
  assert.equal(await backend.get('iam/token'), undefined);
});

test('enumeration stays refused until it is verified per platform', async () => {
  const backend = resolvePlatformBackend({ platform: 'win32', arch: 'x64', load: fakeLoad, service: 'heluo-forge-test' });
  await assert.rejects(() => backend.list('iam/'), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');

  const listing = () => ({ Entry: FakeEntry, AsyncEntry: FakeEntry, findCredentialsAsync: async () => [{ account: 'iam/token', password: 'synthetic-value' }] });
  const optedIn = resolvePlatformBackend({
    platform: 'win32',
    arch: 'x64',
    load: listing,
    service: 'heluo-forge-test',
    enumeration: 'find-credentials',
  });
  assert.deepEqual(await optedIn.list('iam/'), ['iam/token']);
});

test('the lock file names exactly the delivery addons', () => {
  const recorded = Object.keys(checksums.files ?? {});
  const expected = JSON.parse(readFileSync(join(packageRoot, '../../scripts/native-keyring.json'), 'utf8'))
    .targets.map((target) => `${target.triple}/keyring.node`)
    .sort();
  assert.deepEqual(recorded.sort(), expected);
  for (const [relative, expected] of Object.entries(checksums.files)) {
    const absolute = join(nativeRoot, relative);
    // A clean clone carries the lock file but not the addons: staging is a build
    // step (binary files are never committed). Verify bytes only when staged.
    if (!existsSync(absolute)) continue;
    const bytes = readFileSync(absolute);
    assert.equal(bytes.length, expected.bytes, `${relative} size drifted`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${relative} content drifted`);
    assert.equal(expected.version, '2.1.2');
    assert.equal(expected.license, 'MIT');
  }
  // Every recorded file belongs to a mapped triple; nothing stray is shipped.
  for (const relative of recorded) assert.equal(nativeTargetFor(...relative.split('/')[0].split('-').slice(0, 2)), relative.split('/')[0]);
});