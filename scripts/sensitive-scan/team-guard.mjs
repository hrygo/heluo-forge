import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { gitOutput, repoRoot } from './lib.mjs';
import { loadRules } from './team-scan.mjs';

// Every Git subprocess in this file and in its callers must read original
// objects; a replace ref could otherwise swap the base tree being scanned.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

export function gitRaw(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    input: options.input,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

function checkWorktree(path, root) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  let worktree;
  try {
    worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(path), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 128 && String(error.stderr).includes('not a git repository')) return;
    throw new Error('cannot inspect destination worktree');
  }
  if (relative(realpathSync.native(worktree), realpathSync.native(root)) !== '') throw new Error('destination is inside another Git worktree');
}

function checkParents(path) {
  let current = dirname(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (process.platform === 'win32' || stat.uid !== 0) throw new Error('unsafe symlink directory');
    } else if (!stat.isDirectory() || (process.platform !== 'win32' &&
        ((stat.uid !== 0 && stat.uid !== process.getuid()) || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))))) {
      throw new Error('unsafe directory');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function checkCommonDir(common, root) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const options = { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], options).split('\0');
  const rootPath = realpathSync.native(root);
  const reported = records.filter((entry) => entry.startsWith('worktree ')).map((entry) => realpathSync.native(entry.slice(9)));
  if (!reported.length) throw new Error('cannot inspect Git worktrees');
  if (reported.includes(common) && reported.length > 1) throw new Error('cannot determine separate Git main worktree');
  const worktrees = reported.map((path) => path === common && rootPath !== common ? rootPath : path);
  if (!worktrees.includes(rootPath)) worktrees.push(rootPath);
  if (!worktrees.length) throw new Error('cannot inspect Git worktrees');
  const inspect = (tree) => {
    const rel = relative(tree, common);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      const metadata = resolve(tree, '.git');
      const stat = lstatSync(metadata);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(metadata) !== common) throw new Error('Git common directory is inside a worktree');
    }
  };
  for (const tree of worktrees) inspect(tree);
  try {
    const tree = execFileSync('git', ['rev-parse', '--show-toplevel'], { ...options, cwd: dirname(common) }).trim();
    inspect(realpathSync.native(tree));
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
}

function checkSecret(path, root, shared) {
  path = resolve(path);
  checkParents(path);
  if (path === resolve(shared, 'private/rules.json') || path === resolve(shared, 'private/device-key.pem')) {
    for (const directory of [shared, resolve(shared, 'private')]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('unsafe shared directory');
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('unsafe secret file');
    return;
  }
  let ancestor = dirname(path);
  while (true) {
    try {
      if (relative(realpathSync.native(ancestor), realpathSync.native(root)) === '') {
        path = resolve(root, relative(ancestor, path));
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  checkWorktree(path, root);
  const rel = relative(realpathSync.native(root), realpathSync.native(path));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside) {
    const resolved = relative(realpathSync.native(root), realpathSync.native(path));
    if (resolved === '' || (resolved !== '..' && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved))) throw new Error('redirected secret');
  }
  if (inside) {
    let current = root;
    for (const part of rel.split(sep).slice(0, -1)) {
      current = resolve(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022))) throw new Error('unsafe directory');
    }
    if (process.platform !== 'win32' && (lstatSync(dirname(path)).mode & 0o077)) throw new Error('unsafe directory permissions');
    const gitPath = process.platform === 'win32' ? rel.replaceAll('\\', '/') : rel;
    if (gitOutput(['ls-files', '-z', '--', `:(${process.platform === 'win32' ? 'literal,icase' : 'literal'})${gitPath}`], { cwd: root })) throw new Error('tracked secret');
    gitOutput(['check-ignore', '--no-index', '-q', '--', gitPath], { cwd: root });
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('unsafe secret file');
}

/**
 * Resolve the rules and key for the current worktree through the same path,
 * permission, ignore and worktree checks the commit hook uses. Both hooks must
 * accept exactly the same configuration, so the checks live here once.
 */
export function loadGuardContext() {
  for (const name of ['SENSITIVE_SCAN_KEY_FILE', 'SENSITIVE_SCAN_RULES']) {
    if (process.env[name] && !isAbsolute(process.env[name])) throw new Error('configuration path must be absolute');
  }
  const cwd = repoRoot();
  const commonPath = resolve(cwd, gitOutput(['rev-parse', '--git-common-dir'], { cwd }).trim());
  if (lstatSync(commonPath).isSymbolicLink()) throw new Error('unsafe Git common directory');
  checkParents(commonPath);
  const common = realpathSync.native(commonPath);
  checkCommonDir(common, cwd);
  const shared = resolve(common, 'heluo-sensitive-scan');
  const rulesPath = process.env.SENSITIVE_SCAN_RULES || resolve(shared, 'private/rules.json');
  const keyPath = process.env.SENSITIVE_SCAN_KEY_FILE || resolve(shared, 'private/device-key.pem');
  checkSecret(rulesPath, cwd, shared);
  checkSecret(keyPath, cwd, shared);
  const rules = loadRules(rulesPath);
  return { cwd, common, shared, rulesPath, keyPath, rules };
}
