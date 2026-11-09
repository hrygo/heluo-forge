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

/**
 * DSH 0.2.2-rc.1 的 `tools.execute` 形状替身：宿主把 `input.calls` 直接 `.map(...)`
 * （`dsh-tools/lib/pipeline.js:33`，经 `NativeToolExecutor.execute` 与
 * `ToolsService.execute` 转给执行器），单次对象会在这里抛
 * `TypeError: Cannot read properties of undefined (reading 'map')`。
 * 替身若接受单对象，就只是在测我们自己的假设，因此这里刻意保持严格。
 */
function batchHost(settle) {
  const seen = [];
  return {
    seen,
    tools: {
      execute: async (input) => {
        seen.push(input);
        if (!Array.isArray(input?.calls)) {
          throw new TypeError("Cannot read properties of undefined (reading 'map')");
        }
        return { results: input.calls.map((call) => ({ callId: call.id, result: settle(call) })) };
      },
    },
  };
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });

test('dispatchTool: sends the host`s one-element calls batch, not a single call object', async () => {
  const host = batchHost((call) =>
    call.name === 'probe_x' ? textResult('probe_x ran') : { content: [{ type: 'text', text: 'unexpected' }] },
  );
  const signal = new AbortController().signal;
  const result = await dispatchTool({ tools: host.tools }, 'probe_x', { target: 'demo' }, { callId: 'probe-7', signal });
  assert.equal(result.isError, false);
  assert.equal(result.text, 'probe_x ran');
  assert.equal(host.seen.length, 1);
  const [input] = host.seen;
  assert.deepEqual(Object.keys(input).sort(), ['calls', 'signal'], 'batch input carries calls and the caller signal');
  assert.equal(input.signal, signal);
  assert.equal(input.calls.length, 1);
  assert.deepEqual(input.calls[0], { id: 'probe-7', name: 'probe_x', arguments: '{"target":"demo"}' });
});

test('dispatchTool: reads the matching entry out of results and keeps error details', async () => {
  const host = batchHost(() => ({
    isError: true,
    content: [{ type: 'text', text: 'probe-guard-deny' }],
    error: { code: 'DENIED', message: 'probe-guard-deny' },
  }));
  // A settled batch may carry more than the dispatched call; only the matching callId is ours.
  const raw = host.tools.execute;
  host.tools.execute = async (input) => {
    const settled = await raw(input);
    return { results: [{ callId: 'someone-else', result: textResult('other') }, ...settled.results] };
  };
  const result = await dispatchTool({ tools: host.tools }, 'probe_body', {}, { callId: 'probe-8' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'probe-guard-deny');
  assert.deepEqual(result.error, { code: 'DENIED', message: 'probe-guard-deny' });
});

test('dispatchTool: a batch with no result for the dispatched call fails loudly', async () => {
  const tools = { execute: async () => ({ results: [] }) };
  await assert.rejects(
    dispatchTool({ tools }, 'probe_x', {}, { callId: 'probe-9' }),
    /no result for probe-9/,
    'silently returning empty text would look like a passed probe',
  );
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
