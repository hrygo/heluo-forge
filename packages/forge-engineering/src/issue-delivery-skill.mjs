/**
 * 正式企业研发 Skill 的 Host 注册入口（r12 §4.1）。
 *
 * 只做一件事：把随包分发的 `skills/clauses.json` 与 `skills/issue-delivery/**` 通过宿主的
 * Skill 服务注册成**用户显式触发**的只读入口，并在 Context 销毁时撤销注册。
 *
 * 三条边界：
 * 1. **不伪装成业务服务**。本模块不导出工具、不启动 run、不调用任何企业 API；它只是把
 *    Skill 资源挂到宿主发现面上。真正执行仍归原生 Teamflow 与企业插件。
 * 2. **资源根在包内**。`resourceBase` 指向本包的 `skills/` 实体目录，安装后仍可读；不读个人
 *    Skill 目录，也不要求安装者手抄提示词。
 * 3. **缺依赖不静默**。`inject: ['skills']` 让 Loader 在没有 Skill 服务时不激活该条注册；
 *    资源缺失或越界时由 `assembleEnterpriseSkills` 抛 `EnterpriseSkillError`，让"没装上"可见。
 */
import { fileURLToPath } from 'node:url';

import { assembleEnterpriseSkills } from './skills.mjs';

/** 插件标识：与补丁层 `id: heluo-issue-delivery-skill` 同能力、不同命名空间。 */
export const name = 'enterprise-issue-delivery';

/** 没有 Skill 服务时不激活该行（Loaderen 语义：inject 不满足即不加载）。 */
export const inject = Object.freeze(['skills']);

/** Skill 名 = `enterprise-issue-delivery`（与条款 id `issue-delivery` 组合）。 */
export const SKILL_PREFIX = 'enterprise';

/** 包内实体资源根：`packages/forge-engineering/skills/`（打包后仍在同一相对位置）。 */
export const RESOURCE_BASE = fileURLToPath(new URL('../skills/', import.meta.url));

/** 入口的可见策略：模型不得自行进入企业交付流程，只能由用户显式触发。 */
export const INVOCATION = Object.freeze({ modelInvocable: false, userInvocable: true });

/**
 * 本流程依赖的系统名（与 `skills/clauses.json` 的 `appliesTo.system` 一一对应）。
 *
 * 必须显式给出：`selectClauses` 只有在"调用方声明的系统"命中 `appliesTo` 时才选中条款，
 * 不传就等于宣布"当前任务不涉及这些系统"，条款会被判 `not-applicable` 而静默消失。
 * 这些名字同时是**依赖声明**（见 SKILL.md 依赖表），不是权限。
 */
export const SYSTEMS = Object.freeze(['teamflow', 'gitee', 'devops']);

/**
 * 每个 Context 上已装配的入口：`prefix → teardown`。
 *
 * 幂等不是优化而是可用性底线：Loader 重放同一行（或同一 profile 里两处指向本入口）时，
 * 宿主 `registerProvider` 会因重名抛 `a skill provider named "enterprise-clauses" is
 * already registered`，一条可选入口就把整个启动弄崩。同一 Context + 同一 prefix 只装配
 * 一次，重复 `apply` 返回同一个 teardown；Context 销毁后 Map 随之释放（WeakMap 键）。
 */
const ASSEMBLED = new WeakMap();

function teardownsOf(ctx) {
  let byPrefix = ASSEMBLED.get(ctx);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    ASSEMBLED.set(ctx, byPrefix);
  }
  return byPrefix;
}

/**
 * 挂载正式企业研发 Skill。
 *
 * @param {{skills?: object, effect?: Function}} ctx 宿主上下文（cordis）
 * @returns {(() => void) | undefined} 卸载函数（同时登记在 `ctx.effect` 上）
 */
export function apply(ctx) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  const skills = ctx.skills;
  const canRegister = skills !== undefined
    && (typeof skills.registerProvider === 'function' || typeof skills.register === 'function');
  if (!canRegister) {
    // inject 已经保证了这一点；这里是纵深防御：没有 Skill 服务就什么也不注册，也不抛异常
    // 让整条企业组合因为一个可选入口而失败。
    return undefined;
  }

  const assembled = teardownsOf(ctx);
  const existing = assembled.get(SKILL_PREFIX);
  if (existing !== undefined) return existing;

  const assembly = assembleEnterpriseSkills(ctx, {
    root: RESOURCE_BASE,
    systems: SYSTEMS.map((system) => ({ name: system })),
    namePrefix: SKILL_PREFIX,
    invocation: INVOCATION,
  });

  let disposed = false;
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    assembled.delete(SKILL_PREFIX);
    assembly.dispose?.();
  };
  assembled.set(SKILL_PREFIX, teardown);
  if (typeof ctx.effect === 'function') ctx.effect(() => teardown);
  return teardown;
}

export default Object.freeze({ name, inject, apply, SKILL_PREFIX, RESOURCE_BASE, INVOCATION });
