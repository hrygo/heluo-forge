/**
 * 模型可见工具面（设计 §5.3；形态沿用 forge-devops 先例）。
 *
 * 刻意设计点：
 * 1. **写工具参数名用 `target`**：forge-policy 门禁只读 `exec.arguments.target`，
 *    `skill-nacos.*` 动作登记进受控目录后，未批准的写调用在门禁处拒绝且执行体零调用。
 * 2. **只读工具不经受控目录**：search/show 走只读语义，有界返回，不产生安装副作用。
 * 3. **拒绝必须可见**：错误统一带 `reason` 与 `next_action`，不让调用方猜。
 */
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 工具名 → 动作（唯一真源，测试逐条核对）。 */
export const WRITE_TOOLS = Object.freeze({
  skill_nacos_install: 'skill-nacos.install',
  skill_nacos_enable: 'skill-nacos.enable',
  skill_nacos_disable: 'skill-nacos.disable',
  skill_nacos_upgrade: 'skill-nacos.upgrade',
  skill_nacos_scope: 'skill-nacos.scope-change',
  skill_nacos_uninstall: 'skill-nacos.uninstall',
});

export const READ_TOOLS = Object.freeze(['skill_nacos_search', 'skill_nacos_show']);

const NEXT_ACTION = Object.freeze({
  SN_AUTH_MISSING: 'configure-credential',
  SN_FORBIDDEN: 'configure-credential',
  SN_NOT_FOUND: 'pick-another-version',
  SN_NAME_CONFLICT: 'rename-or-remove-local-skill',
  SN_VERSION_MISMATCH: 'use-explicit-upgrade',
  SN_NO_PROJECT_ROOT: 'retry-inside-project',
  SN_QUOTA_EXCEEDED: 'uninstall-unused-skills',
  SN_LOCK_TIMEOUT: 'retry-later',
  SN_NOT_INSTALLED: 'install-first',
});

function fail(action, error) {
  const reason = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  return json({
    ok: false,
    action,
    reason,
    next_action: NEXT_ACTION[reason] ?? 'report-to-admin',
    detail: String(error?.message ?? error),
  });
}

/** `target` 解析：`name` 或 `name@version`；label 形态 `name@stable` 交给服务端解析后固定。 */
function parseTarget(target) {
  const value = typeof target === 'string' ? target.trim() : '';
  if (value.length === 0) return undefined;
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return { name: value, ref: undefined };
  return { name: value.slice(0, separator), ref: { version: value.slice(separator + 1) } };
}

/**
 * @param {object} service Host 服务（createSkillNacosService 产物）
 * @returns 工具定义数组（注册顺序与 READ_TOOLS/WRITE_TOOLS 一致）
 */
export function buildSkillNacosTools(service) {
  return [
    {
      name: 'skill_nacos_search',
      description: 'Search the enterprise Nacos skill catalog (read-only, bounded). Install/upgrade are separate gated tools.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Optional keyword matched against skill name/description' },
          page: { type: 'integer', description: '1-based page number', minimum: 1 },
          pageSize: { type: 'integer', description: 'Items per page (max 20)', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
      async execute(args) {
        try {
          return json({ ok: true, result: await service.searchCatalog({
            keyword: args?.keyword,
            page: Number.isInteger(args?.page) ? args.page : 1,
            pageSize: Number.isInteger(args?.pageSize) ? Math.min(args.pageSize, 20) : 20,
          }) });
        } catch (error) {
          return fail('catalog.search', error);
        }
      },
    },
    {
      name: 'skill_nacos_show',
      description: 'Show one enterprise skill: description, available precise versions with status, and local install state.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Skill name, for example code-review-std' } },
        required: ['target'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
      async execute(args) {
        try {
          return json({ ok: true, result: await service.showSkill(String(args?.target ?? '')) });
        } catch (error) {
          return fail('catalog.show', error);
        }
      },
    },
    writeTool({
      name: 'skill_nacos_install',
      action: WRITE_TOOLS.skill_nacos_install,
      description: 'Install one enterprise skill at a precise version (or a label, resolved and pinned server-side). Requires policy approval.',
      targetHint: 'Skill reference: name@version (for example code-review-std@1.5.0) or just name for the latest online version',
      extraParameters: {
        scope: { type: 'string', enum: ['user', 'project'], description: 'Install scope (default user)' },
        enable: { type: 'boolean', description: 'Enable immediately after install (default true)' },
      },
      invoke: (parsed, args) => service.install({
        name: parsed.name,
        ref: parsed.ref,
        scope: args?.scope === 'project' ? 'project' : 'user',
        enable: args?.enable !== false,
      }),
    }),
    writeTool({
      name: 'skill_nacos_enable',
      action: WRITE_TOOLS.skill_nacos_enable,
      description: 'Enable an installed enterprise skill (it then appears in session skill catalogs).',
      targetHint: 'Skill name',
      invoke: (parsed) => service.enable(parsed.name),
    }),
    writeTool({
      name: 'skill_nacos_disable',
      action: WRITE_TOOLS.skill_nacos_disable,
      description: 'Disable an installed enterprise skill (retires it from new session catalogs; local files are kept).',
      targetHint: 'Skill name',
      invoke: (parsed) => service.disable(parsed.name),
    }),
    writeTool({
      name: 'skill_nacos_upgrade',
      action: WRITE_TOOLS.skill_nacos_upgrade,
      description: 'Explicitly upgrade an installed skill to a precise version; the previous version directory is kept.',
      targetHint: 'Skill reference: name@version',
      invoke: (parsed) => service.upgrade({ name: parsed.name, ref: parsed.ref }),
    }),
    writeTool({
      name: 'skill_nacos_scope',
      action: WRITE_TOOLS.skill_nacos_scope,
      description: 'Change an installed skill scope between user (all workspaces) and project (current project only).',
      targetHint: 'Skill name',
      extraParameters: {
        to: { type: 'string', enum: ['user', 'project'], description: 'Target scope' },
      },
      invoke: (parsed, args) => service.changeScope({ name: parsed.name, to: args?.to === 'project' ? 'project' : 'user' }),
    }),
    writeTool({
      name: 'skill_nacos_uninstall',
      action: WRITE_TOOLS.skill_nacos_uninstall,
      description: 'Uninstall an installed skill into the local trash (files kept for restore; not erased from session history).',
      targetHint: 'Skill name',
      invoke: (parsed) => service.uninstall(parsed.name),
    }),
  ];
}

function writeTool({ name, action, description, targetHint, extraParameters, invoke }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: targetHint },
        ...(extraParameters ?? {}),
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      const parsed = parseTarget(args?.target);
      if (parsed === undefined) {
        return json({ ok: false, action, reason: 'MISSING_TARGET', next_action: 'give-a-target', detail: 'target 不能为空' });
      }
      try {
        return json({ ok: true, action, result: await invoke(parsed, args) });
      } catch (error) {
        return fail(action, error);
      }
    },
  };
}
