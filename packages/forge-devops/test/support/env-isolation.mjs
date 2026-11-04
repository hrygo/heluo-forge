/**
 * 用例隔离：发现层（`cli-discovery`）会扫 `PATH` 与候选目录，开发者本机装了 dop 时，"未配置 → no-reader"
 * 这类断言会被真实环境打红（2026-11-04 实测：本机 `/opt/homebrew/bin/dop` 一装上，两个既有用例立刻变红）。
 *
 * 用例只关心"配置 / 环境变量 / 自动发现都没有"这一种输入，所以临时把 `PATH` 与 dopBin 环境变量清空，
 * 结束时原样恢复——不给生产代码加测试专用开关，也不让本地通过依赖机器上装没装 dop。
 *
 * 边界：只隔离 `PATH` 与 `FORGE_DEVOPS_DOP_BIN`；候选目录（`/usr/local/bin`、`/opt/<tool>/bin`）未隔离，
 * 因为那两个是发现层的固定落点，要造出"目录里真有 dop"的场景应由发现层自己的用例显式注入。
 */
export async function withoutDiscoveredCli(fn) {
  const saved = { PATH: process.env.PATH, FORGE_DEVOPS_DOP_BIN: process.env.FORGE_DEVOPS_DOP_BIN };
  process.env.PATH = '';
  delete process.env.FORGE_DEVOPS_DOP_BIN;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
