#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitOutput } from './lib.mjs';

// Git feeds "<local ref> <local sha> <remote ref> <remote sha>" for every ref a
// push would move. Checking that range here turns a broken commit into a refused
// push instead of a red required check minutes later. Standard input stays
// connected because the installed shim forwards it.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

const ZERO = /^0{40,64}$/;
const verifier = resolve(import.meta.dirname, 'verify.mjs');

function pushedBranches(input) {
  const branches = [];
  for (const line of String(input).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    // Tags and deletions carry no commits of their own.
    if (!localRef.startsWith('refs/heads/') || remoteRef.startsWith('refs/tags/') || ZERO.test(localSha)) continue;
    branches.push({ name: localRef.slice('refs/heads/'.length), localSha, remoteSha });
  }
  return branches;
}

function baseFor(branch) {
  // An existing remote ref gives the exact set of commits this push adds; a new
  // branch is compared against the same baseline the pull-request check uses.
  if (branch.remoteSha && !ZERO.test(branch.remoteSha)) return branch.remoteSha;
  for (const candidate of ['origin/main', 'origin/HEAD', 'main']) {
    try {
      return gitOutput(['rev-parse', '--verify', `${candidate}^{commit}`]).trim();
    } catch {
      // Try the next conventional baseline name.
    }
  }
  return '';
}

function rejected(branch) {
  const base = baseFor(branch);
  if (!base || base === branch.localSha) return '';
  try {
    if (gitOutput(['rev-list', '--count', `${base}..${branch.localSha}`]).trim() === '0') return '';
  } catch {
    return '';
  }
  try {
    execFileSync(process.execPath, [verifier, '--base', base, '--head', branch.localSha], { stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (error) {
    // The verifier reports short commit ids and reasons only; never file content.
    return String(error.stderr ?? '').trim() || 'verification failed';
  }
}

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  const failures = [];
  for (const branch of pushedBranches(input)) {
    const detail = rejected(branch);
    if (detail) failures.push({ branch, detail });
  }
  if (!failures.length) return 0;
  for (const { branch, detail } of failures) {
    console.error(`sensitive-scan: ${branch.name} was not pushed`);
    for (const line of detail.split('\n')) console.error(`  ${line}`);
  }
  console.error('sensitive-scan: push blocked; run git rebase to re-sign the branch, then push again');
  return 1;
}

try {
  process.exitCode = main();
} catch {
  console.error('sensitive-scan: blocked; push could not be verified');
  process.exitCode = 1;
}