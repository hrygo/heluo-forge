import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
class AtomicWriteError extends Error {
  code;
  phase;
  constructor(phase, cause) {
    super("Atomic file write failed", { cause });
    this.code = cause.code;
    this.phase = phase;
  }
}
async function writeFileAtomically(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.dssm-${randomUUID()}.tmp`);
  let phase = "staging";
  try {
    await fs.writeFile(temporary, content, "utf8");
    phase = "replace";
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => void 0);
    if (error instanceof Error && !(error instanceof TypeError) && !(error instanceof ReferenceError) && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code)) {
      throw new AtomicWriteError(phase, error);
    }
    throw error;
  }
}
export {
  AtomicWriteError,
  writeFileAtomically
};
