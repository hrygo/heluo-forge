import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '../scripts/probe/run-host-probe.mjs');

const dsh = process.env.DSH_BIN ?? 'dsh';
const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
const skip =
  version.error === undefined
    ? false
    : `目标 DSH 不在本机 PATH（${version.error.message}）；宿主探针只在装有目标版本的环境运行`;

test('host probe: target DSH honours the documented tool-pipeline semantics', { skip }, () => {
  const run = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 300_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `host probe failed (exit ${run.status}):\n${output}`);
  assert.match(output, /9\/9 checks passed/, 'host probe must report every check as passed');
});
