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
