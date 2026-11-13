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
