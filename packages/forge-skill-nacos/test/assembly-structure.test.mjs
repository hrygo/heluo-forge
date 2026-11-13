import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('assembly point only assembles: scheduling state lives in poll.mjs (ENG-003 P2)', async () => {
  const index = await read('src/index.mjs');
  const poll = await read('src/poll.mjs');
  // 符号归属判据（非行号）：定时器与退避只允许出现在轮询轴模块。
  assert.doesNotMatch(index, /\bsetTimeout\b|\bsetInterval\b|\bclearTimeout\b/, '装配点不得持有定时调度');
  assert.match(poll, /\bsetTimeout\b/, '轮询轴模块应持有 setTimeout');
  assert.match(index, /createCatalogPoller\(/, '装配点经显式端口装配轮询');
});
