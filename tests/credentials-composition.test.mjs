import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'probe', 'run-credentials-composition-probe.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const dshReady = spawnSync(dsh, ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = process.env.DSH_CREDENTIALS_PROBE !== '0';
// This probe needs the installed SDK: it mounts the real
// `dsh-credentials-local` instead of a fixture. A missing host is NOT RUN, not a
// silent pass, so CI without DSH never claims the composition was verified.
const skip = dshReady && enabled ? false : `needs ${dsh} on PATH (or DSH_CREDENTIALS_PROBE=0)`;

test('the single-credentials-provider composition holds in both activation orders', { skip, timeout: 180_000 }, () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 150_000,
    env: process.env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `probe exited ${result.status}: ${output}`);

  // Negative control: with the local row still enabled, a write reaches the
  // plaintext file — this is the shape #125 reports.
  assert.match(output, /ok +enabled-local\/local-first-effective-owner-is-local/u);
  // Order matters and the probe records both facts instead of hiding one:
  // mounting the real local provider first leaves it owning the store.
  assert.match(output, /ok +enabled-local\/keychain-first-effective-owner-is-keychain/u);
  assert.match(output, /ok +enabled-local\/local-first-second-provider-refused/u);
  assert.match(output, /ok +enabled-local\/keychain-first-second-provider-refused/u);
  assert.match(output, /ok +disabled-local\/local-first-legacy-file-untouched/u);
  assert.match(output, /ok +disabled-local\/keychain-first-legacy-file-untouched/u);
  // Fixed composition: one provider, keychain-backed write, no plaintext file.
  for (const order of ['local-first', 'keychain-first']) {
    assert.match(output, new RegExp(`ok +disabled-local/${order}-mounts-one-provider`));
    assert.match(output, new RegExp(`ok +disabled-local/${order}-writes-through-the-keychain-backend`));
    assert.match(output, new RegExp(`ok +disabled-local/${order}-no-plaintext-file`));
    assert.match(output, new RegExp(`ok +disabled-local/${order}-unavailable-backend-publishes-no-provider`));
    assert.match(output, new RegExp(`ok +disabled-local/${order}-legacy-file-untouched`));
  }
  assert.doesNotMatch(output, /^FAIL /mu);
  assert.match(output, /"ok": true/u);
});
