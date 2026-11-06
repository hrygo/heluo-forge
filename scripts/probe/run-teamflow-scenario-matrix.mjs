/**
 * Teamflow 九类场景矩阵的**只读**证据探针（r13 / AC-7）。
 *
 * 做两件事，都不执行模型、不创建 run、不连宿主：
 * 1. `--fixtures`（默认）：对随包的交付 Skill 正文与既有团队流用例做静态断言，
 *    逐条核对本场景应当存在的守则，输出 9 行 Markdown 表骨架。真实宿主列固定
 *    `NOT RUN`——本机没有可复跑的真实 run 证据时，夹具结论不得冒充联调结论。
 * 2. `--report <path>`：解析 QA 报告里的同一张 9 行表，校验列齐、来源类型合法，
 *    以及「真实宿主列不是 NOT RUN 时必须有命令与时间」。把填表纪律变成可复跑断言。
 *
 * 退出码：0 全通过；1 有缺守则 / 表格不合规；2 用法错误。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repo, 'packages/forge-enterprise/skills');
const SKILL = 'issue-delivery/SKILL.md';
const HANDOFF = 'issue-delivery/references/handoff.md';
const EVIDENCE = 'issue-delivery/references/evidence.md';

/** 报告表头：列名固定，顺序固定；`真实宿主` 是唯一允许出现实测的列。 */
export const REPORT_COLUMNS = Object.freeze(['场景', '守则', '夹具结论', '来源类型', '真实宿主', '命令', '时间']);
/** 来源类型白名单：夹具与真实执行分开写，避免「本地跑过」被读成「宿主跑过」。 */
export const SOURCE_TYPES = Object.freeze(['local-execution', 'host-execution', 'fixture', 'NOT RUN']);

/**
 * 9 条固定场景。`phrases` 是要在随包 Skill 里找到的守则原文片段，
 * `tests` 是仓库内必须存在的既有用例（矩阵不能只靠正文自证）。
 */
export const SCENARIOS = Object.freeze([
  {
    id: 'first-handoff',
    title: '首次交接',
    rule: '已有 run 先查询；缺依赖即停并列出缺什么；版本以 contentId 为准',
    phrases: [
      { file: SKILL, text: '把已核实的范围、验收、提交要求和来源交给原生 Teamflow' },
      { file: SKILL, text: '恰一个变更、恰一个代码仓库' },
      { file: SKILL, text: '版本以 `forge_gitee_delivery_snapshot` 的 `contentId` 为准' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'same-task-reentry',
    title: '同任务重复进入',
    rule: '相同 Issue、仓库与要求版本再次进入时先查已有 run，不重复交接',
    phrases: [
      { file: SKILL, text: '相同 Issue、仓库与要求版本再次进入时先查已有 run' },
      { file: HANDOFF, text: '相同 Issue / 仓库 / 要求版本再次进入' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'running-task',
    title: '运行中进入',
    rule: '运行中只跟踪，不重启、不重放写动作',
    phrases: [
      { file: SKILL, text: '运行中只跟踪' },
      { file: HANDOFF, text: '运行中' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'resume-interrupted',
    title: '中断续跑',
    rule: '可续跑的原生续跑一次，不自建执行器、不补写状态',
    phrases: [
      { file: SKILL, text: '可续跑的原生续跑一次' },
      { file: SKILL, text: '本 Skill 不提供替代执行器' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'completed-reentry',
    title: '已完成再进入',
    rule: '已完成先核对版本；completed 只证明执行状态，不证明验证与审查',
    phrases: [
      { file: SKILL, text: '已完成先核对版本' },
      { file: SKILL, text: '原生 `completed` 只证明执行状态' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'conflicting-links',
    title: '关联冲突',
    rule: '多变更、多仓库或入口冲突时只做只读澄清，不自行挑第一个',
    phrases: [
      { file: SKILL, text: '不自行挑第一个' },
      { file: SKILL, text: '重新读取' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'version-changed',
    title: '版本变化',
    rule: '代码或验收要求变化后，旧验证与旧审查不得自动沿用',
    phrases: [
      { file: SKILL, text: '旧验证与旧审查**不得自动沿用**' },
      { file: EVIDENCE, text: '失效' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'missing-dependency',
    title: '缺依赖',
    rule: '缺哪一项就停在哪一步并说明影响与下一步，不用提示词补齐能力',
    phrases: [
      { file: SKILL, text: '停止并说明缺哪一项、影响哪些步骤、下一步做什么' },
      { file: SKILL, text: '不猜目录、不切主目录' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
  {
    id: 'forged-pass-claim',
    title: '伪造通过声明',
    rule: '未取证的通过声明不得写成已验证；输出是证据摘要不是验收结论',
    phrases: [
      { file: SKILL, text: '本 Skill 的输出是证据摘要，不是硬门禁，也不能替代用户验收结论' },
      { file: EVIDENCE, text: '来源分层' },
    ],
    tests: ['packages/forge-enterprise/test/issue-delivery-contract.test.mjs'],
  },
]);

/** 逐条跑静态断言；缺正文、缺片段、缺用例都算「不满足」，并给出可定位原因。 */
export function runFixtures({ root = repo } = {}) {
  const roots = { skill: join(root, 'packages/forge-enterprise/skills'), repo: root };
  return SCENARIOS.map((scenario) => {
    const reasons = [];
    let loaded = 0;
    for (const { file, text } of scenario.phrases) {
      const path = join(roots.skill, file);
      if (!existsSync(path)) {
        reasons.push(`missing ${relative(root, path)}`);
        continue;
      }
      loaded += 1;
      if (!readFileSync(path, 'utf8').includes(text)) reasons.push(`${relative(root, path)} lacks "${text}"`);
    }
    for (const test of scenario.tests) {
      if (!existsSync(join(roots.repo, test))) reasons.push(`missing ${test}`);
    }
    return { id: scenario.id, title: scenario.title, rule: scenario.rule, ok: reasons.length === 0, reasons, checked: scenario.phrases.length, loaded };
  });
}

function tableOf(results) {
  const lines = [
    `| ${REPORT_COLUMNS.join(' | ')} |`,
    `|${REPORT_COLUMNS.map(() => '---').join('|')}|`,
  ];
  for (const entry of results) {
    lines.push(`| ${entry.title} | ${entry.rule} | ${entry.ok ? '满足' : `不满足：${entry.reasons.join('；')}`} | fixture | NOT RUN | — | — |`);
  }
  return lines.join('\n');
}

function cellsOf(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

/** 解析报告里的 9 行表；只认表头与 `REPORT_COLUMNS` 逐字一致的块。 */
export function parseReport(text) {
  const lines = text.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const header = cellsOf(lines[start]);
    if (header === null || header.join('|') !== REPORT_COLUMNS.join('|')) continue;
    const rows = [];
    for (let index = start + 2; index < lines.length; index += 1) {
      const cells = cellsOf(lines[index]);
      if (cells === null || cells.length !== REPORT_COLUMNS.length) break;
      rows.push(Object.fromEntries(REPORT_COLUMNS.map((column, position) => [column, cells[position]])));
    }
    return { found: true, rows, line: start + 1 };
  }
  return { found: false, rows: [], line: 0 };
}

/** 表格合规：行数/场景齐全、来源类型合法、真实宿主列有实测就必须带命令与时间。 */
export function validateReport(text) {
  const errors = [];
  const parsed = parseReport(text);
  if (!parsed.found) return { ok: false, rows: 0, errors: ['no table with the expected header (see REPORT_COLUMNS)'] };
  const byTitle = new Map(parsed.rows.map((row) => [row['场景'], row]));
  for (const scenario of SCENARIOS) {
    const row = byTitle.get(scenario.title);
    if (row === undefined) {
      errors.push(`missing scenario row: ${scenario.title}`);
      continue;
    }
    byTitle.delete(scenario.title);
    if (!SOURCE_TYPES.includes(row['来源类型'])) errors.push(`${scenario.title}: 来源类型 "${row['来源类型']}" not in ${SOURCE_TYPES.join('/')}`);
    const host = row['真实宿主'];
    if (host !== 'NOT RUN' && host.length > 0) {
      if (row['命令'] === '—' || row['命令'].length === 0) errors.push(`${scenario.title}: 真实宿主有结论但没有命令`);
      if (!/^\d{4}-\d{2}-\d{2}/u.test(row['时间'] ?? '')) errors.push(`${scenario.title}: 真实宿主有结论但没有可复核时间`);
    }
    if (row['夹具结论'] !== '满足' && row['夹具结论'] !== '不满足' && row['夹具结论'] !== 'NOT RUN') {
      errors.push(`${scenario.title}: 夹具结论 must be 满足/不满足/NOT RUN`);
    }
  }
  for (const extra of byTitle.keys()) errors.push(`unknown scenario row: ${extra}`);
  if (parsed.rows.length !== SCENARIOS.length) errors.push(`expected ${SCENARIOS.length} rows, found ${parsed.rows.length}`);
  return { ok: errors.length === 0, rows: parsed.rows.length, errors };
}

function main(argv) {
  const reportAt = argv.indexOf('--report');
  if (reportAt !== -1) {
    const target = argv[reportAt + 1];
    if (target === undefined || target.startsWith('-')) {
      console.error('scenario-matrix: --report needs a path');
      process.exitCode = 2;
      return;
    }
    if (!existsSync(target)) {
      console.error(`scenario-matrix: report not found: ${target}`);
      process.exitCode = 2;
      return;
    }
    const verdict = validateReport(readFileSync(target, 'utf8'));
    for (const error of verdict.errors) console.error(`scenario-matrix: ${error}`);
    console.log(`scenario-matrix: ${verdict.rows}/${SCENARIOS.length} rows, ${verdict.ok ? 'report ok' : 'report invalid'}`);
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }
  const results = runFixtures();
  console.log(tableOf(results));
  for (const entry of results) {
    if (!entry.ok) for (const reason of entry.reasons) console.error(`scenario-matrix: ${entry.id}: ${reason}`);
  }
  const ok = results.every((entry) => entry.ok);
  console.log(`scenario-matrix: ${results.filter((entry) => entry.ok).length}/${results.length} fixture assertions ok; 真实宿主 NOT RUN`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
