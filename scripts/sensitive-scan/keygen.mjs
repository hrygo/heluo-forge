#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultKeyPath, keyIdFromPublicKey } from './lib.mjs';

function usage() {
  return `usage: node scripts/sensitive-scan/keygen.mjs --owner <identity> [--key-file <path>] [--force]

Generates an Ed25519 device key, writes the private key with mode 0600, and
prints the public registry entry as JSON. The private key never leaves the
machine. Add the printed entry to .github/sensitive-scan/keys.json by review.`;
}

function parseArgs(argv) {
  const args = { keyFile: defaultKeyPath(), owner: '', force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--owner') args.owner = argv[++index] ?? '';
    else if (value === '--key-file') args.keyFile = argv[++index] ?? '';
    else if (value === '--force') args.force = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.owner) throw new Error('--owner is required (use your enterprise identity, not a display name)');
  if (!args.keyFile) throw new Error('--key-file must not be empty');
  if (existsSync(args.keyFile) && !args.force) {
    throw new Error(`key already exists: ${args.keyFile}; use --force only after revoking the old key`);
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = keyIdFromPublicKey(publicKey);
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(dirname(args.keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(args.keyFile, privatePem, { mode: 0o600 });
  chmodSync(args.keyFile, 0o600);

  const entry = {
    keyId,
    owner: args.owner,
    status: 'active',
    notBefore: new Date().toISOString(),
    notAfter: null,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  console.log(JSON.stringify(entry, null, 2));
  console.error(`private key: ${args.keyFile} (mode 0600)`);
  console.error('next: add the entry above to .github/sensitive-scan/keys.json through review');
} catch (error) {
  console.error(`sensitive-scan keygen: ${error.message}`);
  process.exit(1);
}
