import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const sdk = createRequire(new URL('../packages/forge-skills-manager/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/cordis')).href);
const { SkillRegistry } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-skill')).href);
import { apply as enterprise, TRUSTED_SKILL_RANK } from '../packages/forge-enterprise/src/issue-delivery-skill.mjs';
import { registerEnterpriseSkillsViaProvider } from '../packages/forge-enterprise/src/skills.mjs';

test('reserved skills cannot be created, imported or provided; native same-name copies cannot replace formal workflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-manager-policy-'));
  const before = { ...process.env };
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../packages/forge-skills-manager/lib/core.js');
  const root = local.userRoots().find(root => root.key === 'dsh');
  const document = '---\nname: enterprise-issue-delivery\ndescription: personal copy\n---\npersonal workflow';
  const ctx = new Context();
  let registry, fixture;
  try {
    assert.equal((await local.createSkill({ root: 'dsh', name: 'enterprise-issue-delivery', description: 'fixture', body: 'fixture' })).code, 'error.enterprise.reserved');
    const imported = await local.importUploadedSkill({ name: 'enterprise-issue-delivery', entries: [{ path: 'SKILL.md', data: Buffer.from(document).toString('base64') }] });
    assert.equal(imported.code, 'error.enterprise.reserved');
    await mkdir(join(root.path, 'enterprise-issue-delivery'), { recursive: true });
    await writeFile(join(root.path, 'enterprise-issue-delivery', 'SKILL.md'), document);
    assert.ok(!(await local.listProviderCandidates()).some(item => item.name.startsWith('enterprise-')));
    // Real SDK merge, including competing native project/user candidates.
    registry = ctx.plugin(SkillRegistry);
    await registry.await();
    fixture = ctx.plugin({ name: 'policy-integration', inject: ['skills'], apply(host) {
      enterprise(host);
      host.skills.registerProvider(() => ({ name: 'native-fixture', list: async () => [100, 400].map(rank => ({
        name: 'enterprise-issue-delivery', description: 'personal', source: 'filesystem', rank,
        provider: 'native-fixture', locator: { rank }, invocation: { modelInvocable: true, userInvocable: true },
      })), get: async candidate => ({ ...candidate, content: 'personal workflow' }) }));
    } });
    await fixture.await();
    const summary = (await ctx.skills.list()).find(item => item.name === 'enterprise-issue-delivery');
    assert.ok(TRUSTED_SKILL_RANK < 100);
    assert.equal(summary.provider, 'enterprise-clauses');
    assert.equal(summary.invocation.modelInvocable, false);
    assert.equal(summary.invocation.userInvocable, true);
    const full = await ctx.skills.get(summary.name);
    assert.match(full.content, /单 Issue 可信待验收交付/);
    assert.equal(await readFile(join(root.path, 'enterprise-issue-delivery', 'SKILL.md'), 'utf8'), document, 'historical user files are retained');
    for (const rank of [NaN, Infinity, '0']) assert.throws(() => registerEnterpriseSkillsViaProvider({}, { rank }), /finite/);
  } finally {
    await fixture?.dispose();
    await registry?.dispose();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await rm(directory, { recursive: true, force: true });
  }
});
