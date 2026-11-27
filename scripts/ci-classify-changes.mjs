import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const decoder = new TextDecoder('utf-8', { fatal: true });
const full = (reason) => ({ run_platforms: true, run_windows_arm64: true, reason });
const isObjectId = (value) => typeof value === 'string'
  && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
  && !/^0+$/u.test(value);

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// NUL-separated Git output is either refused as malformed or fully parsed;
// a partial record must never be read as a smaller change set.
function nulFields(output) {
  if (!Buffer.isBuffer(output)) throw new Error('invalid Git output');
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error('truncated Git output');
  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(decoder.decode(output.subarray(start, index)));
      start = index + 1;
    }
  }
  return fields;
}

// --raw -z emits alternating NUL-terminated metadata and path records.
export function parseRawDiff(output) {
  const fields = nulFields(output);
  if (fields.length % 2 !== 0) throw new Error('incomplete Git record');

  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMD])$/u.exec(fields[index]);
    const path = fields[index + 1];
    if (!match || !path || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('invalid Git record');
    }
    const [, oldMode, newMode, oldId, newId, status] = match;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oldId) || oldId.length !== newId.length) {
      throw new Error('invalid Git object ID');
    }
    const oldZero = /^0+$/u.test(oldId);
    const newZero = /^0+$/u.test(newId);
    const validTransition = status === 'A'
      ? oldMode === '000000' && oldZero && newMode !== '000000' && !newZero
      : status === 'D'
        ? oldMode !== '000000' && !oldZero && newMode === '000000' && newZero
        : oldMode !== '000000' && !oldZero && newMode !== '000000' && !newZero;
    if (!validTransition) throw new Error('invalid Git transition');
    entries.push({ path, status, oldMode, newMode });
  }
  return entries;
}

function isPortablePath(path) {
  return path.split('/').every((part) => part.length <= 255
    && !/[\u0000-\u001f\u007f-\u009f<>:"\\|?*]/u.test(part)
    && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/iu.test(part));
}

// Windows compares names through a case table and default macOS volumes fold
// Unicode normalization too, so two distinct Git paths can name one file
// there. Folding to both letter cases keeps pairs such as U+03C3/U+03C2
// (sigma) that only one direction maps together; over-matching can only force
// a full run, never a wrong skip.
const foldKeys = (path) => {
  const normalized = path.normalize('NFC');
  return [...new Set([normalized.toLowerCase(), normalized.toUpperCase()])];
};

function createTreeIndex(paths) {
  const byFoldedName = new Map();
  const directories = new Set();
  const indexName = (keys, path) => {
    for (const key of keys) {
      const names = byFoldedName.get(key);
      if (names) names.push(path);
      else byFoldedName.set(key, [path]);
    }
  };
  for (const path of paths) {
    indexName(foldKeys(path), path);
    let separator = path.indexOf('/');
    while (separator !== -1) {
      for (const key of foldKeys(path.slice(0, separator))) directories.add(key);
      separator = path.indexOf('/', separator + 1);
    }
  }
  return { byFoldedName, directories };
}

// A new path that folds onto an existing file, onto an existing directory, or
// whose parent would have to replace an existing file makes the checked-out
// tree differ from the committed tree on a case-insensitive volume.
function collidesWithTree(index, path) {
  for (const key of foldKeys(path)) {
    const names = index.byFoldedName.get(key);
    if (names && names.some((name) => name !== path)) return true;
    if (index.directories.has(key)) return true;
  }
  let separator = path.indexOf('/');
  while (separator !== -1) {
    // Git cannot hold a file and a directory at one literal path, so a file at
    // one of these prefixes can only be a folding collision.
    for (const key of foldKeys(path.slice(0, separator))) {
      if (index.byFoldedName.has(key)) return true;
    }
    separator = path.indexOf('/', separator + 1);
  }
  return false;
}

const APPROVED_ROOT_DOCS = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md']);

const ISOLATED_NON_PLATFORM_PREFIXES = [
  '.agents/skills/',
  'deploy/',
  'services/forge-desktop/',
];

// Windows ARM64 runs the credential/IAM subset and uses enterprise patch fixtures.
const WINDOWS_ARM64_PACKAGES = new Set(['forge-brand', 'forge-credentials-keychain', 'forge-enterprise', 'forge-iam', 'forge-policy']);

const ISOLATED_NON_PLATFORM_FILES = new Set([
  'scripts/build-desktop-installer.mjs',
  'scripts/derive-brand-icons.mjs',
  'scripts/stage-desktop-payload.mjs',
  'scripts/stage-primary-runtime.mjs',
  'scripts/lib/desktop-after-pack.mjs',
  'scripts/lib/primary-runtime.mjs',
  'scripts/lib/primary-runtime-smoke.py',
  'scripts/lib/zip-archive.mjs',
  'scripts/probe/primary-runtime-probe-plugin.mjs',
  'scripts/probe/run-primary-runtime-probe.mjs',
  'tests/build-desktop-installer.test.mjs',
  'tests/derive-brand-icons.test.mjs',
  'tests/desktop-shell-contract.test.mjs',
  'tests/stage-desktop-payload.test.mjs',
  'tests/stage-primary-runtime.test.mjs',
  'tests/zip-archive.test.mjs',
  'tests/fixtures/primary-runtime-helpers.mjs',
  'tests/fixtures/zip-writer.mjs',
]);

function isApprovedDocPath(path) {
  return APPROVED_ROOT_DOCS.has(path) || (path.startsWith('docs/') && path.endsWith('.md'));
}

function isIsolatedNonPlatformPath(path) {
  return isApprovedDocPath(path)
    || ISOLATED_NON_PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix))
    || ISOLATED_NON_PLATFORM_FILES.has(path);
}

function isPortableRegularChange({ path, status, oldMode, newMode }, tree) {
  if (!isPortablePath(path)) return false;
  if (status === 'A') return newMode === '100644' && tree !== null && !collidesWithTree(tree, path);
  if (status === 'D') return oldMode === '100644';
  return oldMode === '100644' && newMode === '100644';
}

function canSkipWindowsArm64({ path }) {
  if (isIsolatedNonPlatformPath(path)) return true;
  const extension = /^packages\/(forge-[a-z0-9-]+)\//u.exec(path)?.[1];
  return extension !== undefined && !WINDOWS_ARM64_PACKAGES.has(extension) && !path.endsWith('/package.json');
}

export function classifyChanges({ eventName, event, githubSha, cwd = process.cwd(), gitRunner = runGit } = {}) {
  // The optimization is limited to PRs; every other event runs fully.
  if (eventName !== 'pull_request') return full('event requires full platform checks');
  const base = event?.pull_request?.base?.sha;
  const head = event?.pull_request?.head?.sha;
  if (!isObjectId(base) || !isObjectId(head)) return full('missing or invalid PR revisions');
  if (!isObjectId(githubSha)) return full('missing or invalid checkout revision');

  try {
    const verifyRevision = (revision) => {
      const output = decoder.decode(gitRunner(['rev-parse', '--verify', revision], cwd));
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/u.test(output)) throw new Error('invalid Git object ID');
      const id = output.slice(0, -1);
      if (!isObjectId(id)) throw new Error('invalid Git object ID');
      return id;
    };
    const checkout = verifyRevision('HEAD^{commit}');
    if (checkout !== githubSha.toLowerCase()) return full('checkout commit mismatch');

    // A pull_request checkout is either the PR head itself or GitHub's
    // synthetic merge of the base tip and that head. Its identity is proven by
    // the commit graph, not by comparing trees: the merge tree legitimately
    // differs from the head tree whenever the base branch has advanced.
    if (checkout !== head.toLowerCase()) {
      const parents = decoder.decode(gitRunner(['rev-list', '--parents', '-n', '1', checkout], cwd))
        .trim().split(/ +/u);
      if (parents.length !== 3 || parents[0] !== checkout
        || parents[1] !== base.toLowerCase() || parents[2] !== head.toLowerCase()) {
        return full('checkout is not the PR head or its merge');
      }
    }

    const shallow = decoder.decode(gitRunner(['rev-parse', '--is-shallow-repository'], cwd));
    if (shallow !== 'false\n') return full('incomplete Git history');

    const mergeBases = decoder.decode(gitRunner(['merge-base', '--all', base, head], cwd));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/u.test(mergeBases)) {
      return full('no unique merge base');
    }
    // GitHub checks out a merge commit for pull requests, and the diff below
    // against its first parent is then exactly the PR diff. A plain head
    // checkout is only classifiable while the base tip is an ancestor of that
    // head; otherwise the diff would also revert the base branch's own work.
    if (checkout === head.toLowerCase() && mergeBases.slice(0, -1) !== base.toLowerCase()) {
      return full('PR base has advanced');
    }

    // The base tip is the baseline the platform jobs already covered on its
    // own push run; the diff against it is what this PR adds to that baseline.
    const output = gitRunner([
      'diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff',
      '--no-textconv', '--ignore-submodules=none', '--no-relative', '--no-color',
      base, checkout, '--',
    ], cwd);
    const changes = parseRawDiff(output);
    if (changes.length === 0) return full('empty diff');
    const tree = changes.some(({ status }) => status === 'A')
      ? createTreeIndex(nulFields(gitRunner(['ls-tree', '-r', '-z', '--name-only', '--full-tree', checkout], cwd)))
      : null;
    if (!changes.every((entry) => isPortableRegularChange(entry, tree))) {
      return full('non-isolated or unsafe change');
    }
    if (!changes.every(({ path }) => isIsolatedNonPlatformPath(path))) {
      return { ...full('non-isolated or unsafe change'), run_windows_arm64: !changes.every(canSkipWindowsArm64) };
    }
    return {
      run_platforms: false,
      run_windows_arm64: false,
      reason: changes.every(({ path }) => isApprovedDocPath(path)) ? 'documentation-only changes' : 'isolated non-platform changes',
    };
  } catch {
    return full('Git comparison unavailable or invalid');
  }
}

function main() {
  if (!process.env.GITHUB_OUTPUT) {
    console.error('GITHUB_OUTPUT is required');
    process.exitCode = 1;
    return;
  }
  let event = null;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    // Invalid or unavailable PR payloads must result in full checks.
  }
  const result = classifyChanges({ eventName: process.env.GITHUB_EVENT_NAME, event, githubSha: process.env.GITHUB_SHA });
  try {
    appendFileSync(process.env.GITHUB_OUTPUT, `run_platforms=${result.run_platforms}\nrun_windows_arm64=${result.run_windows_arm64}\n`, 'utf8');
  } catch {
    console.error('cannot write GITHUB_OUTPUT');
    process.exitCode = 1;
    return;
  }
  console.log(`platform checks: ${result.run_platforms ? 'run' : 'skip'} (${result.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
