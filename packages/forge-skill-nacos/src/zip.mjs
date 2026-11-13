/**
 * 零依赖 ZIP 读取器（设计 §7.2：有界、只读、防御式）。
 *
 * 只实现 ZIP 规范的最小子集：中央目录定位 + stored/deflate 两种压缩方法。
 * 逐条强制上限（条目数 / 单文件解压上限 / 总解压上限），加密与 ZIP64 一律拒绝；
 * 炸弹防御靠 `zlib` 的 `maxOutputLength` 在解压时即时中止，不靠事后统计。
 */
import { inflateRawSync } from 'node:zlib';
import { REASONS, SkillNacosError } from './errors.mjs';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SCAN_WINDOW = 65557; // EOCD + 注释上限 65535
const FLAG_ENCRYPTED = 0b1;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UNIX_IFMT = 0o170000;
const UNIX_IFLNK = 0o120000;

/**
 * @param {Uint8Array} bytes ZIP 原始字节
 * @param {{maxFileCount?: number, maxTotalBytes?: number, maxEntryBytes?: number}} [limits]
 * @returns {{entries: {name: string, data: Buffer, isDirectory: boolean}[]}} 解出的条目
 * @throws {SkillNacosError} REASONS.INVALID_PACKAGE / REASONS.QUOTA_EXCEEDED
 */
export function readZip(bytes, limits = {}) {
  const maxFileCount = limits.maxFileCount ?? 512;
  const maxTotalBytes = limits.maxTotalBytes ?? 20971520;
  const maxEntryBytes = limits.maxEntryBytes ?? maxTotalBytes;
  const buffer = Buffer.from(bytes);

  const eocd = findEocd(buffer);
  if (eocd === undefined) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, '安装包不是有效的 ZIP 文件（找不到目录结尾记录）');
  }
  if (eocd.entryCount === 0xffff || eocd.centralOffset === 0xffffffff) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, '安装包使用了 ZIP64 扩展，当前不支持');
  }

  const entries = [];
  let offset = eocd.centralOffset;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (index >= maxFileCount) {
      throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `安装包文件数超过上限 ${maxFileCount}`, { maxFileCount });
    }
    const entry = readCentralEntry(buffer, offset);
    offset = entry.next;
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `安装包条目 ${entry.name} 加密，当前不支持`);
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `安装包条目 ${entry.name} 使用不支持的压缩方法 ${entry.method}`);
    }
    if ((entry.externalAttrs >>> 16 & UNIX_IFMT) === UNIX_IFLNK) {
      throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包条目 ${entry.name} 是符号链接，拒绝解包`);
    }
    if (entry.uncompressedSize > maxEntryBytes) {
      throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `安装包条目 ${entry.name} 解压后超过单文件上限 ${maxEntryBytes} 字节`, { name: entry.name });
    }
    const data = readEntryData(buffer, entry, maxEntryBytes);
    entries.push({ name: entry.name, data, isDirectory: entry.isDirectory });
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (totalBytes > maxTotalBytes) {
    throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `安装包解压后总大小超过上限 ${maxTotalBytes} 字节`, { totalBytes, maxTotalBytes });
  }
  return { entries };
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - EOCD_SCAN_WINDOW);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    return {
      entryCount: buffer.readUInt16LE(i + 10),
      centralOffset: buffer.readUInt32LE(i + 16),
    };
  }
  return undefined;
}

function readCentralEntry(buffer, offset) {
  if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, '安装包中央目录记录损坏');
  }
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const externalAttrs = buffer.readUInt32LE(offset + 38);
  const localOffset = buffer.readUInt32LE(offset + 42);
  const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
  return {
    flags: buffer.readUInt16LE(offset + 8),
    method: buffer.readUInt16LE(offset + 10),
    compressedSize: buffer.readUInt32LE(offset + 20),
    uncompressedSize: buffer.readUInt32LE(offset + 24),
    externalAttrs,
    localOffset,
    name,
    isDirectory: name.endsWith('/'),
    next: offset + 46 + nameLength + extraLength + commentLength,
  };
}

function readEntryData(buffer, entry, maxEntryBytes) {
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, `安装包条目 ${entry.name} 本地头损坏`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.isDirectory) return Buffer.alloc(0);
  if (entry.method === METHOD_STORED) {
    if (raw.length !== entry.uncompressedSize) {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `安装包条目 ${entry.name} 大小记录不一致`);
    }
    return Buffer.from(raw);
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `安装包条目 ${entry.name} 解压超过单文件上限（疑似压缩炸弹）`, { name: entry.name });
    }
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, `安装包条目 ${entry.name} 解压失败：${error.message}`);
  }
}
