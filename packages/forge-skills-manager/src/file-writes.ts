import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

export class AtomicWriteError extends Error {
  readonly code: string;
  readonly phase: "staging" | "replace";
  constructor(phase: "staging" | "replace", cause: Error & { code: string }) {
    super("Atomic file write failed", { cause }); this.code = cause.code; this.phase = phase;
  }
}

export async function writeFileAtomically(path: string, content: string) {
  const temporary = join(dirname(path), `.${basename(path)}.dssm-${randomUUID()}.tmp`);
  let phase: "staging" | "replace" = "staging";
  try {
    await fs.writeFile(temporary, content, "utf8");
    phase = "replace";
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof Error && !(error instanceof TypeError) && !(error instanceof ReferenceError) && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code)) {
      throw new AtomicWriteError(phase, error as Error & { code: string });
    }
    throw error;
  }
}
