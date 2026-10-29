#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { cleanMessage, createAttestation, formatTrailer, gitOutput, loadKeyPair, repoRoot, stripTrailer } from './lib.mjs';
import { decodeText, isIgnored, loadRules, scanBuffer, scanText } from './team-scan.mjs';

// All Git subprocesses, including lib.mjs helpers, must read original objects.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

const TEXT_LIMIT = 10 * 1024 * 1024;
const XLSX_LIMIT = 20 * 1024 * 1024;
const spreadsheets = new Set(['.xlsx', '.xlsm', '.xltx']);

function git(cwd, args, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync('git', args, { cwd, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
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

function addedLines(patch) {
  const lines = [];
  let hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { hunk = true; continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) lines.push(line.slice(1));
    else if (!line.startsWith('-') && !line.startsWith(' ') && !line.startsWith('\\')) hunk = false;
  }
  return lines;
}

try {
  const messageFile = process.argv[2];
  if (!messageFile) throw new Error('missing message');
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
  const stripped = stripTrailer(readFileSync(messageFile, 'utf8'));
  // Residual legacy v1/v2 trailer metadata must never become signed prose.
  if (/^Sensitive-Scan: v[12]\s*$[\s\S]*^Sensitive-Scan-Rules:/mi.test(stripped)) throw new Error('legacy trailer blocked');
  const body = cleanMessage(stripped);
  if (!body.trim() || scanText(body, rules).length) throw new Error('blocked');
  const mergePath = resolve(cwd, gitOutput(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd }).trim());
  if (existsSync(mergePath)) throw new Error('merge unsupported');
  const head = gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim();
  const parenttree = gitOutput(['rev-parse', `${head}^{tree}`], { cwd }).trim();
  const beforeTree = gitOutput(['write-tree'], { cwd }).trim();
  const pathsRaw = git(cwd, ['diff', '--ignore-submodules=none', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z', parenttree, beforeTree, '--']);
  const pathsText = new TextDecoder('utf-8', { fatal: true }).decode(pathsRaw);
  const files = pathsText.split('\0').filter(Boolean);
  for (const file of files) {
    if (isIgnored(file, rules)) continue;
    if (scanText(file, rules).length) throw new Error('blocked');
    const entries = new TextDecoder('utf-8', { fatal: true }).decode(git(cwd, ['ls-tree', '-r', '-z', '--full-tree', beforeTree, '--', `:(literal)${file}`])).split('\0').filter(Boolean);
    const entry = entries.length === 1 && /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entries[0]);
    if (!entry || entry[3] !== file) throw new Error('unsupported tree entry');
    const blob = entry[2];
    const xlsx = spreadsheets.has(extname(file).toLowerCase());
    const limit = xlsx ? XLSX_LIMIT : TEXT_LIMIT;
    const size = Number(git(cwd, ['cat-file', '-s', blob]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('blocked');
    const buffer = git(cwd, ['cat-file', 'blob', blob], limit + 1024);
    if (buffer.length !== size) throw new Error('blocked');
    if (xlsx) {
      const result = scanBuffer(buffer, file, rules);
      if (result.kind !== 'xlsx' || result.findings.length) throw new Error('blocked');
      continue;
    }
    const text = decodeText(buffer);
    if (text === null) throw new Error('blocked');
    if (process.env.DSH_HOOK_FULL === '1' || (buffer.length >= 2 && ((buffer[0] === 255 && buffer[1] === 254) || (buffer[0] === 254 && buffer[1] === 255)))) {
      if (scanText(text, rules).length) throw new Error('blocked');
    } else {
      const patch = git(cwd, ['diff', '--no-renames', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', parenttree, beforeTree, '--', `:(literal)${file}`]);
      const patchText = new TextDecoder('utf-8', { fatal: true }).decode(patch);
      if (addedLines(patchText).some(line => scanText(line, rules).length)) throw new Error('blocked');
    }
  }
  const tree = gitOutput(['write-tree'], { cwd }).trim();
  if (tree !== beforeTree || gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim() !== head || existsSync(mergePath)) throw new Error('scan baseline changed');
  const key = loadKeyPair(keyPath);
  const { fields } = createAttestation({ body, tree, parenttree, keyId: key.keyId, privateKey: key.privateKey });
  if (gitOutput(['write-tree'], { cwd }).trim() !== beforeTree || gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim() !== head || existsSync(mergePath)) throw new Error('scan baseline changed');
  writeFileSync(messageFile, formatTrailer(body, fields), 'utf8');
  console.error('sensitive-scan: clean; attestation written');
} catch {
  // Never print error messages: they can contain rule text, paths or key material.
  console.error('sensitive-scan: blocked; scan or signing could not complete');
  process.exitCode = 1;
}
