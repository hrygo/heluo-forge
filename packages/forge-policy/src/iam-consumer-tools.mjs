import { createIamConsumer } from './iam-consumer.mjs';
import { installPolicy } from './installer.mjs';

const messages = Object.freeze({
  IAM_CONSUMPTION_INPUT_INVALID: 'IAM consumption input is invalid',
  IAM_CONSUMPTION_UNVERIFIED: 'IAM consumption sources are not verified',
  IAM_CONSUMPTION_DENIED: 'IAM consumption is denied',
  IAM_CONSUMPTION_CHANGED: 'IAM consumption context changed',
  IAM_CONSUMPTION_UNKNOWN: 'IAM consumption outcome is unknown; no retry was attempted',
});
const error = (code) => Object.assign(new Error(`${code}: ${messages[code]}`), { code });
function safe(errorLike, fallback = 'IAM_CONSUMPTION_CHANGED') {
  let code;
  try { code = Object.getOwnPropertyDescriptor(errorLike, 'code')?.value; } catch { /* no foreign getters */ }
  return error(typeof code === 'string' && Object.hasOwn(messages, code) ? code : fallback);
}
const rejected = (failure) => ({ kind: 'error', text: failure.message });
const text = (value) => typeof value === 'string' && value.trim().length > 0;
function data(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) throw error('IAM_CONSUMPTION_INPUT_INVALID');
  return Object.freeze(Object.fromEntries(keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw error('IAM_CONSUMPTION_INPUT_INVALID');
    return [key, descriptor.value];
  })));
}
function scopeFor(spec) {
  const scope = data(spec.scope, ['kind', 'target', 'purpose']);
  if (scope.kind !== 'tool' || !text(scope.target) || !text(scope.purpose)) throw error('IAM_CONSUMPTION_INPUT_INVALID');
  return scope;
}

/** Test-only owned definitions. No production source discovery or configuration switch. */
export function installIamConsumerTools(ctx, config, options) {
  const entries = [], toolsByName = new Map(), commandsByName = new Map(), actions = new Set();
  const records = new WeakMap(), commandExecutions = new WeakMap(), registrations = [];
  let active = true, commandSequence = 0;

  function validate(entry, exec) {
    const args = data(exec.arguments, ['target', 'payload']);
    if (!active || !exec.agent || !text(exec.agent.id)) throw error('IAM_CONSUMPTION_DENIED');
    if (args.target !== entry.scope.target || typeof args.payload !== 'string') throw error('IAM_CONSUMPTION_INPUT_INVALID');
  }
  function registered(entry, exec) {
    if (entry.kind === 'command') return commandExecutions.get(exec) === entry;
    const actual = ctx.tools.get(entry.definition.name, exec.agent);
    return actual?.execute === entry.definition.execute && actual?.finalizeContent === entry.definition.finalizeContent;
  }
  function current(exec) {
    const record = records.get(exec);
    if (!record) throw error('IAM_CONSUMPTION_UNVERIFIED');
    if (record.failure) throw record.failure;
    if (!active || !registered(record.entry, exec)) throw error('IAM_CONSUMPTION_CHANGED');
    record.entry.core.assertCurrent(record.operation, exec);
    return record;
  }
  function release(exec) {
    const record = records.get(exec);
    if (record?.operation) record.entry.core.release(record.operation);
    records.delete(exec);
  }
  async function prepare(entry, exec) {
    if (records.has(exec)) throw error('IAM_CONSUMPTION_CHANGED');
    const record = { entry }; records.set(exec, record);
    try {
      validate(entry, exec);
      if (!registered(entry, exec)) throw error('IAM_CONSUMPTION_UNVERIFIED');
      record.operation = await entry.core.prepare(exec, entry.scope);
      current(exec);
    } catch (cause) { record.failure = safe(cause); throw record.failure; }
  }
  async function body(entry, exec) {
    let record;
    try {
      record = current(exec);
      if (record.entry !== entry) throw error('IAM_CONSUMPTION_UNVERIFIED');
      if (entry.beforeSend) {
        try { await entry.beforeSend(exec); }
        catch (cause) { current(exec); throw safe(cause, 'IAM_CONSUMPTION_UNKNOWN'); }
      }
      current(exec);
      return await entry.core.dispatch(record.operation, exec, (input) => entry.send(Object.freeze({
        target: entry.scope.target, payload: input.payload,
      })));
    } catch (cause) {
      const failure = safe(cause, 'IAM_CONSUMPTION_UNKNOWN');
      if (record) record.failure = failure;
      throw failure;
    }
  }
  function finalize(exec, result) {
    try {
      const record = current(exec);
      if (result.isError) record.entry.core.fail(record.operation, exec);
      record.entry.core.finish(record.operation, exec, result);
      records.delete(exec);
      return undefined;
    } catch (cause) { const failure = safe(cause); release(exec); throw failure; }
  }
  function entryFor(spec, kind) {
    if (!text(spec.name) || !text(spec.action) || !text(spec.description) || typeof spec.send !== 'function'
      || (spec.beforeSend !== undefined && typeof spec.beforeSend !== 'function')) throw error('IAM_CONSUMPTION_INPUT_INVALID');
    const entry = { kind, action: spec.action, scope: scopeFor(spec), send: spec.send, beforeSend: spec.beforeSend };
    const sourceReader = options.getSources;
    const coreOptions = {
      getSources() { return options.getSources === sourceReader && typeof sourceReader === 'function' ? sourceReader(entry.definition) : undefined; },
      get verifyConsumerSources() { return options.verifyConsumerSources; },
    };
    entry.core = createIamConsumer(coreOptions);
    if (kind === 'tool') {
      entry.definition = Object.freeze({ name: spec.name, description: spec.description,
        parameters: Object.freeze({ type: 'object', properties: { target: { type: 'string', const: entry.scope.target }, payload: { type: 'string' } },
          required: ['target', 'payload'], additionalProperties: false }),
        output: Object.freeze({ schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.message }] }),
        execute: (_args, exec) => body(entry, exec), finalizeContent: finalize,
      });
    } else {
      entry.definition = Object.freeze({ name: spec.name, action: spec.action, description: spec.description,
        resolveArguments: spec.resolveArguments ?? ((invocation) => ({ target: invocation.rawInput, payload: 'synthetic command' })),
        handler: async (_invocation, _args, exec) => {
          const value = await body(entry, exec);
          return { kind: 'success', text: value.message };
        },
      });
    }
    entries.push(entry); actions.add(entry.action);
    const names = kind === 'tool' ? toolsByName : commandsByName;
    const key = kind === 'tool' ? spec.name : `/${spec.name}`;
    if (names.has(key)) throw error('IAM_CONSUMPTION_INPUT_INVALID');
    names.set(key, entry);
    return entry;
  }
  for (const spec of options.tools ?? []) entryFor(spec, 'tool');
  for (const spec of options.commands ?? []) entryFor(spec, 'command');
  // A protected action cannot be aliased onto an unowned tool/category body.
  for (const [name, action] of Object.entries(config.tools ?? {})) {
    if (actions.has(action) && toolsByName.get(name)?.action !== action) throw error('IAM_CONSUMPTION_INPUT_INVALID');
  }
  for (const action of Object.values(config.categories ?? {})) if (actions.has(action)) throw error('IAM_CONSUMPTION_INPUT_INVALID');
  for (const [name, entry] of toolsByName) if (config.tools?.[name] !== entry.action) throw error('IAM_CONSUMPTION_INPUT_INVALID');
  if (typeof ctx.tools?.register !== 'function' || typeof ctx.tools?.get !== 'function' || typeof ctx.on !== 'function') throw error('IAM_CONSUMPTION_UNVERIFIED');

  const owned = {
    async preExecute(gate, context, exec, next) {
      const entry = toolsByName.get(exec.name);
      if (!entry) return gate.preExecute(context, exec, next);
      try {
        await prepare(entry, exec);
        const decision = await gate.preExecute(context, exec, async () => {
          current(exec);
          const downstream = await next();
          current(exec);
          return downstream;
        });
        current(exec);
        if (decision.kind === 'deny') throw error('IAM_CONSUMPTION_DENIED');
        return decision;
      } catch (cause) {
        const failure = safe(cause);
        const record = records.get(exec); if (record) record.failure = failure;
        await gate.postExecute(exec, { kind: 'error' });
        return { kind: 'deny', reason: failure.message };
      }
    },
    guard(gate, exec) {
      if (!toolsByName.has(exec.name)) return gate.guard(exec);
      try {
        current(exec);
        return gate.guard(exec) === undefined ? undefined : error('IAM_CONSUMPTION_DENIED').message;
      } catch (cause) { return safe(cause).message; }
    },
    commandFailure(definition) {
      return commandsByName.get(`/${definition.name}`)?.definition === definition ? rejected(error('IAM_CONSUMPTION_INPUT_INVALID')) : undefined;
    },
    commandOperation(definition, exec, invocation, args) {
      const entry = commandsByName.get(exec.name);
      if (entry?.definition !== definition) return undefined;
      // These two values are internal metadata of this actual normalized command
      // execution, NOT fields supplied by SDK CommandInvocation or permissions.
      Object.defineProperties(exec, { rootCallId: { value: `iam-owned-command-${++commandSequence}`, enumerable: true },
        token: { value: Symbol('owned-command-execution'), enumerable: true } });
      commandExecutions.set(exec, entry);
      return () => definition.handler(invocation, args, exec);
    },
    async executeAction(gate, context, action, exec, operation) {
      if (!actions.has(action)) return gate.executeAction(context, action, exec, operation);
      const entry = commandExecutions.get(exec);
      if (!entry || entry.action !== action) return rejected(error('IAM_CONSUMPTION_UNVERIFIED'));
      try {
        await prepare(entry, exec);
        const result = await gate.executeAction(context, action, exec, async () => { current(exec); return await operation(); });
        current(exec);
        if (result.kind === 'error') return rejected(error('IAM_CONSUMPTION_DENIED'));
        return entry.core.finish(records.get(exec).operation, exec, result);
      } catch (cause) { return rejected(safe(cause)); }
      finally { release(exec); }
    },
    release,
    dispose() {
      if (!active) return;
      active = false;
      for (const entry of entries) entry.core.dispose();
      for (const dispose of registrations.splice(0).reverse()) dispose();
    },
  };
  const dispose = installPolicy(ctx, config, {
    guard: (callback) => ctx.tools.guard(callback), pre: (callback) => ctx.on('tools/pre-execute', callback),
  }, owned);
  try {
    for (const entry of entries) registrations.push(entry.kind === 'tool' ? ctx.tools.register(entry.definition)
      : ctx.get('policy').registerCommand(ctx, entry.definition));
  } catch (cause) { dispose(); throw safe(cause, 'IAM_CONSUMPTION_UNVERIFIED'); }
  return Object.freeze({ tools: Object.freeze([...toolsByName.values()].map((entry) => entry.definition)),
    commands: Object.freeze([...commandsByName.values()].map((entry) => entry.definition)), dispose });
}
