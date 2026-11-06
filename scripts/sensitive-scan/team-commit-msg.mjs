#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanMessage, gitOutput, loadKeyPair, stripTrailer } from './lib.mjs';
import { scanChange, signMessage } from './team-attest.mjs';
import { loadGuardContext } from './team-guard.mjs';
import { scanText } from './team-scan.mjs';

// All Git subprocesses, including lib.mjs helpers, must read original objects.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

try {
  const messageFile = process.argv[2];
  if (!messageFile) throw new Error('missing message');
  const { cwd, rules, keyPath } = loadGuardContext();
  const stripped = stripTrailer(readFileSync(messageFile, 'utf8'));
  // Residual legacy v1/v2 trailer metadata must never become signed prose.
  if (/^Sensitive-Scan: v[12]\s*$[\s\S]*^Sensitive-Scan-Rules:/mi.test(stripped)) throw new Error('legacy trailer blocked');
  const body = cleanMessage(stripped);
  if (!body.trim() || scanText(body, rules).length) throw new Error('blocked');
  const mergePath = resolve(cwd, gitOutput(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd }).trim());
  if (existsSync(mergePath)) throw new Error('merge unsupported');
  const head = gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim();
  const parentTree = gitOutput(['rev-parse', `${head}^{tree}`], { cwd }).trim();
  const tree = gitOutput(['write-tree'], { cwd }).trim();
  scanChange({ cwd, parentTree, tree, rules });
  if (gitOutput(['write-tree'], { cwd }).trim() !== tree || gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim() !== head || existsSync(mergePath)) throw new Error('scan baseline changed');
  const key = loadKeyPair(keyPath);
  const message = signMessage({ body, tree, parentTree, key });
  if (gitOutput(['write-tree'], { cwd }).trim() !== tree || gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd }).trim() !== head || existsSync(mergePath)) throw new Error('scan baseline changed');
  writeFileSync(messageFile, message, 'utf8');
  console.error('sensitive-scan: clean; attestation written');
} catch {
  // Never print error messages: they can contain rule text, paths or key material.
  console.error('sensitive-scan: blocked; scan or signing could not complete');
  process.exitCode = 1;
}
