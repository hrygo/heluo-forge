import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STORE_ARTIFACT,
  extractStoreTargets,
  judgeStoreAccess,
  judgeTokenInvocation,
  storeRootsFrom,
} from '../src/store-protection.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const storeDir = join(base, 'store');
  const keyDir = `${storeDir}.keys`;
  const outside = join(base, 'outside');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(storeDir, 'credentials.sqlite'), '');
  writeFileSync(join(keyDir, 'keyring.json'), '{}');
  writeFileSync(join(outside, 'notes.txt'), 'hello');
  const link = join(base, 'link');
  symlinkSync(storeDir, link);
  const roots = storeRootsFrom({ directory: storeDir, keyDirectory: keyDir });
  return { base, storeDir, keyDir, outside, link, roots };
}

const read = (file_path) => ({ name: 'read', arguments: { file_path } });
const bash = (command, workdir) => ({ name: 'bash', arguments: { command, workdir } });

test('storeRootsFrom 只接受绝对目录，且区分库目录与密钥目录', () => {
  const roots = storeRootsFrom({ directory: '/tmp/a/store', keyDirectory: '/tmp/a/store.keys' });
  assert.deepEqual(roots.map((entry) => entry.artifact), [STORE_ARTIFACT.STORE_DIR, STORE_ARTIFACT.KEYRING]);
  assert.throws(() => storeRootsFrom({ directory: '/tmp/a/store' }), /incomplete|POLICY_STORE_LOCATION_INVALID/u);
  assert.throws(() => storeRootsFrom({ directory: 'relative/store', keyDirectory: '/tmp/x' }), (error) => error.code === 'POLICY_PROTECTED_ROOT_NOT_ABSOLUTE');
});

test('读库文件、读密钥、经符号链接别名都被判为访问存档', () => {
  const { storeDir, keyDir, link, roots } = fixture();
  try {
    const db = judgeStoreAccess(read(join(storeDir, 'credentials.sqlite')), roots);
    assert.equal(db.hit, true);
    assert.equal(db.artifact, STORE_ARTIFACT.STORE_DIR);

    const keyring = judgeStoreAccess(read(join(keyDir, 'keyring.json')), roots);
    assert.equal(keyring.hit, true);
    assert.equal(keyring.artifact, STORE_ARTIFACT.KEYRING);

    // 符号链接别名：归一化后落在库目录内，仍然拒绝。
    const alias = judgeStoreAccess(read(join(link, 'credentials.sqlite')), roots);
    assert.equal(alias.hit, true);
  } finally {
    rmSync(join(storeDir, '..'), { recursive: true, force: true });
  }
});

test('写、删、目录遍历与目录祖先都命中；无关路径放行', () => {
  const { base, storeDir, outside, roots } = fixture();
  try {
    assert.equal(judgeStoreAccess({ name: 'write', arguments: { file_path: join(storeDir, 'x.db') } }, roots).hit, true);
    assert.equal(judgeStoreAccess({ name: 'edit', arguments: { file_path: join(storeDir, 'credentials.sqlite') } }, roots).hit, true);
    assert.equal(judgeStoreAccess(bash(`rm -rf ${storeDir}`), roots).hit, true);
    // 递归目录：库目录的父目录也会覆盖到库，按 ancestor 拒绝。
    const ancestor = judgeStoreAccess({ name: 'glob', arguments: { pattern: '**/*.sqlite', path: base } }, roots);
    assert.equal(ancestor.hit, true);
    assert.equal(ancestor.reason, 'ancestor');
    // 目录内的 glob 是路径命中。
    const inside = judgeStoreAccess({ name: 'grep', arguments: { pattern: 'token', path: storeDir } }, roots);
    assert.equal(inside.hit, true);

    assert.equal(judgeStoreAccess(read(join(outside, 'notes.txt')), roots).hit, false);
    assert.equal(judgeStoreAccess(bash('git status'), roots).hit, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('命令文本点名存档：sqlite3 查询、搬运与未来表同样命中', () => {
  const { base, storeDir, outside, roots } = fixture();
  try {
    assert.equal(judgeStoreAccess(bash(`sqlite3 ${join(storeDir, 'credentials.sqlite')} "select * from records"`), roots).hit, true);
    assert.equal(judgeStoreAccess(bash(`sqlite3 ${join(storeDir, 'credentials.sqlite')} "select * from future_table"`), roots).hit, true);
    assert.equal(judgeStoreAccess(bash(`cp ${join(storeDir, 'credentials.sqlite')} ${join(outside, 'copy.db')}`), roots).hit, true);
    // 位置已知时裸文件名不按指纹拒绝：可能只是别处同名文件；跟随命令里的 cd。
    assert.equal(judgeStoreAccess(bash('sqlite3 credentials.sqlite "select 1"'), roots).hit, false);
    assert.equal(judgeStoreAccess(bash('cat keyring.json'), roots).hit, false);
    assert.equal(judgeStoreAccess(bash(`cd ${storeDir} && sqlite3 credentials.sqlite "select 1"`), roots).hit, true);
    assert.equal(judgeStoreAccess(bash(`cd ${join(outside)} && sqlite3 credentials.sqlite "select 1"`), roots).hit, false);
    // 位置未知（服务缺席或错配降级）时，裸文件名仍按指纹兜底。
    assert.equal(judgeStoreAccess(bash('sqlite3 credentials.sqlite "select 1"'), []).hit, true);
    assert.equal(judgeStoreAccess(bash('cat keyring.json'), []).hit, true);
    assert.equal(judgeStoreAccess(bash(`cat ${join(outside, 'notes.txt')}`), roots).hit, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('file_path 之外的路径键也覆盖：terminal_open cwd、working_directory、下载保存', () => {
  const { storeDir, roots } = fixture();
  try {
    assert.equal(judgeStoreAccess({ name: 'terminal_open', arguments: { cwd: storeDir } }, roots).hit, true);
    assert.equal(judgeStoreAccess({ name: 'working_directory', arguments: { cd: storeDir } }, roots).hit, true);
    assert.equal(judgeStoreAccess({ name: 'dsh_browser_download', arguments: { savePath: join(storeDir, 'dump.db') } }, roots).hit, true);
    assert.equal(extractStoreTargets({ name: 'read', arguments: { file_path: join(storeDir, 'a') } })[0].kind, 'path');
  } finally {
    rmSync(join(storeDir, '..'), { recursive: true, force: true });
  }
});

test('取票通道：CLI、node、npx、shell -c 都命中；whoami 与运行期拼装不命中', () => {
  for (const command of [
    'heluo-forge auth token',
    'heluo-forge auth --json token',
    'node bin/heluo-forge.mjs auth token',
    'npx heluo-forge auth token',
    'sh -c "heluo-forge auth token"',
    '/usr/local/bin/heluo-forge auth token',
    'env HELUO=1 heluo-forge auth token',
    'bash -lc "heluo-forge auth token"',
  ]) {
    assert.equal(judgeTokenInvocation(bash(command)).hit, true, command);
  }
  for (const command of [
    'heluo-forge auth whoami --json',
    'heluo-forge auth login',
    'git status',
    "echo 'Usage: heluo-forge auth token'",
    "echo 'See the manual; heluo-forge auth token'",
    `sh -c "echo 'heluo-forge auth token'"`,
    'printf \'%s\\n\' "heluo-forge auth token"',
    'grep -rn "heluo-forge auth token" docs/',
    "cat <<'EOF'\nUsage: heluo-forge auth token\nEOF",
    'sed -n 1p docs/plan.md # heluo-forge auth token',
  ]) {
    assert.equal(judgeTokenInvocation(bash(command)).hit, false, command);
  }
  // 已知缺口：运行期拼装的可执行名不在调用参数里，判不出来（方案 §3.3 记为不覆盖）。
  assert.equal(judgeTokenInvocation(bash('H=$(which heluo-forge); "$H" auth token')).hit, false);
});

test('shell paths use the supplied workdir and compare known paths before file names', () => {
  const { base, storeDir, outside, roots } = fixture();
  try {
    assert.equal(judgeStoreAccess(bash('cat notes.txt', outside), roots).hit, false);
    assert.equal(judgeStoreAccess(bash('cat version.txt', storeDir), roots).hit, true);
    assert.equal(judgeStoreAccess(bash('cat ./version.txt', storeDir), roots).hit, true);
    assert.equal(judgeStoreAccess(bash('cat credentials.sqlite', outside), roots).hit, false);
    assert.equal(judgeStoreAccess(bash('cat "' + join(outside, 'space name', 'keyring.json') + '"'), roots).hit, false);
    assert.equal(judgeStoreAccess(bash('cat "' + join(storeDir, 'space name', 'keyring.json') + '"'), roots).hit, true);
    // 位置已知、cwd 未定：裸文件名不再按指纹拒绝（评审 #457 P2-2）。
    assert.equal(judgeStoreAccess(bash('cat credentials.sqlite'), roots).hit, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
