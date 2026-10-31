/**
 * #107: demonstrate that unsafe legacy migration is blocked. This is an
 * offline synthetic fixture, not an OS-keychain migration or acceptance test.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyFileToKeychain } from '../../packages/forge-credentials-keychain/src/migrate.mjs';

const dir = await mkdtemp(join(tmpdir(), 'forge-migration-blocked-'));
const path = join(dir, 'legacy.json');
const original = JSON.stringify({ version: 1, entries: { 'fixture/iam/record/session': 'synthetic-value' } });
let accesses = 0;
const unexpected = async () => { accesses += 1; throw new Error('unexpected access'); };
try {
  await writeFile(path, original, { mode: 0o600 });
  const result = await migrateLegacyFileToKeychain({
    legacyPath: path,
    backend: { available: true, get: unexpected, set: unexpected, transaction: unexpected },
    readLegacy: unexpected,
    removeLegacy: unexpected,
  });
  const unchanged = (await readFile(path, 'utf8')) === original;
  const ok = result.migrated === false && result.reason === 'target-atomic-unavailable'
    && result.legacyDeleted === false && result.legacyRetained === null
    && result.plaintextWritten === false && accesses === 0 && unchanged;
  console.log(`${ok ? 'ok' : 'FAIL'} migration-blocked-no-access`);
  console.log('BLOCKED: actual migration and platform acceptance remain unverified');
  if (!ok) process.exitCode = 1;
} finally {
  // Only the private directory created by this probe is removed.
  await rm(dir, { recursive: true, force: true });
}
