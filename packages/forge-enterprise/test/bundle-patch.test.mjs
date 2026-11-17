import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUNTIME_ROWS } from '../src/reflow.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(here, '..', '..');
const read = (file) => readFile(join(here, file), 'utf8');

const BASE_PATCH = 'cordis.patch.yml';

/**
 * 逐行解析补丁的顶层行：`- id: X` 到下一个顶层条目之间的正文（去注释、去空行、去缩进）。
 * 只有禁用行与内置运行时的条件启用行是顶层行；`insert:` 段不在此列。
 */
function topRows(text) {
  const rows = new Map();
  let current;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trimEnd();
    if (line.trim() === '') continue;
    // An indented line belongs to the top-level entry above it; only column zero starts an entry.
    if (!/^- /u.test(line)) {
      if (current !== undefined) rows.get(current).push(line.trim());
      continue;
    }
    const row = /^- id: (.+)$/u.exec(line);
    if (row !== null) {
      current = row[1].trim();
      rows.set(current, []);
      continue;
    }
    current = undefined;
  }
  return rows;
}

const isDisabledRow = (body) => body.length === 1 && body[0] === 'disabled: true';

/**
 * 内置运行时的两行，逐行写明桌面壳与上游工具所依赖的形态（CORP-DSH-DESIGN-025）。
 * 改动其中任何一处都必须同时改这里：两行是通用底座里唯一"启用"官方能力的补丁。
 */
const RUNTIME_ROW_TEXT = Object.freeze({
  'workspace-dependencies': [
    "name: '@deepseek-ai/dsh-tool-workspace-dependencies'",
    'disabled: !!js "!process.env.DSH_PRIMARY_RUNTIME"',
    'config:',
    'source: !!js process.env.DSH_PRIMARY_RUNTIME',
    "root: !!js dshHomePath('dsh-runtimes', 'dsh-primary-runtime')",
  ],
  'skill-office': [
    "name: '@deepseek-ai/dsh-skill-office'",
    'config:',
    'pythonEnvironment: !!js "process.env.DSH_PRIMARY_RUNTIME ? \'workspace-dependencies\' : \'user\'"',
  ],
});

/** 内置运行时行为什么不是上面写明的形态；空列表表示两行逐行一致。保持纯函数，以便对变体复用。 */
function runtimeRowProblems(rows) {
  const problems = [];
  for (const [id, expected] of Object.entries(RUNTIME_ROW_TEXT)) {
    const body = rows.get(id) ?? [];
    if (body.length !== expected.length) problems.push(`${id}: carries ${body.length} lines, not ${expected.length}`);
    expected.forEach((line, index) => {
      if (body[index] !== line) problems.push(`${id}: line ${index + 1} is ${JSON.stringify(body[index])}, not ${JSON.stringify(line)}`);
    });
  }
  return problems;
}

/** 取某行一个键的 `!!js` 表达式原文。 */
const expressionOf = (rows, id, key) => rows.get(id).find((line) => line.startsWith(`${key}: !!js `)).slice(key.length + 6).trim().replace(/^"|"$/gu, '');

/** 按 Loader 挂载该行时的样子求值一个表达式：`process.env` 与 `dshHomePath`。 */
function evaluate(expression, env) {
  const home = [];
  const value = new Function('process', 'dshHomePath', `return (${expression});`)({ env }, (...parts) => {
    home.push(parts);
    return `/harness/${parts.join('/')}`;
  });
  return { value, home };
}

const PAYLOAD = { DSH_PRIMARY_RUNTIME: '/resources/primary-runtime' };

/** `insert:` 段里的 `id` → `name` 映射（缩进四级）。 */
function insertedRows(text) {
  return [...text.matchAll(/^ {4}- id: (\S+)\n {6}name: '([^']+)'$/gmu)].map((m) => [m[1], m[2]]);
}

test('the base patch disables official access, generic model configuration and local credentials', async () => {
  const rows = topRows(await read(BASE_PATCH));
  const disabled = [...rows.entries()].filter(([, body]) => isDisabledRow(body)).map(([id]) => id);
  assert.deepEqual(
    disabled.sort(),
    ['credentials', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'ui-settings-account', 'ui-settings-models'],
    '官方账号、通用模型配置与本地凭据提供方都必须以 disabled: true 关闭',
  );
  // A disabled row carries nothing else: there is no config left to run it with.
  assert.deepEqual(
    [...rows.keys()].sort(),
    ['credentials', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'skill-office', 'ui-settings-account', 'ui-settings-models', 'workspace-dependencies'],
    '顶层行只有七个禁用行与内置运行时的两个条件启用行',
  );
});

test('the local credentials row is disabled rather than removed or re-enabled', async () => {
  const text = await read(BASE_PATCH);
  assert.deepEqual(topRows(text).get('credentials'), ['disabled: true'], '官方 local 提供方必须命中，且除禁用外不带任何配置');
  assert.doesNotMatch(text, /^ {4}- id: credentials$/mu, '不得把官方 local 行复制进 insert 段');
});

test('内置运行时两行只在桌面壳交出载荷时生效，否则与上游默认行为一致', async () => {
  const rows = topRows(await read(BASE_PATCH));
  assert.deepEqual(runtimeRowProblems(rows), []);
  assert.deepEqual(Object.keys(RUNTIME_ROW_TEXT), [...RUNTIME_ROWS], 'the rows whose text is pinned here are exactly the two the detector module names');
  const tool = 'workspace-dependencies';
  const disabled = expressionOf(rows, tool, 'disabled');
  const source = expressionOf(rows, tool, 'source');
  const root = expressionOf(rows, tool, 'root');
  const python = expressionOf(rows, 'skill-office', 'pythonEnvironment');
  // Without the variable nothing changes for a terminal CLI or a machine without the payload.
  assert.equal(evaluate(disabled, {}).value, true, 'the tool row stays disabled');
  assert.equal(evaluate(python, {}).value, 'user', "the Office skills keep pointing the model at the user's Python");
  // With it the tool reads the payload where the shell put it and installs it under the Harness home.
  assert.equal(evaluate(disabled, PAYLOAD).value, false);
  assert.equal(evaluate(source, PAYLOAD).value, PAYLOAD.DSH_PRIMARY_RUNTIME);
  assert.deepEqual(evaluate(root, PAYLOAD), { value: '/harness/dsh-runtimes/dsh-primary-runtime', home: [['dsh-runtimes', 'dsh-primary-runtime']] });
  assert.equal(evaluate(python, PAYLOAD).value, 'workspace-dependencies');
  // Both rows name the upstream package they override, so a replaced package is skipped, not patched.
  assert.equal(rows.get(tool)[0], RUNTIME_ROW_TEXT[tool][0]);
  assert.equal(rows.get('skill-office')[0], RUNTIME_ROW_TEXT['skill-office'][0]);
  // The Office skills are never switched off by this patch, whichever way the variable is set.
  assert.equal(rows.get('skill-office').some((line) => line.startsWith('disabled:')), false);
});

test('反向：内置运行时两行的任何一处改动都被识别，并说出它造成的后果（变异证明）', async () => {
  const rows = topRows(await read(BASE_PATCH));
  const replace = (id, from, to) => (variant) => variant.set(id, variant.get(id).map((line) => (line === from ? to : line)));
  const disabledLine = RUNTIME_ROW_TEXT['workspace-dependencies'][1];
  const pythonLine = RUNTIME_ROW_TEXT['skill-office'][2];
  const variants = [
    ['工具行失去停用条件', (variant) => variant.set('workspace-dependencies', variant.get('workspace-dependencies').filter((line) => !line.startsWith('disabled:')))],
    ['工具行无条件启用', replace('workspace-dependencies', disabledLine, 'disabled: false')],
    ['工具行换个包也照命中', replace('workspace-dependencies', RUNTIME_ROW_TEXT['workspace-dependencies'][0], "name: '@deepseek-ai/dsh-tool-other'")],
    ['载荷装到 Harness home 之外', replace('workspace-dependencies', RUNTIME_ROW_TEXT['workspace-dependencies'][4], "root: !!js '/tmp/elsewhere'")],
    ['Office 技能无条件用内置依赖', replace('skill-office', pythonLine, "pythonEnvironment: 'workspace-dependencies'")],
    ['Office 技能被整体停用', (variant) => variant.set('skill-office', ['disabled: true'])],
    ['去掉 name 守卫', (variant) => variant.set('skill-office', variant.get('skill-office').slice(1))],
  ];
  for (const [label, mutate] of variants) {
    const variant = new Map(rows);
    mutate(variant);
    assert.ok(runtimeRowProblems(variant).length > 0, label);
  }
  // The two edits that matter most are spelled out by what they would do on a machine without the payload.
  const alwaysOn = new Map(rows);
  replace('workspace-dependencies', disabledLine, 'disabled: !!js "false"')(alwaysOn);
  assert.equal(evaluate(expressionOf(alwaysOn, 'workspace-dependencies', 'disabled'), {}).value, false, 'a tool with no payload behind it would be offered to the model');
  const alwaysBundled = new Map(rows);
  replace('skill-office', pythonLine, "pythonEnvironment: 'workspace-dependencies'")(alwaysBundled);
  assert.equal(alwaysBundled.get('skill-office').at(-1), "pythonEnvironment: 'workspace-dependencies'", 'the Office skills would send the model to a tool that is not there');
});

test('the base bundle mounts universal account, keychain, policy, brand, and skills rows with zero R&D surface', async () => {
  const text = await read(BASE_PATCH);
  assert.deepEqual(
    insertedRows(text),
    [
      ['heluo-credentials-keychain', '@heluo/forge-credentials-keychain'],
      ['heluo-policy', '@heluo/forge-policy'],
      ['heluo-iam', '@heluo/forge-iam'],
      ['heluo-brand', '@heluo/forge-brand'],
      ['skills-manager', '@heluo/forge-skills-manager'],
    ],
    '通用底座只装凭据、策略、IAM、品牌令牌与技能管理，不含任何研发行',
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
    ['@heluo/forge-brand', '@heluo/forge-credentials-keychain', '@heluo/forge-iam', '@heluo/forge-policy', '@heluo/forge-skills-manager'],
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
  assert.equal(names.length, 5);
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
