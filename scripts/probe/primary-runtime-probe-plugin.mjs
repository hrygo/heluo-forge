/**
 * 内置运行时探针插件（CORP-DSH-DESIGN-025，CORP-DSH-PLAN-026 §3 #9）。
 *
 * 经 `--patch` 覆盖层挂在 `web` profile 的末尾，在真实 DSH 宿主进程内用宿主自己的
 * 工具管线核对内置运行时是否到达了 agent：`load_workspace_dependencies` 在宿主层注册、
 * 对 standard preset 的 agent 可见、调用后把载荷安装到 Harness home；Office 技能把模型
 * 指向内置依赖；agent 自己的 shell 能用返回的 Python 跑起 Office 库。
 *
 * 只用公开服务（ctx.tools / ctx.agents / ctx.get('agentPresets')），不读私有字段；
 * 拟定结果写 `HELUO_RUNTIME_PROBE_OUT`，随后退出进程（探针专用，不改宿主行为）。
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'forge-primary-runtime-probe';
export const inject = ['tools', 'agents'];

const OUT = 'HELUO_RUNTIME_PROBE_OUT';
const DIR = 'HELUO_RUNTIME_PROBE_DIR';
const MODULES = 'HELUO_RUNTIME_PROBE_MODULES';
const TOOL = 'load_workspace_dependencies';
/** How long to wait for the rest of the profile to finish starting. */
const STARTUP_WAIT_ATTEMPTS = 200;
const STARTUP_WAIT_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (Array.isArray(result?.content) ? result.content.map((part) => part?.text ?? '').join('\n').trim() : '');

/**
 * 一次派发，形状与模型发出的工具调用到达注册表时一致。批次带上所属 Agent：
 * 服务按该 Agent 的作用域选择执行器，preset 自带的工具（`bash`、`skill`）就住在那里。
 *
 * @param {object} ctx 宿主上下文
 * @param {AbortSignal} signal 中止信号
 * @param {object} agent 所属 Agent
 * @param {string} toolName 工具名
 * @param {object} [args] 已解析的工具参数
 * @returns {Promise<{isError: boolean, text: string, error?: {code: string, message: string}}>}
 */
async function dispatch(ctx, signal, agent, toolName, args = {}) {
  const id = `probe-${toolName}`;
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) }], signal, agent });
  const result = batch?.results?.length === 1 && batch.results[0]?.callId === id ? batch.results[0].result : undefined;
  if (typeof result?.isError !== 'boolean' || !Array.isArray(result.content)) throw new Error(`tools.execute returned an invalid result for ${toolName}`);
  return { isError: result.isError, text: textOf(result), error: result.error === undefined ? undefined : { code: result.error.code, message: result.error.message } };
}

export function apply(ctx) {
  const out = process.env[OUT];
  const dir = process.env[DIR] ?? process.cwd();
  const modules = process.env[MODULES];

  const main = async () => {
    const facts = { node: process.version, electron: process.versions.electron ?? null, primaryRuntime: process.env.DSH_PRIMARY_RUNTIME ?? null };
    const signal = new AbortController().signal;

    // 被测的两行位于同一补丁栈的更前面：等工具出现，而不是假定挂载顺序。
    facts.hostSeesTool = false;
    for (let attempt = 0; attempt < STARTUP_WAIT_ATTEMPTS && !facts.hostSeesTool; attempt += 1) {
      facts.hostSeesTool = ctx.tools.get(TOOL) !== undefined;
      if (!facts.hostSeesTool) await sleep(STARTUP_WAIT_MS);
    }

    // preset 在 profile 启动过程中自行登记：等默认 preset 解析得出，而不是假定列表已就绪。
    let presets;
    let resolvedId;
    let waiting;
    for (let attempt = 0; attempt < STARTUP_WAIT_ATTEMPTS && resolvedId === undefined; attempt += 1) {
      presets = ctx.get('agentPresets');
      if (presets !== undefined) {
        try {
          resolvedId = (await presets.resolve(undefined)).id;
        } catch (error) {
          waiting = String(error?.message ?? error);
        }
      }
      if (resolvedId === undefined) await sleep(STARTUP_WAIT_MS);
    }
    facts.agentPresets = presets === undefined ? 'absent' : 'present';
    if (resolvedId === undefined) {
      facts.compositionError = waiting ?? 'no default preset';
      return facts;
    }
    const agentPreset = resolvedId;
    facts.preset = agentPreset;
    facts.presetMounted = false;

    // 按 web 应用的会话控制器的方式组装 agent：解析默认 preset，再在 agent 自己的 setup 里
    // 装上模型选择并挂载 preset。
    let composition;
    try {
      const agent = await import(pathToFileURL(join(modules, '@deepseek-ai', 'dsh-agent', 'lib', 'index.js')).href);
      composition = {
        agentPreset,
        setup: async (agentCtx) => {
          agent.installModelSelection(agentCtx);
          await presets.mount(agentCtx, agentPreset);
          facts.presetMounted = true;
        },
      };
    } catch (error) {
      facts.compositionError = String(error?.message ?? error);
      return facts;
    }

    // 真实 agent 只能在注入就绪的活跃作用域内创建，且要等 agent loop 登记好工厂；
    // 该插件与本插件一同启动。
    let scope;
    let created;
    for (let attempt = 0; attempt < STARTUP_WAIT_ATTEMPTS && created?.error === undefined; attempt += 1) {
      created = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        ctx.inject(['agents'], (injected) => {
          injected.agents
            .create({
              sessionId: `probe-primary-runtime-${randomBytes(3).toString('hex')}`,
              meta: { cwd: dir, agentPreset },
              setup: async (agentScope) => {
                scope = agentScope;
                await composition.setup(agentScope);
              },
            })
            .then((handle) => done({ handle }), (error) => done({ error: String(error?.message ?? error) }));
        });
        setTimeout(() => done({ error: 'the agents service was not ready within 15 s' }), 15_000).unref?.();
      });
      if (created?.error !== undefined && /no agent factory registered/u.test(created.error)) {
        await sleep(STARTUP_WAIT_MS);
        continue;
      }
    }
    if (created?.error !== undefined) {
      facts.agentCreateError = created.error;
      return facts;
    }
    const agent = created.handle.agent ?? created.handle;
    void scope;
    facts.agentSeesTool = ctx.tools.get(TOOL, agent) !== undefined;
    facts.agentSeesBash = ctx.tools.get('bash', agent) !== undefined;
    facts.agentSeesSkill = ctx.tools.get('skill', agent) !== undefined;
    const run = async (tool, args) => {
      try {
        return await dispatch(ctx, signal, agent, tool, args);
      } catch (error) {
        return { isError: true, text: '', error: { code: 'THREW', message: String(error?.message ?? error) } };
      }
    };

    facts.load = await run(TOOL, {});
    facts.loadAgain = await run(TOOL, {});
    facts.skill = await run('skill', { name: 'office-docx' });
    const python = /"python"\s*:\s*"([^"]+)"/u.exec(facts.load.text)?.[1];
    facts.python = python ?? null;
    facts.bash = await run('bash', {
      description: 'Check the bundled Python',
      command: python === undefined
        ? 'echo PROBE_NO_PYTHON'
        : `"${python}" -I -B -c "import sys, numpy, pandas, docx, pptx, openpyxl; print('PROBE_PY_OK', sys.version.split()[0], numpy.__version__, pandas.__version__)"`,
    });
    return facts;
  };

  const finish = (facts) => {
    if (typeof out === 'string' && out !== '') writeFileSync(out, `${JSON.stringify(facts, null, 2)}\n`);
    // 判定由驱动读文件完成；这里的退出码不承载结论。
    process.exit(0);
  };
  main().then(finish, (error) => finish({ fatal: String(error?.stack ?? error) }));
}
