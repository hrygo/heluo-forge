/**
 * Issue #254 items 7, 10, 14 and 15.
 *
 * Three properties the private maker must keep, each with the case that used to
 * pass silently:
 *
 *  - item 7: the config it writes is the config the target plugins accept. The
 *    alignment is asserted against the real validators, not against a copy of
 *    their rules, so drift shows up as a red test instead of a bundle that
 *    installs and then fails to load a capability.
 *  - item 14: "outside the checkout" is a path-component question, not a string
 *    prefix question, and it is answered on resolved symlinks so a link back
 *    into the checkout cannot launder an in-repo output path.
 *  - item 15: the direct maker entry must not report success for an artifact the
 *    existing closure verifier already rejects.
 *
 * Item 10 is asserted here too, at the entry-point boundary: the preview a
 * packager pastes into a ticket must carry keys and verdicts, never the
 * enterprise issuer or endpoint values.
 *
 * Review findings F1 and F4 (same two files) are covered at the end: the
 * artifact gate must refuse private key material by content and by name across
 * every extension, and the structured output must say whether the discovery
 * check ran instead of leaving "verified" and "skipped" indistinguishable.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../packages/forge-iam/src/config.mjs';
import { validateGiteeConfig } from '../packages/forge-gitee/src/runtime-config.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import {
  buildConfig,
  inspectPublicTarball,
  makePrivateBundle,
  parseEnvConfig,
  PrivateBundleError,
} from '../scripts/lib/private-bundle.mjs';
import { assertOutsideDirectory, scanReleaseFiles } from '../scripts/lib/release-support.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(repo, 'scripts', 'make-private-bundle.mjs');
const PUBLIC_VERSION = '0.1.0';
const ENTRY = '@heluo/forge-enterprise';

const ENV = [
  'HELUO_IAM_ISSUER=https://iam.corp.example',
  'HELUO_IAM_CLIENT_ID=forge-console',
  'HELUO_IAM_AUTHORIZATION_ENDPOINT=https://iam.corp.example/authorize',
  'HELUO_IAM_TOKEN_ENDPOINT=https://iam.corp.example/token',
  'HELUO_IAM_JWKS_URI=https://iam.corp.example/jwks',
  'HELUO_IAM_SCOPES=openid profile',
  'HELUO_IAM_CALLBACK_PORT=53682',
  'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
  'HELUO_GITEE_HOST=gitee.corp.example',
  'HELUO_GITEE_TIMEOUT_MS=15000',
];

function temp(t, prefix = 'forge-private-boundary-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** ENV with the named keys replaced, so a refusal case changes exactly one value. */
function envWith(...overrides) {
  const replaced = new Set(overrides.map((line) => line.slice(0, line.indexOf('='))));
  return [...ENV.filter((line) => !replaced.has(line.slice(0, line.indexOf('=')))), ...overrides];
}

function patchText() {
  return [
    '# fixture composition',
    '- insert:',
    '    - id: heluo-credentials-keychain',
    "      name: '@heluo/forge-credentials-keychain'",
    '    - id: heluo-iam',
    "      name: '@heluo/forge-iam'",
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    '      config: {}',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n');
}

function publicTarball({ extraFiles = [] } = {}) {
  const files = [
    { path: 'package.json', body: `${JSON.stringify({ name: ENTRY, version: PUBLIC_VERSION, license: 'Apache-2.0' }, null, 2)}\n` },
    { path: 'cordis.patch.yml', body: patchText() },
    { path: 'README.md', body: '# fixture enterprise bundle\n' },
    { path: 'src/index.mjs', body: 'export const fixture = true;\n' },
    // The maker refuses a public bundle whose bundled IAM validator differs from
    // the toolchain it is paired with, so the fixture ships the real modules.
    ...['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs'].map((name) => ({
      path: `node_modules/@heluo/forge-iam/src/${name}`,
      body: readFileSync(join(repo, 'packages', 'forge-iam', 'src', name)),
    })),
    ...extraFiles,
  ];
  return writeBundleTarball(files);
}

function writeConfig(root, lines = ENV) {
  const path = join(root, 'enterprise.env');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PrivateBundleError, true, `expected PrivateBundleError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function makerInput(t, { extraFiles = [] } = {}) {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicTarball({ extraFiles }));
  return {
    root,
    publicPath,
    expectedSha256: inspectPublicTarball(publicPath).sha256,
    configPath: writeConfig(root),
    version: '0.2.0',
  };
}

// --- item 7: the maker speaks the plugins' real contract --------------------

test('the config the maker writes is accepted by the plugins that load it', () => {
  const config = buildConfig(parseEnvConfig(ENV.join('\n')));

  const iam = validateConfig(config.iam);
  assert.equal(iam.issues, undefined, JSON.stringify(iam.issues));
  assert.equal(iam.value.scopes.includes('openid'), true);

  const gitee = validateGiteeConfig(config.gitee);
  assert.equal(gitee.issues, undefined, JSON.stringify(gitee.issues));
  // The plugin lowercases and keeps only the host; a scheme in the value is the
  // exact defect from the issue: the capability silently failed to load.
  assert.equal(gitee.value.host, 'gitee.corp.example');
  assert.equal(gitee.value.timeoutMs, 15000);
});

for (const [label, override, makerPattern, pluginRejects] of [
  [
    'a Gitee host that carries a scheme',
    'HELUO_GITEE_HOST=https://gitee.corp.example',
    /bare hostname/u,
    () => validateGiteeConfig({ host: 'https://gitee.corp.example' }).issues !== undefined,
  ],
  [
    'a Gitee host that carries a path',
    'HELUO_GITEE_HOST=gitee.corp.example/esc-sso',
    /bare hostname/u,
    () => validateGiteeConfig({ host: 'gitee.corp.example/esc-sso' }).issues !== undefined,
  ],
  [
    'a Gitee CLI path that is a URL',
    'HELUO_GITEE_CLI_PATH=https://gitee.corp.example/bin/cli',
    /not a URL/u,
    () => validateGiteeConfig({ cliPath: 'https://gitee.corp.example/bin/cli' }).issues !== undefined,
  ],
  [
    'a Gitee CLI wrapper script',
    'HELUO_GITEE_CLI_PATH=gitee.cmd',
    /wrapper script/u,
    () => validateGiteeConfig({ cliPath: 'gitee.cmd' }).issues !== undefined,
  ],
  [
    'scopes without openid',
    'HELUO_IAM_SCOPES=profile',
    /openid/u,
    () => validateConfig({ authMode: 'public', clientId: 'c', issuer: 'https://iam.corp.example', discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration', scopes: ['profile'] }).issues !== undefined,
  ],
  [
    'localhost as the callback address',
    'HELUO_IAM_CALLBACK_ADDRESS=localhost',
    /HELUO_IAM_CALLBACK_ADDRESS must be auto/u,
    () => validateConfig({ authMode: 'public', clientId: 'c', issuer: 'https://iam.corp.example', discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration', callbackAddress: 'localhost' }).issues !== undefined,
  ],
  [
    'a redirect path inside /api/forge-iam',
    'HELUO_IAM_REDIRECT_PATH=/api/forge-iam/callback',
    /overlap \/api\/forge-iam/u,
    () => validateConfig({ authMode: 'public', clientId: 'c', issuer: 'https://iam.corp.example', discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration', redirectPath: '/api/forge-iam/callback' }).issues !== undefined,
  ],
]) {
  test(`the maker refuses ${label} before writing anything`, () => {
    assert.equal(pluginRejects(), true, 'the plugin must reject this value, otherwise the maker is over-strict');
    assert.throws(
      () => buildConfig(parseEnvConfig(envWith(override).join('\n'))),
      (error) => error.code === 'CONFIG_INVALID' && makerPattern.test(error.message),
    );
  });
}

// --- item 10: the preview echoes verdicts, not enterprise values ----------

test('the CLI preview carries keys and the redacted verdict, never a configured value', (t) => {
  const input = makerInput(t);
  const run = spawnSync(process.execPath, [
    CLI,
    '--public', input.publicPath,
    '--public-sha256', input.expectedSha256,
    '--config', input.configPath,
    '--version', input.version,
    '--output', join(input.root, 'private'),
    '--repo-root', join(input.root, 'repo-does-not-exist'),
    '--skip-discovery-check',
  ], { encoding: 'utf8' });
  // Without --confirm the run stops after printing the plan, which is the text
  // that ends up in tickets and assistant transcripts.
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /CONFIRM_REQUIRED/u);
  assert.equal(run.stderr.includes('corp.example'), false, 'the preview must not echo a configured value');
  assert.match(run.stderr, /"loginReady": true/u);
  assert.match(run.stderr, /"checked": false/u);
  assert.equal(run.stdout, '');
});

// --- item 14: the boundary is a path question, not a prefix question -------

test('the boundary is decided by path components and resolved symlinks', (t) => {
  const root = temp(t);
  const checkout = join(root, 'repo');
  mkdirSync(join(checkout, 'nested'), { recursive: true });

  assert.throws(() => assertOutsideDirectory(join(checkout, 'out'), checkout, 'output'), /must be outside/u);
  // The reviewer's repro: a directory literally named `..secret` *inside* the
  // checkout used to be reported as outside, and the artifact was written there.
  assert.throws(() => assertOutsideDirectory(join(checkout, '..secret'), checkout, 'output'), /must be outside/u);
  assert.throws(() => assertOutsideDirectory(join(checkout, 'nested', 'deeper'), checkout, 'output'), /must be outside/u);

  // A sibling that only looks like a traversal really is outside.
  assert.doesNotThrow(() => assertOutsideDirectory(join(root, 'repo..secret'), checkout, 'output'));
  assert.doesNotThrow(() => assertOutsideDirectory(join(root, 'repo-private'), checkout, 'output'));

  // A link outside the checkout that resolves back into it is inside.
  const link = join(root, 'link');
  symlinkSync(join(checkout, 'nested'), link, 'dir');
  assert.throws(() => assertOutsideDirectory(link, checkout, 'output'), /must be outside/u);
  assert.throws(() => assertOutsideDirectory(join(link, 'deeper'), checkout, 'output'), /must be outside/u);
});

test('the maker refuses an output that only a lexical check would call outside', (t) => {
  const input = makerInput(t);
  const checkout = join(input.root, 'repo');
  mkdirSync(checkout, { recursive: true });
  expectCode(
    () => makePrivateBundle({ ...input, repoRoot: checkout, output: join(checkout, '..secret') }),
    'OUTPUT_INSIDE_REPO',
  );
  assert.equal(existsSync(join(checkout, '..secret')), false, 'a refused run must not create the output');

  const link = join(input.root, 'link');
  symlinkSync(checkout, link, 'dir');
  expectCode(
    () => makePrivateBundle({ ...input, repoRoot: checkout, output: join(link, 'out') }),
    'OUTPUT_INSIDE_REPO',
  );
  assert.equal(existsSync(join(checkout, 'out')), false);
});

test('a sibling directory whose name starts with dots is a legal output', (t) => {
  const input = makerInput(t);
  const checkout = join(input.root, 'repo');
  mkdirSync(checkout, { recursive: true });
  const result = makePrivateBundle({ ...input, repoRoot: checkout, output: join(input.root, 'repo..secret') });
  assert.equal(existsSync(result.tarball), true);
});

test('the direct maker CLI refuses an in-checkout output with a coded refusal', (t) => {
  const input = makerInput(t);
  const checkout = join(input.root, 'repo');
  mkdirSync(checkout, { recursive: true });
  const run = spawnSync(process.execPath, [
    CLI,
    '--public', input.publicPath,
    '--public-sha256', input.expectedSha256,
    '--config', input.configPath,
    '--version', input.version,
    '--output', join(checkout, '..secret'),
    '--repo-root', checkout,
    '--skip-discovery-check',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /OUTPUT_INSIDE_REPO/u);
  assert.equal(existsSync(join(checkout, '..secret')), false);
});

// --- item 15: success is reported only after the artifact verifier agrees ---

/** A public tarball that records a linux-x64 addon and does not ship it. */
function tarballMissingRecordedAddon() {
  const checksums = {
    package: '@heluo/forge-credentials-keychain',
    version: '0.1.0',
    files: {
      'linux-x64/keyring.node': {
        sha256: 'a'.repeat(64),
        bytes: 128,
        licenseSha256: 'b'.repeat(64),
        licenseBytes: 64,
      },
    },
  };
  return publicTarball({ extraFiles: [{ path: 'vendor/CHECKSUMS.json', body: `${JSON.stringify(checksums, null, 2)}\n` }] });
}

test('the maker refuses a public tarball that fails the artifact closure check', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, tarballMissingRecordedAddon());
  const digest = inspectPublicTarball(publicPath).sha256;
  const output = join(root, 'private');
  expectCode(
    () => makePrivateBundle({ publicPath, expectedSha256: digest, configPath: writeConfig(root), version: '0.2.0', output }),
    'PUBLIC_INCOMPLETE',
  );
  assert.equal(existsSync(output), false, 'a refused run must not leave a private artifact');
});

test('the direct maker CLI refuses a public tarball the verifier rejects', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, tarballMissingRecordedAddon());
  const digest = inspectPublicTarball(publicPath).sha256;
  const output = join(root, 'private');
  const args = [
    CLI,
    '--public', publicPath,
    '--public-sha256', digest,
    '--config', writeConfig(root),
    '--version', '0.2.0',
    '--output', output,
    '--repo-root', join(root, 'repo-does-not-exist'),
    '--skip-discovery-check',
  ];
  // The maker asks for the plan digest before writing, so the refusal has to be
  // reached with a confirmed plan: preview, read the digest, then run for real.
  const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.match(preview.stderr, /CONFIRM_REQUIRED/u);
  const planDigest = /"planDigest": "([0-9a-f]{64})"/u.exec(preview.stderr)?.[1];
  assert.ok(planDigest !== undefined, preview.stderr);
  assert.equal(preview.stdout, '');

  const run = spawnSync(process.execPath, [...args, '--confirm', planDigest.slice(0, 16)], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /PUBLIC_INCOMPLETE/u);
  assert.equal(existsSync(output), false);
});

test('a successful run reports the verified artifact, not just a digest match', (t) => {
  const input = makerInput(t);
  const result = makePrivateBundle({ ...input, output: join(input.root, 'private') });
  assert.equal(result.verified, true);
  assert.match(readFileSync(join(result.output, 'bundle-manifest.json'), 'utf8'), /private-maker/u);
});

// --- F1: the artifact gate must be at least as strong as the source gate ----

// Assembled, not spelled out: the public build scans every tracked file with the
// same gate, so a complete armor block sitting in this fixture would fail the
// repository's own release over a test.
const ARMOR_HEADER = `-----BEGIN ${'PRIVATE'} KEY-----`;
const ARMOR_FOOTER = `-----END ${'PRIVATE'} KEY-----`;
const ARMOR = `${ARMOR_HEADER}\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAiEA\n${ARMOR_FOOTER}\n`;

test('a private key block is refused in every file type, whatever the extension', () => {
  const cases = [
    // Name-based: the extension alone disqualifies the file.
    ['deploy/certs/enterprise.pem', /credential-like file name/u],
    // Content-based: the extension says nothing, the armor decides.
    ['deploy/notes.txt', /private key block/u],
    ['deploy/keys.json', /private key block/u],
    ['deploy/blob.bin', /private key block/u],
    ['deploy/payload.dat', /private key block/u],
    ['deploy/no-extension', /private key block/u],
    ['deploy/certs/misnamed.crt', /private key block/u],
  ];
  for (const [path, expected] of cases) {
    const findings = scanReleaseFiles([{ path, body: Buffer.from(ARMOR) }]);
    assert.equal(findings.length > 0, true, `${path} must be refused`);
    assert.match(findings.join('\n'), expected, path);
    assert.equal(findings.join('\n').includes('MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAiEA'), false, `${path}: the value must not be echoed`);
  }
});

test('encrypted PKCS#8 armor is refused too, not only the bare RSA form', () => {
  for (const header of ['ENCRYPTED PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'DSA PRIVATE KEY']) {
    const body = `-----BEGIN ${header}-----\nMIIB\n-----END ${header}-----\n`;
    const findings = scanReleaseFiles([{ path: 'deploy/notes.txt', body }]);
    assert.match(findings.join('\n'), /private key block/u, header);
  }
});

test('public certificates, public keys and ordinary files are not refused', () => {
  const clean = [
    ['deploy/README.md', '# deploy notes\nrun the installer, then restart\n'],
    ['deploy/certs/ca.crt', '-----BEGIN CERTIFICATE-----\nMIIBszCCARygAwIBAgIFAK\n-----END CERTIFICATE-----\n'],
    ['deploy/certs/intermediate.cer', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'],
    ['.github/keys/team-public-key.pub', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----\n'],
    ['deploy/notes.txt', 'payload: MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAiEA\n'],
  ];
  for (const [path, body] of clean) {
    assert.deepEqual(scanReleaseFiles([{ path, body }]), [], path);
  }
});

// Deliberate fail-closed choice: a `.pem` is refused on its name even when the
// bytes it holds today are a public certificate. The extension cannot tell the
// two apart, and a gate that has to read the content to decide is one edit away
// from shipping the key. A certificate that genuinely has to travel ships as
// `.crt`/`.cer`, which stay allowed and are still content-scanned above.
test('a .pem is refused by name even when it currently holds only a certificate', () => {
  const findings = scanReleaseFiles([{ path: 'deploy/certs/enterprise.pem', body: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' }]);
  assert.match(findings.join('\n'), /credential-like file name/u);
});

test('keystores and the credential names that were already refused stay refused', () => {
  const refused = [
    'deploy/a.key', 'deploy/a.p12', 'deploy/a.pfx', 'deploy/a.jks', 'deploy/a.keystore', 'deploy/a.ppk',
    '.env', '.env.local', 'deploy/.env.production', 'deploy/.npmrc', '.git-credentials', 'deploy/id_rsa', 'deploy/id_ed25519',
  ];
  for (const path of refused) {
    assert.equal(scanReleaseFiles([{ path, body: 'x\n' }]).length, 1, path);
  }
});

// The gate scans the tool sources it ships with: a pattern that matches its own
// definition would fail the public build instead of catching a secret.
test('the gate does not match the tool sources that define it', () => {
  for (const path of ['scripts/lib/release-support.mjs', 'scripts/lib/sensitive-patterns.mjs']) {
    assert.deepEqual(scanReleaseFiles([{ path, body: readFileSync(join(repo, path)) }]), [], `${path} must stay shippable`);
  }
});

// A lone armor header is not key material. The repository's own scan tests embed
// one as a probe string and the public build scans every tracked file, so a
// header-only rule would fail the release over a fixture while catching nothing.
test('a lone armor header is not key material and does not trip the gate', () => {
  const body = "assert.deepEqual(probe(`-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`), ['private key block']);\n";
  const findings = scanReleaseFiles([{ path: 'tests/sensitive-patterns.test.mjs', body }]);
  assert.deepEqual(findings.filter((finding) => /private key block/u.test(finding)), []);
});

// The public build scans every tracked file with this same gate, so the fixtures
// in this file must not read as a leak themselves.
test('this file\'s own fixtures stay shippable under the gate it ships', () => {
  assert.deepEqual(scanReleaseFiles([{ path: 'tests/private-bundle-boundary.test.mjs', body: readFileSync(join(repo, 'tests/private-bundle-boundary.test.mjs')) }]), []);
});

// --- F4: the output says whether the discovery check ran -------------------

function runCliAsync(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

/** Start a local discovery document so the check can really run in a test. */
async function discoveryServer(t) {
  const state = { base: '' };
  const server = createServer((request, response) => {
    if (request.url !== '/.well-known/openid-configuration') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      issuer: state.base,
      authorization_endpoint: `${state.base}/authorize`,
      token_endpoint: `${state.base}/token`,
      jwks_uri: `${state.base}/jwks`,
    }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => server.close());
  const { port } = server.address();
  state.base = `http://127.0.0.1:${port}`;
  return state;
}

function cliArgs(input, configPath, output, extra = []) {
  return [
    CLI,
    '--public', input.publicPath,
    '--public-sha256', input.expectedSha256,
    '--config', configPath,
    '--version', input.version,
    '--output', output,
    '--repo-root', join(input.root, 'repo-does-not-exist'),
    ...extra,
  ];
}

test('--json records a discovery check that actually ran', async (t) => {
  const { base } = await discoveryServer(t);
  const input = makerInput(t);
  const configPath = writeConfig(input.root, [
    `HELUO_IAM_ISSUER=${base}`,
    `HELUO_IAM_DISCOVERY_URL=${base}/.well-known/openid-configuration`,
    'HELUO_IAM_ALLOW_INSECURE_HTTP=true',
    'HELUO_IAM_CLIENT_ID=forge-console',
    'HELUO_IAM_SCOPES=openid profile',
    'HELUO_IAM_CALLBACK_PORT=53682',
    'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
  ]);
  const output = join(input.root, 'private');
  const args = cliArgs(input, configPath, output);

  const preview = await runCliAsync(args);
  const planDigest = /"planDigest": "([0-9a-f]{64})"/u.exec(preview.stderr)?.[1];
  assert.ok(planDigest !== undefined, preview.stderr);
  assert.match(preview.stderr, /^discovery: verified$/mu);

  const run = await runCliAsync([...args, '--json', '--confirm', planDigest.slice(0, 16)]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.discovery, { required: true, checked: true, skipped: false, reason: null });
  assert.equal(existsSync(join(output, 'bundle-manifest.json')), true);
});

test('--json records an explicitly skipped discovery check with its reason', async (t) => {
  const input = makerInput(t);
  const output = join(input.root, 'private');
  const args = cliArgs(input, input.configPath, output, ['--skip-discovery-check']);

  const preview = await runCliAsync(args);
  const planDigest = /"planDigest": "([0-9a-f]{64})"/u.exec(preview.stderr)?.[1];
  assert.ok(planDigest !== undefined, preview.stderr);
  assert.match(preview.stderr, /^discovery: skipped \(skipped by --skip-discovery-check\)$/mu);

  const run = await runCliAsync([...args, '--json', '--confirm', planDigest.slice(0, 16)]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.discovery.skipped, true);
  assert.equal(result.discovery.checked, false);
  assert.equal(result.discovery.required, true);
  assert.equal(typeof result.discovery.reason, 'string');
  assert.notEqual(result.discovery.reason, '');
  // The pre-existing contract fields keep their names.
  for (const key of ['output', 'tarball', 'sha256', 'version', 'base', 'changed', 'configKeys', 'manifest', 'release', 'verified']) {
    assert.equal(key in result, true, `result.${key} must stay in the JSON contract`);
  }
});
