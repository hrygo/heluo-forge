/**
 * 目录轮询调度（#97 设计 §7.1）：有界刷新、失败退避加抖动，刷新零安装副作用。
 * 从装配点抽出的轴模块——ENG-003 P2：装配点不持有状态、不推进状态机，
 * 定时与退避的所有权归属本模块（结构守卫见 test/assembly-structure.test.mjs）。
 */

/**
 * @param {{refresh: () => Promise<{ok: boolean}>, intervalMs: number,
 *          pollMaxBackoffMs?: number, pollJitterMs?: number}} options
 * @returns {{stop: () => void}}
 */
export function createCatalogPoller({ refresh, intervalMs, pollMaxBackoffMs = 60000, pollJitterMs = 5000 }) {
  let stopped = false;
  let timer;
  let backoffMs = 0;
  const schedule = (delay) => {
    if (stopped || intervalMs <= 0) return;
    timer = setTimeout(async () => {
      const result = await refresh();
      backoffMs = result.ok ? 0 : Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, pollMaxBackoffMs);
      const jitter = Math.floor(Math.random() * pollJitterMs);
      schedule(intervalMs + backoffMs + jitter);
    }, delay);
  };
  schedule(intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
