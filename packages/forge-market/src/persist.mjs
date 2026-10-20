import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

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
