import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSecurityCliBackend,
  probeSecurityCli,
  SECURITY_ITEM_NOT_FOUND,
} from '../src/security-cli.mjs';
import { KeychainBackendError } from '../src/backend.mjs';
import { apply, validateConfig } from '../src/index.mjs';

const recorder = (script) => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    const step = script.shift() ?? { status: 0, stdout: '', stderr: '' };
    return step;
  };
  return { calls, runner };
};

test('availability probing reports the search list without leaking paths', () => {
  const { runner } = recorder([{ status: 0, stdout: '    "/a/login.keychain-db"\n    "/b/System.keychain"\n', stderr: '' }]);
  const probe = probeSecurityCli({ runner });
  assert.equal(probe.available, true);
  assert.equal(probe.keychainCount, 2);
  assert.equal(probe.reason, undefined);
  assert.equal(JSON.stringify(probe).includes('/a/'), false, '不记录字面路径');

  const missing = probeSecurityCli({ runner: () => ({ status: 1, stdout: '', stderr: 'no such file\n' }) });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /no such file/);
  assert.equal(missing.keychainCount, 0);
});

test('get maps the measured exit codes instead of guessing', async () => {
  const { runner, calls } = recorder([{ status: 0, stdout: 'secret-value\n', stderr: '' }]);
  const backend = createSecurityCliBackend({ service: 'svc', runner });
  assert.equal(await backend.get('iam.refresh'), 'secret-value');
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'svc', '-a', 'iam.refresh', '-w']);

  const absent = createSecurityCliBackend({ service: 'svc', runner: () => ({ status: SECURITY_ITEM_NOT_FOUND, stdout: '', stderr: 'not found' }) });
  assert.equal(await absent.get('k'), undefined);

  const failing = createSecurityCliBackend({ service: 'svc', runner: () => ({ status: 51, stdout: '', stderr: 'interaction not allowed' }) });
  await assert.rejects(() => failing.get('k'), (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_BACKEND_FAILED' && /interaction not allowed/.test(error.message));
});

test('set keeps the credential out of argv by default and redacts it on failure', async () => {
  const secret = 'spike-secret-value';
  const { runner, calls } = recorder([{ status: 0, stdout: '', stderr: '' }]);
  const backend = createSecurityCliBackend({ service: 'svc', runner });
  await backend.set('iam.refresh', secret);
  assert.equal(calls[0].args.includes(secret), false, 'argv 里不得出现口令');
  assert.equal(calls[0].input, `${secret}\n${secret}\n`, 'stdin 双次输入（含复核）');
  assert.deepEqual(calls[0].args, ['add-generic-password', '-s', 'svc', '-a', 'iam.refresh', '-U', '-w']);

  const { runner: failing } = recorder([{ status: 1, stdout: '', stderr: `boom ${secret}` }]);
  const failingBackend = createSecurityCliBackend({ service: 'svc', runner: failing });
  await assert.rejects(
    () => failingBackend.set('iam.refresh', secret),
    (error) => error.code === 'KEYCHAIN_BACKEND_FAILED' && error.message.includes('[redacted]') && !error.message.includes(secret),
  );

  await assert.rejects(() => backend.set('iam.refresh', ''), (error) => error.code === 'KEYCHAIN_EMPTY_VALUE');
});

test('argv transport is refused unless it is explicitly allowed', async () => {
  const { runner, calls } = recorder([{ status: 0, stdout: '', stderr: '' }]);
  const strict = createSecurityCliBackend({ service: 'svc', runner, secretTransport: 'argv' });
  await assert.rejects(() => strict.set('k', 'v'), (error) => error.code === 'KEYCHAIN_ARGV_SECRET_NOT_ALLOWED');
  assert.equal(calls.length, 0, '被拒绝时不得调用 security');

  const allowed = createSecurityCliBackend({ service: 'svc', runner, secretTransport: 'argv', allowArgvSecret: true });
  await allowed.set('k', 'v');
  assert.deepEqual(calls[0].args, ['add-generic-password', '-s', 'svc', '-a', 'k', '-w', 'v', '-U']);
});

test('delete is idempotent and list refuses instead of reporting an empty store', async () => {
  const missing = createSecurityCliBackend({ service: 'svc', runner: () => ({ status: SECURITY_ITEM_NOT_FOUND, stdout: '', stderr: '' }) });
  await missing.delete('k');
  const failing = createSecurityCliBackend({ service: 'svc', runner: () => ({ status: 1, stdout: '', stderr: 'denied' }) });
  await assert.rejects(() => failing.delete('k'), (error) => error.code === 'KEYCHAIN_BACKEND_FAILED');
  await assert.rejects(() => missing.list('iam.'), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');
  const timedOut = createSecurityCliBackend({ service: 'svc', runner: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) });
  await assert.rejects(() => timedOut.get('k'), (error) => error.code === 'KEYCHAIN_BACKEND_TIMEOUT');
});

test('the spike adapter must be opted into at composition time', () => {
  const issues = validateConfig({ platformAdapter: 'dpapi' });
  assert.equal('issues' in issues, true);
  assert.equal(issues.issues[0].path[0], 'platformAdapter');
  assert.equal('issues' in validateConfig({ allowUnvettedPlatformAdapter: 'yes' }), true);

  const ok = validateConfig({ platformAdapter: 'security-cli', allowUnvettedPlatformAdapter: true });
  assert.equal(ok.value.platformAdapter, 'security-cli');

  const ctx = { provide: () => () => {}, get: () => undefined, effect: () => () => {} };
  assert.throws(
    () => apply(ctx, { platformAdapter: 'security-cli' }),
    (error) => error.code === 'KEYCHAIN_UNVETTED_ADAPTER_REFUSED',
  );
});
