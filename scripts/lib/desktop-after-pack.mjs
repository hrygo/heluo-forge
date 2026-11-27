/**
 * `electron-builder` afterPack hook. On every platform it checks the packed
 * runtime against what was staged, so a build whose archive is not the staged
 * tree fails here; on macOS it then prunes unwanted `.lproj` locale directories
 * inside `Electron Framework.framework` and `Contents/Resources`.
 *
 * `electron-builder` 26 looks for `*.lproj` in `Contents/Resources`, while
 * Electron 44 stores them inside `Electron Framework.framework/Versions/A/Resources`.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ArchiveError, verifyRuntimeArchive } from './desktop-archive.mjs';
import { APP_ARCHIVE_PARTS } from '../../services/forge-desktop/src/layout.mjs';

export const KEEP_MAC_LPROJ = Object.freeze(['Base.lproj', 'en.lproj', 'zh_CN.lproj', 'zh_TW.lproj']);
const KEEP_SET = new Set(KEEP_MAC_LPROJ);

function treeStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

/**
 * Remove unwanted `.lproj` locale directories inside a packaged `.app` bundle.
 *
 * @param {string} appBundlePath
 */
export function pruneMacLocales(appBundlePath) {
  const roots = [
    join(appBundlePath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
    join(appBundlePath, 'Contents', 'Resources'),
  ];
  const summary = { removedDirs: 0, removedFiles: 0, removedBytes: 0, kept: [] };
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
      if (KEEP_SET.has(entry.name)) {
        summary.kept.push(entry.name);
        continue;
      }
      const target = join(dir, entry.name);
      const stats = treeStats(target);
      rmSync(target, { recursive: true, force: true });
      summary.removedDirs += 1;
      summary.removedFiles += stats.files;
      summary.removedBytes += stats.bytes;
    }
  }
  summary.kept.sort();
  return summary;
}

/**
 * The packed runtime, checked against the staged resources electron-builder was
 * configured with: the `extraResources` file set names their directory.
 *
 * electron-builder normalises the configuration before the hook sees it: a file
 * set destined for the resources root has no `to` left. Exactly one such entry
 * says where the resources were staged; more than one would not say which.
 *
 * @param {{electronPlatformName?: string, appOutDir?: string, packager?: {appInfo?: {productFilename?: string}, config?: {extraResources?: Array<{from?: string, to?: string}>}}}} context
 * @returns {{files: number, packed: number, unpacked: number, links: number, bytes: number, archiveBytes: number}}
 * @throws {ArchiveError} when the archive cannot be read, cannot be compared, or is not the staged tree
 */
export function verifyPackedRuntime(context) {
  const atRoot = context?.packager?.config?.extraResources?.filter((entry) => entry?.to === undefined || entry.to === '.' || entry.to === './') ?? [];
  const resourcesDir = atRoot.length === 1 ? atRoot[0].from : undefined;
  const platform = context?.electronPlatformName;
  const product = context?.packager?.appInfo?.productFilename;
  if (typeof resourcesDir !== 'string' || resourcesDir === '' || typeof platform !== 'string' || typeof context?.appOutDir !== 'string') {
    throw new ArchiveError('ARCHIVE_UNVERIFIED', 'the packed runtime was not checked: the packager configuration does not say, in one place, where the resources were staged');
  }
  // Where the platform keeps an Electron app's resources: inside the bundle on macOS, beside the executable elsewhere.
  const resources = platform === 'darwin' ? join(context.appOutDir, `${product}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources');
  return verifyRuntimeArchive({ archivePath: join(resources, ...APP_ARCHIVE_PARTS), resourcesDir });
}

/**
 * `electron-builder` `afterPack` entrypoint.
 *
 * @param {Parameters<typeof verifyPackedRuntime>[0]} context
 */
/** What the build log keeps of the check: one line, found again by `build-desktop-installer.mjs`. */
export const ARCHIVE_VERIFIED_PREFIX = 'heluo-archive-verified ';

export async function afterPack(context) {
  const archive = verifyPackedRuntime(context);
  console.log(`${ARCHIVE_VERIFIED_PREFIX}${JSON.stringify(archive)}`);
  if (context.electronPlatformName !== 'darwin') return { archive };
  const product = context?.packager?.appInfo?.productFilename;
  if (typeof product !== 'string' || product === '') return { archive };
  const appBundle = join(context.appOutDir, `${product}.app`);
  // The bundle is the packager's to create: absent, there is nothing to prune.
  if (!existsSync(appBundle)) return { archive };
  return { archive, ...pruneMacLocales(appBundle) };
}

export default afterPack;
