/**
 * Standalone artifact installation, clean teardown, restart readback, and unknown-schema
 * preservation verification for @heluo/forge-experts (CORP-DSH-DESIGN-023 §5.1–§5.2 / #246).
 *
 * Offline tarball install, release closure audit, isolated storage persistence across
 * reinstall/restart, and unknown-schema byte preservation always execute deterministically.
 * Target DSH CLI profile checks execute when DSH_BIN is available and report NOT RUN otherwise.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditReleaseClosure, execNpm } from '../../../scripts/lib/bundle-rules.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const builderScript = resolve(repoRoot, 'scripts/build-enterprise-bundle.mjs');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function resolveOrBuildTarball(workDir, isolatedEnv) {
  const configuredDir = process.env.FORGE_EXPERTS_ARTIFACT_DIR?.trim();
  if (configuredDir && existsSync(configuredDir)) {
    const tgz = readdirSync(configuredDir).find((name) => /^heluo-forge-experts-.*\.tgz$/u.test(name));
    if (tgz) {
      const tarball = join(configuredDir, tgz);
      return { tarball, sha256: sha256File(tarball), source: 'env-artifact-dir' };
    }
  }
  const artifactDir = join(workDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const run = spawnSync(
    process.execPath,
    [builderScript, '--entry', '@heluo/forge-experts', artifactDir],
    { cwd: repoRoot, env: isolatedEnv, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `build-enterprise-bundle failed: ${run.stderr || run.stdout}`);
  const parsed = JSON.parse(run.stdout);
  assert.ok(existsSync(parsed.tarball), 'built tarball must exist');
  assert.equal(sha256File(parsed.tarball), parsed.sha256, 'tarball sha256 must match builder digest');
  return { tarball: parsed.tarball, sha256: parsed.sha256, source: 'fresh-build' };
}

function createDiskJsonStorageDomain(storageFile) {
  const readDisk = () => {
    if (!existsSync(storageFile)) return {};
    return JSON.parse(readFileSync(storageFile, 'utf8'));
  };
  const writeDisk = (data) => {
    mkdirSync(dirname(storageFile), { recursive: true });
    const tmp = `${storageFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, storageFile);
  };

  return {
    async open(spec) {
      return {
        table(tableName) {
          return {
            get(key) {
              const all = readDisk();
              return all?.[spec.name]?.[tableName]?.[key];
            },
            async put(key, value) {
              const schema = spec.tables?.[tableName]?.valueSchema;
              const parsed = schema?.parse ? schema.parse(value) : value;
              const all = readDisk();
              all[spec.name] ??= {};
              all[spec.name][tableName] ??= {};
              all[spec.name][tableName][key] = parsed;
              writeDisk(all);
            },
          };
        },
        async close() {},
      };
    },
  };
}

test('standalone tarball installs offline, passes closure audit, survives reinstall/restart readback, and preserves unknown schema bytes', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'forge-experts-host-install-'));
  const installDir = join(workDir, 'profile');
  const storageFile = join(workDir, 'storage', 'forge_experts.json');
  const isolatedEnv = {
    ...process.env,
    npm_config_cache: join(workDir, 'npm-cache'),
    npm_config_userconfig: join(workDir, 'empty-npmrc'),
  };

  try {
    writeFileSync(join(workDir, 'empty-npmrc'), '');
    const artifact = resolveOrBuildTarball(workDir, isolatedEnv);

    // 1. Clean offline installation into isolated profile directory.
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'package.json'), '{"name":"forge-experts-install-profile","private":true}\n');
    execNpm(
      ['--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', 'install', artifact.tarball],
      { cwd: installDir, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const installedPkgDir = join(installDir, 'node_modules', '@heluo', 'forge-experts');
    assert.ok(existsSync(join(installedPkgDir, 'package.json')), 'installed package.json must exist');
    assert.deepEqual(
      auditReleaseClosure(installedPkgDir, { allowInstalledBinLinks: true }),
      [],
      'installed tarball must satisfy release closure rules',
    );

    // 2. Activate installed Host entrypoint, persist preference, then cleanly tear down.
    const installedMod = await import(`${pathToFileURL(join(installedPkgDir, 'src', 'index.mjs')).href}?boot=1`);
    const diskStorage = createDiskJsonStorageDomain(storageFile);
    const scope = {
      instanceId: 'delegra-install-01',
      orgId: 'org-install',
      issuer: 'https://iam.corp.example',
      subject: 'emp-install-1',
      validUntil: '2026-12-31T00:00:00Z',
    };

    const host1 = installedMod.createExpertsHost({
      config: { managementEnabled: true, dispatchEnabled: false },
      getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject, orgId: scope.orgId }),
      getConnection: () => ({ requestRejection: () => undefined }),
      openStorageDomain: (spec) => diskStorage.open(spec),
      resolveDelegraScope: async () => scope,
      fetchDelegraCatalog: async () => ({
        scope,
        catalogVersion: 'cv-1',
        completeness: 'complete',
        coveredScopes: [scope.orgId],
        items: [{
          expertId: 'exp-install-1',
          displayName: '安装验收专家',
          disambiguation: null,
          summary: { disclosureState: 'available', responsibility: '验证重启回读' },
          access: { readable: true, callableInOrg: true, callableReason: 'granted', authContinuityDigest: 'sha256:cont-v1' },
          availability: { acceptingTasks: 'accepting', reason: null },
        }],
        page: { nextCursor: null, hasMore: false },
      }),
      verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'sha256:cont-v1' }),
      resolveSessionScope: async () => ({ delegationScope: 'proj-install' }),
      checkDelegraSessionScope: async () => ({
        scope,
        scopeVerified: true,
        validUntil: scope.validUntil,
        results: [{
          expertId: 'exp-install-1',
          callableInScope: true,
          callableReason: 'granted',
          acceptingTasks: 'accepting',
          authContinuityDigest: 'sha256:cont-v1',
        }],
      }),
    });

    await host1.open();
    const resolved1 = await host1.scope.resolveForRequest();
    const prefBefore = await host1.preferences.get({
      scope: resolved1,
      scopeEpoch: resolved1.scopeEpoch,
      expertId: 'exp-install-1',
      authContinuityDigest: 'sha256:cont-v1',
    });
    assert.equal(prefBefore.enabled, false);
    const saved = await host1.preferences.setEnabled({
      scope: resolved1,
      scopeEpoch: resolved1.scopeEpoch,
      expertId: 'exp-install-1',
      enabled: true,
      editToken: prefBefore.editToken,
    });
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.enabled, true);
    assert.equal(saved.revision, 1);
    await host1.close();

    // 3. Reinstall the same tarball cleanly and reopen against the same storage file (§5.2 rollback/reinstall).
    rmSync(join(installDir, 'node_modules'), { recursive: true, force: true });
    execNpm(
      ['--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', 'install', artifact.tarball],
      { cwd: installDir, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const reinstalledMod = await import(`${pathToFileURL(join(installedPkgDir, 'src', 'index.mjs')).href}?boot=2`);
    const host2 = reinstalledMod.createExpertsHost({
      config: { managementEnabled: true, dispatchEnabled: false },
      getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject, orgId: scope.orgId }),
      getConnection: () => ({ requestRejection: () => undefined }),
      openStorageDomain: (spec) => diskStorage.open(spec),
      resolveDelegraScope: async () => scope,
      fetchDelegraCatalog: async () => ({ scope, items: [], page: { nextCursor: null, hasMore: false } }),
      verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'sha256:cont-v1' }),
      resolveSessionScope: async () => null,
      checkDelegraSessionScope: async () => ({ scope, scopeVerified: true, results: [] }),
    });
    await host2.open();
    const resolved2 = await host2.scope.resolveForRequest();
    const readback = await host2.preferences.get({
      scope: resolved2,
      scopeEpoch: resolved2.scopeEpoch,
      expertId: 'exp-install-1',
      authContinuityDigest: 'sha256:cont-v1',
    });
    assert.equal(readback.enabled, true, 'confirmed preference must survive reinstall and restart');
    assert.equal(readback.revision, 1);
    await host2.close();

    // 4. Unknown storage schema bytes must fail closed while preserving exact bytes untouched (§5.2).
    const unknownFile = join(workDir, 'storage', 'forge_experts_unknown.json');
    const prefKey = createHash('sha256')
      .update(JSON.stringify([scope.instanceId, scope.orgId, scope.issuer, scope.subject, 'exp-install-1']))
      .digest('hex');
    const rawUnknownPayload = JSON.stringify({
      forge_experts: {
        preferences: {
          [prefKey]: {
            schemaVersion: 99,
            futureField: 'preserve-me',
          },
        },
      },
    }, null, 2);
    writeFileSync(unknownFile, rawUnknownPayload);
    const unknownBeforeBytes = readFileSync(unknownFile, 'utf8');

    const unknownStorage = createDiskJsonStorageDomain(unknownFile);
    const host3 = reinstalledMod.createExpertsHost({
      config: { managementEnabled: true, dispatchEnabled: false },
      getIamSession: () => ({ state: 'ready', issuer: scope.issuer, subject: scope.subject, orgId: scope.orgId }),
      getConnection: () => ({ requestRejection: () => undefined }),
      openStorageDomain: (spec) => unknownStorage.open(spec),
      resolveDelegraScope: async () => scope,
      fetchDelegraCatalog: async () => ({ scope, items: [], page: { nextCursor: null, hasMore: false } }),
      verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'sha256:cont-v1' }),
      resolveSessionScope: async () => null,
      checkDelegraSessionScope: async () => ({ scope, scopeVerified: true, results: [] }),
    });
    await host3.open();
    const resolved3 = await host3.scope.resolveForRequest();
    await assert.rejects(
      () => host3.preferences.get({
        scope: resolved3,
        scopeEpoch: resolved3.scopeEpoch,
        expertId: 'exp-install-1',
        authContinuityDigest: 'sha256:cont-v1',
      }),
      (err) => err.code === 'EXPERT_STORAGE_UNAVAILABLE',
    );
    assert.equal(readFileSync(unknownFile, 'utf8'), unknownBeforeBytes, 'unknown schema bytes must remain untouched');
    await host3.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('target DSH CLI profile dump-config mounts @heluo/forge-experts patch layer (NOT RUN when DSH_BIN unavailable)', (t) => {
  const dshBin = process.env.DSH_BIN?.trim();
  if (!dshBin) {
    t.skip('NOT RUN: DSH_BIN is not set; supply DSH_BIN=/path/to/dsh to execute target host profile check');
    return;
  }
  const versionRun = spawnSync(dshBin, ['--version'], { encoding: 'utf8' });
  if (versionRun.error || versionRun.status !== 0) {
    t.skip(`NOT RUN: DSH_BIN (${dshBin}) is not executable in current environment`);
    return;
  }
  const target = (process.env.FORGE_EXPERTS_TARGET ?? 'web').trim().toLowerCase();
  const patchPath = resolve(repoRoot, 'packages/forge-experts/cordis.patch.yml');
  const dumpRun = spawnSync(dshBin, ['--profile', target, '--patch', patchPath, '--dump-config'], { encoding: 'utf8' });
  assert.equal(dumpRun.status, 0, `dsh --dump-config failed: ${dumpRun.stderr}`);
  assert.match(dumpRun.stdout, /@heluo\/forge-experts/u);
});
