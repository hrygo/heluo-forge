import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkRepo } from '../scripts/lib/repo-rules.mjs';
import { parsePatchLayer } from '../scripts/lib/bundle-rules.mjs';
import { buildValidRepo } from './check-repo.test.mjs';

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heluo-forge-bundle-'));
  buildValidRepo(root);
  return root;
}

function manifest(overrides = {}) {
  return `${JSON.stringify(
    {
      name: '@heluo/forge-sample',
      version: '0.1.0',
      private: true,
      type: 'module',
      engines: { dsh: '>=0.2.1-rc.2' },
      scripts: { test: 'node --test' },
      main: './src/index.mjs',
      exports: { '.': './src/index.mjs' },
      files: ['src', 'README.md'],
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

function addPackage(root, name = 'forge-sample', overrides = {}) {
  write(root, `packages/${name}/README.md`, `# ${name}\n\n状态：可用\n`);
  write(root, `packages/${name}/src/index.mjs`, 'export const ok = true;\n');
  write(root, `packages/${name}/package.json`, manifest({ name: `@heluo/${name}`, ...overrides }));
}

function run(root) {
  return checkRepo(root).errors.filter((error) => error.startsWith('bundle:'));
}

const withFixture = (body) => {
  const root = fixture();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('a closed package passes the closure rules', () => {
  withFixture((root) => {
    addPackage(root);
    assert.deepEqual(run(root), []);
  });
});

test('file list, entry points and engine pin are enforced', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample', {
      engines: { dsh: '*' },
      main: './src/missing.mjs',
      exports: { '.': './src/index.mjs', './locale/*.json': './locale/*.json' },
      files: ['src', 'README.md', 'docs'],
    });
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('engines.dsh')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('main ./src/missing.mjs does not exist')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('has no matching directory')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('files entry docs does not exist')), errors.join('\n'));
  });
});

test('install-time builds and kernel dependencies are refused', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample', {
      scripts: { test: 'node --test', prepare: 'pnpm build' },
      dependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.2' },
    });
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('install-time build scripts (prepare)')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('must not depend on the DSH kernel')), errors.join('\n'));
  });
});

test('workspace dependency protocol and availability are enforced', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample', { dependencies: { '@heluo/forge-other': '^0.1.0' } });
    addPackage(root, 'forge-second', { dependencies: { '@heluo/forge-absent': 'workspace:*' } });
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('must use the workspace: protocol')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('has no workspace package')), errors.join('\n'));
  });
});

test('cross-package source imports are refused', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample');
    write(root, 'packages/forge-sample/src/deep.mjs', "export { x } from '@heluo/forge-other/src/index.mjs';\n");
    write(root, 'packages/forge-second/README.md', '# forge-second\n\n状态：可用\n');
    write(root, 'packages/forge-second/src/index.mjs', "export { y } from '../../forge-sample/src/index.mjs';\n");
    write(root, 'packages/forge-second/package.json', manifest({ name: '@heluo/forge-second' }));
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('imports another package\u2019s source path') || error.includes("imports another package's source path")), errors.join('\n'));
    assert.ok(errors.filter((error) => error.includes('source path')).length === 2, errors.join('\n'));
  });
});

test('patch layers must ship, declare and resolve', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample');
    write(root, 'packages/forge-sample/cordis.patch.yml', '- insert:\n    - id: sample-row\n      name: "@heluo/forge-absent"\n');
    const undeclared = run(root);
    assert.ok(undeclared.some((error) => error.includes('must list cordis.patch.yml in files')), undeclared.join('\n'));
    assert.ok(undeclared.some((error) => error.includes('must declare dsh.bundle.patch')), undeclared.join('\n'));
    assert.ok(undeclared.some((error) => error.includes('inserts @heluo/forge-absent, which is not a workspace package')), undeclared.join('\n'));

    addPackage(root, 'forge-sample', {
      files: ['src', 'cordis.patch.yml', 'README.md'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    const resolved = run(root);
    assert.ok(resolved.some((error) => error.includes('not a workspace package')), resolved.join('\n'));
    assert.equal(resolved.some((error) => error.includes('must list cordis.patch.yml')), false);
  });
});

test('the legacy market package may only mount itself', () => {
  withFixture((root) => {
    addPackage(root, 'forge-market', {
      files: ['src', 'cordis.patch.yml', 'README.md'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    write(root, 'packages/forge-market/cordis.patch.yml', '- insert:\n    - id: forge-market\n      name: "@heluo/forge-market"\n');
    assert.deepEqual(run(root), []);

    addPackage(root, 'forge-combo', {
      files: ['src', 'cordis.patch.yml', 'README.md'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    write(
      root,
      'packages/forge-combo/cordis.patch.yml',
      '- id: deepseek-account\n  disabled: true\n- insert:\n    - id: forge-market\n      name: "@heluo/forge-market"\n',
    );
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('must not mount the legacy market package')), errors.join('\n'));
  });
});

test('package name must match its directory and the namespace', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample', { name: '@heluo/forge-other' });
    addPackage(root, 'forge-second', { name: 'forge-second' });
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('must match @heluo/forge-*')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('must match its directory name')), errors.join('\n'));
  });
});

test('locale files must ship both languages and be packaged', () => {
  withFixture((root) => {
    addPackage(root, 'forge-sample', { files: ['src', 'README.md'] });
    write(root, 'packages/forge-sample/locale/en.json', '{}\n');
    const errors = run(root);
    assert.ok(errors.some((error) => error.includes('must ship both en.json and zh.json')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('must include the locale directory')), errors.join('\n'));

    write(root, 'packages/forge-sample/locale/zh.json', '{}\n');
    addPackage(root, 'forge-sample', { files: ['src', 'locale', 'README.md'] });
    assert.deepEqual(run(root), []);
  });
});

test('patch parsing reads inserted names and disabled rows', () => {
  const parsed = parsePatchLayer(
    [
      '# 注释',
      '- id: deepseek-account',
      '  disabled: true',
      '- id: llm-deepseek',
      '  disabled: false',
      '- insert:',
      '    - id: forge-market',
      "      name: '@heluo/forge-market'",
      '      inject: [tools]',
      '- insert:',
      '    - id: nameless',
    ].join('\n'),
  );
  assert.deepEqual(parsed.disabled, ['deepseek-account']);
  assert.deepEqual(parsed.inserted, [
    { id: 'forge-market', name: '@heluo/forge-market' },
    { id: 'nameless', name: undefined },
  ]);
});
