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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as electron from 'electron';

import { diagnosticLogPath } from './diagnostic.mjs';
import { fail } from './errors.mjs';
import { EMBEDDED_ENTRY } from './embedded-cli.mjs';
import { ASSETS_DIR, BIN_DIR, DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS, STATUS_PAGE_PARTS, TITLE_BAR_PARTS, TRAY_ICON_PARTS } from './layout.mjs';
import { embeddedExec, embeddedScriptExec, runCommand } from './process.mjs';
import { createRuntime } from './runtime.mjs';
import { startShell } from './shell.mjs';
import { childEnvironment, loginShellArgs, loginShellFallbackArgs, parseNulEnv, parseShellEnv } from './shell-env.mjs';

const PROFILE = 'web';
const BIND_HOST = '127.0.0.1';
const DSH_ENTRY = join(process.resourcesPath, ...DSH_ENTRY_PARTS);
const PNPM_ENTRY = join(process.resourcesPath, ...PNPM_ENTRY_PARTS);
const TRAY_ICON = join(process.resourcesPath, ...TRAY_ICON_PARTS);
// The title bar's bridge is app code, not a staged resource: it ships beside this file.
const TITLE_BAR_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'window-chrome.preload.cjs');

/** The user's login shell, asked for its environment the way a terminal has it. */
async function environmentForChildren() {
  const options = { shell: process.env.SHELL ?? '' };
  const ask = (args) => runCommand(args[0], args.slice(1), { timeout: 15_000 });
  const primary = loginShellArgs(options);
  const fallback = loginShellFallbackArgs(options);
  // `env -0` keeps a value's newlines. Where the shell's `env` has no `-0` the
  // line form is used; a login shell that fails or prints nothing leaves the
  // GUI environment in place.
  let loginEnv = {};
  if (primary !== null) {
    const asked = await ask(primary);
    if (asked.code === 0) loginEnv = parseNulEnv(asked.stdout);
    else loginEnv = parseShellEnv((await ask(fallback)).stdout);
  }
  // The shell's own variables never reach a child; ELECTRON_RUN_AS_NODE is set per child.
  return childEnvironment(process.env, loginEnv, { prepend: [join(process.resourcesPath, BIN_DIR)] });
}

/** The directory of the profile the shell installs into. The rule is the installer's own for `$DSH_HOME` (dshHomeOf): the two must change together. */
function profileDirectory(env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', PROFILE);
}

/** The web profile's process: this app's binary as Node, running the embedded dsh through the shell's entry. */
function spawnProfile(env) {
  return () => {
    const child = spawn(process.execPath, [EMBEDDED_ENTRY, '--profile', PROFILE, '--host', BIND_HOST, '--no-open'], {
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
    assetsCandidates: [join(process.resourcesPath, ASSETS_DIR), join(dirname(process.execPath), ASSETS_DIR)],
    markerPath: join(electron.app.getPath('userData'), 'first-run.json'),
    // The first run and every reported failure are written here; the status page names the file.
    diagnosticLog: diagnosticLogPath(electron.app.getPath('userData')),
    profile: PROFILE,
    bindHost: BIND_HOST,
    // The embedded runtime is where the installer put it, and so is the pnpm
    // every package operation runs. Said here, that is an explanation; found
    // missing later, each is a service that leaves at once.
    preflight: () => {
      if (!existsSync(DSH_ENTRY)) fail('EMBEDDED_RUNTIME_MISSING', 'the embedded runtime entry is missing');
      if (!existsSync(PNPM_ENTRY)) fail('EMBEDDED_RUNTIME_MISSING', 'the bundled pnpm entry is missing');
      if (!existsSync(TITLE_BAR_PRELOAD)) fail('TITLE_BAR_MISSING', 'the title bar bridge is missing');
    },
    embeddedCommand: process.execPath,
    env,
    // The installer may run only the embedded runtime: this binary as Node, through the shell's entry,
    // which hands dsh the bundled pnpm for every package operation. The plugin's own CLI — the secret
    // provisioning commands — runs through the script executor instead: dsh would read that script's
    // path as a profile name, so nothing of dsh is put in front of it.
    exec: embeddedExec({ command: process.execPath, entry: EMBEDDED_ENTRY, env }),
    scriptExec: embeddedScriptExec({ command: process.execPath, profileDir: profileDirectory(env), env }),
    loadInstaller: (path) => import(pathToFileURL(path).href).then((module) => module.runInit),
    createRuntime,
    spawnProfile: spawnProfile(env),
    trayIcon: TRAY_ICON,
    statusPage: join(process.resourcesPath, ...STATUS_PAGE_PARTS),
    titleBarPage: join(process.resourcesPath, ...TITLE_BAR_PARTS),
    titleBarPreload: TITLE_BAR_PRELOAD,
  }).outcome;
}

main().catch((error) => {
  process.stderr.write(`${typeof error?.code === 'string' ? error.code : 'FAILED'}: ${error?.message ?? error}\n`);
  electron.app.quit();
  process.exitCode = 1;
});
