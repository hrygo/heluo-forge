import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createIamService, IamError } from '../src/index.mjs';

const configured = {
  discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
};

function fakeContext() {
  const provided = new Map();
  return {
    provided,
    get() {
      return undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
  };
}

test('apply registers ctx.iam without requiring a configured IAM', () => {
  const ctx = fakeContext();
  const dispose = apply(ctx, {});
  const service = ctx.provided.get('iam');
  assert.ok(service);
  assert.equal(service.getView().state, 'unconfigured');
  assert.equal(service.getView().canSignIn, false);
  dispose();
  assert.equal(ctx.provided.has('iam'), false);
});

test('unconfigured sign-in fails closed with the missing fields', async () => {
  const service = createIamService({});
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error instanceof IamError && error.code === 'IAM_UNCONFIGURED' && error.details.missing.includes('clientId'),
  );
});

test('configured sign-in does not fabricate a URL before the contract is frozen', async () => {
  const service = createIamService(configured);
  assert.equal(service.getView().state, 'signed-out');
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error instanceof IamError && error.code === 'IAM_NOT_IMPLEMENTED',
  );
});

test('token resolution fails closed before the refresh loop exists', async () => {
  const service = createIamService(configured);
  await assert.rejects(
    () => service.resolveToken('https://gateway.corp.example'),
    (error) => error.code === 'IAM_NOT_IMPLEMENTED',
  );
});

test('sign-out from signed-out is a no-op; cancel outside an attempt is a no-op', async () => {
  const service = createIamService(configured);
  const first = await service.signOut();
  assert.equal(first.state, 'signed-out');
  const second = await service.cancelSignIn();
  assert.equal(second.state, 'signed-out');
});

test('watch yields the current snapshot and terminates on abort', async () => {
  const service = createIamService(configured);
  const controller = new AbortController();
  const iterator = service.watch(controller.signal)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.state, 'signed-out');

  controller.abort();
  const second = await iterator.next();
  assert.equal(second.done, true);
});

test('invalid config is rejected synchronously', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { logoutMode: 'browser' }),
    (error) => error instanceof IamError && error.code === 'IAM_CONFIG_INVALID',
  );
  assert.equal(ctx.provided.size, 0);
});

test('a context without provide is rejected instead of silently doing nothing', () => {
  assert.throws(
    () => apply({}, configured),
    (error) => error instanceof IamError && error.code === 'IAM_HOST_UNAVAILABLE',
  );
});

test('IAM_NOT_IMPLEMENTED is distinguishable from network failure', async () => {
  const service = createIamService(configured);
  try {
    await service.startSignIn();
    assert.fail('expected rejection');
  } catch (error) {
    assert.equal(error.code, 'IAM_NOT_IMPLEMENTED');
    assert.notEqual(error.code, 'IAM_UNREACHABLE');
    assert.notEqual(error.code, 'IAM_INVALID_GRANT');
  }
});