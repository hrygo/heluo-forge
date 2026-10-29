import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { runInNewContext } from 'node:vm';

// Exercise the actual installer helper with Windows path semantics on any host.
test('installer resolves an 8.3 worktree alias despite realpath casing differences', () => {
  const source = readFileSync(new URL('../scripts/sensitive-scan/team-full-install.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeRepoAlias(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const root = 'C:\\Fixtures\\RunnerAdmin\\repo';
  const alias = 'C:\\Fixtures\\RUNNER~1\\repo';
  const helper = runInNewContext(`(${source.slice(start, end)})`, {
    ...win32,
    statIfPresent: (path) => win32.relative(path, alias) === '' ? {} : null,
    realpathSync: (path) => path === root ? root : 'c:\\fixtures\\runneradmin\\repo',
    process: { platform: 'win32' },
  });
  assert.equal(helper(`${alias}\\device-key.pem`, root), `${root}\\device-key.pem`);
});
