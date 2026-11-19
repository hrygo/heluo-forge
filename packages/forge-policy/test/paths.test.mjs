import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalize, matchProtected, PolicyPathError, resolveProtectedRoots } from '../src/paths.mjs';

const base = mkdtempSync(join(tmpdir(), 'forge-policy-paths-'));
const protectedRoot = join(base, 'protected');
const outside = join(base, 'outside');
mkdirSync(protectedRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(protectedRoot, 'secret.txt'), 'canary-value');
writeFileSync(join(outside, 'readme.txt'), 'ok');
symlinkSync(protectedRoot, join(base, 'alias'), 'dir');
const roots = [{ raw: protectedRoot, root: protectedRoot }];

test('a protected root template resolves from the environment', () => {
  const resolved = resolveProtectedRoots(['$DSH_HOME/**'], { DSH_HOME: '/var/empty/dsh-home' });
  assert.deepEqual(resolved, [{ raw: '$DSH_HOME/**', root: '/var/empty/dsh-home' }]);
  assert.deepEqual(resolveProtectedRoots([], {}), []);
});

test('an unresolvable or non-absolute protected root refuses the mount', () => {
  assert.throws(
    () => resolveProtectedRoots(['$DSH_AGENTS_HOME/**'], {}),
    (error) => error instanceof PolicyPathError && error.code === 'POLICY_PROTECTED_ROOT_UNRESOLVED',
  );
  assert.throws(
    () => resolveProtectedRoots(['relative/path'], {}),
    (error) => error.code === 'POLICY_PROTECTED_ROOT_NOT_ABSOLUTE',
  );
  assert.throws(
    () => resolveProtectedRoots([''], {}),
    (error) => error.code === 'POLICY_PROTECTED_ROOT_INVALID',
  );
});

test('a direct child, a traversal alias and a symlink alias all hit the root', () => {
  assert.equal(matchProtected(join(protectedRoot, 'secret.txt'), roots).protected, true);
  assert.equal(matchProtected(join(outside, '..', 'protected', 'secret.txt'), roots).protected, true);
  assert.equal(matchProtected(join(base, 'alias', 'secret.txt'), roots).protected, true);
  assert.equal(matchProtected(join(protectedRoot, 'not-created-yet.txt'), roots).protected, true, 'a non-existent target still compares inside the root');
  assert.equal(matchProtected(join(protectedRoot, '..', 'outside', 'readme.txt'), roots).protected, false);
});

test('a sibling with the same textual prefix is not protected', () => {
  const sibling = `${protectedRoot}-backup`;
  mkdirSync(sibling, { recursive: true });
  assert.equal(matchProtected(join(sibling, 'secret.txt'), roots).protected, false);
});

test('the root itself is protected but its parent is not', () => {
  assert.equal(matchProtected(protectedRoot, roots).protected, true);
  assert.equal(matchProtected(base, roots).protected, false);
});

test('relative paths and unverifiable paths raise instead of passing', () => {
  assert.throws(
    () => canonicalize('relative/secret.txt'),
    (error) => error.code === 'POLICY_PATH_NOT_ABSOLUTE',
  );
  assert.throws(
    () => canonicalize('', {}),
    (error) => error.code === 'POLICY_PATH_INVALID',
  );
  const denied = { platform: 'linux', resolve: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.throws(
    () => canonicalize('/var/empty/secret', denied),
    (error) => error.code === 'POLICY_PATH_UNRESOLVABLE',
  );
});

test('case folding follows the platform, not the filesystem', () => {
  const lexical = { resolve: (value) => value };
  assert.equal(canonicalize('/VAR/EMPTY/DSH', { platform: 'darwin', ...lexical }), '/var/empty/dsh');
  assert.equal(canonicalize('/VAR/EMPTY/DSH', { platform: 'linux', ...lexical }), '/VAR/EMPTY/DSH');
  const mixed = { raw: '/var/empty/dsh', root: '/var/empty/dsh' };
  assert.equal(matchProtected('/VAR/EMPTY/DSH/.env', [mixed], { platform: 'darwin', ...lexical }).protected, true);
  assert.equal(matchProtected('/VAR/EMPTY/DSH/.env', [mixed], { platform: 'linux', ...lexical }).protected, false);
});

test('dot-dot after a symlink follows the link target, not the link name', () => {
  // `<base>/link` points into the protected root, so `<base>/link/../secret`
  // reaches `<base>/data/secret` at the syscall level. A lexical fold would
  // read it as `<base>/secret` and let it through, so the check must resolve
  // the symlink before applying `..`.
  const base = mkdtempSync(join(tmpdir(), 'policy-symlink-'));
  try {
    mkdirSync(join(base, 'data', 'sub'), { recursive: true });
    symlinkSync(join(base, 'data', 'sub'), join(base, 'link'));
    const roots = [{ raw: join(base, 'data'), root: join(base, 'data') }];
    const throughLink = matchProtected(`${base}/link/../secret.txt`, roots);
    assert.equal(throughLink.protected, true);
    const physical = matchProtected(join(realpathSync(base), 'data', 'secret.txt'), []).canonical;
    assert.equal(throughLink.canonical, physical, 'the canonical form must be the physical target');
    // The same-shaped path without a symlink stays outside the root.
    const plain = matchProtected(`${base}/other/../secret.txt`, roots);
    assert.equal(plain.protected, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
