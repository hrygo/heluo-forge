/**
 * 卸载编排（20261102-r9 / M3）。
 *
 * 卸载 = 「清理补丁层条目 → 回显区间 → 移除插件」三段，本文件固化这段编排的对外契约
 * （TECHNICAL.md §5.3-§5.4）：
 *  - 顺序：调 `dsh plugin remove` 的时候，补丁层里的本插件条目必须已经不在了（AC-11）；
 *  - 精确：只删自己那条，官方/兄弟条目、注释、空行、深层 llm 模型表逐字保留（AC-12 / AC-15）；
 *  - 幂等：第二次什么都不写（字节与 mtime 都不变），退出码仍为 0（AC-11）；
 *  - 零泄漏：stdout 只有 profile 名、条目身份、行区间与行数，不出现任何绝对路径（AC-14）；
 *  - 绝不伪造：补丁层不存在就报错退出，不创建文件（AC-12）；没探测到 dsh 就只清理并给下一步。
 *
 * runner 一律注入，测试不 spawn 真实 dsh，也不碰真实 profile。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ENTRY_IDS,
  PLUGIN_NAME,
  REMOVE_TIMEOUT_MS,
  parseArgs,
  runUninstall,
} from '../scripts/lib/uninstall-devops.mjs';
import { UninstallError, countEntries, parsePatchBlocks } from '../scripts/lib/patch-layer-blocks.mjs';

const CLI = fileURLToPath(new URL('../scripts/uninstall-devops.mjs', import.meta.url));

/** 一个贴近真实的 profile 补丁层：官方条目 + 兄弟插件 + 本插件 + 带深层 `- id:` 的 llm 表 + 尾注释。 */
const PATCH_LINES = [
  '# profile 补丁层（示例）',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '',
  '- id: forge-gitee',
  "  name: '@heluo/forge-gitee'",
  '',
  '- id: forge-devops',
  "  name: '@heluo/forge-devops'",
  '  config:',
  '    dopBin: tools/dop',
  '',
  '- id: llm-deepseek',
  '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '',
  '# tick 1793176584',
  '',
];
const PLUGIN_START = 7;
const PLUGIN_END = 11;
const PATCH_TEXT = PATCH_LINES.join('\n');

function makeHome({ names = ['web'], patchText = PATCH_TEXT, writePatch = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-uninstall-'));
  const profiles = {};
  for (const name of names) {
    const dir = join(root, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    const patchPath = join(dir, 'cordis.patch.yml');
    if (writePatch) writeFileSync(patchPath, patchText, 'utf8');
    profiles[name] = { dir, patchPath };
  }
  return {
    root,
    profiles,
    env: { DSH_HOME: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 注入式 runner：记录调用、可在移除插件那一刻做断言。 */
function stubRunner({ exitCode = 0, has = (bin) => bin === 'dsh', onExec = null } = {}) {
  const calls = [];
  return {
    calls,
    has,
    execFile: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (onExec !== null) await onExec({ bin, args, options });
      return { code: exitCode, stdout: '', stderr: '' };
    },
  };
}

function noSubprocess(label) {
  return () => {
    throw new Error(`${label}：不应调用子进程`);
  };
}

test('主路径：先清补丁条目、再移除插件；回显五段且零绝对路径', async () => {
  const home = makeHome();
  try {
    const runner = stubRunner({
      onExec: () => {
        // 顺序证明：`dsh plugin remove` 执行的那一刻，残留条目已经是 0。
        assert.equal(countEntries(readFileSync(home.profiles.web.patchPath, 'utf8'), { ids: ENTRY_IDS }), 0);
      },
    });
    const result = await runUninstall({ argv: [], env: home.env, runner });

    assert.equal(result.code, 0);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.lines, [
      'profile：web',
      '补丁层：cordis.patch.yml',
      '已删除条目：id=forge-devops（name=@heluo/forge-devops）行 8-11（共 4 行）',
      '行数：19 → 15',
      '插件：已移除',
    ]);
    for (const line of result.lines) assert.ok(!line.includes(home.root), `回显出现绝对路径：${line}`);

    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].bin, 'dsh');
    assert.deepEqual(runner.calls[0].args, ['plugin', '--profile', 'web', 'remove', PLUGIN_NAME]);
    assert.deepEqual(runner.calls[0].options, { timeout: REMOVE_TIMEOUT_MS, shell: false });

    const after = readFileSync(home.profiles.web.patchPath, 'utf8');
    const expected = PATCH_LINES.slice(0, PLUGIN_START).concat(PATCH_LINES.slice(PLUGIN_END)).join('\n');
    assert.equal(after, expected, '字节 diff 只能是被删区间');
    assert.equal(countEntries(after, { ids: ENTRY_IDS }), 0);
    assert.match(after, /^# profile 补丁层/u);
    assert.match(after, /- id: forge-gitee\n {2}name: '@heluo\/forge-gitee'\n/u);
    assert.match(after, / {6}- id: deepseek-flash\n/u);
    assert.ok(after.endsWith('# tick 1793176584\n'));
  } finally {
    home.cleanup();
  }
});

test('--keep-plugin：删条目但不调用 dsh，回显含下一步命令', async () => {
  const home = makeHome();
  try {
    const runner = stubRunner({ onExec: noSubprocess('--keep-plugin') });
    const result = await runUninstall({ argv: ['--keep-plugin'], env: home.env, runner });

    assert.equal(result.code, 0);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(result.lines, [
      'profile：web',
      '补丁层：cordis.patch.yml',
      '已删除条目：id=forge-devops（name=@heluo/forge-devops）行 8-11（共 4 行）',
      '行数：19 → 15',
      '插件：未移除（--keep-plugin）',
      '下一步：dsh plugin --profile web remove @heluo/forge-devops',
    ]);
    assert.equal(countEntries(readFileSync(home.profiles.web.patchPath, 'utf8'), { ids: ENTRY_IDS }), 0);
  } finally {
    home.cleanup();
  }
});

test('重复执行幂等：第二次零写入（字节与 mtime 不变），仍 exit 0', async () => {
  const home = makeHome();
  try {
    const first = await runUninstall({ argv: [], env: home.env, runner: stubRunner() });
    assert.equal(first.code, 0);

    const bytes = readFileSync(home.profiles.web.patchPath, 'utf8');
    const { mtimeMs } = statSync(home.profiles.web.patchPath);

    const second = await runUninstall({ argv: [], env: home.env, runner: stubRunner() });
    assert.equal(second.code, 0);
    assert.deepEqual(second.lines, [
      'profile：web',
      '补丁层：cordis.patch.yml',
      '无残留（补丁层已是清理后的状态）',
      '插件：已移除',
    ]);
    assert.equal(readFileSync(home.profiles.web.patchPath, 'utf8'), bytes);
    assert.equal(statSync(home.profiles.web.patchPath).mtimeMs, mtimeMs, '未命中时不得写盘');
  } finally {
    home.cleanup();
  }
});

test('没探测到 dsh：只清理并打印下一步，不尝试起子进程', async () => {
  const home = makeHome();
  try {
    const runner = stubRunner({ has: () => false, onExec: noSubprocess('未探测到 dsh') });
    const result = await runUninstall({ argv: [], env: home.env, runner });

    assert.equal(result.code, 0);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(result.lines.slice(-2), [
      '插件：未移除（未探测到 dsh CLI）',
      '下一步：dsh plugin --profile web remove @heluo/forge-devops',
    ]);
    assert.equal(result.lines.length, 6);
  } finally {
    home.cleanup();
  }
});

test('插件移除非零退出：清理结论仍然成立，退出码 0 + 可重跑提示', async () => {
  const home = makeHome();
  try {
    const result = await runUninstall({ argv: [], env: home.env, runner: stubRunner({ exitCode: 7 }) });
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines.slice(-2), [
      '插件：未移除（dsh 退出码 7）',
      '下一步：dsh plugin --profile web remove @heluo/forge-devops',
    ]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /dsh 退出码 7/u);
    assert.equal(countEntries(readFileSync(home.profiles.web.patchPath, 'utf8'), { ids: ENTRY_IDS }), 0);
  } finally {
    home.cleanup();
  }
});

test('补丁层不存在：exit 1 报错且不创建文件（AC-12）', async () => {
  const home = makeHome({ writePatch: false });
  try {
    const result = await runUninstall({ argv: [], env: home.env, runner: stubRunner({ onExec: noSubprocess('缺失') }) });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.warnings, ['uninstall: 找不到 web 的 cordis.patch.yml']);
    assert.deepEqual(readdirSync(home.profiles.web.dir), []);
  } finally {
    home.cleanup();
  }
});

test('profile 无法确定：列出候选、不猜，且不动任何补丁层', async () => {
  const home = makeHome({ names: ['web', 'sdk'] });
  try {
    const ambiguous = await runUninstall({ argv: [], env: home.env, runner: stubRunner({ onExec: noSubprocess('歧义') }) });
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.warnings[0], /无法确定活动 profile（可用：sdk、web）/u);
    assert.ok(!ambiguous.warnings[0].includes(home.root), '报错不得出现绝对路径');

    const unknown = await runUninstall({ argv: ['--profile', 'nope'], env: home.env, runner: stubRunner() });
    assert.equal(unknown.code, 1);
    assert.equal(unknown.warnings[0], 'uninstall: 找不到 profile「nope」（可用：sdk、web）');

    for (const name of ['web', 'sdk']) {
      assert.equal(readFileSync(home.profiles[name].patchPath, 'utf8'), PATCH_TEXT);
    }
  } finally {
    home.cleanup();
  }
});

test('补丁层用 name 写法也能识别，回显只带 name', async () => {
  const byName = ['- name: "@heluo/forge-devops"', '  config:', '    dopBin: tools/dop', '', '- id: other', ''].join('\n');
  const home = makeHome({ patchText: byName });
  try {
    const result = await runUninstall({ argv: ['--keep-plugin'], env: home.env, runner: stubRunner() });
    assert.equal(result.code, 0);
    assert.equal(result.lines[2], '已删除条目：name=@heluo/forge-devops 行 1-3（共 3 行）');
    assert.equal(result.lines[3], '行数：5 → 2');
  } finally {
    home.cleanup();
  }
});

test('嵌套 insert 里的同名条目：不静默通过，报残留行号且不改文件', async () => {
  const insertForm = [
    '- id: ui-settings-general',
    '- insert:',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '',
  ].join('\n');
  const home = makeHome({ patchText: insertForm });
  try {
    const { mtimeMs } = statSync(home.profiles.web.patchPath);
    const result = await runUninstall({ argv: ['--keep-plugin'], env: home.env, runner: stubRunner() });
    assert.equal(result.code, 0);
    assert.equal(result.lines[2], '残留：id=forge-devops 行 3（位于嵌套 insert 块，块模型不删深层条目，需手工删除后再确认）');
    assert.equal(readFileSync(home.profiles.web.patchPath, 'utf8'), insertForm);
    assert.equal(statSync(home.profiles.web.patchPath).mtimeMs, mtimeMs);
  } finally {
    home.cleanup();
  }
});

test('写入失败：exit 1 + 权限提示，文件保持原样', async () => {
  const home = makeHome();
  const patchPath = home.profiles.web.patchPath;
  try {
    chmodSync(patchPath, 0o444);
    const result = await runUninstall({ argv: ['--keep-plugin'], env: home.env, runner: stubRunner() });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.warnings, ['uninstall: 写入 cordis.patch.yml 失败（EACCES），请检查文件权限后重跑']);
    assert.equal(readFileSync(patchPath, 'utf8'), PATCH_TEXT);
  } finally {
    chmodSync(patchPath, 0o644);
    home.cleanup();
  }
});

test('未知参数：显式报错并列出可用开关', async () => {
  assert.throws(() => parseArgs(['--nope']), (error) => {
    assert.ok(error instanceof UninstallError);
    assert.equal(error.code, 'BAD_ARGUMENT');
    return true;
  });
  const home = makeHome();
  try {
    const result = await runUninstall({ argv: ['--nope'], env: home.env, runner: stubRunner() });
    assert.equal(result.code, 1);
    assert.equal(result.warnings[0], 'uninstall: 未知参数「--nope」（可用：--profile <名>、--keep-plugin）');
  } finally {
    home.cleanup();
  }
});

test('CLI 端到端：真实 runner 在空 PATH 下只清理并给出下一步，--help 退出 0', () => {
  const home = makeHome();
  const emptyBin = join(home.root, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const env = { ...process.env, PATH: emptyBin, DSH_HOME: home.root, DSH_PROFILE: '', DSH_PROFILE_DIR: '' };
  try {
    const stdout = execFileSync(process.execPath, [CLI], { encoding: 'utf8', env });
    const lines = stdout.trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, 2), ['profile：web', '补丁层：cordis.patch.yml']);
    assert.match(lines[2], /^已删除条目：id=forge-devops（name=@heluo\/forge-devops）行 8-11（共 4 行）$/u);
    assert.deepEqual(lines.slice(-2), [
      '插件：未移除（未探测到 dsh CLI）',
      '下一步：dsh plugin --profile web remove @heluo/forge-devops',
    ]);
    assert.ok(!stdout.includes(home.root), 'stdout 不得出现绝对路径');
    assert.equal(countEntries(readFileSync(home.profiles.web.patchPath, 'utf8'), { ids: ENTRY_IDS }), 0);

    const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help, /^用法：node scripts\/uninstall-devops\.mjs/u);
    assert.match(help, /--keep-plugin/u);
    assert.match(help, /退出码：0 = 已清理或本无残留；1 =/u);
  } finally {
    home.cleanup();
  }
});

test('块模型与编排共用同一套条目身份（防两处口径漂移）', () => {
  const { blocks } = parsePatchBlocks(PATCH_TEXT);
  const devops = blocks.filter((block) => ENTRY_IDS.includes(block.id) || ENTRY_IDS.includes(block.name));
  assert.equal(devops.length, 1);
  assert.equal(devops[0].id, 'forge-devops');
  assert.equal(devops[0].start, PLUGIN_START);
  assert.equal(devops[0].end, PLUGIN_END);
});
