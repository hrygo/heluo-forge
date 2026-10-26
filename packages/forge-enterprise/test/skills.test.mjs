import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assembleEnterpriseSkills,
  EnterpriseSkillError,
  loadClausePack,
  preActionConstraints,
  registerEnterpriseSkills,
  selectClauses,
} from '../src/skills.mjs';

function pack(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-enterprise-'));
  mkdirSync(join(root, 'clauses'), { recursive: true });
  writeFileSync(join(root, 'clauses/a.md'), '# 规范 A\n硬要求：提交前必须冻结交付清单。\n');
  writeFileSync(join(root, 'clauses/b.md'), '# 规范 B\n建议：PR 描述引用变更号。\n');
  writeFileSync(join(root, 'clauses/old.md'), '# 旧规范\n2025 版已废止。\n');
  writeFileSync(join(root, 'clauses/c.md'), '# 规范 C\n硬要求：外发前必须确认。\n');
  const index = {
    version: 3,
    clauses: [
      { id: 'A-1', title: '交付冻结', level: 'hard', owner: 'platform', summary: '交付前冻结清单', appliesTo: [{ system: 'devops', versions: ['2.1.*'] }], body: 'clauses/a.md', references: ['issue.close'], key: 'delivery', decision: 'freeze-required' },
      { id: 'B-1', title: 'PR 描述', level: 'advice', owner: 'platform', summary: '描述引用变更号', appliesTo: [{ system: 'gitee', versions: ['*'] }], body: 'clauses/b.md' },
      { id: 'OLD-1', title: '旧规范', level: 'hard', status: 'expired', owner: 'legacy-team', summary: '已废止', appliesTo: [{ system: 'devops' }], body: 'clauses/old.md' },
      { id: 'C-1', title: '外发确认', level: 'hard', owner: 'security', summary: '外发需确认', appliesTo: [{ system: 'devops', versions: ['2.1.*'] }], body: 'clauses/c.md', references: ['change.clarification.write'], key: 'egress', decision: 'confirm-required' },
      { id: 'A-2', title: '交付冻结（另一说）', level: 'hard', owner: 'team-b', summary: '另一套冻结口径', appliesTo: [{ system: 'devops', versions: ['2.1.*'] }], body: 'clauses/c.md', key: 'delivery', decision: 'no-freeze' },
    ],
    ...extra,
  };
  writeFileSync(join(root, 'clauses.json'), JSON.stringify(index));
  return { root, indexPath: join(root, 'clauses.json') };
}

test('a clause pack loads bodies read-only', () => {
  const { root, indexPath } = pack();
  const before = statSync(indexPath).mtimeMs;
  const loaded = loadClausePack({ root });
  assert.equal(loaded.version, 3);
  assert.equal(loaded.clauses.length, 5);
  assert.match(loaded.clauses[0].body, /冻结交付清单/);
  assert.equal(loaded.clauses[0].bytes > 0, true);
  assert.equal(statSync(indexPath).mtimeMs, before, 'loading never writes the pack');
  assert.equal(readFileSync(join(root, 'clauses/a.md'), 'utf8').includes('硬要求'), true);
});

test('an invalid pack refuses to load', () => {
  const { root } = pack();
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'nope', body: 'clauses/a.md' }] } }), (error) => error.code === 'ENTERPRISE_CLAUSE_INVALID');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard' }] } }), (error) => error.code === 'ENTERPRISE_CLAUSE_INVALID');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard', body: '/etc/passwd' }] } }), (error) => error.code === 'ENTERPRISE_PATH_ABSOLUTE');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard', body: '../escape.md' }] } }), (error) => error.code === 'ENTERPRISE_PATH_TRAVERSAL');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard', body: 'clauses/missing.md' }] } }), (error) => error.code === 'ENTERPRISE_CLAUSE_BODY_MISSING');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard', status: 'weird', body: 'clauses/a.md' }] } }), (error) => error.code === 'ENTERPRISE_CLAUSE_INVALID');
  assert.throws(() => loadClausePack({ root, index: { clauses: [{ id: 'X', level: 'hard', body: 'clauses/a.md' }, { id: 'X', level: 'hard', body: 'clauses/a.md' }] } }), (error) => error.code === 'ENTERPRISE_CLAUSE_DUPLICATE');
  assert.throws(() => loadClausePack({ root: join(root, 'absent') }), (error) => error.code === 'ENTERPRISE_INDEX_MISSING');
  writeFileSync(join(root, 'broken.json'), '{ nope');
  assert.throws(() => loadClausePack({ root, indexFile: 'broken.json' }), (error) => error.code === 'ENTERPRISE_INDEX_INVALID');
});

test('a combined task loads only the applicable clauses', () => {
  const { root } = pack();
  const loaded = loadClausePack({ root });
  const selection = selectClauses({ pack: loaded, systems: [{ name: 'devops', version: '2.1.7' }] });
  const ids = selection.selected.map((clause) => clause.id);
  assert.deepEqual(ids.filter((id) => id.startsWith('B')), [], 'a gitee-only clause is not loaded for a devops task');
  assert.ok(ids.includes('A-1') && ids.includes('C-1'));
  assert.equal(selection.hard.length >= 2, true);
  assert.equal(selection.advice.length, 0);
  assert.ok(selection.excluded.some((entry) => entry.id === 'OLD-1' && entry.reason === 'expired' && entry.owner === 'legacy-team'));
  assert.ok(selection.excluded.some((entry) => entry.id === 'B-1' && entry.reason === 'not-applicable'));

  const both = selectClauses({ pack: loaded, systems: [{ name: 'devops', version: '2.1.7' }, { name: 'gitee', version: '9' }] });
  assert.ok(both.selected.some((clause) => clause.id === 'B-1'));
  assert.equal(both.advice.length, 1, 'hard and advice stay separable');
  const wrongVersion = selectClauses({ pack: loaded, systems: [{ name: 'devops', version: '1.0.0' }] });
  assert.equal(wrongVersion.selected.some((clause) => clause.id === 'A-1'), false, 'a version outside the range is not applied');
  const noVersion = selectClauses({ pack: loaded, systems: [{ name: 'devops' }] });
  assert.equal(noVersion.selected.some((clause) => clause.id === 'A-1'), false, 'a ranged clause needs a matching version');
});

test('an expired or conflicting clause is surfaced, never silently dropped', () => {
  const { root } = pack();
  const selection = selectClauses({ pack: loadClausePack({ root }), systems: [{ name: 'devops', version: '2.1.7' }] });
  assert.equal(selection.conflicts.length, 1);
  assert.deepEqual(selection.conflicts[0].owners.sort(), ['platform', 'team-b']);
  assert.deepEqual(selection.conflicts[0].clauses.sort(), ['A-1', 'A-2']);
  assert.equal(selection.loadRecord.skipped.some((entry) => entry.id === 'OLD-1'), true);
  assert.equal(selection.loadRecord.loaded.some((entry) => entry.id === 'A-2'), true, 'both sides of a conflict stay visible');
});

test('the context budget is enforced instead of silently truncating', () => {
  const { root } = pack();
  const loaded = loadClausePack({ root });
  const within = selectClauses({ pack: loaded, systems: [{ name: 'devops', version: '2.1.7' }], budgetTokens: 10_000 });
  assert.equal(within.budget.limit, 10_000);
  assert.equal(within.budget.estimatedTokens > 0, true);
  assert.equal(within.budget.clauses, within.selected.length);
  assert.throws(
    () => selectClauses({ pack: loaded, systems: [{ name: 'devops', version: '2.1.7' }], budgetTokens: 1 }),
    (error) => error instanceof EnterpriseSkillError && error.code === 'ENTERPRISE_BUDGET_EXCEEDED',
  );
});

test('registration is user-invocable only and performs no writes', () => {
  const { root, indexPath } = pack();
  const selection = selectClauses({ pack: loadClausePack({ root }), systems: [{ name: 'devops', version: '2.1.7' }] });
  const registrations = [];
  const before = statSync(indexPath).mtimeMs;
  const result = registerEnterpriseSkills({ skills: { register: (skill) => (registrations.push(skill), () => registrations.pop()) } }, { selection });
  assert.equal(result.invocation.modelInvocable, false, 'the model cannot invoke an enterprise entry on its own');
  assert.equal(result.invocation.userInvocable, true);
  assert.equal(registrations.length, selection.hard.length, 'only hard clauses are registered; nothing is injected wholesale');
  for (const skill of registrations) {
    assert.equal(skill.invocation.modelInvocable, false);
    assert.match(skill.description, /冻结|外发|另一套/);
    assert.match(skill.whenToUse, /按需加载/);
    assert.equal(skill.source, 'custom');
  }
  assert.equal(statSync(indexPath).mtimeMs, before, 'registration writes nothing');
  assert.equal(selection.loadRecord.loaded.every((entry) => entry.id.length > 0), true);

  const disposable = registerEnterpriseSkills({ skills: { register: () => () => {} } }, { selection, namePrefix: 'ent' });
  assert.equal(disposable.registered[0].name.startsWith('ent-'), true);
  disposable.dispose();
  assert.throws(() => registerEnterpriseSkills({}, { selection }), (error) => error.code === 'ENTERPRISE_HOST_UNAVAILABLE');
});

test('hard constraints are visible before the action and nothing claims compliance', () => {
  const { root } = pack();
  const selection = selectClauses({ pack: loadClausePack({ root }), systems: [{ name: 'devops', version: '2.1.7' }] });
  const forClose = preActionConstraints({ selection, action: 'issue.close' });
  assert.deepEqual(forClose.map((clause) => clause.id), ['A-1']);
  const forEgress = preActionConstraints({ selection, action: 'change.clarification.write' });
  assert.deepEqual(forEgress.map((clause) => clause.id), ['C-1']);
  assert.deepEqual(preActionConstraints({ selection, action: 'unrelated.action' }).map((clause) => clause.id), []);
  // 加载器只报告条款与引用，不产出"合规通过"结论：结果里没有合规判定字段，
  // 也没有自证 API（导出面只有加载/选择/注册/前置约束）。
  assert.equal('compliant' in selection, false);
  assert.equal('verdict' in selection, false);
  const source = readFileSync(new URL('../src/skills.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export (async )?function \w*(Complian|Attest)\w*/u, 'no self-attestation API is exported');
});

test('FIX-09: single managed assembly entry discovers summaries, loads bodies on demand, disposes cleanly', () => {
  const { root, indexPath } = pack();
  const before = statSync(indexPath).mtimeMs;
  const registrations = [];
  const ctx = { skills: { register: (skill) => (registrations.push(skill), () => void registrations.splice(registrations.indexOf(skill), 1)) } };
  const assembled = assembleEnterpriseSkills(ctx, { root, systems: [{ name: 'devops', version: '2.1.7' }] });
  // 发现面只有摘要：没有正文字段。
  assert.ok(assembled.discovered.length > 0);
  for (const item of assembled.discovered) {
    assert.equal('body' in item, false, 'discovery must not expand bodies');
    assert.ok(item.id.length > 0 && item.summary.length > 0 && item.owner.length > 0);
  }
  // 正文按需取用。
  assert.match(assembled.bodyFor('A-1'), /冻结交付清单/);
  assert.equal(assembled.bodyFor('NOPE'), undefined);
  // 动作前可见性：只给 id + 摘要 + 责任人，不给"合规通过"。
  assert.deepEqual(assembled.constraintsFor('issue.close').map((entry) => entry.id), ['A-1']);
  assert.deepEqual(assembled.constraintsFor('unrelated.action'), []);
  assert.equal('compliant' in assembled, false);
  assert.equal('verdict' in assembled, false);
  // 只注册 hard 条款；模型不可自调用；装配零写入。
  assert.equal(registrations.length, assembled.registered.length);
  assert.equal(assembled.invocation.modelInvocable, false);
  assert.equal(assembled.invocation.userInvocable, true);
  assert.equal(statSync(indexPath).mtimeMs, before, 'assembly writes nothing');
  // 冲突双方与责任人保持可见。
  assert.equal(assembled.conflicts.length, 1);
  // 一次 dispose 注销全部。
  assembled.dispose();
  assert.equal(registrations.length, 0);
});

test('FIX-09: assembly fails closed without a host skills service and honors the budget', () => {
  const { root } = pack();
  assert.throws(
    () => assembleEnterpriseSkills({}, { root, systems: [{ name: 'devops', version: '2.1.7' }] }),
    (error) => error instanceof EnterpriseSkillError && error.code === 'ENTERPRISE_HOST_UNAVAILABLE',
  );
  const ctx = { skills: { register: () => () => {} } };
  assert.throws(
    () => assembleEnterpriseSkills(ctx, { root, systems: [{ name: 'devops', version: '2.1.7' }], budgetTokens: 1 }),
    (error) => error instanceof EnterpriseSkillError && error.code === 'ENTERPRISE_BUDGET_EXCEEDED',
  );
});
