import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

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
