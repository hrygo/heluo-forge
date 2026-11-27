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
import { APP_ARCHIVE_PARTS, ASSETS_DIR, BIN_DIR, DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, STATUS_PAGE_PARTS, TITLE_BAR_PARTS, TRAY_ICON_PARTS, primaryRuntimeNodeParts } from './layout.mjs';
import { resolvePnpmStore } from './pnpm-store.mjs';
import { embeddedExec, embeddedScriptExec, runCommand } from './process.mjs';
import { primaryRuntimeVariable } from './primary-runtime.mjs';
import { createRuntime } from './runtime.mjs';
import { startShell } from './shell.mjs';
import { childEnvironment, loginShellArgs, loginShellFallbackArgs, parseNulEnv, parseShellEnv } from './shell-env.mjs';

/**
 * The one profile the shell owns, under `$DSH_HOME/profiles/`. Not `web`: that
 * profile is the terminal CLI's, and one profile for both let either side
 * change the other's plugins, patch layer and lockfile. Not `desktop`: the dsh
 * command line reserves that name for the official Desktop application. The
 * name is a custom one the installer accepts and creates from the web template.
 * What the terminal shares with the shell is kept above the profiles: sessions
 * and sign-in state under `$DSH_HOME`.
 */
const PROFILE = 'heluo-desktop';
const BIND_HOST = '127.0.0.1';
/**
 * The one port the shell's service listens on. It is fixed so the window keeps
 * the same origin from one start to the next: the Web client keeps drafts,
 * shortcut overrides and layout state in the window's storage, which is keyed
 * by origin, and an origin includes the port. A port handed out by the system
 * (`0`) resets all of that on every start.
 *
 * 30810 is assigned to no one at IANA, lies below the lowest default ephemeral
 * range (Linux starts at 32768), and is not the terminal's default (3080), so a
 * terminal `dsh web` and the shell run at once. What a fixed port costs is that
 * another program on it stops the shell from starting (`PORT_CONFLICT`).
 */
const PORT = '30810';
// Inside the archive, where the embedded runtime travels; checked for here, started only through the entry.
const DSH_ENTRY = join(process.resourcesPath, ...APP_ARCHIVE_PARTS, ...DSH_ENTRY_PARTS);
// The package manager of every dsh package operation: the Node and the pnpm of
// the bundled runtime, whose manifest the environment assembly already accepted.
const RUNTIME_NODE = join(process.resourcesPath, ...primaryRuntimeNodeParts(process.platform));
const RUNTIME_PNPM = join(process.resourcesPath, ...PRIMARY_RUNTIME_PNPM_PARTS);
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
  return {
    ...childEnvironment(process.env, loginEnv, { prepend: [join(process.resourcesPath, BIN_DIR)] }),
    // The bundled runtime is the app's own: named after everything inherited was merged, so nothing inherited names it.
    ...primaryRuntimeVariable(process.resourcesPath),
  };
}

/** The directory of the profile the shell installs into. The rule is the installer's own for `$DSH_HOME` (dshHomeOf): the two must change together. */
function profileDirectory(env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', PROFILE);
}

/**
 * The shell's profile process: this app's binary as Node, running the embedded
 * dsh through the shell's entry. It listens on the shell's own fixed port, so a
 * terminal `dsh web` can run at the same time and the window's origin stays put.
 */
function spawnProfile(env) {
  return () => {
    const child = spawn(process.execPath, [EMBEDDED_ENTRY, '--profile', PROFILE, '--host', BIND_HOST, '--port', PORT, '--no-open'], {
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
    // The embedded runtime is where the installer put it, and every package
    // operation runs the pnpm of the bundled runtime. Said here, that is an
    // explanation; found missing later, each is a service that leaves at once.
    preflight: () => {
      if (!existsSync(DSH_ENTRY)) fail('EMBEDDED_RUNTIME_MISSING', 'the embedded runtime entry is missing');
      if (!existsSync(RUNTIME_NODE) || !existsSync(RUNTIME_PNPM)) fail('EMBEDDED_RUNTIME_MISSING', 'the bundled runtime entry the package operations run from is missing');
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
    // The whole installer module, not just its entry: the first run reads from
    // it what the installer is able to accept before handing anything over.
    loadInstaller: (path) => import(pathToFileURL(path).href),
    // The store the bundled pnpm resolves for the shell's profile, asked of
    // that pnpm once per first-run attempt in the setting the package
    // operations will see. A store it cannot name is simply not handed over:
    // the installer then meets a mismatching store the reactive way.
    pnpmStore: () => resolvePnpmStore({ nodeEntry: RUNTIME_NODE, pnpmEntry: RUNTIME_PNPM, cwd: profileDirectory(env), env }),
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
