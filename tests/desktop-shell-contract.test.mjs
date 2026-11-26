/**
 * Contract between the unified build and the desktop shell.
 *
 * The two are tested separately against their own fixtures. These cases make
 * them meet: the shell must accept the package the build really produces, call
 * the installer the package really ships with arguments that installer really
 * understands, and reach the embedded runtime through the executor the shell
 * really provides.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { EMPLOYEE_MANIFEST_FILE, EMPLOYEE_PACKAGE_SCHEMA as BUILT_SCHEMA, buildEmployeePackage } from '../scripts/build-employee-package.mjs';
import { CAPABILITIES, ENTRY_PACKAGE, parseArgs as installerArgs, isSupportedProfileName, provisionClientSecret, readPrivateRelease, resolveDshLaunch, runInit } from '../scripts/init-enterprise-plugin.mjs';
import { EMBEDDED_ENTRY } from '../services/forge-desktop/src/embedded-cli.mjs';
import {
  CLIENT_SECRET_PATH,
  EMPLOYEE_PACKAGE_SCHEMA as SHELL_SCHEMA,
  firstRunNeeded,
  identifyEmployeePackage,
  initializeProfile,
  inspectEmployeePackage,
  INSTALLER_PATH,
  manifestDigestOf,
  writeFirstRunMarker,
} from '../services/forge-desktop/src/first-run.mjs';
import { embeddedExec, embeddedScriptExec } from '../services/forge-desktop/src/process.mjs';
import { fakePublicBuilder, sha256Of, sourceRepo, temp, TOOL_ROOT, VALUES } from './support/employee-package-fixture.mjs';

const TAG = 'v1.2.3';

/** An employee package exactly as the unified build writes it. */
function builtPackage(t, { withEngineering = false } = {}) {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-contract-out-');
  return buildEmployeePackage({
    repoRoot: root,
    tag: TAG,
    output: join(out, 'heluo-forge-employee-1.2.3-assets'),
    env: VALUES,
    withEngineering,
    buildPublicReleaseImpl: fakePublicBuilder({ commit }),
  });
}

/**
 * The profile the shell names in `main.mjs`: the profile it installs into on
 * its first run and then starts. The entry needs Electron and is not run here,
 * so its one constant is read from the source.
 */
function shellProfile() {
  const main = readFileSync(join(TOOL_ROOT, 'services', 'forge-desktop', 'src', 'main.mjs'), 'utf8');
  const declared = /^const PROFILE = '([^']+)';$/mu.exec(main);
  assert.notEqual(declared, null, 'main.mjs names the profile it owns');
  return declared[1];
}

test('the shell and the build name the package and its installer the same way', () => {
  assert.equal(SHELL_SCHEMA, BUILT_SCHEMA);
  assert.equal(INSTALLER_PATH, 'installer/init-enterprise-plugin.mjs');
  // The shell loads `runInit` from the script inside the package at run time.
  assert.equal(typeof runInit, 'function');
});

test('the shell accepts what the build produces, and no longer needs it once the first run is done', (t) => {
  for (const withEngineering of [false, true]) {
    const built = builtPackage(t, { withEngineering });
    const inspected = inspectEmployeePackage(built.output);
    assert.equal(inspected.ok, true, inspected.problems?.join('\n'));
    assert.equal(inspected.manifestDigest, sha256Of(readFileSync(join(built.output, EMPLOYEE_MANIFEST_FILE))));
    assert.equal(inspected.manifestDigest, manifestDigestOf(built.output));
    // The installer the shell will run is the repository's, byte for byte.
    assert.equal(inspected.installerPath, join(built.output, INSTALLER_PATH));
    assert.deepEqual(readFileSync(inspected.installerPath), readFileSync(join(TOOL_ROOT, 'scripts', 'init-enterprise-plugin.mjs')));
    assert.equal(inspected.pluginDirectory, join(built.output, 'enterprise-plugin'));

    // The secret file sits where the shell expects it, by the name the build gives it.
    assert.equal(existsSync(join(built.output, CLIENT_SECRET_PATH)), true);

    // The installer removes the client secret file once the secret is in the
    // credential store, and treats its absence as done. The shell lets that
    // one listed file go for the same reason: a first run that completed but
    // was not recorded can then be run again, instead of blocking every start.
    const markerPath = join(temp(t, 'forge-contract-state-'), 'first-run.json');
    rmSync(join(built.output, CLIENT_SECRET_PATH));
    assert.equal(inspectEmployeePackage(built.output).ok, true);
    assert.equal(manifestDigestOf(built.output), inspected.manifestDigest);
    // What the shell identifies as the package is what it just verified.
    assert.deepEqual(identifyEmployeePackage({ candidates: [built.output] }), { directory: built.output, manifestDigest: inspected.manifestDigest });
    assert.equal(firstRunNeeded({ markerPath, manifestDigest: manifestDigestOf(built.output), profile: 'web' }), true);
    writeFirstRunMarker(markerPath, { manifestDigest: inspected.manifestDigest, profile: 'web' });
    assert.equal(firstRunNeeded({ markerPath, manifestDigest: manifestDigestOf(built.output), profile: 'web' }), false);

    // A link where a file of the package should be is refused, even one that
    // leads to the very same bytes.
    const kept = join(temp(t, 'forge-contract-kept-'), 'kept.mjs');
    writeFileSync(kept, readFileSync(inspected.installerPath));
    rmSync(inspected.installerPath);
    try {
      symlinkSync(kept, inspected.installerPath);
      assert.equal(inspectEmployeePackage(built.output).ok, false);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
  }
});

/** An executable file standing in for the Electron binary the shell names as `--dsh`. */
function electronStandIn(t, prefix = 'forge-contract-home-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const electron = join(home, 'app', 'electron');
  mkdirSync(join(home, 'app'), { recursive: true });
  writeFileSync(electron, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(electron, 0o755);
  return { home, electron };
}

test('the shell calls the installer with arguments it understands, through an exec that reaches the embedded runtime', async (t) => {
  const built = builtPackage(t);
  const inspected = inspectEmployeePackage(built.output);
  // What the shell passes as `--dsh`: an executable file, here standing in for the Electron binary.
  const { home, electron } = electronStandIn(t);
  assert.deepEqual(resolveDshLaunch(electron, 'linux'), { bin: electron, prefix: [] });
  // The profile is the one the shell really names: a name of its own, which the
  // installer accepts and, finding no such profile, creates from the web template.
  const profile = shellProfile();
  assert.equal(isSupportedProfileName(profile), true, `the installer must accept the profile the shell names ("${profile}")`);

  // The real installer, on the real package, with an isolated home and the
  // shell's real executor, which records what it would start, then stops.
  const started = [];
  const exec = embeddedExec({
    command: electron,
    entry: EMBEDDED_ENTRY,
    spawn: (command, args, options) => {
      started.push({ command, args, env: options.env });
      throw Object.assign(new Error('the test stops every command'), { code: 'ESTOP' });
    },
  });
  // The arguments are the shell's own, not a copy of them: its first-run
  // initializer runs against the real installer behind a recorder, and what it
  // handed over is what gets checked.
  const env = { HOME: home, DSH_HOME: join(home, 'dsh-home'), PATH: '/usr/bin' };
  let handed;
  let outcome;
  await initializeProfile({
    assets: { pluginDirectory: inspected.pluginDirectory },
    installer: { runInit: async (input) => {
      handed = input;
      outcome = await runInit({ ...input, home });
      return outcome;
    }, CAPABILITIES },
    env,
    exec,
    profile,
    dsh: electron,
  }).catch(() => undefined);
  const parsed = installerArgs(handed.argv);
  assert.equal(parsed.release, inspected.pluginDirectory);
  assert.equal(parsed.profile, profile);
  assert.equal(parsed.dsh, electron);
  // The shell's dsh carries its own pnpm, so it tells the installer not to look for one.
  assert.equal(parsed.pnpmFromHost, true);
  // The shell owns its profile, so it lets the installer clear that profile's
  // `node_modules` when pnpm refuses it for coming from another store.
  assert.equal(parsed.reinstallOnStoreMismatch, true);
  assert.equal(parsed.json, true);
  assert.equal(handed.env, env);
  assert.equal(handed.exec, exec);

  // Stopped on purpose: what matters is what it tried to run first.
  assert.equal(outcome.code, 1);
  assert.ok(started.length >= 1, 'the installer ran no command');
  assert.equal(started[0].command, electron, 'only the embedded runtime is started');
  // The profile is absent in the isolated home, so the first command creates it
  // from the web template. The shell's entry comes first: it is what hands dsh
  // the bundled pnpm.
  assert.deepEqual(started[0].args, [EMBEDDED_ENTRY, '--profile', profile, '--from-default-profile', 'web', '--dump-config']);
  assert.equal(started[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(started.every((call) => call.command === electron), true);
  assert.notEqual(outcome.result?.error?.code, 'PNPM_REQUIRED', 'the installer did not stop for a pnpm it was not asked to find');
  // Nothing was written outside the isolated home.
  assert.equal(inspectEmployeePackage(built.output).ok, true);
});

/** What pnpm prints when it refuses a `node_modules` that another pnpm linked from another store. */
const STORE_MISMATCH = [
  'Error: ERR_PNPM_UNEXPECTED_STORE',
  '  ╰─▶ Unexpected store location',
  '  help: The dependencies are currently linked from another store. If you want to use the new store location, reinstall your dependencies with "pnpm install".',
].join('\n');

test("the shell's first run gets past a profile that another pnpm linked: it has told the installer it owns the profile", async (t) => {
  const built = builtPackage(t);
  const inspected = inspectEmployeePackage(built.output);
  // No IAM in this test: without the secret file the installer skips provisioning,
  // the way it does on a second run after a successful one.
  rmSync(join(built.output, CLIENT_SECRET_PATH));
  const { home, electron } = electronStandIn(t, 'forge-contract-foreign-');
  const dshHome = join(home, 'dsh-home');
  const profile = shellProfile();
  // The shell's profile as another pnpm left it: that pnpm's record, and another plugin.
  const profileDir = join(dshHome, 'profiles', profile);
  const modules = join(profileDir, 'node_modules');
  const manifestPath = join(profileDir, 'package.json');
  mkdirSync(modules, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(modules, '.modules.yaml'), JSON.stringify({ storeDir: join(home, 'another-store', 'v10') }));
  mkdirSync(join(modules, 'other-plugin'), { recursive: true });
  const installed = join(modules, ...ENTRY_PACKAGE.split('/'));
  // A host that refuses every package operation while that record is there, and installs otherwise.
  const commands = [];
  const exec = async (bin, args) => {
    assert.equal(bin, electron);
    commands.push(args.join(' '));
    if (args[0] !== 'plugin') return { code: 0, stdout: JSON.stringify({ plugins: [{ name: ENTRY_PACKAGE }] }), stderr: '' };
    if (existsSync(join(modules, '.modules.yaml'))) return { code: 1, stdout: '', stderr: STORE_MISMATCH };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, [ENTRY_PACKAGE]: `file:${args[4]}` };
    manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, ENTRY_PACKAGE];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version: readPrivateRelease(inspected.pluginDirectory).version }));
    return { code: 0, stdout: 'added', stderr: '' };
  };

  const outcome = await initializeProfile({
    assets: { pluginDirectory: inspected.pluginDirectory },
    installer: { runInit: (input) => runInit({ ...input, home }), CAPABILITIES },
    env: { HOME: home, DSH_HOME: dshHome, PATH: '/usr/bin' },
    exec,
    profile,
    dsh: electron,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  // The same command twice: refused, then let through once the directory was cleared.
  const adds = commands.filter((command) => command.startsWith('plugin'));
  assert.equal(adds.length, 2);
  assert.equal(existsSync(join(modules, '.modules.yaml')), false, "the other pnpm's record is gone");
  assert.equal(existsSync(join(modules, 'other-plugin')), false, 'what that pnpm left was cleared with it');
  assert.equal(existsSync(join(installed, 'package.json')), true, 'the enterprise plugin is installed');
  assert.ok(outcome.warnings.some((line) => line.includes('--reinstall-on-store-mismatch')), 'the conclusion says the directory was cleared');
});

test('every capability the installer lists is an argument it really parses', () => {
  // The shell passes only what the list names; a list naming an argument the
  // parser refuses would turn a capability into a BAD_ARGUMENT at first run.
  const base = ['--release', '/release', '--profile', 'web', '--dsh', '/apps/electron'];
  const forms = {
    'pnpm-from-host': [...base, '--pnpm-from-host'],
    'reinstall-on-store-mismatch': [...base, '--reinstall-on-store-mismatch'],
    'pnpm-store': [...base, '--pnpm-store', '/store/v10'],
  };
  assert.deepEqual([...CAPABILITIES], Object.keys(forms), 'the capabilities the shell may probe are all covered here');
  for (const [capability, argv] of Object.entries(forms)) {
    const parsed = installerArgs(argv);
    assert.ok(parsed !== undefined, `${capability} parses`);
  }
  // The valued capability is validated like every other valued argument.
  assert.throws(() => installerArgs([...base, '--pnpm-store', 'relative/store']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => installerArgs([...base, '--pnpm-store']), (error) => error.code === 'BAD_ARGUMENT' && /需要一个值/u.test(error.message));
});

test('a store the shell has named is compared before any package operation: the mismatch is healed up front, not reacted to', async (t) => {
  const built = builtPackage(t);
  const inspected = inspectEmployeePackage(built.output);
  rmSync(join(built.output, CLIENT_SECRET_PATH));
  const { home, electron } = electronStandIn(t, 'forge-contract-preflight-');
  const dshHome = join(home, 'dsh-home');
  const profile = shellProfile();
  const profileDir = join(dshHome, 'profiles', profile);
  const modules = join(profileDir, 'node_modules');
  const manifestPath = join(profileDir, 'package.json');
  // The same foreign profile as the reactive case: another pnpm's record and another plugin.
  mkdirSync(modules, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(modules, '.modules.yaml'), JSON.stringify({ storeDir: join(home, 'another-store', 'v10') }));
  mkdirSync(join(modules, 'other-plugin'), { recursive: true });
  const installed = join(modules, ...ENTRY_PACKAGE.split('/'));
  // A host that would refuse a package operation while the record is there: with the
  // pre-check it never gets the chance, and the test can see that in the commands.
  const commands = [];
  const exec = async (bin, args) => {
    assert.equal(bin, electron);
    commands.push(args.join(' '));
    if (args[0] !== 'plugin') return { code: 0, stdout: JSON.stringify({ plugins: [{ name: ENTRY_PACKAGE }] }), stderr: '' };
    assert.equal(existsSync(join(modules, '.modules.yaml')), false, 'a package operation ran before the mismatch was healed');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, [ENTRY_PACKAGE]: `file:${args[4]}` };
    manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, ENTRY_PACKAGE];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version: readPrivateRelease(inspected.pluginDirectory).version }));
    return { code: 0, stdout: 'added', stderr: '' };
  };

  const outcome = await initializeProfile({
    assets: { pluginDirectory: inspected.pluginDirectory },
    installer: { runInit: (input) => runInit({ ...input, home }), CAPABILITIES },
    env: { HOME: home, DSH_HOME: dshHome, PATH: '/usr/bin' },
    exec,
    profile,
    dsh: electron,
    // What the shell's probe would have named: a store other than the one the profile records.
    pnpmStore: join(home, 'host-store', 'v10'),
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  // Not one package operation met the foreign record: the healing happened before the first.
  const adds = commands.filter((command) => command.startsWith('plugin'));
  assert.equal(adds.length, 1, 'a single, already-healthy install command');
  assert.match(adds[0], /^plugin --profile heluo-desktop add /u, adds[0]);
  assert.equal(existsSync(join(modules, '.modules.yaml')), false, 'the other pnpm record is gone');
  assert.equal(existsSync(join(modules, 'other-plugin')), false, 'what that pnpm left was cleared with it');
  assert.equal(existsSync(join(installed, 'package.json')), true, 'the enterprise plugin is installed');
  // The conclusion says the pre-check did the healing, so the log reads as what it was.
  assert.ok(outcome.lines.some((line) => line.startsWith('store 预检：profile「heluo-desktop」的 node_modules 由另一个 pnpm store 装入')), outcome.lines.join('\n'));
  assert.ok(outcome.lines.includes(`store 预检：先清空 profiles/${profile}/node_modules（--reinstall-on-store-mismatch）`), outcome.lines.join('\n'));
  assert.ok(outcome.warnings.some((line) => line.startsWith(`warn: store 预检发现不一致，已按 --reinstall-on-store-mismatch 先行清空 profiles/${profile}/node_modules`)), outcome.warnings.join('\n'));
});

test('the provisioning command the shell hands the plugin CLI is that CLI itself, not a dsh command line', async (t) => {
  const built = builtPackage(t);
  const inspected = inspectEmployeePackage(built.output);
  const release = readPrivateRelease(inspected.pluginDirectory);
  assert.notEqual(release.secret, null, 'the package the build produces carries an embedded secret');
  const secretPath = release.secret.path;
  const secretBytes = release.secret.bytes;

  const home = mkdtempSync(join(tmpdir(), 'forge-contract-secret-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profileDir = join(home, 'profiles', 'web');
  const cli = join(profileDir, 'node_modules', '@heluo', 'forge-enterprise', 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  // A stand-in of the plugin's own CLI: it writes down what reached it, on its command line and on stdin.
  const witnessed = join(home, 'witness.json');
  process.env.FORGE_WITNESS = witnessed;
  t.after(() => { delete process.env.FORGE_WITNESS; });
  writeFileSync(cli, "import { appendFileSync } from 'node:fs';\nlet stdin = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => { stdin += chunk; });\nprocess.stdin.on('end', () => { appendFileSync(process.env.FORGE_WITNESS, JSON.stringify({ argv: process.argv.slice(1), stdin }) + '\\n'); });\n");

  const status = await provisionClientSecret({
    scriptExec: embeddedScriptExec({ command: process.execPath, profileDir, env: {} }),
    profile: { dir: profileDir },
    release,
    lines: [],
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'http://127.0.0.1:18931', token_endpoint_auth_methods_supported: ['client_secret_post'] }) }),
    storeDirectory: join(home, 'store'),
  });

  assert.equal(status.status, 'provisioned');
  assert.equal(existsSync(secretPath), false, 'provisioned: the plaintext secret file is removed');
  const witness = JSON.parse(readFileSync(witnessed, 'utf8'));
  // The plugin's CLI saw itself first: no dsh entry, no profile name in front of it.
  assert.equal(witness.argv[0], cli);
  assert.deepEqual(witness.argv.slice(1, 3), ['client-secret', 'set']);
  assert.equal(witness.argv.includes(EMBEDDED_ENTRY), false, 'the dsh entry must not reach the plugin CLI');
  assert.equal(witness.argv[witness.argv.indexOf('--issuer') + 1], 'http://127.0.0.1:18931');
  assert.equal(witness.argv[witness.argv.indexOf('--ref') + 1], release.secret.binding.clientSecretRef);
  // The secret reached the CLI as it was shipped, on stdin, byte for byte.
  assert.equal(witness.stdin, secretBytes.toString());
});
