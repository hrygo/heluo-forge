import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_PROFILE, PATCH_LAYER_FILE, UAT_SECTIONS, planUat, verifyLog } from '../scripts/uat-profile.mjs';

const tempHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'uat-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

test('planUat: builds a web-template profile and installs devops/gitee as separate plugin adds', (t) => {
  const home = tempHome(t);
  const plan = planUat({ profile: 'uat', env: { DSH_HOME: home }, home: '/ignored', root: '/repo' });

  assert.equal(plan.commands.createProfile, 'dsh --profile uat --from-default-profile web --dump-config');
  assert.deepEqual(plan.commands.install, [
    'dsh plugin --profile uat add /repo/dist/heluo-forge-devops-0.1.0.tgz',
    'dsh plugin --profile uat add /repo/dist/heluo-forge-gitee-0.1.0.tgz',
  ]);
  assert.equal(plan.commands.dumpConfig, 'dsh --profile uat --dump-config');
  // 启动不带 web 尾词：`dsh web --profile uat` 会被宿主当成额外参数拒绝；
  // `--host/--port/--no-open` 是 web 应用的参数，放在 profile 启动之后。
  assert.equal(plan.commands.launch, 'dsh --profile uat --host 127.0.0.1 --port 48490 --no-open');
  assert.equal(plan.port, 48490);
  assert.doesNotMatch(plan.commands.launch, /\bweb\b/);

  const installPaths = plan.artifacts.map((artifact) => artifact.path);
  assert.ok(installPaths.every((path) => path.startsWith('/repo/dist/')), 'tarball paths must be absolute');
  assert.deepEqual(
    plan.artifacts.map((artifact) => artifact.package),
    ['@heluo/forge-devops', '@heluo/forge-gitee'],
  );
});

test('planUat: rollback cleans the patch layer insert block and both packages', (t) => {
  const home = tempHome(t);
  const plan = planUat({ profile: 'uat', env: { DSH_HOME: home }, root: '/repo' });
  const rollback = plan.commands.rollback;

  assert.equal(rollback.patchLayer.file, join(home, 'profiles', 'uat', PATCH_LAYER_FILE));
  assert.match(rollback.patchLayer.instruction, /- insert:/);
  assert.match(rollback.patchLayer.instruction, /forge-devops/);
  assert.match(rollback.patchLayer.instruction, /heluo-gitee/);
  assert.deepEqual(rollback.commands, [
    'node scripts/uninstall-devops.mjs --profile uat',
    'dsh plugin --profile uat remove @heluo/forge-gitee',
    'dsh plugin --profile uat remove @heluo/forge-devops',
  ]);
  assert.equal(rollback.verify.command, 'dsh --profile uat --dump-config');
  assert.match(rollback.verify.expect.join('\n'), /bundles/);
  assert.match(rollback.verify.expect.join('\n'), /dependencies/);
  assert.match(rollback.verify.expect.join('\n'), /- insert:/);
});

test('planUat: reports a patch layer that still carries insert entries', (t) => {
  const home = tempHome(t);
  const profileDir = join(home, 'profiles', 'uat');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, PATCH_LAYER_FILE), '- insert:\n    - id: forge-devops\n');
  const plan = planUat({ profile: 'uat', env: { DSH_HOME: home }, root: '/repo' });
  assert.equal(plan.patchLayer.hasInsert, true);
  assert.equal(plan.profileExists, true);
});

test('planUat: an explicit --tarball adds the optional enterprise bundle last', (t) => {
  const home = tempHome(t);
  const plan = planUat({ profile: 'uat', tarball: '/artifacts/heluo-forge-enterprise-0.1.0.tgz', env: { DSH_HOME: home }, root: '/repo' });
  assert.deepEqual(plan.commands.install, [
    'dsh plugin --profile uat add /repo/dist/heluo-forge-devops-0.1.0.tgz',
    'dsh plugin --profile uat add /repo/dist/heluo-forge-gitee-0.1.0.tgz',
    'dsh plugin --profile uat add /artifacts/heluo-forge-enterprise-0.1.0.tgz',
  ]);
  assert.deepEqual(plan.commands.rollback.commands.slice(-1), ['dsh plugin --profile uat remove @heluo/forge-enterprise']);
});

const ENTRIES = [
  '- id: heluo-gitee',
  '  name: "@heluo/forge-gitee"',
  '- id: forge-devops',
  '  name: "@heluo/forge-devops"',
  'dependencies:',
  '  "@heluo/forge-gitee": 0.1.0',
  '  "@heluo/forge-devops": 0.1.0',
];

test('verifyLog: target sections need section-specific evidence, not any "slot" substring', () => {
  const log = [
    ...ENTRIES,
    '[slots] settings.section devops-readiness order=29 owner=@heluo/forge-devops',
    '[slots] settings.section gitee order=50 owner=@heluo/forge-gitee',
    '[slots] settings.section devops order=60 owner=@heluo/forge-devops',
  ].join('\n');
  const result = verifyLog(log);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.sections.map((section) => section.evidence !== null), [true, true, true]);
});

test('verifyLog: a registration block is accepted when id and owner are on adjacent lines', () => {
  const log = [
    ...ENTRIES,
    '[slots] register settings.section',
    '  id: devops-readiness order: 29',
    '  plugin: @heluo/forge-devops',
    '',
    '[slots] register settings.section',
    '  id: gitee order: 50',
    '  plugin: @heluo/forge-gitee',
    '',
    '[slots] register settings.section',
    '  id: devops order: 60',
    '  plugin: @heluo/forge-devops',
  ].join('\n');
  assert.equal(verifyLog(log).ok, true, JSON.stringify(verifyLog(log)));
});

test('verifyLog: an unrelated slot line proves nothing', () => {
  const log = [...ENTRIES, '[slots] Unrelated slot discarded'].join('\n');
  const result = verifyLog(log);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((message) => message.includes('devops-readiness')), JSON.stringify(result));
  assert.ok(result.missing.some((message) => message.includes('gitee')), JSON.stringify(result));
});

test('verifyLog: section ids without their owning package stay unverified', () => {
  const log = [
    ...ENTRIES,
    '[slots] settings.section devops-readiness order=29 registered',
    '[slots] settings.section gitee order=50 owner=@heluo/forge-devops',
    '[slots] settings.section devops order=60 owner=@heluo/forge-devops',
  ].join('\n');
  const result = verifyLog(log);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((message) => message.includes('devops-readiness')));
  assert.ok(result.missing.some((message) => message.includes('gitee')), 'a section must not borrow another package');
});

test('verifyLog: a mismatched order is not evidence for the expected section', () => {
  const log = [
    ...ENTRIES,
    '[slots] settings.section devops-readiness order=29 owner=@heluo/forge-devops',
    '[slots] settings.section gitee order=51 owner=@heluo/forge-gitee',
    '[slots] settings.section devops order=60 owner=@heluo/forge-devops',
  ].join('\n');
  const result = verifyLog(log);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((message) => message.includes('gitee')));
});

test('verifyLog: failure markers still fail even with full evidence', () => {
  const log = [
    ...ENTRIES,
    '[slots] settings.section devops-readiness order=29 owner=@heluo/forge-devops',
    '[slots] settings.section gitee order=50 owner=@heluo/forge-gitee',
    '[slots] settings.section devops order=60 owner=@heluo/forge-devops',
    'error: entry not found: @heluo/forge-devops',
  ].join('\n');
  const result = verifyLog(log);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes('entry not found')));
});

test('verifyLog: expected section table keeps id, order and owning package together', () => {
  assert.deepEqual(
    UAT_SECTIONS.map((section) => [section.id, section.order, section.owner]),
    [
      ['devops-readiness', 29, '@heluo/forge-devops'],
      ['gitee', 50, '@heluo/forge-gitee'],
      ['devops', 60, '@heluo/forge-devops'],
    ],
  );
  assert.equal(DEFAULT_PROFILE, 'heluo-r15-uat');
});
