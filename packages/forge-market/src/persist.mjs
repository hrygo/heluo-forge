import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// 每个包一个子目录：否则第二个插件会覆盖第一个的 package.json。
export function packageDirFor(targetDir, name) {
  const leaf = String(name).replace(/^@/, '').replace(/\//g, '-');
  return join(targetDir, leaf);
}

export async function persistFiles(files, targetDir) {
  if (!targetDir) return { ok: false, reason: 'no-target' };
  const root = resolve(targetDir);
  const written = [];

  for (const file of files ?? []) {
    const destination = resolve(join(root, file.path));
    if (destination !== root && !destination.startsWith(root + sep)) {
      return { ok: false, reason: 'outside-target', detail: file.path };
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes);
    written.push(file.path);
  }

  return { ok: true, written, root };
}
