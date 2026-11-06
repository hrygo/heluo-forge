/**
 * #37 / ADR-12: the bundle manifest is a standalone contract.
 *
 * It is generated *from the built tarball* (never from the staging directory),
 * so the file list cannot drift from what `npm pack` actually selected. Build
 * and verification share this one serializer, which keeps the on-disk bytes
 * stable and the comparison honest.
 */
export const MANIFEST_FORMAT_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/u;
const MODE = /^0[0-7]{3}$/u;
const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

const fail = (message) => { throw new Error(`bundle manifest: ${message}`); };

function requireText(value, field) {
  if (typeof value !== 'string' || value === '') fail(`${field} must be a non-empty string`);
  return value;
}

function requireDigest(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${field} must be a lowercase sha256 hex digest`);
  return value;
}

function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0) fail(`${field} must be a non-negative integer`);
  return value;
}

function requireFileName(value, field) {
  const name = requireText(value, field);
  if (name.includes('/') || name.includes('\\') || /[\r\n]/u.test(name) || name === '.' || name === '..') fail(`${field} must be a plain file name`);
  return name;
}

/** Archive paths are relative, `/`-separated, and never escape the artifact root. */
function requirePath(value) {
  const path = requireText(value, 'file path');
  if (path.startsWith('/') || path.includes('\\') || path.endsWith('/') || path.includes('//')) fail(`unsafe file path "${path}"`);
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`unsafe file path "${path}"`);
  return path;
}

function normalizeFile(entry) {
  if (entry === null || typeof entry !== 'object') fail('each file entry must be an object');
  return {
    path: requirePath(entry.path),
    size: requireCount(entry.size, `file ${entry.path} size`),
    sha256: requireDigest(entry.sha256, `file ${entry.path} sha256`),
    mode: typeof entry.mode === 'string' && MODE.test(entry.mode) ? entry.mode : fail(`file ${entry.path} mode must be four octal digits`),
  };
}

function normalizeMembers(members) {
  if (members === null || typeof members !== 'object' || Array.isArray(members)) fail('members must be an object');
  const names = Object.keys(members).sort();
  if (names.length === 0) fail('members must declare at least one package');
  return Object.fromEntries(names.map((name) => [requireText(name, 'member name'), requireText(members[name], `member ${name} version`)]));
}

function normalizeToolchain(toolchain) {
  return {
    node: requireText(toolchain?.node, 'toolchain.node'),
    npm: requireText(toolchain?.npm, 'toolchain.npm'),
  };
}

function normalizeTarball(tarball) {
  return {
    name: requireFileName(tarball?.name, 'tarball.name'),
    sha256: requireDigest(tarball?.sha256, 'tarball.sha256'),
    bytes: requireCount(tarball?.bytes, 'tarball.bytes'),
  };
}

/**
 * @param {{entry: {name: string, version: string}, members: Record<string, string>,
 *   tarball: {name: string, sha256: string, bytes: number}, entries: Array<object>,
 *   toolchain: {node: string, npm: string}}} input
 * `members` carries every shipped package, including the entry package itself.
 */
export function createBundleManifest({ entry, members, tarball, entries, toolchain } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) fail('entries must be a non-empty array');
  if (entry === null || typeof entry !== 'object') fail('entry must be an object');
  const files = entries.map((item) => normalizeFile(item)).sort(byPath);
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].path === files[index].path) fail(`duplicate file ${files[index].path}`);
  }
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    entry: { name: requireText(entry.name, 'entry.name'), version: requireText(entry.version, 'entry.version') },
    members: normalizeMembers(members),
    toolchain: normalizeToolchain(toolchain),
    tarball: normalizeTarball(tarball),
    files,
  };
}

/** Fixed key order, two-space indent, trailing newline: byte-stable for one input. */
export function serializeBundleManifest(manifest) {
  const source = manifest ?? fail('manifest must be an object');
  if (source.formatVersion !== MANIFEST_FORMAT_VERSION) fail(`unsupported formatVersion ${JSON.stringify(source.formatVersion)}`);
  const ordered = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    entry: { name: requireText(source.entry?.name, 'entry.name'), version: requireText(source.entry?.version, 'entry.version') },
    members: normalizeMembers(source.members),
    toolchain: normalizeToolchain(source.toolchain),
    tarball: normalizeTarball(source.tarball),
    files: (Array.isArray(source.files) ? source.files : fail('files must be an array')).map((item) => normalizeFile(item)).sort(byPath),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseBundleManifest(text) {
  if (typeof text !== 'string' || text.trim() === '') fail('manifest text must be a non-empty string');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('manifest must be a JSON object');
  // An unknown version is refused, never guessed: a future layout could hash
  // different bytes and silently pass this verifier.
  if (parsed.formatVersion !== MANIFEST_FORMAT_VERSION) fail(`unsupported formatVersion ${JSON.stringify(parsed.formatVersion)} (expected ${MANIFEST_FORMAT_VERSION})`);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) fail('files must be a non-empty array');
  const files = parsed.files.map((item) => normalizeFile(item));
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1].path;
    const current = files[index].path;
    if (previous === current) fail(`duplicate file ${current}`);
    if (!(previous < current)) fail(`files must be sorted by path (${previous} before ${current})`);
  }
  if (parsed.entry === null || typeof parsed.entry !== 'object') fail('entry must be an object');
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    entry: { name: requireText(parsed.entry.name, 'entry.name'), version: requireText(parsed.entry.version, 'entry.version') },
    members: normalizeMembers(parsed.members),
    toolchain: normalizeToolchain(parsed.toolchain),
    tarball: normalizeTarball(parsed.tarball),
    files,
  };
}

/**
 * Human-readable differences, one line each; `[]` means the tarball matches the
 * manifest. `toolchain` is deliberately not compared — it records the build host
 * (node/npm versions) and differs between machines without the artifact changing.
 */
export function diffBundleManifest(expected, actual) {
  const left = expected ?? {};
  const right = actual ?? {};
  const differences = [];
  // File differences come first: they localise the change, while the tarball
  // digest below only says "something in this archive moved".
  const expectedFiles = new Map((left.files ?? []).map((file) => [file.path, file]));
  const actualFiles = new Map((right.files ?? []).map((file) => [file.path, file]));
  const paths = [...new Set([...expectedFiles.keys(), ...actualFiles.keys()])].sort();
  for (const path of paths) {
    const wanted = expectedFiles.get(path);
    const found = actualFiles.get(path);
    if (found === undefined) {
      differences.push(`package/${path}: missing from tarball`);
      continue;
    }
    if (wanted === undefined) {
      differences.push(`package/${path}: not declared in manifest`);
      continue;
    }
    if (wanted.size !== found.size) differences.push(`package/${path}: size mismatch (manifest ${wanted.size} vs tarball ${found.size})`);
    if (wanted.sha256 !== found.sha256) differences.push(`package/${path}: sha256 mismatch (manifest ${wanted.sha256} vs tarball ${found.sha256})`);
    if (wanted.mode !== found.mode) differences.push(`package/${path}: mode mismatch (manifest ${wanted.mode} vs tarball ${found.mode})`);
  }
  for (const field of ['name', 'sha256', 'bytes']) {
    if (left.tarball?.[field] !== right.tarball?.[field]) {
      differences.push(`tarball: ${field} mismatch (manifest ${left.tarball?.[field] ?? '<missing>'} vs tarball ${right.tarball?.[field] ?? '<missing>'})`);
    }
  }
  for (const field of ['name', 'version']) {
    if (left.entry?.[field] !== right.entry?.[field]) {
      differences.push(`entry: ${field} mismatch (manifest ${left.entry?.[field] ?? '<missing>'} vs tarball ${right.entry?.[field] ?? '<missing>'})`);
    }
  }
  const expectedMembers = left.members ?? {};
  const actualMembers = right.members ?? {};
  for (const name of Object.keys(expectedMembers).sort()) {
    if (!Object.hasOwn(actualMembers, name)) differences.push(`members: ${name} missing from tarball`);
    else if (expectedMembers[name] !== actualMembers[name]) differences.push(`members: ${name} version mismatch (manifest ${expectedMembers[name]} vs tarball ${actualMembers[name]})`);
  }
  for (const name of Object.keys(actualMembers).sort()) {
    if (!Object.hasOwn(expectedMembers, name)) differences.push(`members: ${name} not declared in manifest`);
  }
  return differences;
}

/** GNU coreutils format: two spaces between digest and name, one trailing newline. */
export function serializeSha256Sums(list) {
  if (!Array.isArray(list) || list.length === 0) fail('sha256 sums require a non-empty list');
  return `${list.map((item) => `${requireDigest(item?.sha256, 'sha256 sums digest')}  ${requireFileName(item?.name, 'sha256 sums name')}`).join('\n')}\n`;
}
