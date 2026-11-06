/**
 * 宿主探针版本门控（纯函数）。
 *
 * 背景：`tests/host-probe.test.mjs` 的两例探针只在目标宿主（`.dsh-version`）上
 * 才有判定意义。宿主版本不对时，失败反映的是宿主差异（K-1），不是被交付的补丁；
 * 继续让整棵 `node --test` 变红会掩盖真实回归（PRD AC-13）。
 *
 * 判定只决定“是否运行”，不改变任何断言内容：
 * - `dsh` 不可执行 → skip（含实际错误与目标版本）；
 * - `DSH_HOST_PROBE_FORCE=1` → 强制运行（用于追踪 K-1，预期失败）；
 * - `actual` 归一后为空或与 `target` 不等 → skip（含实际/目标版本与 K-1 原因）；
 * - 相等 → 运行。
 */

/**
 * 从 `dsh --version` 的输出中取出版本号形态（`X.Y.Z` 或 `X.Y.Z-pre`）。
 * 无法解析时返回空串，调用方据此按“版本不匹配”处理。
 */
export function normalizeDshVersion(raw) {
  if (typeof raw !== 'string') return '';
  const match = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/);
  return match === null ? '' : match[0];
}

/**
 * 计算宿主探针的跳过判定。
 * @param {{actual?: string, target?: string, force?: boolean, error?: Error|string|null}} input
 * @returns {{skip: boolean, reason: string}}
 */
export function hostProbeGate({ actual, target, force, error } = {}) {
  const targetVersion = normalizeDshVersion(target);

  if (error !== undefined && error !== null) {
    const message = String(error?.message ?? error);
    return {
      skip: true,
      reason: `目标 DSH 不在本机 PATH（${message}）；宿主探针只在装有目标版本 ${targetVersion || '未知'} 的环境运行（K-1，PRD AC-13）`,
    };
  }

  if (force === true) {
    return { skip: false, reason: 'DSH_HOST_PROBE_FORCE=1：强制在非目标宿主运行（预期失败，用于追踪 K-1）' };
  }

  const actualVersion = normalizeDshVersion(actual);
  if (actualVersion === '' || actualVersion !== targetVersion) {
    const actualText = actualVersion || String(actual ?? '').trim() || '未知';
    return {
      skip: true,
      reason: `宿主版本不匹配（K-1，PRD AC-13）：实际 ${actualText}，目标 ${targetVersion || '未知'}（.dsh-version）；本机不是目标宿主，跳过这两例环境用例，设 DSH_HOST_PROBE_FORCE=1 可强制复跑`,
    };
  }

  return { skip: false, reason: '' };
}
