#!/usr/bin/env node
// `pnpm uninstall:devops` 的薄入口（同 check-docs / check-repo 的惯例）：
// 解析参数、打印、置 exitCode；编排逻辑在 scripts/lib/uninstall-devops.mjs，
// 便于 `node --test` 直接 import main() 离线验证（不 spawn、不碰真实 profile）。
//
// 归属：docs/teamflow/20261102-r9-runner-refresh-uninstall/TECHNICAL.md §5.3。

import { pathToFileURL } from 'node:url';

import { runUninstall } from './lib/uninstall-devops.mjs';

const USAGE = [
  '用法：node scripts/uninstall-devops.mjs [--profile <名>] [--keep-plugin]',
  '',
  '清理本插件写进 profile 补丁层（cordis.patch.yml）的条目，然后移除插件。',
  '上游 `dsh plugin remove` 不清理 profile 补丁层：残留的 `- id: forge-devops` 会让宿主',
  '在每次冷启动打印「entry not found」，所以卸载走这条命令。',
  '',
  '选项：',
  '  --profile <名>   目标 profile。省略时依次取 DSH_PROFILE、DSH_PROFILE_DIR，',
  '                   再取 $DSH_HOME/profiles 下唯一的 profile；都不成立就报错（不猜）',
  '  --keep-plugin    只清理补丁层，不调用 dsh（打印下一步命令）',
  '',
  '退出码：0 = 已清理或本无残留；1 = profile 无法确定 / 补丁层不存在 / 写入失败',
].join('\n');

/**
 * 命令入口：把编排结果写进 stdout / stderr 并给出退出码。
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @param {NodeJS.ProcessEnv} env 注入的环境（测试用临时 DSH_HOME）
 * @returns {Promise<number>} 0 或 1
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const { code, lines, warnings } = await runUninstall({ argv, env });
  for (const line of lines) console.log(line);
  for (const warning of warnings) console.error(warning);
  return code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
