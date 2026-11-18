import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomically } from "./file-writes.js";
import { isExpectedOperationError } from "./operation-errors.js";
function createManagerStateStore(schema) {
  const queues = /* @__PURE__ */ new Map();
  function unavailable(path) {
    return {
      state: schema.fallback(),
      writable: false,
      warning: { code: "warning.state.invalid", params: { path }, error: `\u6280\u80FD\u7BA1\u7406\u5668\u72B6\u6001\u6587\u4EF6\u4E0D\u53EF\u8BFB\uFF0C\u6240\u6709\u6280\u80FD\u5DF2\u5B89\u5168\u505C\u7528\u4E14\u72B6\u6001\u5199\u5165\u5DF2\u9501\u5B9A: ${path}` }
    };
  }
  async function read(path) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path, "utf8"));
    } catch (error) {
      if (isExpectedOperationError(error) && error.code === "ENOENT") return { state: schema.empty(), warning: null, writable: true };
      if (error instanceof SyntaxError || isExpectedOperationError(error)) return unavailable(path);
      throw error;
    }
    const migrated = schema.migrate(parsed);
    if (!schema.validate(migrated)) return unavailable(path);
    return { state: schema.normalize(migrated), warning: null, writable: true };
  }
  function update(modify, options = {}) {
    const path = resolve(schema.path());
    const task = async () => {
      const current = await read(path);
      if (!current.writable) return schema.writeRejected();
      const previous = JSON.stringify(current.state);
      const result = await modify(current.state);
      if (result && typeof result === "object" && "ok" in result && result.ok === false) return result;
      const next2 = schema.normalize(current.state);
      if (!schema.validate(next2)) throw new Error("Invalid manager state update");
      if (options.force || JSON.stringify(next2) !== previous) {
        await fs.mkdir(dirname(path), { recursive: true });
        await writeFileAtomically(path, `${JSON.stringify(next2, null, 2)}
`);
      }
      return result;
    };
    const next = (queues.get(path) ?? Promise.resolve()).then(task, task);
    queues.set(path, next);
    const release = () => {
      if (queues.get(path) === next) queues.delete(path);
    };
    void next.then(release, release);
    return next;
  }
  return { read: () => read(schema.path()), update };
}
export {
  createManagerStateStore
};
