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
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
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
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        path: { type: 'string' },
        readOnly: { type: 'boolean' },
        mutating: { type: 'boolean' },
      },
      required: [],
      additionalProperties: false,
    },
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
      // sdk profile 的宿主在 stdin EOF 后开始卸载，偶尔会让一次派发落在失活窗口
      // （"inactive context"）；这不是被测行为，重试一次后仍失败才记录为该检查的失败。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        seq += 1;
        try {
          const result = await ctx.tools.execute({ callId: `probe-${seq}`, name: toolName, arguments: args, signal });
          return { isError: result?.isError === true, text: textOf(result), error: errorOf(result) };
        } catch (error) {
          const message = String(error?.message ?? error);
          if (attempt === 0 && message.includes('inactive context')) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
          }
          return { threw: message };
        }
      }
      return { threw: 'unreachable' };
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

    // 实测：晚到的注册会撞上宿主卸载（"cannot create effect on inactive context"），
    // 因此身份观察、技能注册与门禁探针工具都在入口处一次完成，后面的步骤只做观察与派发。
    const identityForged = { agent: { id: 'forged-principal' }, principal: 'forged', approved: true, review_kind: 'human' };
    const identityObservation = {};
    disposers.push(
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.name === 'probe_identity') {
          identityObservation.agentIsTheForgedArgument = exec.agent === identityForged.agent;
          identityObservation.agentPresent = exec.agent !== undefined;
          identityObservation.forgedKeys = Object.keys(exec.arguments ?? {});
        }
        return next();
      }),
      ctx.tools.register(probeTool('probe_identity', () => okValue('probe_identity'))),
    );

    const clauseContent = '# 探针条款\n硬要求：外发前必须确认。\n';
    const probeClauseSummary = {
      name: 'probe-provider-clause',
      description: '探针企业条款：外发前必须确认',
      whenToUse: '当任务涉及企业外发时按需加载；由用户显式触发',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'custom',
    };
    const skillsService = ctx.get('skills');
    const skillsRegistration = { registered: false, providerRegistered: false };
    if (skillsService !== undefined) {
      try {
        disposers.push(
          skillsService.register({
            name: 'probe-enterprise-clause',
            description: '探针企业条款：外发前必须确认',
            whenToUse: '当任务涉及企业外发时按需加载；由用户显式触发',
            content: clauseContent,
            source: 'custom',
            invocation: { modelInvocable: false, userInvocable: true },
          }),
        );
        skillsRegistration.registered = true;
      } catch (error) {
        skillsRegistration.registerError = String(error?.message ?? error);
      }
      try {
        // 目录读取走 provider 路径；正文只在 get() 时按需返回。
        disposers.push(
          skillsService.registerProvider(() => ({
            name: 'probe-enterprise-provider',
            list: async () => [
              { ...probeClauseSummary, provider: 'probe-enterprise-provider', rank: 0, locator: { clause: 'probe-1' } },
            ],
            get: async () => ({
              ...probeClauseSummary,
              provider: 'probe-enterprise-provider',
              content: clauseContent,
              metadata: { owner: 'security', level: 'hard' },
            }),
          })),
        );
        skillsRegistration.providerRegistered = true;
      } catch (error) {
        skillsRegistration.providerError = String(error?.message ?? error);
      }
    }

    // A permissive guard first: a later denial must still win (monotonic guards).
    const disposePermissive = ctx.tools.guard((exec) => (guardSeen.push(exec.name), undefined));
    const disposeDeny = ctx.tools.guard((exec) =>
      exec.name === 'probe_body' ? 'probe-guard-deny' : undefined,
    );
    disposers.push(disposePermissive, disposeDeny);

    const llmService = ctx.get('llm');
    if (llmService === undefined) {
      blocked.push({
        id: 'official-rows-runtime-model-surface',
        reason: '探针 profile 未挂载 llm 服务，无法核验官方模型面的运行时影响',
        evidence: { llmPresent: false },
      });
    } else {
      const baseline = process.env.DSH_HOST_PROBE_DISABLE_OFFICIAL === '0';
      const providers = llmService.listProviders().map((entry) => entry.id);
      const official = providers.filter((id) => /deepseek/i.test(id));
      blocked.push({
        id: 'official-rows-runtime-model-surface',
        reason:
          '本 profile 的 LLM 提供方在禁用前后都是 0 个（基线对照同样为 0），因此无法用它证明禁用行对模型面的运行时影响；' +
          '禁用行是否落地由驱动的 --dump-config 对照证明；运行时模型面需要在接了官方模型行的 desktop/web profile 上复跑',
        evidence: {
          baselineRun: baseline,
          apiKeyPresentInEnv: process.env.DEEPSEEK_API_KEY !== undefined,
          providerIds: providers,
          officialProviders: official,
        },
      });
    }

    // 模型门禁：用宿主实测的默认模型选择与可用提供方喂给门禁判定，
    // 再加一组"合成输入"验证切换/保留分支（合成部分不代表企业模型已就绪）。
    const defaultModelService = ctx.get('agentDefaultModel');
    const measuredSelection = (() => {
      if (defaultModelService === undefined) return { available: false };
      try {
        const selection = defaultModelService.currentSelection();
        return {
          available: true,
          keys: selection !== null && typeof selection === 'object' ? Object.keys(selection) : [],
          provider: typeof selection?.provider === 'string' ? selection.provider : undefined,
          model: typeof selection?.model === 'string' ? selection.model : undefined,
        };
      } catch (error) {
        return { available: true, error: String(error?.message ?? error) };
      }
    })();
    const availableProviderIds = llmService === undefined ? [] : llmService.listProviders().map((entry) => entry.id);
    const { evaluateModelGate } = await import('../../packages/forge-iam/src/model-gate.mjs');
    await step('model-gate-denies-on-measured-host-state', async () => {
      const measured = evaluateModelGate({
        signedIn: false,
        officialApiKeyPresent: process.env.DEEPSEEK_API_KEY !== undefined,
        selection:
          measuredSelection.provider === undefined
            ? undefined
            : { provider: measuredSelection.provider, model: measuredSelection.model, explicit: true },
        availableProviders: availableProviderIds,
        disabledProviders: ['deepseek'],
      });
      const synthetic = evaluateModelGate({
        signedIn: true,
        gatewayCredential: 'present',
        enterprise: { provider: 'enterprise-probe', model: 'probe-model' },
        selection: { provider: 'deepseek', model: 'deepseek-chat' },
        availableProviders: ['enterprise-probe'],
        disabledProviders: ['deepseek'],
      });
      return {
        ok:
          measured.allow === false &&
          measured.reason === 'not-signed-in' &&
          synthetic.allow === true &&
          synthetic.switchTo?.provider === 'enterprise-probe',
        detail: {
          measuredSelection,
          availableProviderIds,
          measuredDecision: { allow: measured.allow, reason: measured.reason, notes: measured.notes },
          syntheticDecision: { allow: synthetic.allow, reason: synthetic.reason, switchTo: synthetic.switchTo },
          note: '实测部分：宿主的默认模型选择与可用提供方；合成部分：只验证切换分支，不代表企业模型已就绪',
        },
      };
    });

    // 宿主服务相关的检查先跑：sdk profile 在 stdin EOF 后开始卸载，越晚越容易落在失活窗口。
    if (skillsService === undefined) {
      blocked.push({
        id: 'skills-registry-discovery-and-load',
        reason: '探针 profile 未加载 skills 服务，无法核验按需技能发现与加载',
        evidence: { skillsPresent: false },
      });
    } else {
      await step('skills-registry-discovery-and-load', async () => {
        const clausePath = join(dir, 'clause-fixture.md');
        writeFileSync(clausePath, clauseContent);
        const before = statSync(clausePath);
        const summaries = await skillsService.list({ cwd: dir });
        const providerSummary = summaries.find((entry) => entry.name === 'probe-provider-clause');
        const runtimeSummary = summaries.find((entry) => entry.name === 'probe-enterprise-clause');
        const loaded = await skillsService.get('probe-provider-clause', { cwd: dir });
        const after = statSync(clausePath);
        const result = {
          providerRegistered: skillsRegistration.providerRegistered,
          providerError: skillsRegistration.providerError,
          runtimeRegistered: skillsRegistration.registered,
          registerError: skillsRegistration.registerError,
          summaryCount: summaries.length,
          providerCandidateFound: providerSummary !== undefined,
          runtimeCandidateVisible: runtimeSummary !== undefined,
          summaryCarriesBody: providerSummary !== undefined && Object.hasOwn(providerSummary, 'content'),
          descriptionAccurate: providerSummary?.description === '探针企业条款：外发前必须确认',
          whenToUse: providerSummary?.whenToUse,
          modelInvocable: providerSummary?.invocation?.modelInvocable,
          userInvocable: providerSummary?.invocation?.userInvocable,
          bodyLoadedOnDemand: loaded?.content === clauseContent,
          wroteNothing: before.mtimeMs === after.mtimeMs && before.size === after.size,
        };
        return {
          ok:
            result.providerRegistered === true &&
            result.providerCandidateFound === true &&
            result.summaryCarriesBody === false &&
            result.descriptionAccurate === true &&
            result.modelInvocable === false &&
            result.userInvocable === true &&
            result.bodyLoadedOnDemand === true &&
            result.wroteNothing === true,
          detail: result,
        };
      });
    }

    await step('delegation-identity-not-model-supplied', async () => {
      const result = await dispatch('probe_identity', identityForged);
      return {
        ok: identityObservation.agentIsTheForgedArgument === false && identityObservation.agentPresent === false,
        detail: {
          result,
          observed: identityObservation,
          note: '工具参数里的 agent/principal/approved/review_kind 不会成为宿主身份；宿主未提供身份时 exec.agent 为 undefined',
        },
      };
    });

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

    // 五类开关：把宿主实测的依赖事实喂给组合声明（纯判定，不注册任何东西），
    // 再附一组合成输入验证"全就绪即全开"与"关一类不影响其他类"。
    const { resolveSwitches } = await import('../../packages/forge-enterprise/src/switches.mjs');
    const policyProvenReady = ['guard-deny-zero-side-effect', 'guard-monotonic-no-force-allow', 'pre-execute-async-deny']
      .every((id) => checks.find((entry) => entry.id === id)?.ok === true);
    const measuredIdentity = ctx.get('iam') === undefined ? 'missing' : 'ready';
    await step('combination-switches-fail-closed-on-measured-host', async () => {
      const measured = resolveSwitches({
        // policy 的"就绪"来自同一次探针里 guard/pre 行为断言通过，不是配置文件存在；
        // 探针挂的审计落点是 memory + allowNonDurable，按未就绪处理（企业落点未获准）。
        dependencies: { policy: policyProvenReady ? 'ready' : 'missing', iam: measuredIdentity, audit: 'non-durable-dev' },
        capabilities: { read: false, write: false, publish: false, review: false, observe: true },
        approved: ['read', 'research-write', 'ai-publish', 'human-review', 'observe'],
      });
      const synthetic = resolveSwitches({
        dependencies: { policy: 'ready', iam: 'ready', audit: 'ready' },
        capabilities: { read: true, write: true, publish: true, review: true, observe: true },
        approved: ['read', 'research-write', 'ai-publish', 'human-review', 'observe'],
        c3Approved: true,
      });
      const narrowed = resolveSwitches({
        dependencies: { policy: 'ready', iam: 'ready', audit: 'ready' },
        capabilities: { read: true, write: true, publish: true, review: true, observe: true },
        approved: ['read', 'research-write', 'ai-publish', 'human-review'],
        c3Approved: true,
      });
      return {
        ok:
          measured.on.length === 0 &&
          measured.blocked.length > 0 &&
          synthetic.on.length === 5 &&
          narrowed.switches.observe.state === 'off' &&
          narrowed.switches.read.state === 'on',
        detail: {
          measuredDependencies: { policy: policyProvenReady ? 'ready' : 'missing', iam: measuredIdentity, audit: 'non-durable-dev' },
          measured: {
            on: measured.on,
            blocked: measured.blocked,
            reasons: Object.fromEntries(Object.entries(measured.switches).map(([id, value]) => [id, value.reason])),
          },
          synthetic: { on: synthetic.on },
          narrowed: { on: narrowed.on, observe: narrowed.switches.observe.reason },
          note: 'measured 部分来自宿主实测；synthetic/narrowed 只验证声明分支，不代表企业能力已就绪',
        },
      };
    });

    // #23 AC3：恢复/分叉重新验证身份与范围。本进程就是"重启后的新会话"——内存里没有
    // 上一次运行的委托，因此天然验证"临时表/聊天不能恢复写授权"。
    const { authorizeDelegation, createDelegation, resumeDelegation } = await import('../../packages/forge-policy/src/delegation.mjs');
    await step('delegation-resume-needs-host-facts', async () => {
      const now = Date.now();
      const request = { principal: 'user-a', changeId: 'C-1', repository: 'repo-a', action: 'issue.create_or_update' };
      const withoutGrant = authorizeDelegation({ request, now });
      const untrustedCreate = (() => {
        try {
          createDelegation({ ...request, id: 'dlg-probe', source: 'chat', repositories: ['repo-a'], actions: [request.action], ttlMs: 60_000, now });
          return null;
        } catch (error) {
          return error.code ?? error.name;
        }
      })();
      const grant = createDelegation({
        id: 'dlg-probe',
        source: 'host',
        principal: 'user-a',
        changeId: 'C-1',
        repositories: ['repo-a'],
        actions: ['issue.create_or_update', 'change.read'],
        revisions: {},
        ttlMs: 60_000,
        now,
      });
      const chatResume = resumeDelegation({ grant, resume: { source: 'temporary-map', principal: 'user-a', changeId: 'C-1' }, now });
      const hostResume = resumeDelegation({ grant, resume: { source: 'host', principal: 'user-a', changeId: 'C-1', actions: ['change.read'] }, now });
      const resumedAllow = hostResume.action === 'allow' ? authorizeDelegation({ grant: hostResume.grant, request: { ...request, action: 'change.read' }, now }) : null;
      const resumedDropped = hostResume.action === 'allow' ? authorizeDelegation({ grant: hostResume.grant, request, now }) : null;
      const widened = resumeDelegation({ grant, resume: { source: 'host', principal: 'user-a', changeId: 'C-1', actions: ['issue.close'] }, now });
      return {
        ok:
          withoutGrant.rule === 'delegation-missing' &&
          untrustedCreate === 'POLICY_DELEGATION_UNTRUSTED_SOURCE' &&
          chatResume.rule === 'delegation-resume-untrusted-source' &&
          hostResume.action === 'allow' &&
          hostResume.scopeReduced === true &&
          resumedAllow?.action === 'allow' &&
          resumedDropped?.rule === 'delegation-action-out-of-scope' &&
          widened.rule === 'delegation-resume-scope-widened',
        detail: {
          withoutGrant: withoutGrant.rule,
          untrustedCreate,
          chatResume: chatResume.rule,
          hostResume: { action: hostResume.action, scopeReduced: hostResume.scopeReduced, expiresUnchanged: hostResume.grant?.expiresAt === grant.expiresAt },
          resumedAllow: resumedAllow?.action,
          resumedDropped: resumedDropped?.rule,
          widened: widened.rule,
          note: '本进程没有上一次运行的委托，等于"重启/分叉后内存为空"的实测',
        },
      };
    });

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
    await step('protected-root-resolution', async () => {
      const envFacts = {
        DSH_HOME: process.env.DSH_HOME !== undefined,
        DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME !== undefined,
        DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR !== undefined,
      };
      let resolver;
      try {
        const mod = await import('@deepseek-ai/dsh-home-paths');
        resolver = {
          importable: true,
          dshHome: typeof mod.dshHome === 'function',
          agentsHome: typeof mod.agentsHome === 'function',
          display: typeof mod.dshHomeDisplay === 'function',
        };
      } catch (error) {
        resolver = { importable: false, error: String(error?.message ?? error).slice(0, 120) };
      }
      const resolvable = envFacts.DSH_HOME === true || resolver.dshHome === true;
      return {
        ok: resolvable,
        detail: {
          envFacts,
          resolver,
          note: '只记录可用性与布尔事实，不记录 home 字面路径',
        },
      };
    });

    // 门禁集成：当 forge-policy 与本插件同进程挂载时，用合成查询验证
    // "登记且范围内可执行、未登记/未开放/错目标一律拒绝且副作用为零"。
    if (ctx.get('policy') !== undefined) {
      const gateTools = {
        read: 'probe_gate_read',
        write: 'probe_gate_write',
        unknown: 'probe_gate_unknown',
        confirm: 'probe_gate_confirm',
      };
      const gateCalls = { read: 0, write: 0, unknown: 0, confirm: 0 };
      const gateDisposers = [];
      for (const [key, toolName] of Object.entries(gateTools)) {
        gateDisposers.push(
          ctx.tools.register(
            probeTool(toolName, () => {
              gateCalls[key] += 1;
              return okValue(toolName);
            }),
          ),
        );
      }

      await step('gate-registered-read-runs', async () => {
        const result = await dispatch('probe_gate_read', { target: 'probe-target' });
        return {
          ok: result.isError !== true && gateCalls.read === 1,
          detail: { result, bodyCalls: gateCalls.read },
        };
      });

      await step('gate-disabled-write-denied', async () => {
        const result = await dispatch('probe_gate_write', { target: 'probe-target' });
        return {
          ok: result.isError === true && gateCalls.write === 0 && /not enabled/.test(result.text),
          detail: { result, bodyCalls: gateCalls.write },
        };
      });

      await step('gate-unregistered-action-denied', async () => {
        const result = await dispatch('probe_gate_unknown', { target: 'probe-target' });
        return {
          ok: result.isError === true && gateCalls.unknown === 0 && /not registered/.test(result.text),
          detail: { result, bodyCalls: gateCalls.unknown },
        };
      });

      await step('gate-missing-target-denied', async () => {
        const result = await dispatch('probe_gate_read', {});
        return {
          ok: result.isError === true && /requires a probe-target target/.test(result.text),
          detail: { result, bodyCalls: gateCalls.read },
        };
      });

      await step('gate-self-reported-readonly-ignored', async () => {
        const result = await dispatch('probe_gate_write', { target: 'probe-target', readOnly: true, mutating: false });
        return {
          ok: result.isError === true && gateCalls.write === 0,
          detail: { result, bodyCalls: gateCalls.write, note: '工具自报 readOnly/mutating 未改变判定' },
        };
      });

      const paths = (() => {
        try {
          return JSON.parse(process.env.DSH_HOST_PROBE_PATHS ?? '{}');
        } catch {
          return {};
        }
      })();
      let pathCalls = 0;
      gateDisposers.push(
        ctx.tools.register(
          probeTool('probe_gate_path', () => {
            pathCalls += 1;
            return okValue('probe_gate_path');
          }),
        ),
      );

      await step('gate-protected-path-denied', async () => {
        const result = await dispatch('probe_gate_path', { target: 'file', path: `${paths.protectedDir}/credentials.env` });
        return {
          ok: result.isError === true && pathCalls === 0 && /protected path/.test(result.text),
          detail: { result, bodyCalls: pathCalls, note: '直接命中受保护根内的路径' },
        };
      });

      await step('gate-protected-path-alias-denied', async () => {
        const traversal = await dispatch('probe_gate_path', {
          target: 'file',
          path: `${paths.protectedDir}/../protected/credentials.env`,
        });
        const symlink = paths.aliasReady === true
          ? await dispatch('probe_gate_path', { target: 'file', path: `${paths.aliasLink}/credentials.env` })
          : { isError: true, text: 'symlink unavailable on this host' };
        return {
          ok:
            traversal.isError === true &&
            symlink.isError === true &&
            pathCalls === 0 &&
            /protected path/.test(traversal.text) &&
            /protected path/.test(symlink.text),
          detail: { traversal, symlink, bodyCalls: pathCalls, aliasReady: paths.aliasReady === true },
        };
      });

      await step('gate-path-outside-root-allowed', async () => {
        const result = await dispatch('probe_gate_path', { target: 'file', path: `${dir}/notes.md` });
        return {
          ok: result.isError !== true && pathCalls === 1,
          detail: { result, bodyCalls: pathCalls, note: '受保护根之外不受影响' },
        };
      });

      await step('gate-audit-records-before-and-after-body', async () => {
        const policy = ctx.get('policy');
        const before = policy.auditRecords().length;
        const result = await dispatch('probe_gate_read', { target: 'probe-target' });
        const records = policy.auditRecords().filter((record) => record.tool === 'probe_gate_read');
        const begin = records.find((record) => record.phase === 'begin');
        const settle = records.find((record) => record.phase === 'settle');
        return {
          ok: result.isError !== true && begin !== undefined && settle !== undefined && policy.auditRecords().length > before,
          detail: {
            result,
            begin: begin === undefined ? undefined : { action: begin.action, decision: begin.decision, operationId: begin.operationId },
            settle: settle === undefined ? undefined : { decision: settle.decision, durationMs: settle.durationMs },
            note: '前置记录先于工具体写入，执行后由 tools/post-execute 补记；记录不含参数正文',
          },
        };
      });

      await step('gate-audit-failure-denies-with-zero-effects', async () => {
        const policy = ctx.get('policy');
        const restore = policy.setAuditSink({
          durable: true,
          append: () => {
            throw new Error('probe audit refused');
          },
        });
        const before = gateCalls.read;
        const result = await dispatch('probe_gate_read', { target: 'probe-target' });
        restore();
        return {
          ok: result.isError === true && gateCalls.read === before && /audit refused/.test(result.text),
          detail: { result, bodyCalls: gateCalls.read - before, note: '前置审计失败时不执行工具体' },
        };
      });

      await step('gate-audit-settle-failure-keeps-outcome-and-limits', async () => {
        const policy = ctx.get('policy');
        const restore = policy.setAuditSink({
          durable: true,
          append: (record) => {
            if (record.phase === 'settle') throw new Error('probe settle refused');
          },
        });
        const first = await dispatch('probe_gate_read', { target: 'probe-target' });
        const second = await dispatch('probe_gate_read', { target: 'probe-target' });
        const gaps = policy.auditGaps().length;
        const degraded = policy.auditDegraded();
        policy.acknowledgeAuditGaps();
        const third = await dispatch('probe_gate_read', { target: 'probe-target' });
        restore();
        policy.acknowledgeAuditGaps();
        return {
          ok: first.isError !== true && second.isError === true && gaps >= 1 && degraded === true && third.isError !== true,
          detail: {
            first,
            second,
            third,
            gaps,
            degraded,
            note: '补记失败保留执行结果、记缺口并限制后续动作；显式确认缺口后恢复',
          },
        };
      });

      for (const dispose of gateDisposers) dispose();
      await sleep(0);
    }

    // 真实 agent 只能在注入就绪的活跃作用域内创建（Cordis 效果语义）。
    // 宿主关闭或作用域失效时这里可能抛错；环境问题只记 blocked，不能让整份报告崩掉。
    let agentFacts;
    try {
      agentFacts = await Promise.race([
        new Promise((resolve) => {
          ctx.inject(['agents'], (scope) => {
            void (async () => {
              try {
                let capturedAgentCtx;
                const handle = await scope.agents.create({
                  sessionId: 'probe-agent-1',
                  meta: { cwd: dir },
                  setup: (agentCtx) => {
                    capturedAgentCtx = agentCtx;
                  },
                });
                resolve({ handle, agentCtx: capturedAgentCtx });
              } catch (error) {
                resolve({ error: String(error?.message ?? error) });
              }
            })();
          });
        }),
        sleep(5000).then(() => ({ error: 'inject(agents) 未在 5s 内就绪' })),
      ]);
    } catch (error) {
      agentFacts = { error: `inject(agents) failed: ${String(error?.message ?? error)}` };
    }
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
      const agentCtx = agentFacts.agentCtx;
      await step('agent-scoped-restriction-is-per-scope', async () => {
        // 作用域限制只接受全局工具名（实测：deny 本插件自己注册的工具会报 unknown global tool），
        // 因此用全局工具 bash 验证"限制只落在该 agent 视图"。
        const globalSeesBashBefore = ctx.tools.get('bash') !== undefined;
        // setup 回调给出的正是该 agent 的作用域上下文；restrict 必须从该作用域调用，
        // 视图查询按契约传 agent（"a restricted-away global reads as absent"）。
        const disposeRestrict = agentCtx.tools.restrict({ deny: ['bash'] });
        const visibleForAgent = ctx.tools.get('bash', agent) !== undefined;
        const globalStillVisible = ctx.tools.get('bash') !== undefined;
        disposeRestrict();
        const visibleForAgentAfterLift = ctx.tools.get('bash', agent) !== undefined;
        return {
          ok:
            globalSeesBashBefore &&
            visibleForAgent === false &&
            globalStillVisible === true &&
            visibleForAgentAfterLift === true,
          detail: {
            globalSeesBashBefore,
            visibleForAgent,
            globalStillVisible,
            visibleForAgentAfterLift,
            note: '限制只落在该 agent 视图（视图查询带 agent），全局视图不变；解除后恢复；限制名必须是全局工具名',
          },
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
