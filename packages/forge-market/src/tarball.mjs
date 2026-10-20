import { gunzipSync } from 'node:zlib';
import { ALLOWED_PREFIXES, checkArchivePaths } from './installer.mjs';

const BLOCK = 512;
const MAX_BYTES = 64 * 1024 * 1024;

function readString(block, offset, length) {
  const end = block.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return block.subarray(offset, stop).toString('utf8');
}

function readOctal(block, offset, length) {
  const text = readString(block, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function stripCommonRoot(files) {
  if (files.length < 2) return files;
  const root = files[0].path.split('/')[0];
  // 顶层本身就是白名单文件时说明归档已经是扁平的，不能再剥。
  if (!root || ALLOWED_PREFIXES.includes(root)) return files;
  const shared = files.every((file) => file.path.startsWith(`${root}/`));
  if (!shared) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

export function extractTarball(bytes, { maxBytes = MAX_BYTES } = {}) {
  let data;
  try {
    // maxOutputLength 让 zlib 在解压途中停下：否则一个几百字节的 gzip 可以撑爆内存。
    data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes;
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error?.code === 'ERR_OUT_OF_RANGE') return { ok: false, reason: 'archive-too-large' };
    return { ok: false, reason: 'bad-archive' };
  }
  if (data.length > maxBytes) return { ok: false, reason: 'archive-too-large' };

  const files = [];
  let offset = 0;
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? prefix + '/' + name : name;
    const size = readOctal(header, 124, 12);
    const type = header[156] || 48;
    const start = offset + BLOCK;
    const end = start + size;

    if (path === 'pax_global_header' || path.endsWith('/')) {
      offset = start + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (end > data.length) return { ok: false, reason: 'truncated-archive' };
    if (type === 48 || type === 0) files.push({ path, bytes: data.subarray(start, end) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }

  if (!files.length) return { ok: false, reason: 'empty-archive' };

  // Gitee 归档带 `<repo>-<tag>/` 顶层目录；不去掉的话所有路径都不匹配白名单。
  const stripped = stripCommonRoot(files);

  const safe = checkArchivePaths(stripped.map((file) => file.path));
  if (!safe.ok) return { ok: false, reason: safe.reason, detail: safe.detail };
  const keep = new Set(safe.write);
  return {
    ok: true,
    files: stripped.filter((file) => keep.has(file.path)),
    skipped: stripped.filter((file) => !keep.has(file.path)).map((file) => file.path),
  };
}
