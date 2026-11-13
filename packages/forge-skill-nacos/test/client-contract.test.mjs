import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = await readFile(join(here, 'client.js'), 'utf8');

test('client.js keeps the single-file loader shell (ENG-003)', () => {
  assert.match(text, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: '@heluo\/forge-skill-nacos',/);
  assert.doesNotMatch(text, /^\s*import\s/m, 'client.js 不得出现 import 语句');
  assert.doesNotMatch(text, /^\s*export\s/m, 'client.js 不得出现 export 语句');
  assert.match(text, /require\('react'\)/);
});

test('api() call sites pass data objects, never fetch-init shapes', () => {
  // 回归守卫：源设置切换环境曾把 { method, body } 当数据体传给 api()，
  // 服务端白名单以 SN_CONFIG_INVALID 不可覆盖的字段：method, body 拒绝。
  // api(path, body) 的第二参由其内部 stringify 并设 POST 头。
  assert.doesNotMatch(
    text,
    /api\((?:[^()]|\([^()]*\))*,\s*\{\s*(?:method|body|headers)\s*:/,
    'api() 第二参不得是 fetch-init 形状对象',
  );
});

test('section anchors §1..§14 are present in order (ENG-003 P1)', () => {
  const numbers = [...text.matchAll(/^ {4}\/\/ §(\d+) /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, Array.from({ length: 14 }, (_, i) => i + 1), '锚点须从 §1 连续编号');
});

test('error body is unpacked only in resultNotice (ENG-003 P5)', () => {
  // 符号归属：错误码解包只允许出现在 resultNotice；api() 构造错误体不算解包渲染。
  // 模板插值 `${....code}` 形态即视为分散解包。
  assert.doesNotMatch(text, /\$\{[^}]*\.code/, '不得在模板插值中直接解包错误码');
  const callSites = text.match(/text: resultNotice\(/g) ?? [];
  assert.equal(callSites.length, 4, '四个错误提示位须全部经 resultNotice 渲染');
  assert.equal((text.match(/function resultNotice\(/g) ?? []).length, 1, 'resultNotice 唯一定义');
});
