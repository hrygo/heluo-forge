/**
 * First-run tests of the desktop shell: what counts as an intact employee
 * package, when the profile is initialized again, and how the installer is
 * invoked.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ShellError } from '../src/errors.mjs';
import {
  EMPLOYEE_PACKAGE_SCHEMA,
  firstRunNeeded,
  initializeProfile,
  inspectEmployeePackage,
  locateEnterpriseAssets,
  readFirstRunMarker,
  writeFirstRunMarker,
} from '../src/first-run.mjs';

const TARBALL = 'enterprise-plugin/heluo-forge-enterprise-1.2.3-corp.1.tgz';
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-desktop-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An employee package in the shape the unified build writes. */
function employeePackage(t, { beforeSums } = {}) {
  const dir = temp(t);
  const put = (relative, content) => {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  };
  put('installer/init-enterprise-plugin.mjs', 'export async function runInit() {}\n');
  put('enterprise-plugin/private-release.json', '{"schema":"heluo-private-release/1"}\n');
  put(TARBALL, 'tarball bytes');
  put('INSTALL.md', '# guide\n');
  put('employee-manifest.json', `${JSON.stringify({
    schema: EMPLOYEE_PACKAGE_SCHEMA,
    tag: 'v1.2.3',
    version: '1.2.3',
    source: { commit: 'c'.repeat(40), dirty: false },
    host: { dshVersion: '0.0.0-fixture' },
    packages: [{ role: 'enterprise', name: '@heluo/forge-enterprise', version: '1.2.3-corp.1', file: TARBALL, sha256: sha256Of('tarball bytes') }],
    configKeys: ['iam.clientId'],
    clientSecretEmbedded: false,
    discovery: { checked: false, reason: 'not-run' },
  }, null, 2)}\n`);
  const sums = join(dir, 'SHA256SUMS');
  const writeSums = (entries) => writeFileSync(sums, `${entries.map(([digest, file]) => `${digest}  ${file}`).join('\n')}\n`);
  const filesOf = (root, prefix = '') => readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesOf(path, `${prefix}${name}/`) : [[sha256Of(readFileSync(path)), `${prefix}${name}`]];
  });
  const entries = () => filesOf(dir).filter(([, file]) => file !== 'SHA256SUMS').sort((a, b) => (a[1] < b[1] ? -1 : 1));
  writeSums(entries());
  if (beforeSums !== undefined) beforeSums({ dir, put, writeSums, entries, sums });
  return dir;
}

function refused(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ShellError, `expected ShellError, got ${error?.message}`);
    assert.equal(error.code, code, error.message);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

test('an intact employee package is accepted and named by its parts', (t) => {
  const dir = employeePackage(t);
  const inspected = inspectEmployeePackage(dir);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.manifestDigest, sha256Of(readFileSync(join(dir, 'employee-manifest.json'))));
  assert.equal(inspected.installerPath, join(dir, 'installer', 'init-enterprise-plugin.mjs'));
  assert.equal(inspected.pluginDirectory, join(dir, 'enterprise-plugin'));
  assert.equal(inspected.manifest.version, '1.2.3');
});

test('anything the shell relies on that is missing, altered or unlisted refuses the package', (t) => {
  const problemOf = (options, mutate) => {
    const dir = employeePackage(t, options);
    if (mutate !== undefined) mutate(dir);
    const inspected = inspectEmployeePackage(dir);
    assert.equal(inspected.ok, false, 'the package was accepted');
    return inspected.problems.join('\n');
  };
  assert.match(problemOf({}, (dir) => rmSync(join(dir, 'installer/init-enterprise-plugin.mjs'))), /installer\/init-enterprise-plugin\.mjs is missing/);
  assert.match(problemOf({}, (dir) => rmSync(join(dir, 'SHA256SUMS'))), /SHA256SUMS is missing/);
  assert.match(problemOf({}, (dir) => rmSync(join(dir, TARBALL))), /is missing/);
  // One byte changed in the plugin the shell is about to install.
  assert.match(problemOf({}, (dir) => writeFileSync(join(dir, TARBALL), 'tarball bytes!')), /does not match its digest/);
  // The installer is not covered by the digest list.
  assert.match(problemOf({ beforeSums: ({ entries, writeSums }) => writeSums(entries().filter(([, file]) => !file.startsWith('installer/'))) }), /init-enterprise-plugin\.mjs is not covered by SHA256SUMS/);
  // A listed path that leaves the package.
  assert.match(problemOf({ beforeSums: ({ entries, writeSums }) => writeSums([...entries(), ['a'.repeat(64), '../outside']]) }), /outside the package/);
  assert.match(problemOf({ beforeSums: ({ entries, writeSums }) => writeSums([...entries(), ['a'.repeat(64), '/etc/passwd']]) }), /outside the package/);
  // A manifest that is not what the shell expects.
  assert.match(problemOf({ beforeSums: ({ put }) => put('employee-manifest.json', '{"schema":"something-else"}\n') }), /not an employee package manifest/);
  assert.match(problemOf({ beforeSums: ({ put }) => put('employee-manifest.json', '{not json') }), /not valid JSON/);
  assert.match(problemOf({ beforeSums: ({ put }) => put('employee-manifest.json', JSON.stringify({ schema: EMPLOYEE_PACKAGE_SCHEMA, packages: [] })) }), /names no enterprise plugin/);
});

test('the first intact candidate is the enterprise assets; without one there is nothing to start from', (t) => {
  const broken = employeePackage(t);
  writeFileSync(join(broken, TARBALL), 'tampered');
  const intact = employeePackage(t);
  const found = locateEnterpriseAssets({ candidates: ['', undefined, join(temp(t), 'absent'), broken, intact] });
  assert.equal(found.directory, intact);
  assert.equal(found.ok, true);
  refused(() => locateEnterpriseAssets({ candidates: [broken, join(temp(t), 'absent')] }), 'ASSETS_NOT_FOUND', /no intact employee package/);
  refused(() => locateEnterpriseAssets({ candidates: [] }), 'ASSETS_NOT_FOUND');
});

test('the profile is initialized again only when it never was, or the package changed', (t) => {
  const markerPath = join(temp(t), 'state', 'first-run.json');
  const digest = 'd'.repeat(64);
  assert.equal(firstRunNeeded({ markerPath, manifestDigest: digest, profile: 'web' }), true);
  assert.equal(readFirstRunMarker(markerPath), null);
  assert.deepEqual(writeFirstRunMarker(markerPath, { manifestDigest: digest, profile: 'web' }), { schema: 'heluo-first-run/1', manifestDigest: digest, profile: 'web' });
  assert.equal(statSync(markerPath).mode & 0o777, 0o600);
  assert.equal(firstRunNeeded({ markerPath, manifestDigest: digest, profile: 'web' }), false);
  assert.equal(firstRunNeeded({ markerPath, manifestDigest: 'e'.repeat(64), profile: 'web' }), true);
  assert.equal(firstRunNeeded({ markerPath, manifestDigest: digest, profile: 'desktop' }), true);
  writeFileSync(markerPath, '{truncated');
  assert.equal(readFirstRunMarker(markerPath), null);
  assert.equal(firstRunNeeded({ markerPath, manifestDigest: digest, profile: 'web' }), true);
});

test('the installer is handed the package, the profile and the embedded runtime, and its verdict is final', async (t) => {
  const assets = inspectEmployeePackage(employeePackage(t));
  const calls = [];
  const exec = () => {};
  const env = { PATH: '/usr/bin' };
  const runInit = async (input) => {
    calls.push(input);
    return calls.length === 1
      ? { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } }
      : { code: 1, lines: ['init: 调用 dsh 失败（/some/host/path）'], warnings: [], result: { ok: false, error: { code: 'IAM_CLIENT_SECRET_PROVISION_FAILED', message: 'init: 调用 dsh 失败（/some/host/path）' } } };
  };
  const done = await initializeProfile({ assets, runInit, env, exec, profile: 'web', dsh: '/apps/electron' });
  assert.equal(done.status, 'installed');
  assert.deepEqual(calls[0], {
    argv: ['--release', assets.pluginDirectory, '--profile', 'web', '--dsh', '/apps/electron', '--json'],
    env,
    exec,
  });
  // A failed verdict stops the first run, by the installer's code only.
  await assert.rejects(
    initializeProfile({ assets, runInit, env, exec, profile: 'web', dsh: '/apps/electron' }),
    (error) => error instanceof ShellError && error.code === 'FIRST_RUN_FAILED'
      && error.details.code === 'IAM_CLIENT_SECRET_PROVISION_FAILED'
      && error.message.includes('IAM_CLIENT_SECRET_PROVISION_FAILED')
      && !error.message.includes('/some/host/path'),
  );
  // No verdict at all is not success.
  await assert.rejects(initializeProfile({ assets, runInit: async () => undefined, env, exec, profile: 'web', dsh: '/apps/electron' }), /UNKNOWN/);
  // Without the installer or the runtime there is nothing to run.
  for (const missing of [{ runInit: undefined }, { dsh: '' }, { dsh: undefined }]) {
    await assert.rejects(
      initializeProfile({ assets, runInit, env, exec, profile: 'web', dsh: '/apps/electron', ...missing }),
      (error) => error instanceof ShellError && error.code === 'BAD_ARGUMENT',
    );
  }
});
