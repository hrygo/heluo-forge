import test from 'node:test';
import assert from 'node:assert/strict';
import { canSignIn, createView, initialState, isSignedIn, transition } from '../src/state.mjs';

test('an incomplete config starts unconfigured and cannot sign in', () => {
  const view = initialState(false, ['clientId']);
  assert.equal(view.state, 'unconfigured');
  assert.equal(view.configured, false);
  assert.equal(view.canSignIn, false);
  assert.deepEqual(view.missing, ['clientId']);
});

test('a complete config starts signed out and can sign in', () => {
  const view = initialState(true);
  assert.equal(view.state, 'signed-out');
  assert.equal(view.configured, true);
  assert.equal(view.canSignIn, true);
  assert.equal(view.signedIn, false);
});

test('sign-in transitions through authenticating to ready', () => {
  const started = transition('signed-out', 'SIGN_IN');
  assert.deepEqual(started, { ok: true, state: 'authenticating' });
  const ready = transition(started.state, 'SIGN_IN_SUCCESS');
  assert.deepEqual(ready, { ok: true, state: 'ready' });
  assert.equal(isSignedIn(ready.state), true);
});

test('cancel returns to signed-out and failure lands in error', () => {
  assert.deepEqual(transition('authenticating', 'CANCEL'), { ok: true, state: 'signed-out' });
  assert.deepEqual(transition('authenticating', 'SIGN_IN_FAILURE'), { ok: true, state: 'error' });
  assert.deepEqual(transition('error', 'RESET'), { ok: true, state: 'signed-out' });
});

test('ready can expire or become unreachable and recover', () => {
  assert.deepEqual(transition('ready', 'EXPIRE'), { ok: true, state: 'expired' });
  assert.deepEqual(transition('expired', 'REFRESH_SUCCESS'), { ok: true, state: 'ready' });
  assert.deepEqual(transition('unreachable', 'RECOVER'), { ok: true, state: 'ready' });
  assert.deepEqual(transition('ready', 'EXCLUSIVE_CONFLICT'), { ok: true, state: 'error' });
});

test('invalid events and states are rejected without throwing', () => {
  assert.equal(transition('signed-out', 'REFRESH_SUCCESS').ok, false);
  assert.equal(transition('bogus', 'SIGN_IN').reason, 'unknown-state');
  assert.equal(transition('signed-out', 'BOGUS').reason, 'unknown-event');
  assert.equal(transition('ready', 'SIGN_IN').reason, 'invalid-transition');
});

test('canSignIn is false for unconfigured, authenticating and ready', () => {
  assert.equal(canSignIn('unconfigured'), false);
  assert.equal(canSignIn('authenticating'), false);
  assert.equal(canSignIn('ready'), false);
  assert.equal(canSignIn('signed-out'), true);
  assert.equal(canSignIn('expired'), true);
  assert.equal(canSignIn('error'), true);
});

test('an expired session can still be signed out', () => {
  assert.equal(createView('expired').canSignOut, true);
  assert.equal(createView('signed-out').canSignOut, false);
  assert.equal(createView('ready').canSignOut, true);
});

test('view never carries tokens or verifiers', () => {
  const view = createView('ready', { principal: 'E1001', accessExpiresAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(view.principal, 'E1001');
  assert.equal(view.accessExpiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal('accessToken' in view, false);
  assert.equal('refreshToken' in view, false);
  assert.equal('idToken' in view, false);
});