#!/usr/bin/env node
/**
 * DSH 版本批量工具：报告 / 校验 / 改版。
 *
 *   node scripts/dsh-version.mjs report                 # 列出文档与代码里的所有版本出现位置及分类
 *   node scripts/dsh-version.mjs check                  # 校验：正文基线位置与 .dsh-version 一致、代码无硬编码
 *   node scripts/dsh-version.mjs apply <version>        # 改版：写 .dsh-version + 只改声明的正文基线位置
 *   node scripts/dsh-version.mjs apply <version> --engines   # 同时提升各包 engines.dsh 下限
 *
 * 默认不改历史记录：带日期或标注为编制依据/实测/探针的行只出现在 report 里，不会被 apply 改写。
 * `apply` 默认演练（dry-run），加 `--write` 才落盘。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICAL_SPOTS,
  DSH_VERSION_FILE,
  DSH_VERSION_SHAPE,
  checkEngineFloors,
  checkTargetDeclarations,
  listCodeOccurrences,
  listDocOccurrences,
  listEngineFloors,
  readDshVersion,
  rewriteCanonical,
  rewriteEngineFloors,
  spotMatches,
} from './lib/dsh-version.mjs';

const root = process.cwd();
const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((item) => item.startsWith('--')));
const positional = rest.filter((item) => !item.startsWith('--'));

function groupByKind(rows) {
  const kinds = new Map();
  for (const row of rows) {
    if (!kinds.has(row.kind)) kinds.set(row.kind, []);
    kinds.get(row.kind).push(row);
  }
  return kinds;
}

function report() {
  const current = readDshVersion(root);
  const docs = listDocOccurrences(root);
  const code = listCodeOccurrences(root);
  console.log(`当前基线：${current}（来源 ${DSH_VERSION_FILE}）`);
  console.log(`\n正文出现 ${docs.length} 处：`);
  const titles = {
    canonical: '基线位置（apply 会改）',
    dated: '历史记录（apply 不改）',
    unclassified: '未分类（需人工确认，apply 不改）',
  };
  for (const [kind, rows] of groupByKind(docs)) {
    console.log(`\n[${titles[kind] ?? kind}] ${rows.length} 处`);
    for (const row of rows) console.log(`  ${row.file}:${row.line}  ${row.version}  ${row.text}`);
  }
  console.log(`\n代码/脚本出现 ${code.length} 处（扫描面：全仓，排除 docs/ 与依赖/产物目录）：`);
  const codeTitles = { 'fixture-exception': '夹具例外（登记原因，不随基线更新）' };
  for (const [kind, rows] of groupByKind(code)) {
    console.log(`\n[${codeTitles[kind] ?? kind}] ${rows.length} 处`);
    for (const row of rows) {
      const note = row.reason ? `  ← ${row.reason}` : '';
      console.log(`  ${row.file}:${row.line}  ${row.version}  ${row.text}${note}`);
    }
  }
  const floors = listEngineFloors(root);
  if (floors.length) {
    console.log(`\nengines.dsh 下限（${floors.length} 个清单）：`);
    for (const floor of floors) {
      const note = floor.exception ? `  [有意例外：${floor.reason}]` : '';
      console.log(`  ${floor.file}  ${floor.floor}${note}`);
    }
  }
  const floorsCheck = checkEngineFloors(root);
  for (const line of floorsCheck.warnings) console.log(`\n提示：${line}`);
  const canonicalSpots = new Set(CANONICAL_SPOTS.map((spot) => spot.file));
  const seen = new Set(listDocOccurrences(root).filter((row) => row.kind === 'canonical').map((row) => row.file));
  const missing = [...canonicalSpots].filter((file) => !seen.has(file));
  if (missing.length) console.log(`\n警告：声明的基线位置未命中：${missing.join('、')}（正文可能已改写，需更新 CANONICAL_SPOTS）`);
}

function check() {
  const current = readDshVersion(root);
  const problems = [];
  for (const spot of CANONICAL_SPOTS) {
    const text = readFileSync(join(root, spot.file), 'utf8');
    const matches = spotMatches(text, spot);
    // 带日期的历史记录不算当前声明；其余命中**全部**必须等于基线（只验第一处会漏掉后加的第二处）。
    const live = matches.filter((row) => !row.dated);
    if (!matches.length) {
      problems.push(`${spot.file}：未找到「${spot.label}」，基线位置可能被改写（更新 CANONICAL_SPOTS 或正文）`);
      continue;
    }
    if (!live.length) {
      problems.push(`${spot.file}：「${spot.label}」只剩带日期的历史记录，缺少当前基线声明`);
      continue;
    }
    for (const row of live) {
      if (row.version !== current) {
        problems.push(`${spot.file}:${row.line}：「${spot.label}」写 ${row.version}，与 ${DSH_VERSION_FILE} 的 ${current} 不一致`);
      }
    }
  }
  problems.push(...checkTargetDeclarations(root));
  const floorsCheck = checkEngineFloors(root, current);
  problems.push(...floorsCheck.problems);
  const code = listCodeOccurrences(root, current);
  for (const row of code) {
    if (row.kind === 'code-forbidden') {
      problems.push(`${row.file}:${row.line}：代码/脚本硬编码 DSH 版本 ${row.version}（改为读 ${DSH_VERSION_FILE} 或用清单/夹具例外）`);
    }
  }
  if (problems.length) {
    console.error(`version: ${problems.length} error(s)`);
    for (const line of problems) console.error(`- ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `version: ok（基线 ${current}；基线位置 ${CANONICAL_SPOTS.length} 处、代码无硬编码、下限 ${listEngineFloors(root).length} 个已断言）`,
  );
  for (const line of floorsCheck.warnings) console.log(`version: 提示 ${line}`);
  for (const row of code.filter((item) => item.kind === 'fixture-exception')) {
    console.log(`version: 夹具例外 ${row.file}:${row.line}（${row.reason}）`);
  }
}

function apply(target) {
  if (!target || !DSH_VERSION_SHAPE.test(target)) {
    console.error(`用法：node scripts/dsh-version.mjs apply <version>[ --engines][ --write]（收到 ${JSON.stringify(target ?? '')}）`);
    process.exitCode = 2;
    return;
  }
  const write = flags.has('--write');
  const current = readDshVersion(root);
  const changes = [];
  const staged = new Map();
  if (current !== target) changes.push({ file: DSH_VERSION_FILE, from: current, to: target });
  for (const spot of CANONICAL_SPOTS) {
    const abs = join(root, spot.file);
    const { text, replaced, from } = rewriteCanonical(readFileSync(abs, 'utf8'), spot.file, target);
    staged.set(abs, text);
    if (replaced) {
      changes.push({ file: `${spot.file}（${spot.label}）`, from: from ?? current, to: target });
    } else {
      console.log(`跳过 ${spot.file}：${spot.label} 已是 ${target}`);
    }
  }
  // 落盘前自检：改完的正文里，声明位置的非历史命中必须**全等于**目标版本，否则会把自己写进 check 失败的状态。
  const selfProblems = [];
  for (const spot of CANONICAL_SPOTS) {
    const abs = join(root, spot.file);
    const text = staged.get(abs) ?? readFileSync(abs, 'utf8');
    const live = spotMatches(text, spot).filter((row) => !row.dated);
    if (!live.length) selfProblems.push(`${spot.file}：改写后找不到「${spot.label}」`);
    for (const row of live) {
      if (row.version !== target) selfProblems.push(`${spot.file}:${row.line}：「${spot.label}」改写后仍为 ${row.version}`);
    }
  }
  if (selfProblems.length) {
    console.error(`version: apply 自检未通过（目标 ${target} 无法被现有匹配识别），未写入任何文件`);
    for (const line of selfProblems) console.error(`- ${line}`);
    process.exitCode = 2;
    return;
  }
  if (write) for (const [abs, text] of staged) if (text !== readFileSync(abs, 'utf8')) writeFileSync(abs, text);
  if (flags.has('--engines')) {
    for (const floor of listEngineFloors(root)) {
      if (floor.exception) {
        console.log(`跳过 ${floor.file}：有意例外（${floor.reason}）`);
        continue;
      }
      const abs = join(root, floor.file);
      const { text, replaced } = rewriteEngineFloors(readFileSync(abs, 'utf8'), target);
      if (replaced) {
        changes.push({ file: `${floor.file}（engines.dsh）`, from: floor.floor, to: target });
        if (write) writeFileSync(abs, text);
      }
    }
  } else {
    const floors = listEngineFloors(root).filter((floor) => floor.floor !== target);
    if (floors.length) {
      console.log(`未提升 engines.dsh 下限（如需一并提升加 --engines）：${floors.map((f) => `${f.file}=${f.floor}`).join('、')}`);
    }
  }
  if (write && current !== target) writeFileSync(join(root, DSH_VERSION_FILE), `${target}\n`);
  console.log(`\n${write ? '已写入' : '演练（未落盘，加 --write 落盘）'}：${changes.length} 处`);
  for (const change of changes) console.log(`  ${change.file}  ${change.from} → ${change.to}`);
  const docs = listDocOccurrences(root);
  const dated = docs.filter((row) => row.kind !== 'canonical' && row.version !== target);
  console.log(`\n保持不动的历史/未分类记录：${dated.length} 处（用 report 查看；确认其中是否有应当一并更新的"当前基线"表述）`);
}

switch (command) {
  case 'report':
    report();
    break;
  case 'check':
    check();
    break;
  case 'apply':
    apply(positional[0]);
    break;
  default:
    console.error('用法：node scripts/dsh-version.mjs <report|check|apply> [version] [--engines] [--write]');
    process.exitCode = 2;
}
