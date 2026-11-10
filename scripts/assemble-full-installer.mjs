#!/usr/bin/env node
/**
 * Assemble a full installer directory (issue #222 item ⑤).
 *
 * Usage:
 *   node scripts/assemble-full-installer.mjs \
 *     --inputs <installer-inputs.json> --private <private.tgz> \
 *     --private-sha256 <trusted-digest> --output <empty-dir> \
 *     [--platforms windows-x64,macos-arm64] [--web-port 58260] \
 *     [--repo-root <dir>] [--confirm <digest-prefix>]
 *
 * The inputs file names official host archives per platform plus their declared
 * digests; this tool verifies the bytes before assembling. It never downloads,
 * never signs, and never contains a secret.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { assembleFullInstaller, readInstallerInputs, readPrivateRelease } from './lib/full-installer.mjs';
import { PrivateBundleError } from './lib/private-bundle.mjs';
import { assertOutsideDirectory, sha256 } from './lib/release-support.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = { repoRoot: repo, confirm: undefined, json: false, platforms: undefined, webPort: undefined };
  const valued = new Map([
    ['--inputs', 'inputsPath'],
    ['--private', 'privatePath'],
    ['--private-sha256', 'privateSha256'],
    ['--output', 'output'],
    ['--platforms', 'platforms'],
    ['--web-port', 'webPort'],
    ['--repo-root', 'repoRoot'],
    ['--confirm', 'confirm'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const field = valued.get(argument);
    if (field === undefined) throw new PrivateBundleError('ARGS_INVALID', `unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new PrivateBundleError('ARGS_INVALID', `${argument} needs a value`);
    options[field] = value;
    index += 1;
  }
  for (const [flag, field] of [['--inputs', 'inputsPath'], ['--private', 'privatePath'], ['--private-sha256', 'privateSha256'], ['--output', 'output']]) {
    if (typeof options[field] !== 'string' || options[field] === '') throw new PrivateBundleError('ARGS_INVALID', `${flag} is required`);
  }
  const platforms = options.platforms === undefined ? undefined : options.platforms.split(',').map((id) => id.trim()).filter(Boolean);
  const webPort = options.webPort === undefined ? undefined : Number(options.webPort);
  return { ...options, platforms, webPort };
}

async function confirm(provided, digest) {
  if (provided !== undefined) {
    if (provided === digest || (provided.length >= 8 && digest.startsWith(provided))) return;
    throw new PrivateBundleError('CONFIRM_MISMATCH', `--confirm ${provided} does not match the plan digest ${digest}; nothing was written`);
  }
  if (!process.stdin.isTTY) throw new PrivateBundleError('CONFIRM_REQUIRED', `confirmation required: rerun with --confirm ${digest.slice(0, 16)} after reviewing the plan`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`Plan digest ${digest}\nType the first 8 characters to continue: `);
    if (answer.trim() !== digest.slice(0, 8)) throw new PrivateBundleError('CONFIRM_MISMATCH', 'confirmation did not match; nothing was written');
  } finally {
    terminal.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(options.repoRoot);
  const inputsPath = resolve(options.inputsPath);
  const privatePath = resolve(options.privatePath);
  const output = resolve(options.output);
  assertOutsideDirectory(output, repoRoot, 'installer output');

  const inputs = readInstallerInputs(inputsPath);
  const privateRelease = readPrivateRelease(privatePath);
  const digest = sha256(
    Buffer.from(
      JSON.stringify({
        inputsSha256: sha256(readFileSync(inputsPath)),
        privateSha256: options.privateSha256,
        platforms: options.platforms ?? Object.keys(inputs.platforms).sort(),
        webPort: options.webPort ?? inputs.webPort,
      }),
      'utf8',
    ),
  );
  const redacted = {
    inputs: { path: inputsPath, host: inputs.host, platforms: Object.keys(inputs.platforms).sort() },
    private: { path: privatePath, version: privateRelease.manifest.version, sha256: privateRelease.sha256, configKeys: privateRelease.metadata.config?.keys ?? [] },
    output,
    planDigest: digest,
  };
  if (!options.json) console.error(JSON.stringify(redacted, null, 2));
  if (privateRelease.sha256 !== options.privateSha256) {
    throw new PrivateBundleError('PRIVATE_DIGEST_MISMATCH', `private tarball digest ${privateRelease.sha256} does not match ${options.privateSha256}`);
  }
  await confirm(options.confirm, digest);

  const result = assembleFullInstaller({
    inputsPath,
    privatePath,
    expectedPrivateSha256: options.privateSha256,
    output,
    repoRoot,
    platforms: options.platforms,
    webPort: options.webPort,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof PrivateBundleError ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

export { parseArguments };
