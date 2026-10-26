/**
 * `@heluo/forge-enterprise`：企业组合入口的装配能力。
 *
 * 本包只做装配：官方行默认禁用见 `cordis.patch.yml`，按需企业 Skill 与规范条款的
 * 选择/注册见 `skills.mjs`，五类开关的声明与判定见 `switches.mjs`，官方行回灌检测见 `reflow.mjs`；
 * 不重复实现成员包逻辑，不承载业务接口。
 */
export {
  detectOfficialRowReflow,
  EnterpriseReflowError,
  OFFICIAL_ROWS,
  rowsFromDump,
} from './reflow.mjs';

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
  selectClauses,
} from './skills.mjs';
