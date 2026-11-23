import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PROTECTED_NAME_PATTERNS,
  isPathTemplate,
  judgeProtectedPath,
  matchProtectedName,
  resolveProtectedRoots,
} from '../src/paths.mjs';

// P3 · protectPaths 的纯路径层证据：九类名称恒开、作用域=工作区+配置追加根、
// 归一化与大小写折叠沿用 canonicalize 的口径，任何"判不了"都抛错交给门禁 fail closed。
const POSIX = process.platform !== 'win32';

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-policy-protected-'));
  mkdirSync(join(workspace, 'sub'));
  writeFileSync(join(workspace, '.env'), 'SECRET=fixture\n');
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test('nine fixed name patterns cover exactly the documented classes', () => {
  assert.deepEqual(PROTECTED_NAME_PATTERNS, [
    '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '.npmrc', '.netrc', 'credentials*', '*.p12',
  ]);
  for (const name of ['.env', '.env.local', 'cert.pem', 'server.key', 'id_rsa', 'id_rsa.pub', '.npmrc', '.netrc', 'credentials.json', 'store.p12']) {
    assert.notEqual(matchProtectedName(name), undefined, `${name} must be protected`);
  }
  for (const name of ['notes.txt', 'env.example', 'readme.md', 'keynote.txt', 'credential']) {
    assert.equal(matchProtectedName(name), undefined, `${name} must stay writable`);
  }
});

test('the template grammar accepts absolute paths and $VAR roots only', () => {
  assert.equal(isPathTemplate('/tmp/vault/**'), true);
  assert.equal(isPathTemplate('$DSH_HOME/vault/**'), true);
  assert.equal(isPathTemplate('$DSH_HOME'), true);
  assert.equal(isPathTemplate('relative/path'), false);
  assert.equal(isPathTemplate('$1BAD/x'), false);
  assert.equal(isPathTemplate('~/vault'), false);
});

test('name matching folds case on darwin/win32 and stays literal elsewhere', () => {
  assert.equal(matchProtectedName('.ENV', { platform: 'darwin' }), '.env');
  assert.equal(matchProtectedName('CERT.PEM', { platform: 'win32' }), '*.pem');
  assert.equal(matchProtectedName('.ENV', { platform: 'linux' }), undefined);
});

test('a canonical path inside the workspace is judged by its basename', (t) => {
  const workspace = fixture(t);
  const env = judgeProtectedPath(join(workspace, '.env'), { workspaceRoot: workspace });
  assert.equal(env.judged, true);
  assert.equal(env.protected, true);
  assert.equal(env.kind, 'name');
  assert.equal(env.category, 'name:.env');
  assert.deepEqual(env.ruleIds, ['name:.env']);

  const plain = judgeProtectedPath(join(workspace, 'notes.txt'), { workspaceRoot: workspace });
  assert.equal(plain.judged, true);
  assert.equal(plain.protected, false);
});

test('traversal, dot-dot and symlinks are resolved before matching', (t) => {
  const workspace = fixture(t);
  const traversal = judgeProtectedPath(join(workspace, 'sub', '..', '.env'), { workspaceRoot: workspace });
  assert.equal(traversal.protected, true);
  assert.equal(traversal.category, 'name:.env');

  if (POSIX) {
    symlinkSync(join(workspace, '.env'), join(workspace, 'sub', 'allowed-name'));
    const link = judgeProtectedPath(join(workspace, 'sub', 'allowed-name'), { workspaceRoot: workspace });
    assert.equal(link.protected, true, 'the link name must not launder the target');
    assert.equal(link.category, 'name:.env');
  }
});

test('paths outside the workspace are not judged by this rule', (t) => {
  const workspace = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'forge-policy-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const result = judgeProtectedPath(join(outside, '.env'), { workspaceRoot: workspace });
  assert.equal(result.judged, false);
  assert.equal(result.protected, false);
});

test('a sibling directory sharing the workspace prefix is not in scope', (t) => {
  const workspace = fixture(t);
  const sibling = `${workspace}-sibling`;
  mkdirSync(sibling);
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  assert.equal(judgeProtectedPath(join(sibling, '.env'), { workspaceRoot: workspace }).judged, false);
});

test('configured roots extend the scope and report their raw template', (t) => {
  const workspace = fixture(t);
  const vault = mkdtempSync(join(tmpdir(), 'forge-policy-vault-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  writeFileSync(join(vault, 'notes.txt'), 'vault note\n');
  const template = `${vault}/**`;
  const roots = resolveProtectedRoots([template]);

  const inRoot = judgeProtectedPath(join(vault, 'notes.txt'), { workspaceRoot: workspace, roots });
  assert.equal(inRoot.judged, true);
  assert.equal(inRoot.protected, true);
  assert.equal(inRoot.kind, 'root');
  assert.equal(inRoot.category, `root:${template}`);
  assert.deepEqual(inRoot.ruleIds, [`root:${template}`]);

  // 工作区外的普通路径仍不判：追加根只扩大范围，不代表"工作区外一律受保护"。
  assert.equal(judgeProtectedPath(join(tmpdir(), 'no-such-file.txt'), { workspaceRoot: workspace, roots }).judged, false);
});

test('an unavailable or unresolvable workspace scope throws instead of passing', (t) => {
  const workspace = fixture(t);
  assert.throws(
    () => judgeProtectedPath(join(workspace, '.env'), {}),
    (error) => error.code === 'POLICY_PATH_SCOPE_UNAVAILABLE',
  );
  assert.throws(
    () => judgeProtectedPath(join(workspace, '.env'), { workspaceRoot: 'relative/dir' }),
    (error) => error.code === 'POLICY_PATH_NOT_ABSOLUTE',
  );
  if (POSIX) {
    symlinkSync(join(workspace, 'loop-b'), join(workspace, 'loop-a'));
    symlinkSync(join(workspace, 'loop-a'), join(workspace, 'loop-b'));
    assert.throws(
      () => judgeProtectedPath(join(workspace, 'loop-a'), { workspaceRoot: workspace }),
      (error) => error.code === 'POLICY_PATH_UNRESOLVABLE',
    );
  }
});

test('case folding in the judge follows the platform, not the filesystem', (t) => {
  const workspace = fixture(t);
  writeFileSync(join(workspace, 'UPPER.PEM'), 'cert\n');
  const darwin = judgeProtectedPath(join(workspace, 'UPPER.PEM'), { workspaceRoot: workspace, platform: 'darwin' });
  assert.equal(darwin.protected, true);
  assert.equal(darwin.category, 'name:*.pem');
  const linux = judgeProtectedPath(join(workspace, 'UPPER.PEM'), { workspaceRoot: workspace, platform: 'linux' });
  assert.equal(linux.protected, false);
});
