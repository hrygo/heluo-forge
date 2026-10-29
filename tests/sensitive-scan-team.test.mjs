import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { join, resolve } from 'node:path';
import { canonicalPayload, createAttestation, formatTrailer, keyIdFromPublicKey, parseTrailer, sha256Hex } from '../scripts/sensitive-scan/lib.mjs';

const hook = resolve(import.meta.dirname, '../scripts/sensitive-scan/team-commit-msg.mjs');
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-team-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic-test-user');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'base');
  const keys = generateKeyPairSync('ed25519');
  const key = join(dir, 'key.pem'); writeFileSync(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const rules = join(dir, 'rules.json');
  writeFileSync(rules, JSON.stringify({ literals: { synthetic: ['SYNTHETICWORD'] }, patterns: { synthetic_regex: 'TOKEN-[0-9]+' }, allow: ['TOKEN-999'], ignorePaths: ['ignored/**'] }), { mode: 0o600 });
  const message = join(dir, 'message');
  const run = (text = 'safe message', extra = {}) => {
    writeFileSync(message, text + '\n');
    const result = spawnSync(process.execPath, [hook, message], { cwd: repo, encoding: 'utf8', env: { ...gitEnv, SENSITIVE_SCAN_RULES: rules, SENSITIVE_SCAN_KEY_FILE: key, ...extra } });
    return { ...result, message: readFileSync(message, 'utf8') };
  };
  return { repo, git, run, keys, rules };
}

test('signs clean staged tree and normalized message with synthetic key', t => {
  const { repo, git, run, keys } = setup(t);
  writeFileSync(join(repo, 'safe.txt'), 'hello\n'); git('add', 'safe.txt');
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const { fields, body } = parseTrailer(result.message);
  assert.equal(fields.tree, git('write-tree')); assert.equal(fields.message, sha256Hex(body));
  assert.equal(verify(null, Buffer.from(canonicalPayload({ ...fields, version: fields.version })), keys.publicKey, Buffer.from(fields.sig, 'base64')), true);
});

test('team signer replaces an existing v1 trailer with v2', t => {
  const { repo, git, run, keys } = setup(t);
  writeFileSync(join(repo, 'safe.txt'), 'safe\n'); git('add', 'safe.txt');
  const body = 'safe message\n';
  const fields = createAttestation({ body, tree: git('write-tree'), rules: 'b'.repeat(64), keyId: keyIdFromPublicKey(keys.publicKey), privateKey: keys.privateKey }).fields;
  const result = run(formatTrailer(body, fields));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseTrailer(result.message).fields.version, 'v2');
  assert.equal((result.message.match(/Sensitive-Scan: v[12]/g) ?? []).length, 1);
  assert.equal(parseTrailer(result.message).body, body);
});

test('blocks message, path and added content without disclosing synthetic matches', t => {
  const { repo, git, run } = setup(t);
  writeFileSync(join(repo, 'safe.txt'), 'safe\n'); git('add', 'safe.txt');
  for (const message of ['SYNTHETICWORD', 'TOKEN-123']) { const r = run(message); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /SYNTHETICWORD|TOKEN-123/); assert.doesNotMatch(r.message, /Sensitive-Scan: v[12]/); }
  writeFileSync(join(repo, 'SYNTHETICWORD.txt'), 'safe\n'); git('add', 'SYNTHETICWORD.txt');
  let r = run(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /SYNTHETICWORD/);
  git('reset', '-q'); writeFileSync(join(repo, 'safe.txt'), 'TOKEN-123\n'); git('add', 'safe.txt');
  r = run(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /TOKEN-123/);
});

test('incremental ignores unchanged old line; full mode blocks it', t => {
  const { repo, git, run } = setup(t);
  writeFileSync(join(repo, 'safe.txt'), 'SYNTHETICWORD\nold\n'); git('add', 'safe.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  writeFileSync(join(repo, 'safe.txt'), 'SYNTHETICWORD\nnew\n'); git('add', 'safe.txt');
  assert.equal(run().status, 0); assert.equal(run('safe', { DSH_HOOK_FULL: '1' }).status, 1);
});

test('legacy allow and ignorePaths are honored', t => {
  const { repo, git, run } = setup(t);
  mkdirSync(join(repo, 'ignored')); writeFileSync(join(repo, 'ignored', 'SYNTHETICWORD.bin'), Buffer.from([0]));
  writeFileSync(join(repo, 'safe.txt'), 'TOKEN-999\n'); git('add', '.'); assert.equal(run().status, 0);
});

test('blocks unsupported binary, oversized and malformed xlsx', t => {
  const { repo, git, run } = setup(t);
  for (const [name, bytes] of [['binary.bin', Buffer.from([0, 1])], ['large.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 120)], ['broken.xlsx', Buffer.from('not a spreadsheet')]]) {
    writeFileSync(join(repo, name), bytes); git('add', name); const r = run(); assert.equal(r.status, 1, name); assert.doesNotMatch(r.message, /Sensitive-Scan: v[12]/); git('reset', '-q');
  }
});

function syntheticWorkbook(xml, extra = {}) {
  const entries = { 'xl/workbook.xml': xml, ...extra };
  const locals = []; const centrals = []; let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path); const data = Buffer.from(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('spreadsheets are scanned in full for all supported extensions', t => {
  const { repo, git, run } = setup(t);
  for (const ext of ['xlsx', 'xlsm', 'xltx']) {
    const file = `book.${ext}`;
    writeFileSync(join(repo, file), syntheticWorkbook('<workbook><name>SYNTHETICWORD</name></workbook>'));
    git('add', file); const r = run(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /SYNTHETICWORD/); git('reset', '-q');
    writeFileSync(join(repo, file), syntheticWorkbook('<workbook><name>safe</name></workbook>'));
    git('add', file); assert.equal(run().status, 0); git('reset', '-q');
  }
});

test('workbook scans rich text, all XML and relationship parts', t => {
  const { repo, git, run } = setup(t);
  const variants = [
    { 'xl/sharedStrings.xml': '<sst><si><r><t>SYNTHETIC</t></r><r><t>WORD</t></r></si></sst>' },
    { 'customXml/item1.xml': '<root>SYNTHETICWORD</root>' },
    { '_rels/.rels': '<Relationships><Relationship Target="SYNTHETICWORD"/></Relationships>' },
    { '[Content_Types].xml': '<Types><Default ContentType="SYNTHETICWORD"/></Types>' },
    { 'xl/styles.xml': '<root>SYNTHETICWORD</root>' },
  ];
  for (const parts of variants) {
    writeFileSync(join(repo, 'book.xlsx'), syntheticWorkbook('<workbook/>', parts)); git('add', 'book.xlsx');
    const result = run(); assert.equal(result.status, 1, Object.keys(parts)[0]); assert.doesNotMatch(result.message, /Sensitive-Scan: v[12]/); assert.doesNotMatch(result.stderr, /SYNTHETICWORD/);
  }
});

test('workbook rejects binary, undecodable, unknown or encoded content', t => {
  const { repo, git, run } = setup(t);
  for (const [name, data] of Object.entries({ 'xl/media/image.png': Buffer.from([1, 2, 3]), 'xl/vbaProject.bin': 'macro', 'custom/data.dat': 'text', 'xl/other.xml': Buffer.from([0xff, 0xff]), 'xl/declared.xml': '<?xml version="1.0" encoding="ISO-8859-1"?><x/>', 'xl/fake.xml': 'not XML', 'xl/control.xml': '<x>\u0001</x>' })) {
    writeFileSync(join(repo, 'book.xlsx'), syntheticWorkbook('<workbook/>', { [name]: data })); git('add', 'book.xlsx');
    const result = run(); assert.equal(result.status, 1, name); assert.doesNotMatch(result.message, /Sensitive-Scan: v[12]/);
  }
});

test('UTF-16 workbook XML is decoded and scanned', t => {
  const { repo, git, run } = setup(t);
  const xml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?><x>SYNTHETICWORD</x>', 'utf16le')]);
  writeFileSync(join(repo, 'book.xlsx'), syntheticWorkbook('<workbook/>', { 'custom/item.xml': xml }));
  git('add', 'book.xlsx'); assert.equal(run().status, 1);
  writeFileSync(join(repo, 'book.xlsx'), syntheticWorkbook('<workbook/>', { 'custom/item.xml': Buffer.from([0xff, 0xfe, 0x3c]) }));
  git('add', 'book.xlsx'); assert.equal(run().status, 1);
});

test('safe XML and relationships remain scannable', t => {
  const { repo, git, run } = setup(t);
  writeFileSync(join(repo, 'book.xlsx'), syntheticWorkbook('<workbook/>', { '[Content_Types].xml': '<Types/>', '_rels/.rels': '<Relationships/>', 'xl/styles.xml': '<style/>' }));
  git('add', 'book.xlsx'); const result = run(); assert.equal(result.status, 0, result.stderr);
});

test('rejects symlinks and oversized spreadsheets without signing', { skip: process.platform === 'win32' }, t => {
  const { repo, git, run } = setup(t);
  symlinkSync('target', join(repo, 'link')); git('add', 'link'); assert.equal(run().status, 1); git('reset', '-q');
  writeFileSync(join(repo, 'huge.xlsx'), Buffer.alloc(20 * 1024 * 1024 + 1)); git('add', 'huge.xlsx'); assert.equal(run().status, 1);
});

test('rejects corrupt spreadsheet CRC without signing', t => {
  const { repo, git, run } = setup(t);
  const zip = syntheticWorkbook('<workbook>safe</workbook>'); zip[30 + 'xl/workbook.xml'.length] ^= 1;
  writeFileSync(join(repo, 'corrupt.xlsx'), zip); git('add', 'corrupt.xlsx'); assert.equal(run().status, 1);
});

test('malformed rules do not leak parser text or path', t => {
  const { rules, run } = setup(t); writeFileSync(rules, '{"SYNTHETICWORD":invalid}');
  let r = run(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /SYNTHETICWORD|invalid/);
  writeFileSync(rules, JSON.stringify({ literals: {}, patterns: { SYNTHETIC_CATEGORY: '(SYNTHETIC_PATTERN' } }));
  r = run(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /SYNTHETIC_CATEGORY|SYNTHETIC_PATTERN/);
});
