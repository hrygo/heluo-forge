/**
 * Shared release-artifact primitives (issue #222).
 *
 * Everything here is about *evidence*, not packaging policy: digests, atomic
 * writes, structured reads and the one sensitive-content scan used both on
 * staging files and on archive entries. Keeping the scan in one place matters:
 * "the public build has no enterprise secret" must be judged by the same rule
 * the repository checker applies, not by a second, weaker regex list.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { HOST_PATH, SECRETS } from './sensitive-patterns.mjs';

export const SHA256 = /^[0-9a-f]{64}$/u;

const TEXT_FILE = /\.(md|mjs|cjs|js|json|ya?ml|txt|html|css|ts|tsx|sh|toml|ini|cfg)$/iu;
const FORBIDDEN_NAMES = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519))$/u;
const ALLOW_MARKER = 'security-scan: allow';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha256Of = (text) => sha256(Buffer.from(text, 'utf8'));

export function parseDigest(value, field = 'digest') {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`release: ${field} must be a lowercase sha256 hex digest`);
  }
  return value;
}

/** Archive paths are relative, `/`-separated and never escape their root. */
export function safeRelativePath(value, field = 'path') {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) throw new Error(`release: ${field} must be a non-empty string`);
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    throw new Error(`release: unsafe ${field} "${value}"`);
  }
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`release: unsafe ${field} "${value}"`);
  }
  return value;
}

/** Output must never land inside the source checkout (它会被误提交/误打包). */
export function assertOutsideDirectory(target, forbidden, label = 'output') {
  const from = resolve(forbidden);
  const to = resolve(target);
  const rel = relative(from, to);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`release: ${label} "${target}" must be outside ${from}`);
  }
  return to;
}

export function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

/** Write then rename in the same directory: a crash leaves the old bytes, never half a file. */
export function atomicWrite(path, bytes) {
  mkdirp(dirname(path));
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o644 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function readJsonFile(path, label = 'JSON file') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`release: cannot read ${label} "${path}": ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`release: ${label} "${path}" is not valid JSON`);
  }
}

/**
 * Scan one text body.
 *
 * The allow marker is deliberately NOT honored here: an artifact offered to
 * employees or the public cannot inherit a "reviewed, keep it" exemption from a
 * source line. Callers may only exempt a whole file type, never a line.
 *
 * @returns {string[]} labels, never the matched value
 */
export function scanText(text, { hostPaths = true } = {}) {
  const findings = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (hostPaths && HOST_PATH.test(line)) findings.push(`line ${index + 1}: host-specific absolute path`);
    for (const [pattern, label] of SECRETS) {
      if (pattern.test(line)) findings.push(`line ${index + 1}: possible ${label}`);
    }
  }
  return findings;
}

/**
 * Scan the files that will be shipped.
 *
 * @param {Array<{path: string, body: Buffer | string}>} files
 * @param {{publicOnly?: boolean}} [options]
 */
export function scanReleaseFiles(files, { publicOnly = false } = {}) {
  const problems = [];
  for (const file of files) {
    const path = file.path;
    if (FORBIDDEN_NAMES.test(path)) {
      problems.push(`package/${path}: credential-like file name is not allowed in a release`);
      continue;
    }
    if (!TEXT_FILE.test(path)) continue;
    const text = Buffer.isBuffer(file.body) ? file.body.toString('utf8') : String(file.body ?? '');
    for (const finding of scanText(text, { hostPaths: publicOnly })) {
      problems.push(`package/${path}: ${finding} (value not printed)`);
    }
  }
  return problems;
}

/** A redacted inventory for logs/reports: keys only, never values. */
export function describeConfigKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('release: config keys must be an array');
  return keys.map((key) => safeRelativePath(key, 'config key')).filter((key) => !/SECRET|TOKEN|PASSWORD/iu.test(key)).sort();
}
