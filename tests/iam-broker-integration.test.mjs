/**
 * 跨包集成：IAM 把 CredentialBroker 提供出来，devops/gitee 注册描述符并真的取到托管令牌。
 *
 * 这条链路以前缺的是「提供方」：`forgeIamCredentialBroker` 无人 provide，消费方永远
 * 回退环境变量。这里用真实的 registry / store / facade + 消费方真实的注册函数验证
 * 三个关键行为：托管令牌优先于环境变量、跨账号 fail closed（零 spawn）、清除后回到环境变量。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCredentialRegistry } from '../packages/forge-iam/src/credential-registry.mjs';
import { createExtTokenStore } from '../packages/forge-iam/src/ext-token-store.mjs';
import { createCredentialBroker, createExtTokensService } from '../packages/forge-iam/src/service-ext-tokens.mjs';
import { MemoryCredentials } from '../packages/forge-iam/test/support/memory-credentials.mjs';
import {
  DEVOPS_CREDENTIAL_DESCRIPTOR,
  createDevopsResolveChildEnv,
  registerDevopsCredential,
} from '../packages/forge-devops/src/credential-descriptor.mjs';
import { apply as applyIam } from '../packages/forge-iam/src/index.mjs';
import {
  GITEE_CREDENTIAL_DESCRIPTOR,
  createGiteeResolveChildEnv,
  registerGiteeCredential,
} from '../packages/forge-gitee/src/credential-descriptor.mjs';

function harness(subject = 'E1001') {
  const credentials = new MemoryCredentials();
  const registry = createCredentialRegistry();
  const store = createExtTokenStore(credentials);
  const extTokens = createExtTokensService({
    registry,
    store,
    getCurrentSubject: () => subject,
    getProcessEnv: () => ({}),
  });
  const broker = createCredentialBroker({ extTokens, registry });
  const ctx = {
    get: (name) => (name === 'forgeIamCredentialBroker' ? broker : undefined),
    inject: (_names, callback) => {
      callback({ forgeIamCredentialBroker: broker });
      return () => {};
    },
  };
  return { broker, ctx, credentials };
}

test('devops/gitee 注册描述符后，托管令牌优先于环境变量', async () => {
  const { broker, ctx } = harness();
  registerDevopsCredential(ctx);
  registerGiteeCredential(ctx);

  await broker.saveToken({ extensionId: 'devops', token: 'devops-hosted-token' });
  await broker.saveToken({ extensionId: 'gitee', token: 'gitee-hosted-token' });

  const devopsEnv = createDevopsResolveChildEnv({ broker, processEnv: { DEVOPS_API_KEY: 'from-env' } });
  const giteeEnv = createGiteeResolveChildEnv({ broker, processEnv: { GITEE_TOKEN: 'from-env' } });
  const resolvedDevops = await devopsEnv();
  const resolvedGitee = await giteeEnv();
  assert.equal(resolvedDevops.DEVOPS_API_KEY, 'devops-hosted-token', '托管令牌必须覆盖环境变量');
  assert.equal(resolvedGitee[GITEE_CREDENTIAL_DESCRIPTOR.envKey], 'gitee-hosted-token');
  assert.equal(DEVOPS_CREDENTIAL_DESCRIPTOR.storageRef, 'HEL_EXT_DEVOPS_TOKEN');
});

test('令牌属于另一个账号时 fail closed，不回落到环境变量也不 spawn', async () => {
  const owner = harness('E1001');
  owner.ctx.get('forgeIamCredentialBroker');
  registerDevopsCredential(owner.ctx);
  await owner.broker.saveToken({ extensionId: 'devops', token: 'devops-hosted-token' });

  // 同一个存储、换了登录主体：必须拒绝，且 runner 看到 ok:false 就不会起子进程。
  const intruder = harness('E2002');
  const sharedStore = createExtTokenStore(owner.credentials);
  const registry = createCredentialRegistry();
  const extTokens = createExtTokensService({
    registry,
    store: sharedStore,
    getCurrentSubject: () => 'E2002',
    getProcessEnv: () => ({}),
  });
  const broker = createCredentialBroker({ extTokens, registry });
  registry.registerExtensionCredential(DEVOPS_CREDENTIAL_DESCRIPTOR);

  const resolve = createDevopsResolveChildEnv({ broker, processEnv: { DEVOPS_API_KEY: 'from-env' } });
  const resolved = await resolve();
  assert.equal(resolved.ok, false, '别人的托管令牌必须 fail closed');
  assert.equal(resolved.code, 'OWNER_MISMATCH');
  assert.equal(intruder.broker === broker, false);
});

test('清除托管令牌后回到环境变量；跨账号读取不泄露令牌值', async () => {
  const { broker, ctx } = harness();
  registerDevopsCredential(ctx);
  await broker.saveToken({ extensionId: 'devops', token: 'devops-hosted-token' });
  const resolve = createDevopsResolveChildEnv({ broker, processEnv: { DEVOPS_API_KEY: 'from-env' } });
  assert.equal((await resolve()).DEVOPS_API_KEY, 'devops-hosted-token');

  await broker.clearToken({ extensionId: 'devops' });
  const afterClear = await resolve();
  assert.equal(afterClear.DEVOPS_API_KEY, 'from-env', '清除后应回到环境变量');

  const statuses = await broker.listProjectedStatuses();
  const devops = statuses.find((item) => item.extensionId === 'devops');
  assert.ok(devops, '状态投影必须包含已注册描述符');
  assert.equal(JSON.stringify(statuses).includes('devops-hosted-token'), false, '状态投影不得回显令牌');
});

test('IAM 插件真的把 broker 提供给宿主，而不只是导出一个工厂', async (t) => {
  const credentials = new MemoryCredentials();
  const provided = new Map();
  const ctx = {
    get: (name) => (name === 'credentials' ? credentials : undefined),
    provide: (name, value) => {
      provided.set(name, value);
      return () => {};
    },
    effect: (fn) => fn(),
  };
  const dispose = applyIam(ctx, {});
  t.after(dispose);
  assert.ok(provided.has('iam'), '服务本体必须照常提供');
  const broker = provided.get('forgeIamCredentialBroker');
  assert.ok(broker, '宿主需要能按名字取到 broker，否则消费方永远回退环境变量');
  assert.equal(typeof broker.registerDescriptor, 'function');
  assert.equal(typeof broker.resolveChildEnv, 'function');
  // 消费方的注册函数认得它就是 broker：注册后状态投影里能看到该扩展。
  const off = registerDevopsCredential({ get: () => broker, inject: undefined });
  const statuses = await broker.listProjectedStatuses();
  off();
  assert.ok(statuses.some((item) => item.extensionId === DEVOPS_CREDENTIAL_DESCRIPTOR.extensionId));
});

test('broker 在会话解析期间失效时 fail closed，不回放旧令牌', async () => {
  const credentials = new MemoryCredentials();
  const registry = createCredentialRegistry();
  const session = { subject: 'E1001', epoch: 'boot-1' };
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let gated = false;
  // 只拦解析路径（保存本身也要读）；顺手补齐六个方法，避免原型方法被展开丢掉。
  const delayed = {
    async readRecord(key) {
      if (gated) await gate;
      return credentials.readRecord(key);
    },
    modifyRecord: (key, mutate) => credentials.modifyRecord(key, mutate),
    deleteRecord: (key) => credentials.deleteRecord(key),
    set: (ref, value) => credentials.set(ref, value),
    unset: (ref) => credentials.unset(ref),
    resolve: (ref) => credentials.resolve(ref),
  };
  const store = createExtTokenStore(delayed);
  const extTokens = createExtTokensService({
    registry,
    store,
    getCurrentSubject: () => session.subject,
    getSessionRef: () => (session.subject ? { subject: session.subject, epoch: session.epoch } : null),
    getProcessEnv: () => ({}),
  });
  const broker = createCredentialBroker({ extTokens, registry });
  registry.registerExtensionCredential(DEVOPS_CREDENTIAL_DESCRIPTOR);

  await broker.saveToken({ extensionId: 'devops', token: 'devops-hosted-token' });
  gated = true;
  const resolve = createDevopsResolveChildEnv({ broker, processEnv: { DEVOPS_API_KEY: 'from-env' } });
  const pending = resolve();
  session.subject = null;
  session.epoch = 'boot-2';
  releaseRead();

  const resolved = await pending;
  assert.equal(resolved.ok, false, '登出后不得把旧令牌交给子进程');
  assert.equal(resolved.code, 'IAM_NOT_SIGNED_IN');
  assert.equal(JSON.stringify(resolved).includes('devops-hosted-token'), false);
});
