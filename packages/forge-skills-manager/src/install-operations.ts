import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isExpectedOperationError, operationRejection, PendingOperationError } from "./operation-errors.js";

export interface InstallReceipt { name: string; root: string }
export type InstallOutcome = { state: "pending" } | { state: "succeeded"; result: InstallReceipt } | { state: "rejected"; code: string; error: string };
export type MutationOutcome = { state: "pending" } | { state: "succeeded"; result: unknown } | { state: "rejected"; code: string; error: string; result?: unknown };
export type MutationInspection = Exclude<MutationOutcome, { state: "pending" }>;
interface OperationRecord {
  kind: "install" | "mutation";
  target: string;
  outcome: MutationOutcome;
  settled: boolean;
  inspect?: () => Promise<InstallReceipt | undefined>;
  inspectMutation?: () => Promise<MutationInspection | undefined>;
  promise: Promise<unknown>;
}
interface OperationOwner {
  records: Map<string, OperationRecord>;
  tail: Promise<unknown>;
  invalidate?: () => Promise<void>;
}
const ownersKey = Symbol.for("heluo.forge-skills-manager.operations");
const owners = ((globalThis as typeof globalThis & { [ownersKey]?: Map<string, OperationOwner> })[ownersKey] ??= new Map());

export function createInstallOperations() {
  let owner: OperationOwner = { records: new Map(), tail: Promise.resolve() };
  let managerPath: string | undefined;
  const lifetime = new AbortController();
  const cancelled = () => Object.assign(new Error("技能管理器操作已取消"), { code: "error.nacos.cancelled", statusCode: 499 });
  function invalid(kind: "install" | "mutation") {
    return Object.assign(new Error("操作请求标识无效或与原请求不一致"), { code: kind === "install" ? "error.nacos.query" : "error.proto.invalidParams", statusCode: 400 });
  }
  function validate(id: unknown, kind: "install" | "mutation"): asserts id is string {
    const pattern = kind === "install" ? /^[a-f0-9-]{36}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (typeof id !== "string" || !pattern.test(id)) throw invalid(kind);
  }
  function dispose(): Promise<void> {
    lifetime.abort(cancelled());
    return owner.tail.then(() => undefined);
  }
  function bindManager(path: string) {
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (managerPath === key) return;
    if (managerPath !== undefined || lifetime.signal.aborted || owner.records.size) throw new Error("Operation owner already in use");
    managerPath = key;
    const shared = owners.get(key);
    if (shared) {
      void shared.invalidate?.();
      owner = shared;
    } else owners.set(key, owner);
    owner.invalidate = dispose;
  }
  function enqueue<T>(task: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    return new Promise<T>((fulfill, reject) => {
      let waiting = true;
      const cancel = () => { if (waiting) { waiting = false; reject(cancelled()); } };
      if (combined.aborted) { cancel(); return; }
      combined.addEventListener("abort", cancel, { once: true });
      const execute = async () => {
        combined.removeEventListener("abort", cancel);
        if (!waiting) return;
        waiting = false;
        if (combined.aborted) { reject(cancelled()); return; }
        try { fulfill(await task()); } catch (error) { reject(error); }
      };
      owner.tail = owner.tail.then(execute, execute);
    });
  }
  async function readStatus(id: unknown, kind: "install" | "mutation"): Promise<MutationOutcome> {
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
              ok: false, code: outcome.code, error: outcome.error,
            });
          }
        }
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
      }
    }
    return record.outcome;
  }
  function start<T>(id: unknown, target: string, task: () => Promise<T>, kind: "install" | "mutation", inspect?: () => Promise<InstallReceipt | undefined>, inspectMutation?: () => Promise<MutationInspection | undefined>): Promise<T> {
    const requestId = id === undefined ? randomUUID() : id;
    validate(requestId, kind);
    const previous = owner.records.get(requestId);
    if (previous) {
      if (previous.kind !== kind || previous.target !== target) throw invalid(kind);
      return previous.promise as Promise<T>;
    }
    if (lifetime.signal.aborted) throw cancelled();
    if ([...owner.records.values()].some(record => record.kind === kind && record.target === target && record.outcome.state === "pending" && (kind === "install" || record.settled))) {
      throw Object.assign(new Error("目标已有操作尚待确认，本次请求未执行"), { code: "error.proto.busy", statusCode: 409 });
    }
    if (owner.records.size >= 256) {
      for (const [key, record] of owner.records) if (record.outcome.state !== "pending") owner.records.delete(key);
      if (owner.records.size >= 256) throw Object.assign(new Error("操作回执容量已满，本次请求未执行"), { code: "error.proto.busy", statusCode: 409 });
    }
    const record: OperationRecord = { kind, target, outcome: { state: "pending" }, settled: false, inspect, inspectMutation, promise: Promise.resolve().then(task) };
    owner.records.set(requestId, record);
    record.promise = record.promise.then(result => {
      record.settled = true;
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const rejection = operationRejection(result);
        record.outcome = rejection.code === "error.repo.installState" ? { state: "pending" } : { state: "rejected", result, ...rejection };
      } else record.outcome = { state: "succeeded", result };
      return result;
    }, error => {
      record.settled = true;
      if (error instanceof PendingOperationError) record.inspectMutation ??= error.inspect;
      if (isExpectedOperationError(error) && error.code?.startsWith("error.") && error.code !== "error.repo.installState") {
        record.outcome = { state: "rejected", code: error.code, error: error.message };
      }
      throw error;
    });
    return record.promise as Promise<T>;
  }
  return {
    bindManager, enqueue, dispose, signal: lifetime.signal,
    run: (id: unknown, target: string, task: () => Promise<InstallReceipt>, inspect?: () => Promise<InstallReceipt | undefined>) => start(id, target, task, "install", inspect),
    status: (id: unknown) => readStatus(id, "install") as Promise<InstallOutcome>,
    runMutation: <T>(id: unknown, target: string, task: () => Promise<T>, inspect?: () => Promise<MutationInspection | undefined>) => start(id, target, task, "mutation", undefined, inspect),
    mutationStatus: (id: unknown) => readStatus(id, "mutation"),
  };
}
