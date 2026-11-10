#!/usr/bin/env node
/**
 * Verify a full installer directory without trusting its own claims.
 *
 * Usage: node scripts/verify-full-installer.mjs --installer <dir> [--json]
 * Exit codes: 0 verified, 1 problems found, 2 usage/structural failure.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyFullInstaller } from './lib/full-installer.mjs';

function parseArguments(argv) {
  let installer;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--installer') {
      installer = argv[index + 1];
      index += 1;
      if (installer === undefined) throw new Error('--installer needs a directory');
      continue;
    }
    if (installer !== undefined) throw new Error(`unexpected argument ${argument}`);
    installer = argument;
  }
  if (installer === undefined) throw new Error('usage: verify-full-installer.mjs --installer <dir> [--json]');
  return { installer, json };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { installer, json } = parseArguments(process.argv.slice(2));
    const result = verifyFullInstaller(installer);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.ok ? `verified: ${installer}` : `problems in ${installer}:`);
      for (const problem of result.problems) console.log(`- ${problem}`);
      if (result.ok) console.log(JSON.stringify(result.summary, null, 2));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

export { parseArguments };
