// 卸载编排（20261102-r9 / M3）：**先清补丁条目、再移除插件**。
//
// 为什么需要这一步：profile 补丁层是 dsh-config-editor 的写入目标，配置页保存过的
// `- id: forge-devops` 条目留在 `<profile>/cordis.patch.yml` 里；上游 `dsh plugin remove`
// 只移除依赖并重载，不清理补丁层，于是每次冷启动宿主都为这条悬空条目打印
// 「entry not found」。清理必须由本仓库自己做（AC-11/AC-13）。
//
// 分工：改文件交给 patch-layer-blocks.mjs 的块模型（逐字保留其它行），这里只负责
// 「定位 profile → 清理 → 回显 → 移除插件或打印下一步」。runner 可注入，幂等与失败面
// 都能离线验证，不必真跑 dsh（AC-11）。
//
// 归属：docs/teamflow/20261102-r9-runner-refresh-uninstall/TECHNICAL.md §5.3-§5.4。

import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  PATCH_LAYER_FILE,
  UninstallError,
  findResidualEntries,
  patchLayerExists,
  patchLayerOf,
  removeEntryBlock,
  resolveProfile,
} from './patch-layer-blocks.mjs';

/** 本插件的包名；与清单 `name`、补丁层 `name` 同源。 */
export const PLUGIN_NAME = '@heluo/forge-devops';

/**
 * 补丁层里可能代表「本插件」的条目身份（精确相等，AC-15：禁止前缀/正则模糊匹配）。
 * 配置页写 `id: forge-devops`；手写成包根名时是 `@heluo/forge-devops`。
 */
export const ENTRY_IDS = Object.freeze(['forge-devops', PLUGIN_NAME]);

/** 移除插件用的固定 argv；超时给足 pnpm 安装依赖的时间。 */
export const REMOVE_TIMEOUT_MS = 120_000;

const USAGE_FLAGS = new Set(['--keep-plugin', '--help', '-h']);

function isExecutableFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    return process.platform === 'win32' ? true : (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 里找可用的 CLI。
 *
 * Windows 只认 `.exe`：npm 生成的 `dsh.cmd` / `.ps1` / `.bat` 用 `execFile`（`shell:false`）
 * 起不来，按「未探测到 dsh CLI」处理，只清理并打印下一步——不为了跑通去引入 shell。
 */
function locateOnPath(bin, env) {
  const value = env.PATH ?? env.Path ?? env.path ?? '';
  if (typeof value !== 'string' || value.length === 0) return null;
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of value.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${bin}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 默认 runner：探测 + `execFile`（`shell:false`、固定 argv、超时）。 */
function defaultRunner(env) {
  return {
    has: (bin) => locateOnPath(bin, env) !== null,
    execFile: (bin, args, options) =>
      new Promise((settle) => {
        execFile(bin, args, { ...options, shell: false }, (error, stdout, stderr) => {
          settle({
            code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          });
        });
      }),
  };
}

/** 参数：还有哪些开关（`--profile` 由 resolveProfile 解析，这里只校验并取出布尔位）。 */
export function parseArgs(argv) {
  const options = { keepPlugin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('-')) {
        throw new UninstallError('uninstall: --profile 需要一个 profile 名', 'BAD_ARGUMENT');
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) continue;
    if (arg === '--keep-plugin') {
      options.keepPlugin = true;
      continue;
    }
    if (USAGE_FLAGS.has(arg)) continue;
    throw new UninstallError(`uninstall: 未知参数「${arg}」（可用：--profile <名>、--keep-plugin）`, 'BAD_ARGUMENT');
  }
  return options;
}

function describeRemoved(entry) {
  const hasId = entry.id !== undefined;
  const hasName = entry.name !== undefined;
  const identity = hasId
    ? (hasName ? `id=${entry.id}（name=${entry.name}）` : `id=${entry.id}`)
    : `name=${entry.name}`;
  // 只有 id 或只有 name 时补一个空格，避免出现「…forge-devops行 8-11」这种糊在一起的回显。
  const gap = hasId && hasName ? '' : ' ';
  return `已删除条目：${identity}${gap}行 ${entry.start + 1}-${entry.end}（共 ${entry.count} 行）`;
}

function nextStepLine(profileName) {
  return `下一步：dsh plugin --profile ${profileName} remove ${PLUGIN_NAME}`;
}

/**
 * 执行一次卸载。
 *
 * 返回 `{ code, lines, warnings }`：`lines` 是要打到 stdout 的逐行回显（AC-14：只有 profile 名、
 * 条目身份、行区间与行数，零绝对路径），`warnings` 是 stderr 的补充说明（失败原因、手工重跑提示）。
 * `code` 0 = 已清理或本无残留；1 = profile 无法确定 / 补丁层不存在 / 写入失败。
 */
export async function runUninstall({ argv = [], env = process.env, runner = null, now = Date.now } = {}) {
  const lines = [];
  const warnings = [];
  try {
    // 注入时钟 `now`：回显里不含时间戳，保留该参数是为与仓库内其它可注入时钟的编排同形。
    const options = parseArgs(argv);
    const profile = resolveProfile({ argv, env });
    if (!patchLayerExists(profile)) {
      throw new UninstallError(`uninstall: 找不到 ${profile.name} 的 ${PATCH_LAYER_FILE}`, 'PATCH_LAYER_MISSING');
    }
    const patchPath = patchLayerOf(profile);
    const before = readFileSync(patchPath, 'utf8');
    const { text, removed, before: beforeLines, after: afterLines } = removeEntryBlock(before, { ids: ENTRY_IDS });

    // 只在命中时写盘：未命中不碰文件（mtime 不变，幂等，AC-11）。
    if (removed.length > 0) {
      try {
        writeFileSync(patchPath, text, 'utf8');
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
        throw new UninstallError(`uninstall: 写入 ${PATCH_LAYER_FILE} 失败（${code}），请检查文件权限后重跑`, 'PATCH_LAYER_WRITE_FAILED');
      }
    }

    lines.push(`profile：${profile.name}`);
    lines.push(`补丁层：${PATCH_LAYER_FILE}`);
    if (removed.length > 0) {
      for (const entry of removed) lines.push(describeRemoved(entry));
      lines.push(`行数：${beforeLines} → ${afterLines}`);
    } else {
      const residual = findResidualEntries(text, { ids: ENTRY_IDS });
      if (residual.length > 0) {
        const where = residual.map((entry) => `id=${entry.id ?? entry.name} 行 ${entry.line}`).join('、');
        lines.push(`残留：${where}（位于嵌套 insert 块，块模型不删深层条目，需手工删除后再确认）`);
      } else {
        lines.push('无残留（补丁层已是清理后的状态）');
      }
    }

    if (options.keepPlugin) {
      lines.push('插件：未移除（--keep-plugin）');
      lines.push(nextStepLine(profile.name));
      return { code: 0, lines, warnings };
    }

    const cli = runner ?? defaultRunner(env);
    if (typeof cli?.has !== 'function' || cli.has('dsh') !== true) {
      lines.push('插件：未移除（未探测到 dsh CLI）');
      lines.push(nextStepLine(profile.name));
      return { code: 0, lines, warnings };
    }

    const result = await cli.execFile(
      'dsh',
      ['plugin', '--profile', profile.name, 'remove', PLUGIN_NAME],
      { timeout: REMOVE_TIMEOUT_MS, shell: false },
    );
    const code = typeof result?.code === 'number' ? result.code : 1;
    if (code === 0) {
      lines.push('插件：已移除');
      return { code: 0, lines, warnings };
    }
    lines.push(`插件：未移除（dsh 退出码 ${code}）`);
    lines.push(nextStepLine(profile.name));
    warnings.push(`uninstall: 插件移除未成功（dsh 退出码 ${code}）；补丁层已清理，可重跑上一步或手工执行上一步命令`);
    return { code: 0, lines, warnings };
  } catch (error) {
    if (error instanceof UninstallError) {
      warnings.push(error.message);
      return { code: 1, lines: [], warnings };
    }
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    warnings.push(`uninstall: 读取或写入 ${PATCH_LAYER_FILE} 时失败（${code}）`);
    return { code: 1, lines: [], warnings };
  }
}
