import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";

export function isPortableFileSegment(segment: string): boolean {
  return !!segment && segment !== "." && segment !== ".." &&
    !/[\\/:<>"|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment);
}

export function portablePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function createPortablePathSet() {
  const entries = new Set<string>();
  const prefixes = new Map<string, string>();
  return {
    add(path: string): boolean {
      const key = portablePathKey(path);
      if (entries.has(key)) return false;
      let prefix = "";
      for (const segment of path.split("/")) {
        prefix = prefix ? prefix + "/" + segment : segment;
        const identity = portablePathKey(prefix);
        const previous = prefixes.get(identity);
        if (previous !== undefined && previous !== prefix) return false;
        prefixes.set(identity, prefix);
      }
      entries.add(key);
      return true;
    },
  };
}

export function isMacSystemDirectoryAlias(path: string, target: string, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && ["/tmp", "/var", "/etc"].includes(path) &&
    (target === "/private" + path || target === "private" + path);
}

export async function isSafeAncestorDirectory(path: string, info: Stats): Promise<boolean> {
  if (!info.isSymbolicLink()) return info.isDirectory();
  if (process.platform !== "darwin") return false;
  return isMacSystemDirectoryAlias(path, await fs.readlink(path), process.platform) &&
    (await fs.stat(path)).isDirectory();
}
