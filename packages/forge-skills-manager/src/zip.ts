import { fromBufferPromise, validateFileName } from 'yauzl';
import { crc32 } from 'node:zlib';

export class ZipReadError extends Error {
  readonly reason: 'invalid' | 'size' | 'entries';
  constructor(reason: 'invalid' | 'size' | 'entries' = 'invalid') {
    super('Invalid ZIP or extraction limit exceeded');
    this.reason = reason;
  }
}

interface ZipOptions {
  filter?: (info: { name: string; originalSize: number }) => boolean;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

// Bundled at build time. No caller receives content until every entry validates.
export async function readZip(bytes: Uint8Array, options: ZipOptions = {}): Promise<Record<string, Uint8Array>> {
  const entryLimit = options.maxEntryBytes ?? (32 << 20);
  const totalLimit = options.maxTotalBytes ?? (64 << 20);
  const countLimit = options.maxEntries ?? 1000;
  async function checked<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (caught) { if (caught instanceof ZipReadError) throw caught; throw new ZipReadError(); }
  }
  const zip = await checked(() => fromBufferPromise(Buffer.from(bytes), {
    lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true,
  }));
  const entries = zip.eachEntry();
  const files: Record<string, Uint8Array> = Object.create(null);
  let count = 0, total = 0;
  try {
    while (true) {
      const next = await checked(() => entries.next());
      if (next.done) break;
      const entry = next.value;
      // Preserve the existing UTF-8 path contract. CP437 decoding would turn
      // ASCII control bytes into printable glyphs before portable-path checks.
      let name: string;
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw); }
      catch (caught) {
        if (!(caught instanceof TypeError) || !('code' in caught) || caught.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw caught;
        throw new ZipReadError();
      }
      if (++count > countLimit) throw new ZipReadError('entries');
      if (entry.uncompressedSize > entryLimit || entry.uncompressedSize > totalLimit - total) throw new ZipReadError('size');
      // Keep caller path/domain errors and programming defects outside the mapper.
      const keep = options.filter?.({ name, originalSize: entry.uncompressedSize }) ?? true;
      if (!options.filter && validateFileName(name)) throw new ZipReadError();
      const stream = await checked(() => zip.openReadStreamPromise(entry));
      const chunks: Buffer[] = [];
      let size = 0, checksum = 0;
      try {
        await checked(async () => {
          for await (const chunk of stream) {
            const data = chunk as Buffer;
            size += data.length;
            total += data.length;
            if (size > entryLimit || total > totalLimit) throw new ZipReadError('size');
            checksum = crc32(data, checksum);
            if (keep) chunks.push(data);
          }
        });
      } finally { stream.destroy(); }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new ZipReadError();
      if (keep) files[name] = Buffer.concat(chunks, size);
    }
    return files;
  } finally {
    await entries.return?.();
    zip.close();
  }
}
