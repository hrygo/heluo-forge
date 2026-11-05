#!/usr/bin/env node
/**
 * #121 AC2 实机探针：native-keyring 后端（@napi-rs/keyring，真实驱动路径）。
 *
 * 用 createNativeKeyringBackend 的**真实驱动**（不注入 load）在目标平台系统凭据库上量：
 * 建/读/改/删、默认枚举拒绝语义、（darwin/win32 显式 opt-in 的）findCredentials 枚举、
 * Windows 2560 字节（UTF-16LE）上限、跨进程写/读/删可见性、无明文落盘与清理无残留。
 * 不做跨进程读改写计数：该 backend 有意不导出 transaction()，provider 也不声称
 * 跨进程锁（见包 README）；"多进程竞争刷新"用例归 #120 的宿主侧矩阵。
 *
 * 只写本探针自己创建的条目（service 固定为探针专用名、account 随机），结束删除并复核。
 *
 * 用法：node scripts/probe/run-native-keyring-probe.mjs
 * 退出码：0 全部符合预期；1 有失败项；2 环境不具备（平台无适配器或 @napi-rs/keyring 装不上）。
 * 证据：临时目录里的 native-keyring-probe.json（只含布尔、计数与退出码，不含口令与字面路径）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const pkg = resolve(here, '../../packages/forge-credentials-keychain/src');

const { KeychainBackendError } = await import(`${pkg}/backend.mjs`);
const { createNativeKeyringBackend } = await import(`${pkg}/native-keyring.mjs`);

const role = process.argv[2] ?? null;
const platform = process.platform;
const service = 'heluo-forge-native-keyring-probe';
const account = process.env.NATIVE_KEYRING_PROBE_ACCOUNT ?? 'unknown-account';

// ── 子进程角色：只做一件事，绝不打印值 ──────────────────────────────────
if (role === 'set') {
  const backend = createNativeKeyringBackend({ service });
  await backend.set(account, process.env.NATIVE_KEYRING_PROBE_VALUE);
  process.exit(0);
}
if (role === 'get') {
  const backend = createNativeKeyringBackend({ service });
  const value = await backend.get(account);
  process.stdout.write(value === undefined ? 'MISSING' : 'PRESENT');
  process.exit(0);
}
if (role === 'delete') {
  const backend = createNativeKeyringBackend({ service });
  await backend.delete(account);
  process.exit(0);
}
if (role !== null) {
  console.error('native-keyring-probe: unknown role');
  process.exit(2);
}

// ── 父进程：环境判据与编排 ────────────────────────────────────────────
function platformNotes(platformName) {
  if (platformName === 'win32') return { enumeration: true, blobGuard: true };
  if (platformName === 'linux') return { enumeration: false, blobGuard: false };
  if (platformName === 'darwin') return { enumeration: true, blobGuard: false };
  return { enumeration: false, blobGuard: false };
}
const notes = platformNotes(platform);
if (notes.enumeration === undefined || !['win32', 'linux', 'darwin'].includes(platform)) {
  console.error(`native-keyring-probe: 平台 ${platform} 不在适配器声明范围（win32/linux/darwin）`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'forge-native-keyring-probe-'));
const report = {
  probe: 'native-keyring-probe',
  env: { platform: `${platform}-${process.arch}`, node: process.version },
  steps: [],
  ok: true,
};
const record = (id, ok, detail = {}) => {
  report.steps.push({ id, ok, detail });
  if (!ok) report.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

let backend;
let optInBackend;
try {
  backend = createNativeKeyringBackend({ service });
  optInBackend = createNativeKeyringBackend({ service, enumeration: 'find-credentials' });
} catch (error) {
  const reason = error instanceof KeychainBackendError ? `${error.code}: ${error.message}` : String(error?.message ?? error);
  console.error(`native-keyring-probe: 环境不具备（${reason}）`);
  console.error('native-keyring-probe: 依赖未安装时在仓库根执行 pnpm add -w -D @napi-rs/keyring（本地装包，不提交 manifest 变更）');
  process.exit(2);
}
record('driver-metadata', backend.kind === 'native-keyring' && backend.durable === true && backend.unvetted === true, {
  kind: backend.kind,
  durable: backend.durable,
  unvetted: backend.unvetted,
  enumeration: backend.enumeration,
  crossProcessLock: backend.crossProcessLock === true,
});

const storageKey = `${service}/probe-${randomBytes(4).toString('hex')}`;
const prefix = `${service}/probe-`;
const secret = `native-keyring-probe-${randomBytes(16).toString('hex')}`;
const rotated = `${secret}-rotated`;

try {
  const filesBefore = new Set(readdirSync(dir));
  await backend.set(storageKey, secret);
  const readBack = await backend.get(storageKey);
  record('create-and-read', readBack === secret, { matches: readBack === secret });

  await backend.set(storageKey, rotated);
  const updated = await backend.get(storageKey);
  record('update-same-entry', updated === rotated, { matches: updated === rotated });

  const missing = await backend.get(`absent-${randomBytes(4).toString('hex')}`);
  record('missing-entry-is-undefined', missing === undefined, { undefined: missing === undefined });

  let defaultListRefused = false;
  try {
    await backend.list(prefix);
  } catch (error) {
    defaultListRefused = error instanceof KeychainBackendError && error.code === 'KEYCHAIN_LIST_UNSUPPORTED';
  }
  record('default-enumeration-refuses', defaultListRefused, { refused: defaultListRefused });

  if (notes.enumeration) {
    const found = await optInBackend.list(prefix);
    record('opt-in-enumeration-shows-own-entry', found.includes(storageKey), {
      foundCount: found.length,
      hasOwnEntry: found.includes(storageKey),
    });
  } else {
    record('opt-in-enumeration-shows-own-entry', true, { skipped: 'cross-store semantics unverified on linux; keep NOT RUN' });
  }

  if (notes.blobGuard) {
    let tooLargeRefused = false;
    try {
      await backend.set(accountName, 'x'.repeat(1281));
    } catch (error) {
      tooLargeRefused = error instanceof KeychainBackendError && error.code === 'KEYCHAIN_VALUE_TOO_LARGE';
    }
    const unchanged = (await backend.get(storageKey)) === rotated;
    record('win32-blob-limit-refuses', tooLargeRefused && unchanged, { refused: tooLargeRefused, unchanged });
  }

  // 跨进程：另两个进程写/读/删同一条目。
  const env = { ...process.env, NATIVE_KEYRING_PROBE_ACCOUNT: storageKey, NATIVE_KEYRING_PROBE_VALUE: rotated };
  const child = (childRole) => spawnSync(process.execPath, [self, childRole], { env, encoding: 'utf8', timeout: 60_000 });

  const setChild = child('set');
  record('cross-process-child-writes', setChild.status === 0, { exitCode: setChild.status });
  const readCross = await backend.get(storageKey);
  record('parent-process-reads-foreign-write', readCross === rotated, { matches: readCross === rotated });

  const otherChild = child('get');
  record('third-process-reads-same-value', otherChild.stdout === 'PRESENT', {
    exitCode: otherChild.status,
    outcome: otherChild.stdout,
  });

  const delChild = child('delete');
  record('child-process-deletes-record', delChild.status === 0, { exitCode: delChild.status });
  const afterDelete = await backend.get(storageKey);
  record('record-gone-after-cross-process-delete', afterDelete === undefined, { absent: afterDelete === undefined });

  const filesAfter = readdirSync(dir);
  const createdFiles = filesAfter.filter((name) => !filesBefore.has(name));
  const canaries = [secret, rotated];
  const plaintextFiles = createdFiles.filter((name) => {
    const path = join(dir, name);
    if (!statSync(path).isFile()) return false;
    return canaries.some((canary) => readFileSync(path, 'utf8').includes(canary));
  });
  record('no-plaintext-in-files', plaintextFiles.length === 0, { createdFiles, plaintextFiles });
} finally {
  const residue = [];
  for (const cleanupAccount of [...new Set([storageKey, process.env.NATIVE_KEYRING_PROBE_ACCOUNT].filter(Boolean))]) {
    try {
      await backend.delete(cleanupAccount);
    } catch (error) {
      residue.push(`delete-failed:${String(error?.code ?? 'unknown')}`);
    }
    const afterCleanup = await backend.get(cleanupAccount);
    if (afterCleanup !== undefined) residue.push('residue');
  }
  record('cleanup-verified', residue.length === 0, { residue });
  writeFileSync(join(dir, 'native-keyring-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`native-keyring-probe: ${report.steps.filter((step) => step.ok).length}/${report.steps.length} steps ok`);
  console.log(`native-keyring-probe: 证据留在 ${dir}`);
  if (!report.ok) process.exitCode = 1;
}
