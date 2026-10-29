#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto';
import { canonicalPayload, gitOutput, keyIdFromPublicKey, parseTrailer, sha256Hex } from './lib.mjs';

// Do not allow local replace refs to change the base key or commit objects.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

export const TEAM_PUBLIC_KEY_PATH = '.github/sensitive-scan/team-public-key.pub';

function usage() {
  return `usage: node scripts/sensitive-scan/verify.mjs --base <rev> --head <rev>

Verifies signed tree and message bindings using the one team public key from
--base. No source files or local sensitive rules are scanned by this command.`;
}

function parseArgs(argv) {
  const args = { base: '', head: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') args.base = argv[++index] ?? '';
    else if (value === '--head') args.head = argv[++index] ?? '';
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function loadTeamPublicKey(args) {
  let raw;
  try {
    raw = gitOutput(['show', `${args.base}:${TEAM_PUBLIC_KEY_PATH}`]);
  } catch (error) {
    throw new Error(`cannot read team public key: ${error.message}`);
  }
  let key;
  try {
    key = createPublicKey(raw);
  } catch (error) {
    throw new Error(`invalid team public key: ${error.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('team public key must be Ed25519');
  return key;
}

function parseCommit(sha) {
  const raw = gitOutput(['cat-file', 'commit', sha]);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) throw new Error(`${sha}: malformed commit object`);
  const headers = raw.slice(0, separator).split('\n');
  const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  if (!tree) throw new Error(`${sha}: commit has no tree`);
  return { tree, parents, message: raw.slice(separator + 2) };
}

function verifyCommit(sha, publicKey) {
  const commit = parseCommit(sha);
  if (commit.parents.length !== 1) throw new Error('exactly one parent commit is required');
  const parsed = parseTrailer(commit.message);
  if (!parsed) throw new Error('missing Sensitive-Scan trailer');
  const { fields, body } = parsed;
  if (fields.version !== 'v2') throw new Error('v2 attestation required');
  if (!body.trim()) throw new Error('empty commit message body');
  if (fields.tree !== commit.tree) throw new Error('attestation tree does not match commit tree');
  if (fields.message !== sha256Hex(body)) throw new Error('attestation message digest does not match commit message');
  if (fields.key !== keyIdFromPublicKey(publicKey)) throw new Error('attestation key does not match team public key');
  const payload = canonicalPayload({
    version: fields.version, tree: fields.tree, parenttree: fields.parenttree, message: fields.message, rules: fields.rules,
    scanner: fields.scanner, time: fields.time, nonce: fields.nonce,
  });
  if (!verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(fields.sig, 'base64'))) {
    throw new Error('signature verification failed');
  }
  const parentTree = gitOutput(['rev-parse', `${commit.parents[0]}^{tree}`]).trim();
  if (fields.parenttree !== parentTree) throw new Error('attestation parent-tree does not match parent commit tree');
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.base || !args.head) throw new Error('--base and --head are required');
  const publicKey = loadTeamPublicKey(args);
  const commits = gitOutput(['rev-list', '--reverse', `${args.base}..${args.head}`]).split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error(`no commits in ${args.base}..${args.head}`);
  const failures = [];
  for (const sha of commits) {
    try {
      verifyCommit(sha, publicKey);
    } catch (error) {
      failures.push(`${sha.slice(0, 12)}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.error(`sensitive-attestation: ${failures.length}/${commits.length} commit(s) rejected`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`sensitive-attestation: ${commits.length} commit(s) verified`);
} catch (error) {
  console.error(`sensitive-attestation: ${error.message}`);
  process.exit(1);
}
