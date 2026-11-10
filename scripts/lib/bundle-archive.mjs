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
import { gunzipSync, gzipSync } from 'node:zlib';

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
function normalizePath(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) fail(`unsafe path "${raw}"`);
  if (raw.includes('\\')) fail(`unsafe path "${raw}"`);
  if (!raw.startsWith(PACKAGE_PREFIX)) fail(`unsafe path "${raw}" (expected the package/ prefix)`);
  const relative = raw.slice(PACKAGE_PREFIX.length);
  if (relative === '' || relative.startsWith('/') || relative.endsWith('/') || relative.includes('//')) fail(`unsafe path "${raw}"`);
  if (relative.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`unsafe path "${raw}"`);
  return relative;
}

/**
 * Parse one tarball into its regular files.
 *
 * @param {string | Uint8Array} source tarball path or raw gzip bytes
 * @param {{ withContent?: boolean }} [options] keep each file body for structural checks
 * @returns {Array<{ path: string, size: number, sha256: string, mode: string, content?: Buffer }>}
 */
export function readBundleEntries(source, { withContent = false } = {}) {
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
    const entryPath = normalizePath(pax.path ?? (prefix === '' ? name : `${prefix}/${name}`));
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

/** 写一个 ustar 数值字段：`0` 填充的八进制、以 NUL 结束。 */
function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(`${text}\0`, offset, length, 'latin1');
}

/** 重算头部校验和（先按空格占位，再写入 6 位八进制 + NUL + 空格）。 */
function writeChecksum(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) sum += header[index];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
}

/**
 * 把声明为 bin 的条目在 tar 头里补成 0755，并重新 gzip。
 *
 * `npm pack` 在 Windows 上只能写出 0644（NTFS 不保存 POSIX 位），构建出的发布包因此
 * 在 Unix 侧看起来"bin 不可执行"。这里按字节改头部而不是另起一套打包器：条目内容、
 * 顺序、大小与 pax 记录都不动，只把 `mode` 字段和校验和改对。
 *
 * `normalizePath` 会剥掉 ustar 头里的 `package/` 前缀，所以比对的是相对包根的路径；为了
 * 不把前缀约定写死在调用方，头部原始路径也参与比对。声明了却一个条目都没匹配到（路径
 * 拼错、包被 pack 排除）直接报错，避免"补位静默无操作、Unix 侧照旧拒绝"。
 *
 * @param {Uint8Array} source gzip 字节
 * @param {Set<string>} executablePaths 相对包根的路径
 * @returns {Buffer} 新的 gzip 字节
 */
export function withExecutableModes(source, executablePaths) {
  if (!(source instanceof Uint8Array)) fail('source must be tarball bytes');
  let tar;
  try {
    tar = gunzipSync(source);
  } catch {
    fail('not a gzip stream');
  }
  const patched = Buffer.from(tar);
  const missing = new Set(executablePaths);
  let offset = 0;
  let pax = {};
  let changed = 0;
  while (offset + BLOCK_SIZE <= patched.length) {
    const header = patched.subarray(offset, offset + BLOCK_SIZE);
    if (header.equals(ZERO_BLOCK)) break;
    const size = readOctal(header, 124, 12, 'size');
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const bodyStart = offset + BLOCK_SIZE;
    if (bodyStart + size > patched.length) fail(`truncated tar: "${name}" declares ${size} bytes`);
    if (typeflag === 'x' || typeflag === 'g') {
      pax = { ...pax, ...readPaxRecords(patched.subarray(bodyStart, bodyStart + size)) };
      offset = bodyStart + padded(size);
      continue;
    }
    if (typeflag === '5') {
      pax = {};
      offset = bodyStart + padded(size);
      continue;
    }
    if (typeflag !== '0') fail(`unsupported type "${typeflag}" ("${name}")`);
    const rawPath = pax.path ?? (prefix === '' ? name : `${prefix}/${name}`);
    const entryPath = normalizePath(rawPath);
    pax = {};
    const mode = readOctal(header, 100, 8, 'mode');
    const declared = executablePaths.has(entryPath) || executablePaths.has(rawPath);
    if (!declared) {
      offset = bodyStart + padded(size);
      continue;
    }
    missing.delete(entryPath);
    missing.delete(rawPath);
    if ((mode & 0o100) === 0) {
      writeOctal(header, 100, 8, 0o755);
      writeChecksum(header);
      changed += 1;
    }
    offset = bodyStart + padded(size);
  }
  if (missing.size > 0) fail(`tar archive has no entry for declared executable ${[...missing].join(', ')}`);
  if (changed === 0) return Buffer.from(source);
  return gzipSync(patched);
}

/** 只读一次目录内的 bin 声明，供构建器在打包后补位。 */
export function executableTargets(manifest, prefix = '') {
  const out = new Set();
  for (const target of Object.values(manifest?.bin ?? {})) {
    if (typeof target === 'string' && !target.includes('*')) out.add(`${prefix}${target.replace(/^\.\//u, '')}`);
  }
  return out;
}
