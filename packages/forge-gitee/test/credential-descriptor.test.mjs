import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITEE_CREDENTIAL_DESCRIPTOR,
  createGiteeResolveChildEnv,
  registerGiteeCredential,
} from '../src/credential-descriptor.mjs';
import { ENV_ALLOWLIST, GiteeCliError, createGiteeRunner } from '../src/gitee-cli.mjs';

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
  // 设计 §5.3：诊断要能指出命中文件，而不是只给一个计数。
  assert.ok(risk.riskDetails.files.some((file) => file.endsWith('.gitee-cli/config.json')),
    'riskDetails.files 必须包含命中的配置路径');
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


test('白名单保留代理与 CA 变量，剥离无关密钥', async () => {
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    assert.ok(ENV_ALLOWLIST.includes(name), `${name} 必须在白名单里`);
  }
  const calls = [];
  const runner = createGiteeRunner({
    execFile: (_bin, _args, options, callback) => {
      calls.push(options.env);
      callback(null, 'ok', '');
    },
    env: {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.corp.example:3128',
      SSL_CERT_FILE: '/etc/ssl/corp-root.pem',
      GITEE_TOKEN: 'token',
      DEEPSEEK_API_KEY: 'must-strip',
      AWS_SECRET_ACCESS_KEY: 'must-strip',
    },
    readFile: () => null,
  });
  await runner.run({ bin: 'gitee', args: ['repo', 'view', 'acme/demo'] });
  assert.equal(calls[0].HTTPS_PROXY, 'http://proxy.corp.example:3128');
  assert.equal(calls[0].SSL_CERT_FILE, '/etc/ssl/corp-root.pem');
  assert.equal(calls[0].DEEPSEEK_API_KEY, undefined);
  assert.equal(calls[0].AWS_SECRET_ACCESS_KEY, undefined);
});

test('git 命令面同样拿得到托管令牌，并保持非交互', async () => {
  const calls = [];
  const execFile = (_bin, _args, options, callback) => {
    calls.push(options.env);
    callback(null, 'ok', '');
  };
  const broker = {
    async resolveChildEnv() {
      return { state: 'HOSTED_ACTIVE', env: { GITEE_TOKEN: 'hosted-git-token' } };
    },
  };
  const runner = createGiteeRunner({
    execFile,
    env: { PATH: '/usr/bin', GITEE_TOKEN: 'legacy-env-token' },
    readFile: () => null,
    resolveChildEnv: createGiteeResolveChildEnv({ broker, processEnv: { GITEE_TOKEN: 'legacy-env-token' } }),
  });
  await runner.runGit({ args: ['status', '--short'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].GITEE_TOKEN, 'hosted-git-token', '托管令牌必须压过基线环境');
  assert.equal(calls[0].GIT_TERMINAL_PROMPT, '0', 'git 不得在管道里等输入');
});

test('IAM broker 晚于本插件装载时，经 ctx.inject 补注册而不是永久退回 standalone', () => {
  const registered = [];
  const pending = new Map();
  const released = [];
  let disposed = false;
  // 真实 Cordis 的 `inject` 返回 Fiber（只有 dispose()），不是函数。
  const ctx = {
    inject(deps, callback) {
      pending.set(deps[0], callback);
      return {
        dispose() {
          released.push(deps[0]);
        },
      };
    },
  };

  const dispose = registerGiteeCredential(ctx);
  assert.equal(registered.length, 0);
  assert.deepEqual([...pending.keys()], ['forgeIamCredentialBroker', 'extTokenBroker']);

  const broker = {
    registerDescriptor(desc) {
      registered.push(desc);
      return () => {
        disposed = true;
      };
    },
  };
  pending.get('forgeIamCredentialBroker')({ forgeIamCredentialBroker: broker });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].extensionId, 'gitee');
  pending.get('extTokenBroker')({ extTokenBroker: broker });
  assert.equal(registered.length, 1, '别名后到不得重复注册');

  dispose();
  assert.equal(disposed, true);
  assert.deepEqual(released, ['forgeIamCredentialBroker', 'extTokenBroker']);
});

test('代理 URL 内嵌凭据在子进程输出里被脱敏', async () => {
  // 内嵌凭据的地址用拼接构造：扫描器会把 `scheme://user:pass@host` 字面量当凭据/邮箱。
  const proxy = `http://${['svc-user', 'svc-pass'].join(':')}@proxy.corp.example:3128`;
  const execFile = (_bin, _args, _options, callback) => {
    callback(null, `ok ${proxy}`, `warn ${proxy}`);
  };
  const runner = createGiteeRunner({ execFile, env: { PATH: '/usr/bin' }, readFile: () => null });
  const result = await runner.run({ bin: 'gitee', args: ['repo', 'view', 'acme/demo'] });
  assert.equal(result.stdout.includes('svc-user'), false);
  assert.equal(result.stderr.includes('svc-pass'), false);
  assert.match(result.stdout, /\*\*\*@proxy\.corp\.example/);
});
