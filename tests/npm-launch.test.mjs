import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { npmLaunch } from '../scripts/lib/bundle-rules.mjs';

// Windows refuses `execFile('npm.cmd')` without a shell, and a shell would
// re-split paths that contain spaces. These cases pin the resolution order that
// lets every platform start the npm belonging to its own Node process.
const execPath = join('/fake', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const sysdir = join('/fake', 'node', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const posix = join('/fake', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

test('the CLI script next to the binary wins over any shim', () => {
  const launch = npmLaunch(execPath, (path) => path === sysdir || path === posix);
  assert.deepEqual(launch, { command: execPath, prefix: [sysdir] });
});

test('a POSIX layout resolves through <prefix>/lib', () => {
  const launch = npmLaunch(execPath, (path) => path === posix);
  assert.deepEqual(launch, { command: execPath, prefix: [posix] });
});

test('without the CLI script the platform shim stays the fallback', () => {
  const launch = npmLaunch(execPath, () => false);
  assert.deepEqual(launch.prefix, []);
  assert.equal(launch.command, 'npm');
});
