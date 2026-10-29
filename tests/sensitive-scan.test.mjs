import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAttestation,
  formatTrailer,
  keyIdFromPublicKey,
  normalizeMessage,
  parseTrailer,
  sha256Hex,
  stripTrailer,
} from '../scripts/sensitive-scan/lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const COMMIT_MSG = join(ROOT, 'scripts/sensitive-scan/commit-msg.mjs');
const VERIFY = join(ROOT, 'scripts/sensitive-scan/verify.mjs');
const INSTALL = join(ROOT, 'scripts/sensitive-scan/install-hook.mjs');
const KEYGEN = join(ROOT, 'scripts/sensitive-scan/keygen.mjs');

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

function writeTeamPublicKey(repo, entry) {
  const dir = join(repo, '.github', 'sensitive-scan');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'team-public-key.pub');
  writeFileSync(path, entry.publicKey);
  return path;
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
  const parsed = parseTrailer(readFileSync(messagePath, 'utf8'));
  const privateKey = createPrivateKey(readFileSync(env.SENSITIVE_SCAN_KEY_FILE));
  const parenttree = gitOk(repo, ['rev-parse', 'HEAD^{tree}']);
  const { fields } = createAttestation({ body: parsed.body, tree: parsed.fields.tree, parenttree, rules: parsed.fields.rules, keyId: parsed.fields.key, privateKey });
  writeFileSync(messagePath, formatTrailer(parsed.body, fields));
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

test('normalizeMessage folds CRLF before hashing', () => {
  assert.equal(normalizeMessage('subject\r\n\r\nbody\r\n'), 'subject\n\nbody\n');
});

test('stripTrailer does not truncate body content when the marker is embedded', () => {
  const message = 'subject\n\nSensitive-Scan: v1\nnot a trailer\n';
  assert.equal(stripTrailer(message), 'subject\n\nSensitive-Scan: v1\nnot a trailer\n');
  assert.throws(() => parseTrailer(message), /unexpected line/);
});

test('stripTrailer replaces v1 and v2 trailers without truncating prose', () => {
  const keys = generateKeyPairSync('ed25519');
  const body = 'subject\n\nSensitive-Scan: v2\nnot a trailer\n';
  for (const parenttree of [undefined, 'c'.repeat(40)]) {
    const fields = createAttestation({ body, tree: 'a'.repeat(40), parenttree, rules: 'b'.repeat(64), keyId: keyIdFromPublicKey(keys.publicKey), privateKey: keys.privateKey }).fields;
    const text = formatTrailer(body, fields);
    assert.equal(stripTrailer(text), body);
    assert.equal(parseTrailer(text).fields.version, parenttree ? 'v2' : 'v1');
  }
});

test('commit-msg blocks large and binary files instead of signing a partial scan', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    const messagePath = join(repo, '.git', 'message.txt');
    const env = { ...process.env, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key.privatePath };

    writeFileSync(join(repo, 'large.txt'), Buffer.concat([
      Buffer.alloc(1024 * 1024 + 512, 0x78),
      Buffer.from('\nSECRET-ABC12345\n'),
    ]));
    gitOk(repo, ['add', 'large.txt']);
    writeFileSync(messagePath, 'large\n');
    const large = spawnSync(process.execPath, [COMMIT_MSG, messagePath], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(large.status, 1);
    assert.match(large.stderr, /too-large/);
    assert.doesNotMatch(readFileSync(messagePath, 'utf8'), /Sensitive-Scan: v1/);

    gitOk(repo, ['reset', '-q']);
    writeFileSync(join(repo, 'binary.bin'), Buffer.concat([
      Buffer.from([0]),
      Buffer.from('SECRET-ABC12345\n'),
    ]));
    gitOk(repo, ['add', 'binary.bin']);
    writeFileSync(messagePath, 'binary\n');
    const binary = spawnSync(process.execPath, [COMMIT_MSG, messagePath], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(binary.status, 1);
    assert.match(binary.stderr, /binary/);
    assert.doesNotMatch(readFileSync(messagePath, 'utf8'), /Sensitive-Scan: v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installed hook runs through git commit on this platform', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'scripts', 'sensitive-scan'), join(repo, 'scripts', 'sensitive-scan'), { recursive: true });
    const install = spawnSync(process.execPath, [join(repo, 'scripts', 'sensitive-scan', 'install-hook.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(install.status, 0, install.stderr);

    writeFileSync(join(repo, 'safe.txt'), 'safe\n');
    gitOk(repo, ['add', 'safe.txt']);
    const commit = spawnSync('git', ['commit', '-q', '-m', 'hooked'], {
      cwd: repo,
      env: { ...process.env, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key.privatePath },
      encoding: 'utf8',
    });
    assert.equal(commit.status, 0, commit.stderr);
    assert.match(gitOk(repo, ['log', '-1', '--format=%B']), /Sensitive-Scan: v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadKeyPair rejects a group-readable private key', { skip: process.platform === 'win32' }, () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    chmodSync(key.privatePath, 0o644);
    writeFileSync(join(repo, 'safe.txt'), 'safe\n');
    gitOk(repo, ['add', 'safe.txt']);
    const messagePath = join(repo, '.git', 'message.txt');
    writeFileSync(messagePath, 'mode\n');
    const result = spawnSync(process.execPath, [COMMIT_MSG, messagePath], {
      cwd: repo,
      env: { ...process.env, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key.privatePath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /accessible by group\/others/);
    assert.doesNotMatch(readFileSync(messagePath, 'utf8'), /Sensitive-Scan: v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('team keygen prints a public PEM and never overwrites an existing private key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-key-'));
  try {
    const keyPath = join(dir, 'team.pem');
    const run = () => spawnSync(process.execPath, [KEYGEN, '--key-file', keyPath], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /-----BEGIN PUBLIC KEY-----/);
    assert.doesNotMatch(first.stdout, /PRIVATE KEY/);
    const existing = readFileSync(keyPath);
    const second = run();
    assert.notEqual(second.status, 0);
    assert.deepEqual(readFileSync(keyPath), existing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier rejects a missing, malformed, or non-Ed25519 key from base', () => {
  const { dir, repo } = newRepo();
  try {
    writeFileSync(join(repo, 'file'), 'base\n');
    gitOk(repo, ['add', '.']);
    gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'base']);
    const run = (base) => spawnSync(process.execPath, [VERIFY, '--base', base, '--head', base], { cwd: repo, encoding: 'utf8' });
    assert.match(run('HEAD').stderr, /cannot read team public key/);
    const path = writeTeamPublicKey(repo, { publicKey: 'not a key' });
    gitOk(repo, ['add', '.']); gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'invalid']);
    assert.match(run('HEAD').stderr, /invalid team public key/);
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(path, publicKey.export({ type: 'spki', format: 'pem' }));
    gitOk(repo, ['add', '.']); gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'rsa']);
    assert.match(run('HEAD').stderr, /must be Ed25519/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier never accepts a local override for the base public key', () => {
  const result = spawnSync(process.execPath, [VERIFY, '--base', 'HEAD', '--head', 'HEAD', '--public-key-file', 'override.pem'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown argument: --public-key-file/);
});

test('PR cannot replace the trusted public key from its own head', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const trusted = writeDeviceKey(dir);
    const path = writeTeamPublicKey(repo, trusted.entry);
    gitOk(repo, ['add', '.']);
    gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'base']);
    const base = gitOk(repo, ['rev-parse', 'HEAD']);
    mkdirSync(join(dir, 'other'));
    const other = writeDeviceKey(join(dir, 'other'));
    writeFileSync(path, other.entry.publicKey);
    gitOk(repo, ['add', '.']);
    const head = commitSigned(repo, 'replace key', { SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: other.privatePath });
    const result = spawnSync(process.execPath, [VERIFY, '--base', base, '--head', head], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier trusts one public key from base without registry or allowlist', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    const publicDir = join(repo, '.github', 'sensitive-scan');
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, 'team-public-key.pub'), key.entry.publicKey);
    gitOk(repo, ['add', '.']);
    gitOk(repo, ['commit', '--no-verify', '-q', '-m', 'base']);
    const base = gitOk(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'safe.txt'), 'safe\n');
    gitOk(repo, ['add', 'safe.txt']);
    const head = commitSigned(repo, 'signed', {
      SENSITIVE_SCAN_RULES: rules,
      SENSITIVE_SCAN_KEY_FILE: key.privatePath,
    });
    const result = spawnSync(process.execPath, [VERIFY, '--base', base, '--head', head], {
      cwd: repo, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 commit\(s\) verified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier accepts a clean signed commit and rejects a reused trailer on another tree', () => {
  const { dir, repo } = newRepo();
  try {
    const rules = writeRules(dir);
    const key = writeDeviceKey(dir);
    const publicKeyPath = writeTeamPublicKey(repo, key.entry);
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

    const messagePath = join(repo, '.git', 'message.txt');
    const signedMessage = gitOk(repo, ['show', '-s', '--format=%B', signed]);
    const signedTree = gitOk(repo, ['show', '-s', '--format=%T', signed]);
    const checkCorruption = (message) => {
      const forged = gitOk(repo, ['commit-tree', signedTree, '-p', signed], { input: `${message}\n` });
      return spawnSync(process.execPath, [VERIFY, '--base', signed, '--head', forged], { cwd: repo, encoding: 'utf8' });
    };
    const unsigned = checkCorruption('unsigned');
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.stderr, /missing Sensitive-Scan trailer/);
    const corruptedSignature = signedMessage.replace(/(Sensitive-Scan-Sig: )([A-Za-z0-9+/])/, (_match, prefix, first) => `${prefix}${first === 'A' ? 'B' : 'A'}`);
    const badSignature = checkCorruption(corruptedSignature);
    assert.equal(badSignature.status, 1);
    assert.match(badSignature.stderr, /signature verification failed/);
    const corruptedMetadata = signedMessage.replace(/Sensitive-Scan-Scanner: [^\n]+/, 'Sensitive-Scan-Scanner: synthetic-altered');
    const badMetadata = checkCorruption(corruptedMetadata);
    assert.equal(badMetadata.status, 1);
    assert.match(badMetadata.stderr, /signature verification failed/);
    const markerIndex = signedMessage.split('\n').indexOf('Sensitive-Scan: v2');
    const trailerBlock = signedMessage.split('\n').slice(markerIndex).join('\n');
    writeFileSync(messagePath, `different\n\n${trailerBlock}\n`);
    gitOk(repo, ['commit', '--allow-empty', '--no-verify', '-q', '-F', messagePath]);
    const sameTree = gitOk(repo, ['rev-parse', 'HEAD']);
    assert.equal(
      gitOk(repo, ['show', '-s', '--format=%T', sameTree]),
      gitOk(repo, ['show', '-s', '--format=%T', signed]),
    );
    const changedMessage = verify(sameTree);
    assert.equal(changedMessage.status, 1);
    assert.match(changedMessage.stderr, /message digest does not match/);

    writeFileSync(join(repo, 'safe.txt'), 'tampered\n');
    gitOk(repo, ['add', 'safe.txt']);
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
