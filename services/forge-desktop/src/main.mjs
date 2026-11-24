#!/usr/bin/env node
/**
 * Program entry of the desktop shell: the real `electron`, the paths of the
 * installed app, and nothing else. Every decision lives in the modules beside
 * this file; `shell.mjs` connects them.
 *
 * Not exercised by the offline tests: they drive `shell.mjs` through a
 * stand-in for `electron`. The paths below describe the layout the packaging
 * step will stage and are confirmed when the first installer is built.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as electron from 'electron';

import { embeddedExec, runCommand } from './process.mjs';
import { createRuntime } from './runtime.mjs';
import { startShell } from './shell.mjs';
import { childEnvironment, loginShellArgs, parseShellEnv } from './shell-env.mjs';

const PROFILE = 'web';
const BIND_HOST = '127.0.0.1';
const DSH_ENTRY = join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const TRAY_ICON = join(process.resourcesPath, 'brand', 'tray.png');

/** The user's login shell, asked for its environment the way a terminal has it. */
async function environmentForChildren() {
  const shellArgs = loginShellArgs({ shell: process.env.SHELL ?? '' });
  // A login shell that fails or prints nothing leaves the GUI environment in place.
  const loginEnv = shellArgs === null ? {} : parseShellEnv((await runCommand(shellArgs[0], shellArgs.slice(1), { timeout: 15_000 })).stdout);
  // The shell's own variables never reach a child; ELECTRON_RUN_AS_NODE is set per child.
  return childEnvironment(process.env, loginEnv, { prepend: [join(process.resourcesPath, 'bin')] });
}

/** The web profile's process: this app's binary as Node, running the embedded dsh. */
function spawnProfile(env) {
  return () => {
    const child = spawn(process.execPath, [DSH_ENTRY, '--profile', PROFILE, '--host', BIND_HOST, '--no-open'], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      pid: child.pid,
      kill: (signal) => child.kill(signal),
      exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      output: child.stdout,
      errors: child.stderr,
    };
  };
}

async function main() {
  const env = await environmentForChildren();
  await startShell(electron, {
    platform: process.platform,
    assetsCandidates: [join(process.resourcesPath, 'enterprise-assets'), join(dirname(process.execPath), 'enterprise-assets')],
    markerPath: join(electron.app.getPath('userData'), 'first-run.json'),
    profile: PROFILE,
    bindHost: BIND_HOST,
    embeddedCommand: process.execPath,
    env,
    // The installer may run only the embedded runtime: this binary as Node, with the dsh entry first.
    exec: embeddedExec({ command: process.execPath, entry: DSH_ENTRY, env }),
    loadInstaller: (path) => import(pathToFileURL(path).href).then((module) => module.runInit),
    createRuntime,
    spawnProfile: spawnProfile(env),
    trayIcon: TRAY_ICON,
  }).outcome;
}

main().catch((error) => {
  process.stderr.write(`${typeof error?.code === 'string' ? error.code : 'FAILED'}: ${error?.message ?? error}\n`);
  electron.app.quit();
  process.exitCode = 1;
});
