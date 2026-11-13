import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

const BASE_PATCH = 'cordis.patch.yml';
const ENGINEERING_PATCH = 'cordis.patch.engineering.yml';

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
  // 覆写层只加 disabled 字段，行本身仍由基础组合提供；这里防止用删除或
  // 重新插入同名行来“看起来”关掉它。
  assert.doesNotMatch(text, /^ {4}- id: credentials$/mu, '不得把官方 local 行复制进 insert 段');
});

test('the base layer mounts exactly the universal enterprise packages', async () => {
  const text = await read(BASE_PATCH);
  assert.deepEqual(
    insertedRows(text),
    [
      ['heluo-credentials-keychain', '@heluo/forge-credentials-keychain'],
      ['heluo-policy', '@heluo/forge-policy'],
      ['heluo-iam', '@heluo/forge-iam'],
    ],
    '通用底座只装凭据、策略与 IAM；研发成员进叠加层',
  );
  // 研发域成员进基础层会让每个通用用户都拿到 DevOps / Gitee 设置入口。
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-(devops|gitee)'$/mu, '研发成员不得进基础层');
  assert.doesNotMatch(text, /issue-delivery-skill/u, '研发 Skill 不得进基础层');
  assert.doesNotMatch(text, /name: '@heluo\/forge-enterprise'$/mu, '容器行只在研发叠加层');
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-market'$/mu, '历史市场包不挂（AC5）；注释里提到它不算挂载');
  // 只认**顶层**禁用段：insert 里的企业行不能被这条反面断言误伤。
  assert.doesNotMatch(text, /^- id: (enterprise|forge)-/mu, '禁用段不复制企业行，只覆写官方行');
  assert.match(text, /DEEPSEEK_API_KEY/, '文件需说明 API Key 傍路这条核验依据');
});

test('the engineering overlay mounts the R&D members and the UI container row only', async () => {
  const text = await read(ENGINEERING_PATCH);
  assert.deepEqual(
    insertedRows(text),
    [
      ['heluo-engineering-ui', '@heluo/forge-enterprise'],
      ['heluo-issue-delivery-skill', '@heluo/forge-enterprise/issue-delivery-skill'],
      ['forge-devops', '@heluo/forge-devops'],
      ['heluo-gitee', '@heluo/forge-gitee'],
    ],
    '叠加层 = 容器行 + 研发 Skill + DevOps + Gitee',
  );
  // 策略与 IAM 在基础层：两层同时生效时重复插入同一行会让装配顺序决定幸存配置。
  assert.doesNotMatch(text, /heluo-policy|heluo-iam/u, '叠加层不重复声明策略或 IAM');
  assert.doesNotMatch(text, /disabled: true/u, '叠加层不做官方行禁用');
});

test('the two layers stay disjoint so layering never re-inserts a row', async () => {
  const ids = [...insertedRows(await read(BASE_PATCH)), ...insertedRows(await read(ENGINEERING_PATCH))]
    .map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length, '同一行 id 不得同时出现在两层');
});

test('every inserted package exists, is private, and has a manifest', async () => {
  const texts = await Promise.all([read(BASE_PATCH), read(ENGINEERING_PATCH)]);
  const names = texts.flatMap((text) => [...text.matchAll(/^ {6}name: '([^']+)'$/gmu)].map((m) => m[1]));
  assert.equal(names.length, 7);
  for (const name of names) {
    // `@heluo/<pkg>/<subpath>` 与 `@heluo/<pkg>` 指向同一个 workspace 包：包名取第二段。
    const segments = name.split('/');
    const packageName = segments.slice(0, 2).join('/');
    const dir = join(here, '..', segments[1]);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, packageName, `${name} 的清单名必须与插入行一致`);
    assert.equal(manifest.private, true, `${name} 必须是私有包`);
    assert.ok(manifest.engines?.dsh, `${name} 必须声明 engines.dsh`);
    if (segments.length > 2) {
      // 子路径入口必须真的在 exports 里，否则装上却解析不到（静默无入口）。
      const subpath = `./${segments.slice(2).join('/')}`;
      assert.equal(typeof manifest.exports?.[subpath], 'string', `${name} 的子路径 ${subpath} 必须出现在 exports`);
    }
  }
});

test('the README states the current two-layer bundle status honestly', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（组合骨架/);
  assert.match(text, /cordis\.patch\.yml/);
  assert.match(text, /cordis\.patch\.engineering\.yml/);
  assert.match(text, /官方行禁用层已实现/);
  assert.match(text, /通用底座（`cordis\.patch\.yml`）只挂有真实 Host 职责的通用插件——凭据、策略、IAM/);
  assert.match(text, /研发域成员（DevOps、Gitee、研发 Skill 与「企业研发工具」容器）一律进叠加层/);
  assert.match(text, /运行时模型面与企业环境接入未实现/);
});