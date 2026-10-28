#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto';
import {
  SCANNER_ID,
  canonicalPayload,
  gitOutput,
  loadAllowedRules,
  loadRegistry,
  parseTrailer,
  readJsonFromGit,
  sha256Hex,
} from './lib.mjs';

export const REGISTRY_PATH = '.github/sensitive-scan/keys.json';
export const ALLOWED_RULES_PATH = '.github/sensitive-scan/allowed-rules.json';
const MAX_FUTURE_SKEW_SECONDS = 300;

function usage() {
  return `usage: node scripts/sensitive-scan/verify.mjs --base <rev> --head <rev> [options]

Options:
  --max-age-days <n>     reject attestations older than n days (default: 30)
  --registry-file <f>    use a local registry file instead of the base ref
  --rules-file <f>       use a local allowlist file instead of the base ref
  --registry-ref <rev>   git ref for the registry (default: --base)
  --rules-ref <rev>      git ref for the allowlist (default: --base)

This command never scans code. It verifies local-scanner signatures bound to
the commit tree and message against public keys and an allowlisted rules digest.`;
}

function parseArgs(argv) {
  const args = {
    base: '',
    head: '',
    maxAgeDays: 30,
    registryFile: '',
    rulesFile: '',
    registryRef: '',
    rulesRef: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') args.base = argv[++index] ?? '';
    else if (value === '--head') args.head = argv[++index] ?? '';
    else if (value === '--max-age-days') args.maxAgeDays = Number(argv[++index]);
    else if (value === '--registry-file') args.registryFile = argv[++index] ?? '';
    else if (value === '--rules-file') args.rulesFile = argv[++index] ?? '';
    else if (value === '--registry-ref') args.registryRef = argv[++index] ?? '';
    else if (value === '--rules-ref') args.rulesRef = argv[++index] ?? '';
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  args.registryRef ||= args.base;
  args.rulesRef ||= args.base;
  return args;
}

function parseCommit(sha) {
  const raw = gitOutput(['cat-file', 'commit', sha]);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) throw new Error(`${sha}: malformed commit object`);
  const headers = raw.slice(0, separator).split('\n');
  const message = raw.slice(separator + 2);
  const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  if (!tree) throw new Error(`${sha}: commit has no tree`);
  return { tree, parents, message };
}

function assertAllowed(value, label) {
  if (value?.version !== 1 || !Array.isArray(value.rules) || !Array.isArray(value.scanners)) {
    throw new Error(`${label}: expected { version: 1, rules: [...], scanners: [...] }`);
  }
  return value;
}

function assertAllowedRegistry(value, label) {
  if (value?.version !== 1 || !Array.isArray(value.keys)) {
    throw new Error(`${label}: expected { version: 1, keys: [...] }`);
  }
  return value;
}

function verifyCommit(sha, { registry, allowed, maxAgeDays, now }) {
  const commit = parseCommit(sha);
  if (commit.parents.length > 1) {
    throw new Error('merge commit has no local attestation; use rebase merge and linear history');
  }

  const parsed = parseTrailer(commit.message);
  if (!parsed) throw new Error('missing Sensitive-Scan trailer');
  const { fields, body } = parsed;
  if (!body.trim()) throw new Error('empty commit message body');

  const entry = registry.keys.find((candidate) => candidate.keyId === fields.key);
  if (!entry) throw new Error(`unknown key: ${fields.key}`);
  if (entry.status !== 'active') throw new Error(`inactive key: ${fields.key}`);
  const notBefore = Date.parse(entry.notBefore);
  const notAfter = entry.notAfter ? Date.parse(entry.notAfter) : null;
  const nowMs = now * 1000;
  if (Number.isNaN(notBefore) || (notAfter !== null && Number.isNaN(notAfter))) {
    throw new Error(`invalid key validity window: ${fields.key}`);
  }
  if (nowMs + 300000 < notBefore) throw new Error(`key not valid yet: ${fields.key}`);
  if (notAfter !== null && nowMs > notAfter) throw new Error(`key expired: ${fields.key}`);

  if (fields.tree !== commit.tree) throw new Error('attestation tree does not match commit tree');
  if (fields.message !== sha256Hex(body)) throw new Error('attestation message digest does not match commit message');
  if (!allowed.rules.some((rule) => rule.digest === fields.rules)) {
    throw new Error(`rules digest is not allowlisted: ${fields.rules}`);
  }
  if (!allowed.scanners.includes(fields.scanner)) {
    throw new Error(`scanner is not allowlisted: ${fields.scanner}`);
  }
  if (fields.scanner !== SCANNER_ID) throw new Error(`unexpected scanner: ${fields.scanner}`);

  const time = Number(fields.time);
  if (!Number.isSafeInteger(time) || time <= 0) throw new Error('invalid attestation time');
  if (time > now + MAX_FUTURE_SKEW_SECONDS) throw new Error('attestation time is in the future');
  if (now - time > maxAgeDays * 86400) throw new Error(`attestation is older than ${maxAgeDays} days`);

  const payload = canonicalPayload({
    tree: fields.tree,
    message: fields.message,
    rules: fields.rules,
    scanner: fields.scanner,
    time: fields.time,
    nonce: fields.nonce,
  });
  let publicKey;
  try {
    publicKey = createPublicKey(entry.publicKey);
  } catch (error) {
    throw new Error(`invalid public key for ${fields.key}: ${error.message}`);
  }
  const valid = verify(
    null,
    Buffer.from(payload, 'utf8'),
    publicKey,
    Buffer.from(fields.sig, 'base64'),
  );
  if (!valid) throw new Error('signature verification failed');
  return { fields, body };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.base || !args.head) throw new Error('--base and --head are required');
  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays <= 0) throw new Error('--max-age-days must be positive');

  const registry = args.registryFile
    ? loadRegistry(args.registryFile)
    : assertAllowedRegistry(readJsonFromGit(args.registryRef, REGISTRY_PATH, 'key registry'), REGISTRY_PATH);
  const allowed = args.rulesFile
    ? loadAllowedRules(args.rulesFile)
    : assertAllowed(readJsonFromGit(args.rulesRef, ALLOWED_RULES_PATH, 'rules allowlist'), ALLOWED_RULES_PATH);

  const commits = gitOutput(['rev-list', '--reverse', `${args.base}..${args.head}`])
    .split('\n')
    .filter(Boolean);
  if (commits.length === 0) throw new Error(`no commits in ${args.base}..${args.head}`);

  const failures = [];
  const now = Math.floor(Date.now() / 1000);
  for (const sha of commits) {
    try {
      verifyCommit(sha, { registry, allowed, maxAgeDays: args.maxAgeDays, now });
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
