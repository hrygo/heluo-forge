/**
 * #37 / ADR-12: read a release tarball back from its own bytes.
 *
 * Verification must never trust the staging file list or `npm pack --json`:
 * both describe what the builder *meant* to ship. This module only understands
 * the gzip + ustar container (npm pack emits plain ustar, no pax for this repo),
 * so the caller compares hashes of what actually landed in the archive.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const PACKAGE_PREFIX = 'package/';
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);
const SHA256 = (body) => createHash('sha256').update(body).digest('hex');

const fail = (message) => { throw new Error(`bundle archive: ${message}`); };

/** ustar fields are "0-padded octal, terminated by NUL and/or spaces". */
function readOctal(header, offset, length, field) {
  const slice = header.subarray(offset, offset + length);
  if ((slice[0] & 0x80) !== 0) fail(`unsupported binary ${field} field`);
  const text = slice.toString('latin1').replace(/[\0 ]/gu, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) fail(`invalid ${field} field`);
  return Number.parseInt(text, 8);
}

function readText(header, offset, length) {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

const padded = (size) => Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

/** pax records look like "<len> <key>=<value>\n"; only path/size are meaningful here. */
function readPaxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) fail('malformed pax header');
    const length = Number.parseInt(buffer.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > buffer.length) fail('malformed pax header');
    const record = buffer.subarray(space + 1, offset + length).toString('utf8').replace(/\n$/u, '');
    const equals = record.indexOf('=');
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === 'path') records.path = value;
      else if (key === 'size') {
        const size = Number.parseInt(value, 10);
        if (!Number.isInteger(size) || size < 0) fail('malformed pax size record');
        records.size = size;
      }
      // Other records (comment, mtime, uid...) are intentionally ignored: the
      // manifest is deliberately free of timestamps and ownership.
    }
    offset += length;
  }
  return records;
}

/** npm pack roots every archive at `package/`; anything else is not our artifact. */
function normalizePath(raw, rootPrefix = PACKAGE_PREFIX) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) fail(`unsafe path "${raw}"`);
  if (raw.includes('\\')) fail(`unsafe path "${raw}"`);
  if (!raw.startsWith(rootPrefix)) fail(`unsafe path "${raw}" (expected the ${rootPrefix} prefix)`);
  const relative = raw.slice(rootPrefix.length);
  if (relative === '' || relative.startsWith('/') || relative.endsWith('/') || relative.includes('//')) fail(`unsafe path "${raw}"`);
  if (relative.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`unsafe path "${raw}"`);
  return relative;
}

/**
 * Parse one tarball into its regular files.
 *
 * @param {string | Uint8Array} source tarball path or raw gzip bytes
 * @param {{ withContent?: boolean, prefix?: string }} [options] keep each file body
 *   for structural checks; `prefix` is the archive root (default `package/`), so
 *   the release-tool tarball can be read with its own root.
 * @returns {Array<{ path: string, size: number, sha256: string, mode: string, content?: Buffer }>}
 */
export function readBundleEntries(source, { withContent = false, prefix: rootPrefix = PACKAGE_PREFIX } = {}) {
  if (!rootPrefix.endsWith('/') || rootPrefix.startsWith('/') || rootPrefix.includes('..')) fail(`invalid archive root ${JSON.stringify(rootPrefix)}`);
  const bytes = typeof source === 'string' ? readFileSync(source) : source;
  if (!(bytes instanceof Uint8Array)) fail('source must be a tarball path or buffer');
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch {
    fail('not a gzip stream');
  }
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let pax = {};
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.equals(ZERO_BLOCK)) break;
    const mode = readOctal(header, 100, 8, 'mode');
    const size = readOctal(header, 124, 12, 'size');
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const bodyStart = offset + BLOCK_SIZE;
    if (bodyStart + size > tar.length) fail(`truncated tar: "${name}" declares ${size} bytes`);
    if (typeflag === 'x' || typeflag === 'g') {
      pax = { ...pax, ...readPaxRecords(tar.subarray(bodyStart, bodyStart + size)) };
      offset = bodyStart + padded(size);
      continue;
    }
    if (typeflag === '5') {
      pax = {};
      offset = bodyStart + padded(size);
      continue;
    }
    if (typeflag === '1' || typeflag === '2') fail(`unsupported type "${typeflag}" (link "${name}")`);
    if (typeflag !== '0') fail(`unsupported type "${typeflag}" ("${name}")`);
    if (pax.size !== undefined && pax.size !== size) fail(`unsupported pax size override for "${name}"`);
    const entryPath = normalizePath(pax.path ?? (prefix === '' ? name : `${prefix}/${name}`), rootPrefix);
    pax = {};
    if (seen.has(entryPath)) fail(`duplicate path "${entryPath}"`);
    seen.add(entryPath);
    if (size > MAX_FILE_BYTES) fail(`file too large "${entryPath}" (${size} bytes)`);
    const body = tar.subarray(bodyStart, bodyStart + size);
    const entry = { path: entryPath, size, sha256: SHA256(body), mode: (mode & 0o7777).toString(8).padStart(4, '0') };
    if (withContent) entry.content = body;
    entries.push(entry);
    offset = bodyStart + padded(size);
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** @param {Array<{ size: number }>} entries */
export function summarizeBundle(entries) {
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}
