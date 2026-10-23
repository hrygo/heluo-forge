/**
 * #13 本地区块：macOS 系统钥匙串 spike 驱动。
 *
 * 用 `@heluo/forge-credentials-keychain` 的 security-cli 适配器（非生产、需显式 opt-in）
 * 在真实系统钥匙串上跑一遍 建/读/改/删 与失败语义，并把"无明文落盘"一起量出来。
 * 只写入本探针自己创建的测试条目（service 固定、account 随机），结束时删除并复核。
 *
 * 用法：node scripts/probe/run-keychain-spike.mjs
 * 退出码：0 全部符合预期；1 有失败项；2 环境不具备（非 darwin 或没有 security）。
 * 证据：临时目录里的 keychain-spike.json（只含布尔与退出码，不含口令与字面路径）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../../packages/forge-credentials-keychain/src');

const { createSecurityCliBackend, probeSecurityCli } = await import(`${pkg}/security-cli.mjs`);

if (process.platform !== 'darwin') {
  console.error(`keychain-spike: 仅 darwin 可跑（当前 ${process.platform}）；Windows 凭据管理器与麒麟 Secret Service 适配器待实测`);
  process.exit(2);
}

const service = 'heluo-forge-keychain-spike';
const account = `spike-${randomBytes(4).toString('hex')}`;
const secret = `spike-${randomBytes(16).toString('hex')}`;
const rotated = `${secret}-rotated`;
const dir = mkdtempSync(join(tmpdir(), 'forge-keychain-spike-'));
const report = { probe: 'forge-keychain-spike', env: { platform: `${process.platform}-${process.arch}`, node: process.version }, steps: [], ok: true };
const record = (id, ok, detail) => {
  report.steps.push({ id, ok, detail });
  if (!ok) report.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

const probe = probeSecurityCli();
record('security-cli-available', probe.available, { status: probe.status, keychainCount: probe.keychainCount, reason: probe.reason });
if (!probe.available) {
  writeFileSync(join(dir, 'keychain-spike.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`keychain-spike: 系统钥匙串不可用；证据留在 ${dir}`);
  process.exit(2);
}

const osVersion = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim();
report.env.os = osVersion;

const backend = createSecurityCliBackend({ service });
const argvBackend = createSecurityCliBackend({ service, secretTransport: 'argv' });

try {
  const filesBefore = new Set(readdirSync(dir));
  await backend.set(account, secret);
  const readBack = await backend.get(account);
  record('create-and-read', readBack === secret, { matches: readBack === secret });

  await backend.set(account, rotated);
  const updated = await backend.get(account);
  record('update-same-item', updated === rotated, { matches: updated === rotated });

  let argvRefused = false;
  try {
    await argvBackend.set(account, 'disposable');
  } catch (error) {
    argvRefused = error?.code === 'KEYCHAIN_ARGV_SECRET_NOT_ALLOWED';
  }
  const afterArgvAttempt = await backend.get(account);
  record('argv-secret-refused', argvRefused && afterArgvAttempt === rotated, { refused: argvRefused, unchanged: afterArgvAttempt === rotated });

  const filesAfter = readdirSync(dir);
  const createdFiles = filesAfter.filter((name) => !filesBefore.has(name));
  const plaintext = createdFiles.filter((name) => {
    const path = join(dir, name);
    if (!statSync(path).isFile()) return false;
    return readFileSync(path, 'utf8').includes(secret);
  });
  record('no-plaintext-in-files', plaintext.length === 0, { createdFiles, plaintextFiles: plaintext });

  const missing = await backend.get(`absent-${randomBytes(4).toString('hex')}`);
  record('missing-item-is-undefined', missing === undefined, { undefined: missing === undefined });

  await backend.delete(account);
  const afterDelete = await backend.get(account);
  record('delete-then-absent', afterDelete === undefined, { absent: afterDelete === undefined });

  await backend.delete(account);
  record('delete-is-idempotent', true, { secondDelete: 'no error' });

  let listRefused = false;
  try {
    await backend.list('');
  } catch (error) {
    listRefused = error?.code === 'KEYCHAIN_LIST_UNSUPPORTED';
  }
  record('list-refuses-instead-of-empty', listRefused, { refused: listRefused });
} finally {
  try {
    await backend.delete(account);
  } catch {
    // 清理失败也要把证据留下来，由最后一步按钮核对残留。
  }
  const residue = await backend.get(account);
  record('cleanup-verified', residue === undefined, { residue: residue === undefined });
  writeFileSync(join(dir, 'keychain-spike.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`keychain-spike: ${report.steps.filter((step) => step.ok).length}/${report.steps.length} steps ok`);
  console.log(`keychain-spike: 证据留在 ${dir}`);
  if (!report.ok) process.exitCode = 1;
}
