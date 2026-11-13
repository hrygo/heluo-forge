/**
 * 客户端 inject 契约：apply 只能访问自己在 `inject` 里声明的服务。
 *
 * 为什么单列一条：Cordis 对**未声明**的服务不是返回 undefined，而是直接抛
 * `cannot get property "<name>" without inject`。客户端在 apply 期读到未声明的
 * `ctx.settings`（能力探测的兜底分支）时，抛错发生在 try 之外，整个插件条目被判
 * failed，Web 宿主随即以「Failed to load plugins / 1 entry did not activate」拒绝启动。
 * 这条用例用严格 ctx 复刻该语义，保证以后再写探测分支也只能走已声明入口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_FILE = fileURLToPath(new URL('../client.js', import.meta.url));
const DECLARED = ['locale', 'slots'];

function loadModule() {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  let definition = null;
  const window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  new Function('window', 'require', source)(window, (name) => {
    assert.equal(name, 'react');
    return { createElement: () => null };
  });
  assert.ok(definition, 'client.js 必须通过 window.__ModuleLoader__.load 注册');
  return definition.factory(() => ({ createElement: () => null }));
}

/** 复刻 Cordis 的 inject 守卫：未声明的服务名一读就抛。 */
function strictContext(unknown) {
  const throwFor = (name) => {
    unknown.push(name);
    throw new Error(`cannot get property "${name}" without inject`);
  };
  const registrations = [];
  const services = {
    locale: { bind: () => (key) => key, register: () => {} },
    slots: {
      // 只声明 `settings.section`（无研发容器）：容器子槽位缺席时 inject 不回调，
      // 与真实宿主"槽位尚未声明"一致。
      inject: (name, register) => (name === 'settings.section' ? register() : () => {}),
      register: (definition) => {
        registrations.push(definition);
        return () => {};
      },
    },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // `ctx.get(name)` 同样受 inject 约束；调用方把它放在 try 里就是合法的能力探测。
    get: (name) => {
      unknown.push(`get:${name}`);
      throw new Error(`cannot get property "${name}" without inject`);
    },
  };
  const ctx = new Proxy(services, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property);
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      return throwFor(`ctx.${String(property)}`);
    },
    has: (target, property) => typeof property === 'string' && Object.hasOwn(target, property),
  });
  return { ctx, registrations };
}

test('apply 不读取未声明的服务（否则宿主判定 entry did not activate）', () => {
  const module = loadModule();
  assert.deepEqual([...module.inject].sort(), [...DECLARED].sort(), 'inject 声明与用例假定必须一致');
  const unknown = [];
  const { ctx } = strictContext(unknown);
  assert.doesNotThrow(() => module.apply(ctx));
  assert.deepEqual(
    unknown.filter((name) => !name.startsWith('get:')),
    [],
    `apply 直接读了未声明的服务属性：${unknown.join(', ')}；探测必须走 try 内的 ctx.get`,
  );
});

test('能力探测不到 settings 服务时降级为文字指引，两个分区仍注册', () => {
  const module = loadModule();
  const { ctx, registrations } = strictContext([]);
  assert.doesNotThrow(() => module.apply(ctx));
  assert.deepEqual(
    registrations.map((definition) => definition.id).sort(),
    ['devops', 'devops-readiness'],
    '两个设置分区必须各自注册（任一失败不得牵连另一个）',
  );
  for (const definition of registrations) {
    const props = typeof definition.inject === 'function' ? definition.inject() : {};
    assert.equal(props.navigate, null, `${definition.id} 探测不到宿主导航能力时必须传 null，由面板退回文字指引`);
    assert.equal(typeof props.t, 'function', `${definition.id} 必须拿到文案函数`);
  }
});
