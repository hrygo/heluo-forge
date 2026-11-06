import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readDshVersion } from '../scripts/lib/dsh-version.mjs';
import { hostProbeGate } from '../scripts/lib/host-probe-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const runner = resolve(here, '../scripts/probe/run-host-probe.mjs');

const dsh = process.env.DSH_BIN ?? 'dsh';
const target = readDshVersion(root);
const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
// K-1：探针只在目标宿主（.dsh-version）上有判定意义；版本不符时按 PRD AC-13 显式 skip，
// 文案写明实际/目标版本与原因。DSH_HOST_PROBE_FORCE=1 可强制复跑，断言本身不因门控变化。
const gate = hostProbeGate({
  actual: version.stdout,
  target,
  force: process.env.DSH_HOST_PROBE_FORCE === '1',
  error: version.error,
});

test('host probe: target DSH honours the documented tool-pipeline semantics without DSH_HOME', (t) => {
  if (gate.skip) return t.skip(gate.reason);
  const env = { ...process.env };
  delete env.DSH_HOME;
  const run = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 300_000, env });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `host probe failed (exit ${run.status}):\n${output}`);
  assert.match(output, /\d+\/\d+ checks passed/, 'host probe must report a check summary');
  assert.doesNotMatch(output, /^FAIL /m, 'no host probe check may fail');
});

test('host probe: ignores unrelated DSH_HOME profile patches', (t) => {
  if (gate.skip) return t.skip(gate.reason);
  const home = mkdtempSync(join(tmpdir(), 'forge-host-probe-home-'));
  try {
    const profileDir = join(home, 'profiles', 'sdk');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: unrelated-broken-plugin\n      name: definitely-not-an-installed-plugin\n');
    const env = { ...process.env, DSH_HOME: home };
    const dump = spawnSync(dsh, ['--profile', 'sdk', '--dump-config'], { encoding: 'utf8', env });
    assert.match(dump.stdout, /unrelated-broken-plugin/, 'fixture must actually pollute the host profile');
    const run = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 300_000, env });
    assert.equal(run.status, 0, `probe must not inherit the unrelated profile:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /\d+\/\d+ checks passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
