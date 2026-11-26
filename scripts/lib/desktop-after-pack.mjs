/**
 * `electron-builder` afterPack hook: prunes unwanted macOS `.lproj` locale
 * directories inside `Electron Framework.framework` and `Contents/Resources`.
 *
 * `electron-builder` 26 looks for `*.lproj` in `Contents/Resources`, while
 * Electron 44 stores them inside `Electron Framework.framework/Versions/A/Resources`.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
 * `electron-builder` `afterPack` entrypoint.
 *
 * @param {{ electronPlatformName?: string, appOutDir?: string, packager?: { appInfo?: { productFilename?: string } } }} context
 */
export async function afterPack(context) {
  if (context?.electronPlatformName !== 'darwin') return undefined;
  const product = context?.packager?.appInfo?.productFilename;
  if (typeof product !== 'string' || product === '' || typeof context?.appOutDir !== 'string') return undefined;
  const appBundle = join(context.appOutDir, `${product}.app`);
  if (!existsSync(appBundle)) return undefined;
  return pruneMacLocales(appBundle);
}

export default afterPack;
