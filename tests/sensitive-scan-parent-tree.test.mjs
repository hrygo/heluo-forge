import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAttestation, formatTrailer, keyIdFromPublicKey, sha256Hex } from '../scripts/sensitive-scan/lib.mjs';

const verifier = resolve(import.meta.dirname, '../scripts/sensitive-scan/verify.mjs');
const hook = resolve(import.meta.dirname, '../scripts/sensitive-scan/team-commit-msg.mjs');

function fixture(t, format = 'sha1') {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-parent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test-user', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test-user' };
  const git = (args, input, extra = {}) => {
    const r = spawnSync('git', args, { cwd: repo, env: { ...env, ...extra }, input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', `--object-format=${format}`]);
  const keys = generateKeyPairSync('ed25519');
  const publicDir = join(repo, '.github', 'sensitive-scan'); mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'team-public-key.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(['add', '.']);
  const baseTree = git(['write-tree']);
  const commit = (tree, parent, message, extra = {}) => git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], message, extra);
  const base = commit(baseTree, null, 'base\n');
  git(['update-ref', 'refs/heads/main', base]); git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const tree = (text) => { writeFileSync(join(repo, 'change.txt'), text); git(['add', 'change.txt']); return git(['write-tree']); };
  const verify = (from, to) => spawnSync(process.execPath, [verifier, '--base', from, '--head', to], { cwd: repo, env, encoding: 'utf8' });
  const v2 = (targetTree, parentTree, body = 'signed\n') => {
    const fields = { tree: targetTree, parenttree: parentTree, message: sha256Hex(body), rules: 'b'.repeat(64), scanner: 'heluo-sensitive-scan@1.0.0', time: '1700000000', nonce: 'a'.repeat(32), key: keyIdFromPublicKey(keys.publicKey) };
    const payload = ['v2', `tree=${fields.tree}`, `parent-tree=${fields.parenttree}`, `message=${fields.message}`, `rules=${fields.rules}`, `scanner=${fields.scanner}`, `time=${fields.time}`, `nonce=${fields.nonce}`].join('\n');
    fields.sig = sign(null, Buffer.from(payload), keys.privateKey).toString('base64');
    return `${body}\nSensitive-Scan: v2\nSensitive-Scan-Tree: ${fields.tree}\nSensitive-Scan-ParentTree: ${fields.parenttree}\nSensitive-Scan-Message: ${fields.message}\nSensitive-Scan-Rules: ${fields.rules}\nSensitive-Scan-Scanner: ${fields.scanner}\nSensitive-Scan-Time: ${fields.time}\nSensitive-Scan-Nonce: ${fields.nonce}\nSensitive-Scan-Key: ${fields.key}\nSensitive-Scan-Sig: ${fields.sig}\n`;
  };
  return { dir, repo, env, git, keys, base, baseTree, commit, tree, verify, v2 };
}

test('remote verifier rejects a cryptographically valid v1 certificate', t => {
  const f = fixture(t); const tree = f.tree('first\n');
  const fields = createAttestation({ body: 'signed\n', tree, rules: 'b'.repeat(64), keyId: keyIdFromPublicKey(f.keys.publicKey), privateKey: f.keys.privateKey }).fields;
  const head = f.commit(tree, f.base, formatTrailer('signed\n', fields));
  const result = f.verify(f.base, head);
  assert.equal(result.status, 1, 'v1 must not constitute a remote certificate');
});

test('rejects v2 certificate replayed onto a different parent tree', t => {
  const f = fixture(t); const signedTree = f.tree('first\n');
  const message = f.v2(signedTree, f.baseTree);
  const original = f.commit(signedTree, f.base, message);
  const good = f.verify(f.base, original); assert.equal(good.status, 0, good.stderr);
  const alternateTree = f.tree('different parent\n');
  const alternateBase = f.commit(alternateTree, f.base, 'alternate base\n');
  const replay = f.commit(signedTree, alternateBase, message);
  const rejected = f.verify(alternateBase, replay);
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /parent.tree/i);
});

test('accepts v2 replay with the same parent tree and rewritten committer', t => {
  const f = fixture(t); const tree = f.tree('first\n');
  const alternateBase = f.commit(f.baseTree, null, 'different base identity\n');
  assert.notEqual(alternateBase, f.base);
  const replay = f.commit(tree, alternateBase, f.v2(tree, f.baseTree), { GIT_COMMITTER_NAME: 'Another committer' });
  const result = f.verify(alternateBase, replay); assert.equal(result.status, 0, result.stderr);
});

test('accepts two v2 commits with rewritten parent identities but rejects content tampering', t => {
  const f = fixture(t); const firstTree = f.tree('first\n'); const secondTree = f.tree('second\n');
  const firstMessage = f.v2(firstTree, f.baseTree, 'first\n'); const secondMessage = f.v2(secondTree, firstTree, 'second\n');
  const newBase = f.commit(f.baseTree, null, 'rewritten base\n');
  const first = f.commit(firstTree, newBase, firstMessage, { GIT_COMMITTER_NAME: 'Another committer' });
  const second = f.commit(secondTree, first, secondMessage, { GIT_COMMITTER_NAME: 'Another committer' });
  const accepted = f.verify(newBase, second); assert.equal(accepted.status, 0, accepted.stderr);
  const tamperedTree = f.tree('tampered\n');
  const tampered = f.commit(tamperedTree, first, secondMessage);
  const rejected = f.verify(newBase, tampered); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /tree/i);
});

test('changing the signed parent-tree field invalidates the signature', t => {
  const f = fixture(t); const tree = f.tree('first\n');
  const otherTree = f.tree('other\n'); const otherBase = f.commit(otherTree, f.base, 'other\n');
  const original = f.v2(tree, f.baseTree);
  const forged = original.replace(`Sensitive-Scan-ParentTree: ${f.baseTree}`, `Sensitive-Scan-ParentTree: ${otherTree}`);
  const head = f.commit(tree, otherBase, forged);
  const result = f.verify(otherBase, head); assert.equal(result.status, 1); assert.match(result.stderr, /signature verification failed/);
});

test('v2 verification supports SHA-256 Git repositories', t => {
  const f = fixture(t, 'sha256'); const tree = f.tree('first\n');
  const head = f.commit(tree, f.base, f.v2(tree, f.baseTree));
  const result = f.verify(f.base, head); assert.equal(result.status, 0, result.stderr);
});

test('team signer emits a v2 trailer bound to the parent tree', t => {
  const f = fixture(t); f.tree('first\n');
  const key = join(f.dir, 'synthetic-key.pem'); const rules = join(f.dir, 'synthetic-rules.json'); const message = join(f.dir, 'message');
  writeFileSync(key, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(rules, JSON.stringify({ literals: { example: ['SYNTHETICWORD'] }, patterns: {}, allow: [], ignorePaths: [] }), { mode: 0o600 });
  writeFileSync(message, 'signed\n');
  const result = spawnSync(process.execPath, [hook, message], { cwd: f.repo, env: { ...f.env, SENSITIVE_SCAN_KEY_FILE: key, SENSITIVE_SCAN_RULES: rules }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(message, 'utf8');
  assert.match(output, /Sensitive-Scan: v2/);
  assert.match(output, new RegExp(`Sensitive-Scan-ParentTree: ${f.baseTree}`));
});


function runTeam(f, extra = {}) {
  const key = join(f.dir, 'fixture-key.pem'); const rules = join(f.dir, 'fixture-rules.json'); const message = join(f.dir, 'fixture-message');
  writeFileSync(key, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(rules, JSON.stringify({ literals: { example: ['SYNTHETICWORD'] }, patterns: {}, allow: [], ignorePaths: [] }), { mode: 0o600 });
  writeFileSync(message, 'signed\n');
  return spawnSync(process.execPath, [hook, message], { cwd: f.repo, env: { ...f.env, SENSITIVE_SCAN_KEY_FILE: key, SENSITIVE_SCAN_RULES: rules, ...extra }, encoding: 'utf8' });
}

test('amend with changed parent tree is not a valid remote certificate', t => {
  const f = fixture(t); const headTree = f.tree('first\n');
  const head = f.commit(headTree, f.base, 'original\n');
  const amendedTree = f.tree('second\n');
  const normal = f.commit(amendedTree, head, f.v2(amendedTree, headTree));
  assert.equal(f.verify(head, normal).status, 0, 'valid v2 baseline');
  const amended = f.commit(amendedTree, f.base, f.v2(amendedTree, headTree));
  const rejected = f.verify(f.base, amended); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /parent.tree/i);
});

test('team signer fails closed when HEAD does not exist', t => {
  const f = fixture(t); f.git(['update-ref', '-d', 'refs/heads/main']); f.tree('new\n');
  assert.equal(runTeam(f).status, 1);
});

test('team signer fails closed during a pending merge', t => {
  const f = fixture(t); f.tree('new\n'); writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), `${f.base}\n`);
  assert.equal(runTeam(f).status, 1);
});

for (const target of ['HEAD', 'index']) {
  test(`team signer rejects ${target} changing during scan`, { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); f.tree('new\n');
    const other = f.commit(f.baseTree, f.base, 'other head\n');
    const bin = join(f.dir, 'bin'); mkdirSync(bin);
    const actual = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(actual);
    const marker = join(f.dir, 'triggered');
    const mutation = target === 'HEAD' ? `"$real" update-ref HEAD '${other}'` : `"$real" read-tree '${f.baseTree}'`;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nreal='${actual}'\nif [ "$1" = write-tree ] && [ ! -e '${marker}' ]; then\n  "$real" "$@" || exit $?\n  : > '${marker}'\n  ${mutation} || exit $?\n  exit 0\nfi\nexec "$real" "$@"\n`, { mode: 0o755 });
    const result = runTeam(f, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1, `signer must reject a racing ${target}`);
  });
}


test('scans the signed tree despite a temporary index ABA', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const intended = f.tree('SYNTHETICWORD\n');
  const bin = join(f.dir, 'aba-bin'); mkdirSync(bin);
  const actual = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(actual);
  const marker = join(f.dir, 'aba-triggered');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nreal='${actual}'\nif [ "$1" = diff ] && [ ! -e '${marker}' ]; then\n  : > '${marker}'\n  "$real" read-tree '${f.baseTree}' || exit $?\n  "$real" "$@"\n  status=$?\n  "$real" read-tree '${intended}' || exit $?\n  exit "$status"\nfi\nexec "$real" "$@"\n`, { mode: 0o755 });
  const result = runTeam(f, { PATH: `${bin}:${process.env.PATH}` });
  assert.ok(existsSync(marker), 'the index was switched during the diff');
  assert.equal(f.git(['write-tree']), intended, 'the index was restored to its original tree');
  assert.equal(result.status, 1, 'the signed tree contains a synthetic finding and must not be signed');
});


test('team scanner handles literal special-character paths in immutable trees', t => {
  const f = fixture(t);
  const names = process.platform === 'win32'
    ? ['space name.txt', 'unicode-汉字.txt']
    : ['space name.txt', 'star[1]*.txt', 'colon:name.txt', 'unicode-汉字.txt', 'tab\tname.txt', 'line\nname.txt'];
  for (const name of names) writeFileSync(join(f.repo, name), 'safe\n');
  f.git(['add', '--', ...names.map(name => `:(literal)${name}`)]);
  assert.equal(runTeam(f).status, 0, 'literal paths should scan successfully');
  writeFileSync(join(f.repo, names[1]), 'SYNTHETICWORD\n'); f.git(['add', '--', `:(literal)${names[1]}`]);
  assert.equal(runTeam(f).status, 1, 'literal path findings must be detected');
});

test('tree scanning rejects symlink and submodule entries', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); symlinkSync('base.txt', join(f.repo, 'link')); f.git(['add', 'link']);
  assert.equal(runTeam(f).status, 1, 'symlink rejected');
  f.git(['reset', '-q']); f.git(['update-index', '--add', '--cacheinfo', `160000,${f.base},submodule`]);
  f.git(['config', 'diff.ignoreSubmodules', 'all']);
  assert.equal(runTeam(f).status, 1, 'gitlink rejected even when Git config hides submodules');
});

test('replacement tree cannot make signer and verifier approve an unscanned tree', t => {
  const f = fixture(t); const original = f.tree('SYNTHETICWORD\n');
  const clean = f.tree('safe\n'); f.git(['read-tree', original]); f.git(['replace', original, clean]);
  assert.notEqual(f.git(['cat-file', '-p', original]), f.git(['cat-file', '-p', original], undefined, { GIT_NO_REPLACE_OBJECTS: '1' }));
  const signed = runTeam(f);
  if (signed.status === 0) {
    const message = readFileSync(join(f.dir, 'fixture-message'), 'utf8');
    const head = f.commit(original, f.base, message);
    const checked = f.verify(f.base, head);
    assert.equal(checked.status, 0, 'demonstrate verifier accepts the misleading signature');
  }
  assert.equal(signed.status, 1, 'actual signed tree contains a synthetic finding');
});

test('verifier rejects an unsigned commit replaced with a signed commit', t => {
  const f = fixture(t); const tree = f.tree('safe\n');
  const unsigned = f.commit(tree, f.base, 'unsigned\n');
  const signed = f.commit(tree, f.base, f.v2(tree, f.baseTree));
  f.git(['replace', unsigned, signed]);
  assert.match(f.git(['cat-file', 'commit', unsigned]), /Sensitive-Scan: v2/);
  const result = f.verify(f.base, unsigned);
  assert.equal(result.status, 1); assert.match(result.stderr, /missing Sensitive-Scan trailer/);
});

test('signer scans actual blobs despite a Git replacement ref', t => {
  const f = fixture(t); const tree = f.tree('SYNTHETICWORD\n');
  const original = f.git(['rev-parse', `${tree}:change.txt`]);
  const replacement = f.git(['hash-object', '-w', '--stdin'], 'safe\n');
  f.git(['replace', original, replacement]);
  assert.equal(f.git(['cat-file', 'blob', original]), 'safe', 'replacement ref redirects the blob');
  assert.equal(f.git(['cat-file', 'blob', original], undefined, { GIT_NO_REPLACE_OBJECTS: '1' }), 'SYNTHETICWORD');
  const result = runTeam(f);
  assert.equal(result.status, 1, 'the real blob contains a synthetic finding');
});

test('team scanner signs a SHA-256 Git tree and verifier accepts it', t => {
  const f = fixture(t, 'sha256'); const tree = f.tree('safe\n');
  const result = runTeam(f); assert.equal(result.status, 0, result.stderr);
  const message = readFileSync(join(f.dir, 'fixture-message'), 'utf8');
  const head = f.commit(tree, f.base, message); const checked = f.verify(f.base, head);
  assert.equal(checked.status, 0, checked.stderr);
});
