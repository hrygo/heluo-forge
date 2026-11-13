/**
 * `@heluo/forge-engineering`：企业研发工具套件组合入口。
 *
 * 本包作为独立的研发域预装包，集成「企业研发工具」设置容器、Issue 交付 Skill、
 * 五类研发能力开关判定，以及 DevOps（DOP）与 Gitee 工作流扩展；不包含企业账号或通用模型底座。
 */
export {
  EnterpriseSwitchError,
  ROLE_PRESETS,
  SWITCH_IDS,
  SWITCH_REASONS,
  describeSwitchInput,
  resolveSwitches,
} from './switches.mjs';

export {
  assembleEnterpriseSkills,
  EnterpriseSkillError,
  loadClausePack,
  preActionConstraints,
  registerEnterpriseSkills,
  registerEnterpriseSkillsViaProvider,
  selectClauses,
} from './skills.mjs';

export const name = 'forge-engineering';

/**
 * 纯容器插件的最小宿主入口（CORP-DSH-DESIGN-018 §3 / CORP-DSH-DESIGN-019）：
 * 服务端无状态、不持有凭据；工作台容器完全由 `./client.js` 承载。
 */
export function apply() {}
