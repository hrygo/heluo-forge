import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAttestation,
  formatTrailer,
  keyIdFromPublicKey,
  parseTrailer,
  rulesDigest,
  sha256Hex,
  stripTrailer,
} from '../scripts/sensitive-scan/lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const COMMIT_MSG = join(ROOT, 'scripts/sensitive-scan/commit-msg.mjs');
const VERIFY = join(ROOT, 'scripts/sensitive-scan/verify.mjs');
const INSTALL = join(ROOT, 'scripts/sensitive-scan/install-hook.mjs');

function git(cwd, args, options = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
}

function gitOk(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeRules(dir) {
  const path = join(dir, 'rules.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      rules: [{ id: 'synthetic-token', pattern: 'SECRET-[A-Z0-9]{8}', flags: 'g', severity: 'high' }],
    }),
  );
  return path;
}

function writeDeviceKey(dir) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'device-key.pem');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return {
    privatePath,
    entry: {
      keyId: keyIdFromPublicKey(publicKey),
      owner: 'test-user',
      status: 'active',
      notBefore: new Date(Date.now() - 60_000).toISOString(),
      notAfter: null,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  };
}

function writeRegistry(repo, entry, rules) {
  const dir = join(repo, '.github', 'sensitive-scan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({ version: 1, keys: [entry] }, null, 2));
  writeFileSync(
    join(dir, 'allowed-rules.json'),
    JSON.stringify(
      {
        version: 1,
        rules: [{ digest: rulesDigest(rules), policyId: 'test-policy' }],
        scanners: ['heluo-sensitive-scan@1.0.0'],
      },
      null,
      2,
    ),
  );
  return dir;
}

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sensitive-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  gitOk(repo, ['init', '-q']);
  gitOk(repo, ['config', 'user.email', 'test-user']);
  gitOk(repo, ['config', 'user.name', 'Test']);
  return { dir, repo };
}

function commitSigned(repo, message, env) {
  const messagePath = join(repo, '.git', 'message.txt');
  writeFileSync(messagePath, `${message}\n`);
  const result = spawnSync(process.execPath, [COMMIT_MSG, messagePath], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`commit-msg failed: ${result.stderr}`);
  const committed = git(repo, ['commit', '--no-verify', '-q', '-F', messagePath]);
  if (committed.status !== 0) throw new Error(`git commit failed: ${committed.stderr}`);
  return gitOk(repo, ['rev-parse', 'HEAD']);
}

test('attestation signature is bound to tree and message', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const entry = { keyId: keyIdFromPublicKey(publicKey) };
  const body = 'test\n';
  const attestation = createAttestation({
    body,
    tree: 'a'.repeat(40),
    rules: 'b'.repeat(64),
    keyId: entry.keyId,
    privateKey,
  });
  const parsed = parseTrailer(formatTrailer(body, attestation.fields));
  assert.equal(parsed.fields.tree, 'a'.repeat(40));
  assert.equal(parsed.fields.message, sha256Hex(body));
  assert.equal(stripTrailer(formatTrailer(body, attestation.fields)), body);
  assert.notEqual(parsed.fields.sig, '');
});

test('install-hook writes an executable managed commit-msg shim', () => {
  const { dir, repo } = newRepo();
  try {
    const result = spawnSync(process.execPath, [INSTALL], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    assert.match(readFileSync(hook, 'utf8'), /managed by scripts\/sensitive-scan/);
    if (process.platform !== 'win32') assert.notEqual(statSync(hook).mode & 0o111, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit-msg blocks a synthetic sensitive finding and writes no trailer', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    writeFileSync(join(repo, 'secret.txt'), 'SECRET-ABC12345\n');
    gitOk(repo, ['add', 'secret.txt']);
    const messagePath = join(repo, '.git', 'message.txt');
    writeFileSync(messagePath, 'blocked\n');
    const result = spawnSync(process.execPath, [COMMIT_MSG, messagePath], {
      cwd: repo,
      env: { ...process.env, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key.privatePath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /blocked/);
    assert.doesNotMatch(readFileSync(messagePath, 'utf8'), /Sensitive-Scan: v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit-msg blocks a sensitive finding in the commit message itself', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    writeFileSync(join(repo, 'safe.txt'), 'safe\n');
    gitOk(repo, ['add', 'safe.txt']);
    const messagePath = join(repo, '.git', 'message.txt');
    writeFileSync(messagePath, 'message SECRET-ABC12345\n');
    const result = spawnSync(process.execPath, [COMMIT_MSG, messagePath], {
      cwd: repo,
      env: { ...process.env, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key.privatePath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commit-message:1/);
    assert.doesNotMatch(readFileSync(messagePath, 'utf8'), /Sensitive-Scan: v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier accepts a clean signed commit and rejects a reused trailer on another tree', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    const registryDir = writeRegistry(repo, key.entry, rules);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    gitOk(repo, ['add', '.']);
    gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'base']);
    const base = gitOk(repo, ['rev-parse', 'HEAD']);

    writeFileSync(join(repo, 'safe.txt'), 'safe\n');
    gitOk(repo, ['add', 'safe.txt']);
    const signed = commitSigned(repo, 'signed', {
      SENSITIVE_SCAN_RULES: rules,
      SENSITIVE_SCAN_KEY_FILE: key.privatePath,
    });

    const env = { ...process.env };
    const verify = (head) =>
      spawnSync(
        process.execPath,
        [
          VERIFY,
          '--base',
          base,
          '--head',
          head,
          '--registry-file',
          join(registryDir, 'keys.json'),
          '--rules-file',
          join(registryDir, 'allowed-rules.json'),
        ],
        { cwd: repo, env, encoding: 'utf8' },
      );

    const passed = verify(signed);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /1 commit\(s\) verified/);

    const fromBase = spawnSync(
      process.execPath,
      [VERIFY, '--base', base, '--head', signed],
      { cwd: repo, env, encoding: 'utf8' },
    );
    assert.equal(fromBase.status, 0, fromBase.stderr);
    assert.match(fromBase.stdout, /1 commit\(s\) verified/);

    const registryPath = join(registryDir, 'keys.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.keys[0].status = 'revoked';
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    const revoked = verify(signed);
    assert.equal(revoked.status, 1);
    assert.match(revoked.stderr, /inactive key/);
    registry.keys[0].status = 'active';
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    writeFileSync(join(repo, 'safe.txt'), 'tampered\n');
    gitOk(repo, ['add', 'safe.txt']);
    const messagePath = join(repo, '.git', 'message.txt');
    writeFileSync(messagePath, 'tampered\n');
    const trailer = gitOk(repo, ['show', '-s', '--format=%B', signed]);
    writeFileSync(messagePath, `${trailer}\n`);
    gitOk(repo, ['commit', '--no-verify', '-q', '-F', messagePath]);
    const tampered = gitOk(repo, ['rev-parse', 'HEAD']);
    const rejected = verify(tampered);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /tree does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
