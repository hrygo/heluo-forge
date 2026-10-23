import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

/** 逐行解析补丁：`- id: X` 后面紧跟的 `disabled: true` 视为该行被禁用。 */
function disabledIds(text) {
  const lines = text.split('\n');
  const disabled = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- id: (.+)$/u.exec(lines[index]);
    if (match === null) continue;
    const id = match[1].trim();
    const next = lines[index + 1]?.trim();
    disabled.set(id, next === 'disabled: true');
  }
  return disabled;
}

test('the bundle disables exactly the four official rows', async () => {
  const text = await read('cordis.patch.yml');
  const disabled = disabledIds(text);
  assert.deepEqual(
    [...disabled.entries()].sort(),
    [
      ['deepseek-account', true],
      ['llm-deepseek', true],
      ['llm-deepseek-account', true],
      ['ui-settings-account', true],
    ],
    '四个官方行都必须以 disabled: true 关闭，且不多不少',
  );
});

test('the bundle composes nothing it cannot yet mount', async () => {
  const text = await read('cordis.patch.yml');
  assert.doesNotMatch(text, /^\s*insert:/mu, '组合插入行待对应包可用后再落，不预建未实现包的入口');
  assert.doesNotMatch(text, /^(\s*)- id: (enterprise|forge)-/mu, '禁用段不复制企业行，只覆写官方行');
  assert.match(text, /DEEPSEEK_API_KEY/, '文件需说明 API Key 傍路这条核验依据');
});

test('the README states the current bundle status honestly', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（组合骨架/);
  assert.match(text, /cordis\.patch\.yml/);
  assert.match(text, /官方行禁用层已实现/);
  assert.match(text, /组合插入行[^|]*未实现/);
});
