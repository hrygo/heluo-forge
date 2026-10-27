#!/usr/bin/env node
/** Offline synthetic native fixture builder; never installs or upgrades Go. */
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../tests/fixtures/native-cli/main.go', import.meta.url));
const hostOS = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform()];
const hostArch = { x64: 'amd64', arm64: 'arm64' }[arch()];
const systems = new Set(['windows', 'linux', 'darwin']);
const architectures = new Set(['amd64', 'arm64']);

export function parseBuildArgs(args) {
  const result = { os: hostOS, arch: hostArch };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!['--out', '--os', '--arch'].includes(key) || seen.has(key)
      || typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) {
      throw new Error('Usage: --out NEW_DIRECTORY [--os windows|linux|darwin] [--arch amd64|arm64]');
    }
    seen.add(key);
    result[key.slice(2)] = value;
  }
  if (!result.out || !systems.has(result.os) || !architectures.has(result.arch)) {
    throw new Error('A new output directory and a supported Go OS/architecture are required.');
  }
  result.out = resolve(result.out);
  return result;
}

export function buildNativeCli(options) {
  const { out, os, arch: architecture } = parseBuildArgs([
    '--out', options.out, '--os', options.os ?? hostOS, '--arch', options.arch ?? hostArch,
  ]);
  // Atomic exclusive directory creation refuses existing files, directories and
  // symlinks. Keep partial output on failure for inspection; never delete it.
  mkdirSync(out, { mode: 0o700 });
  const suffix = os === 'windows' ? '.exe' : '';
  const dop = join(out, `dop${suffix}`);
  const gh = join(out, `gh${suffix}`);
  const env = {
    ...process.env,
    CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off',
    GOOS: os, GOARCH: architecture,
    // Ignore ambient Go configuration, workspace and injected build flags.
    GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOEXPERIMENT: '',
  };
  const version = spawnSync('go', ['version'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (version.error || version.status !== 0 || !/\bgo1\.26(?:\.|\s)/u.test(version.stdout)) {
    throw new Error('Local Go 1.26 is required; no toolchain will be downloaded.');
  }
  const result = spawnSync('go', ['build', '-trimpath', '-buildvcs=false', '-o', dop, source], {
    cwd: dirname(source), env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // Build failures contain only local compiler diagnostics, not fixture payloads.
    throw new Error(`Offline native fixture build failed (${result.status ?? result.error?.code}).\n${result.stderr ?? ''}`);
  }
  copyFileSync(dop, gh, constants.COPYFILE_EXCL);
  const manifest = {
    provenance: 'fixture', synthetic: true, network: false,
    os, arch: architecture, go: version.stdout.trim(),
    executables: { dop: `dop${suffix}`, gh: `gh${suffix}` },
    selector: 'HELUO_CONTRACT_CASE or adjacent fixture-case.txt (at most 64 bytes)',
  };
  writeFileSync(join(out, 'fixture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...manifest, out, dop, gh };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = buildNativeCli(parseBuildArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
