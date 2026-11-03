// SDK-shaped local registry only. No installed SDK or current profile executes.
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const failed = (error) => ({ isError: true, error: { message: String(error?.message ?? error),
  info: { name: 'Error', code: error?.code ?? 'TOOL_ERROR' } }, content: [{ type: 'text', text: String(error?.message ?? error) }] });
const success = (definition, exec, value) => ({ isError: false, value,
  content: definition.output.render(exec.arguments, value) });

export function createToolRuntime() {
  const services = new Map(), definitions = new Map(), commands = new Map(), listeners = new Map(), guards = [];
  const executions = [], finalResults = [], phases = [];
  const on = (name, fn) => {
    const entries = listeners.get(name) ?? []; entries.push(fn); listeners.set(name, entries);
    return () => { const at = entries.indexOf(fn); if (at >= 0) entries.splice(at, 1); };
  };
  const waterfall = (name, args, last) => {
    const entries = [...(listeners.get(name) ?? [])];
    const next = (i) => i === entries.length ? last() : entries[i](...args, () => next(i + 1));
    return next(0);
  };
  const tools = {
    register(definition) {
      if (definitions.has(definition.name)) throw new Error('duplicate fixture tool');
      definitions.set(definition.name, definition);
      return () => { if (definitions.get(definition.name) === definition) definitions.delete(definition.name); };
    },
    guard(fn) { guards.push(fn); return () => { const at = guards.indexOf(fn); if (at >= 0) guards.splice(at, 1); }; },
    get: (name) => definitions.get(name),
    async execute(input) {
      const definition = definitions.get(input.name);
      if (!definition) return failed(Object.assign(new Error('unknown tool'), { code: 'UNKNOWN_TOOL' }));
      const originalSignal = input.signal;
      const exec = { ...input, rootCallId: input.rootCallId ?? input.callId, token: Symbol('native-fixture-call'),
        arguments: freeze(structuredClone(input.arguments)), deferContext() {}, concludeTurn() {} };
      executions.push(exec);
      let result;
      try {
        phases.push('pre');
        const pre = await waterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }));
        if (pre.kind === 'deny') throw new Error(pre.reason);
        phases.push('guard');
        for (const guard of [...guards]) { const reason = guard(exec); if (reason !== undefined) throw new Error(reason); }
        phases.push('execute');
        result = await waterfall('tools/execute', [exec], async () => {
          exec.signal = AbortSignal.any([originalSignal, exec.signal]);
          if (exec.signal.aborted) throw new Error('aborted before dispatch');
          phases.push('body');
          return success(definition, exec, await definition.execute(exec.arguments, exec));
        });
      } catch (error) { result = failed(error); }
      try {
        phases.push('post');
        const post = await waterfall('tools/post-execute', [exec, freeze(structuredClone(result))], async () => ({ kind: 'accept' }));
        if (post.kind === 'block') result = { ...failed(new Error('post blocked')), content: post.feedback };
        else if (Object.hasOwn(post, 'value')) result = success(definition, exec, post.value);
        else if (Object.hasOwn(post, 'content')) result = { ...result, content: post.content };
      } catch (error) { result = failed(error); }
      if (originalSignal.aborted && !result.isError) result = failed(new Error('aborted'));
      try {
        phases.push('finalize');
        const content = definition.finalizeContent?.(exec, freeze(structuredClone(result)));
        if (content !== undefined) result = { ...result, content };
      } catch (error) { result = failed(error); }
      result = freeze(structuredClone(result));
      phases.push('result');
      for (const listener of [...(listeners.get('tools/result') ?? [])]) listener(exec, result);
      finalResults.push(result);
      return result;
    },
  };
  const ctx = { tools, on,
    get: (name) => name === 'commands' ? { register(definition) {
      if (commands.has(definition.name)) throw new Error('duplicate fixture command');
      commands.set(definition.name, definition);
      return () => { if (commands.get(definition.name) === definition) commands.delete(definition.name); };
    } } : services.get(name),
    provide: (name, value) => { services.set(name, value); return () => services.delete(name); },
    effect: (callback) => callback(),
  };
  return { ctx, on, definitions, commands, guards, executions, finalResults, phases,
    first(name, listener) { const entries = listeners.get(name) ?? []; entries.unshift(listener); listeners.set(name, entries); },
    run(name = 'synthetic.read', args = { target: 'repo-A', payload: 'synthetic input' }, signal = new AbortController().signal) {
      return tools.execute({ name, arguments: args, callId: `tool-${executions.length + 1}`, agent: Object.freeze({ id: 'agent-fixture' }), signal });
    },
    command(name = 'synthetic-read', changes = {}) {
      const invocation = { commandId: 'command-1', agent: Object.freeze({ id: 'agent-fixture' }),
        rawInput: 'repo-A', attachments: [], signal: new AbortController().signal, ...changes };
      return commands.get(name).handler(invocation);
    },
  };
}
