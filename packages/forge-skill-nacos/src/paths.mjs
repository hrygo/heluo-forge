/**
 * 受管目录布局（设计 §6）：全部位于 `$DSH_HOME/skill-nacos` 之下，
 * 被 forge-policy `protectedPaths`（默认 `$DSH_HOME/**`）硬拒绝覆盖。
 *
 * 受管目录刻意不落在 skill-filesystem 的任何扫描面
 * （`$DSH_HOME/skills`、`~/.agents/skills`、项目 `.dsh/.agents`、customSkillDirs），
 * 避免同一技能被两个 provider 双重发现。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 宿主契约：`$DSH_HOME` 缺席时回落宿主默认 `~/.dsh`（同 forge-policy 实测口径）。 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? resolve(env.DSH_HOME) : join(homedir(), '.dsh');
}

/**
 * @param {string} dshHome `$DSH_HOME` 绝对路径
 * @returns 受管目录布局（不创建目录）
 */
export function layout(dshHome) {
  const root = join(dshHome, 'skill-nacos');
  return Object.freeze({
    root,
    statePath: join(root, 'state.json'),
    lockPath: join(root, '.lock'),
    storeDir: join(root, 'store'),
    stagingDir: join(root, 'staging'),
    skillDir: (name, version) => join(root, 'store', name, version),
  });
}

/** 建齐受管目录（幂等）。 */
export function ensureLayout(dirs) {
  for (const dir of [dirs.root, dirs.storeDir, dirs.stagingDir]) mkdirSync(dir, { recursive: true });
}

/**
 * 从 cwd 向上找项目根（含 `.git` 的目录）；找不到返回 undefined。
 * 口径与 DSH skill-filesystem 的项目根判定一致（设计 §7.3）。
 */
export function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `cwd` 是否位于 `root` 项目之内（含 root 自身）。 */
export function isInsideProject(cwd, root) {
  if (typeof cwd !== 'string' || typeof root !== 'string') return false;
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(root);
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(resolvedRoot + '/');
}

/** 受管 store 当前占用字节数（目录不存在按 0）。 */
export function directorySize(path) {
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry);
    let info;
    try {
      info = statSync(child);
    } catch {
      continue;
    }
    total += info.isDirectory() ? directorySize(child) : info.size;
  }
  return total;
}
