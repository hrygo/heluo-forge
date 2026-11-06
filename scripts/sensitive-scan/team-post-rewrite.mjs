#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { gitOutput, loadKeyPair, parseTrailer, sha256Hex, stripTrailer } from './lib.mjs';
import { scanChange, signMessage } from './team-attest.mjs';
import { gitRaw, loadGuardContext } from './team-guard.mjs';
import { scanText } from './team-scan.mjs';

// Git invokes this hook after `git commit --amend` and after `git rebase`.
// Both rewrite commits, which invalidates the parent-tree binding in the trailer
// the commit-msg hook wrote; re-scanning and re-signing here removes the manual
// rebuild the team otherwise has to do for every replayed commit.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

function readPairs(input) {
  const pairs = [];
  for (const line of String(input).split('\n')) {
    const [oldSha, newSha] = line.trim().split(/\s+/);
    if (oldSha && newSha) pairs.push([oldSha, newSha]);
  }
  return pairs;
}

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  // A re-signing pass must never recurse if a future Git release re-enters hooks
  // for the object writes below.
  if (process.env.SENSITIVE_SCAN_RESIGN === '1') return 0;
  const pairs = readPairs(input);
  if (!pairs.length) return 0;

  const { cwd, rules, keyPath } = loadGuardContext();
  const key = loadKeyPair(keyPath);
  const rewritten = new Set(pairs.map(([, newSha]) => newSha));
  const results = new Map();

  const rewrite = (sha) => {
    const raw = gitRaw(cwd, ['cat-file', 'commit', sha]);
    const split = raw.indexOf('\n\n');
    if (split < 0) throw new Error('malformed commit');
    const headers = raw.subarray(0, split);
    const message = raw.subarray(split + 2).toString('utf8');
    const headerText = headers.toString('utf8');
    const tree = /^tree ([0-9a-f]+)$/m.exec(headerText)?.[1];
    const parents = [...headerText.matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1]);
    if (!tree) throw new Error('malformed commit');
    // Root and merge commits have no single scanned baseline; leave them alone
    // rather than inventing an attestation for a diff nobody scanned.
    if (parents.length !== 1) return { ok: true, sha, skipped: true };
    let parent = parents[0];
    if (rewritten.has(parent)) {
      const upstream = visit(parent);
      if (!upstream.ok) throw new Error('upstream not signed');
      parent = upstream.sha;
    }
    const parentTree = gitOutput(['rev-parse', `${parent}^{tree}`], { cwd }).trim();
    const body = stripTrailer(message);
    if (!body.trim()) throw new Error('empty message');
    const current = parseTrailer(message);
    const valid = Boolean(current) && current.fields.version === 'v2' && current.fields.tree === tree &&
      current.fields.parenttree === parentTree && current.fields.message === sha256Hex(body);
    if (valid && parent === parents[0]) return { ok: true, sha };
    let trailer = message;
    if (!valid) {
      if (scanText(body, rules).length) throw new Error('blocked');
      scanChange({ cwd, parentTree, tree, rules });
      trailer = signMessage({ body, tree, parentTree, key });
    }
    // The replay points the commit at its new parent; reusing the old header
    // block would leave the rewritten tip attached to a dangling commit.
    const remapped = headerText.replace(/^parent [0-9a-f]+$/m, `parent ${parent}`);
    const next = gitRaw(cwd, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      input: Buffer.concat([Buffer.from(remapped, 'utf8'), Buffer.from('\n\n'), Buffer.from(trailer, 'utf8')]),
    }).toString('utf8').trim();
    return { ok: true, sha: next };
  };

  const visit = (sha) => {
    const cached = results.get(sha);
    if (cached) return cached;
    let result;
    try {
      result = rewrite(sha);
    } catch {
      // Never print error messages: they can contain rule text or paths.
      result = { ok: false, sha };
    }
    results.set(sha, result);
    return result;
  };

  for (const [, newSha] of pairs) visit(newSha);

  const reSigned = [...results].filter(([from, result]) => result.ok && result.sha !== from);
  const failed = [...results].filter(([, result]) => !result.ok);
  const tip = gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim();
  const head = results.get(tip);
  // Move the branch only when the whole replayed chain signed; a partial chain
  // would leave unsigned commits reachable with no marker pointing at them.
  const moved = Boolean(head?.ok) && head.sha !== tip && !failed.length;
  if (moved) {
    gitOutput(['update-ref', '-m', 'sensitive-scan: re-sign after rewrite', 'HEAD', head.sha], { cwd });
    console.error(`sensitive-scan: re-signed ${reSigned.length} commit(s) after rewrite`);
  } else if (reSigned.length && head?.skipped) {
    console.error('sensitive-scan: a merge commit sits at the rewritten tip; merges are never signed, so the branch was not updated');
  }
  if (failed.length) {
    console.error(`sensitive-scan: ${failed.length} commit(s) not signed; run scripts/sensitive-scan/verify.mjs to locate them`);
    for (const [sha] of failed) console.error(`- ${sha.slice(0, 12)}`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch {
  console.error('sensitive-scan: blocked; rewrite could not be re-signed');
  process.exitCode = 1;
}
