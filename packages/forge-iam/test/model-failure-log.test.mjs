import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelFailureLogger } from '../src/model-failure-log.mjs';

test('writes structured diagnostics without unknown codes or request values', t => {
  const home = mkdtempSync(join(tmpdir(), 'forge-diagnostics-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = createModelFailureLogger({ home });
  log({ detailCode: 'secret-code-value', code: 'ENTERPRISE_GATEWAY_CALL_FAILED', message: 'fixed safe message', stage: 'unknown', request: { provider: 'secret-provider', model: 'secret-model', sessionId: 'secret-session', messages: ['secret-prompt'] } });
  const path = join(home, 'logs', 'forge-iam-model-failures.jsonl');
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /secret-/);
  const event = JSON.parse(text);
  assert.equal(event.detailCode, null);
  assert.equal(event.stage, 'unknown');
  assert.equal(event.modelHash.length, 64);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0);
});

test('writes known internal codes and reports an unwritable log without throwing', t => {
  const home = mkdtempSync(join(tmpdir(), 'forge-diagnostics-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = createModelFailureLogger({ home });
  log({ detailCode: 'IAM_UNREACHABLE', code: 'ENTERPRISE_IAM_UNAVAILABLE', message: 'safe', stage: 'local' });
  const event = JSON.parse(readFileSync(join(home, 'logs', 'forge-iam-model-failures.jsonl'), 'utf8'));
  assert.equal(event.detailCode, 'IAM_UNREACHABLE');
  assert.equal(event.stage, 'local');
  const blocked = join(home, 'blocked');
  writeFileSync(blocked, 'not a directory');
  let warnings = 0;
  assert.doesNotThrow(() => createModelFailureLogger({ home: blocked, warn: () => warnings++ })({}));
  assert.equal(warnings, 1);
});
