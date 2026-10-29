/**
 * `@heluo/forge-gitee` 的模型可见工具面：**固定 8 个**（3 只读 + 5 受控动作）。
 *
 * 三个刻意的设计点：
 * 1. **固定面、无泛化入口**：`GITEE_TOOLS` 是唯一真源，且名字必须是 `forge_gitee_<名词>_<动词>`
 *    形状——没有 `run` / `exec` / `shell` / `api` 这类"把命令交给模型"的工具。唯一子进程出口
 *    在 `gitee-cli.mjs`，模型够不到 argv，也没法用新命令绕过固定白名单（AC-9/14）。
 * 2. **组装而不重写**：只读定义来自 `gitee-read.mjs`、受控动作定义来自 `gitee-actions.mjs`；
 *    本模块只做注册表校验——缺项、多项、重名、没有执行体、名字越界都**当场抛错**，让
 *    "装上了 8 个"成为装配期事实，而不是运行到一半才发现少了某个工具。
 * 3. **顺序归一**：子表各自怎么排都行，注册顺序一律按 `GITEE_TOOLS`（3 读在前、5 写在后），
 *    这样模型看到的工具顺序与设计文档逐条对齐，不会随实现细节抖动。
 *
 * 写工具默认不可用不是靠这里的开关：五个写动作在分发补丁层里**不登记**，门禁返回
 * `denied`（`rule: 'unregistered-action'`），适配器一次都不调用（AC-17）。
 */
import { writeToolDefinitions } from './gitee-actions.mjs';
import { readToolDefinitions } from './gitee-read.mjs';

/** 只读工具（顺序即注册顺序）：仓库 / Issue / PR。 */
export const GITEE_READ_TOOLS = Object.freeze([
  'forge_gitee_repository_read',
  'forge_gitee_issue_read',
  'forge_gitee_pr_read',
]);

/**
 * 受控动作工具（顺序即注册顺序）：创建/评论、审查发布与记录、交付判定。
 * 它们全部经过门禁，默认因"动作未登记"被拒；`done` 还要求回读一致。
 */
export const GITEE_WRITE_TOOLS = Object.freeze([
  'forge_gitee_issue_write',
  'forge_gitee_pr_write',
  'forge_gitee_review_publish',
  'forge_gitee_review_record',
  'forge_gitee_delivery_gate',
]);

/** 模型可见工具面：8 个，顺序固定（AC-9/14）。 */
export const GITEE_TOOLS = Object.freeze([...GITEE_READ_TOOLS, ...GITEE_WRITE_TOOLS]);

/** 工具名必须落在 `forge_gitee_` 命名空间里（防止别处的工具混进这张表）。 */
export const GITEE_TOOL_PREFIX = 'forge_gitee_';

/** 泛化入口名单：出现即装配期失败，而不是等到模型去"随便跑个命令"。 */
export const GITEE_FORBIDDEN_TOOL_NAMES = Object.freeze([
  'forge_gitee_run',
  'forge_gitee_exec',
  'forge_gitee_execute',
  'forge_gitee_shell',
  'forge_gitee_command',
  'forge_gitee_api',
]);

/** 工具面自身的原因码（平台侧四状态/读信封的原因码由 gitee-read / gitee-actions 给出）。 */
export const TOOL_REASONS = Object.freeze({
  /** 子表工厂抛错：工具面无法组装（装配期可见，不静默装一半）。 */
  REGISTRY_UNAVAILABLE: 'TOOL_REGISTRY_UNAVAILABLE',
  /** 8 个里缺了若干：`detail.missing` 列全。 */
  REGISTRY_INCOMPLETE: 'TOOL_REGISTRY_INCOMPLETE',
  /** 多出未声明的工具：`detail.extra` 列全。 */
  REGISTRY_EXTRANEOUS: 'TOOL_REGISTRY_EXTRANEOUS',
  /** 同名工具出现两次（子表自身重复或读写表重叠）。 */
  REGISTRY_DUPLICATE: 'TOOL_REGISTRY_DUPLICATE',
  /** 定义形状不合法：无名字 / 无描述 / 无 object 参数表 / 没有执行体。 */
  DEFINITION_INVALID: 'TOOL_DEFINITION_INVALID',
  /** 名字越界：不在 `forge_gitee_` 命名空间，或命中泛化入口名单。 */
  NAME_FORBIDDEN: 'TOOL_NAME_FORBIDDEN',
});

/** 工具面装配错误：带可读原因码，装配期抛出（宿主记 `did not activate` 时能看出是哪一项）。 */
export class GiteeToolsError extends Error {
  constructor(reason, message, detail) {
    super(message);
    this.name = 'GiteeToolsError';
    this.code = reason;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

const EXECUTABLE_KEYS = Object.freeze(['execute', 'handler']);

function executableOf(definition) {
  for (const key of EXECUTABLE_KEYS) {
    if (typeof definition[key] === 'function') return definition[key];
  }
  return undefined;
}

function assertToolName(tool, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new GiteeToolsError(TOOL_REASONS.DEFINITION_INVALID, `${tool} 的定义缺少 name`);
  }
  if (GITEE_FORBIDDEN_TOOL_NAMES.includes(name)) {
    throw new GiteeToolsError(
      TOOL_REASONS.NAME_FORBIDDEN,
      `${tool} 的 ${name} 是泛化入口：gitee 只提供具名动作，不提供 run/exec/shell/api`,
      { name },
    );
  }
  if (!name.startsWith(GITEE_TOOL_PREFIX)) {
    throw new GiteeToolsError(
      TOOL_REASONS.NAME_FORBIDDEN,
      `${tool} 的 ${name} 必须落在 ${GITEE_TOOL_PREFIX}* 命名空间里`,
      { name },
    );
  }
}

function assertDefinition(tool, definition) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new GiteeToolsError(TOOL_REASONS.DEFINITION_INVALID, `${tool} 返回的工具定义必须是对象`);
  }
  assertToolName(tool, definition.name);
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    throw new GiteeToolsError(TOOL_REASONS.DEFINITION_INVALID, `${definition.name} 缺少描述（模型看不到就不该存在）`, {
      name: definition.name,
    });
  }
  if (definition.parameters === null || typeof definition.parameters !== 'object'
    || definition.parameters.type !== 'object') {
    throw new GiteeToolsError(
      TOOL_REASONS.DEFINITION_INVALID,
      `${definition.name} 必须声明 object 形状的参数表（宿主按它暴露 schema）`,
      { name: definition.name },
    );
  }
  if (executableOf(definition) === undefined) {
    throw new GiteeToolsError(
      TOOL_REASONS.DEFINITION_INVALID,
      `${definition.name} 没有执行体（execute/handler），注册上去只会让模型拿到一个哑工具`,
      { name: definition.name },
    );
  }
}

function collect(factory, service, tool) {
  let definitions;
  try {
    definitions = factory(service);
  } catch (error) {
    throw new GiteeToolsError(
      TOOL_REASONS.REGISTRY_UNAVAILABLE,
      `${tool} 工具定义无法组装：${error?.message ?? error}`,
      { error },
    );
  }
  if (!Array.isArray(definitions)) {
    throw new GiteeToolsError(TOOL_REASONS.REGISTRY_UNAVAILABLE, `${tool} 工具定义必须是数组`);
  }
  return definitions;
}

/**
 * 组装固定 8 个工具定义：先取两份子表，再按 `GITEE_TOOLS` 归一顺序。
 *
 * `service` 是插件装配层提供的端口（`apply()` 里构造），本模块不解释它的成员——
 * 工具定义怎么用它是 gitee-read / gitee-actions 的事。任何形状问题都在这里抛
 * `GiteeToolsError`，让宿主在挂载时看到具体缺哪一项，而不是静默少注册几个工具。
 *
 * @param {object} service 装配层端口
 * @returns {object[]} 8 个 `ToolDefinition`，顺序同 `GITEE_TOOLS`
 */
export function buildGiteeTools(service) {
  const collected = [
    ...collect(readToolDefinitions, service, '只读'),
    ...collect(writeToolDefinitions, service, '受控动作'),
  ];

  const byName = new Map();
  for (const definition of collected) {
    assertDefinition('gitee', definition);
    if (byName.has(definition.name)) {
      throw new GiteeToolsError(
        TOOL_REASONS.REGISTRY_DUPLICATE,
        `工具 ${definition.name} 被注册了两次：读写表重叠或子表内部重复`,
        { name: definition.name },
      );
    }
    byName.set(definition.name, definition);
  }

  const missing = GITEE_TOOLS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new GiteeToolsError(
      TOOL_REASONS.REGISTRY_INCOMPLETE,
      `工具面缺项：${missing.join(', ')}（固定 8 个，少一个都不算装上）`,
      { missing },
    );
  }

  const declared = new Set(GITEE_TOOLS);
  const extra = [...byName.keys()].filter((name) => !declared.has(name));
  if (extra.length > 0) {
    throw new GiteeToolsError(
      TOOL_REASONS.REGISTRY_EXTRANEOUS,
      `工具面多出未声明的工具：${extra.join(', ')}（新增工具必须先进 GITEE_TOOLS 与设计文档）`,
      { extra },
    );
  }

  return GITEE_TOOLS.map((name) => byName.get(name));
}
