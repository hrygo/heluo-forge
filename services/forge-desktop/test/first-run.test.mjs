/**
 * First-run tests of the desktop shell: what counts as an intact employee
 * package, when the profile is initialized again, and how the installer is
 * invoked.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ShellError } from '../src/errors.mjs';
import {
  CLIENT_SECRET_PATH,
  EMPLOYEE_PACKAGE_SCHEMA,
  firstRunNeeded,
  identifyEmployeePackage,
  initializeProfile,
  inspectEmployeePackage,
  locateEnterpriseAssets,
  readFirstRunMarker,
  writeFirstRunMarker,
} from '../src/first-run.mjs';

const TARBALL = 'enterprise-plugin/heluo-forge-enterprise-1.2.3-corp.1.tgz';
const SECRET = CLIENT_SECRET_PATH;
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-desktop-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An employee package in the shape the unified build writes. */
function employeePackage(t, { beforeSums, secret = false } = {}) {
  const dir = temp(t);
  const put = (relative, content) => {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  };
  put('installer/init-enterprise-plugin.mjs', 'export async function runInit() {}\n');
  put('enterprise-plugin/private-release.json', '{"schema":"heluo-private-release/1"}\n');
  put(TARBALL, 'tarball bytes');
  put('INSTALL.md', '# guide\n');
  if (secret) put(SECRET, 'synthetic client secret');
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

/** Runs `fn`, requires a ShellError with `code`, and returns it. */
function refusedCode(fn, code, pattern) {
  let caught;
  assert.throws(fn, (error) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof ShellError, `expected ShellError, got ${caught}`);
  assert.equal(caught.code, code, caught.message);
  if (pattern !== undefined) assert.match(caught.message, pattern);
  return caught;
}

function refused(fn, code, pattern) {
  refusedCode(fn, code, pattern);
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

test('the first candidate that carries a manifest is the package; a broken one is reported, never swapped for another', (t) => {
  const intact = employeePackage(t);
  const found = locateEnterpriseAssets({ candidates: ['', undefined, join(temp(t), 'absent'), intact] });
  assert.equal(found.directory, intact);
  assert.equal(found.ok, true);
  assert.equal(found.manifestDigest, sha256Of(readFileSync(join(intact, 'employee-manifest.json'))));
  assert.deepEqual(identifyEmployeePackage({ candidates: [intact] }), { directory: intact, manifestDigest: found.manifestDigest });
  assert.equal(identifyEmployeePackage({ candidates: ['', join(temp(t), 'absent')] }), null);

  // The identified package is the one that is verified and installed. When it
  // is broken the shell says so: taking a later candidate instead would leave
  // the record of the first run pointing at a package other than the first.
  const broken = employeePackage(t);
  writeFileSync(join(broken, TARBALL), 'tampered');
  const problem = refusedCode(() => locateEnterpriseAssets({ candidates: [broken, intact] }), 'ASSETS_INVALID');
  assert.match(problem.message, /not intact/);
  assert.deepEqual(problem.details.problems, [`${TARBALL} does not match its digest`]);
  refusedCode(() => locateEnterpriseAssets({ candidates: [broken, join(temp(t), 'absent')] }), 'ASSETS_INVALID');
  refusedCode(() => locateEnterpriseAssets({ candidates: [join(temp(t), 'absent')] }), 'ASSETS_NOT_FOUND');
  refusedCode(() => locateEnterpriseAssets({ candidates: [] }), 'ASSETS_NOT_FOUND');
});

test('a listed path that is, or goes through, a symbolic link is refused even when its bytes match', (t) => {
  const link = (target, path, type) => {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch {
      return false;
    }
  };
  const tryLink = (t, build) => {
    const dir = employeePackage(t);
    if (!build(dir)) {
      t.skip('symbolic links cannot be created here');
      return;
    }
    const inspected = inspectEmployeePackage(dir);
    assert.equal(inspected.ok, false, 'a package with a link was accepted');
    assert.match(inspected.problems.join('\n'), /symbolic link|not a regular file/);
  };
  // A file of the package replaced by a link to an identical file outside it.
  tryLink(t, (dir) => {
    const outside = join(temp(t), 'outside.tgz');
    writeFileSync(outside, 'tarball bytes');
    rmSync(join(dir, TARBALL));
    return link(outside, join(dir, TARBALL));
  });
  // A directory of the package replaced by a link: every file under it now lives elsewhere.
  tryLink(t, (dir) => {
    const elsewhere = temp(t);
    // The same bytes the digest list expects, but outside the package.
    writeFileSync(join(elsewhere, 'init-enterprise-plugin.mjs'), 'export async function runInit() {}\n');
    rmSync(join(dir, 'installer'), { recursive: true });
    return link(elsewhere, join(dir, 'installer'), 'dir');
  });
  // The manifest itself.
  tryLink(t, (dir) => {
    const outside = join(temp(t), 'manifest.json');
    writeFileSync(outside, readFileSync(join(dir, 'employee-manifest.json')));
    rmSync(join(dir, 'employee-manifest.json'));
    return link(outside, join(dir, 'employee-manifest.json'));
  });

  // Reaching the package through a link is ordinary (a symlinked parent directory); what matters is what is inside.
  const real = employeePackage(t);
  const alias = join(temp(t), 'alias');
  if (link(real, alias, 'dir')) {
    assert.equal(inspectEmployeePackage(alias).ok, true);
  }
});

test('the client secret may be gone, because the installer removes it; anything else about it is refused', (t) => {
  const withSecret = () => employeePackage(t, { secret: true });
  assert.equal(inspectEmployeePackage(withSecret()).ok, true);
  const consumed = withSecret();
  rmSync(join(consumed, SECRET));
  assert.equal(inspectEmployeePackage(consumed).ok, true, 'a consumed secret file is not a broken package');
  const altered = withSecret();
  writeFileSync(join(altered, SECRET), 'another secret');
  assert.match(inspectEmployeePackage(altered).problems.join('\n'), /iam-client-secret\.txt does not match its digest/);
  const linked = withSecret();
  const outside = join(temp(t), 'secret');
  writeFileSync(outside, 'synthetic client secret');
  rmSync(join(linked, SECRET));
  try {
    symlinkSync(outside, join(linked, SECRET));
    assert.match(inspectEmployeePackage(linked).problems.join('\n'), /iam-client-secret\.txt is missing, or reached through a symbolic link/);
  } catch {
    t.skip('symbolic links cannot be created here');
  }
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
  // A success returns the installer's whole outcome: the conclusion, and what it printed.
  assert.deepEqual(done, { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } });
  // The shell's dsh carries its own pnpm, so the installer is told not to look for one.
  assert.deepEqual(calls[0], {
    argv: ['--release', assets.pluginDirectory, '--profile', 'web', '--dsh', '/apps/electron', '--pnpm-from-host', '--json'],
    env,
    exec,
  });
  // A failed verdict stops the first run, by the installer's code only; its text travels in the details,
  // for the status page and the log to say which cause stopped the run.
  const lines = ['企业插件初始化', 'profile：web'];
  const warnings = ['warn: 一条警告'];
  const stopped = await initializeProfile({
    assets,
    runInit: async () => ({ code: 1, lines, warnings, result: { ok: false, error: { code: 'IAM_CLIENT_SECRET_PROVISION_FAILED', message: 'init: 调用 dsh 失败（/some/host/path）', next: '修复凭据存储后重跑。' } } }),
    env,
    exec,
    profile: 'web',
    dsh: '/apps/electron',
  }).catch((error) => error);
  assert.ok(stopped instanceof ShellError);
  assert.deepEqual(stopped.details, { code: 'IAM_CLIENT_SECRET_PROVISION_FAILED', reason: 'init: 调用 dsh 失败（/some/host/path）', next: '修复凭据存储后重跑。', lines, warnings });
  assert.equal(stopped.message.includes('/some/host/path'), false, 'the message itself still repeats only the code');
  // No verdict at all is not success, and nothing is invented in its place.
  const blank = await initializeProfile({ assets, runInit: async () => undefined, env, exec, profile: 'web', dsh: '/apps/electron' }).catch((error) => error);
  assert.ok(blank instanceof ShellError && blank.code === 'FIRST_RUN_FAILED');
  assert.match(blank.message, /UNKNOWN/);
  assert.deepEqual(blank.details, { code: 'UNKNOWN', reason: '', next: '', lines: [], warnings: [] });
  // Without the installer or the runtime there is nothing to run.
  for (const missing of [{ runInit: undefined }, { dsh: '' }, { dsh: undefined }]) {
    await assert.rejects(
      initializeProfile({ assets, runInit, env, exec, profile: 'web', dsh: '/apps/electron', ...missing }),
      (error) => error instanceof ShellError && error.code === 'BAD_ARGUMENT',
    );
  }
});
