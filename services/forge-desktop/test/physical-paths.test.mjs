/**
 * Physical path tests of the desktop shell.
 *
 * The embedded runtime travels inside the app's archive. Electron lets a
 * process that loaded from the archive read it, load its unpacked native
 * libraries and `execFile` an unpacked program by its archive path, but
 * `spawn` of that same program fails with ENOTDIR. The entry therefore hands
 * the operating system the physical copy of whatever it is asked to execute
 * with. Every rule here is pure, so the negative cases below prove it fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { promisify } from 'node:util';

import { APP_ARCHIVE_PARTS } from '../src/layout.mjs';
import { archiveRootOf, createPhysicalPath, installPhysicalPaths } from '../src/physical-paths.mjs';

const RESOURCES = '/apps/Heluo.app/Contents/Resources';
const ARCHIVE = `${RESOURCES}/${APP_ARCHIVE_PARTS[0]}`;
const UNPACKED = `${ARCHIVE}.unpacked`;

/** A translator over a disk that holds exactly `unpacked`, and a record of what it was asked about. */
function fixture(unpacked = []) {
  const onDisk = new Set(unpacked);
  const asked = [];
  const exists = (path) => {
    asked.push(path);
    return onDisk.has(path);
  };
  return { asked, physical: createPhysicalPath({ archiveRoot: ARCHIVE, exists, platform: 'darwin' }) };
}

/** A stand-in for `node:child_process`: every call is recorded, every return value is the call itself. */
function fakeChildProcess() {
  const calls = [];
  const recorder = (name) => function recorded(...args) {
    calls.push({ name, args, receiver: this });
    return `${name}:${args.length}`;
  };
  const module = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) module[name] = recorder(name);
  return { calls, module };
}

test('the archive a path leads into: only a real segment counts, and only a string can lead into one', () => {
  assert.deepEqual(APP_ARCHIVE_PARTS, ['app.asar']);
  assert.equal(archiveRootOf(`${ARCHIVE}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`), ARCHIVE);
  assert.equal(archiveRootOf(`${ARCHIVE}/src/embedded-cli.mjs`), ARCHIVE);
  // A staged tree outside any archive, the unpacked tree itself, and a name that merely starts alike lead nowhere.
  for (const outside of ['/apps/Resources/dsh/lib/bin.js', `${UNPACKED}/dsh/lib/bin.js`, `${ARCHIVE}-other/dsh/lib/bin.js`]) {
    assert.equal(archiveRootOf(outside), null, outside);
  }
  for (const notAPath of [undefined, null, 42, '']) assert.equal(archiveRootOf(notAPath), null);
});

test('a path inside the archive becomes its physical copy when that copy is on disk, and stays what it was otherwise', () => {
  const executable = `${ARCHIVE}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  const programDirectory = `${ARCHIVE}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program`;
  const { asked, physical } = fixture([`${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`, `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program`]);
  // The file the loader would have refused to spawn, and a directory a native process reads.
  assert.equal(physical(executable), `${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`);
  assert.equal(physical(programDirectory), `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program`);
  // Packed only: there is no physical copy, so the value is left for the caller's own error.
  assert.equal(physical(`${ARCHIVE}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`), `${ARCHIVE}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`);
  // Already physical: translated again it would name a tree that does not exist.
  assert.equal(physical(`${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`), `${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`);
  // Only what is under the archive is examined: the disk is not asked about anything else.
  assert.deepEqual(asked, [`${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`, `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program`, `${UNPACKED}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`]);
});

test('反向：归档之外、非字符串、同名前缀与归档根本身都不被改写', () => {
  const { asked, physical } = fixture([`${UNPACKED}/x`]);
  for (const untouched of [undefined, null, 7, true, {}, [], '', '/usr/bin/env', 'relative/path', 'C:\\Windows\\System32\\cmd.exe', `${RESOURCES}/primary-runtime/dependencies/node/bin/node`, `${ARCHIVE}-other/x`, ARCHIVE, `${RESOURCES}`]) {
    assert.equal(physical(untouched), untouched, String(untouched));
  }
  // The prefix is the archive and a separator: a longer name that merely starts with it is not inside it.
  assert.equal(physical(`${ARCHIVE}-other/x`), `${ARCHIVE}-other/x`);
  assert.deepEqual(asked, [], 'nothing outside the archive reaches the disk');
});

test('Windows:分隔符与大小写按平台规则处理', () => {
  const onDisk = new Set(['C:\\Apps\\resources\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64\\program\\soffice.exe']);
  const physical = createPhysicalPath({ archiveRoot: 'C:\\Apps\\resources\\app.asar', exists: (path) => onDisk.has(path), platform: 'win32' });
  // dsh spells the path the way it read its own location; the disk is asked with the archive's own spelling.
  assert.equal(physical('c:\\apps\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64\\program\\soffice.exe'), 'C:\\Apps\\resources\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64\\program\\soffice.exe');
  // A separator of the other platform is not a separator here.
  assert.equal(physical('C:\\Apps\\resources\\app.asar/dsh/node_modules/x/y.exe'), 'C:\\Apps\\resources\\app.asar/dsh/node_modules/x/y.exe');
  // POSIX is case-sensitive: the archive's name in another case is another path, and is left alone.
  const differentlyCased = `${ARCHIVE.toUpperCase()}/dsh/node_modules/x/y`;
  assert.equal(createPhysicalPath({ archiveRoot: ARCHIVE, exists: () => true, platform: 'linux' })(differentlyCased), differentlyCased);
});

test('the four functions that start a program hand the operating system physical paths; nothing else is touched', () => {
  const { calls, module } = fakeChildProcess();
  const executable = `${ARCHIVE}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  const physicalExecutable = `${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  const unpackedArgument = `${ARCHIVE}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/types.rdb`;
  const packedArgument = `${ARCHIVE}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`;
  let synced = 0;
  const installed = installPhysicalPaths({
    archiveRoot: ARCHIVE,
    childProcess: module,
    sync: () => { synced += 1; },
    exists: (path) => path === physicalExecutable || path === `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/types.rdb` || path === `${UNPACKED}/src`,
    platform: 'darwin',
  });
  assert.equal(synced, 1, 'the built-in ES module bindings are synchronised once, with the patched exports');
  assert.deepEqual(installed.patched.sort(), ['execFile', 'execFileSync', 'spawn', 'spawnSync']);
  // Shell strings (`exec`) and a Node script of its own (`fork`) are not rewritten: there is no telling a path inside a command line.
  for (const name of ['exec', 'execSync', 'fork']) assert.equal(module[name].name, 'recorded', `${name} is left as it was`);

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    calls.length = 0;
    const receiver = {};
    const options = { env: { NOTE: unpackedArgument, PATH: '/usr/bin:/bin', KEEP: packedArgument }, cwd: `${ARCHIVE}/src`, stdio: 'ignore' };
    const returned = module[name].call(receiver, executable, ['--json', unpackedArgument, packedArgument, 42, null], options);
    assert.equal(returned, `${name}:3`, `${name} returns what the original returned`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, receiver, `${name} keeps the caller as receiver`);
    const [file, args, received] = calls[0].args;
    assert.equal(file, physicalExecutable, `${name}: the program is the physical copy`);
    assert.deepEqual(args, ['--json', `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/types.rdb`, packedArgument, 42, null], `${name}: unpacked arguments become physical, the rest is passed as it was`);
    // A new object: the caller's options are never edited in place.
    assert.notEqual(received, options);
    assert.notEqual(received.env, options.env);
    assert.deepEqual(received, { env: { NOTE: `${UNPACKED}/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/types.rdb`, PATH: '/usr/bin:/bin', KEEP: packedArgument }, cwd: `${UNPACKED}/src`, stdio: 'ignore' }, `${name}: environment values and the working directory follow the same rule`);
    assert.equal(options.env.NOTE, unpackedArgument, `${name}: the caller's environment is unchanged`);
  }
});

test('the two-argument and one-argument forms are understood; options with nothing to translate are passed as the same object', () => {
  const { calls, module } = fakeChildProcess();
  installPhysicalPaths({ archiveRoot: ARCHIVE, childProcess: module, sync: () => {}, exists: () => false, platform: 'darwin' });
  const options = { encoding: 'utf8' };
  module.spawnSync('/usr/bin/true', options);
  // An object in the argument position is the options, passed on where the platform expects them.
  assert.deepEqual(calls.at(-1).args, ['/usr/bin/true', undefined, options]);
  const untouched = { env: { HOME: '/configs/synthetic-home' }, cwd: '/tmp' };
  module.spawn('/bin/ls', ['-la'], untouched);
  assert.equal(calls.at(-1).args[2], untouched, 'nothing under the archive: the caller keeps its own object');
  module.execFile('/usr/bin/true');
  assert.deepEqual(calls.at(-1).args, ['/usr/bin/true', undefined, undefined]);
  module.spawnSync(42);
  assert.deepEqual(calls.at(-1).args, [42, undefined, undefined], 'what is not a string is not a path');
});

test('the callback of `execFile` is passed on where the caller put it', () => {
  const { calls, module } = fakeChildProcess();
  const executable = `${ARCHIVE}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  const physicalExecutable = `${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  installPhysicalPaths({ archiveRoot: ARCHIVE, childProcess: module, sync: () => {}, exists: (path) => path === physicalExecutable || path === `${UNPACKED}/src`, platform: 'darwin' });
  const callback = () => {};
  const options = { cwd: `${ARCHIVE}/src` };
  const translated = { cwd: `${UNPACKED}/src` };
  // `execFile(file, args, options, callback)`: the full form, and the one `util.promisify` calls.
  module.execFile(executable, ['--json'], options, callback);
  assert.deepEqual(calls.at(-1).args, [physicalExecutable, ['--json'], translated, callback]);
  // `execFile(file, options, callback)`: the options in the argument position put the callback one place earlier.
  module.execFile(executable, options, callback);
  assert.deepEqual(calls.at(-1).args, [physicalExecutable, undefined, translated, callback]);
  // A callback in the place of the options stays where it is: the platform finds it there.
  module.execFile(executable, ['--json'], callback);
  assert.deepEqual(calls.at(-1).args, [physicalExecutable, ['--json'], callback]);
  module.execFile(executable, callback);
  assert.deepEqual(calls.at(-1).args, [physicalExecutable, callback, undefined]);
});

test('`promisify(execFile)` keeps what it gives on the platform — `{ stdout, stderr }` and the child — and starts the physical program', async () => {
  const { module } = fakeChildProcess();
  const startedCalls = [];
  // The platform's `execFile`: it starts the child and reports to the callback, and carries the marker `util.promisify` reads.
  function platformExecFile(file, args, options, callback) {
    startedCalls.push({ file, args, options });
    callback(null, 'output', 'errors');
    return 'the child';
  }
  const promised = (execFile) => (...args) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    promise.child = execFile(...args, (error, stdout, stderr) => (error === null ? resolve({ stdout, stderr }) : reject(error)));
    return promise;
  };
  Object.defineProperty(platformExecFile, promisify.custom, { value: promised(platformExecFile) });
  module.execFile = platformExecFile;
  const executable = `${ARCHIVE}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  const physicalExecutable = `${UNPACKED}/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`;
  installPhysicalPaths({ archiveRoot: ARCHIVE, childProcess: module, sync: () => {}, exists: (path) => path === physicalExecutable || path === `${UNPACKED}/src`, platform: 'darwin' });

  const started = promisify(module.execFile)(executable, ['--json'], { cwd: `${ARCHIVE}/src` });
  assert.equal(started.child, 'the child');
  assert.deepEqual(await started, { stdout: 'output', stderr: 'errors' });
  assert.deepEqual(startedCalls, [{ file: physicalExecutable, args: ['--json'], options: { cwd: `${UNPACKED}/src` } }]);
});

test('反向：缺归档根或磁盘探测时拒绝安装，不留下半改的 child_process', () => {
  const { module } = fakeChildProcess();
  const before = { ...module };
  for (const bad of [{ archiveRoot: '' }, { archiveRoot: undefined }, { archiveRoot: `${ARCHIVE}/` }, {}]) {
    assert.throws(
      () => installPhysicalPaths({ ...bad, childProcess: module, sync: () => {}, exists: () => true, platform: 'darwin' }),
      (error) => error?.code === 'BAD_ARGUMENT',
      JSON.stringify(bad),
    );
  }
  for (const name of Object.keys(before)) assert.equal(module[name], before[name], `${name} is still the original`);
});
