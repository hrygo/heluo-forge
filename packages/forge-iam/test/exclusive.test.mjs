import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExclusive } from '../src/exclusive.mjs';
import { apply, createIamService } from '../src/index.mjs';

const configured = {
  discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
};

test('an absent official account service passes exclusivity', () => {
  assert.deepEqual(checkExclusive({ get: () => undefined }, {}), { ok: true });
});

test('a mounted official account service is a violation', () => {
  assert.deepEqual(checkExclusive({ get: () => ({}) }, {}), { ok: false, reason: 'exclusive-violation' });
});

test('a missing lookup or a throwing lookup fails closed', () => {
  assert.deepEqual(checkExclusive(undefined, {}), { ok: false, reason: 'exclusive-check-unavailable' });
  assert.deepEqual(checkExclusive({}, {}), { ok: false, reason: 'exclusive-check-unavailable' });
  assert.deepEqual(
    checkExclusive({ get: () => { throw new Error('not ready'); } }, {}),
    { ok: false, reason: 'exclusive-check-unavailable' },
  );
});

test('requireExclusive false is an explicit opt-out', () => {
  assert.deepEqual(checkExclusive(undefined, { requireExclusive: false }), { ok: true });
});

test('a service with a conflict starts in error and refuses sign-in', async () => {
  const service = createIamService(configured, { exclusive: { ok: false, reason: 'exclusive-violation' } });
  const view = service.getView();
  assert.equal(view.state, 'error');
  assert.equal(view.exclusive, 'exclusive-violation');
  assert.equal(view.error, 'exclusive-violation');
  assert.equal(view.canSignIn, false);
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error.code === 'IAM_EXCLUSIVE_CONFLICT',
  );
});

test('apply checks ctx.get before registering the service', () => {
  const provided = new Map();
  const ctx = {
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    get(name) {
      return name === 'deepseekAccount' ? { getState: async () => ({}) } : undefined;
    },
  };
  apply(ctx, configured);
  const service = provided.get('iam');
  assert.equal(service.getView().exclusive, 'exclusive-violation');
  assert.equal(service.getView().state, 'error');
});