/**
 * 正式 Skill 的**静态**契约（r12 §9 / AC-3 / AC-16）。
 *
 * 这里只证明资源本身：文案不许承诺宿主没有的能力、不许把提示词写成硬门禁、引用的工具名必须
 * 是真实存在的公开工具。真正的调用次数、启动／续跑纪律由宿主实测与探针证明，本文件不冒充。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { RESOURCE_BASE } from '../src/issue-delivery-skill.mjs';
import { loadClausePack } from '../src/skills.mjs';

const SKILL_DIR = join(RESOURCE_BASE, 'issue-delivery');
const read = (relative) => readFileSync(join(SKILL_DIR, relative), 'utf8');

const MAIN = read('SKILL.md');
const HANDOFF = read('references/handoff.md');
const EVIDENCE = read('references/evidence.md');
const INDEX = JSON.parse(readFileSync(join(RESOURCE_BASE, 'clauses.json'), 'utf8'));
const PACK = loadClausePack({ root: RESOURCE_BASE });

test('资源有界：主正文精简，细节在 references 里按需加载', () => {
  // 标准 Agent Skill 的 frontmatter 是发现元数据，不属于“主正文”；以宿主实际
  // 装载的剥离结果计量，避免把元数据算成正文预算。
  const mainBytes = PACK.clauses[0].bytes;
  assert.ok(mainBytes > 500, '主正文不能空到没有实质内容');
  assert.ok(mainBytes < 4096, `主正文应保持精简（当前 ${mainBytes} 字节），细节放 references/`);
  assert.ok(Buffer.byteLength(HANDOFF, 'utf8') > 400);
  assert.ok(Buffer.byteLength(EVIDENCE, 'utf8') > 400);
  assert.match(MAIN, /references\/handoff\.md/u);
  assert.match(MAIN, /references\/evidence\.md/u);
});

test('条款索引形状：一条 hard 条款，正文与引用都指向包内真实文件', () => {
  assert.equal(INDEX.version, 1);
  assert.equal(INDEX.clauses.length, 1);
  const [clause] = INDEX.clauses;
  assert.deepEqual(
    { id: clause.id, level: clause.level, status: clause.status, body: clause.body },
    { id: 'issue-delivery', level: 'hard', status: 'active', body: 'issue-delivery/SKILL.md' },
  );
  assert.ok(clause.summary.length > 0 && clause.summary.length <= 200, '摘要要短');
  assert.ok(Array.isArray(clause.appliesTo) && clause.appliesTo.length > 0);
});

test('引用的工具名都是本仓库真实存在的公开工具（不臆造接口）', () => {
  const referenced = new Set(INDEX.clauses[0].references);
  const known = new Set([
    'forge_gitee_delivery_snapshot',
    'forge_gitee_issue_read',
    'forge_gitee_repository_read',
    'forge_gitee_pr_read',
    'forge_devops_change_context',
    'forge_devops_query',
    'teamflow_start',
    'teamflow_status',
    'teamflow_resume',
  ]);
  for (const tool of referenced) assert.equal(known.has(tool), true, `条款引用了不存在的工具：${tool}`);

  // 正文提到的工具名同样必须是真实工具：拼错的工具名比没有工具名更危险。
  for (const [, tool] of MAIN.matchAll(/`(forge_[a-z_]+|teamflow_[a-z_]+)\(/gu)) {
    assert.equal(known.has(tool), true, `SKILL.md 提到了不存在的工具：${tool}`);
  }
  for (const [, tool] of (HANDOFF + EVIDENCE).matchAll(/`(forge_[a-z_]+|teamflow_[a-z_]+)\(/gu)) {
    assert.equal(known.has(tool), true, `references 提到了不存在的工具：${tool}`);
  }
});

test('AC-16 文案不冒充门禁：不承诺跳过阶段、不代写批准、不自证只读', () => {
  const all = `${MAIN}\n${HANDOFF}\n${EVIDENCE}`;
  // 允许"不声称跳过/不得跳过"这类否定表述，禁止的是正向承诺。
  const forbidden = [
    /可以跳过(PRD|阶段|确认)/u,
    /自动(合并|关闭|发布)/u,
    /readOnly\s*=\s*true/u,
    /approved\s*=\s*true/u,
    /调用方(传入|声明).{0,6}即(可|视为)/u,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(all, pattern, `文案出现越权表述：${pattern}`);
  }
  for (const phrase of ['只能标为**声明**', 'NOT RUN', '不代表可关闭']) {
    assert.ok(all.includes(phrase), `缺关键边界表述：${phrase}`);
  }
});

test('AC-3 依赖缺失要说清楚：缺什么、影响哪些步骤、下一步做什么', () => {
  for (const dependency of ['forge_gitee_issue_read', 'Teamflow', 'forge_gitee_delivery_snapshot', '已授权工作区']) {
    assert.ok(MAIN.includes(dependency), `依赖表缺 ${dependency}`);
  }
  assert.match(MAIN, /下一步/u);
  assert.match(MAIN, /短路/u);
});

test('AC-11/AC-14 证据章节把版本绑定写成 contentId，并声明旧证据不可自动沿用', () => {
  assert.match(EVIDENCE, /contentId/u);
  assert.match(EVIDENCE, /不得自动沿用|失去自动适用资格/u);
  assert.match(EVIDENCE, /unknown/u);
  assert.match(EVIDENCE, /企业[^\n]*NOT RUN|NOT RUN/u);
});
