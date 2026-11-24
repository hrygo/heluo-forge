import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installPolicy } from '../src/index.mjs';

const ENV_KEY = 'HELUO_FORGE_STORE_DIRECTORY';

function host({ location } = {}) {
  const provided = new Map();
  if (location !== undefined) provided.set('credentials-store-location', location);
  const hooks = {};
  const ctx = {
    tools: { guard: () => () => {} },
    on: () => () => {},
    get: (name) => provided.get(name),
    provide: (name, value) => {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect: (callback) => callback(),
    // Cordis 只在声明 inject 的作用域暴露服务：测试夹具按同一语义，仅在服务已提供时回调。
    inject: (names, callback) => {
      if (!names.every((name) => provided.get(name) !== undefined)) return () => {};
      return callback({ get: (name) => provided.get(name) }) ?? (() => {});
    },
    logger: { warn: () => {} },
  };
  const native = {
    guard: (fn) => { hooks.guard = fn; return () => { delete hooks.guard; }; },
    pre: (fn) => { hooks.pre = fn; return () => { delete hooks.pre; }; },
  };
  return { ctx, hooks, native };
}

function withEnv(value, run) {
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'forge-install-store-'));
  const directory = join(base, 'store');
  const keyDirectory = `${directory}.keys`;
  mkdirSync(directory, { recursive: true });
  mkdirSync(keyDirectory, { recursive: true });
  return { base, directory, keyDirectory };
}

const execOf = (name, args) => ({ name, arguments: args, callId: `call-${Math.random().toString(16).slice(2)}`, agent: { kind: 'agent' } });

test('位置服务缺席（如 engineering 单装）：装载成功，存档判定不生效', async () => {
  await withEnv(undefined, async () => {
    const { ctx, hooks, native } = host();
    installPolicy(ctx, {}, native);
    assert.deepEqual(ctx.get('policy').storeDirectories(), []);
    let executed = false;
    const decision = await hooks.pre(execOf('read', { file_path: join(tmpdir(), 'credentials.sqlite') }), async () => {
      executed = true;
      return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'allow');
    assert.equal(executed, true);
  });
});

test('位置服务出现且目录一致：暴露两根并拒绝读库', async () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    withEnv(undefined, () => {
      const { ctx, native } = host({ location: { directory, keyDirectory, isDefault: true } });
      installPolicy(ctx, {}, native);
      const service = ctx.get('policy');
      assert.deepEqual(service.storeDirectories(), [directory, keyDirectory]);
      assert.equal(service.checkStore(join(directory, 'credentials.sqlite')), true);
      assert.equal(service.checkStore(join(base, 'notes.txt')), false);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('环境变量与位置服务不一致：不 arm 根，降级为指纹兜底', async () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    await withEnv(join(base, 'elsewhere'), async () => {
      const { ctx, hooks, native } = host({ location: { directory, keyDirectory, isDefault: true } });
      installPolicy(ctx, {}, native);
      assert.deepEqual(ctx.get('policy').storeDirectories(), []);
      const decision = await hooks.pre(execOf('read', { file_path: join(keyDirectory, 'keyring.json') }), async () => ({ kind: 'allow' }));
      assert.equal(decision.kind, 'deny');
      assert.equal(decision.code, 'POLICY_STORE_ACCESS_DENIED');
      const unrelated = await hooks.pre(execOf('read', { file_path: join(base, 'HeluoForge-notes.md') }),
        async () => ({ kind: 'allow' }));
      assert.equal(unrelated.kind, 'allow');
      const token = await hooks.pre(execOf('bash', { command: 'heluo-forge auth token' }),
        async () => ({ kind: 'allow' }));
      assert.equal(token.code, 'POLICY_IAM_TOKEN_DENIED');
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('自定义目录但环境变量缺席：不 arm 根，降级为指纹兜底', async () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    await withEnv(undefined, async () => {
      const { ctx, hooks, native } = host({ location: { directory, keyDirectory, isDefault: false } });
      installPolicy(ctx, {}, native);
      assert.deepEqual(ctx.get('policy').storeDirectories(), []);
      const decision = await hooks.pre(execOf('read', { file_path: join(directory, 'credentials.sqlite') }), async () => ({ kind: 'allow' }));
      assert.equal(decision.kind, 'deny');
      assert.equal(decision.code, 'POLICY_STORE_ACCESS_DENIED');
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('环境变量与位置服务一致：arm 两根', () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    withEnv(directory, () => {
      const { ctx, native } = host({ location: { directory, keyDirectory, isDefault: false } });
      installPolicy(ctx, {}, native);
      assert.deepEqual(ctx.get('policy').storeDirectories(), [directory, keyDirectory]);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('装配后的 pre 钩子拒绝读库与取票，工具体不执行', async () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    await withEnv(undefined, async () => {
      const { ctx, hooks, native } = host({ location: { directory, keyDirectory, isDefault: true } });
      installPolicy(ctx, {}, native);
      let executed = false;
      const storeDenied = await hooks.pre(execOf('read', { file_path: join(directory, 'credentials.sqlite') }), async () => {
        executed = true;
        return { kind: 'allow' };
      });
      assert.equal(storeDenied.kind, 'deny');
      assert.equal(storeDenied.code, 'POLICY_STORE_ACCESS_DENIED');
      const tokenDenied = await hooks.pre(execOf('bash', { command: 'heluo-forge auth token', description: '取票' }), async () => ({ kind: 'allow' }));
      assert.equal(tokenDenied.kind, 'deny');
      assert.equal(tokenDenied.code, 'POLICY_IAM_TOKEN_DENIED');
      assert.equal(executed, false);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('位置服务晚到、移除和替换时，策略跟随当前注入作用域', async () => {
  const { base, directory, keyDirectory } = fixture();
  try {
    await withEnv(undefined, async () => {
      const { ctx, native, hooks } = host();
      let notify;
      ctx.inject = (_names, callback) => { notify = callback; return () => {}; };
      installPolicy(ctx, {}, native);
      const service = ctx.get('policy');
      const readDb = () => hooks.pre(
        execOf('read', { file_path: join(directory, 'credentials.sqlite') }),
        async () => ({ kind: 'allow' }),
      );
      assert.deepEqual(service.storeDirectories(), []);
      // 服务缺席：不判定、放行。
      assert.equal((await readDb()).kind, 'allow');

      const first = notify({ get: () => ({ directory, keyDirectory, isDefault: true }) });
      assert.deepEqual(service.storeDirectories(), [directory, keyDirectory]);
      assert.equal((await readDb()).kind, 'deny');

      // 移除后回到未 arm：不判定。
      first();
      assert.deepEqual(service.storeDirectories(), []);
      assert.equal((await readDb()).kind, 'allow');

      // 以新目录重新提供：旧清理函数不得清空新快照。
      const replacement = join(base, 'replacement');
      const second = notify({ get: () => ({
        directory: replacement, keyDirectory: replacement + '.keys', isDefault: true,
      }) });
      first();
      assert.deepEqual(service.storeDirectories(), [replacement, replacement + '.keys']);
      second();
      assert.deepEqual(service.storeDirectories(), []);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
