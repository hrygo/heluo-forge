import assert from 'node:assert/strict';
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
    write(root, 'docs/operations/notes.md', `# 说明\n\n-----BEGIN OPENSSH PRIVATE KEY-----\n`); // security-scan: allow
    write(root, 'docs/operations/paths.md', '# 路径\n\n/Users/example/work\n');
    const { errors } = checkRepo(root);
    assert.ok(errors.some((error) => error.includes('private key block') && !error.includes('OPENSSH')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('host-specific absolute path')), errors.join('\n'));
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