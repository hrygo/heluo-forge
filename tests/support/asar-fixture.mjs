/**
 * An asar archive and the unpacked tree beside it, written the way
 * `@electron/asar` writes them for electron-builder: two pickles (the size of
 * the header, then the header itself), followed by the file data. A packed entry
 * is an offset into that data; an unpacked entry has no offset and its bytes
 * are on disk under `<archive>.unpacked/`, at the same relative path.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * @param {string} archivePath where `app.asar` is written; `<archivePath>.unpacked/` is created beside it
 * @param {Array<{path: string, content?: Buffer|string, unpacked?: boolean, link?: string, physical?: Buffer|string|null}>} entries
 *   `link` makes the entry a symbolic link to that target. For an unpacked entry, `physical` is what
 *   the copy on disk holds: the entry's own content unless given, and nothing when `null`.
 * @returns {number} bytes of file data inside the archive
 */
export function writeAsar(archivePath, entries) {
  // The archive and its unpacked tree are one state: an earlier one is not left to be mistaken for part of it.
  rmSync(`${archivePath}.unpacked`, { recursive: true, force: true });
  const root = { files: {} };
  const data = [];
  let offset = 0;
  for (const entry of entries) {
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : (entry.content ?? Buffer.alloc(0));
    const parts = entry.path.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = directory.files[part] ??= { files: {} };
    }
    let node;
    if (entry.link !== undefined) {
      node = { link: entry.link };
    } else if (entry.unpacked === true) {
      node = { size: content.length, unpacked: true };
    } else {
      node = { size: content.length, offset: String(offset) };
      data.push(content);
      offset += content.length;
    }
    directory.files[parts.at(-1)] = node;
    if (entry.unpacked === true && entry.physical !== null) {
      const physical = entry.physical === undefined ? content : typeof entry.physical === 'string' ? Buffer.from(entry.physical) : entry.physical;
      const target = join(`${archivePath}.unpacked`, ...parts);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, physical);
    }
  }
  const json = Buffer.from(JSON.stringify(root));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, Buffer.concat([header, ...data]));
  return offset;
}
