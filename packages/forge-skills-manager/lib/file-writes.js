import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
async function writeFileAtomically(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.dssm-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => void 0);
    throw error;
  }
}
export {
  writeFileAtomically
};
