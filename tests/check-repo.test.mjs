import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkRepo } from '../scripts/lib/repo-rules.mjs';

const WORKFLOW = `name: check
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - run: node scripts/check-docs.mjs
`;

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// Assembled at runtime: the checker's own fixture must not place a literal
// credential marker or host path in tracked source, because the public source
// archive is scanned without the source-line exemption.
const PRIVATE_KEY_MARKER = ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ');
const HOST_ABSOLUTE_DIR = ['', 'Users', 'example', 'work'].join('/');

const PACKAGE = `${JSON.stringify(
  {
    name: 'heluo-forge',
    version: '0.0.0',
    private: true,
    packageManager: 'pnpm@11.28.5',
    engines: { node: '>=24.0.0 <25' },
    scripts: { check: 'node scripts/check-docs.mjs' },
  },
  null,
  2,
)}\n`;

export function buildValidRepo(root) {
  for (const path of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    write(root, path, `# ${path}\n`);
  }
  for (const path of [
    'docs/README.md',
    'docs/DOCUMENT-REGISTER.md',
    'docs/templates/_template.md',
    'docs/templates/design-template.md',
    'docs/design/README.md',
    'docs/operations/README.md',
    'deploy/README.md',
    'deploy/registry/README.md',
    'deploy/clients/README.md',
    'scripts/check-docs.mjs',
    'scripts/check-repo.mjs',
  ]) {
    write(root, path, `# ${path}\n`);
  }
  write(root, 'package.json', PACKAGE);
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - services/*\n');
  write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write(root, '.node-version', '24.21.0\n');
  write(root, '.editorconfig', 'root = true\n');
  write(root, '.gitattributes', '* text=auto eol=lf\n');
  write(root, '.gitignore', 'node_modules/\ncoverage/\n.DS_Store\n');
  write(root, '.github/workflows/check.yml', WORKFLOW);
  write(root, 'packages/forge-iam/README.md', '# forge-iam\n\n状态：规划\n');
  write(root, 'services/devops-mcp/README.md', '# devops-mcp\n\n状态：规划\n');
  mkdirSync(join(root, 'tests'), { recursive: true });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heluo-forge-repo-'));
  buildValidRepo(root);
  return root;
}

test('valid repository skeleton passes', () => {
  const root = fixture();
  try {
    const { errors, counts } = checkRepo(root);
    assert.deepEqual(errors, []);
    assert.equal(counts.packages, 1);
    assert.equal(counts.services, 1);
    assert.equal(counts.workflows, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing required entry is reported', () => {
  const root = fixture();
  try {
    rmSync(join(root, 'SECURITY.md'));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('missing SECURITY.md')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stray root document is rejected', () => {
  const root = fixture();
  try {
    write(root, '2026-11-16_DRIFT_REPORT.md', '# drift\n');
    const { errors } = checkRepo(root);
    assert.ok(
      errors.some((error) => error.includes('2026-11-16_DRIFT_REPORT.md') && error.includes('unapproved root file')),
      errors.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unapproved top-level directory is rejected', () => {
  const root = fixture();
  try {
    write(root, 'scratch/notes.md', '# notes\n');
    const { errors } = checkRepo(root);
    assert.ok(
      errors.some((error) => error.includes('scratch/') && error.includes('unapproved top-level directory')),
      errors.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowlisted root entries are accepted', () => {
  const root = fixture();
  try {
    assert.deepEqual(checkRepo(root).errors, []);
    // Present in ROOT_FILES: adding it must not trip the surface check.
    write(root, '.env.example', 'PLACEHOLDER=\n');
    assert.deepEqual(checkRepo(root).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git root checks include tracked and untracked entries and exclude ignored files', () => {
  const root = fixture();
  try {
    execFileSync('git', ['init', '--quiet', '--template=', root]);
    execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', 'add', '--all']);
    write(root, '.DS_Store', 'ignored by the fixture');
    assert.deepEqual(checkRepo(root).errors, []);

    write(root, 'tracked-report.md', '# Tracked report\n');
    execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', 'add', '--', 'tracked-report.md']);
    write(root, 'untracked-report.md', '# Untracked report\n');
    write(root, 'scratch/notes.md', '# Scratch notes\n');

    const { errors } = checkRepo(root);
    assert.match(errors.join('\n'), /repo: tracked-report\.md is an unapproved root file/);
    assert.match(errors.join('\n'), /repo: untracked-report\.md is an unapproved root file/);
    assert.match(errors.join('\n'), /repo: scratch\/ is an unapproved top-level directory/);
    assert.equal(errors.length, 3, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-private package is rejected', () => {
  const root = fixture();
  try {
    write(root, 'package.json', PACKAGE.replace('"private": true', '"private": false'));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('"private": true')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unpinned workflow action is rejected', () => {
  const root = fixture();
  try {
    write(root, '.github/workflows/check.yml', WORKFLOW.replace(/actions\/checkout@\w+/, 'actions/checkout@v4'));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('not pinned')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Docker workflow images are pinned by a full sha256 digest', () => {
  const root = fixture();
  const image = 'docker://corp.example/review-tool';
  const digest = 'a'.repeat(64);
  const checkout = /actions\/checkout@\w+/u;
  try {
    const pinned = `"${image}@sha256:${digest}" # release image`;
    write(root, '.github/workflows/check.yml', WORKFLOW.replace(checkout, pinned));
    assert.deepEqual(checkRepo(root).errors, []);

    for (const reference of [
      `${image}:latest`,
      `${image}@sha256:${digest.slice(0, 63)}`,
      `${image}@${digest.slice(0, 40)}`,
    ]) {
      write(root, '.github/workflows/check.yml', WORKFLOW.replace(checkout, reference));
      const { errors } = checkRepo(root);
      assert.ok(errors.some((error) => error.includes('not pinned to a full sha256 digest')), reference);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const quote of ['', "'", '"']) {
  test(`workflow SHA validation handles comments with ${quote || 'no'} quotes`, () => {
    const root = fixture();
    try {
      const reference = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
      write(root, '.github/workflows/check.yml', WORKFLOW.replace(reference, `${quote}${reference}${quote} # v7.0.1`));
      assert.deepEqual(checkRepo(root).errors, []);

      write(root, '.github/workflows/check.yml', WORKFLOW.replace(reference, `${quote}actions/checkout@v7${quote} # unpinned`));
      assert.ok(checkRepo(root).errors.some((error) => error.includes('not pinned')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('pull_request_target is rejected', () => {
  const root = fixture();
  try {
    write(root, '.github/workflows/check.yml', WORKFLOW.replace('pull_request:', 'pull_request_target:'));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('pull_request_target')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sensitive-attestation may use base-only pull_request_target, but not PR head checkout', () => {
  const root = fixture();
  const workflow = `name: sensitive-attestation
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ github.event.pull_request.base.sha }}
      - run: node scripts/sensitive-scan/verify.mjs
`;
  try {
    write(root, '.github/workflows/sensitive-attestation.yml', workflow);
    const accepted = checkRepo(root);
    assert.deepEqual(accepted.errors, []);

    const withExpectedSha = workflow.replace('      - run: node', '      - env:\n          EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n        run: node');
    write(root, '.github/workflows/sensitive-attestation.yml', withExpectedSha);
    assert.deepEqual(checkRepo(root).errors, []);

    write(
      root,
      '.github/workflows/sensitive-attestation.yml',
      workflow.replace('base.sha', 'head.sha'),
    );
    const rejected = checkRepo(root);
    assert.ok(
      rejected.errors.some((error) => error.includes('must not reference the pull_request head')),
      rejected.errors.join('\n'),
    );

    write(
      root,
      '.github/workflows/sensitive-attestation.yml',
      workflow.replace('base.sha', 'head.ref'),
    );
    const headRef = checkRepo(root);
    assert.ok(
      headRef.errors.some((error) => error.includes('must not reference the pull_request head')),
      headRef.errors.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workflow without read-only permissions is rejected', () => {
  const root = fixture();
  try {
    write(root, '.github/workflows/check.yml', WORKFLOW.replace('permissions:\n  contents: read\n', ''));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('contents: read')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The unified build is the one workflow that may write to the repository. The
// fixture is its admitted shape; every case below changes exactly one thing.
const RELEASE_BUNDLE = `name: release-bundle
on:
  push:
    tags: ['v*']
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: release-bundle-\${{ github.ref }}
jobs:
  employee:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout the tagged commit
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Build the employee package
        env:
          HELUO_IAM_CLIENT_ID: \${{ secrets.HELUO_IAM_CLIENT_ID }}
          HELUO_IAM_CLIENT_SECRET: \${{ secrets.HELUO_IAM_CLIENT_SECRET }}
        run: node scripts/build-employee-package.mjs
      - name: Attach to the draft Release
        env:
          GH_TOKEN: \${{ github.token }}
        run: node scripts/upload-draft-release.mjs
`;

test('release-bundle is admitted under its narrow conditions and nothing else', () => {
  const root = fixture();
  const path = '.github/workflows/release-bundle.yml';
  const rejected = (text, expected) => {
    write(root, path, text);
    const { errors } = checkRepo(root);
    assert.ok(errors.length > 0, 'the changed workflow must be rejected');
    assert.match(errors.join('\n'), expected);
    return errors.join('\n');
  };
  try {
    write(root, path, RELEASE_BUNDLE);
    const accepted = checkRepo(root);
    assert.deepEqual(accepted.errors, []);
    assert.equal(accepted.counts.workflows, 2);
    // The runner token is the one admitted secret that is not configuration.
    write(root, path, RELEASE_BUNDLE.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'));
    assert.deepEqual(checkRepo(root).errors, []);

    // One more entry widens what the token can write.
    rejected(RELEASE_BUNDLE.replace('  contents: write\n', '  contents: write\n  id-token: write\n'), /permissions must be exactly one entry/);
    // A job-level block re-scopes the grant per job.
    rejected(RELEASE_BUNDLE.replace('    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n'), /must not declare job-level permissions/);
    rejected(RELEASE_BUNDLE.replace('permissions:\n  contents: write\n', 'permissions:\n  contents: read\n'), /permissions must be exactly one entry/);
    // A PR or branch trigger lets any pushed commit reach the write grant.
    rejected(RELEASE_BUNDLE.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'), /may only trigger/);
    rejected(RELEASE_BUNDLE.replace("    tags: ['v*']\n", '    branches: [main]\n'), /may only trigger/);
    // A checkout that keeps the token in the git config exposes it to every later step.
    rejected(RELEASE_BUNDLE.replace('          persist-credentials: false\n', ''), /persist-credentials: false/);
    // Secrets reach a step as an environment variable, never expanded into script text.
    const inline = RELEASE_BUNDLE.replace(
      '        run: node scripts/build-employee-package.mjs',
      '        run: echo ${{ secrets.HELUO_IAM_CLIENT_SECRET }} | node scripts/build-employee-package.mjs',
    );
    rejected(inline, /expands a secret inline/);
    // Script text that merely looks like an env block is still script text.
    const script = RELEASE_BUNDLE.replace(
      '        run: node scripts/upload-draft-release.mjs',
      '        run: |\n          env:\n            HELUO_IAM_CLIENT_ID: ${{ secrets.HELUO_IAM_CLIENT_ID }}\n          node scripts/upload-draft-release.mjs',
    );
    rejected(script, /through an env: block/);
    // `with:` inputs are expression expansion, not environment variables.
    rejected(RELEASE_BUNDLE.replace('        env:\n          HELUO_IAM_CLIENT_ID', '        with:\n          HELUO_IAM_CLIENT_ID'), /through an env: block/);
    // A secret outside the configuration list has no documented injection target.
    rejected(RELEASE_BUNDLE.replace('secrets.HELUO_IAM_CLIENT_SECRET }}', 'secrets.HELUO_GITEE_HOST }}'), /outside the configuration list/);
    // The exception is bound to the one file: the same text under another name is not admitted.
    rmSync(join(root, path));
    write(root, '.github/workflows/other-release.yml', RELEASE_BUNDLE);
    const elsewhere = checkRepo(root).errors.join('\n');
    assert.match(elsewhere, /must not declare contents: write/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('any other workflow that declares contents: write is rejected', () => {
  const root = fixture();
  try {
    write(root, '.github/workflows/check.yml', WORKFLOW.replace('    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n'));
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('must not declare contents: write')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package claimed usable without a manifest is rejected', () => {
  const root = fixture();
  try {
    write(root, 'packages/forge-iam/README.md', '# forge-iam\n\n状态：可用\n');
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('without package.json')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest without engines.dsh or test script is rejected', () => {
  const root = fixture();
  try {
    write(root, 'packages/forge-iam/README.md', '# forge-iam\n\n状态：可用\n');
    write(root, 'packages/forge-iam/package.json', '{"name":"@heluo/forge-iam","private":true}\n');
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('engines.dsh')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('test script')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('credential pattern and host path are reported without printing values', () => {
  const root = fixture();
  try {
    write(root, 'docs/operations/notes.md', `# 说明\n\n${PRIVATE_KEY_MARKER}\n`);
    write(root, 'docs/operations/paths.md', `# 路径\n\n${HOST_ABSOLUTE_DIR}\n`);
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('private key block') && !error.includes('OPENSSH')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('host-specific absolute path')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uppercase text extensions are scanned like their lowercase forms', () => {
  const root = fixture();
  try {
    write(root, 'docs/operations/EXAMPLE.MD', `# 说明\n\n${PRIVATE_KEY_MARKER}\n`);
    write(root, 'docs/operations/PATHS.JSON', `{\n  "path": "${HOST_ABSOLUTE_DIR}"\n}\n`);
    const { errors } = checkRepo(root);
    assert.ok(
      errors.some((error) => error.includes('EXAMPLE.MD') && error.includes('private key block') && !error.includes('OPENSSH')),
      errors.join('\n'),
    );
    assert.ok(errors.some((error) => error.includes('PATHS.JSON') && error.includes('host-specific absolute path')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing ignore coverage is reported', () => {
  const root = fixture();
  try {
    write(root, '.gitignore', '*.log\n');
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('node_modules/')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI exits non-zero on failure and zero on success', async () => {
  const { spawnSync } = await import('node:child_process');
  const good = fixture();
  const bad = fixture();
  try {
    const node = process.execPath;
    const script = join(process.cwd(), 'scripts/check-repo.mjs');
    const success = spawnSync(node, [script, good], { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stdout + success.stderr);
    rmSync(join(bad, 'README.md'));
    const failure = spawnSync(node, [script, bad], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /missing README\.md/);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});
