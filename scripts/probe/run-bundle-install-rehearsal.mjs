/**
 * #37: final self-contained tarball -> clean offline install -> real isolated
 * Cordis/Loader activation -> upgrade/rollback/unload/uninstall. No user profile.
 * DSH_BIN selects an existing CLI; DSH_NODE_MODULES may explicitly select its
 * already installed SDK modules. No downloads, symlinks, servers or OS keychain.
 * The measured macOS desktop launcher uses its installed Electron runtime to
 * read app.asar; ordinary CLI installations keep their original Node runtime.
 * The memory credential backend is an explicit LOCAL fixture, not enterprise IAM evidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEnterpriseBundle } from '../build-enterprise-bundle.mjs';
import { auditReleaseClosure, npmExecutable, parsePatchLayer } from '../lib/bundle-rules.mjs';
import { resolveDshProbeHost } from '../lib/dsh-probe-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dsh = process.env.DSH_BIN ?? 'dsh';
const hostLocation = resolveDshProbeHost({ dsh, modules: process.env.DSH_NODE_MODULES });
// Vanilla Node cannot import modules inside ASAR. Re-enter once using this
// installation's own Electron, preserving argv, exit status and the Node/npm PATH.
if (hostLocation.runtime !== null && realpathSync(process.execPath) !== hostLocation.runtime) {
  const child = spawnSync(hostLocation.runtime, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (child.error) console.error(`rehearsal: desktop runtime failed: ${child.error.message}`);
  process.exit(child.status ?? 1);
}
const profile = process.env.DSH_HOST_PROBE_PROFILE ?? 'sdk';
const officialRows = ['deepseek-account', 'ui-settings-account', 'llm-deepseek-account', 'llm-deepseek'];
const dir = mkdtempSync(join(tmpdir(), 'forge-install-rehearsal-'));
const project = join(dir, 'project');
const evidence = { probe: 'forge-bundle-install-rehearsal', startedAt: new Date().toISOString(), scope: 'local final-tarball composition, NOT enterprise IAM/keychain/registry acceptance', env: { profile, platform: `${process.platform}-${process.arch}`, node: process.version, operatorRole: 'authorized local sol_worker; synthetic credential fixture' }, steps: [], ok: true };
const record = (id, ok, detail = {}) => {
  evidence.steps.push({ id, ok, detail });
  if (!ok) evidence.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
const isolatedEnv = { ...process.env, DSH_HOME: join(dir, 'dsh-home'), npm_config_cache: join(dir, 'npm-cache'), npm_config_userconfig: join(dir, 'empty-npmrc'), npm_config_registry: 'http://127.0.0.1:9' };
delete isolatedEnv.DSH_PROFILE;
delete isolatedEnv.DSH_PROFILE_DIR;
const npm = (args) => execFileSync(npmExecutable(), ['--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...args], { cwd: project, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bundleDir = join(project, 'node_modules', '@heluo', 'forge-enterprise');
const intact = () => readFileSync(join(project, 'user-file.txt'), 'utf8') === 'user-workspace-marker\n' && readFileSync(join(project, 'user-notes', 'notes.md'), 'utf8') === '# 用户笔记\n';
const statusAtStart = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function activateInstalled(label, host) {
  const load = (name) => import(pathToFileURL(host.resolve(name)).href);
  const [{ Context }, { default: Loader }, { default: SystemPrompt }, { default: Tools }, { PluginPackages, createRuntimeResolution }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-app-boot'),
  ]);
  const installedPath = realpathSync(bundleDir);
  const installedRequire = createRequire(pathToFileURL(join(installedPath, 'package.json')));
  const patch = parsePatchLayer(readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8'));
  const ctx = new Context();
  let unloaded = false;
  const ids = [];
  try {
    const resolution = await createRuntimeResolution({
      installAnchor: host.resolve('@deepseek-ai/dsh/package.json'),
      home: isolatedEnv.DSH_HOME,
      profile: { dir: project, layers: [{ packageName: '@heluo/forge-enterprise', packageDir: installedPath }], skippedBundles: [] },
    });
    await ctx.plugin(PluginPackages, { resolution }).await();
    const expectedMembers = Object.keys(JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).dependencies);
    record(`${label}-native-runtime-resolves-bundled-members`, expectedMembers.every((name) => resolution.entries.some((entry) => entry.name === name && entry.scope === 'profile' && realpathSync(entry.packageDir).startsWith(`${installedPath}/`))));
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(Tools, {}).await();
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(installedPath, 'cordis.patch.yml')).href }).await();
    const resolved = [];
    for (const row of patch.inserted) {
      const entry = installedRequire.resolve(row.name);
      const memberPath = relative(installedPath, entry);
      if (memberPath.startsWith('..') || isAbsolute(memberPath)) throw new Error(`member escaped installed tarball: ${row.name}`);
      resolved.push({ name: row.name, entry: memberPath });
      const config = row.name === '@heluo/forge-credentials-keychain'
        ? { backend: (await import(pathToFileURL(entry).href)).createMemoryBackend(), allowEphemeral: true }
        : {};
      ids.push(await ctx.loader.create({ id: row.id, name: row.name, config }));
    }
    await ctx.loader.await();
    const phases = ids.map((id) => ({ id, phase: ctx.loader.resolve(id).fiber?.state }));
    const mounted = ['credentials', 'policy', 'iam'].every((key) => ctx.get(key) !== undefined);
    record(`${label}-real-loader-instantiates-members`, mounted && phases.every((entry) => entry.phase === 2 /* FiberState.ACTIVE (const enum in the installed SDK) */), { resolved, phases, fixture: 'memory credentials; no real identity, keychain or network' });
    if (label === 'install') {
      let invalidPluginRejected = false;
      try {
        await ctx.loader.create({ id: 'negative-legacy-sdd', name: '@heluo/forge-sdd' });
      } catch (error) {
        invalidPluginRejected = /invalid plugin/iu.test(error.message);
      } finally {
        if (ctx.loader.store['negative-legacy-sdd']) ctx.loader.remove('negative-legacy-sdd');
      }
      record('legacy-sdd-plugin-mount-is-rejected', invalidPluginRejected, { note: 'negative control: the delivered SDD library remains NOT a Host plugin' });
    }
    const policy = ctx.get('policy');
    const iam = ctx.get('iam');
    record(`${label}-services-queryable`, policy !== undefined && Array.isArray(policy.actions()) && iam !== undefined && typeof iam.getView === 'function' && iam.getView() !== undefined);
    // Removing actual Loader rows must own and remove registrations, not merely files.
    for (const id of ids.reverse()) ctx.loader.remove(id);
    await ctx.loader.await();
    unloaded = ['credentials', 'policy', 'iam'].every((key) => ctx.get(key) === undefined);
    record(`${label}-loader-unload-clears-registrations`, unloaded);
  } finally {
    await ctx.fiber.dispose();
  }
  if (!unloaded) throw new Error(`${label}: lifecycle cleanup was not proven`);
}

function dump(patch) {
  return spawnSync(dsh, ['--profile', profile, ...(patch ? ['--patch', patch] : []), '--dump-config'], { env: isolatedEnv, encoding: 'utf8' });
}
function rows(text) {
  const found = new Map();
  let id;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u);
    if (match) { id = match[1]; found.set(id, false); }
    if (id && /^\s*disabled:\s*true\s*$/u.test(line)) found.set(id, true);
  }
  return found;
}

mkdirSync(join(project, 'user-notes'), { recursive: true });
writeFileSync(join(project, 'package.json'), '{"name":"rehearsal-project","private":true}\n');
writeFileSync(join(project, 'user-file.txt'), 'user-workspace-marker\n');
writeFileSync(join(project, 'user-notes', 'notes.md'), '# 用户笔记\n');
writeFileSync(join(dir, 'empty-npmrc'), '');
try {
  const version = spawnSync(dsh, ['--version'], { env: isolatedEnv, encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`DSH unavailable: ${version.error?.message ?? version.stderr}`);
  evidence.env.dshVersion = version.stdout.trim();
  evidence.env.npmVersion = execFileSync(npmExecutable(), ['--version'], { encoding: 'utf8' }).trim();
  evidence.env.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  evidence.env.sourceState = 'uncommitted shared implementation; git HEAD is not a release commit';
  evidence.env.targetVersion = readFileSync(join(repo, '.dsh-version'), 'utf8').trim();
  const host = createRequire(pathToFileURL(hostLocation.anchor));
  evidence.env.sdkLayout = hostLocation.kind;
  const toolsManifest = JSON.parse(readFileSync(host.resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'));
  evidence.env.sdkVersion = toolsManifest.version;
  evidence.env.targetVerified = toolsManifest.version === evidence.env.targetVersion;
  evidence.env.targetStatus = evidence.env.targetVerified ? 'tested' : 'NOT RUN: installed SDK differs from target baseline';
  record('dsh-available', true, evidence.env);
  const first = buildEnterpriseBundle({ destination: join(dir, 'pack-v1') });
  evidence.artifact = { sha256: sha256(first.tarball), members: first.members, files: first.packed.length, version: first.manifest.version };
  npm(['install', first.tarball]);
  const installed = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'));
  record('install-v1-with-patch-and-workspace-intact', installed.version === first.manifest.version && intact());
  const closure = auditReleaseClosure(bundleDir, { allowInstalledBinLinks: true });
  record('installed-final-tarball-closure', closure.length === 0, { errors: closure, isolatedEmptyCache: true, registryUnreachable: true });
  const base = dump();
  const patched = dump(join(bundleDir, 'cordis.patch.yml'));
  const baselineRows = rows(base.stdout ?? '');
  const patchedRows = rows(patched.stdout ?? '');
  const present = officialRows.filter((id) => baselineRows.has(id));
  record('installed-patch-disables-official-rows', base.status === 0 && patched.status === 0 && present.length > 0 && present.every((id) => patchedRows.get(id) === true && baselineRows.get(id) === false), { present, absent: officialRows.filter((id) => !baselineRows.has(id)), note: 'dump proves composition only; absent rows are NOT disabled' });
  await activateInstalled('install', host);
  const bin = join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'forge-sdd.cmd' : 'forge-sdd');
  const cli = spawnSync(bin, [], { cwd: project, env: isolatedEnv, encoding: 'utf8' });
  record('installed-bin-is-executable', cli.status === 0 && /用法/u.test(cli.stdout ?? '') && (statSync(join(bundleDir, 'src', 'sdd-cli.mjs')).mode & 0o100) !== 0, { status: cli.status });
  const artifact = join(project, 'deliverable.txt');
  const manifest = join(project, 'delivery.json');
  writeFileSync(artifact, 'local CLI fixture\n');
  const freeze = spawnSync(bin, ['freeze', '--root', project, '--manifest', manifest, '--unit', 'local-fixture', '--change', 'LOCAL-37', '--revision', 'rev-1', '--tested-revision', 'rev-1', '--artifact', 'deliverable.txt'], { cwd: project, env: isolatedEnv, encoding: 'utf8' });
  const verify = spawnSync(bin, ['verify', '--root', project, '--manifest', manifest, '--revision', 'rev-1'], { cwd: project, env: isolatedEnv, encoding: 'utf8' });
  writeFileSync(artifact, 'tampered local fixture\n');
  const tampered = spawnSync(bin, ['verify', '--root', project, '--manifest', manifest, '--revision', 'rev-1'], { cwd: project, env: isolatedEnv, encoding: 'utf8' });
  record('installed-real-cli-freeze-verify-and-reject-tamper', freeze.status === 0 && verify.status === 0 && tampered.status === 1, { freeze: freeze.status, verify: verify.status, tampered: tampered.status });
  const upgraded = buildEnterpriseBundle({ destination: join(dir, 'pack-v2'), version: '0.1.1' });
  npm(['install', upgraded.tarball]);
  await activateInstalled('upgrade', host);
  record('upgrade-to-0.1.1-keeps-composition-and-workspace', JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).version === '0.1.1' && intact());
  npm(['install', first.tarball]);
  await activateInstalled('rollback', host);
  record('rollback-to-0.1.0-keeps-composition-and-workspace', JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).version === first.manifest.version && intact());
  npm(['uninstall', '@heluo/forge-enterprise']);
  record('uninstall-removes-packages-and-keeps-workspace', !existsSync(bundleDir) && !existsSync(bin) && intact());
  record('repository-working-tree-untouched', execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }) === statusAtStart, { note: 'concurrent edits in shared worktree may invalidate this snapshot' });
} catch (error) {
  record('rehearsal-exception', false, { error: error.message });
} finally {
  writeFileSync(join(dir, 'install-rehearsal.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`rehearsal: ${evidence.steps.filter((step) => step.ok).length}/${evidence.steps.length} steps ok`);
  console.log(`rehearsal: evidence ${join(dir, 'install-rehearsal.json')}`);
  if (!evidence.ok) process.exitCode = 1;
}
