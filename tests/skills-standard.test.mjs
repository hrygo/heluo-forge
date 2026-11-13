import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkSkills } from '../scripts/check-skills.mjs';
import { assembleEnterpriseSkills, loadClausePack } from '../packages/forge-engineering/src/skills.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function tempRoot(t, prefix = 'forge-skills-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function put(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function frontmatter(name, description = '演示技能') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function writeSkill(root, { directory, name = directory, description = '演示技能', body = '# 演示技能\n\n正文。\n', raw = undefined }) {
  put(root, `.agents/skills/${directory}/SKILL.md`, raw ?? `${frontmatter(name, description)}${body}`);
}

test('the repository skill tree passes the standard', () => {
  const { errors, counts } = checkSkills(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(counts.skills >= 2, 'the enterprise clause and the release skill are both discovered');
});

test('a skill without frontmatter fails', (t) => {
  const root = tempRoot(t);
  writeSkill(root, { directory: 'plain-skill', raw: '# 纯正文\n' });
  const { errors } = checkSkills(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing YAML frontmatter/u);
});

test('a name that does not match its directory fails', (t) => {
  const root = tempRoot(t);
  writeSkill(root, { directory: 'demo-skill', name: 'other-skill' });
  const { errors } = checkSkills(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not match its directory/u);
});

test('an uppercase or underscored name fails', (t) => {
  for (const [index, name] of ['Demo-Skill', 'demo_skill'].entries()) {
    const root = tempRoot(t, `forge-skills-test-${index}-`);
    writeSkill(root, { directory: name });
    const { errors } = checkSkills(root);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0], /lowercase kebab-case/u);
  }
});

test('a description over 1024 characters fails', (t) => {
  const root = tempRoot(t);
  writeSkill(root, { directory: 'long-skill', description: 'x'.repeat(1025) });
  const { errors } = checkSkills(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /above the 1024 limit/u);
});

test('a missing referenced path fails', (t) => {
  const root = tempRoot(t);
  writeSkill(root, {
    directory: 'linked-skill',
    body: '# 链接技能\n\n见 [参考](references/missing.md)。\n',
  });
  const { errors } = checkSkills(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /references\/missing\.md/u);
});

test('a valid minimal skill passes, including an existing reference and a non-checked URL', (t) => {
  const root = tempRoot(t);
  writeSkill(root, {
    directory: 'valid-skill',
    body: '# 有效技能\n\n见 [参考](references/guide.md) 与 [发布页](https://example.invalid/release) 以及 [锚点](#用途)。\n',
  });
  put(root, '.agents/skills/valid-skill/references/guide.md', '# 参考\n');
  const { errors, counts } = checkSkills(root);
  assert.deepEqual(errors, []);
  assert.equal(counts.skills, 1);
});

test('quoted frontmatter scalars are read like the clause loader', (t) => {
  const root = tempRoot(t);
  writeSkill(root, { directory: 'quoted-skill', name: '"quoted-skill"', description: '"带引号的描述"' });
  const { errors } = checkSkills(root);
  assert.deepEqual(errors, []);
});

test('duplicate names across roots and multiple H1 headings fail', (t) => {
  const root = tempRoot(t);
  writeSkill(root, { directory: 'demo-skill' });
  put(root, 'packages/demo/skills/demo-skill/SKILL.md', `${frontmatter('demo-skill')}# 另一个\n`);
  writeSkill(root, { directory: 'two-headings', body: '# 第一\n\n# 第二\n' });
  const { errors } = checkSkills(root);
  assert.ok(errors.some((error) => /duplicate skill name/u.test(error)));
  assert.ok(errors.some((error) => /exactly one H1/u.test(error)));
});

test('loadClausePack validates and strips frontmatter before registration', (t) => {
  const root = tempRoot(t);
  put(root, 'clauses.json', { version: 1, clauses: [{ id: 'demo', level: 'hard', body: 'demo-skill/SKILL.md' }] });
  put(root, 'demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: 演示条款\n---\n# 演示标题\n\n正文。\n');
  const loaded = loadClausePack({ root });
  const clause = loaded.clauses[0];
  assert.equal(clause.body, '# 演示标题\n\n正文。\n');
  assert.doesNotMatch(clause.body, /---/u);
  assert.doesNotMatch(clause.body, /name:/u);
  const registrations = [];
  const assembled = assembleEnterpriseSkills(
    { skills: { register: (skill) => (registrations.push(skill), () => {}) } },
    { pack: loaded, systems: [] },
  );
  assert.deepEqual(assembled.registered.map((entry) => entry.name), ['enterprise-demo']);
  assert.equal(registrations[0].content, clause.body);
  assert.ok(registrations[0].content.startsWith('# 演示标题'));
});

test('loadClausePack refuses invalid frontmatter with a named error code', (t) => {
  const root = tempRoot(t);
  put(root, 'clauses.json', { version: 1, clauses: [{ id: 'demo', level: 'hard', body: 'demo-skill/SKILL.md' }] });
  const cases = [
    ['---\nname: demo-skill\n---\n# 缺少描述\n', /description/u],
    ['---\nname: other-skill\ndescription: 名称不符\n---\n# 名称不符\n', /does not match its directory/u],
    ['---\nname: demo-skill\ndescription: 未闭合\n', /not closed/u],
  ];
  for (const [text, expected] of cases) {
    put(root, 'demo-skill/SKILL.md', text);
    assert.throws(
      () => loadClausePack({ root }),
      (error) => error.code === 'ENTERPRISE_SKILL_FRONTMATTER_INVALID' && expected.test(error.message) && error.message.includes('"demo"'),
    );
  }
});

test('the enterprise issue-delivery pack still loads and registers under its skill name', () => {
  const registrations = [];
  const assembled = assembleEnterpriseSkills(
    { skills: { register: (skill) => (registrations.push(skill), () => {}) } },
    {
      root: join(repoRoot, 'packages/forge-engineering/skills'),
      systems: [{ name: 'teamflow' }, { name: 'gitee' }, { name: 'devops' }],
    },
  );
  assert.deepEqual(assembled.registered.map((entry) => entry.name), ['enterprise-issue-delivery']);
  assert.equal(registrations.length, 1);
  assert.ok(registrations[0].content.startsWith('# 单 Issue 可信待验收交付'));
  assert.doesNotMatch(registrations[0].content, /^---/u);
});
