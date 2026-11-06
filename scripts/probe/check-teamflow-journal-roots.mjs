/**
 * Teamflow 证据的**工作区归属**检查（r1 / AC-9，取代 r13#AC-7 的三根判据）。
 *
 * 问题：同一份 journal 可能被别的泵路径读到，交付证据于是挂在错误的工作区上。
 * 宿主的归属事实只有一项：`workspaceScopeOf(agent)` 取会话 cwd 写出的
 * `workspacePath`；`stateRoot` / `commitRoot` 在 0.3.2/0.3.3 的 `lib/host.mjs`
 * 中 0 命中，宿主不提供。因此判据只认一个字段，结论分两态：
 *
 * - aligned  ：`workspacePath` 存在、非空，且经真实路径归一后等于授权根或在其下；
 * - mismatch ：`workspacePath` 缺失/空/不可解析，或落在授权根之外（主工作树、别的 worktree）。
 *
 * `stateRoot`/`commitRoot` **仅观测**：缺失记 missing（宿主不提供，不是失败、不是阻断），
 * 存在则记 within/outside 并打印，任何取值都不改 status、不改退出码。
 *
 * 用法：node scripts/probe/check-teamflow-journal-roots.mjs --journal <file> --root <dir>
 * 没有 journal 时打印 NOT RUN 并退出 0；mismatch 退出 1；用法/IO 错误退出 2。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 唯一定夺字段；宿主归属的唯一事实来源。 */
const DECIDING_FIELD = 'workspacePath';
/** 观测字段：只披露，永不参与判定。 */
const OBSERVED_FIELDS = Object.freeze(['stateRoot', 'commitRoot']);

/** 解析真实路径；路径尚不存在时退回绝对路径，避免把「不存在」误判成「越界」。 */
function realOf(path) {
  try {
    return realpathSync(path);
  } catch {
    // 尚不存在的路径（如 logs/state 还没建）：把最近的已存在祖先解析成真实路径，
    // 其余部分原样接回去，避免 /var 与 /private/var 之类别名把归属判反。
    const absolute = resolve(path);
    let head = absolute;
    const tail = [];
    for (;;) {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(head.slice(parent.length).replace(/^\/+/u, ''));
      head = parent;
      try {
        const real = realpathSync(head);
        return join(real, ...tail);
      } catch {
        continue;
      }
    }
  }
}

function within(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {{authorizedRoot: string, journal?: object|null}} input
 * @returns {{
 *   status: 'aligned'|'mismatch',
 *   reasons: string[],
 *   fields: {workspacePath?: string},
 *   optional: {stateRoot: 'missing'|'within'|'outside', commitRoot: 'missing'|'within'|'outside'},
 * }}
 */
export function classifyJournalRoots({ authorizedRoot, journal } = {}) {
  const reasons = [];
  const fields = {};
  const optional = {};
  // 非法入参 fail-closed：缺授权根无法判定归属，按 mismatch 报出（CLI 的用法错误另走退出码 2）。
  if (!isFilledString(authorizedRoot)) {
    return { status: 'mismatch', reasons: ['authorizedRoot missing'], fields, optional };
  }
  if (journal === null || typeof journal !== 'object') {
    return { status: 'mismatch', reasons: ['journal missing'], fields, optional };
  }
  const authorized = realOf(authorizedRoot);

  // 定夺字段：唯一硬门。
  const declared = journal[DECIDING_FIELD];
  if (!isFilledString(declared)) {
    reasons.push(`${DECIDING_FIELD} missing`);
  } else {
    let real;
    try {
      real = realOf(declared);
    } catch {
      real = undefined;
    }
    if (real === undefined) {
      reasons.push(`${DECIDING_FIELD} missing`);
    } else {
      fields[DECIDING_FIELD] = real;
      if (!within(authorized, real)) reasons.push(`${DECIDING_FIELD} outside authorized root: ${real}`);
    }
  }

  // 观测字段：只记录取值，永不进 reasons、永不改判定。
  for (const field of OBSERVED_FIELDS) {
    const value = journal[field];
    if (!isFilledString(value)) {
      optional[field] = 'missing';
      continue;
    }
    let real;
    try {
      real = realOf(value);
    } catch {
      real = undefined;
    }
    optional[field] = real === undefined ? 'missing' : within(authorized, real) ? 'within' : 'outside';
  }

  return { status: reasons.length === 0 ? 'aligned' : 'mismatch', reasons, fields, optional };
}

/** 观测字段的人类可读行；缺失的措辞固定，便于 QA 与 README 共用同一读法。 */
function describeObserved(field, state) {
  if (state === 'missing') return `${field} unknown (host does not provide)`;
  if (state === 'within') return `${field} within authorized root`;
  return `${field} outside authorized root (observational, not a failure)`;
}

function main(argv) {
  const at = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const journalPath = at('--journal');
  const root = at('--root');
  if (journalPath === undefined) {
    // 缺证不等于失败，也不等于通过。
    console.log('journal-roots: NOT RUN (no journal)');
    process.exitCode = 0;
    return;
  }
  if (!isFilledString(root)) {
    console.error('journal-roots: --root is required with --journal');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(journalPath)) {
    console.error(`journal-roots: journal not found: ${journalPath}`);
    process.exitCode = 2;
    return;
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch (error) {
    console.error(`journal-roots: unreadable journal: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const verdict = classifyJournalRoots({ authorizedRoot: root, journal });
  for (const reason of verdict.reasons) console.error(`journal-roots: ${reason}`);
  for (const field of OBSERVED_FIELDS) {
    const state = verdict.optional[field];
    if (state !== undefined) console.error(`journal-roots: ${describeObserved(field, state)}`);
  }
  // stdout 只留一行结论，便于脚本与报告直接引用。
  console.log(`journal-roots: ${verdict.status}`);
  process.exitCode = verdict.status === 'aligned' ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
