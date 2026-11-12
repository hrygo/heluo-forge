/**
 * 只读代码版本快照（r12 §6.1）：把"这次交付到底验的是哪一份代码"变成可复核的值。
 *
 * 三条边界：
 * 1. **只用既有执行出口**。本模块不 import `node:child_process`、不建子进程，只拿
 *    `runner.runGit({args, purpose, cwd})`（唯一出口在 `gitee-cli.mjs`：固定 argv、
 *    `shell:false`、env allowlist、超时与 1MiB 截断）。argv 全部写死在这里，不接受模型传入
 *    cwd / bin / argv，也不开放 `write-tree`、外部 diff、textconv 或任何写命令。
 * 2. **HEAD 不等于被检代码**。`head()` / `branch()` 只能说明分支指向哪个提交；暂存、未暂存、
 *    删除、重命名与未跟踪文件都不在里面。所以版本由 `contentId` 表达：对 HEAD、树、
 *    index 项（模式 + blob）、工作树内容摘要与未跟踪集合做规范排序后取 SHA-256。内容只在
 *    内存里散列，不回显、不落盘、不进证据。
 * 3. **不确定就说不确定**。截断、超时、未支持形态（gitlink、越界软链、路径逃逸）或前后两次
 *    采样不一致，一律返回 `unknown`/`failed`，不截掉余项后凑一个"有效版本"。两次一致也不是
 *    OS 原子快照保证，只是"收口时没有观测到写入者"的弱证据。
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** 工具名的唯一枚举（`gitee-tools` 从这里 re-export，避免两套清单）。 */
export const GITEE_SNAPSHOT_TOOLS = Object.freeze(['forge_gitee_delivery_snapshot']);

/** 快照原因码：失败时只给结论与下一步，不回显路径、stderr 原文或环境变量。 */
export const SNAPSHOT_REASONS = Object.freeze({
  NO_WORKSPACE: 'GIT_SNAPSHOT_NO_WORKSPACE',
  NOT_A_REPOSITORY: 'GIT_SNAPSHOT_NOT_A_REPOSITORY',
  EMPTY_HEAD: 'GIT_SNAPSHOT_EMPTY_HEAD',
  COMMAND_FAILED: 'GIT_SNAPSHOT_COMMAND_FAILED',
  COMMAND_TIMEOUT: 'GIT_SNAPSHOT_COMMAND_TIMEOUT',
  OUTPUT_TRUNCATED: 'GIT_SNAPSHOT_OUTPUT_TRUNCATED',
  INVALID_OUTPUT: 'GIT_SNAPSHOT_INVALID_OUTPUT',
  UNSUPPORTED_ENTRY: 'GIT_SNAPSHOT_UNSUPPORTED_ENTRY',
  CONCURRENT_CHANGE: 'GIT_SNAPSHOT_CONCURRENT_CHANGE',
});

/** 下一步提示：每条失败都给出可执行动作，而不是让调用方猜。 */
const NEXT_OF = Object.freeze({
  [SNAPSHOT_REASONS.NO_WORKSPACE]: '在已授权的工作区内重新发起调用；调用根不可信时不生成版本。',
  [SNAPSHOT_REASONS.NOT_A_REPOSITORY]: '确认本次会话的工作目录确实是目标仓库（或它的 linked worktree）后重试。',
  [SNAPSHOT_REASONS.EMPTY_HEAD]: '仓库还没有任何提交：先产生一次提交，再读取代码版本。',
  [SNAPSHOT_REASONS.COMMAND_FAILED]: '核对仓库状态后重试；不要用分支名或 runId 代替版本。',
  [SNAPSHOT_REASONS.COMMAND_TIMEOUT]: '仓库过大或磁盘忙：稍后重试，不把本次结果当版本。',
  [SNAPSHOT_REASONS.OUTPUT_TRUNCATED]: 'git 输出超过上限：缩小仓库范围或清理无关未跟踪文件后重试。',
  [SNAPSHOT_REASONS.INVALID_OUTPUT]: 'git 返回了无法解析的内容：核对 git 版本与仓库形态后重试。',
  [SNAPSHOT_REASONS.UNSUPPORTED_ENTRY]: '仓库里存在本工具不支持的形态（gitlink、越界软链）：改为人工核对，不计为已绑定版本。',
  [SNAPSHOT_REASONS.CONCURRENT_CHANGE]: '采样期间工作树发生变化：停止写入后重试，本次结果不构成版本。',
});

/** 固定的读取命令：顺序即执行顺序，全部只读。 */
const READ_COMMANDS = Object.freeze([
  Object.freeze({ key: 'topLevel', args: Object.freeze(['rev-parse', '--show-toplevel']), purpose: 'git.snapshot.top-level' }),
  Object.freeze({ key: 'commit', args: Object.freeze(['rev-parse', 'HEAD']), purpose: 'git.snapshot.head' }),
  Object.freeze({ key: 'tree', args: Object.freeze(['rev-parse', 'HEAD^{tree}']), purpose: 'git.snapshot.tree' }),
  Object.freeze({ key: 'branch', args: Object.freeze(['branch', '--show-current']), purpose: 'git.snapshot.branch' }),
  Object.freeze({ key: 'status', args: Object.freeze(['status', '--porcelain=v1', '-z', '--untracked-files=all']), purpose: 'git.snapshot.status' }),
  Object.freeze({ key: 'index', args: Object.freeze(['ls-files', '--stage', '-z']), purpose: 'git.snapshot.index' }),
  Object.freeze({ key: 'untracked', args: Object.freeze(['ls-files', '--others', '--exclude-standard', '-z']), purpose: 'git.snapshot.untracked' }),
  Object.freeze({ key: 'show', args: Object.freeze(['show', '-s', '--format=%H%x00%B', 'HEAD']), purpose: 'git.snapshot.message' }),
]);

/** 受支持的 index 模式：普通文件、可执行文件、软链。gitlink（160000）等一律拒绝。 */
const SUPPORTED_MODES = new Set(['100644', '100755', '120000']);
const GITLINK_MODE = '160000';
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;

/**
 * `NOT_A_REPOSITORY` 时对"一层直接子目录"的只读探测参数：argv 写死、候选有上限、
 * 跳过隐藏目录（`.git`/`.ssh` 等）与依赖/产物目录；只用来补充提示，不改变失败结论。
 */
const PROBE_MAX_CANDIDATES = 8;
const PROBE_SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'coverage']);
const PROBE_TOP_LEVEL = Object.freeze({ args: Object.freeze(['rev-parse', '--show-toplevel']), purpose: 'git.snapshot.probe-top-level' });
const PROBE_HEAD = Object.freeze({ args: Object.freeze(['rev-parse', 'HEAD']), purpose: 'git.snapshot.probe-head' });

const text = (value) => (typeof value === 'string' ? value : '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function failure(status, reason, message) {
  return Object.freeze({
    status,
    reason,
    message,
    next: NEXT_OF[reason] ?? '按失败原因核对后重试。',
    observedAt: null,
  });
}

/** 路径归一：只接受仓库根之内的相对路径；逃逸一律拒绝（不拼绝对路径进错误信息）。 */
function safeRelative(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (path.includes('\u0000')) return null;
  const normalized = normalize(path);
  if (normalized === '' || normalized === '.') return null;
  if (isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null;
  return normalized;
}

function parseStatus(stdout) {
  const tokens = stdout.split('\u0000');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    if (raw === '') continue;
    if (raw.length < 4) return null;
    const x = raw[0];
    const y = raw[1];
    const path = raw.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      index += 1;
      entries.push(Object.freeze({ x, y, path, from: tokens[index] ?? '' }));
    } else {
      entries.push(Object.freeze({ x, y, path }));
    }
  }
  return entries;
}

function parseIndex(stdout) {
  const entries = [];
  for (const token of stdout.split('\u0000')) {
    if (token === '') continue;
    const tab = token.indexOf('\t');
    if (tab < 0) return null;
    const head = token.slice(0, tab).split(' ');
    const path = token.slice(tab + 1);
    if (head.length !== 3) return null;
    const [mode, objectId, stage] = head;
    if (!SUPPORTED_MODES.has(mode) && mode !== GITLINK_MODE) return null;
    if (!OBJECT_ID_PATTERN.test(objectId)) return null;
    entries.push(Object.freeze({ mode, objectId, stage, path }));
  }
  return entries;
}

function parsePaths(stdout) {
  return stdout.split('\u0000').filter((token) => token !== '');
}

/** 字节序比较，避免 `localeCompare` 在不同宿主上给出不同顺序（顺序进散列，必须稳定）。 */
function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * 装配只读快照读取器。
 *
 * @param {object} options
 * @param {{runGit: Function}} options.runner 唯一执行出口（`gitee-cli.mjs`）
 * @param {() => number} [options.now] 可注入时钟
 * @param {number} [options.samples] 采样次数（默认 2：收口前后各一次，不一致即 unknown）
 * @param {string} [options.gitBin] 仅用于证据展示的可执行名（不参与执行）
 */
export function createGiteeSnapshotReader({ runner, now = Date.now, samples = 2 } = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.runGit !== 'function') {
    throw new TypeError('快照读取器需要 runner.runGit(...)：与 git/gitee 共用唯一执行出口（gitee-cli.mjs）');
  }
  if (typeof now !== 'function') throw new TypeError('快照读取器的 now 必须是函数');
  const rounds = Number.isSafeInteger(samples) && samples > 0 ? samples : 2;

  async function git(args, purpose, cwd) {
    let outcome;
    try {
      outcome = await runner.runGit({ args: [...args], purpose, cwd });
    } catch (error) {
      return { ok: false, reason: SNAPSHOT_REASONS.COMMAND_FAILED, detail: text(error?.message) };
    }
    if (outcome === null || typeof outcome !== 'object') {
      return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT, detail: '执行器返回了非对象结果' };
    }
    if (outcome.timedOut === true) return { ok: false, reason: SNAPSHOT_REASONS.COMMAND_TIMEOUT, detail: 'timedOut' };
    if (outcome.truncated === true) return { ok: false, reason: SNAPSHOT_REASONS.OUTPUT_TRUNCATED, detail: 'truncated' };
    const exitCode = Number.isInteger(outcome.exitCode) ? outcome.exitCode : null;
    if (exitCode !== 0) {
      return {
        ok: false,
        reason: SNAPSHOT_REASONS.COMMAND_FAILED,
        detail: text(outcome.stderr) || text(outcome.stdout),
        exitCode,
      };
    }
    return { ok: true, stdout: text(outcome.stdout), stderr: text(outcome.stderr) };
  }

  /**
   * `NOT_A_REPOSITORY` 的一层探测：只读**直接子目录**，找到"子目录自己就是仓库根"就返回
   * 相对目录名与 7 位 HEAD。argv 写死、候选有上限；符号链接不会被当成目录（`Dirent` 不跟随），
   * 隐藏目录与依赖/产物目录直接跳过。任何失败都只是"没找到"：不改变快照的 failed 结论，
   * 也不把绝对路径或 stderr 原文带回提示。
   */
  async function probeChildRepository(cwd) {
    let names;
    try {
      names = readdirSync(cwd, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !PROBE_SKIP.has(entry.name))
        .map((entry) => entry.name)
        .sort(compareBytes)
        .slice(0, PROBE_MAX_CANDIDATES);
    } catch {
      return null;
    }
    for (const name of names) {
      const child = join(cwd, name);
      const top = await git(PROBE_TOP_LEVEL.args, PROBE_TOP_LEVEL.purpose, child);
      if (!top.ok) continue;
      const topLevel = text(top.stdout).split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? '';
      let childRoot;
      let resolved;
      try {
        childRoot = realpathSync(child);
        resolved = realpathSync(topLevel);
      } catch {
        continue;
      }
      // 只认"这个子目录自己就是仓库根"：避免把上层仓库或别处的 toplevel 误报成候选。
      if (resolved !== childRoot) continue;
      const head = await git(PROBE_HEAD.args, PROBE_HEAD.purpose, child);
      if (!head.ok) continue;
      const commit = (text(head.stdout).split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim().toLowerCase();
      if (!OBJECT_ID_PATTERN.test(commit)) continue;
      return Object.freeze({ name, shortHead: commit.slice(0, 7) });
    }
    return null;
  }

  /** 工作树内容摘要：软链只散列目标字符串（不跟随），越界或不可读一律拒绝。 */
  function digestWorktreeEntry(root, relative) {
    const target = resolve(root, relative);
    const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(normalizedRoot)) return { ok: false };
    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      return { ok: false };
    }
    try {
      if (stats.isSymbolicLink()) {
        const link = readlinkSync(target);
        if (isAbsolute(link)) return { ok: false };
        // 只拒绝"目标落在仓库之外"的软链；仓库内的软链按 git 语义散列目标字符串（不跟随）。
        const resolvedLink = resolve(dirname(target), link);
        if (resolvedLink !== root && !resolvedLink.startsWith(normalizedRoot)) return { ok: false };
        return { ok: true, digest: `symlink:${sha256(link)}` };
      }
      if (!stats.isFile()) return { ok: false };
      // 模式也进版本：`100644` ↔ `100755` 在 git 里是内容差异（index 记录模式位），
      // 只散列字节会让"只改了可执行位"看起来没变。
      const mode = (stats.mode & 0o111) !== 0 ? '755' : '644';
      return { ok: true, digest: `file:${mode}:${sha256(readFileSync(target))}` };
    } catch {
      return { ok: false };
    }
  }

  /** 一次完整采样：固定 8 条只读命令 + 内存散列。 */
  async function sample(cwd) {
    const outputs = new Map();
    for (const command of READ_COMMANDS) {
      const result = await git(command.args, command.purpose, cwd);
      if (!result.ok) {
        const reason = result.reason === SNAPSHOT_REASONS.COMMAND_FAILED
          && /not a git repository/iu.test(result.detail ?? '')
          ? SNAPSHOT_REASONS.NOT_A_REPOSITORY
          : result.reason;
        const emptyHead = reason === SNAPSHOT_REASONS.COMMAND_FAILED
          && (command.key === 'commit' || command.key === 'show')
          && /unknown revision|ambiguous argument|does not have any commits|bad revision|Needed a single revision/iu.test(result.detail ?? '');
        return {
          ok: false,
          reason: emptyHead ? SNAPSHOT_REASONS.EMPTY_HEAD : reason,
          exitCode: result.exitCode ?? null,
        };
      }
      outputs.set(command.key, result.stdout);
    }

    const topLevel = text(outputs.get('topLevel')).split(/\r?\n/u).find((line) => line.trim() !== '') ?? '';
    if (topLevel.trim() === '') return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT };
    let root;
    try {
      root = realpathSync(topLevel.trim());
    } catch {
      return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT };
    }

    const commit = (text(outputs.get('commit')).split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim().toLowerCase();
    const tree = (text(outputs.get('tree')).split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim().toLowerCase();
    if (!OBJECT_ID_PATTERN.test(commit) || !OBJECT_ID_PATTERN.test(tree)) {
      return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT };
    }
    const branch = (text(outputs.get('branch')).split(/\r?\n/u).find((line) => line.trim() !== '') ?? '').trim();

    const statusEntries = parseStatus(text(outputs.get('status')));
    const indexEntries = parseIndex(text(outputs.get('index')));
    if (statusEntries === null || indexEntries === null) return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT };

    const rawShow = text(outputs.get('show'));
    const nul = rawShow.indexOf('\u0000');
    const commitMessage = nul < 0 ? '' : rawShow.slice(nul + 1).replace(/\r?\n$/u, '');

    const canonical = [`head ${commit}`, `tree ${tree}`, `branch ${branch}`];
    const seenIndex = new Set();
    for (const entry of indexEntries) {
      const relative = safeRelative(entry.path);
      if (relative === null) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      if (entry.mode === GITLINK_MODE) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      if (!SUPPORTED_MODES.has(entry.mode)) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      if (seenIndex.has(relative)) return { ok: false, reason: SNAPSHOT_REASONS.INVALID_OUTPUT };
      seenIndex.add(relative);
      canonical.push(`index ${entry.mode} ${entry.objectId} ${relative}`);
    }

    const workPaths = new Set();
    for (const entry of statusEntries) {
      const relative = safeRelative(entry.path);
      if (relative === null) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      // `D` 出现在任一列都表示工作树里已经没有这个文件：删除本身就是内容变化，
      // 不能再去 stat 一个不存在的路径（那会被误判成"不支持该形态"）。
      if (entry.x === 'D' || entry.y === 'D') {
        canonical.push(`work ${relative} deleted`);
        continue;
      }
      workPaths.add(relative);
    }
    for (const raw of parsePaths(text(outputs.get('untracked')))) {
      const relative = safeRelative(raw);
      if (relative === null) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      workPaths.add(relative);
    }
    const workEntries = [];
    for (const relative of workPaths) {
      // 未跟踪、或"删除后又出现"的路径同样是工作树里的真实内容，必须进版本。
      const digest = digestWorktreeEntry(root, relative);
      if (!digest.ok) return { ok: false, reason: SNAPSHOT_REASONS.UNSUPPORTED_ENTRY };
      workEntries.push([relative, digest.digest]);
    }
    workEntries.sort((left, right) => compareBytes(left[0], right[0]));
    for (const [relative, digest] of workEntries) canonical.push(`work ${relative} ${digest}`);

    const portable = canonical.slice().sort(compareBytes).join('\n');
    const contentId = sha256(portable);

    return {
      ok: true,
      sample: {
        workspaceId: `ws-${sha256(root).slice(0, 16)}`,
        commit,
        tree,
        branch: branch === '' ? null : branch,
        dirty: statusEntries.length > 0,
        contentId,
        commitMessage,
        // 判定"两次采样是否一致"用：只含摘要，不含路径。
        fingerprint: sha256(`${commit}\n${tree}\n${branch}\n${contentId}`),
      },
    };
  }

  /**
   * @param {string} cwd 已授权工作区目录（由装配层从真实调用上下文解析，不接受模型传入）
   * @returns {Promise<object>} `SnapshotResult`
   */
  async function read(cwd) {
    const directory = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null;
    if (directory === null) {
      return Object.freeze({ ...failure('failed', SNAPSHOT_REASONS.NO_WORKSPACE, '拿不到可信的调用工作区：不生成代码版本'), observedAt: now() });
    }
    const observedAt = now();
    let previous = null;
    for (let round = 0; round < rounds; round += 1) {
      const outcome = await sample(directory);
      if (!outcome.ok) {
        const status = outcome.reason === SNAPSHOT_REASONS.COMMAND_TIMEOUT
          || outcome.reason === SNAPSHOT_REASONS.OUTPUT_TRUNCATED
          || outcome.reason === SNAPSHOT_REASONS.CONCURRENT_CHANGE
          ? 'unknown'
          : 'failed';
        const message = outcome.reason === SNAPSHOT_REASONS.COMMAND_FAILED && outcome.exitCode !== null
          ? `git 只读采样失败（exit ${outcome.exitCode}）：不生成代码版本`
          : `${(NEXT_OF[outcome.reason] ?? '快照不可用')}`;
        let detailMessage = message;
        let next = NEXT_OF[outcome.reason] ?? '按失败原因核对后重试。';
        // "不是仓库"时补一层探测：会话根常常是仓库的父目录，盲查会让调用方以为选错了项目。
        // 探测只补充提示，status/reason 保持原判（探测失败绝不让 failed 变成 unknown）。
        if (outcome.reason === SNAPSHOT_REASONS.NOT_A_REPOSITORY) {
          const child = await probeChildRepository(directory);
          if (child !== null) {
            detailMessage = `当前工作目录不是仓库，但子目录 ${child.name}/ 是仓库根（HEAD=${child.shortHead}）：不生成代码版本`;
            next = `把会话工作目录切到 ${child.name}/ 后重试；本次结果不构成代码版本。`;
          }
        }
        return Object.freeze({ ...failure(status, outcome.reason, detailMessage), next, observedAt });
      }
      if (previous !== null && previous.fingerprint !== outcome.sample.fingerprint) {
        return Object.freeze({
          ...failure('unknown', SNAPSHOT_REASONS.CONCURRENT_CHANGE, '采样期间工作树发生变化：本次结果不构成代码版本'),
          observedAt,
        });
      }
      previous = outcome.sample;
    }

    return Object.freeze({
      status: 'succeeded',
      workspaceId: previous.workspaceId,
      commit: previous.commit,
      tree: previous.tree,
      branch: previous.branch,
      dirty: previous.dirty,
      contentId: previous.contentId,
      commitMessage: previous.commitMessage,
      observedAt,
      evidence: Object.freeze(
        READ_COMMANDS.map((command) => Object.freeze({
          kind: 'local-execution',
          command: `git ${command.args.join(' ')}`,
          source: 'local-git',
          observedAt,
        })),
      ),
      samples: rounds,
    });
  }

  return Object.freeze({ read });
}

/* ------------------------------------------------------------------ 工具层 */

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const TOOL_OUTPUT = Object.freeze({
  schema: { type: 'object' },
  render: (_args, value) => json(value).content,
});

/**
 * 快照工具定义。参数表为空对象且 `additionalProperties: false`：不接受 cwd / repoRoot / bin /
 * argv，也不接受调用方自报 `sourceType`。调用根永远来自真实 Agent 上下文。
 *
 * @param {object} service 装配层端口（`service.snapshot(cwd)`）
 * @param {(exec: object) => Promise<string | undefined>} resolveCwd 会话工作目录解析
 */
export function snapshotToolDefinitions(service, resolveCwd = async () => undefined) {
  return [
    {
      name: GITEE_SNAPSHOT_TOOLS[0],
      description:
        '只读读取当前工作区的代码版本：返回 workspaceId、完整 commit/tree、分支、是否脏、' +
        'contentId（覆盖暂存/未暂存/删除/重命名/未跟踪内容）、提交信息与观测时间。' +
        '不执行写命令、不接受调用方传入目录；截断、超时、未支持形态或采样期间发生变化时返回 unknown。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      execute: async (_args, exec) => {
        let directory;
        try {
          const resolved = await resolveCwd(exec);
          directory = typeof resolved === 'string' && resolved.trim() !== '' ? resolved : undefined;
        } catch {
          directory = undefined;
        }
        // 拿不到可信调用根就地拒绝：一次子进程都不起，也不让服务去猜目录。
        if (directory === undefined) {
          return json({
            ...failure('failed', SNAPSHOT_REASONS.NO_WORKSPACE, '拿不到可信的调用工作区：不生成代码版本'),
            observedAt: Date.now(),
          });
        }
        if (typeof service?.snapshot !== 'function') {
          return json({
            ...failure('failed', SNAPSHOT_REASONS.NO_WORKSPACE, 'gitee 服务没有装配快照读取器：不生成代码版本'),
            observedAt: Date.now(),
          });
        }
        return json(await service.snapshot(directory));
      },
    },
  ];
}
