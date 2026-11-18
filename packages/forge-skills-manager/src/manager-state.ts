import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomically } from "./file-writes.js";
import { isExpectedOperationError } from "./operation-errors.js";
import type { ManagerState, OperationError, PolicyResult } from "./types.js";

interface StateSchema {
  path: () => string;
  empty: () => ManagerState;
  fallback: () => ManagerState;
  migrate: (value: ManagerState) => ManagerState;
  validate: (value: ManagerState) => boolean;
  normalize: (value: ManagerState) => ManagerState;
  writeRejected: () => OperationError;
}

export function createManagerStateStore(schema: StateSchema) {
  const queues = new Map<string, Promise<unknown>>();
  function unavailable(path: string): PolicyResult {
    return {
      state: schema.fallback(), writable: false,
      warning: { code: "warning.state.invalid", params: { path }, error: `技能管理器状态文件不可读，所有技能已安全停用且状态写入已锁定: ${path}` },
    };
  }
  async function read(path: string): Promise<PolicyResult> {
    let parsed: ManagerState;
    try {
      parsed = JSON.parse(await fs.readFile(path, "utf8")) as ManagerState;
    } catch (error) {
      if (isExpectedOperationError(error) && error.code === "ENOENT") return { state: schema.empty(), warning: null, writable: true };
      if (error instanceof SyntaxError || isExpectedOperationError(error)) return unavailable(path);
      throw error;
    }
    const migrated = schema.migrate(parsed);
    if (!schema.validate(migrated)) return unavailable(path);
    return { state: schema.normalize(migrated), warning: null, writable: true };
  }
  function update<Result>(modify: (state: ManagerState) => Result | Promise<Result>, options: { force?: boolean } = {}): Promise<Result | OperationError> {
    const path = resolve(schema.path());
    const task = async () => {
      const current = await read(path);
      if (!current.writable) return schema.writeRejected();
      const previous = JSON.stringify(current.state);
      const result = await modify(current.state);
      if (result && typeof result === "object" && "ok" in result && result.ok === false) return result;
      const next = schema.normalize(current.state);
      if (!schema.validate(next)) throw new Error("Invalid manager state update");
      if (options.force || JSON.stringify(next) !== previous) {
        await fs.mkdir(dirname(path), { recursive: true });
        await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
      }
      return result;
    };
    const next = (queues.get(path) ?? Promise.resolve()).then(task, task);
    queues.set(path, next);
    const release = () => { if (queues.get(path) === next) queues.delete(path); };
    void next.then(release, release);
    return next;
  }
  return { read: () => read(schema.path()), update };
}
