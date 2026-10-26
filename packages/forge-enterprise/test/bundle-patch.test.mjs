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

test('the bundle mounts exactly the implemented enterprise packages', async () => {
  const text = await read('cordis.patch.yml');
  const inserted = [...text.matchAll(/^ {4}- id: (\S+)\n {6}name: '([^']+)'$/gmu)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    inserted,
    [
      ['heluo-credentials-keychain', '@heluo/forge-credentials-keychain'],
      ['heluo-policy', '@heluo/forge-policy'],
      ['heluo-iam', '@heluo/forge-iam'],
    ],
    '插入行只能是真正的三个Host插件；SDD保留CLI，不伪装插件',
  );
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-market'$/mu, '历史市场包不挂（AC5）；注释里提到它不算挂载');
  assert.doesNotMatch(text, /^( {4})- id: (enterprise|forge)-/mu, '禁用段不复制企业行，只覆写官方行');
  assert.match(text, /DEEPSEEK_API_KEY/, '文件需说明 API Key 傍路这条核验依据');
});

test('every inserted package exists, is private, and has a manifest', async () => {
  const text = await read('cordis.patch.yml');
  const names = [...text.matchAll(/^ {6}name: '([^']+)'$/gmu)].map((m) => m[1]);
  assert.equal(names.length, 3);
  for (const name of names) {
    const dir = join(here, '..', name.replace('@heluo/', ''));
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name, `${name} 的清单名必须与插入行一致`);
    assert.equal(manifest.private, true, `${name} 必须是私有包`);
    assert.ok(manifest.engines?.dsh, `${name} 必须声明 engines.dsh`);
  }
});

test('the README states the current bundle status honestly', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（组合骨架/);
  assert.match(text, /cordis\.patch\.yml/);
  assert.match(text, /官方行禁用层已实现/);
  assert.match(text, /insert:[^|]*三个 Host 插件/);
  assert.match(text, /运行时模型面与企业环境接入未实现/);
});
