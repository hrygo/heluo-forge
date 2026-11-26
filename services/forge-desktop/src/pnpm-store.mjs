import { isAbsolute } from 'node:path';

import { runCommand } from './process.mjs';

/**
 * The store the bundled pnpm will use for the shell's profile (CORP-DSH-DESIGN-025).
 *
 * The installer can compare two store directories, but it cannot run pnpm
 * itself: in the shell's form the pnpm is the host's, reachable only through
 * dsh. So the shell — the one that owns the payload — asks that pnpm directly,
 * in the same setting the package operations will reach it in (the profile
 * directory as the working directory, the same environment), and hands the
 * answer to the installer as `--pnpm-store`.
 */

/** One attempt to name the store: a store that cannot be named in time is not named at all. */
export const STORE_PROBE_TIMEOUT_MS = 30_000;

/**
 * The store directory the bundled pnpm resolves, or null when it cannot be
 * named. The probe is an input to the installer's own pre-check, never a
 * precondition: every failure here means only that the installer falls back to
 * reacting to pnpm's own refusal, the way it did before the flag existed.
 *
 * A profile directory that does not exist yet (a first run that will create
 * it) makes the probe fail, which is the right answer — there is no recorded
 * store to compare against on a fresh profile.
 *
 * @param {{nodeEntry: string, pnpmEntry: string, cwd?: string, env?: object, run?: Function}} input
 *   `run` is an injection point for tests.
 * @returns {Promise<string|null>} the store directory, absolute, as pnpm printed it
 */
export async function resolvePnpmStore({ nodeEntry, pnpmEntry, cwd, env, run = runCommand }) {
  if (typeof nodeEntry !== 'string' || nodeEntry === '' || typeof pnpmEntry !== 'string' || pnpmEntry === '') return null;
  let result;
  try {
    result = await run(nodeEntry, [pnpmEntry, 'store', 'path'], { cwd, env, timeout: STORE_PROBE_TIMEOUT_MS });
  } catch {
    // The one-shot runner settles instead of throwing; a throw is still only a probe that failed.
    return null;
  }
  if (result.code !== 0) return null;
  const printed = String(result.stdout ?? '')
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const line = printed.length > 0 ? printed[printed.length - 1] : '';
  return line !== '' && isAbsolute(line) ? line : null;
}
