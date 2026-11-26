import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomically, AtomicWriteError } from "./file-writes.js";
import { isExpectedOperationError, PendingOperationError } from "./operation-errors.js";
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
        const text = `${JSON.stringify(next, null, 2)}\n`;
        try {
          await fs.mkdir(dirname(path), { recursive: true });
          await writeFileAtomically(path, text);
        } catch (error) {
          if (error instanceof AtomicWriteError && error.phase === "replace") {
            throw new PendingOperationError("状态提交结果待确认，请核对操作结果", async () => {
              const committed = await read(path);
              if (!committed.writable) return undefined;
              const actual = JSON.stringify(committed.state);
              if (actual === JSON.stringify(next)) return { state: "succeeded", result };
              if (actual === previous) return { state: "rejected", code: "error.state.write", error: "状态变更未提交，请重试" };
              return undefined;
            });
          }
          if (isExpectedOperationError(error) && /^E[A-Z0-9]+$/.test(error.code!)) {
            throw Object.assign(new Error("状态未写入，请恢复磁盘空间或权限后重试"), { code: "error.state.write", statusCode: 500 });
          }
          throw error;
        }
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
