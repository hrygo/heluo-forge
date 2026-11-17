import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

test('preserved local management and Nacos regression suite', { timeout: 480000 }, async () => {
  const files = (await readdir(join(root, 'spec'))).filter(name => name.endsWith('.case.mjs')).sort();
  assert.ok(files.length >= 20, 'preserved suite unexpectedly empty');
  const result = await new Promise((resolve, reject) => {
    const environment = { ...process.env, FORCE_COLOR: '0' };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-timeout=240000', '--test-reporter=tap', ...files.map(name => `spec/${name}`)], {
      cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(Number(result.output.match(/# tests (\d+)/)?.[1]) >= files.length, 'child suite must actually execute its tests');
});
