/**
 * What the packaged shell carries, and where each staged file ends up.
 *
 * The staged resources (`stage-desktop-payload.mjs`, `stage-primary-runtime.mjs`)
 * are one directory. The embedded runtime under `dsh/` goes into the app's
 * archive as one file: an installer that writes tens of thousands of small
 * files is slow, an installer that writes one archive is not. What the runtime
 * hands to the operating system is unpacked beside the archive, under the same
 * relative path (`services/forge-desktop/src/physical-paths.mjs`). The bundled
 * runtime, the brand and the employee package travel as they were staged.
 *
 * One rule, two projections. `isPackaged` and `isUnpacked` decide for a
 * `/`-separated path from the resources root; the filters and `ASAR_UNPACK` say
 * the same to electron-builder, which matches its patterns against real files.
 * `tests/build-desktop-installer.test.mjs` keeps the projections equal with
 * electron-builder's own matcher.
 *
 * electron-builder counts the path it matches from the app directory, and
 * refuses a file whose real location is outside the file set's source. That is
 * why the staged resources are staged inside the app directory: a tree elsewhere
 * is matched against a path with no meaning, and a link to it is refused.
 */
import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

import { DSH_ENTRY_PARTS } from '../../services/forge-desktop/src/layout.mjs';

/** The embedded runtime's tree, from the resources root. */
export const DSH_DIR = DSH_ENTRY_PARTS[0];
const RUNTIME_MODULES = `${DSH_DIR}/node_modules`;
const DEEPSEEK_SCOPE = `${RUNTIME_MODULES}/@deepseek-ai`;

/**
 * File types the packaged runtime never reads. TypeScript sources and
 * declarations: the embedded Node refuses to strip types under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and nothing in the closure
 * compiles TypeScript. Source maps: the shell drops NODE_OPTIONS from every
 * child environment, so `--enable-source-maps` cannot reach the runtime. Debug
 * symbols: only a debugger opens them. electron-builder's own default excludes
 * apply to the app files, not to a file set of its own.
 */
const RUNTIME_EXCLUDED_EXTENSIONS = ['.ts', '.cts', '.mts', '.map', '.pdb', '.flow', '.c', '.cc', '.cpp', '.h', '.hpp', '.gyp', '.gypi', '.tsbuildinfo'];

/**
 * Third-party packages inside `dsh/node_modules` (outside `@deepseek-ai/`)
 * carry test suites, docs, examples and changelogs that are never needed at
 * runtime; license/notice files are always preserved.
 */
const THIRD_PARTY_EXCLUDED_DIRS = [
  'test',
  'tests',
  '__tests__',
  'docs',
  'example',
  'examples',
  '.github',
  '.vscode',
  '.idea',
  'fixtures',
  '__fixtures__',
];
const THIRD_PARTY_EXCLUDED_DIR_SET = new Set(THIRD_PARTY_EXCLUDED_DIRS);
const THIRD_PARTY_EXCLUDED_DOC_EXTS = new Set(['.md', '.markdown']);
const THIRD_PARTY_EXCLUDED_DOC_PREFIXES = ['CHANGELOG', 'HISTORY'];
/**
 * The same document names for electron-builder's matcher, which is case-sensitive
 * where the rule reads a file's name without case: a class per letter.
 */
const anyCase = (word) => [...word].map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join('');
const THIRD_PARTY_EXCLUDED_DOC_GLOBS = [...THIRD_PARTY_EXCLUDED_DOC_EXTS].map((extension) => `*.${anyCase(extension.slice(1))}`);
const THIRD_PARTY_EXCLUDED_DOC_PREFIX_GLOBS = THIRD_PARTY_EXCLUDED_DOC_PREFIXES.map((prefix) => `${anyCase(prefix)}*`);
/** What a third-party package keeps for its own toolchain, by file name: linter and formatter settings, build files, test and TypeScript configuration. */
const THIRD_PARTY_EXCLUDED_CONFIG_GLOBS = [
  '.eslintrc*',
  '.prettier*',
  '.editorconfig',
  '.npmignore',
  '.flowconfig',
  '.babelrc*',
  'tsconfig*.json',
  'binding.gyp',
  'Makefile',
  'CMakeLists.txt',
  'biome.json',
  'biome.jsonc',
  'jest.config.*',
  'vitest.config.*',
  '.DS_Store',
  'Thumbs.db',
];
const THIRD_PARTY_LICENSE_PREFIXES = ['LICENSE', 'LICENCE', 'NOTICE', 'COPYING'];
const THIRD_PARTY_LICENSE_GLOBS = ['[Ll][Ii][Cc][Ee][Nn][SsCc][Ee]*', '[Nn][Oo][Tt][Ii][Cc][Ee]*', '[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*'];

/** Whether `file`, by its name alone, is one of `THIRD_PARTY_EXCLUDED_CONFIG_GLOBS`; the license and notice files are decided before it is asked. */
function isExcludedConfigFile(file) {
  if (
    file === '.editorconfig' ||
    file === '.npmignore' ||
    file === '.flowconfig' ||
    file === 'binding.gyp' ||
    file === 'Makefile' ||
    file === 'CMakeLists.txt' ||
    file === 'biome.json' ||
    file === 'biome.jsonc' ||
    file === '.DS_Store' ||
    file === 'Thumbs.db'
  ) {
    return true;
  }
  if (
    file.startsWith('.eslintrc') ||
    file.startsWith('.prettier') ||
    file.startsWith('.babelrc') ||
    file.startsWith('jest.config.') ||
    file.startsWith('vitest.config.')
  ) {
    return true;
  }
  if (file.startsWith('tsconfig') && file.endsWith('.json')) return true;
  return false;
}

/**
 * The directory that travels exactly as it was staged: the dsh artifact
 * `runtime-lock.json` pins by digest. Everything else under `dsh/node_modules`
 * is the registry closure.
 */
const VERBATIM_DSH_DIR = `${DEEPSEEK_SCOPE}/${DSH_ENTRY_PARTS[3]}/`;

/**
 * Whether a staged file reaches the package. `relativePath` is `/`-separated
 * from the resources root; the filters say the same to electron-builder.
 *
 * Beside the archive, the staged resources travel as they were staged. Inside
 * the runtime's tree, in order: the verbatim directory as it is; then the file
 * types the runtime never reads, whatever they are named — a type declaration
 * is not a notice file for being called `notice`; then, of the rest, license
 * and notice files always, wherever they lie; then what the third-party
 * packages carry for their own development.
 */
export function isPackaged(relativePath) {
  if (!relativePath.startsWith(`${DSH_DIR}/`)) return true;
  if (relativePath.startsWith(VERBATIM_DSH_DIR)) return true;
  if (RUNTIME_EXCLUDED_EXTENSIONS.includes(extname(relativePath))) return false;
  if (!relativePath.startsWith(`${RUNTIME_MODULES}/`) || relativePath.startsWith(`${DEEPSEEK_SCOPE}/`)) {
    return true;
  }
  const segments = relativePath.slice(`${RUNTIME_MODULES}/`.length).split('/');
  const file = segments.at(-1) ?? '';
  const upperFile = file.toUpperCase();
  if (THIRD_PARTY_LICENSE_PREFIXES.some((prefix) => upperFile.startsWith(prefix))) return true;
  if (segments.slice(0, -1).some((segment) => THIRD_PARTY_EXCLUDED_DIR_SET.has(segment))) {
    return false;
  }
  if (THIRD_PARTY_EXCLUDED_DOC_EXTS.has(extname(file).toLowerCase())) return false;
  if (THIRD_PARTY_EXCLUDED_DOC_PREFIXES.some((prefix) => upperFile.startsWith(prefix))) return false;
  if (isExcludedConfigFile(file)) return false;
  return true;
}

/** Native libraries and executables by the extension the loader knows them by. */
const NATIVE_SUFFIX = /\.(?:node|dll|exe|dylib|so)$/u;
/** A versioned shared object: `libfoo.so.1`, `libfoo.so.42.0.0`. */
const VERSIONED_SHARED_OBJECT = /\/[^/]*\.so\.\d[^/]*$/u;
/**
 * Programs without an extension, by where they are: node-pty's helper, the
 * ripgrep of its package, the Linux landlock sandbox helper of
 * `@deepseek-ai/node-addon-system-*`, and the launcher the `open` package runs
 * itself where the system has none.
 */
const EXTENSIONLESS_PROGRAM = /(?:^|\/)(?:spawn-helper|@vscode\/ripgrep[^/]*\/bin\/rg|@deepseek-ai\/node-addon-system[^/]*\/bin\/landlock-run|open\/xdg-open)$/u;
/**
 * Trees a native process reads by their path, each inside a package under
 * `@deepseek-ai/`: the Office engine of the target, and the Computer Use helper
 * bundles that LaunchServices opens as applications. `name` recognises the
 * package on disk and `glob` names it for electron-builder; `tail` is the
 * directory inside the package, the whole package when empty.
 */
const UNPACKED_TREES = Object.freeze([
  { name: /^libreoffice-kit-(?:darwin|win32|linux)-[^/]+$/u, glob: 'libreoffice-kit-{darwin,win32,linux}-*', tail: '' },
  { name: /^dsh-experimental-cua-macos$/u, glob: 'dsh-experimental-cua-macos', tail: 'native/bin' },
]);
const UNPACKED_TREE_GLOBS = UNPACKED_TREES.map((tree) => `${tree.glob}${tree.tail === '' ? '' : `/${tree.tail}`}`);

/**
 * Whether a path from the resources root lies in a tree that is unpacked whole:
 * under `node_modules/@deepseek-ai/`, in a package a tree names, below the
 * tree's own directory.
 */
export function inUnpackedTree(relativePath) {
  const segments = relativePath.split('/');
  const scope = segments.lastIndexOf('@deepseek-ai');
  if (scope < 1 || segments[scope - 1] !== 'node_modules') return false;
  const tree = UNPACKED_TREES.find((candidate) => candidate.name.test(segments[scope + 1] ?? ''));
  if (tree === undefined) return false;
  const below = segments.slice(scope + 2);
  const tail = tree.tail === '' ? [] : tree.tail.split('/');
  return below.length > tail.length && tail.every((segment, index) => below[index] === segment);
}

/**
 * Whether a packaged file has to be a real file beside the archive: it is
 * handed to the operating system — loaded by the dynamic loader, started as a
 * program, or read by a native process — instead of being read by the runtime.
 * `relativePath` is `/`-separated from the resources root; `ASAR_UNPACK` says
 * the same to electron-builder.
 */
export function isUnpacked(relativePath) {
  if (NATIVE_SUFFIX.test(basename(relativePath)) || VERSIONED_SHARED_OBJECT.test(relativePath)) return true;
  if (EXTENSIONLESS_PROGRAM.test(relativePath)) return true;
  return inUnpackedTree(relativePath);
}

/**
 * `asarUnpack` for electron-builder: `isUnpacked` as patterns. They are matched
 * against each staged file's path counted from the app directory, so they say
 * how a path has to end and never where it starts.
 */
export const ASAR_UNPACK = Object.freeze([
  '**/*.{node,dll,exe,dylib,so}',
  '**/*.so.[0-9]*',
  '**/spawn-helper',
  '**/@vscode/ripgrep*/bin/rg',
  '**/@deepseek-ai/node-addon-system*/bin/landlock-run',
  '**/open/xdg-open',
  ...UNPACKED_TREE_GLOBS.map((glob) => `**/node_modules/@deepseek-ai/${glob}/**/*`),
]);

/**
 * The archive's content, as the file set's filter: the runtime's tree minus the
 * trees that are unpacked whole, which travel as file sets of their own.
 * electron-builder applies its patterns in order and lets a later pattern
 * override an earlier one, so the order is the rule's: what the third-party
 * packages carry for their own development is excluded, license and notice
 * files are re-included after that, the file types the runtime never reads are
 * excluded after those (a declaration is not a notice for being named like
 * one), and the unpacked trees are excluded last: a license inside one belongs
 * to its tree alone, not to both.
 */
export function payloadFilter() {
  return [
    `${DSH_DIR}/**`,
    ...THIRD_PARTY_EXCLUDED_DIRS.flatMap((dir) => [
      `!${RUNTIME_MODULES}/!(@deepseek-ai)/**/${dir}`,
      `!${RUNTIME_MODULES}/!(@deepseek-ai)/**/${dir}/**`,
    ]),
    ...THIRD_PARTY_EXCLUDED_DOC_GLOBS.map((glob) => `!${RUNTIME_MODULES}/!(@deepseek-ai)/**/${glob}`),
    ...THIRD_PARTY_EXCLUDED_DOC_PREFIX_GLOBS.map((glob) => `!${RUNTIME_MODULES}/!(@deepseek-ai)/**/${glob}`),
    ...THIRD_PARTY_EXCLUDED_CONFIG_GLOBS.map((glob) => `!${RUNTIME_MODULES}/!(@deepseek-ai)/**/${glob}`),
    ...THIRD_PARTY_LICENSE_GLOBS.map((glob) => `${RUNTIME_MODULES}/**/${glob}`),
    ...RUNTIME_EXCLUDED_EXTENSIONS.map((extension) => `!${DSH_DIR}/**/*${extension}`),
    `${VERBATIM_DSH_DIR}**`,
    ...UNPACKED_TREE_GLOBS.map((glob) => `!${DEEPSEEK_SCOPE}/${glob}/{,/**}`),
  ];
}

/**
 * What stays a real file beside the archive: the staged resources minus the
 * runtime's tree, which the file sets put into the archive instead. The
 * directory itself is excluded too, so nothing walks into it.
 */
export function resourcesFilter() {
  return ['**/*', `!${DSH_DIR}{,/**}`];
}

/**
 * A tree that is unpacked whole, as its own file set: what `isPackaged` lets
 * through, with paths counted from the tree.
 */
export function treeFilter() {
  return ['**/*', ...RUNTIME_EXCLUDED_EXTENSIONS.map((extension) => `!**/*${extension}`)];
}

/**
 * The unpacked trees the staged resources hold, each as the file set it
 * travels in: `from` the staged directory, `to` its path inside the archive.
 *
 * electron-builder 26 lists every unpacked file in one pattern for its matcher,
 * which refuses a pattern past 64 KiB; the Office engine alone is eight hundred
 * files. A file set whose every file is unpacked is passed as its directory
 * instead, so each of these trees is a file set of its own, and the rest of the
 * runtime lists its twenty-odd unpacked files. (From 26.17 on, electron-builder
 * marks each file itself and needs no such arrangement.)
 *
 * @param {string} resourcesDir the staged resources
 * @returns {Array<{from: string, to: string}>} in a stable order; none for a tree that is not staged
 */
export function unpackedTrees(resourcesDir) {
  const root = resolve(resourcesDir);
  let packages;
  try {
    packages = readdirSync(join(root, DEEPSEEK_SCOPE));
  } catch {
    return [];
  }
  const trees = [];
  for (const tree of UNPACKED_TREES) {
    for (const name of packages.filter((candidate) => tree.name.test(candidate)).sort()) {
      const path = `${DEEPSEEK_SCOPE}/${name}${tree.tail === '' ? '' : `/${tree.tail}`}`;
      if (statSync(join(root, path)).isDirectory()) trees.push({ from: join(root, path), to: path });
    }
  }
  return trees;
}

/**
 * What the staged resources amount to, and where the package puts them: the
 * numbers every build log keeps. `archive` is what the installer writes as one
 * file, `onDisk` what it writes file by file; together they are what the rule
 * lets through. Regular files only; links are copied as links and are not
 * counted.
 */
export function summarizeResources(resourcesDir) {
  const root = resolve(resourcesDir);
  const summary = { files: 0, bytes: 0, excluded: { files: 0, bytes: 0 }, archive: { files: 0, bytes: 0 }, onDisk: { files: 0, bytes: 0 } };
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const size = statSync(path).size;
    const relativePath = relative(root, path).split(sep).join('/');
    summary.files += 1;
    summary.bytes += size;
    if (!isPackaged(relativePath)) {
      summary.excluded.files += 1;
      summary.excluded.bytes += size;
      continue;
    }
    const target = relativePath.startsWith(`${DSH_DIR}/`) && !isUnpacked(relativePath) ? summary.archive : summary.onDisk;
    target.files += 1;
    target.bytes += size;
  }
  return summary;
}

/**
 * The staged files the archive has to account for, by path from `dsh/`: a
 * regular file's absolute path, or the target of a link.
 *
 * @returns {Map<string, {path: string, link?: string}>}
 */
export function stagedRuntime(resourcesDir) {
  const root = join(resolve(resourcesDir), DSH_DIR);
  const staged = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');
    if (!isPackaged(`${DSH_DIR}/${relativePath}`)) continue;
    staged.set(relativePath, entry.isSymbolicLink() ? { path, link: readlinkSync(path).split(sep).join('/') } : { path });
  }
  return staged;
}
