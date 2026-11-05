import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

// U5 of docs/plans/2026-11-05-forge-iam-structure.md: the published session
// state has one owner. `src/service-state.mjs` declares and mutates it;
// `src/service.mjs` may only read `ctx.*` through the returned object.

const service = readFileSync(new URL('../src/service.mjs', import.meta.url), 'utf8');
const state = readFileSync(new URL('../src/service-state.mjs', import.meta.url), 'utf8');

const OWNED = ['state', 'error', 'lastGrant', 'disposed', 'exclusive'];

test('the service keeps no writable copy of the published state', () => {
  for (const name of OWNED) {
    for (const pattern of [`let ${name} =`, `let ${name};`, `var ${name} =`]) {
      assert.ok(
        !service.includes(pattern),
        `src/service.mjs still declares "${pattern}"; the value belongs to service-state.mjs`,
      );
    }
  }
});

test('the service reaches the state only through the created object', () => {
  assert.match(service, /import \{ createServiceState \} from '\.\/service-state\.mjs';/);
  assert.match(service, /const ctx = createServiceState\(\{/);
  // A bare write would bypass the object the module owns.
  for (const name of OWNED) {
    assert.ok(
      !new RegExp(`(^|[^.\\w$])${name}\\s*=[^=]`, 'm').test(service),
      `src/service.mjs still assigns to bare "${name}"`,
    );
  }
});

test('the state module owns the five values and the publish path', () => {
  for (const name of OWNED) {
    assert.match(state, new RegExp(`get ${name}\\(\\)`), `service-state.mjs must expose ${name}`);
    assert.match(state, new RegExp(`set ${name}\\(`), `service-state.mjs must own writes to ${name}`);
  }
  for (const fn of ['view', 'notify', 'publish', 'fail', 'recheckExclusive', 'assertExclusive', 'knownIssuer']) {
    assert.match(state, new RegExp(`function ${fn}\\(`), `service-state.mjs must define ${fn}`);
  }
});

test('listeners are registered through the state module, not a local set', () => {
  assert.ok(!/const listeners = new Set\(\)/.test(service), 'src/service.mjs must not keep its own listener set');
  assert.match(service, /ctx\.addListener\(listener\)/);
  assert.match(service, /ctx\.removeListener\(listener\)/);
  assert.match(service, /ctx\.clearListeners\(\)/);
});

// U6: the credentials provider and its caches have the same single owner.
const provider = readFileSync(new URL('../src/service-store.mjs', import.meta.url), 'utf8');

test('the service keeps no writable copy of the provider state', () => {
  for (const name of ['store', 'storeCredentials', 'storeError', 'gatewayStore', 'modelSelectionStore',
    'gatewaySummary', 'gatewayLoadedAt', 'gatewayLoading', 'gatewayEpoch']) {
    assert.ok(
      !new RegExp(`let ${name}\\b`).test(service),
      `src/service.mjs still declares "let ${name}"; the value belongs to service-store.mjs`,
    );
  }
});

test('the provider module owns the handles and exposes one entry point', () => {
  assert.match(service, /import \{ createServiceStore \} from '\.\/service-store\.mjs';/);
  assert.match(service, /const provider = createServiceStore\(\{ options \}\);/);
  assert.match(provider, /export function createServiceStore\(\{ options \}\)/);
  for (const fn of ['ensure', 'require', 'atomicVerified', 'assertAtomic']) {
    assert.match(provider, new RegExp(`function ${fn}\\(`), `service-store.mjs must define ${fn}`);
  }
  // Revocation cleanup stays in one place: it is the branch that used to leave a
  // stale summary behind.
  // Revoked, reopened and failed-open all bump the epoch, so no in-flight read survives.
  assert.equal((provider.match(/gatewayEpoch \+= 1/g) ?? []).length, 3);
});

// U7: grants and the protocol caches have the same single owner.
const grant = readFileSync(new URL('../src/service-grant.mjs', import.meta.url), 'utf8');

test('the service keeps no writable copy of the grant caches', () => {
  for (const name of ['metadataCache', 'jwksCache', 'identityProfile', 'grantOwners']) {
    assert.ok(
      !new RegExp(`(let|const) ${name}\\b`).test(service),
      `src/service.mjs still declares "${name}"; the value belongs to service-grant.mjs`,
    );
  }
  // Ownership of a grant is only ever decided by the module that mints it.
  assert.ok(!/grantOwners\.(get|set|has)\(/.test(service), 'src/service.mjs must not reach into the owner map');
});

test('the grant module owns binding, context and protocol caches', () => {
  assert.match(service, /const grants = createServiceGrant\(\{/);
  assert.match(grant, /export function createServiceGrant\(env\)/);
  for (const fn of ['prepareAuthentication', 'rememberAuthentication', 'metadata', 'jwks', 'verifyWithJwks',
    'grantFromToken', 'buildGrant', 'assertGrantBinding', 'assertGrantContext', 'redirectUri', 'loadIdentityProfile']) {
    assert.match(grant, new RegExp(`function ${fn}\\(`), `service-grant.mjs must define ${fn}`);
  }
  for (const api of ['own', 'ownerOf', 'had', 'clearProfile', 'cachedIssuer']) {
    assert.match(grant, new RegExp(`${api}[,(]`), `service-grant.mjs must expose ${api}`);
  }
});

// U8: gateway credential display state and the default-model flight.
const gateway = readFileSync(new URL('../src/service-gateway.mjs', import.meta.url), 'utf8');
const selection = readFileSync(new URL('../src/service-model-selection.mjs', import.meta.url), 'utf8');

test('the service keeps no writable copy of the selection or gateway flights', () => {
  for (const name of ['modelSelectionFlight', 'modelSelectionQueued', 'modelSelectionGeneration']) {
    assert.ok(!new RegExp(`let ${name}\\b`).test(service), `src/service.mjs still declares "let ${name}"`);
  }
  assert.match(service, /const selection = createModelSelection\(\{/);
  assert.match(service, /const gateway = createServiceGateway\(\{/);
});

test('the gateway owns the credential cache and depends on selection one way', () => {
  for (const fn of ['read', 'load']) {
    assert.match(gateway, new RegExp(`function ${fn}\\(`), `service-gateway.mjs must define ${fn}`);
  }
  // The change hook is the only edge into selection; selection reaches back only
  // through the injected loader.
  assert.match(gateway, /selection\.schedule\(\)/);
  assert.ok(!/from '\.\/service-gateway\.mjs'/.test(selection), 'selection must not import the gateway');
  assert.match(selection, /getLoadGateway/);
});

test('selection keeps one flight, one queue flag and its own generation', () => {
  assert.match(selection, /export function createModelSelection\(env\)/);
  for (const fn of ['owner', 'services', 'schedule', 'reconcile']) {
    assert.match(selection, new RegExp(`function ${fn}\\(`), `service-model-selection.mjs must define ${fn}`);
  }
  assert.equal((selection.match(/queued = true/g) ?? []).length, 2);
});

// U9: the refresh flight owns its own lifetime.
const token = readFileSync(new URL('../src/service-token.mjs', import.meta.url), 'utf8');

test('the service keeps no writable copy of the refresh flight', () => {
  for (const name of ['refreshPromise', 'refreshPromiseStore', 'refreshPromiseCredentials',
    'refreshPromiseIssuer', 'refreshPromiseAuthentication', 'lastBackgroundRefreshAt']) {
    assert.ok(!new RegExp(`let ${name}\\b`).test(service), `src/service.mjs still declares "let ${name}"`);
  }
  assert.match(service, /const token = createTokenResolver\(\{/);
  assert.match(service, /resolveToken: token\.resolveToken,/);
  assert.match(service, /getAccessToken: token\.getAccessToken,/);
});

test('the refresh flight records the provider it started on', () => {
  assert.match(token, /export function createTokenResolver\(env\)/);
  for (const name of ['refreshPromiseStore', 'refreshPromiseCredentials', 'refreshPromiseIssuer', 'refreshPromiseAuthentication']) {
    assert.match(token, new RegExp(`let ${name} = null`), `service-token.mjs must record ${name}`);
  }
  // One flight at a time: a second caller joins instead of starting its own.
  assert.match(token, /if \(refreshPromise\) return useSharedRefresh\(\);/);
});

// U10: the background reconciler owns adoption; the state module still owns state.
const reconcile = readFileSync(new URL('../src/service-reconcile.mjs', import.meta.url), 'utf8');

test('the reconciler is the only background writer of the session', () => {
  assert.match(service, /const reconcile = createReconciler\(\{/);
  assert.match(service, /hydrate: reconcile\.hydrate,/);
  assert.match(service, /syncFromStore: reconcile\.syncFromStore,/);
  assert.ok(!/async function syncFromStore\(/.test(service), 'src/service.mjs must not keep its own syncFromStore');
  assert.match(reconcile, /export function createReconciler\(env\)/);
});

test('the reconciler publishes through ports, never by reaching into the state', () => {
  assert.match(reconcile, /setObservation\(/);
  assert.match(reconcile, /bumpPublications\(\)/);
  // The observation identity comparison must read the field, not call the port.
  assert.ok(!/observation\.getAuthEpoch\(/.test(reconcile), 'observation.authEpoch is a field, not a port call');
});

// U11a: the sign-in attempt is owned by one module, exactly once at a time.
const signin = readFileSync(new URL('../src/service-signin.mjs', import.meta.url), 'utf8');

test('the service keeps no copy of the attempt or its promise', () => {
  assert.ok(!/let attempt\b/.test(service), 'src/service.mjs must not declare the attempt');
  assert.match(service, /const signin = createSignIn\(\{/);
  assert.match(service, /startSignIn: signin\.startSignIn,/);
  assert.match(service, /handleCallback: signin\.handleCallback,/);
  assert.match(service, /cancelSignIn: signin\.cancelSignIn,/);
  assert.match(service, /function clearAttempt\(\) \{ signin\.clearAttempt\(\); \}/);
});

test('the attempt records the verifier it will check the callback against', () => {
  assert.match(signin, /export function createSignIn\(env\)/);
  assert.match(signin, /let attempt = null;/);
  for (const field of ['verifier', 'nonce', 'redirectUri', 'expiresAt']) {
    assert.match(signin, new RegExp(`${field}:`), `the attempt must record ${field}`);
  }
  // A second attempt replaces the first only through clearAttempt, which also
  // cancels its timer.
  assert.match(signin, /function clearAttempt\(\)/);
  assert.match(signin, /clearTimeout\(attempt\.timer\)/);
});

// U11b: sign-out is one registered flight; its flag is read elsewhere by port.
const signout = readFileSync(new URL('../src/service-signout.mjs', import.meta.url), 'utf8');

test('the service keeps no copy of the sign-out flight', () => {
  for (const name of ['signOutPromise', 'signingOut']) {
    assert.ok(!new RegExp(`let ${name}\\b`).test(service), `src/service.mjs still declares "let ${name}"`);
  }
  assert.match(service, /const signout = createSignOut\(\{/);
  assert.match(service, /signOut: signout\.signOut,/);
  assert.match(service, /isSigningOut: \(\) => signout\.signingOut,/);
});

test('sign-out registers its promise before doing any work', () => {
  assert.match(signout, /export function createSignOut\(env\)/);
  const body = signout.slice(signout.indexOf('async function signOut()'));
  const registered = body.indexOf('signOutPromise = Promise.resolve()');
  const returned = body.lastIndexOf('return signOutPromise');
  assert.ok(registered > 0 && returned > registered, 'the flight must be registered before it is returned');
  // Unknown cleanup must never be reported as a clean exit.
  assert.match(signout, /revocation: 'unknown'/);
});

// U13: service.mjs is an assembly point, not a place where session work happens.
test('the service makes no store, state or transition call of its own', () => {
  for (const call of ['transition(', 'assertExclusive(', '.ensure(', '.require(', '.publish(']) {
    assert.ok(!service.includes(call), `src/service.mjs still calls ${call} directly: move it to the owning module`);
  }
  // …and its axes only reach each other through the ports passed in by the
  // assembly point, never by importing a sibling.
  const axisModules = readdirSync(new URL('../src/', import.meta.url))
    .filter(name => name.startsWith('service-') && name.endsWith('.mjs') && name !== 'service-helpers.mjs');
  assert.ok(axisModules.length >= 9, `expected the axis modules to exist, found ${axisModules.join(', ')}`);
  for (const name of axisModules) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    const siblings = [...source.matchAll(/from '\.\/(service-[a-z-]+)\.mjs'/g)]
      .map(match => match[1])
      .filter(target => target !== 'service-helpers');
    assert.deepEqual(siblings, [], `src/${name} imports a sibling axis: ${siblings.join(', ')}`);
  }
});
