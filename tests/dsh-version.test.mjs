/**
 * DSH 版本单一真源工具的用例。
 * 夹具版本一律从 `.dsh-version` 派生（加一个修订号），测试本身不写死 DSH 版本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICAL_SPOTS,
  CODE_ALLOWED,
  DSH_VERSION_FILE,
  DSH_VERSION_SHAPE,
  dshReleaseLine,
  dshVersionInLine,
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

test('代码允许清单覆盖清单元数据、测试夹具与本工具自身', () => {
  assert.ok(CODE_ALLOWED.some((re) => re.test('packages/demo/package.json')));
  assert.ok(CODE_ALLOWED.some((re) => re.test('packages/demo/test/x.test.mjs')));
  assert.ok(CODE_ALLOWED.some((re) => re.test('tests/x.test.mjs')));
  assert.ok(CODE_ALLOWED.some((re) => re.test('scripts/lib/dsh-version.mjs')));
  assert.equal(CODE_ALLOWED.some((re) => re.test('packages/demo/src/index.mjs')), false);
});
