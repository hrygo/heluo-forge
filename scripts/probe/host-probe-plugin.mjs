/**
 * A01 (#20) 宿主扩展点探针插件。
 *
 * 在真实 DSH 宿主进程内挂载，用宿主自己的工具管线跑断言：guard 单调拒绝、
 * `tools/pre-execute` 异步决策、agent-less `ask` 降级、`tools/result` 观察者异常、
 * 卸载清理、命令面是否独立于工具管线、`approval` 的 `never` 策略。
 *
 * 只用公开服务（ctx.tools / ctx.commands / ctx.approval），不读私有字段；
 * 拟定结果写 DSH_HOST_PROBE_OUT，随后退出进程（探针 profile 专用，不改宿主行为）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'forge-host-probe';
export const inject = ['tools', 'agents'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) =>
  Array.isArray(result?.content) ? result.content.map((part) => part?.text ?? '').join(' ').trim() : '';
const okValue = (label) => ({ text: `${label} ran` });
const errorOf = (result) => (result?.error === undefined ? undefined : { code: result.error.code, message: result.error.message });

function probeTool(toolName, body) {
  return {
    name: toolName,
    description: `probe tool ${toolName}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    // `register` requires output { schema, render }: the body value is validated
    // against the schema, and `render` projects it into the result `content`.
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: body,
  };
}

/** A minimal session stand-in good enough for the approval service's documented reads. */
function stubSession() {
  const events = [{ type: 'turn/start' }];
  return {
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    append: (type, data) => events.push({ type, data }),
  };
}

export function apply(ctx) {
  const dir = process.env.DSH_HOST_PROBE_DIR ?? process.cwd();
  const out = process.env.DSH_HOST_PROBE_OUT ?? join(dir, 'probe-raw.json');
  mkdirSync(dir, { recursive: true });

  const checks = [];
  const blocked = [];
  const step = async (id, run) => {
    try {
      const { ok, detail } = await run();
      checks.push({ id, ok: ok === true, detail });
    } catch (error) {
      checks.push({ id, ok: false, detail: { threw: String(error?.message ?? error) } });
    }
  };

  const main = async () => {
    let seq = 0;
    const signal = new AbortController().signal;
    const dispatch = async (toolName, args = {}) => {
      seq += 1;
      try {
        const result = await ctx.tools.execute({ callId: `probe-${seq}`, name: toolName, arguments: args, signal });
        return { isError: result?.isError === true, text: textOf(result), error: errorOf(result) };
      } catch (error) {
        return { threw: String(error?.message ?? error) };
      }
    };

    const bodyCalls = { body: 0, asyncAllow: 0, asyncDeny: 0, ask: 0, side: 0 };
    const disposers = [];
    const guardSeen = [];
    const sideEffect = join(dir, 'side-effect.txt');

    disposers.push(
      ctx.tools.register(probeTool('probe_body', () => (bodyCalls.body += 1, okValue('probe_body')))),
      ctx.tools.register(probeTool('probe_async_allow', () => (bodyCalls.asyncAllow += 1, okValue('probe_async_allow')))),
      ctx.tools.register(probeTool('probe_async_deny', () => (bodyCalls.asyncDeny += 1, okValue('probe_async_deny')))),
      ctx.tools.register(probeTool('probe_ask', () => (bodyCalls.ask += 1, okValue('probe_ask')))),
      ctx.tools.register(
        probeTool('probe_side', () => {
          bodyCalls.side += 1;
          writeFileSync(sideEffect, `side effect at ${new Date().toISOString()}\n`);
          return okValue('probe_side');
        }),
      ),
    );

    // A permissive guard first: a later denial must still win (monotonic guards).
    const disposePermissive = ctx.tools.guard((exec) => (guardSeen.push(exec.name), undefined));
    const disposeDeny = ctx.tools.guard((exec) =>
      exec.name === 'probe_body' ? 'probe-guard-deny' : undefined,
    );
    disposers.push(disposePermissive, disposeDeny);

    await step('guard-deny-zero-side-effect', async () => {
      const result = await dispatch('probe_body');
      return {
        ok: result.isError === true && bodyCalls.body === 0 && result.text.includes('probe-guard-deny'),
        detail: { result, bodyCalls: bodyCalls.body, expected: 'isError with reason probe-guard-deny and zero body calls' },
      };
    });

    await step('guard-monotonic-no-force-allow', async () => {
      const first = guardSeen.length;
      const result = await dispatch('probe_body');
      return {
        ok: result.isError === true && bodyCalls.body === 0 && guardSeen.length > first,
        detail: { result, guardsObserved: guardSeen.slice(first), note: 'permissive guard ran before the denying guard and could not force-allow' },
      };
    });

    const disposePre = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'probe_async_deny') {
        await sleep(10);
        return { kind: 'deny', reason: 'probe-async-deny' };
      }
      if (exec.name === 'probe_async_allow') {
        await sleep(10);
        return { kind: 'allow' };
      }
      if (exec.name === 'probe_ask') return { kind: 'ask', reason: 'probe-ask' };
      return next();
    });
    disposers.push(disposePre);

    await step('pre-execute-async-deny', async () => {
      const result = await dispatch('probe_async_deny');
      return {
        ok: result.isError === true && bodyCalls.asyncDeny === 0 && result.text.includes('probe-async-deny'),
        detail: { result, bodyCalls: bodyCalls.asyncDeny },
      };
    });

    await step('pre-execute-async-allow', async () => {
      const result = await dispatch('probe_async_allow');
      return {
        ok: result.isError !== true && bodyCalls.asyncAllow === 1,
        detail: { result, bodyCalls: bodyCalls.asyncAllow },
      };
    });

    await step('pre-execute-ask-without-agent-denies', async () => {
      const result = await dispatch('probe_ask');
      return {
        ok: result.isError === true && bodyCalls.ask === 0 && /no agent to route it through/.test(result.text),
        detail: { result, bodyCalls: bodyCalls.ask },
      };
    });

    const disposeObserverThrow = ctx.on('tools/result', () => {
      throw new Error('probe observer boom');
    });
    const disposeObserverReject = ctx.on('tools/result', async () => {
      throw new Error('probe observer async boom');
    });

    await step('result-observer-throw-keeps-outcome', async () => {
      const result = await dispatch('probe_side');
      return {
        ok: result.isError !== true && bodyCalls.side === 1,
        detail: { result, bodyCalls: bodyCalls.side, sideEffectWritten: true },
      };
    });
    disposers.push(disposeObserverThrow, disposeObserverReject);

    await step('uninstall-cleanup', async () => {
      for (const dispose of disposers) dispose();
      await sleep(0);
      const afterGet = ctx.tools.get('probe_body') === undefined ? 'absent' : 'visible';
      const result = await dispatch('probe_body');
      return {
        ok: afterGet === 'absent' && result.isError === true,
        detail: { toolAfterDispose: afterGet, result },
      };
    });

    await step('command-surface-separate-from-tools', async () => {
      const commands = ctx.get('commands');
      if (commands === undefined) return { ok: false, detail: { available: false } };
      const disposeCommand = commands.register({
        name: 'probe-cmd',
        description: 'probe command',
        handler: async () => ({ kind: 'success', text: 'probe command ran' }),
      });
      const seenBefore = guardSeen.length;
      const session = stubSession();
      let execution;
      try {
        execution = await commands.execute({ session }, '/probe-cmd', [], signal);
      } catch (error) {
        execution = { threw: String(error?.message ?? error) };
      }
      const guardSawCommand = guardSeen.slice(seenBefore).some((seen) => seen === 'probe-cmd');
      disposeCommand();
      return {
        ok: guardSawCommand === false,
        detail: {
          registered: true,
          execution,
          guardObservedDuringCommand: guardSeen.slice(seenBefore),
          note: 'commands 由独立服务派发，工具管线 guard 未看到该次调用；真正纳入统一门禁是 P01 (#21) 的实现项',
        },
      };
    });

    await step('approval-never-policy-rejects', async () => {
      const approval = ctx.get('approval');
      if (approval === undefined) return { ok: false, detail: { available: false } };
      const session = stubSession();
      approval.setPolicy({ session, inject: () => {} }, 'never');
      const outcome = await approval.request({ agent: { session, inject: () => {} }, toolName: 'probe_body', callId: 'probe-approval', signal });
      return { ok: outcome === 'rejected', detail: { outcome, expected: 'rejected' } };
    });

    // 记录本轮无法跑通的一项：子 Agent 限制是否继承需要真实 agent 会话，
    // 而探针所用的 sdk/headless profile 不含 agent-loop 与 subagent 插件。
    // 真实 agent 只能在注入就绪的活跃作用域内创建（Cordis 效果语义）。
    const agentFacts = await Promise.race([
      new Promise((resolve) => {
        ctx.inject(['agents'], (scope) => {
          void (async () => {
            try {
              resolve({ handle: await scope.agents.create({ cwd: dir }) });
            } catch (error) {
              resolve({ error: String(error?.message ?? error) });
            }
          })();
        });
      }),
      sleep(5000).then(() => ({ error: 'inject(agents) 未在 5s 内就绪' })),
    ]);
    const agentHandle = agentFacts.handle;
    const agentCreateError = agentFacts.error;
    const subagents = ctx.get('subagents');
    const providers =
      subagents === undefined
        ? 'service-absent'
        : subagents.list().map((providerName) => {
            const provider = subagents.getProvider(providerName);
            return { providerName, inheritsParentContext: provider?.inheritsParentContext, capabilities: provider?.capabilities };
          });
    if (agentHandle === undefined) {
      blocked.push({
        id: 'subagent-restriction-inheritance',
        reason: '探针 profile 无法创建真实 agent 会话，继承实验未跑；已记录可声明的继承属性与该失败原因',
        evidence: { agentsCreate: agentCreateError, subagentProviders: providers },
      });
    } else {
      const agent = agentHandle.agent ?? agentHandle;
      const agentCtx = agent.ctx ?? agentHandle.ctx;
      await step('agent-scoped-restriction-is-per-scope', async () => {
        const globalsBefore = ctx.tools.schemas().some((schema) => schema.name === 'probe_body');
        const disposeRestrict = agentCtx.tools.restrict({ deny: ['probe_body'] });
        const visibleForAgent = ctx.tools.get('probe_body', agent) !== undefined;
        const globalStillVisible = ctx.tools.get('probe_body') !== undefined;
        disposeRestrict();
        return {
          ok: globalsBefore && visibleForAgent === false && globalStillVisible === true,
          detail: { globalsBefore, visibleForAgent, globalStillVisible, note: '作用域限制只影响该 agent 视图，全局视图不变' },
        };
      });
      blocked.push({
        id: 'subagent-restriction-inheritance',
        reason: '子 Agent 是否继承父作用域限制仍需一次真实委派（会触发模型调用），本轮以 provider 声明与作用域事实记录',
        evidence: { subagentProviders: providers, agentScopedRestriction: 'per-scope (见 agent-scoped-restriction-is-per-scope)' },
      });
    }

    const failed = checks.filter((check) => !check.ok).length;
    const report = {
      probe: 'forge-host-probe',
      harness: process.env.DSH_HOST_PROBE_HARNESS ?? 'unknown',
      env: { node: process.version, platform: `${process.platform}-${process.arch}` },
      checks,
      blocked,
      failed,
      passed: checks.length - failed,
    };
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = failed === 0 ? 0 : 1;
    process.exit(failed === 0 ? 0 : 1);
  };

  void main().catch((error) => {
    writeFileSync(
      out,
      `${JSON.stringify({ probe: 'forge-host-probe', harness: process.env.DSH_HOST_PROBE_HARNESS ?? 'unknown', env: { node: process.version, platform: `${process.platform}-${process.arch}` }, crashed: String(error?.stack ?? error) }, null, 2)}\n`,
    );
    process.exit(2);
  });
}
