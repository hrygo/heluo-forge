import { gunzipSync } from 'node:zlib';
import { checkArchivePaths } from './installer.mjs';

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

export function extractTarball(bytes, { maxBytes = MAX_BYTES } = {}) {
  let data;
  try {
    data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  } catch {
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
  const safe = checkArchivePaths(files.map((file) => file.path));
  if (!safe.ok) return { ok: false, reason: safe.reason, detail: safe.detail };
  return { ok: true, files };
}
