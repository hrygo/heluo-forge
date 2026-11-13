import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(here, '..', '..');
const read = (file) => readFile(join(here, file), 'utf8');

const BASE_PATCH = 'cordis.patch.yml';

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

/** `insert:` 段里的 `id` → `name` 映射（缩进四级）。 */
function insertedRows(text) {
  return [...text.matchAll(/^ {4}- id: (\S+)\n {6}name: '([^']+)'$/gmu)].map((m) => [m[1], m[2]]);
}

test('the base patch disables official access, generic model configuration and local credentials', async () => {
  const text = await read(BASE_PATCH);
  const disabled = disabledIds(text);
  assert.deepEqual(
    [...disabled.entries()].sort(),
    [
      ['credentials', true],
      ['deepseek-account', true],
      ['llm-deepseek', true],
      ['llm-deepseek-account', true],
      ['llm-pi-ai', true],
      ['ui-settings-account', true],
      ['ui-settings-models', true],
    ],
    '官方账号、通用模型配置与本地凭据提供方都必须以 disabled: true 关闭',
  );
});

test('the local credentials row is disabled rather than removed or re-enabled', async () => {
  const text = await read(BASE_PATCH);
  const disabled = disabledIds(text);
  assert.equal(disabled.get('credentials'), true, '官方 local 提供方必须命中并被禁用');
  assert.doesNotMatch(text, /^ {4}- id: credentials$/mu, '不得把官方 local 行复制进 insert 段');
});

test('the base bundle mounts only universal account, keychain, and policy rows with zero R&D surface', async () => {
  const text = await read(BASE_PATCH);
  assert.deepEqual(
    insertedRows(text),
    [
      ['heluo-credentials-keychain', '@heluo/forge-credentials-keychain'],
      ['heluo-policy', '@heluo/forge-policy'],
      ['heluo-iam', '@heluo/forge-iam'],
    ],
    '通用底座只装凭据、策略与 IAM，不含任何研发行',
  );
  assert.doesNotMatch(text, /forge-devops|heluo-gitee|issue-delivery-skill|heluo-engineering-ui/u);
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-(devops|gitee|engineering)'$/mu);
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-market'$/mu, '历史市场包不挂（AC5）');
  assert.doesNotMatch(text, /^- id: (enterprise|forge)-/mu, '禁用段不复制企业行，只覆写官方行');
  assert.match(text, /DEEPSEEK_API_KEY/, '文件需说明 API Key 旁路这条核验依据');
});

test('the base manifest declares only universal dependencies and no R&D exports or client UI', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-enterprise');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client, undefined);
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['@heluo/forge-credentials-keychain', '@heluo/forge-iam', '@heluo/forge-policy'],
  );
  assert.equal(manifest.exports['./client'], undefined);
  assert.equal(manifest.exports['./skills'], undefined);
  assert.equal(manifest.exports['./switches'], undefined);
  assert.equal(manifest.exports['./issue-delivery-skill'], undefined);
  assert.equal(manifest.files.includes('cordis.patch.engineering.yml'), false);
  assert.equal(manifest.files.includes('client.js'), false);
  assert.equal(manifest.files.includes('skills'), false);
});

test('every inserted package exists, is private, and has a manifest', async () => {
  const text = await read(BASE_PATCH);
  const names = [...text.matchAll(/^ {6}name: '([^']+)'$/gmu)].map((m) => m[1]);
  assert.equal(names.length, 3);
  for (const name of names) {
    const segments = name.split('/');
    const packageName = segments.slice(0, 2).join('/');
    const dir = join(repoRoot, 'packages', segments[1]);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.private, true);
    assert.ok(manifest.engines?.dsh);
  }
});

test('the README states the universal base status honestly without R&D leakage', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（组合骨架/);
  assert.match(text, /cordis\.patch\.yml/);
  assert.doesNotMatch(text, /cordis\.patch\.engineering\.yml/);
  assert.doesNotMatch(text, /issue-delivery|dop|gh\s+CLI|企业研发工具/u);
});
