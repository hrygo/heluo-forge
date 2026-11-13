import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVOPS_CREDENTIAL_DESCRIPTOR,
  createDevopsResolveChildEnv,
  registerDevopsCredential,
} from '../src/credential-descriptor.mjs';
import { createCliRunner } from '../src/cli-runner.mjs';
import { createDevopsFlow } from '../src/flow.mjs';

test('DEVOPS_CREDENTIAL_DESCRIPTOR 声明与协议字段完整', () => {
  assert.deepEqual(DEVOPS_CREDENTIAL_DESCRIPTOR, {
    extensionId: 'devops',
    storageRef: 'HEL_EXT_DEVOPS_TOKEN',
    envKey: 'DEVOPS_API_KEY',
    allowlistedEnvNames: ['DEVOPS_API_KEY'],
  });
});

test('托管凭证优先覆盖同名环境变量 DEVOPS_API_KEY', async () => {
  const calls = [];
  const execFile = (_bin, _args, options, callback) => {
    calls.push(options.env);
    callback(null, '{"id":"ARD123"}', '');
  };
  const broker = {
    async resolveChildEnv({ extensionId }) {
      assert.equal(extensionId, 'devops');
      return { state: 'HOSTED_ACTIVE', env: { DEVOPS_API_KEY: 'hosted-vault-token' } };
    },
  };

  const runner = createCliRunner({
    execFile,
    processEnv: { PATH: '/usr/bin', DEVOPS_API_KEY: 'stale-env-token', DEEPSEEK_API_KEY: 'must-strip' },
    resolveChildEnv: createDevopsResolveChildEnv({ broker, processEnv: { DEVOPS_API_KEY: 'stale-env-token' } }),
  });

  await runner.run({ bin: 'dop', args: ['change', 'view', 'ARD123', '--json'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].DEVOPS_API_KEY, 'hosted-vault-token');
  assert.equal(calls[0].DEEPSEEK_API_KEY, undefined);
});

test('无 IAM broker 时（standalone 模式，ADR-0012）仍可正常运行并注册零异常', async () => {
  const dispose = registerDevopsCredential({});
  assert.equal(typeof dispose, 'function');
  dispose();

  let spawned = 0;
  const execFile = (_bin, _args, options, callback) => {
    spawned += 1;
    assert.equal(options.env.DEVOPS_API_KEY, 'standalone-env-token');
    assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
    callback(null, JSON.stringify({ id: 'ARD123456', title: 'test', status: 'open', type: 'bug' }), '');
  };
  const flow = createDevopsFlow({
    config: { dopBin: '/secret/bin/dop', dopEndpoint: 'https://dop.corp.example', timeoutMs: 5000 },
    env: { PATH: '/usr/bin', DEVOPS_API_KEY: 'standalone-env-token', DEEPSEEK_API_KEY: 'ds-secret' },
    execFile,
  });
  const card = await flow.startFromChange({ changeId: 'ARD123456' });
  assert.equal(spawned, 1);
  assert.equal(card.ok, true);
});

test('有 IAM broker 时 registerDevopsCredential 注册描述符并返回卸载函数', () => {
  const registered = [];
  let disposed = false;
  const ctx = {
    forgeIamCredentialBroker: {
      registerDescriptor(desc) {
        registered.push(desc);
        return () => {
          disposed = true;
        };
      },
    },
  };
  const dispose = registerDevopsCredential(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].extensionId, 'devops');
  dispose();
  assert.equal(disposed, true);
});
