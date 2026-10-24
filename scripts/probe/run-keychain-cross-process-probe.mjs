#!/usr/bin/env node
/**
 * #13 AC4 补测：**真实钥匙串的跨进程可见性**。
 *
 * 既有证据已覆盖"真钥匙串上迁移成功、回读一致后才删旧值"与"不可用时 fail closed"，
 * 但那些都在**同一个进程**里完成。跨进程是另一类风险：只要 backend 里存在任何进程内
 * 状态（缓存、句柄、按 pid 命名），本进程内的往返都会通过，而 CLI 与桌面应用之间
 * （两个进程）却读不到对方的记录。本探针把写、读、删拆到**不同进程**验证。
 *
 * 判据（真钥匙串，值只比较、不打印）：
 *   1. 子进程 A 写入记录 → 进程 B 能读到同一值（跨进程可见）。
 *   2. 子进程 C 删除记录 → 进程 B 再读为不存在（跨进程删除生效）。
 *   3. 无论成败，记录都被清理（不留残余项）。
 *
 * 用法：node scripts/probe/run-keychain-cross-process-probe.mjs
 * 退出码：0 三条判据成立；1 有判据不成立；2 环境不具备（非 darwin 或系统钥匙串不可用）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const pkg = join(here, '../../packages/forge-credentials-keychain/src');
const { createSecurityCliBackend, probeSecurityCli } = await import(`${pkg}/security-cli.mjs`);

const role = process.argv[2] ?? null;
const service = 'heluo-forge-keychain-cross-process';
const accountPrefix = 'iam';
const account = `${service}/${accountPrefix}/record/${process.env.KEYCHAIN_PROBE_KEY ?? 'unknown'}`;

// ── 子进程角色：只做一件事，绝不打印值 ──────────────────────────────
if (role === 'set') {
  const backend = createSecurityCliBackend({ service });
  await backend.set(account, process.env.KEYCHAIN_PROBE_VALUE);
  process.exit(0);
}
if (role === 'delete') {
  const backend = createSecurityCliBackend({ service });
  await backend.delete(account);
  process.exit(0);
}
if (role === 'get') {
  const backend = createSecurityCliBackend({ service });
  const value = await backend.get(account);
  process.stdout.write(value === undefined ? 'MISSING' : 'PRESENT');
  process.exit(0);
}
if (role !== null) {
  console.error('keychain-cross-process: unknown role');
  process.exit(2);
}

// ── 父进程：编排三个子进程并判定 ────────────────────────────────────
if (process.platform !== 'darwin') {
  console.error(`keychain-cross-process: 仅 darwin 可跑（当前 ${process.platform}）；其他平台适配器待实测`);
  process.exit(2);
}
const probe = probeSecurityCli();
if (!probe.available) {
  console.error(`keychain-cross-process: 系统钥匙串不可用（${probe.reason ?? probe.status}）`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'forge-keychain-cross-process-'));
const key = `session-${randomBytes(4).toString('hex')}`;
const secret = `cross-process-canary-${randomBytes(16).toString('hex')}`;
const env = { ...process.env, KEYCHAIN_PROBE_KEY: key, KEYCHAIN_PROBE_VALUE: secret };
const report = {
  probe: 'keychain-cross-process',
  env: { platform: `${process.platform}-${process.arch}`, node: process.version },
  steps: [],
  ok: true,
};
const record = (id, ok, detail = {}) => {
  report.steps.push({ id, ok, detail });
  if (!ok) report.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

const child = (childRole) =>
  spawnSync(process.execPath, [self, childRole], { env, encoding: 'utf8', timeout: 30_000 });

const parentRead = async () => {
  const backend = createSecurityCliBackend({ service });
  return backend.get(`${service}/${accountPrefix}/record/${key}`);
};
const parentDelete = async () => {
  const backend = createSecurityCliBackend({ service });
  await backend.delete(`${service}/${accountPrefix}/record/${key}`).catch(() => {});
};

let wrote = false;
try {
  const set = child('set');
  wrote = set.status === 0;
  record('child-process-writes-record', wrote, { exitCode: set.status });

  const readByParent = await parentRead();
  record('parent-process-reads-same-value', readByParent === secret, {
    valueMatched: readByParent === secret,
    valueLength: typeof readByParent === 'string' ? readByParent.length : null,
  });

  const getByOtherChild = child('get');
  record('third-process-reads-same-value', getByOtherChild.stdout === 'PRESENT', {
    exitCode: getByOtherChild.status,
    outcome: getByOtherChild.stdout,
  });

  const del = child('delete');
  record('child-process-deletes-record', del.status === 0, { exitCode: del.status });

  const afterDelete = await parentRead();
  record('record-gone-after-cross-process-delete', afterDelete === undefined, {
    valuePresent: afterDelete !== undefined,
  });
} catch (error) {
  record('cross-process-sequence', false, { threw: String(error?.message ?? error).slice(0, 160) });
} finally {
  // 成败都要清场：真钥匙串里不留探针记录。
  if (wrote) await parentDelete();
  const residue = await parentRead();
  record('no-residue-after-cleanup', residue === undefined, { residuePresent: residue !== undefined });
}

writeFileSync(join(dir, 'keychain-cross-process.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ probe: report.probe, ok: report.ok, steps: report.steps.length, dir }, null, 2));
process.exit(report.ok ? 0 : 1);
