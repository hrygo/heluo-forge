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

test('the bundle disables official access, generic model configuration and local credentials', async () => {
  const text = await read('cordis.patch.yml');
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
  const text = await read('cordis.patch.yml');
  const disabled = disabledIds(text);
  assert.equal(disabled.get('credentials'), true, '官方 local 提供方必须命中并被禁用');
  // 覆写层只加 disabled 字段，行本身仍由基础组合提供；这里防止用删除或
  // 重新插入同名行来“看起来”关掉它。
  assert.doesNotMatch(text, /^ {4}- id: credentials$/mu, '不得把官方 local 行复制进 insert 段');
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
      // r12：正式企业研发 Skill 是本包自己的子路径入口，不是第四个包（所以上面的
      // "逐个包校验"要按包名归一后再查清单）。
      ['heluo-issue-delivery-skill', '@heluo/forge-enterprise/issue-delivery-skill'],
      // r13：研发读面与交付判定进闭包。缺这两行时组合"装上了却没有 Issue/变更可读"（r12 D-3）。
      ['forge-devops', '@heluo/forge-devops'],
      ['heluo-gitee', '@heluo/forge-gitee'],
    ],
    '插入行 = 五个真正的 Host 插件 + 本包的 Skill 子路径入口；SDD 保留 CLI，不伪装插件',
  );
  assert.doesNotMatch(text, /^\s*name: '@heluo\/forge-market'$/mu, '历史市场包不挂（AC5）；注释里提到它不算挂载');
  // 只认**顶层**禁用段：insert 里的 `    - id: forge-devops` 是合法企业行，不能被这条反面断言误伤。
  assert.doesNotMatch(text, /^- id: (enterprise|forge)-/mu, '禁用段不复制企业行，只覆写官方行');
  assert.match(text, /DEEPSEEK_API_KEY/, '文件需说明 API Key 傍路这条核验依据');
});

test('every inserted package exists, is private, and has a manifest', async () => {
  const text = await read('cordis.patch.yml');
  const names = [...text.matchAll(/^ {6}name: '([^']+)'$/gmu)].map((m) => m[1]);
  assert.equal(names.length, 6);
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

test('the README states the current bundle status honestly', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（组合骨架/);
  assert.match(text, /cordis\.patch\.yml/);
  assert.match(text, /官方行禁用层已实现/);
  assert.match(text, /insert:[^|]*五个 Host 插件/);
  assert.match(text, /运行时模型面与企业环境接入未实现/);
});
