import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dispatchTool } from '../scripts/probe/host-probe-plugin.mjs';
import { hostProbeGate } from '../scripts/lib/host-probe-gate.mjs';
import { readDshVersion } from '../scripts/lib/dsh-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '../scripts/probe/run-host-probe.mjs');

/** The target DSH tools service accepts one ToolExecutionInput and returns one result. */
function singleCallHost(settle) {
  const seen = [];
  return {
    seen,
    tools: {
      execute: async (input) => {
        seen.push(input);
        assert.equal(typeof input?.callId, 'string');
        assert.equal(typeof input?.name, 'string');
        assert.equal(Array.isArray(input?.calls), false);
        return settle(input);
      },
    },
  };
}

const textResult = (text) => ({ isError: false, content: [{ type: 'text', text }], value: { text } });

test('dispatchTool: sends the target host one call with parsed arguments', async () => {
  const host = singleCallHost((call) =>
    call.name === 'probe_x' ? textResult('probe_x ran') : textResult('unexpected'),
  );
  const signal = new AbortController().signal;
  const result = await dispatchTool({ tools: host.tools }, 'probe_x', { target: 'demo' }, { callId: 'probe-7', signal });
  assert.equal(result.isError, false);
  assert.equal(result.text, 'probe_x ran');
  assert.equal(host.seen.length, 1);
  const [input] = host.seen;
  assert.deepEqual(input, { callId: 'probe-7', name: 'probe_x', arguments: { target: 'demo' }, signal });
  assert.equal(result.shape.kind, 'object');
  assert.deepEqual(result.shape.keys, ['isError', 'content', 'value']);
});

test('dispatchTool: preserves the single result error details', async () => {
  const host = singleCallHost(() => ({
    isError: true,
    content: [{ type: 'text', text: 'probe-guard-deny' }],
    error: { code: 'DENIED', message: 'probe-guard-deny' },
  }));
  const result = await dispatchTool({ tools: host.tools }, 'probe_body', {}, { callId: 'probe-8' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'probe-guard-deny');
  assert.deepEqual(result.error, { code: 'DENIED', message: 'probe-guard-deny' });
});

test('dispatchTool: defaults the call ID and arguments', async () => {
  const host = singleCallHost(() => textResult('probe_x ran'));
  await dispatchTool({ tools: host.tools }, 'probe_x', null, { callId: '' });
  assert.equal(host.seen[0].callId, 'probe-probe_x');
  assert.deepEqual(host.seen[0].arguments, {});
  assert.ok(host.seen[0].signal instanceof AbortSignal);
});

test('dispatchTool: malformed or batch results fail instead of looking successful', async () => {
  for (const returned of [undefined, null, {}, { results: [] }, { isError: false }, { isError: false, content: 'text' }]) {
    const tools = { execute: async () => returned };
    await assert.rejects(
      dispatchTool({ tools }, 'probe_x', {}, { callId: 'probe-9' }),
      /invalid result for probe-9/,
    );
  }
});

const dsh = process.env.DSH_BIN ?? 'dsh';
const root = resolve(here, '..');
const target = readDshVersion(root);
const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
// 探针只在目标宿主（.dsh-version）上才有判定意义：版本不符时显式 skip 并写明实际/目标版本，
// 否则每次宿主升级都会让整棵 node --test 变红，掩盖真实回归（K-1，PRD AC-13）。
// `DSH_HOST_PROBE_FORCE=1` 可强制在任意宿主复跑，断言本身不随门控变化。
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
