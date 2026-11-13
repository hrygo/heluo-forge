import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, SERVICE_KEY } from '../src/index.mjs';
import { REASONS } from '../src/errors.mjs';
import { buildSkillNacosTools } from '../src/tools.mjs';
import { baseConfig, fakeCtx, skillPackage, startMockNacos, tempHome } from './helpers.mjs';

const SKILLS = [
  {
    name: 'code-review-std',
    description: '提交前代码评审标准流程',
    versions: [
      { version: '1.5.0', status: 'online', updateTime: 2, zip: skillPackage('code-review-std', { version: '1.5.0', description: '提交前代码评审标准流程', extra: [{ path: 'checklist.md', data: '# 清单\n' }] }) },
      { version: '1.6.0', status: 'online', updateTime: 3, zip: skillPackage('code-review-std', { version: '1.6.0', description: '提交前代码评审标准流程（新增两项阻断）' }) },
    ],
  },
  { name: 'api-doc-gen', description: '接口文档生成', versions: [{ version: '2.0.0', status: 'online', updateTime: 1, zip: skillPackage('api-doc-gen', { version: '2.0.0' }) }] },
  { name: 'db-migration-guard', description: '数据库变更自查', versions: [{ version: '0.9.4', status: 'online', updateTime: 1, zip: skillPackage('db-migration-guard', { version: '0.9.4' }) }] },
];

let setup;

test.before(async () => {
  const home = await tempHome();
  const server = await startMockNacos({ skills: SKILLS });
  process.env.DSH_HOME = home.base;
  const ctx = fakeCtx();
  const teardown = await apply(ctx, baseConfig(server.url, { catalogRefreshIntervalMs: 0 }));
  setup = {
    home, server, ctx, teardown,
    service: ctx.state.services[SERVICE_KEY],
    provider: ctx.state.providers[0],
  };
});

test.after(async () => {
  setup.teardown();
  await setup.server.close();
  delete process.env.DSH_HOME;
});

test('install commits atomically and the provider serves the native shape', async () => {
  const result = await setup.service.install({ name: 'code-review-std', ref: { version: '1.5.0' } });
  assert.equal(result.ok, true);
  assert.match(result.contentSha256, /^[0-9a-f]{64}$/);

  const candidates = await setup.provider.list({});
  const candidate = candidates.find((entry) => entry.name === 'code-review-std');
  assert.equal(candidate.rank, 700);
  assert.equal(candidate.source, 'nacos');
  assert.equal(candidate.provider, 'nacos');
  assert.equal(candidate.metadata.version, '1.5.0');
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.ok(candidate.path.endsWith('SKILL.md'));

  const definition = await setup.provider.get(candidate);
  assert.match(definition.content, /# 指令/);
  assert.equal(definition.resourceBase.path, candidate.resourceBase.path);
  assert.equal(existsSync(join(candidate.resourceBase.path, 'checklist.md')), true);
});

test('re-installing the same version is idempotent; another version demands explicit upgrade', async () => {
  const again = await setup.service.install({ name: 'code-review-std', ref: { version: '1.5.0' } });
  assert.equal(again.alreadyInstalled, true);
  await assert.rejects(
    setup.service.install({ name: 'code-review-std', ref: { version: '1.6.0' } }),
    (error) => error.code === REASONS.VERSION_MISMATCH,
  );
});

test('upgrade keeps the previous version directory and switches the pointer', async () => {
  const upgraded = await setup.service.upgrade({ name: 'code-review-std', ref: { version: '1.6.0' } });
  assert.equal(upgraded.version, '1.6.0');
  const storeRoot = join(setup.home.base, 'skill-nacos', 'store', 'code-review-std');
  assert.deepEqual((await readdir(storeRoot)).sort(), ['1.5.0', '1.6.0']);
  const candidate = (await setup.provider.list({})).find((entry) => entry.name === 'code-review-std');
  assert.equal(candidate.metadata.version, '1.6.0');
});

test('disable retires the skill from the provider; enable brings it back', async () => {
  await setup.service.disable('code-review-std');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'code-review-std'), false);
  await setup.service.enable('code-review-std');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'code-review-std'), true);
});

test('a tampered SKILL.md makes the record invisible instead of serving unknown content', async () => {
  const skillMdPath = join(setup.home.base, 'skill-nacos', 'store', 'code-review-std', '1.6.0', 'SKILL.md');
  const original = await readFile(skillMdPath, 'utf8');
  writeFileSync(skillMdPath, `${original}\n<!-- tampered -->`, 'utf8');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'code-review-std'), false);
  writeFileSync(skillMdPath, original, 'utf8');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'code-review-std'), true);
});

test('same-name local skills from other providers block the install', async () => {
  setup.ctx.state.existingSkills = [{ name: 'api-doc-gen', provider: 'filesystem', source: 'user-dsh' }];
  await assert.rejects(
    setup.service.install({ name: 'api-doc-gen', ref: { version: '2.0.0' } }),
    (error) => error.code === REASONS.NAME_CONFLICT,
  );
  setup.ctx.state.existingSkills = [];
  const installed = await setup.service.install({ name: 'api-doc-gen', ref: { version: '2.0.0' } });
  assert.equal(installed.version, '2.0.0');
});

test('project scope is visible only inside the project and convertible', async () => {
  await setup.service.changeScope({ name: 'api-doc-gen', to: 'project', cwd: setup.home.insideProject });
  const inside = await setup.provider.list({ cwd: setup.home.insideProject });
  const outside = await setup.provider.list({ cwd: setup.home.outside });
  assert.equal(inside.some((entry) => entry.name === 'api-doc-gen'), true);
  assert.equal(outside.some((entry) => entry.name === 'api-doc-gen'), false);

  await setup.service.changeScope({ name: 'api-doc-gen', to: 'user' });
  assert.equal((await setup.provider.list({ cwd: setup.home.outside })).some((entry) => entry.name === 'api-doc-gen'), true);

  await assert.rejects(
    setup.service.changeScope({ name: 'api-doc-gen', to: 'project', cwd: setup.home.outside }),
    (error) => error.code === REASONS.NO_PROJECT_ROOT,
  );
});

test('project-scope install refuses outside a project root', async () => {
  await assert.rejects(
    setup.service.install({ name: 'db-migration-guard', ref: { version: '0.9.4' }, scope: 'project', cwd: setup.home.outside }),
    (error) => error.code === REASONS.NO_PROJECT_ROOT,
  );
  assert.equal(setup.service.listInstalled().some((record) => record.name === 'db-migration-guard'), false);
});

test('uninstall keeps files in trash; restore verifies integrity; purge cleans up', async () => {
  const { trashId } = await setup.service.uninstall('api-doc-gen');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'api-doc-gen'), false);
  assert.equal(existsSync(join(setup.home.base, 'skill-nacos', 'store', 'api-doc-gen', '2.0.0')), true);

  const restored = await setup.service.restore(trashId);
  assert.equal(restored.version, '2.0.0');
  assert.equal((await setup.provider.list({})).some((entry) => entry.name === 'api-doc-gen'), true);

  const second = await setup.service.uninstall('api-doc-gen');
  const skillMdPath = join(setup.home.base, 'skill-nacos', 'store', 'api-doc-gen', '2.0.0', 'SKILL.md');
  writeFileSync(skillMdPath, '---\nname: api-doc-gen\ndescription: tampered\n---\nx', 'utf8');
  await assert.rejects(setup.service.restore(second.trashId), (error) => error.code === REASONS.INVALID_PACKAGE);

  const purged = await setup.service.purge(second.trashId);
  assert.equal(purged.name, 'api-doc-gen');
  assert.equal(existsSync(join(setup.home.base, 'skill-nacos', 'store', 'api-doc-gen')), false);
});

test('orphan staging content is wiped at startup cleanup', async () => {
  const orphan = join(setup.home.base, 'skill-nacos', 'staging', 'dead-tx');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'pkg.zip'), 'junk');
  const removed = await setup.service.cleanStaging();
  assert.ok(removed >= 1);
  assert.equal(existsSync(orphan), false);
});

test('tools are registered through apply, gate-aligned, and fail visibly', async () => {
  const names = setup.ctx.state.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'skill_nacos_search', 'skill_nacos_show', 'skill_nacos_install', 'skill_nacos_enable',
    'skill_nacos_disable', 'skill_nacos_upgrade', 'skill_nacos_scope', 'skill_nacos_uninstall',
  ]);
  for (const tool of setup.ctx.state.tools) {
    if (tool.parameters.required) assert.deepEqual(tool.parameters.required, ['target']);
  }

  const search = setup.ctx.state.tools[0];
  const searched = await search.execute({ keyword: '评审' });
  assert.equal(JSON.parse(searched.content[0].text).ok, true);

  const installTool = setup.ctx.state.tools[2];
  const missing = await installTool.execute({});
  const missingBody = JSON.parse(missing.content[0].text);
  assert.equal(missingBody.reason, 'MISSING_TARGET');

  const conflict = await installTool.execute({ target: 'api-doc-gen@1.0.0' });
  const conflictBody = JSON.parse(conflict.content[0].text);
  assert.equal(conflictBody.ok, false);
  assert.ok(conflictBody.next_action.length > 0);
});

test('buildSkillNacosTools stays the single tool truth for package-shape checks', () => {
  const tools = buildSkillNacosTools(setup.service);
  assert.equal(tools.length, 8);
  assert.ok(tools.every((tool) => typeof tool.execute === 'function'));
});
