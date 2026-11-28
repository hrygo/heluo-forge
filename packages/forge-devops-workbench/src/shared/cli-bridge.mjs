/**
 * 同仓既有 CLI 能力衔接桥（@heluo/forge-devops 与 @heluo/forge-gitee）。
 *
 * 严格约束：
 *   1. 只探测同进程公开注册的服务对象（ctx.get('devops') / ctx.get('gitee')），
 *      严禁深导入其他包内的 src/*.mjs；
 *   2. 一期只提供只读工具提示与变更上下文串联信息，不触发写回动作。
 */

export function createCliBridge({ getDevopsService, getGiteeService } = {}) {
  function getCapabilities() {
    const devops = typeof getDevopsService === 'function' ? getDevopsService() : null;
    const gitee = typeof getGiteeService === 'function' ? getGiteeService() : null;
    return Object.freeze({
      devopsAvailable: Boolean(devops),
      giteeAvailable: Boolean(gitee),
    });
  }

  /**
   * 构造故事关联系统变更单与代码评审的只读 CLI 工具提示（用于提示词串联）。
   *
   * @param {string[]} changeNos
   */
  function readChangeContextHint(changeNos = []) {
    const caps = getCapabilities();
    const list = Array.isArray(changeNos)
      ? changeNos.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [];

    const suggestions = [];
    if (list.length > 0) {
      suggestions.push(
        caps.devopsAvailable
          ? `可调用 forge_devops_change_context 查询变更单 ${list.join(', ')} 的子系统详情与验收要求`
          : `可在主对话按需使用 dop（forge_devops_change_context）补全变更单 ${list.join(', ')} 上下文（当前 @heluo/forge-devops 服务未挂载）`,
      );
    }
    if (caps.giteeAvailable) {
      suggestions.push('可配合 forge_gitee_repository_read / forge_gitee_pr_read 只读核查代码库与评审状态');
    }

    return Object.freeze({
      capabilities: caps,
      changeNos: list,
      suggestions,
    });
  }

  return Object.freeze({
    getCapabilities,
    readChangeContextHint,
  });
}
