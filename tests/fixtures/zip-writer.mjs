/**
 * Write the zip archives the tests read (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * The reader under test is the one production uses, so a fixture built by the
 * same code would prove nothing about what it accepts. This writer emits the
 * format by hand — local headers, central directory, end record — with the
 * knobs a negative case needs: an entry can carry a wrong CRC-32, an
 * unsupported compression method, an encryption flag, a foreign file type or
 * an unsafe name.
 */
import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../../scripts/lib/zip-archive.mjs';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MADE_BY_UNIX = 3 << 8;
const DOS_EPOCH = 0x21;
const STORED = 0;
const DEFLATED = 8;

/**
 * @param {Array<{ path: string, content?: string | Uint8Array, mode?: number, directory?: boolean, flags?: number }>} entries
 *   `mode` is the full Unix mode, file type included; `flags` overrides the general flags.
 * @param {{ method?: 'store' | 'deflate', compression?: number, crc?: Function, flags?: number }} [options]
 *   `compression` and `flags` replace what every entry records; `crc` replaces the checksum.
 * @returns {Buffer}
 */
export function writeZip(entries, { method = 'deflate', compression, crc, flags = 0 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.directory ? `${entry.path}/` : entry.path, 'utf8');
    const content = Buffer.from(entry.content ?? '');
    const packed = method === 'deflate' && !entry.directory && content.length > 0 ? deflateRawSync(content) : content;
    const technique = compression ?? (packed === content ? STORED : DEFLATED);
    const checksum = crc === undefined ? crc32(content) : crc(content);
    const mode = entry.mode ?? (entry.directory ? 0o40755 : 0o100644);
    const entryFlags = entry.flags ?? flags;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entryFlags, 6);
    header.writeUInt16LE(technique, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_EPOCH, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
    record.writeUInt16LE(MADE_BY_UNIX | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entryFlags, 8);
    record.writeUInt16LE(technique, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(DOS_EPOCH, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28);
    // External attributes are the Unix mode in the high half; `<<` alone would make large modes negative.
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    const body = Buffer.concat([header, name, packed]);
    locals.push(body);
    centrals.push(Buffer.concat([record, name]));
    offset += body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
