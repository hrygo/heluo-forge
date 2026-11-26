import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkDevelopmentSdk(manifest, baseline) {
  return Object.entries(manifest.devDependencies ?? {})
    .filter(([name, version]) => name.startsWith('@deepseek-ai/dsh-') && version !== baseline)
    .map(([name, version]) => name + ' ' + version + ' differs from .dsh-version ' + baseline);
}

export function verifyDevelopmentSdk(root = packageRoot) {
  const baseline = readFileSync(resolve(root, '..', '..', '.dsh-version'), 'utf8').trim();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(checkDevelopmentSdk(manifest, baseline), [], 'development SDK pins must follow .dsh-version');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDevelopmentSdk();
}
