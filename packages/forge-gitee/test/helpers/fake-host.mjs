/**
 * 测试夹具：假宿主 + 补丁层解析器（不跨包导入 devops 源码）。
 *
 * 为什么需要它：AC-7/13/17 要证明的是"**分发出去的补丁层 + 真实策略服务 + 本插件**"三者的
 * 装载后果，而不是某个桩函数的返回值。所以：
 *   - 策略服务用真实的 `@heluo/forge-policy`（`apply` + `compileCatalog` + `executeAction`），
 *     不造假目录、不假 deny——空目录、少登记、`enabled:false` 的后果必须与线上一致。
 *   - 宿主用最小 ctx（`get/provide/effect/on/tools.register/tools.guard`），形状取自
 *     `@heluo/forge-policy` 与 `@heluo/forge-devops` 实际用到的 seam。
 *   - GitHub（devops）侧只用**等价假插件**（9 个哑工具 + 同样的"目录未登记即 fail closed"），
 *     因为本包的测试不允许导入 devops 源码；它的策略目录来自 devops 自己的补丁层（当数据读）。
 *
 * 补丁层解析只覆盖分发用到的 YAML 子集：`- insert:` / 4 空格 `- id:` / `name:` /
 * `isolate:`（`policy: gitee` 这类行内映射） / `config:`（含 `config: {}`）/ `catalog:` 流式
 * 映射条目 / `audit:` 键值。写别的语法会让解析结果失真，因此入口测试同时断言解析出的行数、
 * id 顺序与 isolate 声明。
 *
 * 两条"夹具不许偷懒"的纪律（D-1/D-2 的直接成因，本文件是它们唯一的常驻门禁）：
 *   - `tools.register()` **镜像宿主判据**：缺 `output.render` 或 `output.schema` 用了宿主
 *     不支持的 JSON Schema 关键字就抛（`@deepseek-ai/dsh-tools` 的 `register()` +
 *     `assertSupportedJsonSchema()`），否则离线用例全绿、真机整条 entry 不激活。
 *   - `isolate` **真隔离**：同 label 的 entry 共用一份服务域，不同 label 互不可见
 *     （cordis `Context.isolate` + loader `isolate` entry 选项）。两行策略不会因为同名 id
 *     互相覆盖，也不会因为 `policy` 单实例约束互相打掉。
 */
import { apply as applyPolicy } from '@heluo/forge-policy';
import { readFile } from 'node:fs/promises';

/** 试点/联调级审计舱：与分发补丁层同一口径（memory + 显式允许非持久）。 */
export const DEFAULT_AUDIT = Object.freeze({ sink: 'memory', allowNonDurable: true });

/**
 * 宿主支持的 JSON Schema 子集（逐字取自 `@deepseek-ai/dsh-tools` 的
 * `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS`；`assertSupportedJsonSchema()` 用它拒绝
 * `minimum`/`maximum`/`pattern` 这类关键字）。
 */
export const HOST_CONSTRAINT_KEYWORDS = Object.freeze([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
export const HOST_ANNOTATION_KEYWORDS = Object.freeze(['description', 'title', 'default', 'examples']);
const CONSTRAINT_KEYWORDS = new Set(HOST_CONSTRAINT_KEYWORDS);
const ANNOTATION_KEYWORDS = new Set(HOST_ANNOTATION_KEYWORDS);

const ROW = /^ {4}- id: (\S+)\s*$/u;
const NAME = /^ {6}name: '([^']+)'\s*$/u;
const ISOLATE = /^ {6}isolate:\s*\{(.*)\}\s*$/u;
const ISOLATE_HEAD = /^ {6}isolate:\s*$/u;
const ISOLATE_PAIR = /^ {8}([A-Za-z][\w]*): (.+?)\s*$/u;
const CONFIG = /^ {6}config:\s*$/u;
const INLINE_CONFIG = /^ {6}config:\s*\{\s*\}\s*$/u;
const CATALOG = /^ {8}catalog:\s*$/u;
const AUDIT = /^ {8}audit:\s*$/u;
const CATALOG_ENTRY = /^ {10}- (\{.*\})\s*$/u;
const AUDIT_PAIR = /^ {10}([A-Za-z][\w]*): (.+?)\s*$/u;

function scalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^'.*'$/u.test(value)) return value.slice(1, -1);
  return value;
}

/** `{ action: 'x', kind: 'read', target: 'y', enabled: true }` → 对象。 */
function flowMap(text) {
  const parsed = {};
  for (const chunk of text.replace(/^\{/u, '').replace(/\}$/u, '').split(',')) {
    const match = /^\s*([A-Za-z][\w]*):\s*(.+?)\s*$/u.exec(chunk);
    if (match !== null) parsed[match[1]] = scalar(match[2]);
  }
  return parsed;
}

/**
 * 镜像宿主 `tools.register()` 的判据（`@deepseek-ai/dsh-tools`：`register()` 强制
 * `output.render` 是函数 + `assertSupportedJsonSchema(output.schema)`）。
 *
 * 夹具的作用是"离线就能复现宿主会拒绝的东西"，所以这里宁可严一点：只校验 output 与
 * output.schema（与宿主一致），参数面由 `hostSchemaViolations()` 单独检查——宿主虽然不在
 * `register()` 里校验参数关键字，但参数一旦越界 PTC 渲染会降级，属于必须挡在交付前的问题。
 *
 * @param {object} definition 工具定义
 * @throws {TypeError} 与宿主同形的错误文案
 */
export function assertHostToolDefinition(definition) {
  const name = definition?.name;
  const output = definition?.output;
  if (output === undefined || output === null || typeof output !== 'object' || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  const violations = hostSchemaViolations(output.schema, 'output.schema');
  if (violations.length > 0) {
    throw new TypeError(`tool "${name}" output.schema is not supported: ${violations.join('; ')}`);
  }
  return definition;
}

/**
 * 一个 schema 里宿主不支持的关键字（递归，含 `items`/`oneOf`/`properties` 的子节点）。
 *
 * @param {unknown} node schema 节点
 * @param {string} path 诊断路径
 * @returns {string[]} 违规描述
 */
export function hostSchemaViolations(node, path = 'schema') {
  if (node === undefined) return [`${path} is missing`];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [`${path} must be a schema object`];
  const violations = [];
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(`${path}.${key} is not a supported keyword (subset: ${HOST_CONSTRAINT_KEYWORDS.join('/')} + annotations)`);
  }
  if (typeof node.properties === 'object' && node.properties !== null) {
    for (const [key, child] of Object.entries(node.properties)) violations.push(...hostSchemaViolations(child, `${path}.properties.${key}`));
  }
  if (node.items !== undefined) violations.push(...hostSchemaViolations(node.items, `${path}.items`));
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => violations.push(...hostSchemaViolations(child, `${path}.oneOf[${index}]`)));
  }
  return violations;
}

/**
 * 逐行解析补丁层，返回 `[{ id, name, isolate, config, catalog, audit }]`。
 *
 * `config` 保留"写没写"的区别：`config: {}` → `{}`，只写 `config:` → `undefined`（宿主
 * 正是把这种缺席原样交给 `ConfigStandard.validate`）。`isolate` 同理：`{}` → `{}`、
 * 缺行 → `undefined`——loader 只对写出来的服务名建立独立服务域。
 */
export function parsePatch(text) {
  const rows = [];
  let current = null;
  let section = null;
  for (const line of text.split('\n')) {
    const row = ROW.exec(line);
    if (row !== null) {
      current = { id: row[1], name: null, isolate: undefined, config: undefined, catalog: [], audit: {} };
      rows.push(current);
      section = null;
      continue;
    }
    if (current === null) continue;
    const name = NAME.exec(line);
    if (name !== null) {
      current.name = name[1];
      continue;
    }
    const isolateInline = ISOLATE.exec(line);
    if (isolateInline !== null) {
      current.isolate = flowMap(`{${isolateInline[1]}}`);
      section = 'isolate';
      continue;
    }
    if (ISOLATE_HEAD.test(line)) {
      current.isolate ??= {};
      section = 'isolate';
      continue;
    }
    if (INLINE_CONFIG.test(line)) {
      current.config = {};
      section = 'config';
      continue;
    }
    if (CONFIG.test(line)) {
      section = 'config';
      continue;
    }
    if (CATALOG.test(line)) {
      section = 'catalog';
      continue;
    }
    if (AUDIT.test(line)) {
      section = 'audit';
      continue;
    }
    const isolatePair = ISOLATE_PAIR.exec(line);
    if (isolatePair !== null && section === 'isolate') {
      current.isolate[isolatePair[1]] = scalar(isolatePair[2]);
      continue;
    }
    const entry = CATALOG_ENTRY.exec(line);
    if (entry !== null && section === 'catalog') {
      current.catalog.push(flowMap(entry[1]));
      continue;
    }
    const pair = AUDIT_PAIR.exec(line);
    if (pair !== null && section === 'audit') {
      current.audit[pair[1]] = scalar(pair[2]);
    }
  }
  return rows;
}

/** 读并解析一个补丁层文件。 */
export async function readPatch(path) {
  return parsePatch(await readFile(path, 'utf8'));
}

/**
 * 假宿主：最小 cordis ctx（含 `isolate` 服务域）。
 *
 * `isolate` 按 loader 的 entry 选项实现：label → 一份独立服务域，同 label 的 entry 共用
 * （provider 与 consumer 因此能互相看见），不同 label 与未写 isolate 的 root 域互不可见。
 * 这正是本包补丁层与 devops 补丁层能共存的前提（D-2）：两行策略各在自己的域里 provide
 * `policy`，既不互相覆盖 config，也不触发 `POLICY_SERVICE_CONFLICT`。
 *
 * `tools.register()` 走 `assertHostToolDefinition()`——离线用例必须能挡住宿主会拒绝的定义
 * （D-1：5 个写工具缺 `output` 时真机整条 entry 不激活，而夹具当时照单全收）。
 *
 * @param {{catalog?: object[], audit?: object}} [options] 传入 `catalog`（哪怕是空数组）即
 *   在创建时挂载真实策略服务；不传则交由测试自行 `mountPolicy`。
 */
export function createFakeHost(options = {}) {
  const services = new Map();
  const realms = new Map();
  const tools = new Map();
  const effects = [];
  const plugins = [];

  /** `isolate` 里写了的服务名走 label 域，其余落 root 域（与 cordis 同序）。 */
  function storeFor(isolate, key) {
    const label = isolate?.[key];
    if (label === undefined) return { map: services, key };
    let realm = realms.get(label);
    if (realm === undefined) {
      realm = new Map();
      realms.set(label, realm);
    }
    return { map: realm, key };
  }

  function createCtx(isolate) {
    return {
      get: (key) => storeFor(isolate, key).map.get(key),
      provide(key, value) {
        const store = storeFor(isolate, key);
        store.map.set(store.key, value);
        return () => {
          if (store.map.get(store.key) === value) store.map.delete(store.key);
        };
      },
      effect(factory) {
        effects.push(factory);
        return () => {
          const index = effects.indexOf(factory);
          if (index >= 0) effects.splice(index, 1);
        };
      },
      // `@heluo/forge-policy` 用它注册 tools/pre-execute 等监听器；本夹具不用宿主派发，
      // 只保证 seam 存在且卸载时可摘。
      on: () => () => {},
      // 策略服务要求 ctx.tools.guard 存在（硬门禁 seam）；这里收下即可。
      tools: {
        guard: () => () => {},
        register(definition) {
          assertHostToolDefinition(definition);
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
        /** 宿主侧摘工具：等价插件用它证明"卸载后工具归零"（真实插件各自持有 disposer）。 */
        unregister(name) {
          return tools.delete(name);
        },
      },
    };
  }

  const ctx = createCtx(undefined);

  const host = {
    ctx,
    services,
    realms,
    tools,
    effects,
    plugins,
    toolNames: () => [...tools.keys()],
    /** 某个 isolate label 的服务域（没用过就是空 Map）；不传 = root 域。 */
    realm(label) {
      return label === undefined ? services : (realms.get(label) ?? new Map());
    },
    /** 从某域取策略服务（不传 label = root 域）。 */
    policyIn(label) {
      return host.realm(label).get('policy');
    },
    /**
     * 用真实策略服务挂载（目录无效/服务已占用时捕获错误而不抛）。
     *
     * `isolate` 与被挂载的 entry 同形（`{ policy: 'gitee' }`）：写了的服务进独立域。
     */
    mountPolicy({ catalog, audit = DEFAULT_AUDIT, isolate } = {}) {
      const scoped = createCtx(isolate);
      try {
        applyPolicy(scoped, { catalog, audit });
        return { ok: true, policy: storeFor(isolate, 'policy').map.get('policy'), isolate };
      } catch (error) {
        return { ok: false, error, code: error?.code ?? error?.reason };
      }
    },
    /** 挂一个插件：记录它注册了哪些工具、失败原因码（不抛，供"失败可见"断言）。 */
    mount(plugin, config, label, { isolate } = {}) {
      const scoped = createCtx(isolate);
      const before = new Set(tools.keys());
      const record = { label: label ?? plugin?.name ?? 'plugin', ok: false, error: undefined, code: undefined, tools: [] };
      try {
        // 传进来的可能本身就是入口的 `apply` 函数：`plugin.apply(ctx, config)` 会变成
        // `Function.prototype.apply`（this=ctx、参数当数组），等于空参调用。函数必须直接调。
        const invokeMount = typeof plugin === 'function'
          ? () => plugin(scoped, config)
          : () => plugin.apply(scoped, config);
        record.teardown = invokeMount();
        record.ok = true;
      } catch (error) {
        record.error = error;
        record.code = error?.code ?? error?.reason;
        record.detail = error?.detail;
      }
      record.tools = [...tools.keys()].filter((name) => !before.has(name));
      plugins.push(record);
      return record;
    },
    /**
     * 跑所有 effect 清理器（等价宿主的 unload-all）。
     *
     * cordis 的 `ctx.effect(fn)` 里 `fn` 是**注册时执行、返回值是清理器**的那一套；
     * 本仓库的插件（含 forge-devops）写成 `ctx.effect(() => teardown)`，即"调用 fn 得到
     * 真正的 teardown"。两种写法都覆盖：先调 fn，返回值是函数就再调一次。
     */
    disposeAll() {
      for (const factory of effects.splice(0)) {
        try {
          const result = factory();
          if (typeof result === 'function') result();
        } catch {
          // 卸载失败不该让用例的断言失去意义。
        }
      }
    },
  };

  if (options.catalog !== undefined) {
    const mounted = host.mountPolicy({ catalog: options.catalog, audit: options.audit });
    if (!mounted.ok) throw mounted.error;
    host.policy = mounted.policy;
  }

  return host;
}

/** 便捷：只要一个真实策略服务（挂载失败直接抛，供纯门禁用例）。 */
export function createFakePolicy({ catalog = [], audit = DEFAULT_AUDIT } = {}) {
  const host = createFakeHost();
  const mounted = host.mountPolicy({ catalog, audit });
  if (!mounted.ok) throw mounted.error;
  return mounted.policy;
}

/** 读工具输出里的结构化信封：兼容 `{content:[{type:'text',text}]}` 与直接返回对象。 */
export function bodyOf(output) {
  if (typeof output === 'string') {
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }
  if (output !== null && typeof output === 'object' && Array.isArray(output.content)) {
    const text = output.content
      .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return output;
}

/** 调一个已注册工具（`execute` 或 `handler`），返回 `{definition, output, body}`。 */
export async function invokeTool(host, toolName, args, extra = {}) {
  const definition = host.tools.get(toolName);
  if (definition === undefined) {
    throw new Error(`工具 ${toolName} 没有注册（现有：${host.toolNames().join(', ') || '(空)'}）`);
  }
  const run = typeof definition.execute === 'function' ? definition.execute : definition.handler;
  if (typeof run !== 'function') throw new Error(`工具 ${toolName} 没有执行体`);
  const output = await run.call(definition, args, extra);
  return { definition, output, body: bodyOf(output) };
}

/**
 * 等价的 GitHub（`@heluo/forge-devops`）假插件：9 个哑工具 + 同样的 fail-closed 前置
 * （少了它的只读动作就不挂载）。
 *
 * 只用它来跑共存三形态——真实的 devops 装配不在本包测试的导入范围（包间零源码依赖），
 * 而"两条补丁层叠加"这个后果与 devops 内部实现无关，只与它同样要求策略目录有关。
 */
export function createEquivalentPlatformPlugin({ label = 'forge-devops-equivalent', readActions = [], toolNames = [] } = {}) {
  return {
    name: label,
    apply(ctx) {
      const policy = typeof ctx.get === 'function' ? ctx.get('policy') : undefined;
      if (policy === undefined) {
        throw Object.assign(new Error(`${label}：策略服务未挂载，拒绝挂载`), { code: 'POLICY_UNAVAILABLE' });
      }
      const missing = readActions.filter((action) => policy.catalog?.get?.(action)?.enabled !== true);
      if (missing.length > 0) {
        throw Object.assign(
          new Error(`${label}：策略目录缺只读动作 ${missing.join(', ')}`),
          { code: 'POLICY_ACTION_UNREGISTERED', detail: { missing } },
        );
      }
      for (const toolName of toolNames) {
        ctx.tools.register({
          name: toolName,
          description: `${label} 哑工具（共存形态用例）`,
          parameters: { type: 'object', properties: {} },
          // 等价插件的工具也要过宿主契约（缺 output 的定义装不进去），所以这里同形声明。
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute() {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: toolName }) }] };
          },
        });
      }
      // 与真实插件一致地登记卸载：卸载要能把自己的工具摘干净，否则"卸载后工具归零"的
      // 断言会把夹具的偷懒当成被测行为。
      const teardown = () => {
        for (const toolName of toolNames) ctx.tools.unregister?.(toolName);
      };
      if (typeof ctx.effect === 'function') ctx.effect(() => teardown);
      else return teardown;
      return undefined;
    },
  };
}
