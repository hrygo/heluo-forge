/**
 * profile 补丁层的块模型（20261102-r9 / M3）。
 *
 * 卸载之所以不能直接跑 `dsh plugin remove`：上游只移除依赖与重载，不清理 profile 补丁层，
 * 配置页写进去的 `- id: forge-devops` 行会残留并在每次冷启动打印「entry not found」。
 * 而清理又不能用「扫 `id:` 正则 + 重写 YAML」——同一文件里 `config:` 子树还有 llm 模型表的
 * `- id: deepseek-flash`，重写还会吃掉用户的注释与空行（AC-12 / AC-15）。
 *
 * 本文件固化块模型的三条判据：
 *  1. 只认顶层缩进的 `- ` 块；身份只取块内**直接子行**（缩进 + 2）的 `id:` / `name:`；
 *  2. 删除是区间切片，其它行逐字节保留（含注释、空行、CRLF、条目顺序）；
 *  3. 匹配是 Set 精确相等，禁止前缀/正则模糊匹配；未命中一个字节都不动。
 *
 * 归属：docs/teamflow/20261102-r9-runner-refresh-uninstall/TECHNICAL.md §5.1-§5.2。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PATCH_LAYER_FILE,
  UninstallError,
  countEntries,
  findResidualEntries,
  parsePatchBlocks,
  patchLayerExists,
  patchLayerOf,
  removeEntryBlock,
  resolveProfile,
} from '../scripts/lib/patch-layer-blocks.mjs';

const IDS = new Set(['forge-devops', '@heluo/forge-devops']);

/** 真实的 profile 补丁层形态：顶格注释 + 官方条目 + 兄弟插件条目 + 本插件条目 + 深层 `- id:`。 */
const PATCH_LAYER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
  '',
  '- id: forge-gitee',
  "  name: '@heluo/forge-gitee'",
  '  config: {}',
  '',
  '- id: forge-devops',
  "  name: '@heluo/forge-devops'",
  '  config:',
  '    dopBin: tools/dop',
  '    timeoutMs: 30000',
  '',
  '- id: llm-deepseek',
  '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '        name: DeepSeek-V4.1-Flash',
  '',
  '# tick 1793176584',
  '',
].join('\n');

function tempRoot(prefix = 'forge-patch-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withTemp(prefix, body) {
  const root = tempRoot(prefix);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function profilesRoot(root, names) {
  for (const name of names) mkdirSync(join(root, 'profiles', name), { recursive: true });
  return root;
}

test('块模型只认顶层 `- ` 块，块尾不含空行与顶格注释', () => {
  const { lines, blocks } = parsePatchBlocks(PATCH_LAYER);
  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((block) => block.id),
    ['ui-settings-general', 'forge-gitee', 'forge-devops', 'llm-deepseek'],
  );

  const devops = blocks.find((block) => block.id === 'forge-devops');
  assert.equal(devops.name, '@heluo/forge-devops');
  assert.equal(devops.indent, 0);
  assert.equal(lines[devops.start], '- id: forge-devops');
  // 块尾停在 `timeoutMs: 30000` 之后：空行属于分隔，不随条目删除。
  assert.equal(lines[devops.end - 1], '    timeoutMs: 30000');
  assert.equal(lines[devops.end], '');

  const last = blocks.at(-1);
  assert.equal(last.name, '@deepseek-ai/dsh-llm-deepseek-api-key');
  assert.equal(lines[last.end - 1], '        name: DeepSeek-V4.1-Flash');
  assert.equal(lines[last.end], '');
  assert.deepEqual(blocks.map((block) => block.start), [2, 7, 11, 17]);
});

test('深层 `- id:` 不参与身份判定：llm 模型表永远不算一条补丁条目', () => {
  const { blocks } = parsePatchBlocks(PATCH_LAYER);
  assert.equal(countEntries(PATCH_LAYER, { ids: ['deepseek-flash'] }), 0);
  assert.equal(countEntries(PATCH_LAYER, { ids: ['@deepseek-ai/dsh-llm-deepseek-api-key'] }), 1);
  assert.equal(blocks.find((block) => block.id === 'llm-deepseek').name, '@deepseek-ai/dsh-llm-deepseek-api-key');
});

test('删除是区间切片：其余行逐字保留，字节 diff 只含被删区间', () => {
  const lines = PATCH_LAYER.split('\n');
  const { blocks } = parsePatchBlocks(PATCH_LAYER);
  const block = blocks.find((entry) => entry.id === 'forge-devops');
  const expected = lines.slice(0, block.start).concat(lines.slice(block.end)).join('\n');

  const result = removeEntryBlock(PATCH_LAYER, { ids: IDS });
  assert.equal(result.text, expected);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.removed[0], {
    id: 'forge-devops',
    name: '@heluo/forge-devops',
    start: block.start,
    end: block.end,
    count: block.end - block.start,
  });
  assert.equal(result.before, 25);
  assert.equal(result.after, 25 - result.removed[0].count);
  assert.equal(result.after, expected.split('\n').length - 1);

  // 兄弟条目、官方条目、注释与空行一字未动。
  const text = result.text;
  assert.match(text, /^# Your patch layer for this dsh profile/u);
  assert.match(text, /# tick 1793176584\n$/u);
  assert.match(text, /- id: forge-gitee\n {2}name: '@heluo\/forge-gitee'\n {2}config: \{\}\n/u);
  assert.match(text, /- id: llm-deepseek\n {2}name: "@deepseek-ai\/dsh-llm-deepseek-api-key"/u);
  assert.match(text, / {6}- id: deepseek-flash\n {8}name: DeepSeek-V4\.1-Flash\n/u);
  assert.equal(countEntries(text, { ids: IDS }), 0);
  assert.deepEqual(findResidualEntries(text, { ids: IDS }), []);
});

test('`id:` 与 `name:` 两种写法都能识别', () => {
  const byName = ['- name: "@heluo/forge-devops"', '  config:', '    dopBin: tools/dop', ''].join('\n');
  const result = removeEntryBlock(byName, { ids: IDS });
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].id, undefined);
  assert.equal(result.removed[0].name, '@heluo/forge-devops');
  assert.equal(result.text, '');

  const byBoth = ['- id: forge-devops', "  name: '@heluo/forge-devops'", '  config: {}', ''].join('\n');
  const both = removeEntryBlock(byBoth, { ids: IDS });
  assert.equal(both.removed.length, 1);
  assert.equal(both.removed[0].id, 'forge-devops');
  assert.equal(both.removed[0].name, '@heluo/forge-devops');
});

test('匹配是精确集合相等：前缀、包名变形、大小写都不命中，且不改一个字节', () => {
  for (const ids of [['forge'], ['forge-devops-extra'], ['@heluo/forge'], ['FORGE-DEVOPS'], ['@heluo/forge-devops ']]) {
    const result = removeEntryBlock(PATCH_LAYER, { ids });
    assert.deepEqual(result.removed, [], ids.join(','));
    assert.equal(result.text, PATCH_LAYER, ids.join(','));
    assert.equal(countEntries(PATCH_LAYER, { ids }), 0);
  }
});

test('重复执行幂等：清过之后不再命中，文本完全相同', () => {
  const first = removeEntryBlock(PATCH_LAYER, { ids: IDS });
  const second = removeEntryBlock(first.text, { ids: IDS });
  assert.deepEqual(second.removed, []);
  assert.equal(second.text, first.text);
  assert.equal(second.before, second.after);
});

test('CRLF 与缩进过的补丁层同样按块处理', () => {
  const crlf = ['- id: forge-gitee', "  name: '@heluo/forge-gitee'", '- id: forge-devops', '  name: forge-devops', ''].join('\r\n');
  const result = removeEntryBlock(crlf, { ids: IDS });
  assert.equal(result.removed.length, 1);
  assert.equal(result.text, '- id: forge-gitee\r\n  name: \'@heluo/forge-gitee\'\r\n');

  const indented = ['  - id: forge-devops', '    name: forge-devops', '    config: {}', '', '  - id: other', '    name: other', ''].join('\n');
  const nested = removeEntryBlock(indented, { ids: IDS });
  assert.equal(nested.removed.length, 1);
  assert.equal(nested.text, '\n  - id: other\n    name: other\n');
});

test('未命中不产生写盘动作：返回值里没有副作用通道，文本与入参同一内容', () => {
  const untouched = removeEntryBlock(PATCH_LAYER, { ids: ['someone-else'] });
  assert.equal(untouched.removed.length, 0);
  assert.equal(untouched.text.length, PATCH_LAYER.length);
  assert.equal(untouched.before, untouched.after);
});

test('嵌套 insert 块里的同名条目不算顶层条目，但也不会被谎称「无残留」', () => {
  const insertForm = [
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '- insert:',
    '    - id: heluo-policy',
    "      name: '@heluo/forge-policy'",
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '',
  ].join('\n');
  assert.equal(countEntries(insertForm, { ids: IDS }), 0);
  const result = removeEntryBlock(insertForm, { ids: IDS });
  assert.equal(result.text, insertForm);
  assert.deepEqual(
    findResidualEntries(insertForm, { ids: IDS }).map((entry) => ({ line: entry.line, id: entry.id, name: entry.name })),
    [{ line: 6, id: 'forge-devops', name: null }],
  );
});

test('匹配集合类型错误要显式报错，不接受字符串（避免按字符逐个匹配）', () => {
  assert.throws(() => removeEntryBlock(PATCH_LAYER, { ids: 'forge-devops' }), (error) => {
    assert.ok(error instanceof UninstallError);
    assert.equal(error.code, 'INVALID_MATCH_SET');
    return true;
  });
  assert.throws(() => countEntries(PATCH_LAYER, { ids: 7 }), UninstallError);
});

test('profile 解析五分支：--profile 显式优先', () => {
  withTemp('forge-profile-', (root) => {
    profilesRoot(root, ['web', 'sdk']);
    const profile = resolveProfile({
      argv: ['--profile', 'web'],
      env: { DSH_HOME: root, DSH_PROFILE: 'sdk' },
    });
    assert.equal(profile.name, 'web');
    assert.equal(profile.dir, join(root, 'profiles', 'web'));
    assert.equal(patchLayerOf(profile), join(root, 'profiles', 'web', PATCH_LAYER_FILE));
  });
});

test('profile 解析五分支：DSH_PROFILE → DSH_PROFILE_DIR → 唯一 profiles 目录', () => {
  withTemp('forge-profile-', (root) => {
    profilesRoot(root, ['web', 'sdk']);

    assert.equal(resolveProfile({ argv: [], env: { DSH_HOME: root, DSH_PROFILE: 'sdk' } }).name, 'sdk');

    const byDir = resolveProfile({ argv: [], env: { DSH_HOME: root, DSH_PROFILE_DIR: join(root, 'profiles', 'web') } });
    assert.equal(byDir.name, 'web');
    assert.equal(byDir.dir, join(root, 'profiles', 'web'));

    rmSync(join(root, 'profiles', 'sdk'), { recursive: true, force: true });
    assert.equal(resolveProfile({ argv: [], env: { DSH_HOME: root } }).name, 'web');
  });
});

test('profile 解析五分支：无 / 多个候选一律报错并列出名字，不猜', () => {
  withTemp('forge-profile-', (root) => {
    assert.throws(() => resolveProfile({ argv: [], env: { DSH_HOME: root } }), (error) => {
      assert.ok(error instanceof UninstallError);
      assert.equal(error.code, 'PROFILE_UNRESOLVED');
      assert.match(error.message, /找不到 profile/u);
      assert.ok(!error.message.includes(root), '报错不得出现绝对路径');
      return true;
    });

    profilesRoot(root, ['web', 'sdk']);
    assert.throws(() => resolveProfile({ argv: [], env: { DSH_HOME: root } }), (error) => {
      assert.match(error.message, /无法确定活动 profile（可用：sdk、web）/u);
      assert.ok(!error.message.includes(root));
      return true;
    });

    assert.throws(() => resolveProfile({ argv: ['--profile', 'nope'], env: { DSH_HOME: root } }), (error) => {
      assert.match(error.message, /找不到 profile「nope」（可用：sdk、web）/u);
      return true;
    });

    assert.throws(() => resolveProfile({ argv: ['--profile', '../escape'], env: { DSH_HOME: root } }), (error) => {
      assert.match(error.message, /不合法/u);
      return true;
    });

    assert.throws(() => resolveProfile({ argv: ['--profile'], env: { DSH_HOME: root } }), (error) => {
      assert.match(error.message, /需要一个 profile 名/u);
      return true;
    });
  });
});

test('$DSH_HOME 缺省取 <home>/.dsh；补丁层存在性只看普通文件', () => {
  withTemp('forge-profile-', (root) => {
    profilesRoot(join(root, '.dsh'), ['web']);
    const profile = resolveProfile({ argv: [], env: {}, home: root });
    assert.equal(profile.name, 'web');
    assert.equal(profile.dir, join(root, '.dsh', 'profiles', 'web'));
    assert.equal(patchLayerExists(profile), false);

    writeFileSync(patchLayerOf(profile), '- id: other\n', 'utf8');
    assert.equal(patchLayerExists(profile), true);

    const sdkDir = join(root, '.dsh', 'profiles', 'sdk');
    mkdirSync(join(sdkDir, PATCH_LAYER_FILE), { recursive: true });
    assert.equal(patchLayerExists({ name: 'sdk', dir: sdkDir }), false);
  });
});
