/**
 * DSH 版本单一真源工具的用例。
 * 夹具版本一律从 `.dsh-version` 派生（加一个修订号），测试本身不写死 DSH 版本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CANONICAL_SPOTS,
  CODE_ALLOWED,
  DSH_VERSION_FILE,
  DSH_VERSION_SHAPE,
  dshReleaseLine,
  dshVersionInLine,
  hasDshContext,
  listCodeOccurrences,
  listDocOccurrences,
  listEngineFloors,
  readDshVersion,
  rewriteCanonical,
  rewriteEngineFloors,
} from '../scripts/lib/dsh-version.mjs';

const ROOT = process.cwd();
const BASELINE = readDshVersion(ROOT);
/** 与基线同发布线的另一个版本，用于验证替换。 */
function sibling(version) {
  const match = version.match(/^(.*?)(\d+)(-[0-9A-Za-z.]+)?$/);
  return `${match[1]}${Number(match[2]) + 1}${match[3] ?? ''}`;
}
/** 换一条发布线的版本，用于验证"不相关版本不误报"。 */
function otherLine(version) {
  const [major, minor] = version.split('.');
  return `${major}.${Number(minor) + 7}.0`;
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-'));
  mkdirSync(join(root, 'docs/requirements'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, DSH_VERSION_FILE), `${BASELINE}\n`);
  return root;
}

test('readDshVersion 读单一真源，且形状合法', () => {
  assert.match(BASELINE, DSH_VERSION_SHAPE);
  assert.equal(readDshVersion(ROOT), BASELINE);
});

test('声明的基线位置都能在正文命中（防止正文改写后工具静默失效）', () => {
  for (const spot of CANONICAL_SPOTS) {
    const text = readFileSync(join(ROOT, spot.file), 'utf8');
    assert.match(text, spot.pattern, `${spot.file} 未命中「${spot.label}」`);
  }
});

test('dshVersionInLine 只认 DSH 上下文或同发布线，不误伤 IP 与无关版本', () => {
  assert.equal(dshVersionInLine(BASELINE, `一期固定 DSH \`${BASELINE}\``, BASELINE), true);
  assert.equal(dshVersionInLine(otherLine(BASELINE), '// 无关的第三方包版本', BASELINE), false);
  assert.equal(dshVersionInLine(sibling(BASELINE), `engines: { dsh: '>=${sibling(BASELINE)}' }`, BASELINE), true);
  assert.equal(dshReleaseLine(BASELINE), BASELINE.split('.').slice(0, 2).join('.'));
});

test('hasDshContext 要求 DSH 名称与版本邻近：标题提到 DSH、末列是文档版本不算 DSH 版本', () => {
  const docVersionRow = `| CORP-DSH-ARCH-005 | DSH 与 Agent 模型网关认证方案评审稿 | [x](y) | V1.0.0 | 评审稿 | 平台组 | — |`;
  assert.equal(hasDshContext(docVersionRow, '1.0.0'), false);
  assert.equal(hasDshContext(`目标环境 DSH \`${BASELINE}\``, BASELINE), true);
  assert.equal(hasDshContext(`engines: { dsh: '>=${BASELINE}' }`, BASELINE), true);
  assert.equal(
    hasDshContext(`受保护根按模板解析，默认 \`$DSH_HOME/**\`。实测（DSH ${BASELINE} / darwin-arm64）`, BASELINE),
    true,
  );
});

test('listDocOccurrences 分类：基线位置、历史记录、未分类，且忽略章节号与 IP', () => {
  const root = fixtureRoot();
  try {
    const file = join(root, CANONICAL_SPOTS[0].file);
    const next = sibling(BASELINE);
    writeFileSync(
      file,
      [
        `| AS-4 | 锁版本 \`${BASELINE}\` + 升级门禁 |`,
        `> 编制依据：2026-10-24 对 DSH \`${BASELINE}\` 的核验（历史记录）`,
        `- 见 §5.1.1 与 http://127.0.0.1:4567 两处`,
        `- 恰好落在本发布线的裸表述：DSH \`${next}\``,
        `| CORP-DSH-DESIGN-003 | 策略与审计详细设计 | V0.2.1 | 草案 |`,
      ].join('\n'),
    );
    const rows = listDocOccurrences(root, BASELINE);
    const kinds = rows.map((row) => `${row.kind}:${row.version}`);
    assert.ok(kinds.includes(`canonical:${BASELINE}`), kinds.join(' '));
    assert.ok(kinds.includes(`dated:${BASELINE}`), kinds.join(' '));
    assert.ok(kinds.includes(`unclassified:${next}`), kinds.join(' '));
    assert.equal(
      rows.some((row) => row.text.includes('127.0.0')),
      false,
      'IP 不应被当作版本',
    );
    assert.equal(
      rows.some((row) => row.text.includes('CORP-DSH-DESIGN-003')),
      false,
      '标识符 CORP-DSH-* 不应被当作 DSH 上下文（否则会把文档版本行当成 DSH 版本）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewriteCanonical 只改基线位置，并把历史记录原样保留', () => {
  const root = fixtureRoot();
  try {
    const file = join(root, CANONICAL_SPOTS[0].file);
    const next = sibling(BASELINE);
    const original = [`锁版本 \`${BASELINE}\` + 升级门禁`, `> 编制依据：2026-10-24 对 DSH \`${BASELINE}\` 的核验`].join('\n');
    writeFileSync(file, original);
    const { text, replaced } = rewriteCanonical(readFileSync(file, 'utf8'), CANONICAL_SPOTS[0].file, next);
    assert.equal(replaced, 1);
    assert.match(text, new RegExp(`锁版本 \`${next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
    assert.ok(text.includes(`编制依据：2026-10-24 对 DSH \`${BASELINE}\` 的核验`), '历史记录被改写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCodeOccurrences：src 里的硬编码被拒，清单与夹具例外被放行', () => {
  const root = fixtureRoot();
  try {
    mkdirSync(join(root, 'packages/demo/src'), { recursive: true });
    mkdirSync(join(root, 'packages/demo/test'), { recursive: true });
    writeFileSync(join(root, 'packages/demo/src/index.mjs'), `export const pinned = '${BASELINE}';\n`);
    writeFileSync(join(root, 'packages/demo/test/unit.test.mjs'), `const fixture = '${BASELINE}';\n`);
    writeFileSync(join(root, 'packages/demo/package.json'), `{ "engines": { "dsh": ">=${BASELINE}" } }\n`);
    const rows = listCodeOccurrences(root, BASELINE);
    const kinds = new Set(rows.map((row) => row.kind));
    assert.ok(kinds.has('code-forbidden'), [...kinds].join(' '));
    assert.equal(
      rows.find((row) => row.file.endsWith('src/index.mjs'))?.kind,
      'code-forbidden',
    );
    assert.equal(rows.find((row) => row.file.includes('/test/'))?.kind, 'code-allowed');
    assert.equal(rows.find((row) => row.file.endsWith('package.json'))?.kind, 'code-allowed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('清单里的 engines.dsh 下限可列举：形状合法，且与基线的差异必须有登记的原因', () => {
  const floors = listEngineFloors(ROOT);
  assert.ok(floors.length >= 5, `只找到 ${floors.length} 个清单`);
  for (const floor of floors) {
    assert.match(floor.floor, DSH_VERSION_SHAPE, `${floor.file} 的 engines.dsh 下限形状非法`);
    const sameLine = dshReleaseLine(floor.floor) === dshReleaseLine(BASELINE);
    if (!sameLine) {
      assert.equal(floor.exception, true, `${floor.file} 的下限 ${floor.floor} 与基线不同发布线且未登记原因`);
      assert.ok(floor.reason, `${floor.file} 的例外缺少原因说明`);
    }
  }
  const next = sibling(BASELINE);
  const { text, replaced } = rewriteEngineFloors(`{ "engines": { "dsh": ">=${BASELINE}" } }`, next);
  assert.equal(replaced, 1);
  assert.ok(text.includes(next));
});

test('代码允许清单：测试夹具与本工具自身放行，源码与清单不在"整文件白名单"里', () => {
  const allowed = (rel) => CODE_ALLOWED.some((entry) => (entry.only ? entry.re.test(rel) && entry.only.test(rel) : entry.re.test(rel)));
  assert.ok(allowed('packages/demo/test/x.test.mjs'));
  assert.ok(allowed('tests/x.test.mjs'));
  assert.ok(allowed('scripts/lib/dsh-version.mjs'));
  assert.equal(allowed('packages/demo/src/index.mjs'), false);
  // 测试目录里的数据夹具不整目录放行：确需写死版本要登记例外。
  assert.equal(allowed('tests/fixture.json'), false);
  // 清单不整文件放行：只放行 engines.dsh 里的值，否则 dependencies 里钉死的版本会溜过去。
  assert.equal(allowed('packages/demo/package.json'), false);
});

// --- CLI 级用例：lib 用例覆盖不到"跑起来会不会失败" ---

const CLI_SRC = join(ROOT, 'scripts/dsh-version.mjs');
const LIB_SRC = join(ROOT, 'scripts/lib/dsh-version.mjs');

/** 同发布线内的前一个候选版（如 0.2.1-rc.3 → 0.2.1-rc.2）；没有预发布后缀时返回 null。 */
function previousCandidate(version) {
  const match = version.match(/^(.*-rc\.)(\d+)$/);
  return match && Number(match[2]) > 0 ? `${match[1]}${Number(match[2]) - 1}` : null;
}

/** 搭一个最小仓库：真源 + 两处声明位置 + 任意附加文件，并把被测工具复制进去。 */
function corpusFiles(options) {
  const { files = {}, requirement, architecture, baseline = BASELINE } = options;
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-cli-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'docs/requirements'), { recursive: true });
  mkdirSync(join(root, 'docs/architecture'), { recursive: true });
  writeFileSync(join(root, DSH_VERSION_FILE), `${baseline}\n`);
  copyFileSync(LIB_SRC, join(root, 'scripts/lib/dsh-version.mjs'));
  copyFileSync(CLI_SRC, join(root, 'scripts/dsh-version.mjs'));
  writeFileSync(
    join(root, 'docs/requirements/requirements-baseline.md'),
    requirement ?? `| AS-4 | 试点期间无 DSH 上游破坏性变更影响已锁版本 | 推断 | 锁版本 \`${baseline}\` + 升级门禁 |\n`,
  );
  writeFileSync(
    join(root, 'docs/architecture/platform-architecture.md'),
    architecture ?? `- **锁版本**：一期兼容目标固定 DSH \`${baseline}\`（升级循环见设计索引）。\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function withCorpus(options, fn) {
  const root = corpusFiles(options);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(root, args) {
  return spawnSync(process.execPath, [join(root, 'scripts/dsh-version.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('CLI check：基线一致通过；声明位置过期、只剩历史记录都失败', () => {
  withCorpus({}, (root) => assert.equal(runCli(root, ['check']).status, 0));
  withCorpus(
    { requirement: `| AS-4 | 试点期间无 DSH 上游破坏性变更影响已锁版本 | 推断 | 锁版本 \`${sibling(BASELINE)}\` + 升级门禁 |\n` },
    (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AS-4 锁版本/);
    },
  );
  withCorpus(
    { requirement: '| AS-4 | 试点期间无 DSH 上游破坏性变更影响已锁版本 | 推断 | 见下方说明 |\n' },
    (root) => assert.equal(runCli(root, ['check']).status, 1, '缺少当前基线声明应当失败'),
  );
});

test('CLI check：同一文件里的第二处非历史过期表述会被抓到（只验第一处会漏）', () => {
  const current = sibling(BASELINE);
  withCorpus(
    {
      requirement:
        `| AS-4 | 试点期间无 DSH 上游破坏性变更影响已锁版本 | 推断 | 锁版本 \`${BASELINE}\` + 升级门禁 |\n` +
        `\n补充：本仓锁版本 \`${current}\`，与真源保持一致。\n`,
    },
    (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, new RegExp(current.replace(/\./g, '\\.')));
    },
  );
});

test('CLI check：真行之前的带日期历史引用不算过期声明', () => {
  const old = sibling(BASELINE);
  withCorpus(
    {
      requirement:
        `> 历史：2026-10-24 曾锁版本 \`${old}\`（已升级）。\n\n` +
        `| AS-4 | 试点期间无 DSH 上游破坏性变更影响已锁版本 | 推断 | 锁版本 \`${BASELINE}\` + 升级门禁 |\n`,
    },
    (root) => assert.equal(runCli(root, ['check']).status, 0),
  );
});

test('CLI check：扫描面覆盖 deploy/、根清单以外的扩展名与 v 前缀', () => {
  withCorpus({ files: { 'deploy/install.yml': `DSH_VERSION="${BASELINE}"\n` } }, (root) => {
    const result = runCli(root, ['check']);
    assert.equal(result.status, 1, 'deploy/ 下的硬编码必须被拦');
    assert.match(result.stderr, /deploy\/install\.yml/);
  });
  withCorpus({ files: { 'packages/demo/src/pin.cjs': `module.exports = { pin: '${BASELINE}' };\n` } }, (root) => {
    assert.equal(runCli(root, ['check']).status, 1, '.cjs 也必须被扫到');
  });
  withCorpus({ files: { 'packages/demo/src/pin.mjs': `export const PIN = 'v${BASELINE}';\n` } }, (root) => {
    assert.equal(runCli(root, ['check']).status, 1, 'v 前缀不能绕过');
  });
});

test('CLI check/report：排除 Paperclip 本地工作副本，仍检查相近名称目录与 CI 配置', () => {
  const pin = `DSH_VERSION="${BASELINE}"\n`;
  withCorpus({ files: { '.paperclip/worktrees/demo/packages/demo/pin.mjs': pin } }, (root) => {
    const result = runCli(root, ['check']);
    assert.equal(result.status, 0, result.stderr);
    const report = runCli(root, ['report']);
    assert.equal(report.status, 0, report.stderr);
    assert.doesNotMatch(report.stdout, /\.paperclip\//);
  });
  for (const file of ['.paperclip-other/pin.mjs', '.github/workflows/pin.yml', 'packages/demo/src/pin.mjs']) {
    withCorpus({ files: { [file]: pin } }, (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1, `${file} 仍须检查`);
      assert.ok(result.stderr.includes(file), result.stderr);
    });
  }
});

test('CLI check：清单只放行 engines.dsh 的值，下限断言会拦跨基础版本与高于基线', () => {
  const below = previousCandidate(BASELINE);
  const base = BASELINE.replace(/^v/i, '').split('-')[0];
  const otherBase = base.replace(/(\d+)$/, (digit) => String(Number(digit) - 1));
  withCorpus(
    { files: { 'packages/demo/package.json': `{"name":"demo","engines":{"dsh":">=${otherBase}"}}\n` } },
    (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1, '不同基础版本且未登记例外必须失败');
      assert.match(result.stderr, /ENGINE_FLOOR_EXCEPTIONS/);
    },
  );
  withCorpus(
    { files: { 'packages/demo/package.json': `{"name":"demo","engines":{"dsh":">=${otherLine(BASELINE)}"}}\n` } },
    (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /发布线/);
    },
  );
  withCorpus(
    { files: { 'packages/demo/package.json': `{"name":"demo","engines":{"dsh":">=${sibling(BASELINE)}"}}\n` } },
    (root) => {
      const result = runCli(root, ['check']);
      assert.equal(result.status, 1, '下限高于基线必须失败');
      assert.match(result.stderr, /高于基线/);
    },
  );
  withCorpus(
    { files: { 'packages/demo/package.json': `{"name":"demo","dependencies":{"@deepseek-ai/dsh":"^${BASELINE}"}}\n` } },
    (root) => assert.equal(runCli(root, ['check']).status, 1, '依赖里钉死 DSH 版本也应被拦'),
  );
  if (below) {
    withCorpus(
      { files: { 'packages/demo/package.json': `{"name":"demo","engines":{"dsh":">=${below}"}}\n` } },
      (root) => {
        const result = runCli(root, ['check']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /提示/);
      },
    );
  }
});

test('CLI check：目标声明行不得写死目标版本，带核验判据的版本可以保留', () => {
  withCorpus({ files: { 'docs/design/plugins/demo.md': `| 目标 DSH 与 SDK | \`${BASELINE}\` |\n` } }, (root) => {
    const result = runCli(root, ['check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /目标 DSH 与 SDK/);
  });
  withCorpus(
    {
      files: {
        'docs/design/plugins/demo.md': `| 目标 DSH 与 SDK | 见仓库根 \`${DSH_VERSION_FILE}\`（接口核验版本 \`${sibling(BASELINE)}\`，2026-10-21） |\n`,
      },
    },
    (root) => assert.equal(runCli(root, ['check']).status, 0),
  );
});

test('CLI apply：任意预发布后缀都能改完再通过 check，非法形状拒绝落盘', () => {
  withCorpus({}, (root) => {
    const target = '0.2.1-beta.1';
    const applied = runCli(root, ['apply', target, '--write']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(root, DSH_VERSION_FILE), 'utf8').trim(), target);
    assert.equal(runCli(root, ['check']).status, 0, '改完必须仍能通过 check（旧实现会把自己写红）');
  });
  withCorpus({}, (root) => {
    const rejected = runCli(root, ['apply', 'not-a-version', '--write']);
    assert.equal(rejected.status, 2);
    assert.equal(readFileSync(join(root, DSH_VERSION_FILE), 'utf8').trim(), BASELINE);
  });
});

test('CANONICAL_SPOTS 覆盖声明的基线位置（防止实现里减少声明而用例照样通过）', () => {
  assert.deepEqual(
    CANONICAL_SPOTS.map((spot) => [spot.file, spot.label]),
    [
      ['docs/requirements/requirements-baseline.md', 'AS-4 锁版本'],
      ['docs/architecture/platform-architecture.md', '一期兼容目标'],
    ],
  );
});
