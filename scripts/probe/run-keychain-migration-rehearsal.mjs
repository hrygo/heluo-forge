/**
 * #13 AC4 本地区块：旧 0600 明文记录 → 系统钥匙串的**迁移演练**。
 *
 * 全程只碰副本：旧记录是探针在临时目录里自己创建的合成文件，写入的是本探针自己的、
 * account 随机的钥匙串条目；不读取、不删除任何真实凭据记录，也不写仓库或真实 profile。
 * 量四件事：迁移成功后才删旧值、keychain 不可用 fail closed、回读不一致即停、证据里无秘密值。
 *
 * 用法：node scripts/probe/run-keychain-migration-rehearsal.mjs
 * 退出码：0 全部符合预期；1 有失败项；2 环境不具备（非 darwin 或没有 security）。
 * 证据：临时目录里的 keychain-migration.json（只含布尔、键名与退出码，不含口令）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../../packages/forge-credentials-keychain/src');

const { createFileBackend, createUnavailableBackend } = await import(`${pkg}/backend.mjs`);
const { migrateLegacyFileToKeychain } = await import(`${pkg}/migrate.mjs`);
const { createSecurityCliBackend, probeSecurityCli } = await import(`${pkg}/security-cli.mjs`);

if (process.platform !== 'darwin') {
  console.error(`keychain-migration: 仅 darwin 可跑（当前 ${process.platform}）；Windows 凭据管理器与麒麟 Secret Service 适配器待实测`);
  process.exit(2);
}

const service = 'heluo-forge-keychain-migration';
const accountPrefix = 'iam';
const suffix = randomBytes(4).toString('hex');
const secret = `migration-canary-${randomBytes(16).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'forge-keychain-migration-'));
const report = {
  probe: 'forge-keychain-migration-rehearsal',
  env: { platform: `${process.platform}-${process.arch}`, node: process.version },
  steps: [],
  ok: true,
};
const record = (id, ok, detail = {}) => {
  report.steps.push({ id, ok, detail });
  if (!ok) report.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

const probe = probeSecurityCli();
record('security-cli-available', probe.available, { status: probe.status, keychainCount: probe.keychainCount, reason: probe.reason });
if (!probe.available) {
  writeFileSync(join(dir, 'keychain-migration.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`keychain-migration: 系统钥匙串不可用；证据留在 ${dir}`);
  process.exit(2);
}

report.env.os = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim();
const backend = createSecurityCliBackend({ service });
const createdKeys = [];

/** 在临时目录里造一份 0600 明文旧记录（合成值，非真实凭据）。 */
async function makeLegacy(name, payload) {
  const path = join(dir, `${name}.json`);
  const file = createFileBackend({ path });
  await file.set(`${service}/${accountPrefix}/record/${name}`, payload);
  return { path, account: `${service}/${accountPrefix}/record/${name}`, mode: statSync(path).mode & 0o777 };
}

const plaintextFilesIn = (target) => {
  const names = [];
  for (const entry of readdirSync(target)) {
    const path = join(target, entry);
    if (!statSync(path).isFile()) continue;
    if (readFileSync(path, 'utf8').includes(secret)) names.push(entry);
  }
  return names;
};

try {
  // A. 真钥匙串：迁移成功、回读一致，之后才删旧文件。
  const legacyA = await makeLegacy(`session-${suffix}`, secret);
  createdKeys.push(legacyA.account);
  record('legacy-fixture-is-0600', legacyA.mode === 0o600, { mode: legacyA.mode.toString(8) });
  const resultA = await migrateLegacyFileToKeychain({ legacyPath: legacyA.path, backend, service, accountPrefix });
  const keychainValue = await backend.get(legacyA.account);
  record(
    'migrate-then-delete-legacy',
    resultA.migrated === true &&
      resultA.legacyDeleted === true &&
      resultA.plaintextWritten === false &&
      keychainValue === secret &&
      !readdirSync(dir).includes(`session-${suffix}.json`),
    {
      migrated: resultA.migrated,
      legacyDeleted: resultA.legacyDeleted,
      keychainMatches: keychainValue === secret,
      legacyFileGone: !readdirSync(dir).includes(`session-${suffix}.json`),
    },
  );
  record('no-new-plaintext-after-migration', plaintextFilesIn(dir).length === 0, { plaintextFiles: plaintextFilesIn(dir) });

  // B. keychain 不可用：fail closed，副本原样保留。
  const legacyB = await makeLegacy(`session-b-${suffix}`, secret);
  const resultB = await migrateLegacyFileToKeychain({
    legacyPath: legacyB.path,
    backend: createUnavailableBackend('adapter missing'),
    service,
    accountPrefix,
  });
  record(
    'unavailable-keychain-fails-closed',
    resultB.migrated === false &&
      resultB.reason === 'keychain-unavailable' &&
      readdirSync(dir).includes(`session-b-${suffix}.json`) &&
      (statSync(legacyB.path).mode & 0o777) === 0o600,
    { reason: resultB.reason, legacyRetained: readdirSync(dir).includes(`session-b-${suffix}.json`), plaintextWritten: resultB.plaintextWritten },
  );

  // C. 回读不一致（真实钥匙串 + 夹具包装）：立即停止、旧文件保留、条目留待人工核查。
  const legacyC = await makeLegacy(`session-c-${suffix}`, secret);
  createdKeys.push(legacyC.account);
  const tampering = {
    ...backend,
    async set(key, value) {
      await backend.set(key, `${value}-tampered`);
    },
  };
  const resultC = await migrateLegacyFileToKeychain({ legacyPath: legacyC.path, backend: tampering, service, accountPrefix });
  record(
    'read-back-mismatch-stops-and-keeps-legacy',
    resultC.migrated === false && resultC.reason === 'read-back-mismatch' && readdirSync(dir).includes(`session-c-${suffix}.json`),
    { reason: resultC.reason, legacyRetained: readdirSync(dir).includes(`session-c-${suffix}.json`) },
  );

  // D. 目标已有不同值：不覆盖。
  const legacyD = await makeLegacy(`session-d-${suffix}`, secret);
  createdKeys.push(legacyD.account);
  await backend.set(legacyD.account, 'pre-existing-other-value');
  const resultD = await migrateLegacyFileToKeychain({ legacyPath: legacyD.path, backend, service, accountPrefix });
  const keptValue = await backend.get(legacyD.account);
  record(
    'target-conflict-does-not-overwrite',
    resultD.migrated === false && resultD.reason === 'target-conflict' && keptValue === 'pre-existing-other-value',
    { reason: resultD.reason, existingValueKept: keptValue === 'pre-existing-other-value' },
  );

  // E. 证据与消息不含秘密值。
  const serialized = JSON.stringify({ steps: report.steps, env: report.env });
  record('no-secret-in-evidence', !serialized.includes(secret), { containsSecret: serialized.includes(secret) });
} finally {
  for (const key of createdKeys) {
    await backend.delete(key).catch(() => {});
  }
  const residue = [];
  for (const key of createdKeys) {
    try {
      const value = await backend.get(key);
      if (value !== undefined) residue.push(key);
    } catch {
      residue.push(key);
    }
  }
  record('cleanup-verified', residue.length === 0, { residueKeys: residue.length });
  writeFileSync(join(dir, 'keychain-migration.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`keychain-migration: ${report.steps.filter((step) => step.ok).length}/${report.steps.length} steps ok`);
  console.log(`keychain-migration: 证据留在 ${dir}`);
  if (!report.ok) process.exitCode = 1;
}
