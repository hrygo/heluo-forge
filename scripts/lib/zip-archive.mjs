/**
 * Read a zip archive back from its own bytes (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * The primary runtime unpacks Python wheels and the Windows Node.js archive
 * itself: no package manager, no archive tool, no lifecycle script. Like
 * `bundle-archive.mjs`, this reader only understands what those archives use —
 * a single-disk zip of stored or deflated regular files — and refuses
 * encryption, ZIP64, links and every other member type as unsupported instead
 * of guessing. Every file is held to the size and the CRC-32 its directory
 * entry records before it is returned.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_FILE_FIXED = 30;
const CENTRAL_FILE_FIXED = 46;
const END_OF_CENTRAL_FIXED = 22;
const MAX_COMMENT_BYTES = 0xffff;
const UNSIGNED_MAX = 0xffffffff;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x01;
const STRONG_ENCRYPTION = 0x40;

/**
 * Resource budget for reading one archive. A locked wheel is a few tens of MiB
 * compressed and inflates to a few times that; the bounds keep a corrupt or
 * hostile file from inflating without limit.
 */
export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
});

/** Archive failures carry a stable category so callers can diagnose them. */
export class ZipError extends Error {
  constructor(code, message) {
    super(`zip archive: ${message}`);
    this.name = 'ZipError';
    this.code = code;
  }
}

const fail = (message, code = 'ZIP_CORRUPT') => {
  throw new ZipError(code, message);
};
const tooLarge = (message) => fail(message, 'ZIP_TOO_LARGE');
const unsupported = (message) => fail(message, 'ZIP_UNSUPPORTED');

const CRC_TABLE = new Int32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value;
}

/** The CRC-32 a zip directory records for each member. */
export function crc32(bytes) {
  let value = -1;
  for (let index = 0; index < bytes.length; index += 1) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}

/** The record that ends the directory, found only where a comment of its own length follows it. */
function findEndOfCentralDirectory(bytes) {
  const last = bytes.length - END_OF_CENTRAL_FIXED;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let offset = last; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = bytes.readUInt16LE(offset + 20);
    if (offset + END_OF_CENTRAL_FIXED + commentBytes === bytes.length) return offset;
  }
  return fail('no end of central directory record');
}

/**
 * The member path as it is written below the extraction directory: relative,
 * with ordinary names only. A leading `./` prefixes every member in archives
 * some tools write and carries no meaning of its own.
 */
function memberPath(raw, directory) {
  if (raw === '' || raw.includes('\0') || raw.includes('\\')) fail('unsafe member path');
  if (raw.startsWith('/')) fail('unsafe member path: absolute');
  const path = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const parts = path.split('/');
  const unsafe = parts.some((part, index) => !(index === 0 && part === '.' && parts.length > 1) && (part === '' || part === '.' || part === '..'));
  if (unsafe) fail('unsafe member path: leaves the extraction directory');
  return path;
}

/** Inflate one file and hold it to the size and the CRC-32 its directory entry records. */
function memberContent(bytes, { path, localOffset, method, compressedBytes, size, expectedCrc }) {
  if (localOffset + LOCAL_FILE_FIXED > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    fail(`truncated local header of "${path}"`);
  }
  const start = localOffset + LOCAL_FILE_FIXED + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
  const end = start + compressedBytes;
  if (end > bytes.length) fail(`truncated content of "${path}"`);
  const stored = bytes.subarray(start, end);
  let content;
  try {
    // An empty member can still be deflated, and the output bound must be at least one byte.
    content = method === STORED ? Buffer.from(stored) : inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') tooLarge(`member "${path}" inflates beyond its recorded size`);
    fail(`member "${path}" cannot be inflated (${error?.message ?? 'UNKNOWN'})`);
  }
  if (content.length !== size) fail(`member "${path}" inflates to ${content.length} bytes, not the recorded ${size}`);
  if (crc32(content) !== expectedCrc) fail(`member "${path}" fails its CRC-32`);
  return content;
}

/**
 * Parse one zip archive into its entries.
 *
 * @param {string | Uint8Array} source archive path or raw bytes
 * @param {{ withContent?: boolean, limits?: object }} [options] keep each file body
 * @returns {Array<{ path: string, size: number, crc32: number, mode: string, directory: boolean, content?: Buffer }>}
 */
export function readZipEntries(source, { withContent = false, limits = ZIP_LIMITS } = {}) {
  if (!Number.isSafeInteger(limits?.archiveBytes) || !Number.isSafeInteger(limits?.totalBytes) || !Number.isSafeInteger(limits?.fileBytes)) {
    fail('invalid archive budget');
  }
  const bytes = typeof source === 'string' ? readFileSync(source) : source;
  if (!(bytes instanceof Uint8Array)) fail('source must be an archive path or a buffer');
  if (bytes.length > limits.archiveBytes) tooLarge(`archive is ${bytes.length} bytes, budget ${limits.archiveBytes}`);

  const end = findEndOfCentralDirectory(bytes);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) unsupported('multi-disk archives');
  const count = bytes.readUInt16LE(end + 10);
  const directoryBytes = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryBytes === UNSIGNED_MAX || directoryStart === UNSIGNED_MAX) unsupported('ZIP64 archives');
  if (directoryStart + directoryBytes !== end) fail('the central directory does not end at its record');

  const entries = [];
  const seen = new Set();
  let totalBytes = 0;
  let offset = directoryStart;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_FILE_FIXED > end || bytes.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) fail('truncated central directory');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedBytes = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const unixMode = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xffff;
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + CENTRAL_FILE_FIXED, offset + CENTRAL_FILE_FIXED + nameBytes).toString('utf8');
    offset += CENTRAL_FILE_FIXED + nameBytes + extraBytes + commentBytes;
    if ((flags & ENCRYPTED) !== 0 || (flags & STRONG_ENCRYPTION) !== 0) unsupported(`encrypted member "${name}"`);
    if (method !== STORED && method !== DEFLATED) unsupported(`compression method ${method} of "${name}"`);
    if (compressedBytes === UNSIGNED_MAX || size === UNSIGNED_MAX || localOffset === UNSIGNED_MAX) unsupported(`ZIP64 member "${name}"`);
    const fileType = unixMode & FILE_TYPE_MASK;
    if (fileType !== 0 && fileType !== REGULAR_FILE && fileType !== DIRECTORY) unsupported(`member "${name}" is not a regular file`);
    const directory = name.endsWith('/') || fileType === DIRECTORY;
    const path = memberPath(name, directory);
    if (seen.has(path)) fail(`duplicate member "${path}"`);
    seen.add(path);
    if (size > limits.fileBytes) tooLarge(`member "${path}" is ${size} bytes, budget ${limits.fileBytes}`);
    totalBytes += size;
    if (totalBytes > limits.totalBytes) tooLarge(`inflated content exceeds the budget of ${limits.totalBytes} bytes`);

    const entry = { path, size, crc32: expectedCrc, mode: (unixMode & 0o777 || 0o644).toString(8).padStart(4, '0'), directory };
    if (withContent && !directory) entry.content = memberContent(bytes, { path, localOffset, method, compressedBytes, size, expectedCrc });
    entries.push(entry);
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
