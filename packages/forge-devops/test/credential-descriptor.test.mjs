import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVOPS_CREDENTIAL_DESCRIPTOR,
  createDevopsResolveChildEnv,
  registerDevopsCredential,
} from '../src/credential-descriptor.mjs';
import { ENV_ALLOWLIST, createCliRunner, pickAllowlistedEnv } from '../src/cli-runner.mjs';
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

test('无 IAM broker 时（standalone 模式，ADR-0012）把注入环境交给子进程，不静默丢凭据', async () => {
  const dispose = registerDevopsCredential({});
  assert.equal(typeof dispose, 'function');
  dispose();

  // 断言写在假 execFile 外面：`invoke()` 会把回调里抛出的异常吞成失败结果，
  // 写在里面的断言永远不会执行（本用例曾因此恒绿）。
  const childEnvs = [];
  const execFile = (_bin, _args, options, callback) => {
    childEnvs.push(options.env);
    callback(null, JSON.stringify({ id: 'ARD123456', title: 'test', status: 'open', type: 'bug' }), '');
  };
  const flow = createDevopsFlow({
    config: { dopBin: '/secret/bin/dop', dopEndpoint: 'https://dop.corp.example', timeoutMs: 5000 },
    env: {
      PATH: '/usr/bin',
      DEVOPS_API_KEY: 'standalone-env-token',
      DEEPSEEK_API_KEY: 'ds-secret',
      HTTPS_PROXY: 'http://proxy.corp.example:3128',
      SSL_CERT_FILE: '/etc/ssl/corp-root.pem',
    },
    execFile,
  });
  const card = await flow.startFromChange({ changeId: 'ARD123456' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(childEnvs.length, 1, '配置齐全时必须真的执行一次 dop');
  assert.equal(childEnvs[0].DEVOPS_API_KEY, 'standalone-env-token', '注入环境的凭据必须进子进程');
  assert.equal(childEnvs[0].DEEPSEEK_API_KEY, undefined, '无关密钥必须剥离');
  assert.equal(childEnvs[0].HTTPS_PROXY, 'http://proxy.corp.example:3128', '企业代理必须透传');
  assert.equal(childEnvs[0].SSL_CERT_FILE, '/etc/ssl/corp-root.pem', '企业根证书必须透传');
  assert.equal(card.ok, true);
});

test('白名单保留代理与 CA 变量，剥离无关密钥', () => {
  assert.ok(ENV_ALLOWLIST.includes('HTTPS_PROXY'));
  assert.ok(ENV_ALLOWLIST.includes('HTTP_PROXY'));
  assert.ok(ENV_ALLOWLIST.includes('NO_PROXY'));
  const picked = pickAllowlistedEnv({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.corp.example:3128',
    NO_PROXY: 'localhost,127.0.0.1',
    SSL_CERT_DIR: '/etc/ssl/certs',
    DEVOPS_API_KEY: 'token',
    GITEE_TOKEN: 'must-strip',
    DEEPSEEK_API_KEY: 'must-strip',
  });
  assert.equal(picked.HTTPS_PROXY, 'http://proxy.corp.example:3128');
  assert.equal(picked.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(picked.SSL_CERT_DIR, '/etc/ssl/certs');
  assert.equal(picked.DEVOPS_API_KEY, 'token');
  assert.equal('GITEE_TOKEN' in picked, false);
  assert.equal('DEEPSEEK_API_KEY' in picked, false);
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

  const dispose = registerDevopsCredential(ctx);
  assert.equal(registered.length, 0, '服务未就绪时不能假装注册成功');
  assert.deepEqual([...pending.keys()], ['forgeIamCredentialBroker', 'extTokenBroker'], '别名也要等');

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
  assert.equal(registered[0].extensionId, 'devops');
  // 别名后到不得重复注册同一描述符。
  pending.get('extTokenBroker')({ extTokenBroker: broker });
  assert.equal(registered.length, 1);
  dispose();
  assert.equal(disposed, true, '卸载必须撤掉迟到注册的描述符');
  assert.deepEqual(released, ['forgeIamCredentialBroker', 'extTokenBroker'], '卸载必须释放两个注入句柄');
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


test('流程构造后 IAM broker 才就绪：之后的命令用托管令牌，而不是永久停在 standalone', async () => {
  let broker = null;
  const ctx = {
    get: (key) => (key === 'forgeIamCredentialBroker' ? broker : undefined),
  };
  const childEnvs = [];
  const execFile = (_bin, _args, options, callback) => {
    childEnvs.push(options.env);
    callback(null, JSON.stringify({ id: 'ARD123456', title: 'test', status: 'open', type: 'bug' }), '');
  };
  const flow = createDevopsFlow({
    ctx,
    config: { dopBin: '/secret/bin/dop', dopEndpoint: 'https://dop.corp.example', timeoutMs: 5000 },
    env: { PATH: '/usr/bin', DEVOPS_API_KEY: 'env-token' },
    execFile,
  });

  await flow.startFromChange({ changeId: 'ARD123456' });
  assert.equal(childEnvs[0].DEVOPS_API_KEY, 'env-token', 'broker 未就绪时退回白名单环境');

  broker = {
    async resolveChildEnv() {
      return { state: 'HOSTED_ACTIVE', env: { DEVOPS_API_KEY: 'late-hosted-token' } };
    },
  };
  await flow.startFromChange({ changeId: 'ARD123456' });
  assert.equal(childEnvs[1].DEVOPS_API_KEY, 'late-hosted-token', 'broker 就绪后按次解析必须立刻生效');
  assert.equal(childEnvs[1].DEEPSEEK_API_KEY, undefined);
});

test('宿主用别名提供 broker 时同样只注册一次描述符', () => {
  const registered = [];
  const pending = [];
  const ctx = {
    inject(deps, callback) {
      pending.push({ name: deps[0], callback });
      return { dispose() {} };
    },
  };
  const dispose = registerDevopsCredential(ctx);
  const broker = {
    registerDescriptor(desc) {
      registered.push(desc);
      return () => {};
    },
  };
  // 别名先就绪、主名后到：必须注册且不重复。
  pending.find((entry) => entry.name === 'extTokenBroker').callback({ extTokenBroker: broker });
  pending.find((entry) => entry.name === 'forgeIamCredentialBroker').callback({ forgeIamCredentialBroker: broker });
  assert.equal(registered.length, 1);
  dispose();
});
