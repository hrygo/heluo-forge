/**
 * The packed runtime, checked against what was staged.
 *
 * electron-builder packs the staged `dsh/` tree into `app.asar` and unpacks
 * what the rules name beside it. Those bytes are what the user installs, and
 * nothing else reads them before the user does. So the build reads them: after
 * packing, on every platform, the archive must hold exactly the files the rule
 * lets through — byte for byte as staged, except that a dependency's manifest
 * may lack what electron-builder removes from it; what has to be a real file
 * must be flagged unpacked and lie on disk with the staged bytes; and no native
 * program or library may be left inside the archive, whatever its name. A build
 * whose archive fails here fails, instead of an app that fails on the user's
 * machine with an error that names neither the file nor the reason.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { DSH_DIR, isPackaged, isUnpacked, stagedRuntime } from './desktop-payload.mjs';

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const PROBLEMS_SHOWN = 12;

/** Magic numbers, as the first four bytes read in little endian: every Mach-O and universal binary. */
const MACHO_MAGIC = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca']);
/** ELF, byte for byte: `7f 45 4c 46`. Windows programs always carry `.exe` or `.dll`, which the rule knows. */
const ELF_MAGIC = '7f454c46';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * What electron-builder takes out of a dependency's `package.json` on its way
 * into the archive, and to nothing else it packs: registry metadata, and
 * fields only a build reads. It cannot be turned off. What the runtime reads —
 * `dependencies`, `exports`, `main`, `bin`, `version` — it leaves in place.
 */
const MANIFEST_METADATA = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors', 'bundleDependencies', 'tags', 'scripts', 'keywords', 'bugs']);

/**
 * The staged manifest as electron-builder is allowed to pack it, or null when
 * it is not a JSON object.
 */
function trimmedManifest(staged) {
  let data;
  try {
    data = JSON.parse(staged.toString('utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  // The Babel configuration goes only when the package has no Babel of its own to configure.
  const withoutBabel = typeof data.dependencies !== 'object' || data.dependencies === null || !Object.keys(data.dependencies).some((name) => name.startsWith('babel'));
  return Object.fromEntries(Object.entries(data).filter(([key]) => !(key.startsWith('_') || MANIFEST_METADATA.has(key) || (withoutBabel && key === 'babel'))));
}

/** Whether a file's first bytes say it is a program or library the operating system would have to load. */
function isNative(bytes) {
  return bytes.length >= 4 && (bytes.subarray(0, 4).toString('hex') === ELF_MAGIC || MACHO_MAGIC.has(bytes.readUInt32LE(0).toString(16).padStart(8, '0')));
}

function readExactly(fd, buffer, position) {
  let read = 0;
  while (read < buffer.length) {
    const chunk = readSync(fd, buffer, read, buffer.length - read, position + read);
    if (chunk === 0) break;
    read += chunk;
  }
  return read === buffer.length;
}

/**
 * An asar archive, opened for reading.
 *
 * The format is two pickles and the file data: a four-byte payload giving the
 * size of the header, then the header (its own payload size, the length of the
 * JSON, and the JSON), then every packed file's bytes at the offset its entry
 * names from the end of the header. An unpacked entry has a size and no offset:
 * its bytes are in `app.asar.unpacked/`. A link entry only names its target,
 * from the archive's root — where the link on disk names it from its own
 * directory.
 *
 * @param {string} archivePath
 * @returns {{files: Map<string, {size: number, offset?: string, unpacked?: true, link?: string}>, read: (entry: {size: number, offset?: string}) => Buffer, close: () => void}}
 * @throws {ArchiveError} `ARCHIVE_INVALID`
 */
export function openArchive(archivePath) {
  const invalid = (message) => new ArchiveError('ARCHIVE_INVALID', `${archivePath}: ${message}`);
  let fd;
  try {
    fd = openSync(archivePath, 'r');
    const lead = Buffer.alloc(16);
    if (!readExactly(fd, lead, 0) || lead.readUInt32LE(0) !== 4) throw invalid('not an asar archive');
    const headerSize = lead.readUInt32LE(4);
    const jsonLength = lead.readUInt32LE(12);
    if (headerSize < 12 || headerSize % 4 !== 0 || lead.readUInt32LE(8) !== headerSize - 4 || jsonLength > headerSize - 4) {
      throw invalid('the header does not describe the archive');
    }
    const json = Buffer.alloc(jsonLength);
    if (!readExactly(fd, json, 16)) throw invalid('the header is shorter than it says');
    let header;
    try {
      header = JSON.parse(json.toString('utf8'));
    } catch {
      throw invalid('the header is not readable');
    }
    const files = new Map();
    const visit = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = prefix === '' ? name : `${prefix}/${name}`;
        if (entry.files !== undefined) visit(entry, path);
        else files.set(path, entry);
      }
    };
    visit(header, '');
    const dataOffset = 8 + headerSize;
    return {
      files,
      read: (entry) => {
        const bytes = Buffer.alloc(entry.size);
        if (entry.offset === undefined || !readExactly(fd, bytes, dataOffset + Number(entry.offset))) {
          throw invalid("an entry's bytes are not in the archive");
        }
        return bytes;
      },
      close: () => closeSync(fd),
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

/** `/`-separated paths of the regular files under a directory, empty for a directory that is not there. */
function filesUnder(root) {
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return new Set();
  }
  return new Set(entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')));
}

function list(problems) {
  const shown = problems.slice(0, PROBLEMS_SHOWN);
  const more = problems.length - shown.length;
  return `${problems.length} problem${problems.length === 1 ? '' : 's'} with the packed runtime:\n  ${shown.join('\n  ')}${more > 0 ? `\n  … and ${more} more` : ''}`;
}

/**
 * How bytes packed for one file compare with the file that was staged: the
 * same, the same manifest without what electron-builder removes from it, or
 * different. Unpacked files go through the same cleanup before they are
 * written beside the archive.
 */
function compareWithStaged(path, bytes, stagedPath) {
  const staged = readFileSync(stagedPath);
  if (digest(bytes) === digest(staged)) return 'same';
  const trimmed = basename(path) === 'package.json' && path.includes('/node_modules/') ? trimmedManifest(staged) : null;
  let packed;
  try {
    packed = trimmed === null ? undefined : JSON.parse(bytes.toString('utf8'));
  } catch {
    packed = undefined;
  }
  return trimmed !== null && isDeepStrictEqual(packed, trimmed) ? 'trimmed' : 'different';
}

/**
 * Check the archive's runtime against the staged tree.
 *
 * @param {{archivePath: string, resourcesDir: string}} input
 *   `archivePath` is `app.asar`; `resourcesDir` is the staged directory it was packed from.
 * @returns {{files: number, packed: number, unpacked: number, links: number, trimmedManifests: number, bytes: number, archiveBytes: number}}
 *   `trimmedManifests` counts the dependency manifests electron-builder removed metadata from.
 * @throws {ArchiveError} `ARCHIVE_INVALID` when the archive cannot be read, `ARCHIVE_UNVERIFIED` when there is
 *   no staged tree to compare with, `NATIVE_PACKED` when a native program or library is inside the archive,
 *   and `ARCHIVE_MISMATCH` when the archive is not the staged tree.
 */
export function verifyRuntimeArchive({ archivePath, resourcesDir }) {
  let staged;
  try {
    staged = stagedRuntime(resourcesDir);
  } catch (error) {
    throw new ArchiveError('ARCHIVE_UNVERIFIED', `the staged runtime could not be read to compare the archive with: ${error.message}`);
  }
  const archive = openArchive(archivePath);
  try {
    const unpackedRoot = `${archivePath}.unpacked`;
    const onDisk = filesUnder(join(unpackedRoot, DSH_DIR));
    const problems = [];
    const native = [];
    const summary = { files: 0, packed: 0, unpacked: 0, links: 0, trimmedManifests: 0, bytes: 0, archiveBytes: statSync(archivePath).size };

    for (const [path, entry] of archive.files) {
      if (!path.startsWith(`${DSH_DIR}/`)) continue;
      const expected = staged.get(path.slice(DSH_DIR.length + 1));
      summary.files += 1;
      if (expected === undefined) {
        problems.push(`${path} is in the archive but ${isPackaged(path) ? 'was not staged' : 'is a file the rule leaves out'}`);
        continue;
      }
      staged.delete(path.slice(DSH_DIR.length + 1));
      if (expected.link !== undefined) {
        summary.links += 1;
        // Where the staged link points, as a path from the archive's root: that is how the archive records it.
        const target = posix.normalize(posix.join(posix.dirname(path), expected.link));
        if (target.startsWith('../') || posix.normalize(entry.link ?? '') !== target) {
          problems.push(`${path} is a link to ${entry.link}; staged, it points at ${target}`);
        }
        continue;
      }
      if (entry.unpacked === true) {
        summary.unpacked += 1;
        onDisk.delete(path.slice(DSH_DIR.length + 1));
        if (!isUnpacked(path)) {
          problems.push(`${path} is unpacked and is not to be unpacked: what is unpacked is what the rule names`);
          continue;
        }
        const physical = join(unpackedRoot, path);
        const bytes = existsAsFile(physical) ? readFileSync(physical) : null;
        const compared = bytes === null ? 'missing' : compareWithStaged(path, bytes, expected.path);
        if (compared === 'missing') problems.push(`${path} is unpacked but there is nothing on disk for it`);
        else if (compared === 'different') problems.push(`${path} differs on disk from the staged file: bytes differ`);
        else if (compared === 'trimmed') summary.trimmedManifests += 1;
        continue;
      }
      summary.packed += 1;
      summary.bytes += entry.size;
      const bytes = archive.read(entry);
      if (isUnpacked(path)) {
        // The content says which failure this is: a native file by what it is, anything else by the rule alone.
        if (isNative(bytes)) native.push(`${path} is a native library left inside the archive`);
        else problems.push(`${path} must be unpacked: the operating system is handed its path`);
      } else if (isNative(bytes)) {
        native.push(`${path} is a native program or library left inside the archive, and the unpack rule does not name it`);
      } else {
        const compared = compareWithStaged(path, bytes, expected.path);
        if (compared === 'different') problems.push(`${path} is not the staged file: bytes differ`);
        else if (compared === 'trimmed') summary.trimmedManifests += 1;
      }
    }
    for (const path of staged.keys()) problems.push(`${DSH_DIR}/${path} is staged but missing from the archive`);
    for (const path of onDisk) problems.push(`${DSH_DIR}/${path} is on disk but not an entry of the archive`);
    if (native.length > 0) throw new ArchiveError('NATIVE_PACKED', list(native));
    if (problems.length > 0) throw new ArchiveError('ARCHIVE_MISMATCH', list(problems));
    return summary;
  } finally {
    archive.close();
  }
}

function existsAsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
