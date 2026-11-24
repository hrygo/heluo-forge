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
import { join } from 'node:path';
import test from 'node:test';

import { EMPLOYEE_MANIFEST_FILE, EMPLOYEE_PACKAGE_SCHEMA as BUILT_SCHEMA, buildEmployeePackage } from '../scripts/build-employee-package.mjs';
import { parseArgs as installerArgs, resolveDshLaunch, runInit } from '../scripts/init-enterprise-plugin.mjs';
import {
  CLIENT_SECRET_PATH,
  EMPLOYEE_PACKAGE_SCHEMA as SHELL_SCHEMA,
  firstRunNeeded,
  identifyEmployeePackage,
  inspectEmployeePackage,
  INSTALLER_PATH,
  manifestDigestOf,
  writeFirstRunMarker,
} from '../services/forge-desktop/src/first-run.mjs';
import { embeddedExec } from '../services/forge-desktop/src/process.mjs';
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

test('the shell calls the installer with arguments it understands, through an exec that reaches the embedded runtime', async (t) => {
  const built = builtPackage(t);
  const inspected = inspectEmployeePackage(built.output);
  // What the shell passes as `--dsh`: an executable file, here standing in for the Electron binary.
  const home = mkdtempSync(join(tmpdir(), 'forge-contract-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const electron = join(home, 'app', 'electron');
  mkdirSync(join(home, 'app'), { recursive: true });
  writeFileSync(electron, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(electron, 0o755);
  assert.deepEqual(resolveDshLaunch(electron, 'linux'), { bin: electron, prefix: [] });
  const argv = ['--release', inspected.pluginDirectory, '--profile', 'web', '--dsh', electron, '--json'];
  const parsed = installerArgs(argv);
  assert.equal(parsed.release, inspected.pluginDirectory);
  assert.equal(parsed.profile, 'web');
  assert.equal(parsed.dsh, electron);
  assert.equal(parsed.json, true);

  // The real installer, on the real package, with an isolated home and an exec
  // that records what the shell's executor would start, then stops.
  const started = [];
  const exec = embeddedExec({
    command: electron,
    entry: '/apps/dsh/lib/bin.js',
    spawn: (command, args, options) => {
      started.push({ command, args, env: options.env });
      throw Object.assign(new Error('the test stops every command'), { code: 'ESTOP' });
    },
  });
  const outcome = await runInit({ argv, env: { HOME: home, DSH_HOME: join(home, 'dsh-home'), PATH: '/usr/bin' }, home, exec });
  // Stopped on purpose: what matters is what it tried to run first.
  assert.equal(outcome.code, 1);
  assert.ok(started.length >= 1, 'the installer ran no command');
  assert.equal(started[0].command, electron, 'only the embedded runtime is started');
  assert.deepEqual(started[0].args.slice(0, 2), ['/apps/dsh/lib/bin.js', '--profile']);
  assert.equal(started[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(started.every((call) => call.command === electron), true);
  // Nothing was written outside the isolated home.
  assert.equal(inspectEmployeePackage(built.output).ok, true);
});
