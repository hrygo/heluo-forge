#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultKeyPath, keyIdFromPublicKey } from './lib.mjs';

function usage() {
  return `usage: node scripts/sensitive-scan/keygen.mjs [--key-file <path>]

Generate the shared team Ed25519 key once, under an authorized custodian's control.
Prints only the public PEM; store the private key outside the repository and
share it securely with the team. Existing files are never overwritten.`;
}

try {
  const args = process.argv.slice(2);
  let keyFile = defaultKeyPath();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--key-file') keyFile = args[++index] ?? '';
    else if (args[index] === '--help' || args[index] === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown argument: ${args[index]}`);
  }
  if (!keyFile) throw new Error('--key-file must not be empty');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') chmodSync(keyFile, 0o600);
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }));
  console.error(`Public key SHA-256: ${keyIdFromPublicKey(publicKey)}`);
  console.error('Replace .github/sensitive-scan/team-public-key.pub with the public PEM through review.');
  console.error('Keep the private key outside git and distribute it only via an approved secure channel.');
} catch (error) {
  console.error(`sensitive-scan keygen: ${error.message}`);
  process.exit(1);
}
