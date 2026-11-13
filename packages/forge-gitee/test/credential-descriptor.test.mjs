import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITEE_CREDENTIAL_DESCRIPTOR,
  createGiteeResolveChildEnv,
  registerGiteeCredential,
} from '../src/credential-descriptor.mjs';
import { GiteeCliError, createGiteeRunner } from '../src/gitee-cli.mjs';

test('GITEE_CREDENTIAL_DESCRIPTOR 声明与 detectRiskAndExternal 边界完整', () => {
  assert.equal(GITEE_CREDENTIAL_DESCRIPTOR.extensionId, 'gitee');
  assert.equal(GITEE_CREDENTIAL_DESCRIPTOR.storageRef, 'HEL_EXT_GITEE_TOKEN');
  assert.equal(GITEE_CREDENTIAL_DESCRIPTOR.envKey, 'GITEE_TOKEN');
  assert.deepEqual(GITEE_CREDENTIAL_DESCRIPTOR.allowlistedEnvNames, ['GITEE_TOKEN']);

  const risk = GITEE_CREDENTIAL_DESCRIPTOR.detectRiskAndExternal({
    processEnv: { HOME: '/virtual/home', GITEE_TOKEN: 'env-token-value' },
    readFile: (file) => (file.endsWith('.gitee-cli/config.json') ? '{"token":"plaintext-abc12345"}' : null),
  });
  assert.deepEqual(risk.envHitNames, ['GITEE_TOKEN']);
  assert.equal(risk.plaintextRisk, true);
  assert.equal(risk.riskDetails.reason, 'GITEE_PERSISTENT_TOKEN');
  assert.ok(risk.riskDetails.fileCount >= 1);
});

test('托管凭证优先覆盖 GITEE_TOKEN 且对 stdout/stderr 统一脱敏', async () => {
  const calls = [];
  const execFile = (_bin, _args, options, callback) => {
    calls.push(options.env);
    callback(null, 'ok token=hosted-gitee-secret', 'warn hosted-gitee-secret');
  };
  const broker = {
    async resolveChildEnv({ extensionId }) {
      assert.equal(extensionId, 'gitee');
      return { state: 'HOSTED_ACTIVE', env: { GITEE_TOKEN: 'hosted-gitee-secret' } };
    },
  };

  const runner = createGiteeRunner({
    execFile,
    env: { PATH: '/usr/bin', GITEE_TOKEN: 'legacy-env-token', DEEPSEEK_API_KEY: 'must-strip' },
    readFile: () => null,
    resolveChildEnv: createGiteeResolveChildEnv({ broker, processEnv: { GITEE_TOKEN: 'legacy-env-token' } }),
  });

  const result = await runner.run({ bin: 'gitee', args: ['repo', 'view', 'acme/demo'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].GITEE_TOKEN, 'hosted-gitee-secret');
  assert.equal(calls[0].DEEPSEEK_API_KEY, undefined);
  assert.ok(!result.stdout.includes('hosted-gitee-secret'));
  assert.ok(!result.stderr.includes('hosted-gitee-secret'));
});

test('resolveChildEnv 返回 OWNER_MISMATCH 或抛错时 fail closed 且零子进程 spawn', async () => {
  let spawned = 0;
  const execFile = (_bin, _args, _options, callback) => {
    spawned += 1;
    callback(null, 'never', '');
  };
  const broker = {
    async resolveChildEnv() {
      const err = new Error('hosted extension token belongs to a different enterprise account');
      err.code = 'OWNER_MISMATCH';
      throw err;
    },
  };

  const runner = createGiteeRunner({
    execFile,
    env: { PATH: '/usr/bin', GITEE_TOKEN: 'legacy-env-token' },
    readFile: () => null,
    resolveChildEnv: createGiteeResolveChildEnv({ broker }),
  });

  await assert.rejects(
    () => runner.run({ bin: 'gitee', args: ['repo', 'view', 'acme/demo'] }),
    (err) => err instanceof GiteeCliError && err.code === 'OWNER_MISMATCH' && err.status === 'denied',
  );
  assert.equal(spawned, 0, 'OWNER_MISMATCH 时绝不触发 execFile');
});

test('无 IAM broker 时（standalone）与有 broker 时 registerGiteeCredential 均符合契约', () => {
  const noop = registerGiteeCredential({ get: () => null });
  noop();

  const registered = [];
  let disposed = false;
  const ctx = {
    get(key) {
      if (key === 'forgeIamCredentialBroker') {
        return {
          registerDescriptor(desc) {
            registered.push(desc);
            return () => {
              disposed = true;
            };
          },
        };
      }
      return null;
    },
  };
  const dispose = registerGiteeCredential(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].extensionId, 'gitee');
  dispose();
  assert.equal(disposed, true);
});
