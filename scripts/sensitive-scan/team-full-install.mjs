#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { gitOutput, keyIdFromPublicKey, loadKeyPair } from './lib.mjs';
import { loadRules, scanText } from './team-scan.mjs';

const MARKER = '# managed by heluo-sensitive-scan complete distribution';
const KNOWN_V1 = {
  'lib.mjs': '9973e15ad4b9ce7077e2c18bd0b334cad6055fbd534ade422b380101dff9dcc8',
  'team-commit-msg.mjs': '1dcdf2b1ff8da88f7366d7b67568037a27363749b5e4e9e62e60253e2eafb54a',
  'team-scan.mjs': '761ad1e8fb517e589505884113bc3f9194d46b96be985860d2899ed647c1c90b',
};
const packageRoot = resolve(import.meta.dirname, '../..');
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
function statIfPresent(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function effectivePath(path) {
  const pending = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('cannot resolve destination');
    pending.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...pending);
}
function ensureOutsideRepo(path, repo) {
  const rel = relative(realpathSync.native(repo), effectivePath(path));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('private key and rules must be stored outside the repository');
  }
}
function normalizeRepoAlias(path, repo) {
  let ancestor = dirname(path);
  while (true) {
    if (statIfPresent(ancestor) && relative(realpathSync.native(ancestor), realpathSync.native(repo)) === '') return resolve(repo, relative(ancestor, path));
    const parent = dirname(ancestor);
    if (parent === ancestor) return path;
    ancestor = parent;
  }
}
function checkWorktree(path, repo) {
  let parent = dirname(path);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error('cannot inspect destination worktree');
    parent = next;
  }
  const env = { ...process.env, LC_ALL: 'C' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  let worktree;
  try {
    worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: parent, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 128 && String(error.stderr).includes('not a git repository')) return;
    throw new Error('cannot inspect destination worktree');
  }
  if (relative(realpathSync.native(worktree), realpathSync.native(repo)) !== '') throw new Error('destination is inside another Git worktree');
}
function checkParents(path) {
  let current = dirname(path);
  while (true) {
    const stat = statIfPresent(current);
    if (stat) {
      if (stat.isSymbolicLink()) {
        // System-owned path aliases such as macOS /var are not user-controlled.
        if (process.platform === 'win32' || stat.uid !== 0) throw new Error('unsafe symlink directory');
      } else if (!stat.isDirectory() || (process.platform !== 'win32' &&
          ((stat.uid !== 0 && stat.uid !== process.getuid()) || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))))) {
        throw new Error('unsafe destination directory');
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function checkCommonDir(common, root) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const options = { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], options).split('\0');
  const rootPath = realpathSync.native(root);
  const reported = records.filter((entry) => entry.startsWith('worktree ')).map((entry) => realpathSync.native(entry.slice(9)));
  if (!reported.length) throw new Error('cannot inspect Git worktrees');
  // With separate-git-dir Git can report the metadata itself as the main
  // worktree. When linked worktrees exist its actual main location is unknown.
  if (reported.includes(common) && reported.length > 1) throw new Error('cannot determine separate Git main worktree');
  const worktrees = reported.map((path) => path === common && rootPath !== common ? rootPath : path);
  if (!worktrees.includes(rootPath)) worktrees.push(rootPath);
  if (!worktrees.length) throw new Error('cannot inspect Git worktrees');
  const inspect = (tree) => {
    const rel = relative(tree, common);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      const metadata = resolve(tree, '.git');
      const stat = lstatSync(metadata);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(metadata) !== common) {
        throw new Error('Git common directory is inside a worktree');
      }
    }
  };
  for (const tree of worktrees) inspect(tree);
  try {
    const tree = execFileSync('git', ['rev-parse', '--show-toplevel'], { ...options, cwd: dirname(common) }).trim();
    inspect(realpathSync.native(tree));
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  let expected;
  for (const tree of worktrees) {
    const local = { ...options, cwd: tree };
    let configured;
    try { configured = execFileSync('git', ['config', '--path', '--get', 'core.hooksPath'], local).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
    if (configured !== undefined && !isAbsolute(configured)) throw new Error('core.hooksPath must be absolute');
    const hook = resolve(tree, execFileSync('git', ['rev-parse', '--git-path', 'hooks/commit-msg'], local).trim());
    const actual = effectivePath(hook);
    if (expected !== undefined && expected !== actual) throw new Error('worktrees do not share a commit-msg hook');
    expected = actual;
  }
  return expected;
}
function checkDestination(path, repo) {
  checkParents(path);
  checkWorktree(path, repo);
  const rel = relative(realpathSync.native(repo), effectivePath(path));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside) {
    ensureOutsideRepo(path, repo);
    const parent = statIfPresent(dirname(path));
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && (parent.mode & 0o022)))) {
      throw new Error('unsafe destination directory');
    }
    return;
  }
  let current = repo;
  for (const component of rel.split(sep).slice(0, -1)) {
    current = resolve(current, component);
    const stat = statIfPresent(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022)))) {
      throw new Error('unsafe destination directory');
    }
  }
  const gitPath = process.platform === 'win32' ? rel.replaceAll('\\', '/') : rel;
  const tracked = gitOutput(['ls-files', '-z', '--', `:(${process.platform === 'win32' ? 'literal,icase' : 'literal'})${gitPath}`], { cwd: repo });
  if (tracked) throw new Error('destination is tracked by Git');
  try { gitOutput(['check-ignore', '--no-index', '-q', '--', gitPath], { cwd: repo }); }
  catch { throw new Error('destination must be ignored by Git'); }
  const parent = statIfPresent(dirname(path));
  if (parent && process.platform !== 'win32' && (parent.mode & 0o077)) throw new Error('destination directory permissions are too broad');
}
function checkExisting(path, expected, label) {
  const stat = statIfPresent(path);
  if (!stat) return false;
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (stat.uid !== 0 && stat.uid !== process.getuid()))) throw new Error(`existing ${label} permissions or owner are unsafe`);
  if (!stat.isFile() || stat.isSymbolicLink() || !readFileSync(path).equals(expected)) {
    throw new Error(`existing ${label} differs or is not a regular file; not modified`);
  }
  return true;
}
function createPrivateFile(path, data) {
  const missing = [];
  let directory = dirname(path);
  while (!statIfPresent(directory)) {
    missing.unshift(directory);
    directory = dirname(directory);
  }
  for (const dir of missing) {
    mkdirSync(dir, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
  }
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

try {
  const args = process.argv.slice(2);
  let repo = process.cwd();
  let upgrade = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--repo') repo = args[++i] ?? '';
    else if (args[i] === '--upgrade-known-v1') upgrade = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('usage: node scripts/sensitive-scan/team-full-install.mjs [--repo <repository>] [--upgrade-known-v1]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (!repo) throw new Error('--repo must not be empty');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24 is required');
  for (const name of ['SENSITIVE_SCAN_KEY_FILE', 'SENSITIVE_SCAN_RULES']) {
    if (process.env[name] && !isAbsolute(process.env[name])) throw new Error(`${name} must be an absolute path`);
  }
  const root = gitOutput(['rev-parse', '--show-toplevel'], { cwd: resolve(repo) }).trim();
  ensureOutsideRepo(packageRoot, root);
  let packageInsideGit = false;
  try { packageInsideGit = gitOutput(['rev-parse', '--is-inside-work-tree'], { cwd: packageRoot }).trim() === 'true'; } catch { /* no enclosing Git worktree */ }
  if (packageInsideGit) throw new Error('extract the complete package outside all Git worktrees');
  const commonPath = resolve(root, gitOutput(['rev-parse', '--git-common-dir'], { cwd: root }).trim());
  if (lstatSync(commonPath).isSymbolicLink()) throw new Error('unsafe Git common directory');
  checkParents(commonPath);
  const common = realpathSync.native(commonPath);
  const expectedHook = checkCommonDir(common, root);
  const shared = resolve(common, 'heluo-sensitive-scan');
  const hook = resolve(root, gitOutput(['rev-parse', '--git-path', 'hooks/commit-msg'], { cwd: root }).trim());
  if (effectivePath(hook) !== expectedHook) throw new Error('Git hook selection differs from worktree configuration');
  const keyPath = normalizeRepoAlias(resolve(process.env.SENSITIVE_SCAN_KEY_FILE || resolve(shared, 'private/device-key.pem')), root);
  const rulesPath = normalizeRepoAlias(resolve(process.env.SENSITIVE_SCAN_RULES || resolve(shared, 'private/rules.json')), root);
  const sharedFiles = ['lib.mjs', 'team-scan.mjs', 'team-commit-msg.mjs'].map((name) => {
    const source = resolve(import.meta.dirname, name);
    checkParents(source);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022))) throw new Error('unsafe package script');
    return { path: resolve(shared, 'scripts', name), data: readFileSync(source), label: `script ${name}` };
  });
  checkParents(resolve(shared, 'scripts/file'));
  checkParents(hook);
  for (const path of [shared, resolve(shared, 'private'), resolve(shared, 'scripts')]) {
    const stat = statIfPresent(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))) {
      throw new Error('unsafe shared directory');
    }
  }
  if (keyPath !== resolve(shared, 'private/device-key.pem')) checkDestination(keyPath, root);
  if (rulesPath !== resolve(shared, 'private/rules.json')) checkDestination(rulesPath, root);
  if (effectivePath(keyPath) === effectivePath(rulesPath)) throw new Error('key and rules destinations must differ');

  const node = quote(process.execPath.replace(/\\/g, '/'));
  const scanner = quote(resolve(shared, 'scripts/team-commit-msg.mjs').replace(/\\/g, '/'));
  const shim = `#!/bin/sh\n${MARKER}\nexec ${node} ${scanner} "$1"\n`;
  const hookStat = statIfPresent(hook);
  if (hookStat && (!hookStat.isFile() || hookStat.isSymbolicLink() || readFileSync(hook, 'utf8') !== shim)) {
    throw new Error('existing commit-msg hook differs; not modified');
  }
  if (hookStat && process.platform !== 'win32') {
    if (!(hookStat.mode & 0o111)) throw new Error('existing commit-msg hook is not executable');
    accessSync(hook, constants.X_OK);
  }

  const sourceKeyPath = resolve(packageRoot, 'private/device-key.pem');
  const sourceRulesPath = resolve(packageRoot, 'private/rules.json');
  const sourcePublicPath = resolve(packageRoot, '.github/sensitive-scan/team-public-key.pub');
  for (const path of [sourceKeyPath, sourceRulesPath, sourcePublicPath]) {
    checkParents(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022))) throw new Error('unsafe package file');
  }
  const sourceKey = readFileSync(sourceKeyPath);
  const sourceRules = readFileSync(sourceRulesPath);
  const key = createPrivateKey(sourceKey);
  const packagedPublic = createPublicKey(readFileSync(sourcePublicPath));
  if (key.asymmetricKeyType !== 'ed25519' || packagedPublic.asymmetricKeyType !== 'ed25519' ||
      keyIdFromPublicKey(createPublicKey(key)) !== keyIdFromPublicKey(packagedPublic)) {
    throw new Error('packaged private key does not match team public key');
  }
  try {
    const parsed = JSON.parse(sourceRules.toString('utf8'));
    if (!parsed || !parsed.literals || !parsed.patterns ||
        !Object.values(parsed.literals).every((v) => Array.isArray(v) && v.every((s) => typeof s === 'string')) ||
        !Object.values(parsed.patterns).every((v) => typeof v === 'string') ||
        (parsed.allow !== undefined && (!Array.isArray(parsed.allow) || !parsed.allow.every((s) => typeof s === 'string'))) ||
        (parsed.ignorePaths !== undefined && (!Array.isArray(parsed.ignorePaths) || !parsed.ignorePaths.every((s) => typeof s === 'string')))) {
      throw new Error('invalid format');
    }
    scanText('', loadRules(sourceRulesPath));
  } catch {
    throw new Error('packaged rules have invalid format or regex');
  }
  const haveKey = checkExisting(keyPath, sourceKey, 'private key');
  const haveRules = checkExisting(rulesPath, sourceRules, 'rules');
  const changes = [];
  for (const file of sharedFiles) {
    const stat = statIfPresent(file.path);
    if (!stat) { file.exists = false; continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
        ((stat.mode & 0o077) || (stat.uid !== 0 && stat.uid !== process.getuid())))) {
      throw new Error(`existing ${file.label} permissions, owner or type are unsafe`);
    }
    const old = readFileSync(file.path);
    file.exists = true;
    file.old = old;
    if (!old.equals(file.data)) {
      const hash = createHash('sha256').update(old).digest('hex');
      if (!upgrade || hash !== KNOWN_V1[basename(file.path)]) throw new Error(`existing ${file.label} differs or is not a known v1 file; not modified`);
      changes.push({ ...file, old });
    }
  }
  if (haveKey) loadKeyPair(keyPath);
  if (upgrade && (hookStat || haveKey || haveRules || sharedFiles.some((file) => file.exists)) &&
      (!haveKey || !haveRules || !hookStat || sharedFiles.some((file) => !file.exists))) {
    throw new Error('upgrade requires a complete existing installation');
  }
  if (changes.length) {
    // Every existing script was checked above against either the package or its
    // known v1 hash; a partially completed upgrade can therefore be resumed.
    // Back up only public program sources before replacing any of them.
    const backups = resolve(shared, 'backups');
    checkParents(resolve(backups, 'file'));
    const backupStat = statIfPresent(backups);
    if (backupStat && (!backupStat.isDirectory() || backupStat.isSymbolicLink() ||
        (process.platform !== 'win32' && ((backupStat.mode & 0o077) || (backupStat.uid !== 0 && backupStat.uid !== process.getuid()))))) {
      throw new Error('unsafe backup directory');
    }
    if (!backupStat) {
      mkdirSync(backups, { mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(backups, 0o700);
    }
    const backup = resolve(backups, `v1-${randomBytes(16).toString('hex')}`);
    mkdirSync(backup, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(backup, 0o700);
    for (const file of changes) createPrivateFile(resolve(backup, basename(file.path)), file.old);
    for (const file of changes) {
      // Recheck immediately before replacement; retain backups on any failure.
      if (!checkExisting(file.path, file.old, file.label)) throw new Error(`existing ${file.label} disappeared`);
      const temporary = resolve(dirname(file.path), `.upgrade-${randomBytes(16).toString('hex')}`);
      createPrivateFile(temporary, file.data);
      if (!checkExisting(file.path, file.old, file.label)) throw new Error(`existing ${file.label} disappeared`);
      renameSync(temporary, file.path);
    }
  }
  for (const file of sharedFiles) if (!file.exists) createPrivateFile(file.path, file.data);
  if (!haveKey) createPrivateFile(keyPath, sourceKey);
  if (!haveRules) createPrivateFile(rulesPath, sourceRules);
  if (!hookStat) {
    mkdirSync(dirname(hook), { recursive: true });
    const fd = openSync(hook, 'wx', 0o700);
    try { writeFileSync(fd, shim, 'utf8'); if (process.platform !== 'win32') fchmodSync(fd, 0o700); } finally { closeSync(fd); }
    if (process.platform !== 'win32') accessSync(hook, constants.X_OK);
  }
  console.log(`sensitive-scan: ${hookStat ? 'already installed' : 'installed'} ${hook}`);
  console.log(`team public key SHA-256: ${keyIdFromPublicKey(packagedPublic)}`);
  console.log('The hook uses installed shared scripts; keep the Node executable in a trusted location.');
  console.log('Protect the extracted private directory and remove it manually after confirming installation.');
  if (process.env.SENSITIVE_SCAN_RULES || process.env.SENSITIVE_SCAN_KEY_FILE) {
    console.log('Ensure configuration environment variables are also available to Git and GUI clients.');
  }
} catch (error) {
  console.error(`sensitive-scan team-full-install: ${error.message}`);
  process.exit(1);
}
