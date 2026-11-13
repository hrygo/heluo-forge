#!/usr/bin/env node
/**
 * macOS private-release maker CLI (issue #222 item ④).
 *
 * Usage:
 *   node scripts/make-private-bundle.mjs \
 *     --public <downloaded-public.tgz> --public-sha256 <trusted-digest> \
 *     --config <enterprise.env> --version <semver> --output <empty-dir> \
 *     [--repo-root <dir>] [--confirm <digest-prefix>]
 *
 * The release engineer runs this from a place where the public artifact was
 * downloaded, not necessarily this checkout. `--config` must be mode 0600;
 * when placed in a repository, use a git-ignored file such as `.env`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import {
  buildConfig,
  inspectPublicTarball,
  isLoginConfigured,
  makePrivateBundle,
  parseEnvConfig,
  planDigest,
  PrivateBundleError,
  readConfigFile,
  SUPPORTED_PLATFORMS,
  verifyDiscovery,
} from './lib/private-bundle.mjs';
import { assertOutsideDirectory } from './lib/release-support.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = { repoRoot: repo, confirm: undefined, json: false, skipDiscoveryCheck: false };
  const valued = new Map([
    ['--public', 'publicPath'],
    ['--public-sha256', 'publicSha256'],
    ['--config', 'configPath'],
    ['--version', 'version'],
    ['--output', 'output'],
    ['--repo-root', 'repoRoot'],
    ['--confirm', 'confirm'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--skip-discovery-check') {
      options.skipDiscoveryCheck = true;
      continue;
    }
    const field = valued.get(argument);
    if (field === undefined) throw new PrivateBundleError('ARGS_INVALID', `unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new PrivateBundleError('ARGS_INVALID', `${argument} needs a value`);
    options[field] = value;
    index += 1;
  }
  for (const [flag, field] of [['--public', 'publicPath'], ['--public-sha256', 'publicSha256'], ['--config', 'configPath'], ['--version', 'version'], ['--output', 'output']]) {
    if (typeof options[field] !== 'string' || options[field] === '') throw new PrivateBundleError('ARGS_INVALID', `${flag} is required`);
  }
  return options;
}

async function confirmDigest(digest, provided) {
  if (provided !== undefined) {
    if (provided === digest || (provided.length >= 8 && digest.startsWith(provided))) return;
    throw new PrivateBundleError('CONFIRM_MISMATCH', `--confirm ${provided} does not match the plan digest ${digest}; nothing was written`);
  }
  if (!process.stdin.isTTY) {
    throw new PrivateBundleError('CONFIRM_REQUIRED', `confirmation required: rerun with --confirm ${digest.slice(0, 16)} after reviewing the redacted plan`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`Plan digest ${digest}\nType the first 8 characters to continue: `);
    if (answer.trim() !== digest.slice(0, 8)) throw new PrivateBundleError('CONFIRM_MISMATCH', 'confirmation did not match; nothing was written');
  } finally {
    terminal.close();
  }
}

/** Boundary refusals carry the same error codes the library and the skill document use. */
function assertOutside(target, forbidden, code, label) {
  try {
    assertOutsideDirectory(target, forbidden, label);
  } catch {
    throw new PrivateBundleError(code, `${label} "${target}" must be outside ${forbidden}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(options.repoRoot);
  const publicPath = resolve(options.publicPath);
  const configPath = resolve(options.configPath);
  const output = resolve(options.output);
  // The output boundary is a path-component, symlink-resolved question, not a
  // string-prefix question: the CLI must not be the one place where a `..secret`
  // sibling or a symlink back into the checkout slips through (issue #254 item
  // 14). The configuration file is deliberately NOT held to the same rule: the
  // documented workflow keeps it in a git-ignored `.env` beside the checkout, and
  // it is never copied into the artifact.
  assertOutside(output, repoRoot, 'OUTPUT_INSIDE_REPO', 'output directory');

  const publicInfo = inspectPublicTarball(publicPath);
  if (publicInfo.problems.length > 0) {
    throw new PrivateBundleError('PUBLIC_UNSAFE', `public input failed preflight:\n- ${publicInfo.problems.join('\n- ')}`);
  }
  const entries = parseEnvConfig(readConfigFile(configPath));
  const config = buildConfig(entries);
  const discovery = options.skipDiscoveryCheck
    ? { checked: false, reason: 'skipped by --skip-discovery-check' }
    : await verifyDiscovery(config.iam);
  // "Verified" and "not verified because the packager skipped it" must never
  // look alike in the output an audit reads back (review F4). `required` records
  // the policy; `skipped` records the deviation from it, with its reason.
  const discoveryState = {
    required: true,
    checked: discovery.checked === true,
    skipped: options.skipDiscoveryCheck,
    reason: options.skipDiscoveryCheck
      ? 'skipped by --skip-discovery-check'
      : (discovery.checked === true ? null : (discovery.reason ?? 'not-checked')),
  };
  const digest = planDigest({ publicSha256: options.publicSha256, version: options.version, config, platforms: SUPPORTED_PLATFORMS });
  const redacted = {
    public: { path: publicPath, sha256: options.publicSha256, version: publicInfo.version, name: publicInfo.name, files: publicInfo.files },
    version: options.version,
    output,
    configKeys: config.keys,
    configValues: 'redacted',
    loginReady: isLoginConfigured(config.iam),
    discovery,
    discoveryCheck: discoveryState,
    platforms: SUPPORTED_PLATFORMS,
    planDigest: digest,
  };
  if (!options.json) {
    console.error(JSON.stringify(redacted, null, 2));
    // One human-readable line, because the JSON block above is easy to skim
    // past: a packager reading the terminal must see whether discovery ran.
    console.error(`discovery: ${discoveryState.skipped
      ? `skipped (${discoveryState.reason})`
      : discoveryState.checked ? 'verified' : `not verified (${discoveryState.reason})`}`);
  }
  await confirmDigest(digest, options.confirm);

  const result = makePrivateBundle({
    publicPath,
    expectedSha256: options.publicSha256,
    configPath,
    version: options.version,
    output,
    repoRoot,
  });
  console.log(
    JSON.stringify(
      {
        output: result.output,
        tarball: result.tarball,
        sha256: result.sha256,
        version: result.version,
        base: result.base,
        changed: result.changed,
        configKeys: result.configKeys,
        manifest: result.manifest,
        release: result.release,
        verified: result.verified,
        discovery: discoveryState,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof PrivateBundleError ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

export { parseArguments, confirmDigest };
