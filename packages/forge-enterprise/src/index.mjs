/**
 * `@heluo/forge-enterprise`：企业账号与模型通用底座组合入口。
 *
 * 本包只包含通用底座装配与官方行回灌检测（`reflow.mjs`）；不承载研发域能力、
 * 研发 UI 或研发 Skill。
 */
export {
  detectOfficialRowReflow,
  EnterpriseReflowError,
  OFFICIAL_ROWS,
  rowsFromDump,
} from './reflow.mjs';

export const name = 'forge-enterprise';

export function apply() {}
