import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const decoder = new TextDecoder('utf-8', { fatal: true });
const full = (reason) => ({ run_platforms: true, reason });
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

// --raw -z emits alternating NUL-terminated metadata and path records.
// Refuse partial or malformed data instead of treating it as a smaller diff.
export function parseRawDiff(output) {
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

function isApprovedDocumentation({ path, status, oldMode, newMode }) {
  const approvedPath = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'].includes(path)
    || (path.startsWith('docs/') && path.endsWith('.md'));
  if (!approvedPath || !isPortablePath(path)) return false;
  // New paths (and thus renames) can introduce Windows checkout collisions.
  if (status === 'A') return false;
  if (status === 'D') return oldMode === '100644';
  return oldMode === '100644' && newMode === '100644';
}

export function classifyChanges({ eventName, event, githubSha, cwd = process.cwd(), gitRunner = runGit } = {}) {
  // The first rollout limits optimization to PRs; every other event runs fully.
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
    if (verifyRevision('HEAD^{commit}') !== githubSha.toLowerCase()) return full('checkout commit mismatch');
    if (verifyRevision('HEAD^{tree}') !== verifyRevision(`${head}^{tree}`)) return full('checkout tree mismatch');

    const shallow = decoder.decode(gitRunner(['rev-parse', '--is-shallow-repository'], cwd));
    if (shallow !== 'false\n') return full('incomplete Git history');

    const mergeBases = decoder.decode(gitRunner(['merge-base', '--all', base, head], cwd));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/u.test(mergeBases)) {
      return full('no unique merge base');
    }
    const mergeBase = mergeBases.slice(0, -1);
    if (!isObjectId(mergeBase)) return full('invalid merge base');
    if (mergeBase !== base.toLowerCase()) return full('PR base has advanced');

    const output = gitRunner([
      'diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff',
      '--no-textconv', '--ignore-submodules=none', '--no-relative', '--no-color',
      mergeBase, head, '--',
    ], cwd);
    const changes = parseRawDiff(output);
    if (changes.length === 0) return full('empty diff');
    if (!changes.every(isApprovedDocumentation)) return full('non-documentation or unsafe change');
    return { run_platforms: false, reason: 'documentation-only changes' };
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
    appendFileSync(process.env.GITHUB_OUTPUT, `run_platforms=${result.run_platforms}\n`, 'utf8');
  } catch {
    console.error('cannot write GITHUB_OUTPUT');
    process.exitCode = 1;
    return;
  }
  console.log(`platform checks: ${result.run_platforms ? 'run' : 'skip'} (${result.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
