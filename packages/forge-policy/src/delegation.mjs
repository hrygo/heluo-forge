/**
 * 调用来源判定：谁在发起这次受控写。
 *
 * 宿主对"子代理"的唯一权威判据是 `agent.session.header.origin === 'subagent'`。
 * `session.header.parentSession` 在历史普通 fork 上也存在，`ctx.subagents.rootOf()`
 * 对非托管实例抛 `UNAUTHORIZED`，两者都不能用来判定来源，因此这里只认 origin 与
 * 兼容字段（`kind`/`origin` 的历史取值）。判定是纯函数：没有宿主也能逐条验证。
 *
 * 文案与审计摘要同在此处，gate 与用例都从这里取，避免同一个拒绝理由出现两套措辞。
 */

export const PERSONA = Object.freeze({
  HOST: 'host',
  ROOT: 'root',
  CHILD: 'child',
});

/** 宿主权威来源值：`session.header.origin`。 */
const SUBAGENT_ORIGIN = 'subagent';

/** 测试桩与历史字段里的子代理取值；只用于兼容，不替代宿主 origin。 */
const CHILD_KINDS = Object.freeze(['child', 'subagent', 'sub-agent', 'worker', 'teammate']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 来源判定（按序短路）：无 agent 是宿主直接调用；宿主 origin 为 subagent 是子代理；
 * 其余带子代理风格 `kind`/`origin` 的桩按子代理处理；剩下的是主会话中的 agent。
 *
 * @param {unknown} agent 宿主传入的 `exec.agent`
 * @returns {'host' | 'root' | 'child'}
 */
export function personaOf(agent) {
  if (agent === null || agent === undefined) return PERSONA.HOST;
  if (!isPlainObject(agent)) return PERSONA.ROOT;
  const header = agent.session?.header;
  if (isPlainObject(header) && header.origin === SUBAGENT_ORIGIN) return PERSONA.CHILD;
  for (const key of ['kind', 'origin']) {
    const value = agent[key];
    if (typeof value === 'string' && CHILD_KINDS.includes(value)) return PERSONA.CHILD;
  }
  return PERSONA.ROOT;
}

/**
 * 审计里记录的 `agent.kind`：保持 P0 兼容（字符串 `kind` 原样），其余按来源归一。
 *
 * @param {object} [exec] host execution object
 * @returns {string} `host` | `root` | `child` | 原样字符串
 */
export function agentKindOf(exec) {
  const agent = exec?.agent;
  if (agent === null || agent === undefined) return PERSONA.HOST;
  const persona = personaOf(agent);
  // 来源结论优先：审计必须能看出这次写来自子代理，哪怕宿主给的 kind 是笼统的 'agent'。
  if (persona === PERSONA.CHILD) return PERSONA.CHILD;
  if (isPlainObject(agent) && typeof agent.kind === 'string' && agent.kind.trim() !== '') return agent.kind;
  return persona === PERSONA.HOST ? PERSONA.ROOT : persona;
}

/**
 * 找到这次子代理调用所属的存活根（主会话）agent。
 *
 * 宿主只允许"存活的根"收人工确认（`assertLiveRoot` 会抛 `DELEGATED_CALLER`），
 * 所以子代理要拿到卡片，只能由它的根会话代问。沿 `session.header.parentSession`
 * 上溯，命中 `agents.roots()` 的那只就是根；上溯不到时只有全进程恰好一个根才敢认
 * ——多个根时猜错会把卡片弹进别人的会话，宁可不弹。
 *
 * @param {object} ctx 插件上下文（需要 `ctx.get('agents')`）
 * @param {unknown} agent 触发这次调用的子代理
 * @returns {object | undefined} 存活根 agent
 */
export function rootOf(ctx, agent) {
  const registry = ctx?.get?.('agents');
  if (registry === null || typeof registry !== 'object' || typeof registry.roots !== 'function') {
    return undefined;
  }
  const roots = registry.roots();
  if (!Array.isArray(roots) || roots.length === 0) return undefined;
  let current = agent;
  for (let depth = 0; depth < 32; depth += 1) {
    const parentId = isPlainObject(current) ? current.session?.header?.parentSession : undefined;
    if (typeof parentId !== 'string' || parentId === '') break;
    const root = roots.find((candidate) => candidate?.id === parentId);
    if (root !== undefined) return root;
    current = typeof registry.get === 'function' ? registry.get(parentId) : undefined;
  }
  return roots.length === 1 ? roots[0] : undefined;
}

/** 子代理来源的拒绝文案：只说明必须在主会话发起，不给任何绕过提示。 */
export function delegationCopy(action) {
  return `受控写「${action}」已拒绝：本次调用来自子代理，受控写必须在主会话发起。请在主会话重新发起该动作。`;
}

/** 需要人工确认的写来自子代理时的拒绝文案（开关关闭时的兜底）。 */
export function confirmDelegatedCopy(action) {
  return `受控写「${action}」需要人工确认，但本次调用来自子代理、又找不到可代问的主会话，未执行。请在主会话重新发起该动作。`;
}

/** 一条审计即可解释拒绝理由：来源、动作、结论。 */
export function delegationSummary(action) {
  return `受控写 ${action}：本次调用来自子代理，已拒绝（受控写必须在主会话发起）`;
}
