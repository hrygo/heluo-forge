/**
 * `@heluo/forge-enterprise`：企业组合入口的装配能力。
 *
 * 本包只做装配：官方行默认禁用见 `cordis.patch.yml`，按需企业 Skill 与规范条款的
 * 选择/注册见 `skills.mjs`；不重复实现成员包逻辑，不承载业务接口。
 */
export {
  EnterpriseSkillError,
  loadClausePack,
  preActionConstraints,
  registerEnterpriseSkills,
  selectClauses,
} from './skills.mjs';
