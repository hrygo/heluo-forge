/**
 * Deterministic tar.gz writer for release artifacts (issue #222).
 *
 * `npm pack` can only produce an archive from an extracted package tree, and the
 * private-release maker must replace a patch/config file without trusting a
 * mutable staging directory. Writing the container here has three properties the
 * release contract depends on:
 *
 *   1. every path is `package/`-rooted -- the same prefix
 *      `readBundleEntries()` accepts, so the verifier and the writer cannot drift;
 *   2. timestamps, ownership and gzip mtime are fixed -- two runs over the same
 *      file list produce the same bytes, which is what "same version must mean
 *      the same artifact" needs;
 *   3. no links, no directories, no duplicate or traversing paths -- the archive
 *      is a flat list of regular files by construction.
 *
 * npm pack itself emits ustar + gzip; this writer does the same, using a pax
 * record only when a path does not fit ustar's name/prefix fields.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const BLOCK = 512;
/** 1985-10-26T08:15:00Z: the fixed mtime `npm pack` has used for years. */
export const FIXED_MTIME = 499_162_500;
const PACKAGE_PREFIX = 'package/';
const MAX_PATH_BYTES = 255;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SHA256 = (body) => createHash('sha256').update(body).digest('hex');

const fail = (message) => {
  throw new Error(`bundle writer: ${message}`);
};

function normalizeRelative(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) fail(`unsafe path ${JSON.stringify(path)}`);
  if (path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.includes('//')) fail(`unsafe path "${path}"`);
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`unsafe path "${path}"`);
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) fail(`path too long "${path}"`);
  return path;
}

function checksum(header) {
  let sum = 0;
  for (const byte of header) sum += byte;
  return `${sum.toString(8).padStart(6, '0')}\0 `;
}

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

function header({ name, prefix = '', mode, size, typeflag = '0' }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode & 0o7777, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1'); // uid
  block.write(octal(0, 8), 116, 'latin1'); // gid
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(FIXED_MTIME, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(typeflag, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  if (prefix !== '') block.write(prefix, 345, 155, 'utf8');
  block.write(checksum(block), 148, 'latin1');
  return block;
}

/** `"<length> <key>=<value>\n"`, where the length includes its own digits. */
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, 'utf8') + 2;
  for (;;) {
    const candidate = Buffer.from(`${length} ${body}`, 'utf8');
    if (candidate.length === length) return candidate;
    length = candidate.length;
  }
}

/**
 * Long-name fallback: a pax extended header (`x`) followed by the real entry.
 *
 * The extended header's typeflag must be `x`; writing it as a regular file makes
 * every reader treat `PaxHeaders/entry` as a shipped file, and the following
 * header keeps the entry's own mode rather than a hard-coded 0644.
 */
function paxBlocks(path, { size, mode }) {
  const payload = paxRecord('path', path);
  const record = Buffer.concat([
    header({ name: 'PaxHeaders/entry', mode: 0o644, size: payload.length, typeflag: 'x' }),
    payload,
    Buffer.alloc((BLOCK - (payload.length % BLOCK)) % BLOCK),
  ]);
  return [record, header({ name: lastSegment(path), mode, size })];
}

function lastSegment(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (Buffer.byteLength(name, 'utf8') > 100) fail(`path segment too long "${path}"`);
  return name;
}

/** Try ustar's prefix/name split before falling back to pax. */
function locate(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && name !== '' && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  return undefined;
}

/**
 * @param {Array<{path: string, body: Buffer | Uint8Array | string, mode?: number}>} files
 * @returns {Buffer}
 */
export function writeBundleTarball(files, { prefix = PACKAGE_PREFIX } = {}) {
  if (!Array.isArray(files) || files.length === 0) fail('entries must be a non-empty array');
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('..') || prefix.includes('\\')) {
    fail(`invalid archive prefix ${JSON.stringify(prefix)}`);
  }
  const normalized = files.map((file) => {
    const path = normalizeRelative(file?.path);
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? '', 'utf8');
    if (body.length > MAX_FILE_BYTES) fail(`file too large "${path}"`);
    const mode = file.mode ?? 0o644;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) fail(`invalid mode for "${path}"`);
    return { path: `${prefix}${path}`, body, mode };
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const seen = new Set();
  const chunks = [];
  for (const file of normalized) {
    if (seen.has(file.path)) fail(`duplicate path "${file.path}"`);
    seen.add(file.path);
    const padding = Buffer.alloc((BLOCK - (file.body.length % BLOCK)) % BLOCK);
    const located = locate(file.path);
    if (located === undefined) {
      const [pax, entry] = paxBlocks(file.path, { size: file.body.length, mode: file.mode });
      chunks.push(pax, entry, file.body, padding);
      continue;
    }
    chunks.push(header({ ...located, mode: file.mode, size: file.body.length }), file.body, padding);
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Entries as the manifest expects them: path without `package/`, size/hash/mode. */
export function tarballEntries(files) {
  return files.map((file) => {
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? '', 'utf8');
    return {
      path: normalizeRelative(file.path),
      size: body.length,
      sha256: SHA256(body),
      mode: (file.mode ?? 0o644).toString(8).padStart(4, '0'),
    };
  });
}
