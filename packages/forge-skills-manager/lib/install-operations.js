import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isExpectedOperationError, operationRejection } from "./operation-errors.js";
const ownersKey = Symbol.for("heluo.forge-skills-manager.operations");
const owners = globalThis[ownersKey] ??= /* @__PURE__ */ new Map();
function createInstallOperations() {
  let owner = { records: /* @__PURE__ */ new Map(), tail: Promise.resolve() };
  let managerPath;
  const lifetime = new AbortController();
  const cancelled = () => Object.assign(new Error("\u6280\u80FD\u7BA1\u7406\u5668\u64CD\u4F5C\u5DF2\u53D6\u6D88"), { code: "error.nacos.cancelled", statusCode: 499 });
  function invalid(kind) {
    return Object.assign(new Error("\u64CD\u4F5C\u8BF7\u6C42\u6807\u8BC6\u65E0\u6548\u6216\u4E0E\u539F\u8BF7\u6C42\u4E0D\u4E00\u81F4"), { code: kind === "install" ? "error.nacos.query" : "error.proto.invalidParams", statusCode: 400 });
  }
  function validate(id, kind) {
    const pattern = kind === "install" ? /^[a-f0-9-]{36}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (typeof id !== "string" || !pattern.test(id)) throw invalid(kind);
  }
  function dispose() {
    lifetime.abort(cancelled());
    return owner.tail.then(() => void 0);
  }
  function bindManager(path) {
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (managerPath === key) return;
    if (managerPath !== void 0 || lifetime.signal.aborted || owner.records.size) throw new Error("Operation owner already in use");
    managerPath = key;
    const shared = owners.get(key);
    if (shared) {
      void shared.invalidate?.();
      owner = shared;
    } else owners.set(key, owner);
    owner.invalidate = dispose;
  }
  function enqueue(task, signal) {
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    return new Promise((fulfill, reject) => {
      let waiting = true;
      const cancel = () => {
        if (waiting) {
          waiting = false;
          reject(cancelled());
        }
      };
      if (combined.aborted) {
        cancel();
        return;
      }
      combined.addEventListener("abort", cancel, { once: true });
      const execute = async () => {
        combined.removeEventListener("abort", cancel);
        if (!waiting) return;
        waiting = false;
        if (combined.aborted) {
          reject(cancelled());
          return;
        }
        try {
          fulfill(await task());
        } catch (error) {
          reject(error);
        }
      };
      owner.tail = owner.tail.then(execute, execute);
    });
  }
  async function readStatus(id, kind) {
    validate(id, kind);
    const record = owner.records.get(id);
    if (!record || record.kind !== kind) return { state: "pending" };
    if (record.outcome.state === "pending" && record.settled) {
      try {
        if (kind === "install" && record.inspect) {
          const result = await record.inspect();
          if (result) {
            record.outcome = { state: "succeeded", result };
            record.promise = Promise.resolve(result);
          }
        } else if (kind === "mutation" && record.inspectMutation) {
          const outcome = await record.inspectMutation();
          if (outcome) {
            record.outcome = outcome;
            record.promise = Promise.resolve(outcome.state === "succeeded" ? outcome.result : outcome.result ?? {
              ok: false,
              code: outcome.code,
              error: outcome.error
            });
          }
        }
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
      }
    }
    return record.outcome;
  }
  function start(id, target, task, kind, inspect, inspectMutation) {
    const requestId = id === void 0 ? randomUUID() : id;
    validate(requestId, kind);
    const previous = owner.records.get(requestId);
    if (previous) {
      if (previous.kind !== kind || previous.target !== target) throw invalid(kind);
      return previous.promise;
    }
    if (lifetime.signal.aborted) throw cancelled();
    if ([...owner.records.values()].some((record2) => record2.kind === kind && record2.target === target && record2.outcome.state === "pending" && (kind === "install" || record2.settled))) {
      throw Object.assign(new Error("\u8BE5\u4E0B\u8F7D\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\uFF0C\u8BF7\u6838\u5BF9\u672C\u5730\u6280\u80FD"), { code: "error.repo.installState", statusCode: 409 });
    }
    if (owner.records.size >= 256) {
      for (const [key, record2] of owner.records) if (record2.outcome.state !== "pending") owner.records.delete(key);
      if (owner.records.size >= 256) throw Object.assign(new Error("\u64CD\u4F5C\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\uFF0C\u8BF7\u5148\u6838\u5BF9\u672C\u5730\u6280\u80FD"), { code: "error.repo.installState", statusCode: 409 });
    }
    const record = { kind, target, outcome: { state: "pending" }, settled: false, inspect, inspectMutation, promise: Promise.resolve().then(task) };
    owner.records.set(requestId, record);
    record.promise = record.promise.then((result) => {
      record.settled = true;
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const rejection = operationRejection(result);
        record.outcome = rejection.code === "error.repo.installState" ? { state: "pending" } : { state: "rejected", result, ...rejection };
      } else record.outcome = { state: "succeeded", result };
      return result;
    }, (error) => {
      record.settled = true;
      if (isExpectedOperationError(error) && error.code?.startsWith("error.") && error.code !== "error.repo.installState") {
        record.outcome = { state: "rejected", code: error.code, error: error.message };
      }
      throw error;
    });
    return record.promise;
  }
  return {
    bindManager,
    enqueue,
    dispose,
    signal: lifetime.signal,
    run: (id, target, task, inspect) => start(id, target, task, "install", inspect),
    status: (id) => readStatus(id, "install"),
    runMutation: (id, target, task, inspect) => start(id, target, task, "mutation", void 0, inspect),
    mutationStatus: (id) => readStatus(id, "mutation")
  };
}
export {
  createInstallOperations
};
